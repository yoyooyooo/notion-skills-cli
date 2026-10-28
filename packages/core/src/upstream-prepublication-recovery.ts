import { Effect } from "effect"
import { portableIdentity } from "./export.ts"
import { withLocalLocks } from "./local-locks.ts"
import { fail } from "./model.ts"
import { authoredPortable, portableFiles } from "./portable.ts"
import { PublicationReceiptSchema } from "./publication-model.ts"
import { sha256, Store } from "./store.ts"
import {
  publicationMemberKey,
  subscriptionConfigHash,
  targetKey,
  thawPortable,
} from "./upstream-content.ts"
import { UpstreamPublisher, type PublishRequest } from "./upstream-model.ts"
import { UpstreamState } from "./upstream-state.ts"
import { getSubscription, upstreamOperationScope } from "./upstream-subscription.ts"

/** Classifies failures only; preparedCreate must still prove no mutation began. */
export function isPrepublicationReadFailure(code: string | undefined) {
  return code === "RATE_LIMITED" || code === "CATALOG_INCOMPLETE" || code === "NTN_UNAVAILABLE"
}

/** Read the original create request; absence of any proof leaves the child fenced. */
function preparedCreate(planId: string, index: number) {
  return Effect.gen(function* () {
    if (!Number.isSafeInteger(index) || index < 0) return undefined
    const state = yield* UpstreamState
    const plan = yield* state.plan(planId)
    const operation = yield* state.operation(planId)
    if (!plan || !operation) return undefined
    const item = plan.items[index]
    const prior = operation.items[index]
    const { plan_id: _id, plan_hash: _hash, ...body } = plan
    if (
      plan.plan_id !== planId ||
      planId !== `up_${plan.plan_hash}` ||
      (yield* sha256(JSON.stringify(body))) !== plan.plan_hash ||
      operation.operation_id !== `uo_${yield* sha256(planId)}` ||
      operation.plan_id !== planId ||
      operation.subscription_id !== plan.subscription_id ||
      operation.scope !== plan.scope ||
      operation.database_id !== plan.database_id ||
      operation.target_database_id !== plan.target_database_id ||
      operation.state === "verified" ||
      operation.items.length !== plan.items.length ||
      operation.items.some(
        (entry, position) => entry.member_key !== plan.items[position]?.member_key,
      ) ||
      new Set(plan.items.map((entry) => entry.member_key)).size !== plan.items.length ||
      !item ||
      !prior ||
      item.action !== "create" ||
      item.generation !== 0 ||
      item.page_id !== undefined ||
      item.expected_version !== undefined ||
      item.expected_hash !== undefined ||
      !item.candidate ||
      !item.accepted ||
      !item.content_hash ||
      JSON.stringify(item.candidate) !== JSON.stringify(item.accepted) ||
      (prior.status !== "unknown" && prior.status !== "running") ||
      !isPrepublicationReadFailure(prior.error_code) ||
      prior.page_id !== undefined ||
      prior.publication_operation_id !== `${operation.operation_id}:${index}` ||
      plan.source_manifest?.source_id !== plan.subscription_id ||
      plan.source_manifest.revision !== plan.revision ||
      plan.source_manifest.members.filter((member) => member.member_key === item.member_key)
        .length !== 1
    )
      return undefined

    const store = yield* Store
    const publicationId = `p_${yield* sha256(prior.publication_operation_id)}`
    // Publication rows cannot be retired, and publication_intents has an enforced
    // foreign key to publications. Its absent row also proves no retained intent.
    if (yield* store.readJson(`publications/${publicationId}.json`, PublicationReceiptSchema))
      return undefined
    const integrity = yield* store.integrity.inspect(publicationId)
    if (
      !integrity ||
      integrity.version !== 1 ||
      integrity.operation_id !== publicationId ||
      integrity.page_id !== undefined ||
      integrity.marker.version !== 2 ||
      integrity.marker.operation_id !== publicationId ||
      integrity.marker.intended_hash !== integrity.intended_hash ||
      integrity.marker.state !== "writing" ||
      integrity.marker.creation !== undefined ||
      integrity.marker.base_revision !== undefined
    )
      return undefined

    const portable = authoredPortable(yield* thawPortable(item.candidate))
    // Validate every retained file before entering any writer. The integrity
    // identity includes lengths and kind as well as the portable content hash.
    yield* Effect.try({
      try: () => portableFiles(portable),
      catch: () => fail("STATE_CORRUPT", "The original create has invalid frozen content."),
    })
    const files: Array<readonly [string, number, string]> = []
    for (const file of [...portable.files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ))
      files.push([file.path, file.bytes.length, yield* sha256(file.bytes)])
    if (
      (yield* portableIdentity(portable)) !== item.content_hash ||
      (yield* sha256(
        JSON.stringify([portable.kind, portable.name, portable.description, portable.main, files]),
      )) !== integrity.intended_hash
    )
      return undefined

    const scope = yield* upstreamOperationScope
    if (!scope || scope.scope !== plan.scope || scope.database_id !== plan.database_id)
      return undefined
    const subscription = yield* getSubscription(plan.subscription_id)
    if (
      subscription.subscription_id !== plan.subscription_id ||
      subscription.database_id !== plan.database_id ||
      subscription.target_database_id !== plan.target_database_id ||
      !subscription.enabled ||
      subscription.removed ||
      (yield* subscriptionConfigHash(subscription)) !== plan.config_hash ||
      (subscription.source.publisher_subscription_id ?? subscription.subscription_id) !==
        plan.publisher_subscription_id ||
      targetKey(subscription, item.member_key) !== item.target_key ||
      subscription.published?.members.some((member) => member.member_key === item.member_key) ||
      (yield* state.bindings(plan.subscription_id)).some(
        (binding) => binding.member_key === item.member_key,
      ) ||
      (yield* state.target(item.target_key))
    )
      return undefined
    const mapKey = `${planId}:subscription-map`
    const before = yield* state.command(mapKey)
    const intended = yield* state.command(`${mapKey}:intended`)
    const current = subscription.published ?? { unpublished: true }
    if (
      before === undefined ||
      (JSON.stringify(current) !== JSON.stringify(before) &&
        JSON.stringify(current) !== JSON.stringify(intended))
    )
      return undefined

    return {
      publicationId,
      request: {
        operation_id: prior.publication_operation_id,
        portable,
        target_database_id: plan.target_database_id,
        ownership: {
          subscription_id: plan.publisher_subscription_id,
          member_key: publicationMemberKey(subscription, item.member_key),
          mode: "tracked",
          published_hash: item.content_hash,
          revision: plan.revision,
        },
      } satisfies PublishRequest,
    }
  })
}

