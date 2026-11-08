import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { invalidateSnapshotCache } from "./cache.ts"
import { fail, property } from "./model.ts"
import { pageId } from "./ref.ts"
import { sharedSkillId } from "./shared-content.ts"
import { isResourceContent, type FileEvent } from "./shared-file-state.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { querySharedOperationIndex, type SharedOperationHeader } from "./shared-operation-index.ts"
import {
  pendingFileOperations,
  sharedPendingObservationPrefix,
} from "./shared-pending-file-operations.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  type SharedRecord,
} from "./shared-records.ts"
import { loadSharedResourceContent } from "./shared-resource-content.ts"
import {
  plannedResourceEventId,
  resourceAuthoringChecked,
  resourceAuthoringOutcomeId,
  resourceAuthoringOutcomesEntity,
  SharedResourceAuthoringOutcomeSchema,
  validateSharedResourceAuthoringPlan,
  type SharedResourceAuthoringPlan,
} from "./shared-resource-authoring-model.ts"
import { querySharedSkillIndex } from "./shared-skill-index.ts"
import { restoreSharedSnapshotHistory } from "./shared-snapshot-history.ts"
import { sha256, Store } from "./store.ts"

export function resourceOriginalRecord(
  library: SharedLibrary,
  plan: SharedResourceAuthoringPlan,
  mode: "create" | "reconcile",
) {
  return appendSharedRecord(library, {
    mode,
    recordId: plan.operation_id,
    operationId: plan.operation_id,
    skillPageId: plan.skill_page_id,
    kind: "operation",
    entityId: plan.file_id,
    payload: plan,
  })
}
function decodeOutcome(row: SharedRecord) {
  const value = Schema.decodeUnknownSync(SharedResourceAuthoringOutcomeSchema)(row.payload, {
    onExcessProperty: "error",
  })
  const eventId = plannedResourceEventId(value.operation_id)
  if (
    eventId === undefined ||
    row.kind !== "operation" ||
    row.entity_id !== resourceAuthoringOutcomesEntity ||
    row.record_id !== resourceAuthoringOutcomeId(value.operation_id) ||
    row.operation_id !== value.operation_id ||
    (value.page_id !== null && pageId(value.page_id) !== value.page_id) ||
    (value.entry_block_id !== null && pageId(value.entry_block_id) !== value.entry_block_id) ||
    (value.status === "applied"
      ? value.event_id !== eventId || value.page_id === null || value.entry_block_id === null
      : value.event_id !== null)
  )
    throw fail(
      "SHARED_RESOURCE_AUTHORING_INVALID",
      "The resource outcome differs from its exact original identity.",
    )
  return value
}
export function resourceOperationScope(
  library: SharedLibrary,
  plan: Pick<SharedResourceAuthoringPlan, "skill_id" | "skill_page_id">,
) {
  return Effect.gen(function* () {
    const scope = yield* authScope
    return {
      prefix: yield* sharedPendingObservationPrefix(scope, library.library_id, plan.skill_id),
      scope,
      library_id: library.library_id,
      skill_id: plan.skill_id,
      skill_page_id: plan.skill_page_id,
    }
  })
}
export function retireResourceOperation(library: SharedLibrary, plan: SharedResourceAuthoringPlan) {
  return Effect.gen(function* () {
    const scope = yield* resourceOperationScope(library, plan)
    const local = yield* pendingFileOperations(scope)
    const original = local.find((entry) => entry.plan.operation_id === plan.operation_id)
    if (original !== undefined) {
      if (canonicalSharedJson(original.plan) !== canonicalSharedJson(plan))
        return yield* Effect.fail(
          fail(
            "STATE_CORRUPT",
            "The local original resource intent differs from its shared outcome.",
          ),
        )
      yield* (yield* Store).retireKeys([original.key])
    }
    yield* invalidateSnapshotCache(sharedSkillId(library.library_id, plan.skill_id), scope.scope)
  })
}

