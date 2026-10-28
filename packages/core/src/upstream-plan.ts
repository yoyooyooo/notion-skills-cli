import { Clock, Effect } from "effect"
import { portableIdentity } from "./export.ts"

import { fail, SkillsError } from "./model.ts"

import { sha256 } from "./store.ts"

import { strictDecode, UpstreamPlanSchema, UpstreamPublisher } from "./upstream-model.ts"
import type { FrozenPortable, PlanItem, UpstreamPlan } from "./upstream-model.ts"
import { UpstreamState } from "./upstream-state.ts"
import { getSubscription } from "./upstream-subscription.ts"
import { readPublishedUpstreamPages, type PublishedUpstreamLookup } from "./upstream-identity.ts"
import { authScope } from "./catalog.ts"
import { buildSourceMemberManifest } from "./upstream-member-links.ts"

import {
  freezePortable,
  thawPortable,
  subscriptionConfigHash,
  publicationMemberKey,
  targetKey,
  contentDeltas,
  mergeSharedDelta,
  discover,
} from "./upstream-content.ts"
export function planUpstream(subscriptionId: string) {
  return Effect.gen(function* () {
    const subscription = yield* getSubscription(subscriptionId)
    if (!subscription.enabled || subscription.removed)
      return yield* Effect.fail(
        fail(
          "UPSTREAM_DISABLED",
          "The subscription is disabled or removed; published content is retained.",
        ),
      )
    const state = yield* UpstreamState,
      publisher = yield* UpstreamPublisher
    const snapshot = yield* discover(subscription)
    const sourceManifest = yield* buildSourceMemberManifest(subscription.subscription_id, snapshot)
    const bindings = yield* state.bindings(subscription.subscription_id)
    const byKey = new Map(bindings.map((b) => [b.member_key, b]))
    const sourceBaseline =
      subscription.source.shared_target_set && subscription.source.accepted_ref
        ? yield* discover(subscription, subscription.source.accepted_ref)
        : undefined
    if (
      subscription.source.shared_target_set &&
      (!subscription.source.accepted_ref || !subscription.source.publisher_subscription_id)
    )
      return yield* Effect.fail(
        fail(
          "UPSTREAM_SHARED_AUTHORITY_REQUIRED",
          "Shared target sets require a source accepted_ref and one explicit publisher subscription.",
        ),
      )
    const baselineMembers = new Map(
      sourceBaseline?.members.map((member) => [member.member_key, member]) ?? [],
    )
    const items: PlanItem[] = []
    const publisherId =
      subscription.source.publisher_subscription_id ?? subscription.subscription_id
    let publishedPages: PublishedUpstreamLookup | undefined
    for (const member of snapshot.members) {
      const key = targetKey(subscription, member.member_key)
      const binding = byKey.get(member.member_key)
      const target = yield* state.target(key)
      let page =
        binding?.page_id ??
        target?.page_id ??
        subscription.published?.members.find(
          (published) => published.member_key === member.member_key,
        )?.page_id
      if (!page) {
        publishedPages ??= yield* readPublishedUpstreamPages(
          subscription.target_database_id,
          publisherId,
        )
        page = yield* publishedPages(
          publicationMemberKey(subscription, member.member_key),
          member.portable.kind,
        )
      }
      const current = page ? yield* publisher.inspect(page) : undefined
      const rawCandidate = yield* freezePortable(member.portable)
      let candidate: FrozenPortable = rawCandidate
      let action: PlanItem["action"] = current ? "update" : "create",
        reason = "source-changed"
      if (target && target.publisher_subscription_id !== publisherId) {
        action = "conflict"
        reason = "publication-authority-conflict"
      }
      if (current) {
        const owner = current.ownership
        if (
          !owner ||
          owner.subscription_id !== publisherId ||
          owner.member_key !== publicationMemberKey(subscription, member.member_key)
        ) {
          action = "conflict"
          reason = "ownership-conflict"
        } else if (owner.mode === "fork" || binding?.mode === "fork") {
          action = "fork"
          reason = "explicit-fork-retained"
        } else if (
          current.content_hash !== owner.published_hash ||
          (binding &&
            !subscription.source.shared_target_set &&
            current.content_hash !== binding.published_hash)
        ) {
          action = "conflict"
          reason = "tracked-content-edited"
        } else if (binding && binding.accepted.name !== rawCandidate.name) {
          action = "conflict"
          reason = "rename-requires-explicit-resolution"
        } else if (
          !binding &&
          current.portable.name !== rawCandidate.name &&
          !subscription.source.shared_target_set
        ) {
          action = "conflict"
          reason = "rename-requires-explicit-resolution"
        } else if (subscription.source.shared_target_set) {
          const baseline =
            binding?.accepted ??
            (baselineMembers.get(member.member_key)
              ? yield* freezePortable(baselineMembers.get(member.member_key)!.portable)
              : undefined)
          if (!baseline) {
            action = "conflict"
            reason = "shared-member-has-no-accepted-baseline"
          } else {
            const frozenCurrent = yield* freezePortable(current.portable)
            const merged = yield* Effect.try({
              try: () => mergeSharedDelta(baseline, frozenCurrent, rawCandidate),
              catch: (e) => e as SkillsError,
            }).pipe(Effect.result)
            if (merged._tag === "Failure") {
              action = "conflict"
              reason = merged.failure.code
            } else candidate = merged.success
          }
        }
        if (
          action === "update" &&
          (yield* portableIdentity(yield* thawPortable(candidate))) === current.content_hash
        ) {
          action = "unchanged"
          reason = "identical-managed-content"
        }
      }
      const hash = yield* portableIdentity(yield* thawPortable(candidate))
      items.push({
        member_key: member.member_key,
        target_key: key,
        action,
        reason,
        generation: binding?.generation ?? 0,
        ...(current
          ? {
              page_id: current.page_id,
              expected_version: current.version,
              expected_hash: current.content_hash,
            }
          : {}),
        upstream_hash: member.upstream_hash,
        ...(member.git_materialization ? { git_materialization: member.git_materialization } : {}),
        content_hash: hash,
        ...(member.patch_hash ? { patch_hash: member.patch_hash } : {}),
        candidate,
        accepted: rawCandidate,
        deltas: contentDeltas(
          current ? yield* freezePortable(current.portable) : undefined,
          candidate,
        ),
      })
      byKey.delete(member.member_key)
    }
    for (const binding of byKey.values())
      items.push({
        member_key: binding.member_key,
        target_key: binding.target_key,
        action: "retain",
        reason: "missing-or-excluded",
        generation: binding.generation,
        page_id: binding.page_id,
        expected_hash: binding.published_hash,
        deltas: [],
      })
    for (const published of subscription.published?.members ?? [])
      if (
        !snapshot.members.some((member) => member.member_key === published.member_key) &&
        !byKey.has(published.member_key)
      )
        items.push({
          member_key: published.member_key,
          target_key: targetKey(subscription, published.member_key),
          action: "retain",
          reason: "missing-or-excluded-remote-map",
          generation: 0,
          page_id: published.page_id,
          expected_hash: published.content_hash,
          deltas: [],
        })
    const configHash = yield* subscriptionConfigHash(subscription)
    const createdAt = yield* Clock.currentTimeMillis
    const planScope = yield* authScope
    const {
      plan_id: _pendingId,
      plan_hash: _pendingHash,
      ...body
    } = yield* Effect.try({
      try: () =>
        strictDecode(UpstreamPlanSchema, {
          version: 1,
          plan_id: "pending",
          plan_hash: "pending",
          created_at: createdAt,
          subscription_id: subscription.subscription_id,
          subscription_version: subscription.version,
          scope: planScope,
          database_id: subscription.database_id,
          config_hash: configHash,
          revision: snapshot.revision,
          source_manifest: sourceManifest,
          provenance: snapshot.provenance,
          publisher_subscription_id: publisherId,
          target_database_id: subscription.target_database_id,
          items: items.sort((a, b) => a.member_key.localeCompare(b.member_key)),
        }),
      catch: (error) => error as SkillsError,
    })
    const hash = yield* sha256(JSON.stringify(body))
    const plan: UpstreamPlan = { ...body, plan_id: `up_${hash}`, plan_hash: hash }
    yield* state.savePlan(plan)
    return plan
  })
}
