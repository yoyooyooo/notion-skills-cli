import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { invalidateSnapshotCache, invalidateSubscriptionCatalog } from "./cache.ts"
import { fail, property } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { pageId } from "./ref.ts"
import { sharedSkillId } from "./shared-content.ts"
import {
  createChecked,
  sharedCreateBodyPayload,
  sharedCreateInputPayload,
  sharedCreateManifest,
  sharedCreateManifestEntity,
} from "./shared-create-model.ts"
import { sharedCreateJournalKey } from "./shared-create.ts"
import { sharedCreateDispatch } from "./shared-create-dispatch.ts"
import { saveSharedCreateOwnership } from "./shared-create-ownership.ts"
import {
  sharedCreateRecoveryOutcomeId,
  sharedCreateRecoveryReviewId,
} from "./shared-create-recovery-completion.ts"
import { sharedCreateRecoveryJournalKey } from "./shared-create-recovery-prefix.ts"
import {
  originalNativeMainAllocation,
  observeNativeMainRecovery,
  acknowledgedNativeRecoveryPrefix,
  type NativeRecoveryFact,
} from "./shared-create-recovery-native-authority.ts"
import { readSharedCreateNativeCompletion } from "./shared-create-recovery-native-completion.ts"
import {
  sharedNativeRecoveryOutcomesEntity,
  sharedNativeRecoveryReviewEntity,
  type SharedNativeRecoveryOrigin,
  type SharedCreateNativeRecoveryReview,
  type SharedCreateNativeRecoveryOutcome,
} from "./shared-create-recovery-native-model.ts"
import {
  nativeMainRecoveryPlan,
  makeSharedCreateNativeRecoveryFile,
  makeSharedCreateNativeRecoveryReview,
  validateSharedCreateNativeRecoveryReview,
} from "./shared-create-recovery-native-plan.ts"
import { prefixRecoveryRequired } from "./shared-create-recovery-errors.ts"
import { FileEventSchema } from "./shared-file-state.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import { querySharedOperationIndex } from "./shared-operation-index.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  validateSharedRecordEnvelope,
} from "./shared-records.ts"
import { sha256, Store } from "./store.ts"

const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const hash = (value: unknown) => sha256(canonicalSharedJson(value))
const refusal = (message: string) => Effect.fail(prefixRecoveryRequired(message))

export function reviewSharedCreateNativeRecovery(input: {
  readonly entry: string
  readonly plan: unknown
  readonly target: string
  readonly origin: SharedNativeRecoveryOrigin
}) {
  return Effect.gen(function* () {
    const plan = yield* nativeMainRecoveryPlan(input.plan),
      page = pageId(input.target)
    if (!page) return yield* refusal("Select the exact original acknowledged native main page.")
    const library = yield* loadSharedLibrary(input.entry)
    const original = yield* originalNativeMainAllocation(plan, page)
    const observation = yield* observeNativeMainRecovery(library, plan, page)
    return yield* makeSharedCreateNativeRecoveryReview({
      plan,
      page,
      origin: input.origin,
      bootstrap: original.bootstrap,
      observations: [observation],
    })
  }).pipe(withReadOnlyNotion)
}

export function reconcileSharedCreateNativeRecovery(input: {
  readonly entry: string
  readonly plan: unknown
  readonly target: string
}) {
  return Effect.gen(function* () {
    const plan = yield* nativeMainRecoveryPlan(input.plan),
      page = pageId(input.target)
    if (!page) return yield* refusal("Select the original native main allocation.")
    const library = yield* loadSharedLibrary(input.entry)
    const headers = yield* querySharedOperationIndex(library, page)
    const manifests = headers.filter(
      (header) =>
        header.record_id === plan.operation_id && header.entity_id === sharedCreateManifestEntity,
    )
    if (manifests.length !== 1)
      return yield* refusal(
        "No exact native recovery manifest is visible; never replay the original main or recovery suffix.",
      )
    const eventRows = yield* querySharedRecords(library, { skillPageId: page, kind: "file_event" })
    const events = yield* createChecked(() =>
      eventRows.map((row) =>
        Schema.decodeUnknownSync(FileEventSchema)(row.payload, { onExcessProperty: "error" }),
      ),
    )
    const result = yield* readSharedCreateNativeCompletion(library, {
      skillPageId: page,
      originalManifestHeader: manifests[0]!,
      headers,
      events,
    })
    if (result === undefined || !same(result.plan, plan))
      return yield* refusal(
        "The exact native recovery completion remains missing or unknown; reconciliation grants no new write.",
      )
    const scope = yield* authScope
    yield* saveSharedCreateOwnership(scope, plan, result.outcome.bindings)
    yield* (yield* Store).retireKeys([
      yield* sharedCreateJournalKey(scope, library.library_id, plan.operation_id),
      yield* sharedCreateRecoveryJournalKey(scope, library.library_id, plan.operation_id),
    ])
    return {
      status: "recovered" as const,
      original_operation_id: plan.operation_id,
      recovery_operation_id: result.review.review_id,
      skill_page_id: page,
      original_status: "acknowledged_prefix" as const,
      original_outcome_recorded: false as const,
      verification: "original_native_recovery_outcome" as const,
      verified: true as const,
      current_snapshot_verified: false as const,
      requires_fresh_read: true as const,
      existing_pages_preserved: 1,
      created_pages: 0,
      reused: true as const,
    }
  }).pipe(withReadOnlyNotion)
}

