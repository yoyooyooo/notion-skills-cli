import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { invalidateSnapshotCache } from "./cache.ts"
import { fail, property, type SkillsError } from "./model.ts"
import { withNotionRequestAttribution } from "./notion.ts"
import { sharedSkillId } from "./shared-content.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { executeSharedBodyWrite, reconcileSharedBodyWrite } from "./shared-body-write.ts"
import {
  executeSharedMetadataWrite,
  reconcileSharedMetadataWrite,
} from "./shared-metadata-write.ts"
import { querySharedOperationIndex, type SharedOperationHeader } from "./shared-operation-index.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  type SharedRecord,
} from "./shared-records.ts"
import {
  pendingFileOperations,
  pendingFileOperationKey,
  retainPendingFileOperation,
  sharedPendingObservationPrefix,
  type SharedPendingFileScope,
} from "./shared-pending-file-operations.ts"
import { querySharedSkillIndex } from "./shared-skill-index.ts"
import { sha256, Store } from "./store.ts"
import {
  applyChecked,
  sharedSkillApplyChildren,
  sharedSkillApplyChildrenHash,
  sharedSkillApplyOutcomeId,
  sharedSkillApplyOutcomesEntity,
  sharedSkillApplyPlansEntity,
  sharedSkillApplyProtection,
  validateSharedSkillApplyPlan,
  type SharedSkillApplyChild,
  type SharedSkillApplyPlan,
} from "./shared-skill-apply-model.ts"

const OutcomeSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("skill_apply_outcome"),
  operation_id: Schema.String,
  status: Schema.Literals(["applied", "partial"]),
  children: Schema.Array(
    Schema.Struct({
      operation_id: Schema.String,
      status: Schema.Literals(["applied", "not_applied", "not_sent"]),
      plan_hash: Schema.optional(Schema.String),
      outcome_hash: Schema.optional(Schema.String),
    }),
  ),
  reason_code: Schema.String,
})
type Outcome = typeof OutcomeSchema.Type

function recovery(
  error: SkillsError,
  plan: SharedSkillApplyPlan,
  stage: string,
  completed: readonly string[] = [],
) {
  return fail(error.code, error.message, {
    ...property(error.details),
    apply_operation_id: plan.operation_id,
    apply_stage: stage,
    completed_child_operations: completed,
    protection: sharedSkillApplyProtection,
    recovery: { version: 1, mode: "reconcile", plan },
    ...(stage === "plan" && error.code === "WRITE_OUTCOME_UNKNOWN"
      ? {
          first_plan_visibility_boundary: true,
          limitation:
            "An empty independent client cannot distinguish an invisible first apply plan from a never-sent operation.",
        }
      : {}),
  })
}

function journalScope(scope: string, plan: SharedSkillApplyPlan) {
  return Effect.gen(function* () {
    return {
      prefix: yield* sharedPendingObservationPrefix(scope, plan.library_id, plan.skill_id),
      scope,
      library_id: plan.library_id,
      skill_id: plan.skill_id,
      skill_page_id: plan.skill_page_id,
    } satisfies SharedPendingFileScope
  })
}

function verifyScope(library: SharedLibrary, plan: SharedSkillApplyPlan) {
  return Effect.gen(function* () {
    const actual = yield* loadSharedLibrary(library.skills.database_id)
    if (
      library.library_id !== plan.library_id ||
      canonicalSharedJson(actual) !== canonicalSharedJson(library)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_SCOPE",
          "The frozen apply belongs to another registered shared library.",
        ),
      )
    const index = yield* querySharedSkillIndex(library, plan.skill_page_id)
    if (index.skill_id !== plan.skill_id || index.main.file_id !== plan.file_id)
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_SCOPE",
          "The original apply no longer has the exact shared Skill identity.",
        ),
      )
  })
}

