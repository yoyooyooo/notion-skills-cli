import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { fail, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { pageId } from "./ref.ts"
import {
  createChecked,
  validateSharedCreatePlan,
  sharedCreateManifest,
  SharedCreateJournalSchema,
  sharedCreateOutcomesEntity,
  sharedCreateEnabled,
  type SharedCreatePlan,
} from "./shared-create-model.ts"
import {
  SharedCreateOutcomeSchema,
  decodeSharedCreateOutcome,
  sharedCreateOutcomeId,
  type SharedCreateOutcome,
  type SharedCreateBinding,
} from "./shared-create-outcome.ts"
import {
  executeSharedCreate,
  reconcileSharedCreate,
  loadSharedCreatePlan,
  sharedCreateJournalKey,
  sharedCreateMainRequest,
  verifySharedCreateRecoveryScope,
  verifySharedCreateRecoveryIndex,
} from "./shared-create.ts"
import { sharedCreateDispatch } from "./shared-create-dispatch.ts"
import { originalKnownCreateBootstrap } from "./shared-create-recovery-known-bootstrap.ts"
import { SharedCreateKnownBootstrapSchema } from "./shared-create-recovery-acknowledgement-model.ts"
import {
  observeSharedCreatePrefixBody,
  assertSharedCreateAcknowledgedMetadata,
} from "./shared-create-recovery-prefix-model.ts"
import { sourceField } from "./shared-source-definitions.ts"
import {
  SharedCreateRecoveryBindingSchema,
  SharedCreateKnownRecoveryObservationSchema,
} from "./shared-create-recovery-proof-model.ts"
import { prepareSharedNativeAllocationProof } from "./shared-create-recovery-acknowledgements.ts"
import { sharedCreateRecoveryJournalKey } from "./shared-create-recovery-prefix.ts"
import { FileEventSchema, type FileEvent } from "./shared-file-state.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import { preservesSharedLibraryBindings, type SharedLibrary } from "./shared-library-model.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  validateSharedRecordEnvelope,
} from "./shared-records.ts"
import { sha256, Store } from "./store.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const OriginalId = Schema.String.check(Schema.isPattern(/^skill-create-[a-f0-9]{64}$/u))
const ReviewId = Schema.String.check(Schema.isPattern(/^create-restore-[a-f0-9]{64}$/u))
const ReviewSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("skill_create_restoration_review"),
  review_id: ReviewId,
  original_operation_id: OriginalId,
  original_plan_sha256: Hash,
  original_manifest_sha256: Hash,
  original_outcome_sha256: Hash,
  library_id: Schema.String,
  skill_id: Schema.String,
  skill_page_id: Schema.String,
  decision: Schema.Literal("resume_exact_original_candidate"),
  bootstrap: SharedCreateKnownBootstrapSchema,
  bindings: Schema.Array(SharedCreateRecoveryBindingSchema),
  observations: Schema.Array(SharedCreateKnownRecoveryObservationSchema),
})
export type SharedCreateRestorationReview = typeof ReviewSchema.Type
const CompletionSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("skill_create_restoration_outcome"),
  review_id: ReviewId,
  original_outcome_sha256: Hash,
  outcome: SharedCreateOutcomeSchema,
})
const reviewEntity = "skill-create-restoration-reviews-v1"
export const sharedCreateRestorationOutcomesEntity = "skill-create-restoration-outcomes-v1"
const reviewRecordId = (operation: string) => "restoration-review-" + operation
const completionRecordId = (operation: string) => "restoration-outcome-" + operation
const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const hash = (value: unknown) => sha256(canonicalSharedJson(value))
const refusal = (message: string) =>
  Effect.fail(fail("SHARED_CREATE_RESTORATION_REQUIRED", message))

function restorationPlan(input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedCreatePlan(input)
    if (
      plan.version !== 1 ||
      plan.source_projection !== undefined ||
      plan.complete_resources !== undefined ||
      (plan.resources?.length ?? 0) !== 0 ||
      plan.files.some((file) => file.event.kind !== "adopted" || file.event.parents.length !== 0)
    )
      return yield* refusal(
        "Select the unchanged ordinary native create with only its original Markdown files.",
      )
    return plan
  })
}

