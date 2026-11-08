import { Effect, Schema } from "effect"
import { fail, property } from "./model.ts"
import { pageId } from "./ref.ts"
import {
  sharedCreateContinuationReviewId,
  sharedCreateRecoveryTerminalId,
} from "./shared-create-continuation-model.ts"
import {
  createChecked,
  SharedCreateManifestSchema,
  sharedCreateManifestEntity,
  sharedCreateOutcomesEntity,
} from "./shared-create-model.ts"
import { decodeSharedCreateOutcome, sharedCreateOutcomeId } from "./shared-create-outcome.ts"
import {
  sharedCreateRecoveryOutcomeId,
  sharedCreateRecoveryOutcomesEntity,
  sharedCreateRecoveryReviewId,
  sharedCreateRecoveryReviewEntity,
} from "./shared-create-recovery-completion.ts"
import {
  SharedCreateKnownRecoveryOutcomeSchema,
  validateSharedCreateKnownRecoveryReview,
} from "./shared-create-recovery-known-model.ts"
import { nativeFileMetadata, type FileEvent } from "./shared-file-state.ts"
import { preservesSharedLibraryBindings, type SharedLibrary } from "./shared-library-model.ts"
import { querySharedOperationIndex, type SharedOperationHeader } from "./shared-operation-index.ts"
import { canonicalSharedJson, querySharedRecords } from "./shared-records.ts"
import { sha256 } from "./store.ts"

const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const invalid = (message: string) => fail("SHARED_CREATE_RECOVERY_INVALID", message)

/** Read the immutable completion of a v9 admission without a local journal,
 * source fetch, current-body observation or adoption of later edits. */
