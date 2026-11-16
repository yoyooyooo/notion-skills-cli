import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { fail, property } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { pageId } from "./ref.ts"
import {
  createChecked,
  sharedCreateManifestEntity,
  type SharedCreatePlan,
} from "./shared-create-model.ts"
import { sharedCreateFileRequest } from "./shared-create.ts"
import { sharedCreateManifestRecordHash } from "./shared-create-outcome.ts"
import { sharedCreateDispatch } from "./shared-create-dispatch.ts"
import { resolveSharedCreateSource } from "./shared-create-source.ts"
import { withObservedBody } from "./shared-create-import-readback.ts"
import { assertSharedCreateAcknowledgedMetadata } from "./shared-create-recovery-prefix-model.ts"
import { SharedCreateFrozenPostSchema } from "./shared-create-recovery-acknowledgement-model.ts"
import {
  readSharedNativeAllocationProofs,
  retainSharedNativeAllocationProofs,
} from "./shared-create-recovery-acknowledgements.ts"
import {
  inspectRetainedImportFileResubmissionPrefix,
  readRetainedImportResubmissionAuthority,
} from "./shared-create-retained-recovery.ts"
import {
  readSharedCreateTextPayload,
  retainSharedCreateText,
} from "./shared-create-text-retention.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import { preservesSharedLibraryBindings, type SharedLibrary } from "./shared-library-model.ts"
import { projectNativeImageBlocks } from "./shared-native-image-layout.ts"
import { assertImportedMarkdownContent } from "./shared-import-markdown.ts"
import { selectOriginalSourceRecoveryPlan, sourceRecoveryError } from "./shared-source-recovery.ts"
import { withSourceUpdateLock } from "./shared-source-policy.ts"
import {
  SourceMutationAcknowledgementSchema,
  SourceMutationRejectionSchema,
} from "./shared-sources-model.ts"
import {
  SourceFileResubmissionPlanSchema,
  SourceFileResubmissionReviewRecordSchema,
  SourceFileResubmissionCompletionSchema,
  SourceFileResubmissionCompletionRecordSchema,
  type SourceFileResubmissionPlan,
  type SourceFileResubmissionCompletionReference,
  type VerifiedNativeFileSubstitution,
} from "./shared-source-file-resubmission-model.ts"
import { appendSharedRecord, canonicalSharedJson, querySharedRecords } from "./shared-records.ts"
import type { SharedOperationHeader } from "./shared-operation-index.ts"
import { sha256, Store } from "./store.ts"

export { SourceFileResubmissionPlanSchema } from "./shared-source-file-resubmission-model.ts"
export type { SourceFileResubmissionPlan } from "./shared-source-file-resubmission-model.ts"

const reviewsEntity = "source-file-resubmission-reviews-v1"
const outcomesEntity = "source-file-resubmission-outcomes-v1"
const reviewRecord = (operation: string, file: string) =>
  `source-file-resubmission-review-${operation}-${file}`
const outcomeRecord = (operation: string, file: string) =>
  `source-file-resubmission-outcome-${operation}-${file}`
const same = (a: unknown, b: unknown) => canonicalSharedJson(a) === canonicalSharedJson(b)
const hash = (value: unknown) => sha256(canonicalSharedJson(value))
const refusal = (message: string) => Effect.fail(fail("SOURCE_FILE_RESUBMISSION_REQUIRED", message))
type OriginalInput = {
  readonly entry: string
  readonly plan: unknown
  readonly operationId?: string
}
type ApplyInput = OriginalInput & {
  readonly review: unknown
  readonly reviewId: string
  readonly dryRun?: boolean
}
type FrozenPost = typeof SharedCreateFrozenPostSchema.Type
type TextReference = { readonly sha256: string; readonly bytes: number }

function context(input: OriginalInput) {
  return Effect.gen(function* () {
    const plan = yield* selectOriginalSourceRecoveryPlan(input.plan, input.operationId)
    const library = yield* loadSharedLibrary(input.entry)
    if (
      plan.version !== 1 ||
      plan.source_projection?.version !== 2 ||
      plan.enabled !== false ||
      !preservesSharedLibraryBindings(plan.library, library)
    )
      return yield* refusal(
        "Select the exact original disabled retained import and registered library.",
      )
    return { plan, library }
  })
}