function originalRecord(
  library: SharedLibrary,
  plan: SharedSkillApplyPlan,
  mode: "create" | "reconcile",
) {
  return appendSharedRecord(library, {
    mode,
    recordId: plan.operation_id,
    operationId: plan.operation_id,
    skillPageId: plan.skill_page_id,
    kind: "operation",
    entityId: sharedSkillApplyPlansEntity,
    payload: plan,
    payloadContainsBody: true,
  }).pipe(Effect.mapError((error) => recovery(error, plan, "plan")))
}

function decodeOutcome(record: SharedRecord) {
  return Effect.gen(function* () {
    const value = yield* applyChecked(() =>
      Schema.decodeUnknownSync(OutcomeSchema)(record.payload, { onExcessProperty: "error" }),
    )
    const expectedHash = sharedSkillApplyChildrenHash(value.operation_id)
    if (
      expectedHash === undefined ||
      record.record_id !== sharedSkillApplyOutcomeId(value.operation_id) ||
      record.operation_id !== value.operation_id ||
      record.entity_id !== sharedSkillApplyOutcomesEntity ||
      value.children.length === 0 ||
      new Set(value.children.map((child) => child.operation_id)).size !== value.children.length ||
      (yield* sha256(canonicalSharedJson(value.children.map((child) => child.operation_id)))) !==
        expectedHash ||
      (value.status === "applied"
        ? value.children.some((child) => child.status !== "applied")
        : value.children.every((child) => child.status === "applied"))
    )
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_INVALID",
          "The shared apply outcome does not identify the exact frozen child sequence.",
        ),
      )
    let stopped = false
    for (const child of value.children) {
      if (
        child.status === "not_sent"
          ? child.plan_hash !== undefined || child.outcome_hash !== undefined
          : child.plan_hash === undefined ||
            child.outcome_hash === undefined ||
            !/^[a-f0-9]{64}$/u.test(child.plan_hash) ||
            !/^[a-f0-9]{64}$/u.test(child.outcome_hash)
      )
        return yield* Effect.fail(
          fail(
            "SHARED_APPLY_INVALID",
            "A completed child requires its exact immutable plan and outcome fingerprints.",
          ),
        )
      if (stopped && child.status !== "not_sent")
        return yield* Effect.fail(
          fail(
            "SHARED_APPLY_INVALID",
            "An apply outcome cannot restart dispatch after its first stopped child.",
          ),
        )
      if (child.status !== "applied") stopped = true
    }
    return value
  })
}

function saveOutcome(
  library: SharedLibrary,
  plan: SharedSkillApplyPlan,
  children: Outcome["children"],
  reason: string,
) {
  return Effect.gen(function* () {
    const headers = yield* withNotionRequestAttribution(
      querySharedOperationIndex(library, plan.skill_page_id),
      { phase: "author_verify" },
    )
    const fingerprints: Outcome["children"][number][] = []
    for (const child of children) {
      if (child.status === "not_sent") {
        fingerprints.push(child)
        continue
      }
      const original = headers.find((header) => header.record_id === child.operation_id)
      const outcome = headers.find((header) => header.record_id === `outcome-${child.operation_id}`)
      if (original === undefined || outcome === undefined)
        return yield* Effect.fail(
          recovery(
            fail(
              "SHARED_APPLY_UNRESOLVED",
              "A verified child no longer has visible immutable plan and outcome evidence; do not publish a parent completion.",
            ),
            plan,
            "outcome",
          ),
        )
      fingerprints.push({ ...child, plan_hash: original.hash, outcome_hash: outcome.hash })
    }
    const value: Outcome = {
      version: 1,
      kind: "skill_apply_outcome",
      operation_id: plan.operation_id,
      status: children.every((child) => child.status === "applied") ? "applied" : "partial",
      children: fingerprints,
      reason_code: reason,
    }
    return yield* appendSharedRecord(library, {
      mode: "create",
      recordId: sharedSkillApplyOutcomeId(plan.operation_id),
      operationId: plan.operation_id,
      skillPageId: plan.skill_page_id,
      kind: "operation",
      entityId: sharedSkillApplyOutcomesEntity,
      payload: value,
    }).pipe(
      Effect.mapError((error) =>
        recovery(
          error,
          plan,
          "outcome",
          children.filter((child) => child.status === "applied").map((child) => child.operation_id),
        ),
      ),
    )
  })
}