export function validateSharedCreateRestorationReview(
  input: unknown,
  planInput: unknown,
  expectedId?: string,
) {
  return Effect.gen(function* () {
    const plan = yield* restorationPlan(planInput)
    const review = yield* createChecked(() =>
      Schema.decodeUnknownSync(ReviewSchema)(input, { onExcessProperty: "error" }),
    )
    const { review_id, ...fields } = review
    const main = plan.files.find((file) => file.path === plan.entrypoint)!
    const binding = review.bindings[0],
      observation = review.observations[0]
    if (
      review_id !== "create-restore-" + (yield* hash(fields)) ||
      (expectedId !== undefined && review_id !== expectedId) ||
      review.original_operation_id !== plan.operation_id ||
      review.original_plan_sha256 !== (yield* hash(plan)) ||
      review.original_manifest_sha256 !== (yield* hash(sharedCreateManifest(plan))) ||
      review.library_id !== plan.library.library_id ||
      review.skill_id !== plan.skill_id ||
      pageId(review.skill_page_id) !== review.skill_page_id ||
      review.bootstrap.kind !== "known_needs_review" ||
      review.bootstrap.allocations.length !== 1 ||
      review.bindings.length !== 1 ||
      !binding ||
      binding.file_id !== main.file_id ||
      binding.path !== main.path ||
      binding.event_id !== main.event.event_id ||
      binding.page_id !== review.skill_page_id ||
      review.observations.length !== 1 ||
      !observation ||
      observation.file_id !== main.file_id ||
      observation.page_id !== review.skill_page_id ||
      observation.body_sha256 !== main.content.sha256 ||
      observation.body_bytes !== main.content.bytes ||
      review.bootstrap.allocations[0]?.file_id !== main.file_id
    )
      return yield* refusal(
        "The restoration review no longer binds the exact original main, complete input and unchanged candidate.",
      )
    yield* prepareSharedNativeAllocationProof(
      plan,
      review.skill_page_id,
      binding,
      review.bootstrap.allocations[0]!.acknowledgement,
      { attemptId: plan.operation_id, file: main },
    )
    yield* createChecked(() => validateSharedRecordEnvelope(review.review_id, review, "operation"))
    return { plan, review }
  })
}

function originalOutcome(library: SharedLibrary, plan: SharedCreatePlan, page: string) {
  return Effect.gen(function* () {
    const rows = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      entityId: sharedCreateOutcomesEntity,
      recordId: sharedCreateOutcomeId(plan.operation_id),
    })
    if (rows.length !== 1)
      return yield* refusal("The immutable original creation failure is required.")
    const row = rows[0]!
    const outcome = yield* createChecked(() => decodeSharedCreateOutcome(row))
    if (
      outcome.version !== 1 ||
      outcome.status !== "needs_review" ||
      outcome.reason_code !== "SHARED_CREATE_BODY_MISMATCH" ||
      outcome.operation_id !== plan.operation_id ||
      outcome.skill_id !== plan.skill_id ||
      outcome.skill_page_id !== page ||
      outcome.source_projection !== undefined
    )
      return yield* refusal(
        "Only the original ordinary native body-mismatch failure can be restored.",
      )
    return { row, outcome }
  })
}

function observeRestoredMain(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  page: string,
  bindings: readonly SharedCreateBinding[],
  initial: boolean,
) {
  return Effect.gen(function* () {
    yield* verifySharedCreateRecoveryScope(library, plan, page)
    if (initial) yield* verifySharedCreateRecoveryIndex(library, plan, page, bindings, false, true)
    const raw = yield* (yield* Notion).request("v1/pages/" + page)
    if (initial)
      yield* createChecked(() =>
        assertSharedCreateAcknowledgedMetadata(sharedCreateMainRequest(plan.library, plan), raw),
      )
    const origin = library.skills.property_ids.Origin
    if (origin !== undefined) {
      const relation = sourceField(raw, origin)
      if (
        relation.has_more === true ||
        !Array.isArray(relation.relation) ||
        relation.relation.length !== 0
      )
        return yield* refusal("The original native main acquired a Source origin.")
    }
    const sourceMember = library.skills.property_ids["Source Member"]
    if (sourceMember !== undefined && text(sourceField(raw, sourceMember).rich_text) !== "")
      return yield* refusal("The original native main acquired a Source member.")
    const main = plan.files.find((file) => file.path === plan.entrypoint)!
    const body = yield* (yield* Notion).request(
      "v1/pages/" + page + "/markdown?markdown_version=v2",
    )
    const observed = yield* observeSharedCreatePrefixBody(main.file_id, page, body)
    if (observed.body_sha256 !== main.content.sha256 || observed.body_bytes !== main.content.bytes)
      return yield* refusal(
        "The complete current main body does not equal the exact original frozen candidate.",
      )
    return {
      file_id: observed.file_id,
      page_id: observed.page_id,
      format: "notion_markdown_v2" as const,
      normalization_version: 1 as const,
      response_sha256: observed.response_sha256,
      body_sha256: observed.body_sha256,
      body_bytes: observed.body_bytes,
      truncated: false as const,
      unknown_block_count: 0 as const,
      warning_count: 0 as const,
      has_more: false as const,
      next_cursor: null,
    }
  }).pipe(withReadOnlyNotion)
}