function frozenPost(operation: string, body: unknown) {
  return Effect.gen(function* () {
    const request = {
      identity: operation + ":" + (yield* hash(["v1/pages", "POST", body])),
      path: "v1/pages" as const,
      method: "POST" as const,
      body,
    }
    return { version: 1 as const, operation: "source-op-" + (yield* hash(request)), ...request }
  })
}
const textRef = (value: string) =>
  Effect.gen(function* () {
    return { sha256: yield* sha256(value), bytes: new TextEncoder().encode(value).length }
  })
function sourceRoot(library: SharedLibrary) {
  return Effect.gen(function* () {
    return `operations/shared-sources/${yield* hash([
      yield* (yield* Notion).credentialIdentity,
      library.library_id,
      library.sources?.data_source_id ?? null,
    ])}/`
  })
}
function slotKey(plan: SharedCreatePlan, file: string) {
  return Effect.gen(function* () {
    return `operations/shared-native-resubmissions/${yield* authScope}/${plan.operation_id}/${yield* sha256(file)}.json`
  })
}
function verifyRejection(dispatch: FrozenPost, value: unknown) {
  return Effect.gen(function* () {
    const rejection = yield* createChecked(() =>
      Schema.decodeUnknownSync(SourceMutationRejectionSchema)(value, { onExcessProperty: "error" }),
    )
    if (
      rejection.operation_id !== dispatch.operation ||
      rejection.request_hash !== (yield* hash(dispatch)) ||
      !Number.isSafeInteger(rejection.rejected_at) ||
      rejection.rejected_at < 0
    )
      return yield* refusal(
        "A complete matching original 400 validation_error/not_applied receipt is required.",
      )
    return rejection
  })
}
function originalRefusal(library: SharedLibrary, plan: SharedCreatePlan, dispatch: FrozenPost) {
  return Effect.gen(function* () {
    const root = yield* sourceRoot(library),
      store = yield* Store
    const key = root + dispatch.operation + ".json"
    const suffix = dispatch.operation.slice("source-op-".length)
    if (
      !same(yield* store.readJson(key, Schema.Unknown), dispatch) ||
      (yield* store.readJson(root + "source-ack-" + suffix + ".json", Schema.Unknown)) !==
        undefined ||
      (yield* store.readJson(root + "source-receipt-" + suffix + ".json", Schema.Unknown)) !==
        undefined
    )
      return yield* refusal(
        "The exact rejected original POST must remain unacknowledged and unapplied.",
      )
    const rejection = yield* verifyRejection(
      dispatch,
      yield* store.readJson(root + "source-rejection-" + suffix + ".json", Schema.Unknown),
    )
    for (const otherKey of yield* store.listKeys(root)) {
      if (!/\/source-op-[a-f0-9]{64}\.json$/u.test(otherKey) || otherKey === key) continue
      const pending = property(yield* store.readJson(otherKey, Schema.Unknown))
      if (
        typeof pending.identity !== "string" ||
        !pending.identity.startsWith(plan.operation_id + ":")
      )
        continue
      if (
        (yield* store.readJson(otherKey.replace("/source-op-", "/source-ack-"), Schema.Unknown)) ===
        undefined
      )
        return yield* refusal(
          "Another original dispatch has no complete acknowledgement; do not bypass an unknown request.",
        )
    }
    return rejection
  })
}

