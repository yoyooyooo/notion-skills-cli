import { Effect, Schema } from "effect"
import { authScope, databaseId } from "./catalog.ts"
import { fail, property } from "./model.ts"
import { pageId } from "./ref.ts"
import { Store } from "./store.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import { canonicalSharedJson, querySharedRecords } from "./shared-records.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { withSharedAuthoringTarget } from "./shared-authoring-context.ts"
import {
  pendingFileOperations,
  sharedPendingObservationPrefix,
} from "./shared-pending-file-operations.ts"
import { validateSharedBodyWritePlan } from "./shared-body-write-model.ts"
import { reconcileSharedBodyWrite } from "./shared-body-write.ts"
import {
  validateSharedMetadataWritePlan,
  sharedMetadataEntity,
} from "./shared-metadata-write-model.ts"
import { reconcileSharedMetadataWrite } from "./shared-metadata-write.ts"
import { validateSharedFileManagementPlan } from "./shared-file-management-model.ts"
import { reconcileSharedFileManagement } from "./shared-file-management.ts"
import {
  validateSharedSkillApplyPlan,
  sharedSkillApplyPlansEntity,
} from "./shared-skill-apply-model.ts"
import { reconcileSharedSkillApply, resumeSharedSkillApply } from "./shared-skill-apply.ts"
import {
  validateSharedNativeAdoptionPlan,
  nativeAdoptionEntity,
} from "./shared-native-adoption-model.ts"
import { reconcileSharedNativeAdoption } from "./shared-native-adoption.ts"
import { validateSharedResourceAuthoringPlan } from "./shared-resource-authoring-model.ts"
import { reconcileSharedResourceAuthoring } from "./shared-resource-authoring-recovery.ts"
import { resolveSharedMaintenanceTarget } from "./shared-maintenance-target.ts"
import { validateSharedBodyWriteReviewPlan } from "./shared-body-write-review-model.ts"
import { reconcileSharedBodyWriteReview } from "./shared-body-write-review.ts"
import {
  validateSharedObservationPlan,
  reconcileSharedObservation,
} from "./shared-observation-operation.ts"

export const isSharedMaintenanceOperation = (id: string) =>
  /^(?:(?:metadata-write|skill-adopt|body-review)-[a-f0-9]{64}|(?:observe|body-write-(?:adopt|follow)|file-management-(?:add|delete|move|undelete)|skill-apply|resource-authoring-(?:add|replace|delete|move|restore|undelete))-[a-f0-9]{64}\.[a-f0-9]{64})$/u.test(
    id,
  )

export type SharedMaintenanceSelection = {
  readonly operationId: string
  readonly target?: string
  readonly entry?: string
}

function validateOriginal(input: unknown) {
  return Effect.gen(function* () {
    switch (property(input).kind) {
      case "body_write":
        return yield* validateSharedBodyWritePlan(input)
      case "metadata_write":
        return yield* validateSharedMetadataWritePlan(input)
      case "file_management":
        return yield* validateSharedFileManagementPlan(input)
      case "skill_apply":
        return yield* validateSharedSkillApplyPlan(input)
      case "native_adoption":
        return yield* validateSharedNativeAdoptionPlan(input)
      case "resource_authoring":
        return yield* validateSharedResourceAuthoringPlan(input)
      case "body_write_review":
        return yield* validateSharedBodyWriteReviewPlan(input)
      case "file_observation":
        return yield* validateSharedObservationPlan(input)
      default:
        return yield* Effect.fail(
          fail(
            "OPERATION_DOMAIN_UNSUPPORTED",
            "This original operation has a separate recovery contract; no write was replayed.",
          ),
        )
    }
  })
}

