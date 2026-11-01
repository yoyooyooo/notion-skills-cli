import { Effect } from "effect"
import { fail } from "./model.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import {
  executeSharedMetadataWriteWithJournal,
  prepareSharedMetadataWrite,
  sharedMetadataWriteProtection,
  validateSharedMetadataWritePlan,
  type SharedMetadataWritePlan,
} from "./shared-metadata-write.ts"
import { resolveSelectedSharedSourceReference } from "./shared-selected-source.ts"

/** null is explicit native Notion content; no empty/alias value silently selects it. */
export function prepareSharedSourceSelection(input: {
  readonly library: SharedLibrary
  readonly skillPageId: string
  readonly sourceId: string | null
  readonly expectedSourceId?: string | null
}) {
  return Effect.gen(function* () {
    const selected =
      input.sourceId === null
        ? undefined
        : yield* resolveSelectedSharedSourceReference(input.library, {
            skillPageId: input.skillPageId,
            sourceId: input.sourceId,
          })
    const plan = yield* prepareSharedMetadataWrite({
      library: input.library,
      skillPageId: input.skillPageId,
      changes: [{ field: "Source", value: input.sourceId ?? "" }],
      ...(input.expectedSourceId === undefined
        ? {}
        : {
            expected: {
              values: [{ field: "Source" as const, value: input.expectedSourceId ?? "" }],
            },
          }),
    })
    return {
      plan,
      selection:
        selected === undefined
          ? { kind: "native" as const }
          : {
              kind: selected.kind,
              source_id: selected.source_id,
              revision: selected.revision,
              paths: selected.paths,
            },
      protection: sharedMetadataWriteProtection,
    }
  })
}

export function validateSharedSourceSelectionPlan(input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedMetadataWritePlan(input)
    const change = plan.changes[0]
    if (
      plan.changes.length !== 1 ||
      change?.field !== "Source" ||
      typeof change.before !== "string" ||
      typeof change.after !== "string"
    )
      return yield* Effect.fail(
        fail(
          "INVALID_SOURCE_SELECTION",
          "This command accepts only a frozen operation that changes the single Source property.",
        ),
      )
    return plan
  })
}

/** The shared metadata journal owns dispatch and reconciliation; Source has no second write ledger. */
export function applySharedSourceSelection(input: {
  readonly library: SharedLibrary
  readonly plan: SharedMetadataWritePlan
  readonly mode: "create" | "reconcile"
  readonly dryRun?: boolean
}) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedSourceSelectionPlan(input.plan)
    return yield* executeSharedMetadataWriteWithJournal({
      library: input.library,
      plan,
      mode: input.mode,
      dryRun: input.dryRun,
      beforeDispatch: (frozen) =>
        Effect.gen(function* () {
          const change = frozen.changes[0]
          if (change === undefined || typeof change.after !== "string")
            return yield* Effect.fail(
              fail("INVALID_SOURCE_SELECTION", "The frozen source selection is incomplete."),
            )
          if (change.after !== "")
            yield* resolveSelectedSharedSourceReference(input.library, {
              skillPageId: frozen.skill_page_id,
              sourceId: change.after,
            })
        }),
    })
  })
}

export function reconcileSharedSourceSelection(
  library: SharedLibrary,
  plan: SharedMetadataWritePlan,
) {
  return applySharedSourceSelection({ library, plan, mode: "reconcile" })
}