function validatePlan(plan: SharedCreatePlan, value: unknown, expectedId?: string) {
  return Effect.gen(function* () {
    const saved = yield* createChecked(() =>
      Schema.decodeUnknownSync(SourceFileResubmissionPlanSchema)(value, {
        onExcessProperty: "error",
      }),
    )
    const review = saved.review,
      { review_id, ...fields } = review
    const resolved = yield* resolveSharedCreateSource(plan, review.skill_page_id)
    const file = resolved.facts.files.find(
      (file) => file.file_id === review.file_id && file.path === review.path,
    )
    if (
      !file ||
      file.path === plan.entrypoint ||
      review_id !== "source-file-resubmission-" + (yield* hash(fields)) ||
      (expectedId !== undefined && review_id !== expectedId) ||
      review.original_operation_id !== plan.operation_id ||
      review.library_id !== plan.library.library_id ||
      review.skill_id !== plan.skill_id ||
      pageId(review.skill_page_id) !== review.skill_page_id ||
      review.source_id !== resolved.selection?.source_id ||
      review.plan_sha256 !== (yield* hash(plan)) ||
      review.manifest_sha256 !== (yield* sharedCreateManifestRecordHash(plan))
    )
      return yield* refusal("The independently reviewed identity or original source plan changed.")
    const original = yield* frozenPost(
      plan.operation_id,
      sharedCreateFileRequest(plan.library, review.skill_page_id, file),
    )
    if (
      !same(original, saved.original_dispatch) ||
      review.original_request_sha256 !== (yield* hash(original)) ||
      review.original_rejection_sha256 !== (yield* hash(saved.original_rejection))
    )
      return yield* refusal("The original complete wire request or negative receipt changed.")
    yield* verifyRejection(original, saved.original_rejection)
    const markdown = property(original.body).markdown
    if (typeof markdown !== "string")
      return yield* refusal("The rejected request has no complete native Markdown input.")
    const candidate = yield* createChecked(() => projectNativeImageBlocks(markdown))
    if (
      candidate.kind !== "changed" ||
      !same(candidate.summary, review.changes) ||
      review.candidate_body_sha256 !== (yield* sha256(candidate.markdown))
    )
      return yield* refusal(
        "The candidate must be exactly the reviewed image-block line-feed insertion.",
      )
    const ordered = [
      plan.files.find((item) => item.path === plan.entrypoint)!,
      ...plan.files.filter((item) => item.path !== plan.entrypoint),
    ]
    if (
      review.bindings.length === 0 ||
      ordered[review.bindings.length]?.file_id !== file.file_id ||
      review.allocations.length !== review.bindings.length ||
      review.observations.length !== review.bindings.length ||
      new Set(review.bindings.map((binding) => binding.page_id)).size !== review.bindings.length ||
      review.bindings.some(
        (binding, index) =>
          binding.file_id !== ordered[index]?.file_id ||
          binding.path !== ordered[index]?.path ||
          pageId(binding.page_id) !== binding.page_id ||
          review.observations[index]?.file_id !== binding.file_id ||
          review.observations[index]?.page_id !== binding.page_id,
      )
    )
      return yield* refusal(
        "The independently reviewed complete acknowledged prefix is not the exact original file order.",
      )
    const next = yield* frozenPost(review_id, {
      ...property(original.body),
      markdown: candidate.markdown,
    })
    return { saved, review, file, resolved, candidate: candidate.markdown, next }
  })
}

function verifyNewAck(dispatch: FrozenPost, input: unknown) {
  return Effect.gen(function* () {
    const ack = yield* createChecked(() =>
      Schema.decodeUnknownSync(SourceMutationAcknowledgementSchema)(input, {
        onExcessProperty: "error",
      }),
    )
    const response = property(ack.response),
      page = response.id
    if (
      ack.operation_id !== dispatch.operation ||
      ack.request_hash !== (yield* hash(dispatch)) ||
      ack.response_hash !== (yield* hash(ack.response)) ||
      !Number.isSafeInteger(ack.acknowledged_at) ||
      ack.acknowledged_at < 0 ||
      response.object !== "page" ||
      typeof page !== "string" ||
      pageId(page) !== page ||
      response.archived === true ||
      response.is_archived === true ||
      response.in_trash === true ||
      property(response.parent).data_source_id !==
        property(property(dispatch.body).parent).data_source_id
    )
      return yield* refusal(
        "The independent native POST lacks its exact complete durable page acknowledgement.",
      )
    yield* createChecked(() => assertSharedCreateAcknowledgedMetadata(dispatch.body, ack.response))
    return { ack, page }
  })
}
function localNewAck(library: SharedLibrary, dispatch: FrozenPost) {
  return Effect.gen(function* () {
    const root = yield* sourceRoot(library),
      store = yield* Store
    const key = root + dispatch.operation + ".json",
      suffix = dispatch.operation.slice("source-op-".length)
    const pending = yield* store.readJson(key, Schema.Unknown)
    const ack = yield* store.readJson(root + "source-ack-" + suffix + ".json", Schema.Unknown)
    const rejected = yield* store.readJson(
      root + "source-rejection-" + suffix + ".json",
      Schema.Unknown,
    )
    const receipt = yield* store.readJson(
      root + "source-receipt-" + suffix + ".json",
      Schema.Unknown,
    )
    if (
      pending === undefined &&
      ack === undefined &&
      rejected === undefined &&
      receipt === undefined
    )
      return undefined
    if (!same(pending, dispatch) || ack === undefined || rejected !== undefined)
      return yield* Effect.fail(
        fail(
          "SOURCE_FILE_RESUBMISSION_PENDING",
          "The independent request is unacknowledged or rejected; preserve its identity and never resend it.",
        ),
      )
    return yield* verifyNewAck(dispatch, ack)
  })
}