export function readSharedCreateKnownCompletion(
  library: SharedLibrary,
  input: {
    readonly skillPageId: string
    readonly originalManifestHeader: SharedOperationHeader
    readonly events: readonly FileEvent[]
    readonly headers?: readonly SharedOperationHeader[]
  },
) {
  return Effect.gen(function* () {
    const headers = input.headers ?? (yield* querySharedOperationIndex(library, input.skillPageId))
    const original = input.originalManifestHeader.record_id
    const exact = (recordId: string) => {
      const found = headers.filter((header) => header.record_id === recordId)
      if (found.length > 1) throw invalid("A recovery fact has duplicate headers.")
      return found[0]
    }
    const completionHeader = yield* createChecked(() =>
      exact(sharedCreateRecoveryOutcomeId(original)),
    )
    if (completionHeader === undefined) return undefined
    const read = (recordId: string, entityId: string, containsBody = false) =>
      Effect.gen(function* () {
        const header = yield* createChecked(() => exact(recordId))
        if (!header || header.entity_id !== entityId)
          return yield* Effect.fail(invalid("A recovery fact lacks its exact immutable header."))
        const rows = yield* querySharedRecords(library, {
          skillPageId: input.skillPageId,
          kind: "operation",
          recordId,
          entityId,
          ...(containsBody ? { payloadContainsBody: true as const } : {}),
        })
        const row = rows[0]
        if (
          rows.length !== 1 ||
          !row ||
          row.kind !== "operation" ||
          row.record_id !== recordId ||
          row.entity_id !== entityId ||
          row.hash !== header.hash ||
          row.skill_page_id !== input.skillPageId
        )
          return yield* Effect.fail(
            invalid("A recovery fact differs from its exact shared identity, header or owner."),
          )
        return row
      })
    const completed = yield* read(
      sharedCreateRecoveryOutcomeId(original),
      sharedCreateRecoveryOutcomesEntity,
    )
    // Earlier immutable recovery versions retain their own completion checks.
    if (property(completed.payload).version !== 4) return undefined
    const outcome = yield* createChecked(() =>
      Schema.decodeUnknownSync(SharedCreateKnownRecoveryOutcomeSchema)(completed.payload, {
        onExcessProperty: "error",
      }),
    )
    const retained = yield* read(
      sharedCreateRecoveryReviewId(original),
      sharedCreateRecoveryReviewEntity,
      true,
    )
    const review = yield* validateSharedCreateKnownRecoveryReview(
      retained.payload,
      outcome.recovery_id,
    )
    const originalRow = yield* read(original, sharedCreateManifestEntity, true)
    const manifest = yield* createChecked(() =>
      Schema.decodeUnknownSync(SharedCreateManifestSchema)(originalRow.payload, {
        onExcessProperty: "error",
      }),
    )
    const expected = {
      version: 4,
      kind: "skill_create_recovery_outcome",
      status: "applied",
      original_operation_id: original,
      original_manifest_sha256: input.originalManifestHeader.hash,
      original_plan_sha256: review.original_plan_sha256,
      original_outcome_sha256: review.original_outcome_sha256,
      bootstrap_sha256: yield* sha256(canonicalSharedJson(review.bootstrap)),
      recovery_id: review.review_id,
      skill_id: review.skill_id,
      skill_page_id: input.skillPageId,
      review_record_hash: retained.hash,
      bindings: outcome.bindings,
    }
    if (
      !same(outcome, expected) ||
      completed.operation_id !== review.review_id ||
      retained.operation_id !== review.review_id ||
      originalRow.operation_id !== original ||
      originalRow.hash !== input.originalManifestHeader.hash ||
      input.originalManifestHeader.entity_id !== sharedCreateManifestEntity ||
      review.original_manifest_sha256 !== input.originalManifestHeader.hash ||
      review.original_operation_id !== original ||
      review.skill_page_id !== input.skillPageId ||
      !preservesSharedLibraryBindings(review.library, library) ||
      !preservesSharedLibraryBindings(manifest.library, library) ||
      manifest.version !== 1 ||
      manifest.source_projection?.version !== 1 ||
      manifest.source_projection.local !== undefined ||
      manifest.content_kind !== "skill" ||
      manifest.complete_resources !== undefined ||
      (manifest.resources?.length ?? 0) !== 0 ||
      manifest.members.length !== 0 ||
      (manifest.requires?.length ?? 0) !== 0 ||
      manifest.operation_id !== original ||
      manifest.skill_id !== review.skill_id ||
      manifest.files.length === 0 ||
      manifest.files.length !== review.files.length ||
      new Set(manifest.files.map((file) => file.file_id)).size !== manifest.files.length ||
      new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length ||
      outcome.bindings.length !== manifest.files.length ||
      new Set(outcome.bindings.map((binding) => binding.file_id)).size !== manifest.files.length ||
      new Set(outcome.bindings.map((binding) => binding.path)).size !== manifest.files.length ||
      new Set(outcome.bindings.map((binding) => binding.page_id)).size !== manifest.files.length ||
      outcome.bindings.some((binding) => pageId(binding.page_id) !== binding.page_id) ||
      headers.some(
        (header) =>
          header.record_id === sharedCreateContinuationReviewId(original) ||
          header.record_id === sharedCreateRecoveryTerminalId(review.review_id),
      )
    )
      return yield* Effect.fail(
        invalid("The completion differs from its exact fixed Git admission and recovery decision."),
      )
    const originalOutcomeHeader = yield* createChecked(() => exact(sharedCreateOutcomeId(original)))
    if (review.bootstrap.kind === "acknowledged_main_before_manifest") {
      if (originalOutcomeHeader !== undefined || review.original_outcome_sha256 !== null)
        return yield* Effect.fail(
          invalid("An acknowledged prefix cannot replace or invent an original terminal outcome."),
        )
    } else {
      if (!originalOutcomeHeader || originalOutcomeHeader.hash !== review.original_outcome_sha256)
        return yield* Effect.fail(
          invalid("The known failure lacks its exact original terminal header."),
        )
      const row = yield* read(sharedCreateOutcomeId(original), sharedCreateOutcomesEntity)
      const terminal = yield* createChecked(() => decodeSharedCreateOutcome(row))
      if (
        terminal.version !== 1 ||
        terminal.status !== "needs_review" ||
        terminal.reason_code !== "SHARED_CREATE_BODY_MISMATCH" ||
        terminal.operation_id !== original ||
        terminal.skill_id !== review.skill_id ||
        terminal.skill_page_id !== input.skillPageId ||
        !same(terminal.bindings, review.bindings) ||
        terminal.source_projection === undefined ||
        !same(terminal.source_projection, {
          source_id: manifest.source_projection.binding.source_id,
          revision: manifest.source_projection.binding.commit,
          manifest_record_hash: input.originalManifestHeader.hash,
        })
      )
        return yield* Effect.fail(
          invalid("Recovery changed the original known failure, source or acknowledged bindings."),
        )
    }
    const ordered = [
      ...manifest.files.filter((file) => file.path === manifest.entrypoint),
      ...manifest.files.filter((file) => file.path !== manifest.entrypoint),
    ]
    if (
      ordered[0]?.path !== manifest.entrypoint ||
      review.bindings.length === 0 ||
      review.bindings.length > ordered.length ||
      review.bindings[0]?.page_id !== input.skillPageId
    )
      return yield* Effect.fail(invalid("Recovery has no exact original main-first prefix."))
    for (const [index, prefix] of review.bindings.entries()) {
      const old = ordered[index]
      const completedBinding = outcome.bindings.find(
        (binding) => binding.file_id === prefix.file_id,
      )
      if (
        !old ||
        old.file_id !== prefix.file_id ||
        old.path !== prefix.path ||
        old.event.event_id !== prefix.event_id ||
        !completedBinding ||
        completedBinding.page_id !== prefix.page_id ||
        completedBinding.path !== prefix.path
      )
        return yield* Effect.fail(
          invalid("Recovery changed an already-created page or the ordered original prefix."),
        )
    }
    for (const old of manifest.files) {
      const file = review.files.find((item) => item.file_id === old.file_id)
      const binding = outcome.bindings.find((item) => item.file_id === old.file_id)
      if (
        !file ||
        !binding ||
        old.projection.version !== 9 ||
        old.projection.purpose !== "data_source_create" ||
        file.projection.version !== 10 ||
        file.projection.purpose !== "data_source_create" ||
        old.projection.removed_terminal_lfs !== file.projection.removed_terminal_lfs ||
        file.path !== old.path ||
        binding.path !== old.path ||
        file.input_sha256 !== old.input.sha256 ||
        file.event.kind !== "projected" ||
        old.event.kind !== "projected" ||
        old.event.parents.length !== 0 ||
        old.ancestors !== undefined ||
        old.baseline_body !== undefined ||
        file.event.source_revision !== old.event.source_revision ||
        old.event.source_revision !== manifest.source_projection.binding.commit ||
        !same(nativeFileMetadata(file.content), nativeFileMetadata(old.content)) ||
        !same(nativeFileMetadata(file.event), nativeFileMetadata(old.event)) ||
        binding.event_id !== file.event.event_id
      )
        return yield* Effect.fail(
          invalid(
            "Recovery changed a frozen path, input, projection, source revision or metadata.",
          ),
        )
      const events = input.events.filter((event) => event.event_id === binding.event_id)
      if (events.length !== 1 || !same(events[0], file.event))
        return yield* Effect.fail(
          invalid("The completion lacks its exact published initial ownership event."),
        )
    }
    return { outcome, review, review_record_hash: retained.hash }
  })
}
