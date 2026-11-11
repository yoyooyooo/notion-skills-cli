import { Effect, Schema } from "effect"
import { fail } from "./model.ts"
import {
  createChecked,
  sharedCreateBodyPayload,
  sharedCreateManifestEntity,
} from "./shared-create-model.ts"
import { loadSharedCreatePlan, retainSharedCreateInputs } from "./shared-create.ts"
import { sharedCreateOutcomeId } from "./shared-create-outcome.ts"
import {
  sharedCreateRecoveryOutcomeId,
  sharedCreateRecoveryReviewId,
} from "./shared-create-recovery-completion.ts"
import { readSharedNativeAllocationProofs } from "./shared-create-recovery-acknowledgements.ts"
import {
  SharedCreateNativeRecoveryOutcomeSchema,
  sharedNativeRecoveryOutcomesEntity,
  sharedNativeRecoveryReviewEntity,
} from "./shared-create-recovery-native-model.ts"
import {
  nativeMainRecoveryPlan,
  makeSharedCreateNativeRecoveryFile,
  makeSharedCreateNativeRecoveryReview,
  validateSharedCreateNativeRecoveryReview,
} from "./shared-create-recovery-native-plan.ts"
import type { FileEvent } from "./shared-file-state.ts"
import { preservesSharedLibraryBindings, type SharedLibrary } from "./shared-library-model.ts"
import { querySharedOperationIndex, type SharedOperationHeader } from "./shared-operation-index.ts"
import { canonicalSharedJson, querySharedRecords } from "./shared-records.ts"
import { sha256 } from "./store.ts"

const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const invalid = (message: string) => fail("SHARED_CREATE_RECOVERY_INVALID", message)