function readText(
  library: SharedLibrary,
  page: string,
  ref: TextReference,
  kind: "input" | "body",
) {
  return Effect.gen(function* () {
    const id = (kind === "input" ? "input-" : "body-") + ref.sha256
    const rows = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "object",
      entityId: id,
      recordId: id,
      payloadContainsBody: true,
    })
    if (
      rows.length !== 1 ||
      rows[0]!.operation_id !== (kind === "input" ? "retain-input-" : "retain-") + ref.sha256
    )
      return yield* refusal("A complete immutable request, response or body proof is missing.")
    return yield* readSharedCreateTextPayload(library, page, { kind, ...ref }, rows[0]!.payload)
  })
}

function savedReview(library: SharedLibrary, plan: SharedCreatePlan, page: string, file: string) {
  return Effect.gen(function* () {
    const rows = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      entityId: reviewsEntity,
      recordId: reviewRecord(plan.operation_id, file),
    })
    if (rows.length === 0) return undefined
    if (rows.length !== 1) return yield* refusal("The independent file review is duplicated.")
    const row = rows[0]!,
      record = yield* createChecked(() =>
        Schema.decodeUnknownSync(SourceFileResubmissionReviewRecordSchema)(row.payload, {
          onExcessProperty: "error",
        }),
      )
    const input = yield* readText(library, page, record.plan, "input")
    const decoded = yield* validatePlan(
      plan,
      yield* createChecked(() => JSON.parse(input)),
      record.review_id,
    )
    if (
      record.original_operation_id !== plan.operation_id ||
      record.file_id !== file ||
      record.path !== decoded.review.path ||
      row.operation_id !== record.review_id ||
      decoded.review.skill_page_id !== page
    )
      return yield* refusal("The shared independent review changed its original file or parent.")
    return { row, decoded }
  })
}

function readCompletion(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  page: string,
  file: string,
) {
  return Effect.gen(function* () {
    const rows = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      entityId: outcomesEntity,
      recordId: outcomeRecord(plan.operation_id, file),
    })
    if (rows.length === 0) return undefined
    if (rows.length !== 1) return yield* refusal("The independent file completion is duplicated.")
    const record = yield* createChecked(() =>
      Schema.decodeUnknownSync(SourceFileResubmissionCompletionRecordSchema)(rows[0]!.payload, {
        onExcessProperty: "error",
      }),
    )
    const saved = yield* savedReview(library, plan, page, file)
    if (!saved)
      return yield* refusal("The independent completion has no complete reviewed original request.")
    const { decoded } = saved,
      review = decoded.review
    const serialized = yield* readText(library, page, record.proof, "input")
    const outcome = yield* createChecked(() =>
      Schema.decodeUnknownSync(SourceFileResubmissionCompletionSchema)(JSON.parse(serialized), {
        onExcessProperty: "error",
      }),
    )
    if (
      record.original_operation_id !== plan.operation_id ||
      record.file_id !== file ||
      record.path !== review.path ||
      record.review_id !== review.review_id ||
      rows[0]!.operation_id !== review.review_id ||
      outcome.review_id !== review.review_id ||
      outcome.original_operation_id !== plan.operation_id ||
      outcome.skill_page_id !== page ||
      outcome.file_id !== file ||
      outcome.path !== review.path ||
      !same(outcome.new_dispatch, decoded.next)
    )
      return yield* refusal(
        "The independent completion does not bind the full original review and exact new dispatch.",
      )
    const authority = yield* readRetainedImportResubmissionAuthority(library, plan, page)
    if (
      authority.original.row.hash !== review.failure_sha256 ||
      authority.review.review_id !== review.retained_review_id ||
      authority.reviewRecord.hash !== review.retained_review_hash ||
      authority.review.bootstrap.original_journal_sha256 !== review.journal_sha256 ||
      authority.review.permission_scope !== review.permission_scope ||
      authority.review.bindings.some((binding, index) => !same(binding, review.bindings[index])) ||
      authority.review.observations.some((body, index) => !same(body, review.observations[index]))
    )
      return yield* refusal(
        "The independent file review lost its immutable original failure or retained recovery authority.",
      )
    yield* readSharedNativeAllocationProofs(
      library,
      plan,
      page,
      review.bindings,
      review.allocations,
      (binding) => ({
        attemptId: plan.operation_id,
        file: decoded.resolved.facts.files.find((item) => item.file_id === binding.file_id)!,
      }),
    )
    for (const observation of review.observations) {
      const before = yield* readText(
        library,
        page,
        { sha256: observation.body_sha256, bytes: observation.body_bytes },
        "body",
      )
      const native = decoded.resolved.facts.files.find(
        (item) => item.file_id === observation.file_id,
      )!
      const observed = yield* withObservedBody(native, before)
      if (observed.event.event_id !== observation.event_id)
        return yield* refusal(
          "An original prefix observation does not reconstruct its complete retained body event.",
        )
    }
    const acknowledged = yield* verifyNewAck(decoded.next, outcome.new_acknowledgement)
    if (
      outcome.page_id !== acknowledged.page ||
      review.bindings.some((binding) => binding.page_id === outcome.page_id) ||
      outcome.observation.file_id !== file ||
      outcome.observation.page_id !== outcome.page_id
    )
      return yield* refusal(
        "The independent new ACK cannot replace or reuse an original prefix page.",
      )
    const body = yield* readText(
      library,
      page,
      { sha256: outcome.observation.body_sha256, bytes: outcome.observation.body_bytes },
      "body",
    )
    yield* createChecked(() => assertImportedMarkdownContent(decoded.candidate, body))
    const observed = yield* withObservedBody(decoded.file, body)
    if (observed.event.event_id !== outcome.observation.event_id)
      return yield* refusal(
        "The completed replacement body does not reconstruct the original file event.",
      )
    return {
      original_operation_id: plan.operation_id,
      file_id: file,
      path: review.path,
      original_dispatch: decoded.saved.original_dispatch,
      original_rejection: decoded.saved.original_rejection,
      review_id: review.review_id,
      new_dispatch: decoded.next,
      new_acknowledgement: acknowledged.ack,
      page_id: outcome.page_id,
      prefix_bindings: review.bindings,
      prefix_observations: review.observations,
      observation: outcome.observation,
      completion_reference: {
        file_id: file,
        path: review.path,
        review_id: review.review_id,
        review_record_hash: saved.row.hash,
        outcome_record_hash: rows[0]!.hash,
      },
    } satisfies VerifiedNativeFileSubstitution
  }).pipe(withReadOnlyNotion)
}