/** Caller holds the original plan/subscription/target locks and selected this index.
 * Only classified read failures with the complete pre-bind proof recover here.
 * The publication session
 * refuses every HTTP mutation until bind persists its receipt, then journals
 * each intent before sending it. No receipt plus the untouched original writing
 * marker therefore permits the same frozen create to reach its first mutation.
 */
export function recoverPrepublicationCreate(planId: string, originalIndex: number) {
  return Effect.gen(function* () {
    const initial = yield* preparedCreate(planId, originalIndex)
    if (!initial) return undefined
    const store = yield* Store
    return yield* withLocalLocks(
      store.root,
      [`publication:${initial.publicationId}`],
      Effect.gen(function* () {
        const prepared = yield* preparedCreate(planId, originalIndex)
        if (!prepared) return undefined
        // The absent-receipt branch of publish/createPortable does not acquire
        // this lock. Any retained receipt stays on normal reconcile/resume.
        const published = yield* (yield* UpstreamPublisher).publish(prepared.request)
        if (
          !published.verified ||
          published.content_hash !== prepared.request.ownership.published_hash ||
          published.publication_operation_id !== prepared.publicationId
        )
          return yield* Effect.fail(
            fail("UPSTREAM_UNVERIFIED", "The original prepared create was not verified."),
          )
        return published
      }),
    )
  })
}
