import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { fail, type SkillsError } from "./model.ts"
import { Store, sha256 } from "./store.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { appendSharedRecord, canonicalSharedJson, querySharedRecords } from "./shared-records.ts"
import { storedSharedOperationPlan } from "./shared-plan-storage.ts"
import { querySharedOperationIndex } from "./shared-operation-index.ts"
import { validateSharedBodyWritePlan } from "./shared-body-write-model.ts"
import { executeSharedBodyWrite, reconcileSharedBodyWrite } from "./shared-body-write.ts"
import { reconcileSharedFileManagement } from "./shared-file-management.ts"
import { validateSharedFileManagementPlan } from "./shared-file-management-model.ts"
import {
  pendingFileOperations,
  pendingFileOperationKey,
  sharedPendingObservationPrefix,
} from "./shared-pending-file-operations.ts"
import {
  applyChecked,
  bindSharedApplyBody,
  type SharedApplyBodyBinding,
  type SharedSkillApplyChild,
  type SharedSkillApplyPlan,
} from "./shared-skill-apply-model.ts"

const entity = "apply-body-bindings-v1"
const BindingSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("apply_body_binding_record"),
  intent_sha256: Schema.String,
  bindings: Schema.Array(Schema.Struct({ page_id: Schema.String, path: Schema.String })),
  body_plan: Schema.Unknown,
})
const OutcomeSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("apply_body_binding_outcome"),
  operation_id: Schema.String,
  body_operation_id: Schema.String,
  body_plan_hash: Schema.String,
  body_outcome_hash: Schema.String,
  status: Schema.Literals(["applied", "not_applied"]),
})

export function loadSharedApplyBodyBinding(library: SharedLibrary, child: SharedApplyBodyBinding) {
  return Effect.gen(function* () {
    const records = yield* querySharedRecords(library, {
      skillPageId: child.skill_page_id,
      kind: "operation",
      entityId: entity,
      recordId: child.operation_id,
      payloadContainsBody: true,
    })
    const record = records[0]
    if (records.length !== 1 || record === undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_BINDING_UNRESOLVED",
          "The original native binding is unavailable. An absent query result is not permission to bind or write again.",
          { child_operation_id: child.operation_id },
        ),
      )
    const value = yield* applyChecked(() =>
      Schema.decodeUnknownSync(BindingSchema)(record.payload, { onExcessProperty: "error" }),
    )
    const actual = yield* validateSharedBodyWritePlan(value.body_plan)
    for (const allocation of child.allocations) {
      const originals = yield* querySharedRecords(library, {
        skillPageId: child.skill_page_id,
        kind: "operation",
        recordId: allocation.operation_id,
        payloadContainsBody: true,
      })
      if (originals.length !== 1 || originals[0] === undefined)
        return yield* Effect.fail(
          fail(
            "SHARED_APPLY_BINDING_UNRESOLVED",
            "The exact original reference allocation is unavailable; a saved URL cannot replace its evidence.",
          ),
        )
      const original = yield* validateSharedFileManagementPlan(originals[0].payload)
      if (
        original.operation_id !== allocation.operation_id ||
        original.action !== "add" ||
        original.file_id !== allocation.file_id ||
        original.path !== allocation.path ||
        original.library_id !== child.library_id ||
        original.skill_id !== child.skill_id ||
        original.skill_page_id !== child.skill_page_id
      )
        return yield* Effect.fail(
          fail(
            "SHARED_APPLY_INVALID",
            "The saved reference binding does not match its original allocation intent.",
          ),
        )
      const outcome = yield* reconcileSharedFileManagement(library, original)
      if (
        outcome.status !== "applied" ||
        !value.bindings.some(
          (bound) => bound.path === allocation.path && bound.page_id === outcome.page_id,
        )
      )
        return yield* Effect.fail(
          fail(
            "SHARED_APPLY_BINDING_UNRESOLVED",
            "The saved reference page differs from its verified original allocation outcome.",
          ),
        )
    }
    const expectedPaths = [
      ...child.existing_bindings.map((item) => item.path),
      ...child.allocations.map((item) => item.path),
    ].sort()
    if (
      value.intent_sha256 !== (yield* sha256(canonicalSharedJson(child))) ||
      canonicalSharedJson(value.bindings.map((item) => item.path).sort()) !==
        canonicalSharedJson(expectedPaths) ||
      new Set(value.bindings.map((item) => item.page_id)).size !== value.bindings.length ||
      child.existing_bindings.some(
        (item) =>
          !value.bindings.some(
            (bound) => bound.page_id === item.page_id && bound.path === item.path,
          ),
      ) ||
      canonicalSharedJson(yield* bindSharedApplyBody(child, value.bindings)) !==
        canonicalSharedJson(actual)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_INVALID",
          "The retained binding does not reproduce this exact logical intent and original body preimage.",
        ),
      )
    return { value, actual }
  })
}