/** Historical verification uses complete immutable facts, never today's page or importer Store. */
export function loadCompletedSourceFileResubmissions(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  page: string,
  expectedRefs?: readonly SourceFileResubmissionCompletionReference[],
) {
  return Effect.gen(function* () {
    const rows = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      entityIds: [reviewsEntity, outcomesEntity],
    })
    const reviews = rows.filter((row) => row.entity_id === reviewsEntity),
      outcomes = rows.filter((row) => row.entity_id === outcomesEntity)
    if (reviews.length !== outcomes.length)
      return yield* Effect.fail(
        fail(
          "SOURCE_FILE_RESUBMISSION_PENDING",
          "An independent resubmission lacks complete immutable ACK proof; the original import remains unresolved.",
        ),
      )
    const result: VerifiedNativeFileSubstitution[] = []
    for (const row of reviews) {
      const record = yield* createChecked(() =>
        Schema.decodeUnknownSync(SourceFileResubmissionReviewRecordSchema)(row.payload, {
          onExcessProperty: "error",
        }),
      )
      if (
        record.original_operation_id !== plan.operation_id ||
        row.record_id !== reviewRecord(plan.operation_id, record.file_id) ||
        result.some((item) => item.file_id === record.file_id)
      )
        return yield* refusal(
          "A resubmission has a foreign, duplicate or aliased original file identity.",
        )
      const proof = yield* readCompletion(library, plan, page, record.file_id)
      if (!proof) return yield* refusal("The exact independent completion proof is missing.")
      result.push(proof)
    }
    result.sort((a, b) => a.file_id.localeCompare(b.file_id))
    if (
      expectedRefs !== undefined &&
      !same(
        result.map((item) => item.completion_reference),
        expectedRefs,
      )
    )
      return yield* refusal(
        "The parent completion must bind the entire independent resubmission proof set.",
      )
    return result
  }).pipe(withReadOnlyNotion)
}

