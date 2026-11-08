import { Effect, Schema } from "effect"
import { fail, property } from "./model.ts"
import { pageId } from "./ref.ts"
import {
  sharedCreateContinuationReviewEntity,
  sharedCreateContinuationReviewId,
  sharedCreateRecoveryTerminalsEntity,
  sharedCreateRecoveryTerminalId,
  validateSharedCreateContinuationReview,
  validateSharedCreateRecoveryTerminal,
} from "./shared-create-continuation-model.ts"
import {
  createChecked,
  SharedCreateManifestSchema,
  sharedCreateManifestEntity,
} from "./shared-create-model.ts"
import type { SharedCreateOutcome } from "./shared-create-outcome.ts"
import { readSharedCreateKnownCompletion } from "./shared-create-recovery-known-completion.ts"
import {
  validateSharedCreateRecoveryReview,
  type SharedCreateRecoveryReview,
} from "./shared-create-recovery-model.ts"
import type { FileEvent } from "./shared-file-state.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import type { SharedOperationHeader } from "./shared-operation-index.ts"
import { canonicalSharedJson, querySharedRecords } from "./shared-records.ts"
import { sha256 } from "./store.ts"

export const sharedCreateRecoveryReviewEntity = "skill-create-recovery-reviews-v1"
export const sharedCreateRecoveryOutcomesEntity = "skill-create-recovery-outcomes-v1"
export const sharedCreateRecoveryReviewId = (original: string) => `recovery-${original}`
export const sharedCreateRecoveryOutcomeId = (original: string) => `recovered-${original}`
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const OriginalId = Schema.String.check(Schema.isPattern(/^skill-create-[a-f0-9]{64}$/u))
const RecoveryId = Schema.String.check(Schema.isPattern(/^create-recovery-[a-f0-9]{64}$/u))
const ContinuationId = Schema.String.check(Schema.isPattern(/^create-continuation-[a-f0-9]{64}$/u))
const OutcomeFields = {
  kind: Schema.Literal("skill_create_recovery_outcome"),
  status: Schema.Literal("applied"),
  original_operation_id: OriginalId,
  original_manifest_sha256: Hash,
  original_outcome_sha256: Hash,
  recovery_id: RecoveryId,
  skill_id: Schema.String,
  skill_page_id: Schema.String,
  review_record_hash: Hash,
  bindings: Schema.Array(
    Schema.Struct({
      file_id: Schema.String,
      path: Schema.String,
      page_id: Schema.String,
      event_id: Schema.String,
    }),
  ),
}
export const SharedCreateRecoveryOutcomeV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  ...OutcomeFields,
})
export const SharedCreateRecoveryOutcomeV2Schema = Schema.Struct({
  version: Schema.Literal(2),
  ...OutcomeFields,
  continuation_id: ContinuationId,
  continuation_review_record_hash: Hash,
})
export const SharedCreateRecoveryOutcomeSchema = Schema.Union([
  SharedCreateRecoveryOutcomeV1Schema,
  SharedCreateRecoveryOutcomeV2Schema,
])
export type SharedCreateRecoveryOutcome = typeof SharedCreateRecoveryOutcomeSchema.Type
export type SharedCreateRecoveryOutcomeV2 = typeof SharedCreateRecoveryOutcomeV2Schema.Type
const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const invalid = (message: string) => fail("SHARED_CREATE_RECOVERY_INVALID", message)
const recoveryReceiptsEntity = "skill-create-recovery-receipts-v1"
type HeaderOptions = { readonly headers?: readonly SharedOperationHeader[] }

function exactHeader(headers: readonly SharedOperationHeader[], recordId: string) {
  const matches = headers.filter((header) => header.record_id === recordId)
  if (matches.length > 1) throw invalid("A recovery operation has more than one shared header.")
  return matches[0]
}

function readOperationRecord(
  library: SharedLibrary,
  input: HeaderOptions & {
    readonly skillPageId: string
    readonly recordId: string
    readonly entityId: string
    readonly operationId?: string
    readonly hash?: string
    readonly containsBody?: boolean
  },
) {
  return Effect.gen(function* () {
    const header = yield* createChecked(() => {
      if (input.headers === undefined) return undefined
      const selected = exactHeader(input.headers, input.recordId)
      if (
        !selected ||
        selected.entity_id !== input.entityId ||
        (input.hash !== undefined && selected.hash !== input.hash)
      )
        throw invalid("A recovery record lacks its exact expected shared header.")
      return selected
    })
    const rows = yield* querySharedRecords(library, {
      skillPageId: input.skillPageId,
      kind: "operation",
      recordId: input.recordId,
      ...(input.containsBody ? { payloadContainsBody: true as const } : {}),
    })
    const row = rows[0]
    if (
      rows.length !== 1 ||
      !row ||
      row.kind !== "operation" ||
      row.record_id !== input.recordId ||
      row.skill_page_id !== input.skillPageId ||
      row.entity_id !== input.entityId ||
      (input.operationId !== undefined && row.operation_id !== input.operationId) ||
      (input.hash !== undefined && row.hash !== input.hash) ||
      (header !== undefined && row.hash !== header.hash)
    )
      return yield* Effect.fail(
        invalid("A recovery record differs from its exact shared identity or header."),
      )
    return row
  })
}

