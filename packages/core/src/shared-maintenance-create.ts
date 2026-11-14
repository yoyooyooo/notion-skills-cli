import { Effect } from "effect"
import { authScope, databaseId } from "./catalog.ts"
import { fail } from "./model.ts"
import { Store } from "./store.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import {
  loadSharedCreatePlan,
  reconcileSharedCreate,
  sharedCreateJournalKey,
} from "./shared-create.ts"
import { SharedCreateJournalSchema, validateSharedCreatePlan } from "./shared-create-model.ts"
import { loadSharedCreateOwnership } from "./shared-create-ownership.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { resolveSharedMaintenanceTarget } from "./shared-maintenance-target.ts"
import type { SharedMaintenanceSelection } from "./shared-maintenance-operations.ts"
import { Notion } from "./notion.ts"
import { sharedSkillTextProperty } from "./shared-content.ts"

export const isSharedCreationOperation = (id: string) => /^skill-create-[a-f0-9]{64}$/u.test(id)

function originalCreate(input: SharedMaintenanceSelection) {
  return Effect.gen(function* () {
    if (!isSharedCreationOperation(input.operationId))
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Select an exact original native creation ID."),
      )
    const scope = yield* authScope,
      store = yield* Store
    const ownership = yield* loadSharedCreateOwnership(scope, input.operationId)
    const supplied = input.target ?? ownership?.skill_page_id
    const selected =
      supplied === undefined
        ? undefined
        : yield* resolveSharedMaintenanceTarget(supplied, input.entry)
    for (const key of yield* store.listKeys("operations/shared-native-create/")) {
      if (!key.endsWith(`/${input.operationId}.json`)) continue
      const journal = yield* store.readJson(key, SharedCreateJournalSchema)
      if (journal === undefined || journal.scope !== scope) continue
      if (
        journal.library_id !== journal.plan.library.library_id ||
        journal.plan.operation_id !== input.operationId ||
        key !== (yield* sharedCreateJournalKey(scope, journal.library_id, input.operationId))
      )
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "The native original journal does not match its exact address."),
        )
      const plan = yield* validateSharedCreatePlan(journal.plan)
      if (
        (selected !== undefined && selected.library_id !== plan.library.library_id) ||
        (input.entry !== undefined &&
          (yield* databaseId(input.entry)) !== plan.library.skills.database_id)
      )
        return yield* Effect.fail(
          fail(
            "OPERATION_SCOPE_MISMATCH",
            "The native original creation belongs to another library.",
          ),
        )
      if (ownership !== undefined && ownership.skill_id !== plan.skill_id)
        return yield* Effect.fail(
          fail(
            "OPERATION_SCOPE_MISMATCH",
            "The original ownership receipt and creation intent disagree.",
          ),
        )
      if (selected !== undefined) {
        const row = yield* (yield* Notion).request(`v1/pages/${selected.page_id}`)
        if (sharedSkillTextProperty(row, plan.library, "Skill ID") !== plan.skill_id)
          return yield* Effect.fail(
            fail(
              "OPERATION_SCOPE_MISMATCH",
              "The supplied target is not the original creation's stable Skill.",
            ),
          )
      }
      return {
        plan,
        target: ownership?.skill_page_id ?? selected?.page_id ?? null,
        evidence: "original_native_dispatch_journal" as const,
      }
    }
    if (selected === undefined)
      return yield* Effect.fail(
        fail(
          "OPERATION_CONTEXT_REQUIRED",
          "The original native plan is not locally visible. Supply its exact --target page and --entry; no replacement was created.",
        ),
      )
    const library = yield* loadSharedLibrary(selected.entry)
    const plan = yield* loadSharedCreatePlan(library, {
      skillPageId: selected.page_id,
      operationId: input.operationId,
    })
    return {
      plan,
      target: selected.page_id,
      evidence: "original_shared_creation_manifest" as const,
    }
  })
}

export function showSharedCreationOperation(input: SharedMaintenanceSelection) {
  return Effect.gen(function* () {
    const { plan, target, evidence } = yield* originalCreate(input)
    return {
      domain: "shared_maintenance" as const,
      family: "native_create" as const,
      operation_id: plan.operation_id,
      state: "original_intent_recorded" as const,
      verified: false,
      target: { page_id: target, library_id: plan.library.library_id, skill_id: plan.skill_id },
      coverage: { original_intent: evidence, terminal_outcome: "not_checked" as const },
      remote_writes: 0,
      resume_supported: false,
      next: {
        argv: [
          "ntn-skills",
          "ctl",
          "operation",
          "reconcile",
          plan.operation_id,
          "--entry",
          plan.library.skills.database_id,
          ...(target === null ? [] : ["--target", target]),
        ],
        read_only: true,
        reason:
          "Observe only the original native creation. A lost first-page response never permits creating a replacement.",
      },
    }
  }).pipe(withReadOnlyNotion)
}

export function reconcileSharedCreationOperation(input: SharedMaintenanceSelection) {
  return Effect.gen(function* () {
    const { plan, target } = yield* originalCreate(input)
    const result = yield* reconcileSharedCreate(plan.library, plan)
    if (target !== null && result.skill_page_id !== target)
      return yield* Effect.fail(
        fail(
          "OPERATION_SCOPE_MISMATCH",
          "The verified original creation selected a different page.",
        ),
      )
    return {
      domain: "shared_maintenance" as const,
      family: "native_create" as const,
      operation_id: plan.operation_id,
      state: result.status,
      verified: result.verified,
      target: {
        page_id: result.skill_page_id,
        library_id: plan.library.library_id,
        skill_id: plan.skill_id,
      },
      result,
      remote_writes: 0,
      next: {
        argv: [
          "ntn-skills",
          "read",
          result.skill_page_id,
          "--database",
          plan.library.skills.database_id,
          "--authoring",
          "--read-only",
        ],
        read_only: true,
        reason:
          "Original completion is historical; inspect current author content separately without enabling the Skill.",
      },
    }
  }).pipe(withReadOnlyNotion)
}