function verifyOutcomeHeaders(outcome: Outcome, headers: readonly SharedOperationHeader[]): void {
  for (const child of outcome.children) {
    if (child.status === "not_sent") continue
    const original = headers.find((header) => header.record_id === child.operation_id)
    const completed = headers.find((header) => header.record_id === `outcome-${child.operation_id}`)
    if (original === undefined || completed === undefined)
      throw fail(
        "SHARED_APPLY_UNRESOLVED",
        "A parent completion cannot replace missing original child plan or outcome evidence.",
        { apply_operation_id: outcome.operation_id, child_operation_id: child.operation_id },
      )
    if (original.hash !== child.plan_hash || completed.hash !== child.outcome_hash)
      throw fail(
        "SHARED_RECORD_CONFLICT",
        "An original apply child fact differs from the parent's retained exact evidence.",
        { apply_operation_id: outcome.operation_id, child_operation_id: child.operation_id },
      )
  }
}

function reconcileChild(library: SharedLibrary, child: SharedSkillApplyChild) {
  return child.kind === "body_write"
    ? reconcileSharedBodyWrite(library, child).pipe(
        Effect.map((result) => ({ status: result.status, operation_id: result.operation_id })),
      )
    : reconcileSharedMetadataWrite(library, child).pipe(
        Effect.map((result) => ({ status: result.status, operation_id: result.operation_id })),
      )
}

function allChildrenApplied(library: SharedLibrary, plan: SharedSkillApplyPlan) {
  return Effect.gen(function* () {
    const verified: string[] = []
    for (const child of sharedSkillApplyChildren(plan)) {
      const result = yield* reconcileChild(library, child).pipe(
        Effect.mapError((error) => recovery(error, plan, "child_reconcile", verified)),
      )
      if (result.status !== "applied")
        return yield* Effect.fail(
          recovery(
            fail(
              "SHARED_APPLY_UNRESOLVED",
              "The original apply has no complete terminal outcome and not every original child was applied. No missing child is inferred to be unsent.",
            ),
            plan,
            "children",
            verified,
          ),
        )
      verified.push(child.operation_id)
    }
    return verified
  })
}

function retireVerified(plan: SharedSkillApplyPlan, journal: SharedPendingFileScope) {
  return Effect.gen(function* () {
    yield* invalidateSnapshotCache(sharedSkillId(plan.library_id, plan.skill_id), journal.scope)
    const keys: string[] = [yield* pendingFileOperationKey(journal.prefix, plan)]
    for (const child of sharedSkillApplyChildren(plan))
      keys.push(yield* pendingFileOperationKey(journal.prefix, child))
    yield* (yield* Store).retireKeys(keys)
  })
}