export function reviewSharedSourceFileResubmission(
  input: OriginalInput & { readonly target: string; readonly path: string },
) {
  return Effect.gen(function* () {
    const { library, plan } = yield* context(input),
      page = pageId(input.target)
    if (!page) return yield* refusal("Select the exact original main page.")
    const current = yield* inspectRetainedImportFileResubmissionPrefix(
      library,
      plan,
      page,
      input.path,
    )
    const original_dispatch = yield* frozenPost(
      plan.operation_id,
      sharedCreateFileRequest(library, page, current.file),
    )
    const original_rejection = yield* originalRefusal(library, plan, original_dispatch)
    const markdown = property(original_dispatch.body).markdown
    if (typeof markdown !== "string")
      return yield* refusal("The original rejected request must contain complete Markdown.")
    const candidate = yield* createChecked(() => projectNativeImageBlocks(markdown))
    if (candidate.kind !== "changed")
      return yield* refusal("The original request has no eligible adjacent image-only paragraph.")
    const fields = {
      version: 1 as const,
      kind: "source_file_resubmission_review" as const,
      original_operation_id: plan.operation_id,
      permission_scope: current.journal.scope,
      library_id: library.library_id,
      skill_id: plan.skill_id,
      skill_page_id: page,
      source_id: current.original.resolved.selection!.source_id,
      file_id: current.file.file_id,
      path: current.file.path,
      plan_sha256: yield* hash(plan),
      manifest_sha256: yield* sharedCreateManifestRecordHash(plan),
      failure_sha256: current.original.row.hash,
      journal_sha256: yield* hash(current.journal.journal),
      retained_review_id: current.review.review_id,
      retained_review_hash: current.reviewRecord.hash,
      wire_policy: candidate.policy,
      changes: candidate.summary,
      original_request_sha256: yield* hash(original_dispatch),
      original_rejection_sha256: yield* hash(original_rejection),
      candidate_body_sha256: yield* sha256(candidate.markdown),
      bindings: current.bindings,
      allocations: current.proofs.map((proof) => proof.reference),
      observations: current.observations,
    }
    const saved: SourceFileResubmissionPlan = {
      version: 1,
      kind: "source_file_resubmission_plan",
      review: { ...fields, review_id: "source-file-resubmission-" + (yield* hash(fields)) },
      original_dispatch,
      original_rejection,
    }
    yield* validatePlan(plan, saved)
    const slot = yield* (yield* Store).readJson(
      yield* slotKey(plan, current.file.file_id),
      Schema.Unknown,
    )
    const prior = yield* savedReview(library, plan, page, current.file.file_id)
    if (
      (slot !== undefined && !same(slot, saved)) ||
      (prior !== undefined && !same(prior.decoded.saved, saved))
    )
      return yield* refusal(
        "An earlier independent request already owns this rejected file; preserve its review and request identity.",
      )
    return saved
  }).pipe(withReadOnlyNotion)
}

function completedResult(proof: VerifiedNativeFileSubstitution, page: string) {
  return {
    status: "completed" as const,
    review_id: proof.review_id,
    operation_id: proof.review_id,
    original_operation_id: proof.original_operation_id,
    skill_page_id: page,
    file_id: proof.file_id,
    path: proof.path,
    file_page_id: proof.page_id,
    verified: true as const,
    original_failure_preserved: true as const,
    original_creation_completed: false as const,
  }
}

