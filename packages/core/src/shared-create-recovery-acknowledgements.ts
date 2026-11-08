import { Effect, Schema } from "effect"
import { property } from "./model.ts"
import { pageId } from "./ref.ts"
import { createChecked, type SharedCreatePlan } from "./shared-create-model.ts"
import type { SharedCreateBinding } from "./shared-create-outcome.ts"
import { sharedCreateFileRequest, sharedCreateMainRequest } from "./shared-create.ts"
import { assertSharedCreateAcknowledgedMetadata } from "./shared-create-recovery-prefix-model.ts"
import {
  SharedNativeAllocationProofSchema,
  type SharedNativeAllocationProof,
  type SharedNativeAllocationReference,
} from "./shared-create-recovery-acknowledgement-model.ts"
import { prefixRecoveryRequired } from "./shared-create-recovery-errors.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  validateSharedRecordEnvelope,
} from "./shared-records.ts"
import { SourceMutationAcknowledgementSchema } from "./shared-sources-model.ts"
import { sha256 } from "./store.ts"

const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const hash = (value: unknown) => sha256(canonicalSharedJson(value))
const refusal = (message: string) => Effect.fail(prefixRecoveryRequired(message))

export type NativeAllocation = {
  readonly attemptId: string
  readonly file: SharedCreatePlan["files"][number]
  readonly acknowledgement?: unknown
}

/** Full original responses remain in separate ordinary bounded facts. A digest alone is not an ACK. */
export function prepareSharedNativeAllocationProof(
  plan: SharedCreatePlan,
  skillPageId: string,
  binding: SharedCreateBinding,
  acknowledgement: unknown,
  allocation: NativeAllocation,
) {
  return Effect.gen(function* () {
    const ack = yield* createChecked(() =>
      Schema.decodeUnknownSync(SourceMutationAcknowledgementSchema)(acknowledgement, {
        onExcessProperty: "error",
      }),
    )
    if (allocation.acknowledgement !== undefined && !same(ack, allocation.acknowledgement))
      return yield* refusal(
        "The retained proof replaced an ACK already bound by the original review.",
      )
    const main = binding.page_id === skillPageId
    if (
      binding.file_id !== allocation.file.file_id ||
      binding.path !== allocation.file.path ||
      (main && allocation.attemptId !== plan.operation_id)
    )
      return yield* refusal("An allocation proof changed its exact original file or main dispatch.")
    const body = main
      ? sharedCreateMainRequest(plan.library, plan)
      : sharedCreateFileRequest(plan.library, skillPageId, allocation.file)
    const request = {
      identity: allocation.attemptId + ":" + (yield* hash(["v1/pages", "POST", body])),
      path: "v1/pages" as const,
      method: "POST" as const,
      body,
    }
    const dispatch = {
      version: 1 as const,
      operation: "source-op-" + (yield* hash(request)),
      ...request,
    }
    const response = property(ack.response)
    if (
      ack.operation_id !== dispatch.operation ||
      ack.request_hash !== (yield* hash(dispatch)) ||
      ack.response_hash !== (yield* hash(ack.response)) ||
      !Number.isSafeInteger(ack.acknowledged_at) ||
      ack.acknowledged_at < 0 ||
      response.object !== "page" ||
      response.id !== binding.page_id ||
      pageId(binding.page_id) !== binding.page_id ||
      response.archived === true ||
      response.is_archived === true ||
      response.in_trash === true ||
      property(response.parent).data_source_id !== property(property(body).parent).data_source_id
    )
      return yield* refusal(
        "The allocation lacks its exact original request, durable ACK, page or parent.",
      )
    yield* createChecked(() => assertSharedCreateAcknowledgedMetadata(body, ack.response))
    const payload: SharedNativeAllocationProof = {
      version: 1,
      kind: "native_create_acknowledgement",
      original_operation_id: plan.operation_id,
      allocation_operation_id: allocation.attemptId,
      skill_id: plan.skill_id,
      skill_page_id: skillPageId,
      file_id: binding.file_id,
      path: binding.path,
      page_id: binding.page_id,
      dispatch,
      acknowledgement: ack,
    }
    const digest = yield* hash(payload),
      operationId = "retain-native-ack-" + digest
    yield* createChecked(() => validateSharedRecordEnvelope(operationId, payload, "object"))
    return {
      payload,
      operation_id: operationId,
      reference: {
        file_id: binding.file_id,
        page_id: binding.page_id,
        allocation_operation_id: allocation.attemptId,
        record_id: "native-ack-" + digest,
        hash: yield* hash({ version: 1, operation_id: operationId, payload }),
      } satisfies SharedNativeAllocationReference,
    }
  })
}
export type PreparedNativeAllocationProof = Effect.Success<
  ReturnType<typeof prepareSharedNativeAllocationProof>
>

export function retainSharedNativeAllocationProofs(
  library: SharedLibrary,
  skillPageId: string,
  proofs: readonly PreparedNativeAllocationProof[],
) {
  return Effect.forEach(proofs, (proof) =>
    appendSharedRecord(library, {
      mode: "create",
      recordId: proof.reference.record_id,
      operationId: proof.operation_id,
      skillPageId,
      kind: "object",
      entityId: proof.reference.record_id,
      payload: proof.payload,
      payloadContainsBody: true,
    }),
  )
}

/** Independent clients reconstruct frozen requests from the shared original plan and read the complete ACK facts. */
export function readSharedNativeAllocationProofs(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  skillPageId: string,
  bindings: readonly SharedCreateBinding[],
  references: readonly SharedNativeAllocationReference[],
  allocationFor: (binding: SharedCreateBinding) => NativeAllocation,
) {
  return Effect.gen(function* () {
    if (
      references.length !== bindings.length ||
      new Set(references.map((item) => item.record_id)).size !== references.length ||
      new Set(references.map((item) => item.page_id)).size !== references.length
    )
      return yield* refusal("The allocation proof directory is incomplete or duplicated.")
    const rows = []
    for (let offset = 0; offset < references.length; offset += 80)
      rows.push(
        ...(yield* querySharedRecords(library, {
          skillPageId,
          kind: "object",
          entityIds: references.slice(offset, offset + 80).map((item) => item.record_id),
          payloadContainsBody: true,
        })),
      )
    if (rows.length !== references.length)
      return yield* refusal(
        "A complete original allocation response fact is missing or duplicated.",
      )
    for (const [index, binding] of bindings.entries()) {
      const ref = references[index]!,
        row = rows.find((item) => item.record_id === ref.record_id)
      if (
        !row ||
        ref.file_id !== binding.file_id ||
        ref.page_id !== binding.page_id ||
        row.hash !== ref.hash ||
        row.entity_id !== ref.record_id ||
        row.skill_page_id !== skillPageId
      )
        return yield* refusal("An allocation proof differs from its immutable reference or owner.")
      const proof = yield* createChecked(() =>
        Schema.decodeUnknownSync(SharedNativeAllocationProofSchema)(row.payload, {
          onExcessProperty: "error",
        }),
      )
      const rebuilt = yield* prepareSharedNativeAllocationProof(
        plan,
        skillPageId,
        binding,
        proof.acknowledgement,
        allocationFor(binding),
      )
      if (
        !same(rebuilt.payload, proof) ||
        !same(rebuilt.reference, ref) ||
        row.operation_id !== rebuilt.operation_id
      )
        return yield* refusal(
          "The retained allocation does not reconstruct its exact original frozen POST and ACK.",
        )
    }
  })
}