export function reviewSharedCreateRestoration(input: {
  readonly entry: string
  readonly plan: unknown
  readonly target: string
}) {
  return Effect.gen(function* () {
    const plan = yield* restorationPlan(input.plan),
      page = pageId(input.target)
    if (!page) return yield* refusal("Select the exact original main page.")
    const library = yield* loadSharedLibrary(input.entry)
    if (!preservesSharedLibraryBindings(plan.library, library))
      return yield* refusal("The original create belongs to another library.")
    const original = yield* originalKnownCreateBootstrap(library, plan, page)
    if (original.originalOutcomeHash === null || original.bindings.length !== 1)
      return yield* refusal("This restoration requires the original known one-main failure.")
    const observed = yield* observeRestoredMain(library, plan, page, original.bindings, true)
    const fields = {
      version: 1 as const,
      kind: "skill_create_restoration_review" as const,
      original_operation_id: plan.operation_id,
      original_plan_sha256: yield* hash(plan),
      original_manifest_sha256: yield* hash(sharedCreateManifest(plan)),
      original_outcome_sha256: original.originalOutcomeHash,
      library_id: library.library_id,
      skill_id: plan.skill_id,
      skill_page_id: page,
      decision: "resume_exact_original_candidate" as const,
      bootstrap: original.bootstrap,
      bindings: original.bindings,
      observations: [observed],
    }
    const review = { ...fields, review_id: "create-restore-" + (yield* hash(fields)) }
    return (yield* validateSharedCreateRestorationReview(review, plan)).review
  }).pipe(withReadOnlyNotion)
}

export function saveSharedCreateRestorationCompletion(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  review: SharedCreateRestorationReview,
  bindings: readonly SharedCreateBinding[],
) {
  const outcome: SharedCreateOutcome = {
    version: 1,
    kind: "skill_create_outcome",
    operation_id: plan.operation_id,
    skill_id: plan.skill_id,
    skill_page_id: review.skill_page_id,
    status: "applied",
    reason_code: "EXACT_ORIGINAL_CANDIDATE_RESTORED_AND_TREE_VERIFIED",
    bindings,
  }
  return appendSharedRecord(library, {
    mode: "create",
    recordId: completionRecordId(plan.operation_id),
    operationId: review.review_id,
    skillPageId: review.skill_page_id,
    kind: "operation",
    entityId: sharedCreateRestorationOutcomesEntity,
    payload: {
      version: 1,
      kind: "skill_create_restoration_outcome",
      review_id: review.review_id,
      original_outcome_sha256: review.original_outcome_sha256,
      outcome,
    },
  })
}