function selectedOriginal(input: SharedMaintenanceSelection) {
  return Effect.gen(function* () {
    if (!isSharedMaintenanceOperation(input.operationId))
      return yield* Effect.fail(
        fail(
          "INVALID_ARGUMENT",
          "Use one exact original maintenance operation and optional exact target and library entry.",
        ),
      )
    const resolved =
      input.target !== undefined && pageId(input.target) === undefined
        ? yield* resolveSharedMaintenanceTarget(input.target, input.entry)
        : undefined
    const selected =
      resolved?.page_id ?? (input.target === undefined ? undefined : pageId(input.target))
    const scope = yield* authScope
    const store = yield* Store
    const local: {
      plan: Effect.Success<ReturnType<typeof validateOriginal>>
      library_id: string
    }[] = []
    const keys = yield* store.listKeys("operations/shared-observation-pending/")
    if (keys.length > 1000 && (input.entry === undefined || selected === undefined))
      return yield* Effect.fail(
        fail(
          "OPERATION_SCOPE_REQUIRED",
          "The local pending inventory exceeds the bounded lookup. Supply the exact --target and --entry instead.",
        ),
      )
    for (const key of keys.length > 1000 ? [] : keys) {
      const envelope = property(yield* store.readJson(key, Schema.Unknown))
      if (envelope.scope !== scope || property(envelope.plan).operation_id !== input.operationId)
        continue
      if (
        typeof envelope.library_id !== "string" ||
        typeof envelope.skill_id !== "string" ||
        typeof envelope.skill_page_id !== "string" ||
        pageId(envelope.skill_page_id) !== envelope.skill_page_id
      )
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "The original operation has an invalid local scope."),
        )
      const prefix = yield* sharedPendingObservationPrefix(
        scope,
        envelope.library_id,
        envelope.skill_id,
      )
      const checked = yield* pendingFileOperations({
        prefix,
        scope,
        library_id: envelope.library_id,
        skill_id: envelope.skill_id,
        skill_page_id: envelope.skill_page_id,
      })
      const found = checked.find(
        (value) => value.key === key && value.plan.operation_id === input.operationId,
      )
      if (found === undefined)
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "The original operation is not bound to this journal location."),
        )
      local.push({ plan: yield* validateOriginal(found.plan), library_id: envelope.library_id })
    }
    if (local.some((plan) => canonicalSharedJson(plan) !== canonicalSharedJson(local[0])))
      return yield* Effect.fail(
        fail("OPERATION_ID_COLLISION", "The original operation has conflicting retained intents."),
      )
    const original = local[0]?.plan
    if (selected !== undefined && original !== undefined && original.skill_page_id !== selected)
      return yield* Effect.fail(
        fail("OPERATION_SCOPE_MISMATCH", "The original operation belongs to another exact Skill."),
      )
    const selectedEntry =
      input.entry === undefined ? resolved?.entry : yield* databaseId(input.entry)
    const library =
      selectedEntry === undefined ? undefined : yield* loadSharedLibrary(selectedEntry)
    if (
      library !== undefined &&
      original !== undefined &&
      local[0]!.library_id !== library.library_id
    )
      return yield* Effect.fail(
        fail(
          "OPERATION_SCOPE_MISMATCH",
          "The original operation belongs to another exact library.",
        ),
      )
    if (original !== undefined)
      return {
        plan: original,
        library,
        library_id: local[0]!.library_id,
        evidence: "original_local_dispatch_intent" as const,
      }
    if (selected === undefined)
      return yield* Effect.fail(
        fail(
          "OPERATION_CONTEXT_REQUIRED",
          "No exact local intent was found. Supply --target PAGE and --entry LIBRARY to inspect its original shared record; nothing was replayed.",
          {
            operation_id: input.operationId,
            next: { argv: ["ntn-skills", "ctl", "operation", "show", "--help"], read_only: true },
          },
        ),
      )
    const originalLibrary =
      library ?? (yield* loadSharedLibrary((yield* resolveSharedMaintenanceTarget(selected)).entry))
    const records = yield* querySharedRecords(originalLibrary, {
      skillPageId: selected,
      kind: "operation",
      recordId: input.operationId,
      payloadContainsBody: true,
    })
    const record = records[0]
    if (records.length !== 1 || record === undefined)
      return yield* Effect.fail(
        fail(
          "OPERATION_NOT_FOUND",
          "The exact original shared operation is unavailable. Its absence does not authorize recreating it.",
        ),
      )
    const plan = yield* validateOriginal(record.payload)
    const entity =
      plan.kind === "skill_apply"
        ? sharedSkillApplyPlansEntity
        : plan.kind === "metadata_write"
          ? sharedMetadataEntity
          : plan.kind === "native_adoption"
            ? nativeAdoptionEntity
            : plan.file_id
    if (
      plan.operation_id !== input.operationId ||
      record.operation_id !== input.operationId ||
      record.entity_id !== entity ||
      ("library_id" in plan && plan.library_id !== originalLibrary.library_id) ||
      plan.skill_page_id !== selected ||
      record.skill_page_id !== selected
    )
      return yield* Effect.fail(
        fail(
          "OPERATION_SCOPE_MISMATCH",
          "The original fact does not match the requested operation and owner.",
        ),
      )
    return {
      plan,
      library: originalLibrary,
      library_id: originalLibrary.library_id,
      evidence: "original_shared_intent" as const,
    }
  })
}