/** Historical proof uses only immutable shared evidence; no current body or local approval is adopted. */
export function readSharedCreateNativeCompletion(
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
    const selected = headers.filter(
      (header) => header.record_id === sharedCreateRecoveryOutcomeId(original),
    )
    if (selected.length === 0) return undefined
    if (selected.length !== 1)
      return yield* Effect.fail(invalid("The native recovery completion header is duplicated."))
    if (selected[0]!.entity_id !== sharedNativeRecoveryOutcomesEntity) return undefined
    const read = (recordId: string, entityId: string) =>
      Effect.gen(function* () {
        const exact = headers.filter((header) => header.record_id === recordId)
        if (exact.length !== 1 || exact[0]!.entity_id !== entityId)
          return yield* Effect.fail(
            invalid("The native recovery lacks its exact shared operation header."),
          )
        const rows = yield* querySharedRecords(library, {
          skillPageId: input.skillPageId,
          kind: "operation",
          recordId,
          entityId,
          payloadContainsBody: true,
        })
        const row = rows[0]
        if (
          rows.length !== 1 ||
          row === undefined ||
          row.hash !== exact[0]!.hash ||
          row.skill_page_id !== input.skillPageId ||
          row.record_id !== recordId ||
          row.entity_id !== entityId
        )
          return yield* Effect.fail(
            invalid("A native recovery fact differs from its exact header and owner."),
          )
        return row
      })
    const completion = yield* read(
      sharedCreateRecoveryOutcomeId(original),
      sharedNativeRecoveryOutcomesEntity,
    )
    const outcome = yield* createChecked(() =>
      Schema.decodeUnknownSync(SharedCreateNativeRecoveryOutcomeSchema)(completion.payload, {
        onExcessProperty: "error",
      }),
    )
    const retained = yield* read(
      sharedCreateRecoveryReviewId(original),
      sharedNativeRecoveryReviewEntity,
    )
    const review = yield* validateSharedCreateNativeRecoveryReview(
      retained.payload,
      outcome.recovery_id,
    )
    if (
      headers.some((header) => header.record_id === sharedCreateOutcomeId(original)) ||
      original !== review.original_operation_id ||
      review.skill_page_id !== input.skillPageId ||
      review.original_manifest_sha256 !== input.originalManifestHeader.hash ||
      input.originalManifestHeader.entity_id !== sharedCreateManifestEntity ||
      !preservesSharedLibraryBindings(review.library, library) ||
      retained.operation_id !== review.review_id ||
      completion.operation_id !== review.review_id
    )
      return yield* Effect.fail(
        invalid(
          "The native completion changed its exact original plan, owner or absent original outcome.",
        ),
      )
    const plan = yield* nativeMainRecoveryPlan(
      yield* loadSharedCreatePlan(library, {
        skillPageId: input.skillPageId,
        operationId: original,
      }),
    )
    yield* retainSharedCreateInputs(library, plan, input.skillPageId, "reconcile")
    const rebuilt = yield* makeSharedCreateNativeRecoveryReview({
      plan,
      page: input.skillPageId,
      origin: review.origin,
      bootstrap: review.bootstrap,
      observations: review.observations,
    })
    if (!same(rebuilt, review))
      return yield* Effect.fail(
        invalid(
          "The shared native decision does not reconstruct from its full original input and fixed projection.",
        ),
      )
    const proofs = yield* readSharedNativeAllocationProofs(
      library,
      plan,
      input.skillPageId,
      review.bindings,
      review.bootstrap.allocations,
      () => ({ attemptId: plan.operation_id, file: plan.files[0]! }),
    )
    if (
      review.bootstrap.original_dispatches_sha256 !==
      (yield* sha256(
        canonicalSharedJson(
          proofs.map(({ dispatch, acknowledgement }) => ({ dispatch, acknowledgement })),
        ),
      ))
    )
      return yield* Effect.fail(
        invalid(
          "The shared complete allocation proof differs from the original dispatch-set commitment.",
        ),
      )
    const file = yield* makeSharedCreateNativeRecoveryFile(plan)
    const bodies = yield* querySharedRecords(library, {
      skillPageId: input.skillPageId,
      kind: "object",
      entityId: file.content.object_id,
      payloadContainsBody: true,
    })
    const body = bodies[0]
    if (
      bodies.length !== 1 ||
      body === undefined ||
      body.record_id !== file.content.object_id ||
      body.operation_id !== "retain-" + file.content.sha256 ||
      !same(body.payload, sharedCreateBodyPayload(file.projection.markdown))
    )
      return yield* Effect.fail(
        invalid("The full new native body fact is missing or differs from its fixed prediction."),
      )
    const wantedBindings = [
      {
        file_id: file.file_id,
        path: file.path,
        page_id: input.skillPageId,
        event_id: file.event.event_id,
      },
    ]
    const expected = {
      version: 7,
      kind: "skill_create_recovery_outcome",
      status: "applied",
      original_operation_id: plan.operation_id,
      original_plan_sha256: review.original_plan_sha256,
      original_manifest_sha256: review.original_manifest_sha256,
      original_outcome_sha256: null,
      bootstrap_sha256: yield* sha256(canonicalSharedJson(review.bootstrap)),
      recovery_id: review.review_id,
      skill_id: plan.skill_id,
      skill_page_id: input.skillPageId,
      review_record_hash: retained.hash,
      bindings: wantedBindings,
    }
    if (!same(outcome, expected) || !input.events.some((event) => same(event, file.event)))
      return yield* Effect.fail(
        invalid(
          "The native completion omits or changes its exact whole-file ownership event and metadata.",
        ),
      )
    const events = yield* querySharedRecords(library, {
      skillPageId: input.skillPageId,
      kind: "file_event",
      recordId: file.event.event_id,
      entityId: file.file_id,
    })
    if (
      events.length !== 1 ||
      events[0]?.operation_id !== file.event.event_id ||
      !same(events[0]?.payload, file.event)
    )
      return yield* Effect.fail(
        invalid("The native recovery event has a foreign immutable record identity."),
      )
    return { review, outcome, plan, file }
  })
}