export function readSharedCreateRestoration(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  page: string,
  failed: SharedCreateOutcome,
  failureHash: string,
  suppliedEvents?: readonly FileEvent[],
) {
  return Effect.gen(function* () {
    const completions = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      recordId: completionRecordId(plan.operation_id),
    })
    if (completions.length === 0) return undefined
    const completion = completions[0]!
    const payload = yield* createChecked(() =>
      Schema.decodeUnknownSync(CompletionSchema)(completion.payload, { onExcessProperty: "error" }),
    )
    const reviews = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      recordId: reviewRecordId(plan.operation_id),
    })
    if (completions.length !== 1 || reviews.length !== 1)
      return yield* refusal("The original restoration review and completion must be unique.")
    const reviewed = reviews[0]!
    const { review } = yield* validateSharedCreateRestorationReview(
      reviewed.payload,
      plan,
      payload.review_id,
    )
    const outcome = payload.outcome
    if (
      failed.version !== 1 ||
      failed.status !== "needs_review" ||
      failed.reason_code !== "SHARED_CREATE_BODY_MISMATCH" ||
      failed.operation_id !== plan.operation_id ||
      failed.skill_id !== plan.skill_id ||
      failed.skill_page_id !== page ||
      failed.source_projection !== undefined ||
      !same(failed.bindings, review.bindings) ||
      review.original_outcome_sha256 !== failureHash ||
      payload.original_outcome_sha256 !== failureHash ||
      completion.entity_id !== sharedCreateRestorationOutcomesEntity ||
      completion.operation_id !== review.review_id ||
      reviewed.entity_id !== reviewEntity ||
      reviewed.operation_id !== review.review_id ||
      review.skill_page_id !== page ||
      outcome.version !== 1 ||
      outcome.status !== "applied" ||
      outcome.source_projection !== undefined ||
      outcome.operation_id !== plan.operation_id ||
      outcome.skill_id !== plan.skill_id ||
      outcome.skill_page_id !== page ||
      outcome.bindings.length !== plan.files.length ||
      new Set(outcome.bindings.map((binding) => binding.page_id)).size !== outcome.bindings.length
    )
      return yield* refusal(
        "The restoration completion does not preserve its exact original failure, page and review.",
      )
    const events =
      suppliedEvents ??
      (yield* querySharedRecords(library, { skillPageId: page, kind: "file_event" })).map((row) =>
        Schema.decodeUnknownSync(FileEventSchema)(row.payload, { onExcessProperty: "error" }),
      )
    for (const file of plan.files) {
      const bindings = outcome.bindings.filter((binding) => binding.file_id === file.file_id)
      if (
        bindings.length !== 1 ||
        bindings[0]!.path !== file.path ||
        bindings[0]!.event_id !== file.event.event_id ||
        pageId(bindings[0]!.page_id) !== bindings[0]!.page_id ||
        (file.path === plan.entrypoint && bindings[0]!.page_id !== page) ||
        !events.some((event) => same(event, file.event))
      )
        return yield* refusal(
          "The restoration completion lacks the complete original file and initial event set.",
        )
    }
    return { review, outcome }
  }).pipe(withReadOnlyNotion)
}