export function loadSharedResourceAuthoringPlan(
  library: SharedLibrary,
  input: { readonly skillPageId: string; readonly operationId: string },
) {
  return Effect.gen(function* () {
    if (plannedResourceEventId(input.operationId) === undefined)
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Select one exact original resource-authoring operation."),
      )
    const index = yield* querySharedSkillIndex(library, input.skillPageId)
    const scope = yield* resourceOperationScope(library, {
      skill_id: index.skill_id,
      skill_page_id: index.page_id,
    })
    const local = (yield* pendingFileOperations(scope)).find(
      (entry) => entry.plan.operation_id === input.operationId,
    )
    if (local !== undefined) {
      if (local.plan.kind !== "resource_authoring")
        return yield* Effect.fail(
          fail("SHARED_RESOURCE_SCOPE", "The local original intent is another operation kind."),
        )
      return local.plan
    }
    const rows = yield* querySharedRecords(library, {
      skillPageId: input.skillPageId,
      kind: "operation",
      recordId: input.operationId,
    })
    const row = rows[0]
    if (rows.length !== 1 || row === undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_AUTHORING_UNRESOLVED",
          "The original resource intent is unavailable; no replacement operation will be created.",
        ),
      )
    const plan = yield* validateSharedResourceAuthoringPlan(row.payload)
    if (
      plan.operation_id !== input.operationId ||
      row.record_id !== plan.operation_id ||
      row.operation_id !== plan.operation_id ||
      row.entity_id !== plan.file_id ||
      plan.library_id !== library.library_id ||
      plan.skill_page_id !== input.skillPageId ||
      plan.skill_id !== index.skill_id
    )
      return yield* Effect.fail(
        fail("SHARED_RESOURCE_SCOPE", "The resource intent belongs to another original scope."),
      )
    return plan
  })
}

/** Only immutable original records decide completion. No upload, create, append,
 * event write or current-byte inference occurs on this path. */
export function reconcileSharedResourceAuthoring(
  library: SharedLibrary,
  input: SharedResourceAuthoringPlan,
) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedResourceAuthoringPlan(input)
    if (plan.library_id !== library.library_id)
      return yield* Effect.fail(
        fail("SHARED_RESOURCE_SCOPE", "The resource intent belongs to another library."),
      )
    const index = yield* querySharedSkillIndex(library, plan.skill_page_id)
    if (index.skill_id !== plan.skill_id)
      return yield* Effect.fail(
        fail("SHARED_RESOURCE_SCOPE", "The resource intent belongs to another stable Skill."),
      )
    yield* resourceOriginalRecord(library, plan, "reconcile")
    const rows = yield* querySharedRecords(library, {
      skillPageId: plan.skill_page_id,
      kind: "operation",
      entityId: resourceAuthoringOutcomesEntity,
      recordId: resourceAuthoringOutcomeId(plan.operation_id),
    })
    if (rows.length !== 1 || rows[0] === undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_AUTHORING_UNRESOLVED",
          "The exact original resource outcome is unavailable; matching current bytes or pages never authorize replay.",
          { resource_operation_id: plan.operation_id, next_mode: "reconcile" },
        ),
      )
    const outcome = yield* resourceAuthoringChecked(() => decodeOutcome(rows[0]!))
    if (outcome.file_id !== plan.file_id)
      return yield* Effect.fail(
        fail("SHARED_RESOURCE_SCOPE", "The original resource outcome names another file."),
      )
    if (outcome.status === "needs_review")
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_AUTHORING_REVIEW_REQUIRED",
          "Preserve the original resource operation, retained bytes and management page for explicit review.",
          { resource_operation_id: plan.operation_id, page_id: outcome.page_id },
        ),
      )
    if (outcome.status === "applied") {
      yield* restoreSharedSnapshotHistory(library, {
        skillPageId: plan.skill_page_id,
        pinId: plan.prior_pin,
        expectedSkillId: plan.skill_id,
      })
      yield* loadSharedResourceContent(library, {
        skillPageId: plan.skill_page_id,
        content: plan.content,
      })
      if (plan.before !== null)
        yield* loadSharedResourceContent(library, {
          skillPageId: plan.skill_page_id,
          content: plan.before,
        })
      if (plan.baseline !== null)
        yield* appendSharedRecord(library, {
          mode: "reconcile",
          skillPageId: plan.skill_page_id,
          kind: "file_event",
          entityId: plan.file_id,
          recordId: plan.baseline.event_id,
          operationId: plan.baseline.event_id,
          payload: plan.baseline,
        })
      yield* appendSharedRecord(library, {
        mode: "reconcile",
        skillPageId: plan.skill_page_id,
        kind: "file_event",
        entityId: plan.file_id,
        recordId: plan.event.event_id,
        operationId: plan.event.event_id,
        payload: plan.event,
      })
      const binding = index.files.find((file) => file.file_id === plan.file_id)
      if (
        binding === undefined ||
        binding.page_id !== outcome.page_id ||
        (plan.page_id !== null && plan.page_id !== binding.page_id)
      )
        return yield* Effect.fail(
          fail(
            "SHARED_RESOURCE_AUTHORING_UNRESOLVED",
            "The original resource event no longer has its exact bound management page.",
          ),
        )
    }
    yield* retireResourceOperation(library, plan)
    return {
      status: outcome.status === "applied" ? ("applied" as const) : ("not_applied" as const),
      operation_id: plan.operation_id,
      file_id: plan.file_id,
      page_id: outcome.page_id,
      prior_pin: plan.prior_pin,
      verified: true as const,
      requires_fresh_read: true as const,
      remote_writes: 0 as const,
    }
  })
}

