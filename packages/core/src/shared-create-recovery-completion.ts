import { Effect, Schema } from "effect"
import { fail } from "./model.ts"
import { pageId } from "./ref.ts"
import {
  createChecked,
  SharedCreateManifestSchema,
  sharedCreateManifestEntity,
} from "./shared-create-model.ts"
import type { SharedCreateOutcome } from "./shared-create-outcome.ts"
import { validateSharedCreateRecoveryReview } from "./shared-create-recovery-model.ts"
import type { FileEvent } from "./shared-file-state.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import type { SharedOperationHeader } from "./shared-operation-index.ts"
import { canonicalSharedJson, querySharedRecords } from "./shared-records.ts"

export const sharedCreateRecoveryReviewEntity = "skill-create-recovery-reviews-v1"
export const sharedCreateRecoveryOutcomesEntity = "skill-create-recovery-outcomes-v1"
export const sharedCreateRecoveryReviewId = (original: string) => `recovery-${original}`
export const sharedCreateRecoveryOutcomeId = (original: string) => `recovered-${original}`
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const OriginalId = Schema.String.check(Schema.isPattern(/^skill-create-[a-f0-9]{64}$/u))
const RecoveryId = Schema.String.check(Schema.isPattern(/^create-recovery-[a-f0-9]{64}$/u))
export const SharedCreateRecoveryOutcomeSchema = Schema.Struct({
  version: Schema.Literal(1),
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
})
export type SharedCreateRecoveryOutcome = typeof SharedCreateRecoveryOutcomeSchema.Type
const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const invalid = (message: string) => fail("SHARED_CREATE_RECOVERY_INVALID", message)

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
    const completionHeader = input.headers.find((header) => header.record_id === completionId)
    if (completionHeader === undefined) return false
    if (completionHeader.entity_id !== sharedCreateRecoveryOutcomesEntity)
      return yield* Effect.fail(invalid("The recovery completion uses another record entity."))
    const read = (header: SharedOperationHeader, containsBody = false) =>
      Effect.gen(function* () {
        const rows = yield* querySharedRecords(library, {
          skillPageId: input.skillPageId,
          kind: "operation",
          recordId: header.record_id,
          ...(containsBody ? { payloadContainsBody: true as const } : {}),
        })
        const row = rows[0]
        if (
          rows.length !== 1 ||
          !row ||
          row.hash !== header.hash ||
          row.entity_id !== header.entity_id
        )
          return yield* Effect.fail(
            invalid("A recovery record differs from its exact shared header."),
          )
        return row
      })
    const completionRow = yield* read(completionHeader)
    const completion = yield* createChecked(() =>
      Schema.decodeUnknownSync(SharedCreateRecoveryOutcomeSchema)(completionRow.payload, {
        onExcessProperty: "error",
      }),
    )
    const reviewHeader = input.headers.find(
      (header) => header.record_id === sharedCreateRecoveryReviewId(original.operation_id),
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
        completionRow.operation_id !== completion.recovery_id ||
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
    return true
  })
}