export function reconcileSharedApplyBodyBinding(
  library: SharedLibrary,
  child: SharedApplyBodyBinding,
) {
  return Effect.gen(function* () {
    const { actual } = yield* loadSharedApplyBodyBinding(library, child)
    const result = yield* reconcileSharedBodyWrite(library, actual)
    const rows = yield* querySharedRecords(library, {
      skillPageId: child.skill_page_id,
      kind: "operation",
      entityId: entity,
      recordId: `outcome-${child.operation_id}`,
    })
    if (rows.length !== 1 || rows[0] === undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_BINDING_UNRESOLVED",
          "The bound body has original evidence, but the binding completion is not retained. Resume the original parent to settle that evidence without replaying its body.",
          { child_operation_id: child.operation_id, body_write_operation_id: actual.operation_id },
        ),
      )
    const saved = yield* applyChecked(() =>
      Schema.decodeUnknownSync(OutcomeSchema)(rows[0]!.payload, { onExcessProperty: "error" }),
    )
    const headers = yield* querySharedOperationIndex(library, child.skill_page_id)
    if (
      saved.operation_id !== child.operation_id ||
      saved.body_operation_id !== actual.operation_id ||
      saved.status !== (result.status === "applied" ? "applied" : "not_applied") ||
      headers.find((item) => item.record_id === actual.operation_id)?.hash !==
        saved.body_plan_hash ||
      headers.find((item) => item.record_id === `outcome-${actual.operation_id}`)?.hash !==
        saved.body_outcome_hash
    )
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_INVALID",
          "The binding result differs from its exact original body operation and outcome.",
        ),
      )
    const scope = yield* authScope
    const prefix = yield* sharedPendingObservationPrefix(scope, child.library_id, child.skill_id)
    yield* (yield* Store).retireKeys([yield* pendingFileOperationKey(prefix, actual)])
    return {
      status: saved.status,
      operation_id: child.operation_id,
      body_operation_id: actual.operation_id,
    }
  })
}

