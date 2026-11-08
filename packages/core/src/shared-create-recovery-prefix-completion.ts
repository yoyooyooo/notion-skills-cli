import { Effect, Schema } from "effect"
import { fail } from "./model.ts"
import { pageId } from "./ref.ts"
import {
  createChecked,
  SharedCreateManifestSchema,
  sharedCreateManifestEntity,
} from "./shared-create-model.ts"
import { sharedCreateOutcomeId } from "./shared-create-outcome.ts"
import {
  sharedCreateRecoveryOutcomeId,
  sharedCreateRecoveryOutcomesEntity,
  sharedCreateRecoveryReviewId,
  sharedCreateRecoveryReviewEntity,
} from "./shared-create-recovery-completion.ts"
import {
  SharedCreatePrefixRecoveryOutcomeSchema,
  validateSharedCreatePrefixRecoveryReview,
} from "./shared-create-recovery-prefix-model.ts"
import { nativeFileMetadata, type FileEvent } from "./shared-file-state.ts"
import { preservesSharedLibraryBindings, type SharedLibrary } from "./shared-library-model.ts"
import { querySharedOperationIndex, type SharedOperationHeader } from "./shared-operation-index.ts"
import { canonicalSharedJson, querySharedRecords } from "./shared-records.ts"
import { sha256 } from "./store.ts"

const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const invalid = (message: string) => fail("SHARED_CREATE_RECOVERY_INVALID", message)

/** Compact shared proof for the honest ACK-before-manifest recovery variant.
 * The original outcome remains absent, and later current edits are not adopted here. */
export function readSharedCreatePrefixCompletion(
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
          return yield* Effect.fail(
            invalid("A prefix recovery fact lacks its exact immutable header."),
          )
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
          row.hash !== header.hash ||
          row.skill_page_id !== input.skillPageId
        )
          return yield* Effect.fail(
            invalid("A prefix recovery fact differs from its exact header and owner."),
          )
        return row
      })
    const completed = yield* read(
      sharedCreateRecoveryOutcomeId(original),
      sharedCreateRecoveryOutcomesEntity,
    )
    const outcome = yield* createChecked(() =>
      Schema.decodeUnknownSync(SharedCreatePrefixRecoveryOutcomeSchema)(completed.payload, {
        onExcessProperty: "error",
      }),
    )
    const retained = yield* read(
      sharedCreateRecoveryReviewId(original),
      sharedCreateRecoveryReviewEntity,
      true,
    )
    const review = yield* validateSharedCreatePrefixRecoveryReview(
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
      version: 3,
      kind: "skill_create_recovery_outcome",
      status: "applied",
      original_operation_id: original,
      original_manifest_sha256: input.originalManifestHeader.hash,
      original_plan_sha256: review.original_plan_sha256,
      original_outcome_sha256: null,
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
      review.original_manifest_sha256 !== input.originalManifestHeader.hash ||
      review.original_operation_id !== original ||
      review.skill_page_id !== input.skillPageId ||
      !preservesSharedLibraryBindings(review.library, library) ||
      !preservesSharedLibraryBindings(manifest.library, library) ||
      manifest.version !== 1 ||
      manifest.source_projection?.version !== 1 ||
      manifest.source_projection.local !== undefined ||
      manifest.content_kind !== "skill" ||
      manifest.operation_id !== original ||
      manifest.skill_id !== review.skill_id ||
      headers.some((header) => header.record_id === sharedCreateOutcomeId(original)) ||
      manifest.files.length !== review.files.length ||
      outcome.bindings.length !== manifest.files.length ||
      new Set(outcome.bindings.map((binding) => binding.file_id)).size !== manifest.files.length ||
      new Set(outcome.bindings.map((binding) => binding.page_id)).size !== manifest.files.length ||
      outcome.bindings.some((binding) => pageId(binding.page_id) !== binding.page_id)
    )
      return yield* Effect.fail(
        invalid(
          "The completion does not bind the exact original ACK prefix, manifest and recovery decision.",
        ),
      )
    for (const old of manifest.files) {
      const file = review.files.find((item) => item.file_id === old.file_id)
      const binding = outcome.bindings.find((item) => item.file_id === old.file_id)
      if (
        !file ||
        !binding ||
        old.projection.version !== 8 ||
        old.projection.purpose !== "data_source_create" ||
        file.projection.version !== 9 ||
        file.projection.purpose !== "data_source_create" ||
        old.projection.removed_terminal_lfs !== file.projection.removed_terminal_lfs ||
        file.path !== old.path ||
        binding.path !== old.path ||
        file.input_sha256 !== old.input.sha256 ||
        file.event.kind !== "projected" ||
        old.event.kind !== "projected" ||
        file.event.source_revision !== old.event.source_revision ||
        !same(nativeFileMetadata(file.content), nativeFileMetadata(old.content)) ||
        !same(nativeFileMetadata(file.event), nativeFileMetadata(old.event)) ||
        binding.event_id !== file.event.event_id
      )
        return yield* Effect.fail(
          invalid(
            "Recovery changed a frozen path, input, projection transition or native metadata.",
          ),
        )
      const events = input.events.filter((event) => event.event_id === binding.event_id)
      if (events.length !== 1 || !same(events[0], file.event))
        return yield* Effect.fail(
          invalid("The completion lacks its exact published initial ownership event."),
        )
      if (old.path === manifest.entrypoint) {
        const prefix = review.bindings[0]
        if (
          !prefix ||
          prefix.file_id !== old.file_id ||
          prefix.path !== old.path ||
          prefix.event_id !== old.event.event_id ||
          prefix.page_id !== input.skillPageId ||
          binding.page_id !== prefix.page_id
        )
          return yield* Effect.fail(
            invalid("Recovery replaced the original acknowledged main page."),
          )
      }
    }
    return { outcome, review, review_record_hash: retained.hash }
  })
}

export function completedSharedCreatePrefixRecovery(
  library: SharedLibrary,
  input: Parameters<typeof readSharedCreatePrefixCompletion>[1],
) {
  return readSharedCreatePrefixCompletion(library, input).pipe(
    Effect.map((result) => result !== undefined),
  )
}
