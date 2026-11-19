import { Effect } from "effect"
import { fail } from "./model.ts"
import { readCurrentOperationIntent, type CurrentWriteMode } from "./shared-current-operation.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"

/** A new parent cannot forget the one older child that its current predecessor
 * has not handed over yet. Inspect at most that cursor target, never an ancestry
 * log or one Record query per member. Repeating the same successor is resume. */
export function assertCurrentSourceHandoffSettled(
  library: SharedLibrary,
  pending: Effect.Success<ReturnType<typeof readCurrentOperationIntent>>,
  mode: CurrentWriteMode | undefined,
  newOperationId: string,
) {
  return Effect.gen(function* () {
    if (
      typeof mode !== "object" ||
      pending === undefined ||
      pending.intent.operation_id === newOperationId ||
      pending.intent.operation_id !== mode.operation_id
    )
      return
    const previous = pending.predecessor
    if (
      previous === undefined ||
      !("source_input" in previous.intent) ||
      !("source_input" in pending.intent) ||
      previous.source_progress === undefined
    )
      return
    const skillId =
      previous.intent.source_input.affected_skill_ids[previous.source_progress.next_index]
    if (skillId === undefined) return
    const child = yield* readCurrentOperationIntent(library, { kind: "skill", id: skillId })
    if (child === undefined) return
    const binding = "source" in child.intent ? child.intent.source : undefined
    const expectedOperation =
      "source-target-" +
      (yield* sha256(canonicalSharedJson([pending.intent.operation_id, skillId])))
    const expectedAuthorization = yield* sha256(
      canonicalSharedJson({
        parent: pending.intent,
        page_id: pending.owner_page_id,
        skill_id: skillId,
        input_sha256: child.intent.input_sha256,
      }),
    )
    if (
      binding !== undefined &&
      binding.source_id === pending.intent.owner.id &&
      binding.source_page_id === pending.owner_page_id &&
      binding.operation_id === pending.intent.operation_id &&
      binding.input_sha256 === pending.intent.input_sha256 &&
      child.intent.operation_id === expectedOperation &&
      binding.authorization_sha256 === expectedAuthorization
    )
      return
    return yield* Effect.fail(
      fail(
        "CURRENT_SOURCE_HANDOFF_PENDING",
        "Finish the selected Source's existing child handoff before replacing its goal again.",
        {
          owner: pending.intent.owner,
          source_id: pending.intent.owner.id,
          source_page_id: pending.owner_page_id,
          operation_id: pending.intent.operation_id,
          input_sha256: pending.intent.input_sha256,
          source_action: pending.intent.source_input.kind,
          child: {
            owner: child.intent.owner,
            operation_id: child.intent.operation_id,
            source_intent: binding ?? null,
          },
          next: "reconcile_current",
          required_input:
            "Resume the current Source action with its original input and --operation " +
            pending.intent.operation_id +
            " --resume, then submit another complete successor if needed.",
        },
      ),
    )
  })
}