function recoveryFacts(
  plan: Effect.Success<ReturnType<typeof nativeMainRecoveryPlan>>,
  review: SharedCreateNativeRecoveryReview,
  proof: Effect.Success<ReturnType<typeof originalNativeMainAllocation>>["proof"],
) {
  return Effect.gen(function* () {
    const old = plan.files[0]!,
      file = yield* makeSharedCreateNativeRecoveryFile(plan)
    const reviewHash = yield* hash({ version: 1, operation_id: review.review_id, payload: review })
    const completion: SharedCreateNativeRecoveryOutcome = {
      version: 7,
      kind: "skill_create_recovery_outcome",
      status: "applied",
      original_operation_id: plan.operation_id,
      original_plan_sha256: review.original_plan_sha256,
      original_manifest_sha256: review.original_manifest_sha256,
      original_outcome_sha256: null,
      bootstrap_sha256: yield* hash(review.bootstrap),
      recovery_id: review.review_id,
      skill_id: plan.skill_id,
      skill_page_id: review.skill_page_id,
      review_record_hash: reviewHash,
      bindings: [
        {
          file_id: file.file_id,
          path: file.path,
          page_id: review.skill_page_id,
          event_id: file.event.event_id,
        },
      ],
    }
    const items: Array<Omit<NativeRecoveryFact, "hash">> = [
      {
        record_id: sharedCreateRecoveryReviewId(plan.operation_id),
        operation_id: review.review_id,
        entity_id: sharedNativeRecoveryReviewEntity,
        kind: "operation",
        payload: review,
      },
      {
        record_id: proof.reference.record_id,
        operation_id: proof.operation_id,
        entity_id: proof.reference.record_id,
        kind: "object",
        payload: proof.payload,
      },
      {
        record_id: plan.operation_id,
        operation_id: plan.operation_id,
        entity_id: sharedCreateManifestEntity,
        kind: "operation",
        payload: sharedCreateManifest(plan),
      },
      {
        record_id: old.input.object_id,
        operation_id: "retain-input-" + old.input.sha256,
        entity_id: old.input.object_id,
        kind: "object",
        payload: sharedCreateInputPayload(old.input.text),
      },
      {
        record_id: old.content.object_id,
        operation_id: "retain-" + old.content.sha256,
        entity_id: old.content.object_id,
        kind: "object",
        payload: sharedCreateBodyPayload(old.projection.markdown),
      },
      {
        record_id: file.content.object_id,
        operation_id: "retain-" + file.content.sha256,
        entity_id: file.content.object_id,
        kind: "object",
        payload: sharedCreateBodyPayload(file.projection.markdown),
      },
      {
        record_id: file.event.event_id,
        operation_id: file.event.event_id,
        entity_id: file.file_id,
        kind: "file_event",
        payload: file.event,
      },
      {
        record_id: sharedCreateRecoveryOutcomeId(plan.operation_id),
        operation_id: review.review_id,
        entity_id: sharedNativeRecoveryOutcomesEntity,
        kind: "operation",
        payload: completion,
      },
    ]
    const facts = new Map<string, NativeRecoveryFact>()
    for (const item of items) {
      yield* createChecked(() =>
        validateSharedRecordEnvelope(item.operation_id, item.payload, item.kind),
      )
      const fact = {
        ...item,
        hash: yield* hash({ version: 1, operation_id: item.operation_id, payload: item.payload }),
      }
      const prior = facts.get(item.record_id)
      if (prior && !same(prior, fact))
        return yield* refusal(
          "The native recovery fact union contains conflicting immutable identities.",
        )
      facts.set(item.record_id, fact)
    }
    return { facts: [...facts.values()], completion }
  })
}

