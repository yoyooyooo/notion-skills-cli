import { Effect, Schema } from "effect"

import { withLocalLocks } from "./local-locks.ts"
import { fail, SkillsError } from "./model.ts"

import { sha256, Store } from "./store.ts"

import {
  ProjectionOperationSchema,
  PublishedMembersSchema,
  strictDecode,
  UpstreamPublisher,
} from "./upstream-model.ts"
import type {
  ProjectionOperation,
  PublishedMembers,
  Subscription,
  UpstreamBinding,
  UpstreamOperation,
} from "./upstream-model.ts"
import { UpstreamState } from "./upstream-state.ts"
import {
  isPrepublicationReadFailure,
  recoverPrepublicationCreate,
} from "./upstream-prepublication-recovery.ts"
import {
  getSubscription,
  listSubscriptions,
  publishSubscriptionMembers,
  updateSubscription,
  upstreamOperationScope,
} from "./upstream-subscription.ts"

import { invalidateSubscriptionCatalog } from "./cache.ts"

import {
  type AwaitedPublication,
  thawPortable,
  subscriptionConfigHash,
  publicationMemberKey,
} from "./upstream-content.ts"

const SubscriptionMapCheckpointSchema = Schema.Struct({
  subscription_id: Schema.String,
  version: Schema.String,
  published: Schema.NullOr(PublishedMembersSchema),
})
const subscriptionMapCheckpoint = (subscription: Subscription) => ({
  subscription_id: subscription.subscription_id,
  version: subscription.version,
  published: subscription.published,
})

