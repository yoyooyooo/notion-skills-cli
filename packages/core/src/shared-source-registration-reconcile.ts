import { Effect } from "effect"
import { fail } from "./model.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { makeSourceBinding, registerSourceBinding } from "./shared-source-binding.ts"
import { makeSourcePlanBinding, registerSourcePlanBinding } from "./shared-source-plan-binding.ts"
import { loadPendingSharedSourceRegistration } from "./shared-source-registration.ts"
import { resolveSelectedSharedSourceReference } from "./shared-selected-source.ts"

/** Reconcile an exact retained registration; never re-inspect a URL, reread a manifest, or POST. */
export function reconcileSharedSourceRegistration(
  library: SharedLibrary,
  input: { readonly skillPageId: string; readonly sourceId: string },
) {
  return Effect.gen(function* () {
    const retained = yield* loadPendingSharedSourceRegistration(library, input)
    if (retained === undefined) {
      const selected = yield* resolveSelectedSharedSourceReference(library, input)
      return {
        source_id: selected.source_id,
        revision: selected.revision,
        status: "observed" as const,
        original_dispatch: "unavailable" as const,
        writes: 0 as const,
      }
    }
    if (retained.payload.kind === "git") {
      const { url, commit, root, tree, files } = retained.payload
      const source = { url, commit, root, tree, files }
      const canonical = yield* makeSourceBinding(source)
      if (
        canonical.source_id !== input.sourceId ||
        canonicalSharedJson(canonical) !== canonicalSharedJson(retained.payload)
      )
        return yield* Effect.fail(
          fail(
            "SOURCE_REGISTRATION_CONFLICT",
            "The original Git registration does not match its fixed content identity.",
          ),
        )
      const result = yield* registerSourceBinding(retained.library, {
        skillPageId: input.skillPageId,
        mode: "reconcile",
        fixedSource: source,
      })
      return {
        source_id: result.binding.source_id,
        revision: result.binding.commit,
        status: "observed" as const,
        original_dispatch: "retained" as const,
        writes: 0 as const,
      }
    }
    const canonical = yield* makeSourcePlanBinding(retained.payload)
    if (
      canonical.source_plan_id !== input.sourceId ||
      canonicalSharedJson(canonical.plan) !== canonicalSharedJson(retained.payload)
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_REGISTRATION_CONFLICT",
          "The original composition registration does not match its fixed content identity.",
        ),
      )
    const result = yield* registerSourcePlanBinding(retained.library, {
      skillPageId: input.skillPageId,
      mode: "reconcile",
      plan: retained.payload,
    })
    return {
      source_id: result.binding.source_plan_id,
      revision: result.binding.source_plan_id,
      status: "observed" as const,
      original_dispatch: "retained" as const,
      writes: 0 as const,
    }
  })
}