/** A failed or continued recovery cannot be relabelled as an ordinary v1 success. */
export function assertSharedCreateRecoveryNotContinued(
  library: SharedLibrary,
  review: SharedCreateRecoveryReview,
  options: HeaderOptions = {},
) {
  return Effect.gen(function* () {
    const recordIds = [
      sharedCreateContinuationReviewId(review.original_operation_id),
      sharedCreateRecoveryTerminalId(review.review_id),
    ]
    for (const recordId of recordIds) {
      if (options.headers !== undefined) {
        if (options.headers.some((header) => header.record_id === recordId))
          return yield* Effect.fail(
            invalid(
              "A v1 recovery completion cannot replace a terminal failure or continuation decision.",
            ),
          )
        continue
      }
      const rows = yield* querySharedRecords(library, {
        skillPageId: review.skill_page_id,
        kind: "operation",
        recordId,
      })
      if (rows.length !== 0)
        return yield* Effect.fail(
          invalid(
            "A v1 recovery completion cannot replace a terminal failure or continuation decision.",
          ),
        )
    }
  })
}

/** Prove the accepted continuation from compact shared records, without source archives or current reads. */
export function validateSharedCreateContinuationCompletion(
  library: SharedLibrary,
  completion: SharedCreateRecoveryOutcomeV2,
  review: SharedCreateRecoveryReview,
  options: HeaderOptions = {},
) {
  return Effect.gen(function* () {
    yield* createChecked(() => {
      if (
        completion.recovery_id !== review.review_id ||
        completion.original_operation_id !== review.original_operation_id ||
        completion.original_manifest_sha256 !== review.original_manifest_sha256 ||
        completion.original_outcome_sha256 !== review.original_outcome_sha256 ||
        completion.skill_id !== review.skill_id ||
        completion.skill_page_id !== review.skill_page_id ||
        review.library_id !== library.library_id ||
        !same(review.library, library)
      )
        throw invalid(
          "The continuation completion differs from its exact original recovery review.",
        )
    })
    const stoppedId = sharedCreateRecoveryTerminalId(completion.continuation_id)
    const stopped =
      options.headers !== undefined
        ? options.headers.some((header) => header.record_id === stoppedId)
        : (yield* querySharedRecords(library, {
            skillPageId: review.skill_page_id,
            kind: "operation",
            recordId: stoppedId,
          })).length !== 0
    if (stopped)
      return yield* Effect.fail(
        invalid("A stopped continuation cannot be replaced by a successful completion."),
      )
    const terminalRow = yield* readOperationRecord(library, {
      ...options,
      skillPageId: review.skill_page_id,
      recordId: sharedCreateRecoveryTerminalId(review.review_id),
      entityId: sharedCreateRecoveryTerminalsEntity,
      operationId: review.review_id,
    })
    const terminal = yield* validateSharedCreateRecoveryTerminal(
      terminalRow.payload,
      review,
      completion.review_record_hash,
    )
    const continuationRow = yield* readOperationRecord(library, {
      ...options,
      skillPageId: review.skill_page_id,
      recordId: sharedCreateContinuationReviewId(review.original_operation_id),
      entityId: sharedCreateContinuationReviewEntity,
      operationId: completion.continuation_id,
      hash: completion.continuation_review_record_hash,
      containsBody: true,
    })
    const continuation = yield* validateSharedCreateContinuationReview(
      continuationRow.payload,
      review,
      completion.review_record_hash,
      terminal,
      terminalRow.hash,
      completion.continuation_id,
    )
    yield* createChecked(() => {
      const bindings = new Map(completion.bindings.map((binding) => [binding.file_id, binding]))
      if (
        bindings.size !== review.files.length ||
        completion.bindings.length !== review.files.length ||
        new Set(completion.bindings.map((binding) => binding.page_id)).size !== bindings.size ||
        completion.bindings.some((binding) => pageId(binding.page_id) !== binding.page_id) ||
        review.files.some((file) => {
          const binding = bindings.get(file.file_id)
          return !binding || binding.path !== file.path || binding.event_id !== file.event.event_id
        }) ||
        continuation.bindings.some((binding) => !same(binding, bindings.get(binding.file_id)))
      )
        throw invalid(
          "Completion changed accepted continuation pages or the complete recovery file events.",
        )
    })
    for (const receipt of continuation.successful_response_records) {
      const recordId = `create-recovery-receipt-${yield* sha256(
        canonicalSharedJson([review.review_id, `create:${receipt.file_id}`]),
      )}`
      if (receipt.record_id !== recordId)
        return yield* Effect.fail(
          invalid("A successful create response names another original file dispatch."),
        )
      const row = yield* readOperationRecord(library, {
        ...options,
        skillPageId: review.skill_page_id,
        recordId,
        entityId: recoveryReceiptsEntity,
        operationId: review.review_id,
        hash: receipt.hash,
        containsBody: true,
      })
      yield* createChecked(() => {
        const payload = property(row.payload),
          request = property(payload.request),
          response = property(payload.response)
        if (
          payload.version !== 1 ||
          payload.kind !== "skill_create_recovery_response" ||
          payload.recovery_id !== review.review_id ||
          payload.original_operation_id !== review.original_operation_id ||
          payload.action !== "create_file_response" ||
          request.method !== "POST" ||
          request.path !== "v1/pages" ||
          response.object !== "page" ||
          response.id !== receipt.page_id ||
          response.in_trash === true ||
          response.archived === true
        )
          throw invalid(
            "A retained successful response does not prove its accepted original create page.",
          )
      })
    }
    return continuation
  })
}