/** Read only: verify original shared evidence; never dispatch a remaining child. */
export function reconcileSharedSkillApply(library: SharedLibrary, input: SharedSkillApplyPlan) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedSkillApplyPlan(input)
    const journal = yield* journalScope(yield* authScope, plan)
    yield* verifyScope(library, plan)
    yield* originalRecord(library, plan, "reconcile")
    const rows = yield* querySharedRecords(library, {
      skillPageId: plan.skill_page_id,
      kind: "operation",
      entityId: sharedSkillApplyOutcomesEntity,
      recordId: sharedSkillApplyOutcomeId(plan.operation_id),
    })
    const saved = rows[0] === undefined ? undefined : yield* decodeOutcome(rows[0])
    if (saved === undefined) {
      const completed = yield* allChildrenApplied(library, plan)
      yield* retireVerified(plan, journal)
      return {
        status: "applied" as const,
        operation_id: plan.operation_id,
        verified: true as const,
        completed_child_operations: completed,
        verification: "exact_child_outcomes" as const,
        requires_fresh_read: true as const,
        protection: sharedSkillApplyProtection,
      }
    }
    const children = sharedSkillApplyChildren(plan)
    if (
      canonicalSharedJson(saved.children.map((child) => child.operation_id)) !==
      canonicalSharedJson(children.map((child) => child.operation_id))
    )
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_INVALID",
          "The original apply outcome differs from its frozen children.",
        ),
      )
    const headers = yield* querySharedOperationIndex(library, plan.skill_page_id)
    yield* applyChecked(() => verifyOutcomeHeaders(saved, headers))
    for (let index = 0; index < saved.children.length; index++) {
      const status = saved.children[index]!.status
      if (status === "not_sent") continue
      const result = yield* reconcileChild(library, children[index]!)
      if (result.status !== (status === "applied" ? "applied" : "not_applied"))
        return yield* Effect.fail(
          recovery(
            fail(
              "SHARED_APPLY_INVALID",
              "A child outcome contradicts the exact original apply completion.",
            ),
            plan,
            "children",
          ),
        )
    }
    yield* retireVerified(plan, journal)
    return {
      status: saved.status,
      operation_id: plan.operation_id,
      verified: true as const,
      completed_child_operations: saved.children
        .filter((child) => child.status === "applied")
        .map((child) => child.operation_id),
      verification: "original_outcome_and_children" as const,
      requires_fresh_read: true as const,
      protection: sharedSkillApplyProtection,
    }
  }).pipe((effect) =>
    withNotionRequestAttribution(effect, {
      phase: "reconcile",
      skill_page_id: input.skill_page_id,
      operation_id: input.operation_id,
    }),
  )
}