export function applySharedCreateNativeRecovery(input: {
  readonly entry: string
  readonly plan: unknown
  readonly review: unknown
  readonly reviewId: string
  readonly origin: SharedNativeRecoveryOrigin
  readonly dryRun?: boolean
}) {
  return Effect.gen(function* () {
    const plan = yield* nativeMainRecoveryPlan(input.plan)
    const review = yield* validateSharedCreateNativeRecoveryReview(input.review, input.reviewId)
    if (!same(review.origin, input.origin))
      return yield* refusal("The native recovery belongs to another original inventory approval.")
    const library = yield* loadSharedLibrary(input.entry),
      page = review.skill_page_id
    const rebuilt = yield* makeSharedCreateNativeRecoveryReview({
      plan,
      page,
      origin: input.origin,
      bootstrap: review.bootstrap,
      observations: review.observations,
    })
    if (!same(rebuilt, review))
      return yield* refusal(
        "The inspected native review changed the original complete creation intent.",
      )
    const store = yield* Store,
      scope = yield* authScope
    const key = yield* sharedCreateRecoveryJournalKey(scope, library.library_id, plan.operation_id)
    if (
      (yield* store.listKeys("operations/shared-native-recovery/")).some(
        (item) => item !== key && item.endsWith("/" + plan.operation_id + ".json"),
      )
    )
      return yield* refusal("A native recovery attempt already exists in another credential scope.")
    const sharedReviews = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      recordId: sharedCreateRecoveryReviewId(plan.operation_id),
      payloadContainsBody: true,
    })
    const journal = yield* store.readJson(key, Schema.Unknown)
    const prior = journal !== undefined || sharedReviews.length !== 0
    const reconciled = prior
      ? yield* reconcileSharedCreateNativeRecovery({ entry: input.entry, plan, target: page }).pipe(
          Effect.result,
        )
      : undefined
    if (reconciled?._tag === "Success") return reconciled.success
    if (prior && !same(journal, { version: 3, scope, library_id: library.library_id, review }))
      return yield* refusal("The exact original native recovery journal is missing or changed.")
    const original = yield* originalNativeMainAllocation(plan, page)
    if (!same(original.bootstrap, review.bootstrap))
      return yield* refusal("The original native dispatch or durable ACK changed after review.")
    const planned = yield* recoveryFacts(plan, review, original.proof)
    const prefix = prior
      ? yield* acknowledgedNativeRecoveryPrefix(library, review, planned.facts)
      : []
    if (prefix === undefined) {
      if (reconciled?._tag === "Failure") return yield* Effect.fail(reconciled.failure)
      return yield* refusal("Only the exact acknowledged native recovery prefix can continue.")
    }
    yield* observeNativeMainRecovery(library, plan, page, prefix)
    const remaining = planned.facts.slice(prefix.length)
    if (input.dryRun)
      return {
        status: "planned" as const,
        dry_run: true as const,
        verified: false as const,
        original_operation_id: plan.operation_id,
        recovery_operation_id: review.review_id,
        original_status: "acknowledged_prefix" as const,
        original_outcome_recorded: false as const,
        existing_pages: 1,
        remaining_pages: 0,
        acknowledged_records: prefix.length,
        write_plan: {
          record_ids: remaining.map((fact) => fact.record_id).sort(),
          maximum_record_creates: remaining.length,
          native_page_creates: 0,
          existing_body_patches: 0,
          metadata_patches: 0,
          notion_write_upper_bound: remaining.length,
        },
        review,
      }
    if (journal === undefined)
      yield* store.writeJson(key, { version: 3, scope, library_id: library.library_id, review })
    const acknowledged: NativeRecoveryFact[] = [...prefix]
    let stage = "review"
    const dispatch = yield* sharedCreateDispatch(
      plan.library,
      { operation_id: review.review_id, skill_id: plan.skill_id },
      observeNativeMainRecovery(library, plan, page, acknowledged).pipe(Effect.asVoid),
    )
    return yield* Effect.gen(function* () {
      for (const fact of remaining) {
        stage = fact.record_id
        yield* appendSharedRecord(library, {
          mode: "create",
          recordId: fact.record_id,
          operationId: fact.operation_id,
          skillPageId: page,
          kind: fact.kind,
          entityId: fact.entity_id,
          payload: fact.payload,
          payloadContainsBody: true,
        })
        acknowledged.push(fact)
      }
      yield* observeNativeMainRecovery(library, plan, page, acknowledged)
      const result = yield* reconcileSharedCreateNativeRecovery({
        entry: input.entry,
        plan,
        target: page,
      })
      yield* invalidateSubscriptionCatalog(scope, library.skills.database_id)
      yield* invalidateSnapshotCache(sharedSkillId(library.library_id, plan.skill_id), scope)
      return { ...result, reused: false as const }
    }).pipe(
      Effect.provideService(Notion, dispatch.api),
      Effect.mapError((error) =>
        fail(error.code, error.message, {
          ...property(error.details),
          original_operation_id: plan.operation_id,
          recovery_operation_id: review.review_id,
          skill_page_id: page,
          stage,
          next: {
            command: "ctl library inventory recovery reconcile",
            original_plan_required: true,
            target: page,
          },
        }),
      ),
    )
  })
}
