import { Effect, Schema } from "effect"
import { portableIdentity } from "./export.ts"
import { withLocalLocks } from "./local-locks.ts"
import { fail, SkillsError } from "./model.ts"

import { sha256, Store } from "./store.ts"

import { FrozenPortableSchema, strictDecode, UpstreamPublisher } from "./upstream-model.ts"
import type { UpstreamBinding, UpstreamCommandOperation } from "./upstream-model.ts"
import { UpstreamState } from "./upstream-state.ts"
import { getSubscription } from "./upstream-subscription.ts"

import { authScope } from "./catalog.ts"

import {
  freezePortable,
  thawPortable,
  publicationMemberKey,
  contentDeltas,
  discover,
} from "./upstream-content.ts"
export function forkUpstream(subscriptionId: string, memberKey: string) {
  return Effect.gen(function* () {
    const store = yield* Store
    const targetBinding = (yield* (yield* UpstreamState).bindings(subscriptionId)).find(
      (binding) => binding.member_key === memberKey,
    )
    return yield* withLocalLocks(
      store.root,
      [
        `upstream-subscription:${subscriptionId}`,
        ...(targetBinding ? [`upstream-target:${targetBinding.target_key}`] : []),
      ],
      Effect.gen(function* () {
        const state = yield* UpstreamState,
          publisher = yield* UpstreamPublisher,
          subscription = yield* getSubscription(subscriptionId)
        const binding = (yield* state.bindings(subscriptionId)).find(
          (b) => b.member_key === memberKey,
        )
        if (!binding)
          return yield* Effect.fail(
            fail("UPSTREAM_MEMBER_NOT_FOUND", "Use an exact published member key."),
          )
        const current = yield* publisher.inspect(binding.page_id)
        if (
          !current.ownership ||
          current.ownership.subscription_id !==
            (subscription.source.publisher_subscription_id ?? subscriptionId) ||
          current.ownership.member_key !== publicationMemberKey(subscription, binding.member_key)
        )
          return yield* Effect.fail(
            fail(
              "UPSTREAM_OWNERSHIP_CONFLICT",
              "Fork requires the exact existing publication owner.",
            ),
          )
        if (binding.mode === "fork") return binding
        const targetBaseline = yield* state.command(`materialized:${binding.target_key}`)
        const materialized = targetBaseline
          ? yield* Effect.try({
              try: () =>
                strictDecode(
                  Schema.Struct({
                    portable: FrozenPortableSchema,
                    content_hash: Schema.String,
                    revision: Schema.String,
                  }),
                  targetBaseline,
                ),
              catch: (e) => e as SkillsError,
            })
          : {
              portable: binding.materialized,
              content_hash: binding.published_hash,
              revision: binding.revision,
            }
        const accepted = yield* thawPortable(materialized.portable)
        const acceptedHash = yield* portableIdentity(accepted)
        if (acceptedHash !== materialized.content_hash)
          return yield* Effect.fail(
            fail(
              "STATE_CORRUPT",
              "Shared target baseline hash no longer matches its frozen full files.",
            ),
          )
        const scope = yield* authScope
        const operationId = `um_${yield* sha256(JSON.stringify([scope, subscription.database_id, binding.subscription_id, binding.member_key, binding.generation, "fork"]))}`
        const prior = yield* state.command(operationId)
        if (prior)
          return yield* Effect.fail(
            fail(
              "WRITE_OUTCOME_UNKNOWN",
              "Explicit mode transition must reconcile before another write.",
              { operation_id: operationId },
            ),
          )
        const priorBaselines = yield* store.integrity.baselines(current.ownership.subscription_id)
        const beforeIds = new Set(priorBaselines.map((entry) => entry.operation_id))
        let evidence: Extract<UpstreamCommandOperation, { domain: "upstream_fork" }> = {
          operation_id: operationId,
          domain: "upstream_fork",
          scope,
          database_id: subscription.database_id,
          subscription_id: subscriptionId,
          member_key: memberKey,
          page_id: binding.page_id,
          expected_version: current.version,
          state: "running",
          recovery_generation: binding.generation,
          publication_required: current.ownership.mode !== "fork",
          baseline_operation_ids: [],
          baseline_before_ids: [...beforeIds],
          publisher_subscription_id: current.ownership.subscription_id,
        }
        yield* state.saveCommand(operationId, evidence)
        const recovered = yield* Effect.gen(function* () {
          return current.ownership?.mode === "fork" && current.ownership.fork_baseline
            ? current.ownership.fork_baseline
            : {
                version: 1 as const,
                original_ref: JSON.stringify(subscription.source.provider),
                revision: materialized.revision,
                content_hash: acceptedHash,
                portable_ref: yield* publisher.recoverableBaseline(
                  binding.page_id,
                  current.version,
                  {
                    portable: accepted,
                    content_hash: acceptedHash,
                    revision: materialized.revision,
                  },
                ),
              }
        }).pipe(Effect.result)
        const baselines = yield* store.integrity.baselines(current.ownership.subscription_id)
        const baselinePage =
          recovered._tag === "Success"
            ? /^notion-baseline:\/\/([^#]+)#/.exec(recovered.success.portable_ref)?.[1]
            : undefined
        evidence = {
          ...evidence,
          baseline_operation_ids: baselines
            .filter((entry) =>
              recovered._tag === "Success"
                ? entry.page_id === baselinePage
                : !beforeIds.has(entry.operation_id),
            )
            .map((entry) => entry.operation_id),
        }
        if (recovered._tag === "Failure") {
          yield* state.saveCommand(operationId, {
            ...evidence,
            state: recovered.failure.code === "WRITE_OUTCOME_UNKNOWN" ? "unknown" : "failed",
            error_code: recovered.failure.code,
          })
          return yield* Effect.fail(
            fail(recovered.failure.code, recovered.failure.message, { operation_id: operationId }),
          )
        }
        const baseline = recovered.success
        evidence = { ...evidence, baseline }
        yield* state.saveCommand(operationId, evidence)
        if (
          (yield* portableIdentity(yield* publisher.readBaseline(baseline.portable_ref))) !==
          baseline.content_hash
        )
          return yield* Effect.fail(
            fail(
              "UPSTREAM_BASELINE_UNVERIFIED",
              "Remote fork baseline did not recover the accepted full files.",
              { operation_id: operationId },
            ),
          )
        if (current.ownership?.mode !== "fork") {
          yield* state.saveCommand(operationId, { ...evidence, state: "running" })
          yield* publisher.setMode({
            operation_id: operationId,
            page_id: binding.page_id,
            expected_version: current.version,
            mode: "fork",
            fork_baseline: baseline,
          })
        }
        const next = {
          ...binding,
          generation: binding.generation + 1,
          mode: "fork" as const,
          fork_baseline: baseline,
        }
        yield* state.setMode(next, binding.generation)
        yield* state.saveCommand(operationId, { ...evidence, state: "verified" })
        return next
      }),
    )
  })
}
export function trackUpstream(subscriptionId: string, memberKey: string) {
  return Effect.gen(function* () {
    const store = yield* Store
    const targetBinding = (yield* (yield* UpstreamState).bindings(subscriptionId)).find(
      (binding) => binding.member_key === memberKey,
    )
    return yield* withLocalLocks(
      store.root,
      [
        `upstream-subscription:${subscriptionId}`,
        ...(targetBinding ? [`upstream-target:${targetBinding.target_key}`] : []),
      ],
      Effect.gen(function* () {
        const state = yield* UpstreamState,
          publisher = yield* UpstreamPublisher,
          subscription = yield* getSubscription(subscriptionId)
        const binding = (yield* state.bindings(subscriptionId)).find(
          (b) => b.member_key === memberKey,
        )
        if (!binding)
          return yield* Effect.fail(
            fail("UPSTREAM_MEMBER_NOT_FOUND", "Use an exact published member key."),
          )
        if (
          binding.fork_baseline &&
          (yield* portableIdentity(
            yield* publisher.readBaseline(binding.fork_baseline.portable_ref),
          )) !== binding.fork_baseline.content_hash
        )
          return yield* Effect.fail(
            fail("UPSTREAM_BASELINE_UNVERIFIED", "Fork baseline is no longer recoverable."),
          )
        const snapshot = yield* discover(subscription)
        const member = snapshot.members.find((m) => m.member_key === memberKey)
        if (!member)
          return yield* Effect.fail(
            fail(
              "UPSTREAM_MEMBER_MISSING",
              "The exact source member is missing; resolve its identity first.",
            ),
          )
        const current = yield* publisher.inspect(binding.page_id),
          candidate = yield* freezePortable(member.portable),
          local = yield* freezePortable(current.portable)
        if (
          !current.ownership ||
          current.ownership.subscription_id !==
            (subscription.source.publisher_subscription_id ?? subscriptionId) ||
          current.ownership.member_key !== publicationMemberKey(subscription, binding.member_key)
        )
          return yield* Effect.fail(
            fail(
              "UPSTREAM_OWNERSHIP_CONFLICT",
              "Track requires the exact existing publication owner.",
            ),
          )
        const deltas = contentDeltas(local, candidate)
        if (current.content_hash !== (yield* portableIdentity(member.portable)))
          return {
            tracked: false as const,
            requires_resolution: true as const,
            deltas,
            member_key: memberKey,
          }
        const scope = yield* authScope
        const operationId = `um_${yield* sha256(JSON.stringify([scope, subscription.database_id, binding.subscription_id, binding.member_key, binding.generation, "tracked"]))}`
        const baselinePage = binding.fork_baseline
          ? /^notion-baseline:\/\/([^#]+)#/.exec(binding.fork_baseline.portable_ref)?.[1]
          : undefined
        const baselineIds = baselinePage
          ? (yield* store.integrity.baselines(current.ownership.subscription_id))
              .filter((entry) => entry.page_id === baselinePage)
              .map((entry) => entry.operation_id)
          : []
        const evidence = {
          operation_id: operationId,
          domain: "upstream_track" as const,
          scope,
          database_id: subscription.database_id,
          subscription_id: subscriptionId,
          member_key: memberKey,
          page_id: binding.page_id,
          expected_version: current.version,
          recovery_generation: binding.generation,
          publication_required:
            current.ownership.mode !== "tracked" ||
            current.ownership.published_hash !== current.content_hash,
          baseline_operation_ids: baselineIds,
          content_hash: current.content_hash,
          revision: snapshot.revision,
        }
        const prior = yield* state.command(operationId)
        if (prior)
          return yield* Effect.fail(
            fail(
              "WRITE_OUTCOME_UNKNOWN",
              "Resume the original frozen mode operation before another transition.",
              { operation_id: operationId },
            ),
          )
        if (
          current.ownership?.mode !== "tracked" ||
          current.ownership.published_hash !== current.content_hash
        ) {
          yield* state.saveCommand(operationId, { ...evidence, state: "running" })
          yield* publisher.setMode({
            operation_id: operationId,
            page_id: binding.page_id,
            expected_version: current.version,
            mode: "tracked",
            published_hash: current.content_hash,
            revision: snapshot.revision,
          })
        }
        const next: UpstreamBinding = {
          ...binding,
          mode: "tracked",
          generation: binding.generation + 1,
          accepted: candidate,
          materialized: candidate,
          published_hash: current.content_hash,
          revision: snapshot.revision,
        }
        yield* state.setMode(next, binding.generation)
        yield* state.saveCommand(`materialized:${binding.target_key}`, {
          portable: candidate,
          content_hash: current.content_hash,
          revision: snapshot.revision,
        })
        yield* state.saveCommand(operationId, { ...evidence, state: "verified" })
        return {
          tracked: true as const,
          requires_resolution: false as const,
          deltas,
          member_key: memberKey,
        }
      }),
    )
  })
}