export function executeSharedSkillApply(
  library: SharedLibrary,
  input: {
    readonly plan: SharedSkillApplyPlan
    readonly mode: "create" | "reconcile"
    readonly dryRun?: boolean
  },
) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedSkillApplyPlan(input.plan)
    if (input.mode === "reconcile") return yield* reconcileSharedSkillApply(library, plan)
    if (input.mode !== "create")
      return yield* Effect.fail(fail("INVALID_ARGUMENT", "Apply mode must be create or reconcile."))
    const scope = yield* authScope
    if (scope !== plan.snapshot_scope)
      return yield* Effect.fail(
        fail(
          "SNAPSHOT_CONFLICT",
          "The prepared apply belongs to another authenticated snapshot scope.",
        ),
      )
    yield* withNotionRequestAttribution(verifyScope(library, plan), { phase: "author_preflight" })
    const journal = yield* journalScope(scope, plan)
    const local = yield* pendingFileOperations(journal)
    const original = local.find((entry) => entry.plan.operation_id === plan.operation_id)
    if (original !== undefined) {
      if (canonicalSharedJson(original.plan) !== canonicalSharedJson(plan))
        return yield* Effect.fail(
          fail(
            "STATE_CORRUPT",
            "The original apply receipt differs from the requested complete plan.",
          ),
        )
      return yield* reconcileSharedSkillApply(library, plan)
    }
    if (local.length !== 0)
      return yield* Effect.fail(
        fail(
          "SHARED_PENDING_OPERATION",
          "Reconcile original shared operations before a new apply.",
        ),
      )
    const headers = yield* withNotionRequestAttribution(
      querySharedOperationIndex(library, plan.skill_page_id),
      { phase: "author_preflight" },
    )
    if (headers.some((header) => header.record_id === plan.operation_id))
      return yield* reconcileSharedSkillApply(library, plan)
    const pending = yield* withNotionRequestAttribution(
      loadPendingSharedSkillApplies(library, { skillPageId: plan.skill_page_id, headers }),
      { phase: "author_preflight" },
    )
    if (pending.length !== 0)
      return yield* Effect.fail(
        fail("SHARED_APPLY_PENDING", "Reconcile the original shared apply before new intent.", {
          apply_operation_id: pending[0]!.operation_id,
        }),
      )
    if (input.dryRun)
      return {
        status: "planned" as const,
        operation_id: plan.operation_id,
        dry_run: true as const,
        plan,
        protection: sharedSkillApplyProtection,
      }
    yield* retainPendingFileOperation(journal, plan)
    yield* invalidateSnapshotCache(sharedSkillId(plan.library_id, plan.skill_id), scope)
    yield* originalRecord(library, plan, "create")
    const children = sharedSkillApplyChildren(plan)
    const completed: Outcome["children"][number][] = []
    for (let index = 0; index < children.length; index++) {
      const child = children[index]!
      let prepared = false
      const before = (value: SharedSkillApplyChild) =>
        retainPendingFileOperation(journal, value).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              prepared = true
            }),
          ),
        )
      const action =
        child.kind === "body_write"
          ? executeSharedBodyWrite(library, {
              plan: child,
              mode: "create",
              beforePlanWrite: before,
            }).pipe(
              Effect.map((result) => ({
                status: result.status,
                operation_id: result.operation_id,
              })),
            )
          : executeSharedMetadataWrite(library, {
              plan: child,
              mode: "create",
              beforePlanWrite: before,
            }).pipe(
              Effect.map((result) => ({
                status: result.status,
                operation_id: result.operation_id,
              })),
            )
      const result = yield* action.pipe(Effect.result)
      if (result._tag === "Failure") {
        // Unknown stops immediately, including an unknown terminal-fact POST.
        if (result.failure.code === "WRITE_OUTCOME_UNKNOWN")
          return yield* Effect.fail(
            recovery(
              result.failure,
              plan,
              "child",
              completed.map((value) => value.operation_id),
            ),
          )
        let terminal: "not_sent" | "not_applied" | undefined
        const existed = headers.some(
          (header) =>
            header.record_id === child.operation_id ||
            header.record_id === `outcome-${child.operation_id}`,
        )
        const preflightConflict =
          result.failure.code === "SHARED_BODY_WRITE_STALE" ||
          result.failure.code === "WRITE_CONFLICT"
        if (
          !prepared &&
          !existed &&
          preflightConflict &&
          property(result.failure.details).recovery === undefined
        )
          terminal = "not_sent"
        else {
          const recovered = yield* reconcileChild(library, child).pipe(Effect.result)
          if (recovered._tag === "Success" && recovered.success.status === "not_applied")
            terminal = "not_applied"
        }
        if (terminal === undefined)
          return yield* Effect.fail(
            recovery(
              result.failure,
              plan,
              "child",
              completed.map((value) => value.operation_id),
            ),
          )
        const summary: Outcome["children"] = [
          ...completed,
          { operation_id: child.operation_id, status: terminal },
          ...children.slice(index + 1).map((remaining) => ({
            operation_id: remaining.operation_id,
            status: "not_sent" as const,
          })),
        ]
        yield* saveOutcome(library, plan, summary, result.failure.code)
        yield* retireVerified(plan, journal)
        return yield* Effect.fail(
          recovery(
            fail(
              "SHARED_APPLY_PARTIAL",
              "The sequential apply stopped at a verified failure. Earlier completed edits remain; the exact remaining intent is retained. Read the current Skill before preparing a new apply.",
              { cause_code: result.failure.code, children: summary, requires_fresh_read: true },
            ),
            plan,
            "partial",
            completed.map((value) => value.operation_id),
          ),
        )
      }
      if (result.success.status !== "applied")
        return yield* Effect.fail(
          recovery(
            fail(
              "SHARED_APPLY_UNRESOLVED",
              "The original child did not return an exact applied outcome; stop without dispatching another child.",
            ),
            plan,
            "child",
            completed.map((value) => value.operation_id),
          ),
        )
      completed.push({ operation_id: child.operation_id, status: "applied" })
    }
    yield* saveOutcome(library, plan, completed, "ALL_ORIGINAL_CHILDREN_VERIFIED")
    yield* retireVerified(plan, journal)
    return {
      status: "applied" as const,
      operation_id: plan.operation_id,
      verified: true as const,
      completed_child_operations: completed.map((child) => child.operation_id),
      requires_fresh_read: true as const,
      protection: sharedSkillApplyProtection,
    }
  }).pipe((effect) =>
    withNotionRequestAttribution(effect, {
      phase: "author_apply",
      skill_page_id: input.plan.skill_page_id,
      operation_id: input.plan.operation_id,
    }),
  )
}