/** Share the one-per-Skill operation index. Completed intents need only their
 * compact outcomes and content-derived file events, never their original input. */
export function loadPendingSharedResourceAuthoring(
  library: SharedLibrary,
  input: {
    readonly skillPageId: string
    readonly events: readonly FileEvent[]
    readonly headers?: readonly SharedOperationHeader[]
  },
) {
  return Effect.gen(function* () {
    const headers = input.headers ?? (yield* querySharedOperationIndex(library, input.skillPageId))
    const candidates = headers.filter(
      (header) =>
        header.record_id.startsWith("resource-authoring-") &&
        header.entity_id !== resourceAuthoringOutcomesEntity,
    )
    if (candidates.length === 0) return [] as readonly SharedResourceAuthoringPlan[]
    const outcomeHeaders = headers.filter(
      (header) => header.entity_id === resourceAuthoringOutcomesEntity,
    )
    const rows =
      outcomeHeaders.length === 0
        ? []
        : yield* querySharedRecords(library, {
            skillPageId: input.skillPageId,
            kind: "operation",
            entityId: resourceAuthoringOutcomesEntity,
          })
    const outcomes = new Map<string, ReturnType<typeof decodeOutcome>>()
    for (const row of rows) {
      const value = yield* resourceAuthoringChecked(() => decodeOutcome(row))
      if (outcomeHeaders.find((header) => header.record_id === row.record_id)?.hash !== row.hash)
        return yield* Effect.fail(
          fail(
            "SHARED_RESOURCE_AUTHORING_INVALID",
            "A resource outcome differs from its exact compact index.",
          ),
        )
      outcomes.set(value.operation_id, value)
    }
    for (const header of outcomeHeaders)
      if (!outcomes.has(header.record_id.replace(/^outcome-/u, "")))
        return yield* Effect.fail(
          fail(
            "SHARED_RESOURCE_AUTHORING_UNRESOLVED",
            "An indexed original resource outcome is unavailable.",
          ),
        )
    const plans: SharedResourceAuthoringPlan[] = []
    for (const header of candidates) {
      const eventId = plannedResourceEventId(header.record_id)
      if (eventId === undefined)
        return yield* Effect.fail(
          fail(
            "SHARED_RESOURCE_AUTHORING_INVALID",
            "A resource header has an invalid original identity.",
          ),
        )
      const outcome = outcomes.get(header.record_id)
      if (outcome !== undefined && outcome.file_id !== header.entity_id)
        return yield* Effect.fail(
          fail("SHARED_RESOURCE_SCOPE", "A resource outcome names another original file."),
        )
      if (outcome?.status === "not_sent" || outcome?.status === "rejected") continue
      if (outcome?.status === "applied") {
        const event = input.events.find((value) => value.event_id === eventId)
        const resourceEvent =
          event !== undefined &&
          (event.kind === "resource_followed" ||
            (event.kind === "adopted"
              ? isResourceContent(event.content)
              : (event.kind === "deleted" || event.kind === "moved") &&
                isResourceContent(event.retained)))
        if (event === undefined || event.file_id !== header.entity_id || !resourceEvent)
          return yield* Effect.fail(
            fail(
              "SHARED_RESOURCE_AUTHORING_UNRESOLVED",
              "The original resource completion has no exact resource event.",
            ),
          )
        const { event_id: _event, ...fields } = event
        if (eventId !== `resource-${yield* sha256(canonicalSharedJson({ version: 1, ...fields }))}`)
          return yield* Effect.fail(
            fail(
              "SHARED_RESOURCE_AUTHORING_INVALID",
              "The original resource event failed its content-derived identity.",
            ),
          )
        continue
      }
      const originals = yield* querySharedRecords(library, {
        skillPageId: input.skillPageId,
        kind: "operation",
        entityId: header.entity_id,
        recordId: header.record_id,
      })
      const row = originals[0]
      if (originals.length !== 1 || row === undefined)
        return yield* Effect.fail(
          fail(
            "SHARED_RESOURCE_AUTHORING_UNRESOLVED",
            "The indexed original resource plan is unavailable.",
          ),
        )
      const plan = yield* validateSharedResourceAuthoringPlan(row.payload)
      if (
        row.hash !== header.hash ||
        row.operation_id !== plan.operation_id ||
        row.record_id !== plan.operation_id ||
        row.entity_id !== plan.file_id ||
        plan.library_id !== library.library_id ||
        plan.skill_page_id !== input.skillPageId
      )
        return yield* Effect.fail(
          fail("SHARED_RESOURCE_SCOPE", "The resource plan differs from its exact indexed scope."),
        )
      plans.push(plan)
    }
    return plans.sort((left, right) => left.operation_id.localeCompare(right.operation_id))
  })
}