export const listSharedMaintenanceOperations = Effect.gen(function* () {
  const store = yield* Store
  const keys = yield* store.listKeys("operations/shared-observation-pending/")
  if (!keys.length)
    return {
      operations: [],
      count: 0,
      coverage: {
        scope: "current_credential_local_pending" as const,
        complete: true,
        remote_history: "not_scanned" as const,
      },
    }
  const scope = yield* authScope
  const visited = new Set<string>(),
    operations = []
  for (const key of keys.slice(0, 1000)) {
    const envelope = property(yield* store.readJson(key, Schema.Unknown))
    if (envelope.scope !== scope) continue
    if (
      typeof envelope.library_id !== "string" ||
      typeof envelope.skill_id !== "string" ||
      typeof envelope.skill_page_id !== "string" ||
      pageId(envelope.skill_page_id) !== envelope.skill_page_id
    )
      return yield* Effect.fail(
        fail("STATE_CORRUPT", "A current-scope pending operation has invalid ownership."),
      )
    const prefix = yield* sharedPendingObservationPrefix(
      scope,
      envelope.library_id,
      envelope.skill_id,
    )
    if (visited.has(prefix)) continue
    visited.add(prefix)
    for (const { plan } of yield* pendingFileOperations({
      prefix,
      scope,
      library_id: envelope.library_id,
      skill_id: envelope.skill_id,
      skill_page_id: envelope.skill_page_id,
    })) {
      operations.push({
        domain: "shared_maintenance" as const,
        family: plan.kind,
        operation_id: plan.operation_id,
        target: {
          page_id: plan.skill_page_id,
          library_id: envelope.library_id,
          file_id: plan.file_id,
        },
        verified: false,
        state: "original_intent_recorded" as const,
        remote_writes: 0,
        next: {
          argv: ["ntn-skills", "ctl", "operation", "show", plan.operation_id],
          read_only: true,
          reason: "Inspect this original intent before taking its family's next action.",
        },
      })
    }
  }
  return {
    operations,
    count: operations.length,
    coverage: {
      scope: "current_credential_local_pending" as const,
      complete: keys.length <= 1000,
      remote_history: "not_scanned" as const,
    },
  }
}).pipe(withReadOnlyNotion)

function contextArgv(input: SharedMaintenanceSelection, target: string) {
  return ["--target", target, ...(input.entry === undefined ? [] : ["--entry", input.entry])]
}

export function showSharedMaintenanceOperation(input: SharedMaintenanceSelection) {
  return Effect.gen(function* () {
    const { plan, library, library_id, evidence } = yield* selectedOriginal(input)
    return {
      domain: "shared_maintenance" as const,
      family: plan.kind,
      operation_id: plan.operation_id,
      target: { page_id: plan.skill_page_id, library_id, file_id: plan.file_id },
      state: "original_intent_recorded" as const,
      verified: false,
      resume_supported: false,
      coverage: { original_intent: evidence, terminal_outcome: "not_checked" as const },
      remote_writes: 0,
      next: {
        argv: [
          "ntn-skills",
          "ctl",
          "operation",
          "reconcile",
          plan.operation_id,
          ...contextArgv(
            { ...input, entry: library?.skills.database_id ?? input.entry },
            plan.skill_page_id,
          ),
        ],
        read_only: true,
        reason:
          "Observe the original outcome at its exact page. This does not replay a write or complete an unsent suffix.",
      },
    }
  }).pipe(withReadOnlyNotion)
}