/** Validate the compact completion and original manifest, without loading source archives.
 * Later edits may add descendants; the original recovery events must remain exact. */
export function completedSharedCreateRecovery(
  library: SharedLibrary,
  input: {
    readonly skillPageId: string
    readonly originalManifestHeader: SharedOperationHeader
    readonly originalOutcome: SharedCreateOutcome
    readonly originalOutcomeHash: string
    readonly events: readonly FileEvent[]
    readonly headers: readonly SharedOperationHeader[]
  },
) {
  return Effect.gen(function* () {
    const original = input.originalOutcome
    const completionId = sharedCreateRecoveryOutcomeId(original.operation_id)
    const completionHeader = yield* createChecked(() => exactHeader(input.headers, completionId))
    if (completionHeader === undefined) return false
    if (completionHeader.entity_id !== sharedCreateRecoveryOutcomesEntity)
      return yield* Effect.fail(invalid("The recovery completion uses another record entity."))
    const read = (header: SharedOperationHeader, containsBody = false) =>
      readOperationRecord(library, {
        skillPageId: input.skillPageId,
        recordId: header.record_id,
        entityId: header.entity_id,
        hash: header.hash,
        headers: input.headers,
        containsBody,
      })
    const completionRow = yield* read(completionHeader)
    if (property(completionRow.payload).version === 4) {
      const recovered = yield* readSharedCreateKnownCompletion(library, input)
      if (
        !recovered ||
        recovered.review.bootstrap.kind !== "known_needs_review" ||
        recovered.outcome.original_outcome_sha256 !== input.originalOutcomeHash ||
        original.version !== 1 ||
        original.status !== "needs_review" ||
        original.reason_code !== "SHARED_CREATE_BODY_MISMATCH" ||
        original.operation_id !== recovered.review.original_operation_id ||
        original.skill_id !== recovered.review.skill_id ||
        original.skill_page_id !== recovered.review.skill_page_id ||
        !same(original.bindings, recovered.review.bindings)
      )
        return yield* Effect.fail(invalid("The recovery differs from the selected known failure."))
      return true
    }
    const completion = yield* createChecked(() =>
      Schema.decodeUnknownSync(SharedCreateRecoveryOutcomeSchema)(completionRow.payload, {
        onExcessProperty: "error",
      }),
    )
    const reviewHeader = yield* createChecked(() =>
      exactHeader(input.headers, sharedCreateRecoveryReviewId(original.operation_id)),
    )
    if (
      !reviewHeader ||
      reviewHeader.entity_id !== sharedCreateRecoveryReviewEntity ||
      reviewHeader.hash !== completion.review_record_hash
    )
      return yield* Effect.fail(
        invalid("The completion lacks its exact immutable recovery review."),
      )
    const reviewRow = yield* read(reviewHeader, true)
    const review = yield* validateSharedCreateRecoveryReview(
      reviewRow.payload,
      completion.recovery_id,
    )
    const manifestRow = yield* read(input.originalManifestHeader)
    const manifest = yield* createChecked(() =>
      Schema.decodeUnknownSync(SharedCreateManifestSchema)(manifestRow.payload, {
        onExcessProperty: "error",
      }),
    )
    yield* createChecked(() => {
      if (
        original.version !== 2 ||
        original.status !== "needs_review" ||
        original.reason_code !== "SHARED_CREATE_BODY_MISMATCH" ||
        manifest.version !== 2 ||
        manifest.operation_id !== original.operation_id ||
        input.originalManifestHeader.record_id !== original.operation_id ||
        input.originalManifestHeader.entity_id !== sharedCreateManifestEntity ||
        manifestRow.operation_id !== original.operation_id ||
        original.manifest_record_hash !== input.originalManifestHeader.hash ||
        completion.original_operation_id !== original.operation_id ||
        review.original_operation_id !== original.operation_id ||
        completion.original_manifest_sha256 !== input.originalManifestHeader.hash ||
        review.original_manifest_sha256 !== input.originalManifestHeader.hash ||
        completion.original_outcome_sha256 !== input.originalOutcomeHash ||
        review.original_outcome_sha256 !== input.originalOutcomeHash ||
        completionRow.operation_id !==
          (completion.version === 2 ? completion.continuation_id : completion.recovery_id) ||
        reviewRow.operation_id !== completion.recovery_id ||
        completion.recovery_id !== review.review_id ||
        completion.skill_page_id !== input.skillPageId ||
        original.skill_page_id !== input.skillPageId ||
        review.skill_page_id !== input.skillPageId ||
        completion.skill_id !== original.skill_id ||
        manifest.skill_id !== original.skill_id ||
        review.skill_id !== original.skill_id ||
        review.library_id !== library.library_id ||
        !same(review.library, library) ||
        !same(manifest.library, library) ||
        !same(review.bindings, original.bindings)
      )
        throw invalid(
          "The recovery does not bind the exact original library, manifest, failure and page identities.",
        )
      const files = new Map(review.files.map((file) => [file.file_id, file]))
      const bindings = new Map(completion.bindings.map((binding) => [binding.file_id, binding]))
      if (
        manifest.files.length === 0 ||
        files.size !== manifest.files.length ||
        review.files.length !== files.size ||
        bindings.size !== files.size ||
        completion.bindings.length !== files.size ||
        new Set(manifest.files.map((file) => file.file_id)).size !== files.size ||
        new Set(completion.bindings.map((binding) => binding.page_id)).size !== files.size ||
        new Set(completion.bindings.map((binding) => binding.path)).size !== files.size ||
        completion.bindings.some((binding) => pageId(binding.page_id) !== binding.page_id)
      )
        throw invalid("The recovery completion must cover every original file exactly once.")
      const ordered = [
        ...manifest.files.filter((file) => file.path === manifest.entrypoint),
        ...manifest.files.filter((file) => file.path !== manifest.entrypoint),
      ]
      if (
        original.bindings.length === 0 ||
        original.bindings.length > ordered.length ||
        original.bindings[0]?.page_id !== input.skillPageId
      )
        throw invalid("The original failure has no exact retained main-page binding.")
      for (const [index, binding] of original.bindings.entries()) {
        const file = ordered[index],
          completed = bindings.get(binding.file_id)
        if (
          !file ||
          file.file_id !== binding.file_id ||
          file.path !== binding.path ||
          file.event.event_id !== binding.event_id ||
          !completed ||
          completed.page_id !== binding.page_id ||
          completed.path !== binding.path
        )
          throw invalid("Recovery changed an already-created page or the original creation prefix.")
      }
      for (const originalFile of manifest.files) {
        const file = files.get(originalFile.file_id),
          binding = bindings.get(originalFile.file_id)
        if (
          !file ||
          !binding ||
          file.path !== originalFile.path ||
          binding.path !== originalFile.path ||
          file.input_sha256 !== originalFile.input.sha256 ||
          originalFile.projection.version !== 4 ||
          file.projection.version !== 5 ||
          file.projection.purpose !== "data_source_create" ||
          originalFile.projection.purpose !== "data_source_create" ||
          originalFile.projection.removed_terminal_lfs !== file.projection.removed_terminal_lfs ||
          file.event.kind !== originalFile.event.kind ||
          (file.event.kind === "projected" &&
            (originalFile.event.kind !== "projected" ||
              file.event.source_revision !== originalFile.event.source_revision)) ||
          binding.event_id !== file.event.event_id
        )
          throw invalid(
            "Recovery changed the complete retained file mapping, source ownership or fixed projection transition.",
          )
        const events = input.events.filter((event) => event.event_id === binding.event_id)
        if (events.length !== 1 || !same(events[0], file.event))
          throw invalid("A recovery completion lacks its exact published initial event.")
      }
    })
    if (completion.version === 2)
      yield* validateSharedCreateContinuationCompletion(library, completion, review, {
        headers: input.headers,
      })
    else
      yield* assertSharedCreateRecoveryNotContinued(library, review, {
        headers: input.headers,
      })
    return true
  })
}