export function applyUpstream(planId: string, memberKeys?: readonly string[]) {
  return Effect.gen(function* () {
    const store = yield* Store
    const state = yield* UpstreamState
    const plan = yield* state.plan(planId)
    if (!plan)
      return yield* Effect.fail(
        fail("UPSTREAM_PLAN_NOT_FOUND", "Apply requires the exact saved plan ID."),
      )
    const selected = memberKeys === undefined ? undefined : new Set(memberKeys)
    if (
      memberKeys !== undefined &&
      (!memberKeys.length ||
        memberKeys.some((key) => !key || !plan.items.some((item) => item.member_key === key)))
    )
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Select at least one exact member key from the frozen plan."),
      )
    return yield* withLocalLocks(
      store.root,
      [`upstream-plan:${planId}`],
      Effect.gen(function* () {
        const publisher = yield* UpstreamPublisher
        const scope = yield* upstreamOperationScope
        if (!scope || plan.scope !== scope.scope || plan.database_id !== scope.database_id)
          return yield* Effect.fail(
            fail(
              "UPSTREAM_PLAN_NOT_FOUND",
              "No frozen upstream plan is available in the current authentication scope.",
            ),
          )
        const { plan_id: _id, plan_hash: _hash, ...body } = plan
        if ((yield* sha256(JSON.stringify(body))) !== plan.plan_hash)
          return yield* Effect.fail(fail("STATE_CORRUPT", "Upstream plan hash mismatch."))
        return yield* withLocalLocks(
          store.root,
          [
            `upstream-subscription:${plan.subscription_id}`,
            ...plan.items.map((item) => `upstream-target:${item.target_key}`),
          ],
          Effect.gen(function* () {
            const subscription = yield* getSubscription(plan.subscription_id)
            const previous = yield* state.operation(plan.plan_id)
            if (
              previous &&
              (previous.operation_id !== `uo_${yield* sha256(plan.plan_id)}` ||
                previous.plan_id !== plan.plan_id ||
                previous.subscription_id !== plan.subscription_id ||
                previous.scope !== plan.scope ||
                previous.database_id !== plan.database_id ||
                previous.target_database_id !== plan.target_database_id ||
                previous.items.length !== plan.items.length ||
                previous.items.some(
                  (item, index) => item.member_key !== plan.items[index]?.member_key,
                ))
            )
              return yield* Effect.fail(
                fail(
                  "STATE_CORRUPT",
                  "Saved upstream outcomes differ from the complete frozen plan.",
                ),
              )
            if (previous?.state === "verified") {
              yield* invalidateSubscriptionCatalog(scope.scope, plan.target_database_id)
              return previous
            }
            const currentConfigHash = yield* subscriptionConfigHash(subscription)
            const acceptedConfig = yield* state.command(`${plan.plan_id}:accepted-config`)
            const acceptedAdvance =
              acceptedConfig === currentConfigHash &&
              subscription.source.accepted_ref === plan.revision &&
              subscription.published?.plan_hash === plan.plan_hash
            if (
              !subscription.enabled ||
              subscription.removed ||
              (currentConfigHash !== plan.config_hash && !acceptedAdvance) ||
              (!previous && subscription.version !== plan.subscription_version)
            )
              return yield* Effect.fail(
                fail("UPSTREAM_PLAN_STALE", "Subscription changed after the plan was frozen."),
              )
            const mapKey = `${plan.plan_id}:subscription-map`
            const savedMap = yield* state.command(mapKey)
            const intendedMap = yield* state.command(`${mapKey}:intended`)
            const checkpointKey = `${mapKey}:checkpoint`
            const savedCheckpoint = yield* state.command(checkpointKey)
            const checkpoint =
              savedCheckpoint === undefined
                ? undefined
                : yield* Effect.try({
                    try: () => strictDecode(SubscriptionMapCheckpointSchema, savedCheckpoint),
                    catch: () => fail("STATE_CORRUPT", "Invalid subscription map checkpoint."),
                  })
            if (checkpoint && checkpoint.subscription_id !== plan.subscription_id)
              return yield* Effect.fail(
                fail("STATE_CORRUPT", "Subscription map checkpoint belongs to another source."),
              )
            const matchesCheckpoint =
              checkpoint !== undefined &&
              checkpoint.version === subscription.version &&
              JSON.stringify(checkpoint.published) === JSON.stringify(subscription.published)
            const matchesBefore =
              savedMap &&
              (JSON.stringify(subscription.published) === JSON.stringify(savedMap) ||
                (!subscription.published &&
                  typeof savedMap === "object" &&
                  savedMap !== null &&
                  "unpublished" in savedMap))
            if (
              savedMap &&
              !matchesBefore &&
              !matchesCheckpoint &&
              JSON.stringify(subscription.published) !== JSON.stringify(intendedMap)
            )
              return yield* Effect.fail(
                fail(
                  "UPSTREAM_PLAN_STALE",
                  "The published active map was edited after execution began.",
                ),
              )
            if (!savedMap)
              yield* state.saveCommand(mapKey, subscription.published ?? { unpublished: true })
            let operation: UpstreamOperation = previous ?? {
              operation_id: `uo_${yield* sha256(plan.plan_id)}`,
              plan_id: plan.plan_id,
              subscription_id: plan.subscription_id,
              scope: plan.scope,
              database_id: plan.database_id,
              target_database_id: plan.target_database_id,
              state: "running",
              items: plan.items.map((item) => ({ member_key: item.member_key, status: "pending" })),
            }
            yield* state.saveOperation(operation)
            const projectionKey = `${operation.operation_id}:projections`
            const savedProjection = yield* state.command(projectionKey)
            let projection: ProjectionOperation = savedProjection
              ? yield* Effect.try({
                  try: () => strictDecode(ProjectionOperationSchema, savedProjection),
                  catch: (e) => e as SkillsError,
                })
              : { operation_id: projectionKey, entries: [] }
            if (!savedProjection && subscription.source.shared_target_set) {
              const peers = (yield* listSubscriptions).filter(
                (peer) =>
                  !peer.removed &&
                  peer.subscription_id !== subscription.subscription_id &&
                  peer.source.shared_target_set === subscription.source.shared_target_set &&
                  peer.published,
              )
              projection = {
                operation_id: projectionKey,
                entries: peers.map((peer) => ({
                  subscription_id: peer.subscription_id,
                  expected_version: peer.version,
                  before: peer.published!,
                  after: {
                    ...peer.published!,
                    members: peer.published!.members.map((member) => {
                      const planned = plan.items.find(
                        (item) =>
                          item.page_id === member.page_id &&
                          (item.action === "update" || item.action === "unchanged"),
                      )
                      return planned?.content_hash
                        ? { ...member, content_hash: planned.content_hash }
                        : member
                    }),
                  },
                  status: "pending" as const,
                })),
              }
              yield* state.saveCommand(projectionKey, projection)
            }
            const bindings = new Map(
              (yield* state.bindings(plan.subscription_id)).map((b) => [b.member_key, b]),
            )
            const change = (index: number, item: UpstreamOperation["items"][number]) => {
              operation = {
                ...operation,
                items: operation.items.map((old, i) => (i === index ? item : old)),
              }
            }
            for (let index = 0; index < plan.items.length; index++) {
              const item = plan.items[index]!,
                prior = operation.items[index]!
              // Selection schedules original indices; it never rewrites the saved plan or outcomes.
              if (selected && !selected.has(item.member_key)) continue
              if (["verified", "retained", "fork", "conflict"].includes(prior.status)) continue
              let recovered: AwaitedPublication | undefined
              let resumeOnly = false
              if (prior.status === "unknown" || prior.status === "running") {
                recovered =
                  item.action === "unchanged" && item.page_id
                    ? yield* Effect.gen(function* () {
                        const current = yield* publisher.inspect(item.page_id!)
                        return current.version === item.expected_version &&
                          current.content_hash === item.expected_hash
                          ? {
                              page_id: current.page_id,
                              version: current.version,
                              content_hash: current.content_hash,
                              publication_operation_id: `${operation.operation_id}:${index}`,
                              verified: true as const,
                            }
                          : undefined
                      })
                    : yield* publisher.reconcile(
                        prior.publication_operation_id ?? `${operation.operation_id}:${index}`,
                      )
                if (
                  !recovered &&
                  item.action === "create" &&
                  isPrepublicationReadFailure(prior.error_code)
                )
                  recovered = yield* recoverPrepublicationCreate(plan.plan_id, index)
                if (!recovered) {
                  resumeOnly =
                    item.action === "update" &&
                    !!item.page_id &&
                    prior.page_id === item.page_id &&
                    !!item.expected_version &&
                    !!item.expected_hash &&
                    prior.publication_operation_id === `${operation.operation_id}:${index}`
                  if (!resumeOnly) {
                    change(index, { ...prior, status: "unknown" })
                    continue
                  }
                }
                if (recovered && recovered.content_hash !== item.content_hash)
                  return yield* Effect.fail(
                    fail(
                      "UPSTREAM_RECONCILE_MISMATCH",
                      "Recovered publication differs from the frozen candidate.",
                    ),
                  )
              }
              if (item.action === "conflict" || item.action === "fork") {
                change(index, {
                  member_key: item.member_key,
                  status: item.action,
                  ...(item.page_id ? { page_id: item.page_id } : {}),
                })
                yield* state.saveOperation(operation)
                continue
              }
              const existing = bindings.get(item.member_key)
              if ((existing?.generation ?? 0) !== item.generation) {
                change(index, {
                  member_key: item.member_key,
                  status: "conflict",
                  error_code: "UPSTREAM_PLAN_STALE",
                })
                yield* state.saveOperation(operation)
                continue
              }
              const target = yield* state.target(item.target_key)
              if (target && target.page_id !== (recovered?.page_id ?? item.page_id)) {
                change(index, {
                  member_key: item.member_key,
                  status: "conflict",
                  error_code: "UPSTREAM_TARGET_CHANGED",
                })
                yield* state.saveOperation(operation)
                continue
              }
              if (item.action === "retain") {
                if (!existing) {
                  change(index, {
                    member_key: item.member_key,
                    status: "retained",
                    ...(item.page_id ? { page_id: item.page_id } : {}),
                  })
                  yield* state.saveOperation(operation)
                  continue
                }
                change(index, {
                  member_key: item.member_key,
                  status: "retained",
                  page_id: existing.page_id,
                })
                yield* state.advance(
                  { ...existing, active: false, generation: existing.generation + 1 },
                  existing.generation,
                  plan.publisher_subscription_id,
                  operation,
                )
                continue
              }
              const result = yield* Effect.gen(function* () {
                // Retained children observe and resume their original frozen request before inspection.
                const current =
                  item.page_id && !resumeOnly ? yield* publisher.inspect(item.page_id) : undefined
                if (
                  !recovered &&
                  current &&
                  (current.version !== item.expected_version ||
                    current.content_hash !== item.expected_hash)
                )
                  return yield* Effect.fail(
                    fail("UPSTREAM_PLAN_STALE", "Published content changed after plan."),
                  )
                if (!item.candidate || !item.accepted || !item.content_hash)
                  return yield* Effect.fail(fail("STATE_CORRUPT", "Frozen candidate missing."))
                const publicationId =
                  prior.publication_operation_id ?? `${operation.operation_id}:${index}`
                change(index, {
                  member_key: item.member_key,
                  status: "running",
                  publication_operation_id: publicationId,
                  ...(item.page_id ? { page_id: item.page_id } : {}),
                })
                yield* state.saveOperation(operation)
                const published =
                  recovered ??
                  (yield* publisher.publish({
                    operation_id: publicationId,
                    portable: yield* thawPortable(item.candidate),
                    target_database_id: plan.target_database_id,
                    ...(resumeOnly
                      ? {
                          resume_only: true as const,
                          expected: {
                            page_id: item.page_id!,
                            version: item.expected_version!,
                            hash: item.expected_hash!,
                          },
                        }
                      : {}),
                    ...(current
                      ? {
                          expected: {
                            page_id: current.page_id,
                            version: current.version,
                            hash: current.content_hash,
                          },
                        }
                      : {}),
                    ownership: {
                      subscription_id: plan.publisher_subscription_id,
                      member_key:
                        current?.ownership?.member_key ??
                        publicationMemberKey(subscription, item.member_key),
                      mode: "tracked",
                      published_hash: item.content_hash,
                      revision: plan.revision,
                    },
                  }))
                if (!published.verified || published.content_hash !== item.content_hash)
                  return yield* Effect.fail(
                    fail(
                      "UPSTREAM_UNVERIFIED",
                      "Publisher did not verify the frozen content hash.",
                    ),
                  )
                change(index, {
                  member_key: item.member_key,
                  status: "verified",
                  page_id: published.page_id,
                  publication_operation_id: published.publication_operation_id,
                })
                const binding: UpstreamBinding = {
                  subscription_id: plan.subscription_id,
                  member_key: item.member_key,
                  target_key: item.target_key,
                  page_id: published.page_id,
                  generation: item.generation + 1,
                  mode: "tracked",
                  active: true,
                  revision: plan.revision,
                  published_hash: published.content_hash,
                  accepted: item.accepted,
                  materialized: item.candidate,
                }
                yield* state.advance(
                  binding,
                  item.generation,
                  plan.publisher_subscription_id,
                  operation,
                )
              }).pipe(Effect.result)
              if (result._tag === "Failure") {
                const error = result.failure
                const unknown =
                  ["running", "verified"].includes(operation.items[index]?.status ?? "") ||
                  ["WRITE_OUTCOME_UNKNOWN", "UPSTREAM_UNVERIFIED"].includes(error.code)
                change(index, {
                  ...operation.items[index]!,
                  status: unknown ? "unknown" : "failed",
                  error_code: error.code,
                })
                yield* state.saveOperation(operation)
              }
            }
            const allItemsVerified = operation.items.every(
              (item) =>
                item.status === "verified" || item.status === "retained" || item.status === "fork",
            )
            // Only previously accepted members and this operation's verified members may be active.
            const live = yield* state.bindings(plan.subscription_id)
            const memberMap = live
              .filter((b) => b.active)
              .map((b) => ({
                member_key: b.member_key,
                page_id: b.page_id,
                content_hash: b.published_hash,
              }))
            for (const published of subscription.published?.members ?? [])
              if (
                !memberMap.some((member) => member.member_key === published.member_key) &&
                !plan.items.some(
                  (item) =>
                    item.member_key === published.member_key &&
                    item.action === "retain" &&
                    (!selected || selected.has(item.member_key)),
                )
              )
                memberMap.push(published)
            const materializedMembers: PublishedMembers["members"][number][] = []
            for (const member of memberMap) {
              if (selected && !selected.has(member.member_key)) {
                const published = subscription.published?.members.find(
                  (published) => published.member_key === member.member_key,
                )
                if (published)
                  materializedMembers.push({
                    ...published,
                    revision: published.revision ?? subscription.published!.revision,
                  })
                continue
              }
              const inspected = yield* publisher.inspect(member.page_id)
              if (
                !inspected.ownership ||
                inspected.ownership.subscription_id !== plan.publisher_subscription_id
              )
                return yield* Effect.fail(
                  fail(
                    "UPSTREAM_OWNERSHIP_CONFLICT",
                    "Active materialized member lost its publisher ownership.",
                  ),
                )
              materializedMembers.push({
                ...member,
                content_hash: inspected.ownership.published_hash,
                revision: inspected.ownership.revision,
              })
            }
            // A verified child can precede a failed map publication. Selection must not turn
            // its unmaterialized binding into a newly active member or whole-plan completion.
            const allVerified =
              allItemsVerified &&
              operation.items.every((item, index) =>
                item.status === "retained"
                  ? !materializedMembers.some((member) => member.member_key === item.member_key)
                  : item.status !== "verified" ||
                    materializedMembers.some(
                      (member) =>
                        member.member_key === item.member_key &&
                        member.page_id === item.page_id &&
                        member.content_hash === plan.items[index]?.content_hash,
                    ),
              )
            operation = {
              ...operation,
              state: operation.items.some(
                (item) => item.status === "unknown" || item.status === "running",
              )
                ? "unknown"
                : allVerified
                  ? "verified"
                  : "partial",
            }
            const publishedMap = {
              version: 1 as const,
              revision: plan.revision,
              plan_hash: plan.plan_hash,
              publisher_subscription_id: plan.publisher_subscription_id,
              ...(plan.source_manifest?.source_id === plan.subscription_id &&
              plan.source_manifest.revision === plan.revision
                ? { source_manifest: plan.source_manifest }
                : {}),
              members: materializedMembers,
            }
            // Keep the accepted before value before replacing the sole pending intent.
            // A failed later PATCH must not erase an earlier partial map's exact version.
            yield* state.saveCommand(checkpointKey, subscriptionMapCheckpoint(subscription))
            yield* state.saveCommand(`${mapKey}:intended`, publishedMap)
            const publishedSubscription =
              JSON.stringify(subscription.published) !== JSON.stringify(publishedMap) ||
              subscription.status !== (allVerified ? "verified" : "partial")
                ? yield* publishSubscriptionMembers(
                    plan.subscription_id,
                    subscription.version,
                    publishedMap,
                    allVerified ? "verified" : "partial",
                  )
                : subscription
            yield* state.saveCommand(
              checkpointKey,
              subscriptionMapCheckpoint(publishedSubscription),
            )
            for (let index = 0; index < projection.entries.length; index++) {
              const entry = projection.entries[index]!
              if (
                selected &&
                [...entry.before.members, ...entry.after.members].some((member) => {
                  const before = entry.before.members.find(
                    (old) => old.member_key === member.member_key,
                  )
                  const after = entry.after.members.find(
                    (next) => next.member_key === member.member_key,
                  )
                  return (
                    JSON.stringify(before) !== JSON.stringify(after) &&
                    !plan.items.some(
                      (item) => item.page_id === member.page_id && selected.has(item.member_key),
                    )
                  )
                })
              )
                continue
              if (
                entry.after.members.some((member) => {
                  const index = plan.items.findIndex(
                    (item) =>
                      item.page_id === member.page_id && item.content_hash === member.content_hash,
                  )
                  return index >= 0 && operation.items[index]?.status !== "verified"
                })
              )
                continue
              if (entry.status === "verified") continue
              const peer = yield* getSubscription(entry.subscription_id)
              const desired = {
                ...entry.after,
                members: entry.after.members.map((member) => {
                  const itemIndex = plan.items.findIndex((item) => item.page_id === member.page_id)
                  return itemIndex >= 0 && operation.items[itemIndex]?.status !== "verified"
                    ? entry.before.members.find((old) => old.page_id === member.page_id)!
                    : member
                }),
              }
              if (JSON.stringify(peer.published) === JSON.stringify(desired))
                projection = {
                  ...projection,
                  entries: projection.entries.map((old, i) =>
                    i === index ? { ...old, status: "verified" } : old,
                  ),
                }
              else if (
                peer.version !== entry.expected_version ||
                JSON.stringify(peer.published) !== JSON.stringify(entry.before)
              )
                projection = {
                  ...projection,
                  entries: projection.entries.map((old, i) =>
                    i === index ? { ...old, status: "conflict" } : old,
                  ),
                }
              else {
                const result = yield* publishSubscriptionMembers(
                  peer.subscription_id,
                  peer.version,
                  desired,
                  peer.status === "verified" ? "verified" : "partial",
                ).pipe(Effect.result)
                projection = {
                  ...projection,
                  entries: projection.entries.map((old, i) =>
                    i === index
                      ? {
                          ...old,
                          status:
                            result._tag === "Success"
                              ? "verified"
                              : result.failure.code === "WRITE_OUTCOME_UNKNOWN"
                                ? "unknown"
                                : "conflict",
                        }
                      : old,
                  ),
                }
              }
              yield* state.saveCommand(projectionKey, projection)
            }
            if (projection.entries.some((entry) => entry.status !== "verified"))
              operation = {
                ...operation,
                state: projection.entries.some((entry) => entry.status === "unknown")
                  ? "unknown"
                  : "partial",
              }
            operation = { ...operation, projections: projection }
            if (
              operation.state === "verified" &&
              subscription.source.shared_target_set &&
              subscription.source.accepted_ref !== plan.revision
            ) {
              const current = yield* getSubscription(plan.subscription_id)
              if ((yield* subscriptionConfigHash(current)) !== plan.config_hash)
                return yield* Effect.fail(
                  fail(
                    "UPSTREAM_PLAN_STALE",
                    "Source configuration changed before accepted revision advancement.",
                  ),
                )
              yield* state.saveCommand(
                `${plan.plan_id}:accepted-config`,
                yield* subscriptionConfigHash({
                  ...current,
                  source: { ...current.source, accepted_ref: plan.revision },
                }),
              )
              yield* updateSubscription(current.subscription_id, current.version, {
                ...current,
                source: { ...current.source, accepted_ref: plan.revision },
              })
            }
            yield* state.saveOperation(operation)
            yield* invalidateSubscriptionCatalog(scope.scope, plan.target_database_id)
            return operation
          }),
        )
      }),
    )
  })
}