/** Completed batches scan only compact headers and small outcomes. */
export function loadPendingSharedSkillApplies(
  library: SharedLibrary,
  input: { readonly skillPageId: string; readonly headers?: readonly SharedOperationHeader[] },
) {
  return Effect.gen(function* () {
    const headers = input.headers ?? (yield* querySharedOperationIndex(library, input.skillPageId))
    const candidates = headers.filter((header) => header.entity_id === sharedSkillApplyPlansEntity)
    if (candidates.length === 0) return [] as readonly SharedSkillApplyPlan[]
    const outcomes = new Map<string, Outcome>()
    if (headers.some((header) => header.entity_id === sharedSkillApplyOutcomesEntity)) {
      for (const row of yield* querySharedRecords(library, {
        skillPageId: input.skillPageId,
        kind: "operation",
        entityId: sharedSkillApplyOutcomesEntity,
      })) {
        const outcome = yield* decodeOutcome(row)
        const header = headers.find((entry) => entry.record_id === row.record_id)
        if (header !== undefined && header.hash !== row.hash)
          return yield* Effect.fail(
            fail(
              "SHARED_RECORD_CONFLICT",
              "A shared apply outcome changed across the exact compact index.",
            ),
          )
        outcomes.set(outcome.operation_id, outcome)
      }
    }
    const pending: SharedSkillApplyPlan[] = []
    for (const header of candidates) {
      if (sharedSkillApplyChildrenHash(header.record_id) === undefined)
        return yield* Effect.fail(
          fail(
            "SHARED_APPLY_INVALID",
            "An apply-plan index entry has an invalid original identity.",
          ),
        )
      const completed = outcomes.get(header.record_id)
      if (completed !== undefined) {
        yield* applyChecked(() => verifyOutcomeHeaders(completed, headers))
        continue
      }
      const rows = yield* querySharedRecords(library, {
        skillPageId: input.skillPageId,
        kind: "operation",
        entityId: sharedSkillApplyPlansEntity,
        recordId: header.record_id,
        payloadContainsBody: true,
      })
      const row = rows[0]
      if (row === undefined || row.hash !== header.hash || row.operation_id !== header.record_id)
        return yield* Effect.fail(
          fail(
            "SHARED_APPLY_UNRESOLVED",
            "The indexed original apply plan is unavailable or changed; do not replace its intent.",
          ),
        )
      const plan = yield* validateSharedSkillApplyPlan(row.payload)
      if (
        plan.operation_id !== header.record_id ||
        plan.library_id !== library.library_id ||
        plan.skill_page_id !== input.skillPageId
      )
        return yield* Effect.fail(
          fail("SHARED_APPLY_SCOPE", "The original shared apply belongs to another Skill."),
        )
      // A lost final POST does not invalidate independently visible, exact
      // applied child outcomes. This path is read-only and never fills a gap.
      const complete = yield* allChildrenApplied(library, plan).pipe(Effect.result)
      if (complete._tag === "Failure") pending.push(plan)
    }
    return pending
  })
}