/** Allocate first, retain one exact binding, then use the original whole-body writer. */
export function executeSharedApplyBodyBinding<R>(
  library: SharedLibrary,
  parent: SharedSkillApplyPlan,
  child: SharedApplyBodyBinding,
  before: (plan: SharedSkillApplyChild) => Effect.Effect<void, SkillsError, R>,
  resume = false,
) {
  return Effect.gen(function* () {
    if (
      parent.version !== 2 ||
      !parent.deferred_bodies?.some(
        (value) => canonicalSharedJson(value) === canonicalSharedJson(child),
      )
    )
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_INVALID",
          "The native binding must belong to its exact retained parent.",
        ),
      )
    const headers = yield* querySharedOperationIndex(library, child.skill_page_id)
    if (headers.some((item) => item.record_id === `outcome-${child.operation_id}`))
      return yield* reconcileSharedApplyBodyBinding(library, child)
    let actual
    if (resume || headers.some((item) => item.record_id === child.operation_id)) {
      actual = (yield* loadSharedApplyBodyBinding(library, child)).actual
    } else {
      const bindings = [...child.existing_bindings]
      for (const allocation of child.allocations) {
        const plan = parent.layout.find((item) => item.operation_id === allocation.operation_id)
        if (
          plan?.action !== "add" ||
          plan.file_id !== allocation.file_id ||
          plan.path !== allocation.path
        )
          return yield* Effect.fail(
            fail("SHARED_APPLY_INVALID", "The deferred reference has no original allocation."),
          )
        const result = yield* reconcileSharedFileManagement(library, plan)
        if (result.status !== "applied" || typeof result.page_id !== "string")
          return yield* Effect.fail(
            fail(
              "SHARED_APPLY_BINDING_UNRESOLVED",
              "A reference needs its verified original allocation outcome before native binding.",
            ),
          )
        bindings.push({ page_id: result.page_id, path: allocation.path })
      }
      actual = yield* bindSharedApplyBody(child, bindings)
      yield* before(child)
      yield* appendSharedRecord(library, {
        mode: "create",
        recordId: child.operation_id,
        operationId: child.operation_id,
        skillPageId: child.skill_page_id,
        kind: "operation",
        entityId: entity,
        payload: {
          version: 1,
          kind: "apply_body_binding_record",
          intent_sha256: yield* sha256(canonicalSharedJson(child)),
          bindings,
          body_plan: storedSharedOperationPlan(actual),
        },
        payloadContainsBody: true,
      })
    }
    const scope = yield* authScope
    const local = yield* pendingFileOperations({
      prefix: yield* sharedPendingObservationPrefix(scope, child.library_id, child.skill_id),
      scope,
      library_id: child.library_id,
      skill_id: child.skill_id,
      skill_page_id: child.skill_page_id,
    })
    const original = local.find((item) => item.plan.operation_id === actual.operation_id)
    const bodyHeaders = yield* querySharedOperationIndex(library, child.skill_page_id)
    const attempted =
      original !== undefined || bodyHeaders.some((item) => item.record_id === actual.operation_id)
    if (!attempted && !local.some((item) => item.plan.operation_id === child.operation_id))
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_UNSENT_PROOF_UNAVAILABLE",
          "The original local binding journal is required to dispatch its provably unissued body.",
        ),
      )
    const result = attempted
      ? yield* reconcileSharedBodyWrite(library, actual)
      : yield* executeSharedBodyWrite(library, {
          plan: actual,
          mode: "create",
          beforePlanWrite: before,
        })
    if (result.status === "unchanged")
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_BINDING_UNRESOLVED",
          "The bound operation returned no original write evidence; do not manufacture an applied parent.",
        ),
      )
    const completedHeaders = yield* querySharedOperationIndex(library, child.skill_page_id)
    const bodyPlan = completedHeaders.find((item) => item.record_id === actual.operation_id)
    const bodyOutcome = completedHeaders.find(
      (item) => item.record_id === `outcome-${actual.operation_id}`,
    )
    if (bodyPlan === undefined || bodyOutcome === undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_BINDING_UNRESOLVED",
          "The original bound body requires its exact plan and outcome before publishing binding completion.",
        ),
      )
    const status = result.status === "applied" ? ("applied" as const) : ("not_applied" as const)
    yield* appendSharedRecord(library, {
      mode: "create",
      recordId: `outcome-${child.operation_id}`,
      operationId: child.operation_id,
      skillPageId: child.skill_page_id,
      kind: "operation",
      entityId: entity,
      payload: {
        version: 1,
        kind: "apply_body_binding_outcome",
        operation_id: child.operation_id,
        body_operation_id: actual.operation_id,
        body_plan_hash: bodyPlan.hash,
        body_outcome_hash: bodyOutcome.hash,
        status,
      },
    })
    const prefix = yield* sharedPendingObservationPrefix(scope, child.library_id, child.skill_id)
    yield* (yield* Store).retireKeys([yield* pendingFileOperationKey(prefix, actual)])
    return { status, operation_id: child.operation_id, body_operation_id: actual.operation_id }
  })
}