export function reconcileSharedMaintenanceOperation(input: SharedMaintenanceSelection) {
  return Effect.gen(function* () {
    const { plan, library: selected, library_id } = yield* selectedOriginal(input)
    const library =
      selected ??
      (plan.kind === "native_adoption"
        ? plan.library
        : yield* loadSharedLibrary(
            (yield* resolveSharedMaintenanceTarget(plan.skill_page_id)).entry,
          ))
    if (library.library_id !== library_id)
      return yield* Effect.fail(
        fail(
          "OPERATION_SCOPE_MISMATCH",
          "The original operation no longer belongs to this exact page's library.",
        ),
      )
    const result = yield* withSharedAuthoringTarget(
      plan.skill_page_id,
      Effect.gen(function* () {
        switch (plan.kind) {
          case "body_write":
            return yield* reconcileSharedBodyWrite(library, plan)
          case "metadata_write":
            return yield* reconcileSharedMetadataWrite(library, plan)
          case "file_management":
            return yield* reconcileSharedFileManagement(library, plan)
          case "skill_apply":
            return yield* reconcileSharedSkillApply(library, plan)
          case "native_adoption":
            return yield* reconcileSharedNativeAdoption(plan)
          case "resource_authoring":
            return yield* reconcileSharedResourceAuthoring(library, plan)
          case "body_write_review":
            return yield* reconcileSharedBodyWriteReview(library, plan)
          case "file_observation": {
            const verified = yield* reconcileSharedObservation(library, plan)
            return {
              status: "observed" as const,
              verified: true,
              operation_id: verified.operation_id,
              verification: "exact_original_observation_facts" as const,
              event_id: verified.event.event_id,
            }
          }
        }
      }),
    )
    return {
      domain: "shared_maintenance" as const,
      family: plan.kind,
      operation_id: plan.operation_id,
      target: { page_id: plan.skill_page_id, library_id, file_id: plan.file_id },
      state: result.status,
      verified: result.verified,
      result,
      remote_writes: 0,
      next: {
        argv: [
          "ntn-skills",
          "ctl",
          "operation",
          "show",
          plan.operation_id,
          "--target",
          plan.skill_page_id,
          "--entry",
          library.skills.database_id,
        ],
        read_only: true,
        reason:
          "The family's verified result describes the original attempt. It does not authorize replay or a replacement operation.",
      },
    }
  }).pipe(withReadOnlyNotion)
}

/** Explicit continuation, never part of a read-only inspection. */
export function resumeSharedMaintenanceOperation(input: SharedMaintenanceSelection) {
  return Effect.gen(function* () {
    const { plan, library: selected, library_id } = yield* selectedOriginal(input)
    if (plan.kind !== "skill_apply")
      return yield* Effect.fail(
        fail(
          "OPERATION_RESUME_UNSUPPORTED",
          "Only an original apply has a guarded unsent suffix here; use the family's original recovery command.",
          {
            next: {
              argv: [
                "ntn-skills",
                "ctl",
                "operation",
                "show",
                plan.operation_id,
                ...contextArgv(input, plan.skill_page_id),
              ],
              read_only: true,
            },
          },
        ),
      )
    const library =
      selected ??
      (yield* loadSharedLibrary((yield* resolveSharedMaintenanceTarget(plan.skill_page_id)).entry))
    if (library.library_id !== library_id)
      return yield* Effect.fail(
        fail("OPERATION_SCOPE_MISMATCH", "The original parent belongs to another library."),
      )
    const result = yield* withSharedAuthoringTarget(
      plan.skill_page_id,
      resumeSharedSkillApply(library, plan),
    )
    return {
      domain: "shared_maintenance" as const,
      family: plan.kind,
      operation_id: plan.operation_id,
      state: result.status,
      verified: result.verified,
      result,
      next: {
        argv: [
          "ntn-skills",
          "read",
          plan.skill_page_id,
          "--database",
          library.skills.database_id,
          "--authoring",
          "--read-only",
        ],
        read_only: true,
        reason:
          "Inspect the complete current tree after the original operation reaches its verified result.",
      },
    }
  })
}