export function applySharedSourceFileResubmission(input: ApplyInput) {
  return Effect.gen(function* () {
    const { library, plan } = yield* context(input)
    const action = Effect.gen(function* () {
      const decoded = yield* validatePlan(plan, input.review, input.reviewId),
        review = decoded.review
      const completed = yield* readCompletion(library, plan, review.skill_page_id, review.file_id)
      if (completed) {
        if (completed.review_id !== review.review_id)
          return yield* refusal("This file completed under a different original review.")
        return { ...completedResult(completed, review.skill_page_id), remote_writes: 0 as const }
      }
      if (review.permission_scope !== (yield* authScope))
        return yield* refusal(
          "Use the original credential-scoped author runtime for an incomplete resubmission.",
        )
      const store = yield* Store,
        key = yield* slotKey(plan, review.file_id)
      const slot = yield* store.readJson(key, Schema.Unknown)
      if (slot !== undefined && !same(slot, decoded.saved))
        return yield* refusal(
          "Another independent review already owns this original rejected file.",
        )
      const previous = yield* localNewAck(library, decoded.next)
      const before = (allocatedPage?: string) =>
        Effect.gen(function* () {
          const current = yield* inspectRetainedImportFileResubmissionPrefix(
            library,
            plan,
            review.skill_page_id,
            review.path,
            allocatedPage,
          )
          const negative = yield* originalRefusal(library, plan, decoded.saved.original_dispatch)
          if (
            current.original.row.hash !== review.failure_sha256 ||
            current.reviewRecord.hash !== review.retained_review_hash ||
            (yield* hash(current.journal.journal)) !== review.journal_sha256 ||
            !same(negative, decoded.saved.original_rejection) ||
            !same(current.bindings, review.bindings) ||
            !same(
              current.proofs.map((proof) => proof.reference),
              review.allocations,
            ) ||
            !same(current.observations, review.observations)
          )
            return yield* refusal(
              "The original rejection, current complete allocation prefix or source ownership changed after review.",
            )
          if (allocatedPage !== undefined && current.allocatedFile !== undefined)
            yield* createChecked(() =>
              assertImportedMarkdownContent(
                decoded.candidate,
                current.allocatedFile!.projection.markdown,
              ),
            )
          return current
        }).pipe(withReadOnlyNotion)
      const priorReview = yield* savedReview(library, plan, review.skill_page_id, review.file_id)
      if (
        (priorReview !== undefined && !same(priorReview.decoded.saved, decoded.saved)) ||
        (previous !== undefined && priorReview === undefined)
      )
        return yield* refusal(
          "The independent request must retain its full original review before any native allocation.",
        )
      if (input.dryRun) {
        yield* before(previous?.page)
        return {
          status: "reviewed" as const,
          review_id: review.review_id,
          operation_id: review.review_id,
          original_operation_id: plan.operation_id,
          skill_page_id: review.skill_page_id,
          file_id: review.file_id,
          path: review.path,
          verified: false as const,
          remote_writes: 0 as const,
          original_failure_preserved: true as const,
          original_creation_completed: false as const,
          native_pages_created: 0 as const,
          native_pages_to_create: previous === undefined ? 1 : 0,
          acknowledged_page_reused: previous !== undefined,
        }
      }
      if (slot === undefined) yield* store.writeJson(key, decoded.saved)
      const acknowledged =
        previous ??
        (yield* Effect.gen(function* () {
          const current = yield* before()
          // One immutable review-publication stage shares its already checked intent.
          // The native allocation has a separate fresh guard below.
          const dispatch = yield* sharedCreateDispatch(library, {
            operation_id: review.review_id,
            skill_id: plan.skill_id,
          })
          yield* Effect.gen(function* () {
            const serialized = canonicalSharedJson(decoded.saved)
            yield* retainSharedCreateText(
              library,
              review.skill_page_id,
              serialized,
              "input",
              "create",
            )
            yield* retainSharedNativeAllocationProofs(library, review.skill_page_id, current.proofs)
            for (const observation of review.observations) {
              const file = current.facts.files.find((item) => item.file_id === observation.file_id)!
              yield* retainSharedCreateText(
                library,
                review.skill_page_id,
                file.projection.markdown,
                "body",
                "create",
              )
            }
            yield* appendSharedRecord(library, {
              mode: "create",
              kind: "operation",
              skillPageId: review.skill_page_id,
              entityId: reviewsEntity,
              recordId: reviewRecord(plan.operation_id, review.file_id),
              operationId: review.review_id,
              payload: {
                version: 1,
                kind: "source_file_resubmission_review_record",
                review_id: review.review_id,
                original_operation_id: plan.operation_id,
                file_id: review.file_id,
                path: review.path,
                plan: yield* textRef(serialized),
              },
            })
          }).pipe(Effect.provideService(Notion, dispatch.api))
          const retained = yield* savedReview(library, plan, review.skill_page_id, review.file_id)
          if (!retained || !same(retained.decoded.saved, decoded.saved))
            return yield* refusal(
              "The complete independent review is not durably visible before the native POST.",
            )
          const native = yield* sharedCreateDispatch(
            library,
            { operation_id: review.review_id, skill_id: plan.skill_id },
            before().pipe(Effect.asVoid),
          )
          yield* native.api.request("v1/pages", decoded.next.body, { method: "POST" })
          const ack = yield* localNewAck(library, decoded.next)
          if (!ack)
            return yield* refusal("The independent native POST has no durable acknowledgement.")
          return ack
        }))
      const current = yield* before(acknowledged.page)
      const observed = current.allocatedFile
      if (!observed)
        return yield* refusal(
          "The independently acknowledged file lacks a complete native readback.",
        )
      const completion = {
        version: 1 as const,
        kind: "source_file_resubmission_completion" as const,
        review_id: review.review_id,
        original_operation_id: plan.operation_id,
        skill_page_id: review.skill_page_id,
        file_id: review.file_id,
        path: review.path,
        page_id: acknowledged.page,
        new_dispatch: decoded.next,
        new_acknowledgement: acknowledged.ack,
        observation: {
          file_id: review.file_id,
          page_id: acknowledged.page,
          body_sha256: observed.content.sha256,
          body_bytes: observed.content.bytes,
          event_id: observed.event.event_id,
        },
      }
      const commit = yield* sharedCreateDispatch(library, {
        operation_id: review.review_id,
        skill_id: plan.skill_id,
      })
      yield* Effect.gen(function* () {
        yield* retainSharedCreateText(
          library,
          review.skill_page_id,
          observed.projection.markdown,
          "body",
          "create",
        )
        const serialized = canonicalSharedJson(completion)
        yield* retainSharedCreateText(library, review.skill_page_id, serialized, "input", "create")
        const final = yield* before(acknowledged.page)
        if (
          final.allocatedFile?.content.sha256 !== observed.content.sha256 ||
          final.allocatedFile.content.bytes !== observed.content.bytes ||
          final.allocatedFile.event.event_id !== observed.event.event_id
        )
          return yield* refusal(
            "The complete acknowledged native body changed during proof publication.",
          )
        yield* appendSharedRecord(library, {
          mode: "create",
          kind: "operation",
          skillPageId: review.skill_page_id,
          entityId: outcomesEntity,
          recordId: outcomeRecord(plan.operation_id, review.file_id),
          operationId: review.review_id,
          payload: {
            version: 1,
            kind: "source_file_resubmission_completion_record",
            review_id: review.review_id,
            original_operation_id: plan.operation_id,
            file_id: review.file_id,
            path: review.path,
            proof: yield* textRef(serialized),
          },
        })
      }).pipe(Effect.provideService(Notion, commit.api))
      const done = yield* readCompletion(library, plan, review.skill_page_id, review.file_id)
      if (!done)
        return yield* refusal("The full independent file completion is not durably visible.")
      return { ...completedResult(done, review.skill_page_id), remote_writes: undefined }
    }).pipe(Effect.mapError((error) => sourceRecoveryError(error, plan)))
    return yield* input.dryRun
      ? action.pipe(withReadOnlyNotion)
      : withSourceUpdateLock(library, action)
  })
}