export function applySharedCreateRestoration(input: {
  readonly entry: string
  readonly plan: unknown
  readonly review: unknown
  readonly reviewId: string
  readonly dryRun?: boolean
}) {
  const work = Effect.gen(function* () {
    const { plan, review } = yield* validateSharedCreateRestorationReview(
      input.review,
      input.plan,
      input.reviewId,
    )
    const library = yield* loadSharedLibrary(input.entry)
    if (!preservesSharedLibraryBindings(plan.library, library))
      return yield* refusal("The restoration belongs to another exact library.")
    const completed = yield* reconcileSharedCreate(library, plan).pipe(Effect.result)
    if (completed._tag === "Success") return completed.success
    const failure = yield* originalOutcome(library, plan, review.skill_page_id)
    if (
      failure.row.hash !== review.original_outcome_sha256 ||
      !same(failure.outcome.bindings, review.bindings)
    )
      return yield* refusal("The immutable original body-mismatch outcome changed.")
    const store = yield* Store,
      scope = yield* authScope
    const key = yield* sharedCreateRecoveryJournalKey(scope, library.library_id, plan.operation_id)
    const journal = yield* store.readJson(key, Schema.Unknown)
    const expectedJournal = { version: 4, scope, library_id: library.library_id, review }
    const main = plan.files.find((file) => file.path === plan.entrypoint)!
    const allocation = yield* prepareSharedNativeAllocationProof(
      plan,
      review.skill_page_id,
      review.bindings[0]!,
      review.bootstrap.allocations[0]!.acknowledgement,
      { attemptId: plan.operation_id, file: main },
    )
    const namespace = yield* hash([
      yield* (yield* Notion).credentialIdentity,
      plan.library.library_id,
      plan.library.sources?.data_source_id ?? null,
    ])
    const acknowledgementKey =
      "operations/shared-sources/" +
      namespace +
      "/source-ack-" +
      allocation.payload.dispatch.operation.slice("source-op-".length) +
      ".json"
    if (
      !same(
        yield* store.readJson(acknowledgementKey, Schema.Unknown),
        review.bootstrap.allocations[0]!.acknowledgement,
      )
    )
      return yield* refusal("The original main's complete durable ACK is missing or changed.")
    if (
      (yield* store.listKeys("operations/shared-native-recovery/")).some(
        (other) => other !== key && other.endsWith("/" + plan.operation_id + ".json"),
      )
    )
      return yield* refusal(
        "This original restoration already belongs to another credential scope.",
      )
    if (journal === undefined) {
      const original = yield* originalKnownCreateBootstrap(library, plan, review.skill_page_id)
      if (
        !same(original.bootstrap, review.bootstrap) ||
        original.originalOutcomeHash !== review.original_outcome_sha256
      )
        return yield* refusal("The original request and durable ACK set changed after review.")
    } else {
      if (!same(journal, expectedJournal))
        return yield* refusal("The original restoration journal changed.")
      const originalKey = yield* sharedCreateJournalKey(
        scope,
        library.library_id,
        plan.operation_id,
      )
      const original = yield* store.readJson(originalKey, SharedCreateJournalSchema)
      if (
        original === undefined ||
        (yield* hash(original)) !== review.bootstrap.original_journal_sha256 ||
        !same(original.plan, plan)
      )
        return yield* refusal("The original create journal is missing or changed.")
      const restored = yield* loadSharedCreatePlan(library, {
        skillPageId: review.skill_page_id,
        operationId: plan.operation_id,
      })
      if (!same(restored, plan))
        return yield* refusal("The complete retained original input changed.")
    }
    yield* observeRestoredMain(
      library,
      plan,
      review.skill_page_id,
      review.bindings,
      journal === undefined,
    )
    if (input.dryRun)
      return {
        status: "planned" as const,
        dry_run: true as const,
        verified: false as const,
        original_operation_id: plan.operation_id,
        restoration_operation_id: review.review_id,
        skill_page_id: review.skill_page_id,
        original_status: "needs_review" as const,
        original_failure_preserved: true as const,
        write_plan: {
          original_native_file_suffix: plan.files
            .filter((file) => file.path !== plan.entrypoint)
            .map((file) => ({ file_id: file.file_id, path: file.path })),
          maximum_native_page_creates: plan.files.length - 1,
          existing_body_patches: 0,
          enabled: sharedCreateEnabled(plan),
          record_ids: [
            reviewRecordId(plan.operation_id),
            ...plan.files.map((file) => file.event.event_id),
            completionRecordId(plan.operation_id),
          ],
        },
        review,
      }
    if (journal === undefined) yield* store.writeJson(key, expectedJournal)
    const dispatch = yield* sharedCreateDispatch(
      plan.library,
      {
        operation_id: review.review_id,
        skill_id: plan.skill_id,
      },
      observeRestoredMain(library, plan, review.skill_page_id, review.bindings, true).pipe(
        Effect.asVoid,
      ),
    )
    yield* appendSharedRecord(library, {
      mode: "create",
      recordId: reviewRecordId(plan.operation_id),
      operationId: review.review_id,
      skillPageId: review.skill_page_id,
      kind: "operation",
      entityId: reviewEntity,
      payload: review,
    }).pipe(Effect.provideService(Notion, dispatch.api))
    const result = yield* executeSharedCreate(library, {
      plan,
      mode: "create",
      restoration: review,
    })
    yield* store.retireKeys([key])
    return {
      ...result,
      restoration_operation_id: review.review_id,
      original_failure_preserved: true as const,
    }
  })
  return input.dryRun ? work.pipe(withReadOnlyNotion) : work
}

export function reconcileSharedCreateRestoration(input: {
  readonly entry: string
  readonly plan: unknown
  readonly target: string
}) {
  return Effect.gen(function* () {
    const plan = yield* restorationPlan(input.plan),
      library = yield* loadSharedLibrary(input.entry)
    const result = yield* reconcileSharedCreate(library, plan)
    if (result.skill_page_id !== pageId(input.target))
      return yield* refusal("The original restoration belongs to another page.")
    return {
      ...result,
      original_failure_preserved: true as const,
      current_snapshot_verified: false as const,
    }
  }).pipe(withReadOnlyNotion)
}