export function reconcileSharedSourceFileResubmission(input: ApplyInput) {
  return Effect.gen(function* () {
    const { library, plan } = yield* context(input)
    const decoded = yield* validatePlan(plan, input.review, input.reviewId),
      review = decoded.review
    const proof = yield* readCompletion(library, plan, review.skill_page_id, review.file_id)
    if (proof) {
      if (proof.review_id !== review.review_id)
        return yield* refusal("The completion belongs to a different independent review.")
      return { ...completedResult(proof, review.skill_page_id), remote_writes: 0 as const }
    }
    if (review.permission_scope !== (yield* authScope))
      return yield* refusal(
        "Inspect an unresolved independent request in its original author scope.",
      )
    const acknowledged = yield* localNewAck(library, decoded.next)
    if (!acknowledged)
      return yield* refusal(
        "The independent request has no complete original native ACK; it remains unresolved.",
      )
    const saved = yield* savedReview(library, plan, review.skill_page_id, review.file_id)
    if (!saved || !same(saved.decoded.saved, decoded.saved))
      return yield* refusal("The original independent review is unavailable.")
    yield* inspectRetainedImportFileResubmissionPrefix(
      library,
      plan,
      review.skill_page_id,
      review.path,
      acknowledged.page,
    )
    return {
      status: "completion_pending" as const,
      review_id: review.review_id,
      operation_id: review.review_id,
      original_operation_id: plan.operation_id,
      skill_page_id: review.skill_page_id,
      file_id: review.file_id,
      path: review.path,
      file_page_id: acknowledged.page,
      verified: false as const,
      remote_writes: 0 as const,
      original_failure_preserved: true as const,
      original_creation_completed: false as const,
    }
  }).pipe(withReadOnlyNotion)
}

export function sourceFileResubmissionOriginal(
  header: SharedOperationHeader,
  operations: readonly SharedOperationHeader[],
) {
  if (header.entity_id !== reviewsEntity && header.entity_id !== outcomesEntity) return undefined
  const match =
    /^source-file-resubmission-(?:review|outcome)-(skill-create-[a-f0-9]{64})-file-[a-f0-9]{64}$/u.exec(
      header.record_id,
    )
  return match &&
    operations.some(
      (row) => row.entity_id === sharedCreateManifestEntity && row.record_id === match[1],
    )
    ? match[1]
    : undefined
}
