import { Clock, Crypto, Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { invalidateSnapshotCache } from "./cache.ts"
import { fail, property, SkillsError, text, type SharedSkillRecord } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { sharedRecordFromPage, sharedSkillProperty } from "./shared-content.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { querySharedOperationIndex, type SharedOperationHeader } from "./shared-operation-index.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  type SharedRecord,
} from "./shared-records.ts"
import { completeSharedRouterMemberIds, querySharedRouterMembers } from "./shared-router-members.ts"
import {
  pendingFileOperations,
  pendingFileOperationKey,
  retainPendingFileOperation,
  sharedPendingObservationPrefix,
} from "./shared-pending-file-operations.ts"
import { Store } from "./store.ts"
import {
  makeSharedMetadataWritePlan,
  metadataChecked,
  sharedMetadataEntity,
  sharedMetadataOutcomeId,
  sharedMetadataWriteProtection,
  validateMetadataValue,
  validateSharedMetadataWritePlan,
  type SharedMetadataChange,
  type SharedMetadataField,
  type SharedMetadataValue,
  type SharedMetadataWritePlan,
} from "./shared-metadata-write-model.ts"

export {
  SharedMetadataWritePlanSchema,
  sharedMetadataWriteProtection,
  validateSharedMetadataWritePlan,
  type SharedMetadataChange,
  type SharedMetadataField,
  type SharedMetadataValue,
  type SharedMetadataWritePlan,
} from "./shared-metadata-write-model.ts"

const OutcomeSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("metadata_write_outcome"),
  operation_id: Schema.String,
  status: Schema.Literals(["applied", "not_sent", "rejected", "needs_review"]),
  reason_code: Schema.String,
  observed: Schema.optional(
    Schema.Array(Schema.Struct({ field: Schema.String, value: Schema.Unknown })),
  ),
})
type Outcome = typeof OutcomeSchema.Type

function source(library: SharedLibrary) {
  return {
    alias: library.library_id,
    database_id: library.skills.database_id,
    data_source_ids: [library.skills.data_source_id],
    title: "",
    role: "content" as const,
    shared_library: library,
  }
}

function decodePage(library: SharedLibrary, raw: unknown, selected: string) {
  const record = sharedRecordFromPage(raw, source(library), library.skills.data_source_id)
  if (record.locator.page_id !== selected || !record.enabled)
    throw fail(
      "SHARED_METADATA_WRITE_SCOPE",
      "The selected enabled Skill is unavailable in this shared library.",
    )
  const file = sharedSkillProperty(raw, library, "Main File ID")
  if (file.type !== "rich_text" || !Array.isArray(file.rich_text) || file.has_more === true)
    throw fail(
      "SHARED_METADATA_WRITE_SCOPE",
      "The shared Skill has no complete main file identity.",
    )
  const fileId = text(file.rich_text)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(fileId))
    throw fail("SHARED_METADATA_WRITE_SCOPE", "The shared Skill has an invalid main file identity.")
  return { record, file_id: fileId }
}

function readValue(
  library: SharedLibrary,
  raw: unknown,
  record: SharedSkillRecord,
  field: SharedMetadataField,
) {
  return Effect.gen(function* () {
    const value = yield* metadataChecked(() => sharedSkillProperty(raw, library, field))
    if (field === "Members")
      return (yield* completeSharedRouterMemberIds(library, record, raw)).sort()
    return yield* metadataChecked(() => {
      if (field === "Default Context") {
        if (value.type !== "checkbox" || typeof value.checkbox !== "boolean")
          throw fail(
            "SHARED_METADATA_WRITE_INVALID",
            "Default Context is not a complete native checkbox.",
          )
        return value.checkbox
      }
      const kind = field === "Name" ? "title" : "rich_text"
      if (value.type !== kind || !Array.isArray(value[kind]) || value.has_more === true)
        throw fail(
          "SHARED_METADATA_WRITE_INVALID",
          "A selected native text property is incomplete.",
        )
      return validateMetadataValue(field, text(value[kind]))
    })
  })
}

function observedValues(
  library: SharedLibrary,
  raw: unknown,
  record: SharedSkillRecord,
  fields: readonly SharedMetadataField[],
) {
  return Effect.gen(function* () {
    const result: Array<{
      readonly field: SharedMetadataField
      readonly value: SharedMetadataValue
    }> = []
    for (const field of fields)
      result.push({ field, value: yield* readValue(library, raw, record, field) })
    return result
  })
}

function verifyRequestedMembers(
  library: SharedLibrary,
  raw: unknown,
  record: SharedSkillRecord,
  values: readonly SharedMetadataChange[],
) {
  return Effect.gen(function* () {
    const members = values.find((change) => change.field === "Members")
    if (members === undefined) return
    if (record.kind !== "router" || !Array.isArray(members.value))
      return yield* Effect.fail(
        fail("INVALID_MEMBERS", "Only a Router may explicitly update native Members."),
      )
    const propertyId = library.skills.property_ids.Members
    if (propertyId === undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_ROUTER_MEMBERS_UNAVAILABLE",
          "Register the native Members relation before updating it.",
        ),
      )
    const properties = Object.fromEntries(
      Object.entries(property(property(raw).properties)).filter(
        ([key, value]) => key !== propertyId && property(value).id !== propertyId,
      ),
    )
    const candidate = {
      ...property(raw),
      properties: {
        ...properties,
        [propertyId]: {
          id: propertyId,
          type: "relation",
          relation: members.value.map((id) => ({ id })),
          has_more: false,
        },
      },
    }
    yield* querySharedRouterMembers(library, { router: record, rawPage: candidate })
  })
}

export function prepareSharedMetadataWrite(input: {
  readonly library: SharedLibrary
  readonly skillPageId: string
  readonly changes: readonly SharedMetadataChange[]
  readonly expected?: {
    readonly record_id?: string
    readonly values?: readonly SharedMetadataChange[]
  }
}) {
  return Effect.gen(function* () {
    const changes = yield* metadataChecked(() => {
      if (
        pageId(input.skillPageId) !== input.skillPageId ||
        input.changes.length === 0 ||
        new Set(input.changes.map((change) => change.field)).size !== input.changes.length
      )
        throw fail(
          "INVALID_ARGUMENT",
          "Choose one exact Skill and each requested metadata field once.",
        )
      return input.changes
        .map((change) => ({
          field: change.field,
          value: validateMetadataValue(change.field, change.value),
        }))
        .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0))
    })
    const raw = yield* (yield* Notion).request(`v1/pages/${input.skillPageId}`)
    const current = yield* metadataChecked(() => decodePage(input.library, raw, input.skillPageId))
    if (input.expected?.record_id !== undefined && input.expected.record_id !== current.record.id)
      return yield* Effect.fail(
        fail(
          "WRITE_CONFLICT",
          "The selected Skill identity differs from the expected metadata baseline.",
        ),
      )
    for (const expected of input.expected?.values ?? []) {
      const actual = yield* readValue(input.library, raw, current.record, expected.field)
      if (
        canonicalSharedJson(actual) !==
        canonicalSharedJson(validateMetadataValue(expected.field, expected.value))
      )
        return yield* Effect.fail(
          fail(
            "WRITE_CONFLICT",
            "A selected native property changed before metadata preparation.",
            { field: expected.field },
          ),
        )
    }
    yield* verifyRequestedMembers(input.library, raw, current.record, changes)
    const frozen: SharedMetadataWritePlan["changes"][number][] = []
    for (const change of changes) {
      const propertyId = input.library.skills.property_ids[change.field]
      if (propertyId === undefined)
        return yield* Effect.fail(
          fail(
            "SHARED_METADATA_WRITE_INVALID",
            "The requested property has no registered stable identity.",
            { field: change.field },
          ),
        )
      frozen.push({
        field: change.field,
        property_id: propertyId,
        before: yield* readValue(input.library, raw, current.record, change.field),
        after: change.value,
      })
    }
    return yield* makeSharedMetadataWritePlan({
      library_id: input.library.library_id,
      skill_id: current.record.locator.skill_id,
      skill_page_id: input.skillPageId,
      file_id: current.file_id,
      page_id: input.skillPageId,
      record_id: current.record.id,
      observed_at: yield* Clock.currentTimeMillis,
      changes: frozen,
    })
  })
}

function recovery(error: SkillsError, plan: SharedMetadataWritePlan, stage: string) {
  return fail(error.code, error.message, {
    ...property(error.details),
    metadata_operation_id: plan.operation_id,
    metadata_stage: stage,
    protection: sharedMetadataWriteProtection,
    recovery: { version: 1, mode: "reconcile", plan },
    ...(stage === "plan" && error.code === "WRITE_OUTCOME_UNKNOWN"
      ? {
          first_plan_visibility_boundary: true,
          limitation:
            "An empty independent client cannot distinguish an invisible first plan from a never-sent operation.",
        }
      : {}),
  })
}

function verifyScope(library: SharedLibrary, plan: SharedMetadataWritePlan) {
  if (
    plan.library_id !== library.library_id ||
    plan.changes.some((change) => library.skills.property_ids[change.field] !== change.property_id)
  )
    throw fail(
      "SHARED_METADATA_WRITE_SCOPE",
      "The original metadata operation belongs to different registered property identities.",
    )
}

function verifyBefore(library: SharedLibrary, plan: SharedMetadataWritePlan) {
  return Effect.gen(function* () {
    const raw = yield* (yield* Notion).request(`v1/pages/${plan.page_id}`)
    const context = yield* metadataChecked(() => decodePage(library, raw, plan.page_id))
    if (context.record.id !== plan.record_id || context.file_id !== plan.file_id)
      return yield* Effect.fail(
        fail("WRITE_CONFLICT", "The original metadata target identity changed."),
      )
    const values = yield* observedValues(
      library,
      raw,
      context.record,
      plan.changes.map((change) => change.field),
    )
    for (const value of values) {
      const frozen = plan.changes.find((change) => change.field === value.field)
      if (!frozen || canonicalSharedJson(value.value) !== canonicalSharedJson(frozen.before))
        return yield* Effect.fail(
          fail("WRITE_CONFLICT", "A requested native property changed before dispatch.", {
            field: value.field,
          }),
        )
    }
    yield* verifyRequestedMembers(
      library,
      raw,
      context.record,
      plan.changes.map((change) => ({ field: change.field, value: change.after })),
    )
    return context
  })
}

function spans(value: string) {
  const characters = Array.from(value)
  const result: Array<{ readonly type: "text"; readonly text: { readonly content: string } }> = []
  for (let offset = 0; offset < characters.length; offset += 2000)
    result.push({
      type: "text",
      text: { content: characters.slice(offset, offset + 2000).join("") },
    })
  return result
}
function patchProperties(plan: SharedMetadataWritePlan) {
  return Object.fromEntries(
    plan.changes.map((change) => {
      const value = change.after
      const native =
        change.field === "Members" && Array.isArray(value)
          ? { relation: value.map((id) => ({ id })) }
          : change.field === "Default Context" && typeof value === "boolean"
            ? { checkbox: value }
            : typeof value === "string" && change.field === "Name"
              ? { title: spans(value) }
              : typeof value === "string"
                ? { rich_text: spans(value) }
                : undefined
      if (native === undefined)
        throw fail(
          "SHARED_METADATA_WRITE_INVALID",
          "A frozen property cannot be encoded without losing its type.",
        )
      return [change.property_id, native]
    }),
  )
}

function decodeOutcome(record: SharedRecord): Outcome {
  const outcome = Schema.decodeUnknownSync(OutcomeSchema)(record.payload, {
    onExcessProperty: "error",
  })
  if (
    !/^metadata-write-[a-f0-9]{64}$/u.test(outcome.operation_id) ||
    record.operation_id !== outcome.operation_id ||
    record.record_id !== sharedMetadataOutcomeId(outcome.operation_id) ||
    record.entity_id !== sharedMetadataEntity
  )
    throw fail(
      "SHARED_METADATA_WRITE_INVALID",
      "A native metadata outcome differs from its exact original operation.",
    )
  return outcome
}

function verifyOutcome(plan: SharedMetadataWritePlan, saved: Outcome) {
  if (
    saved.operation_id !== plan.operation_id ||
    (saved.status === "applied" &&
      canonicalSharedJson(saved.observed) !==
        canonicalSharedJson(
          plan.changes.map((change) => ({ field: change.field, value: change.after })),
        )) ||
    ((saved.status === "not_sent" || saved.status === "rejected") && saved.observed !== undefined)
  )
    throw fail(
      "SHARED_METADATA_WRITE_INVALID",
      "The exact original outcome does not prove this plan's requested native values.",
    )
}

function outcome(
  library: SharedLibrary,
  plan: SharedMetadataWritePlan,
  status: Outcome["status"],
  reasonCode: string,
  observed?: Outcome["observed"],
) {
  return appendSharedRecord(library, {
    mode: "create",
    recordId: sharedMetadataOutcomeId(plan.operation_id),
    operationId: plan.operation_id,
    skillPageId: plan.skill_page_id,
    kind: "operation",
    entityId: sharedMetadataEntity,
    payload: {
      version: 1,
      kind: "metadata_write_outcome",
      operation_id: plan.operation_id,
      status,
      reason_code: reasonCode,
      ...(observed === undefined ? {} : { observed }),
    } satisfies Outcome,
  }).pipe(Effect.mapError((error) => recovery(error, plan, "outcome")))
}

export function reconcileSharedMetadataWrite(
  library: SharedLibrary,
  input: SharedMetadataWritePlan,
) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedMetadataWritePlan(input)
    yield* metadataChecked(() => verifyScope(library, plan))
    yield* appendSharedRecord(library, {
      mode: "reconcile",
      recordId: plan.operation_id,
      operationId: plan.operation_id,
      skillPageId: plan.skill_page_id,
      kind: "operation",
      entityId: sharedMetadataEntity,
      payload: plan,
    }).pipe(Effect.mapError((error) => recovery(error, plan, "plan")))
    const rows = yield* querySharedRecords(library, {
      skillPageId: plan.skill_page_id,
      kind: "operation",
      entityId: sharedMetadataEntity,
      recordId: sharedMetadataOutcomeId(plan.operation_id),
    })
    const saved = rows[0]
    if (saved !== undefined) {
      const result = yield* metadataChecked(() => decodeOutcome(saved))
      yield* metadataChecked(() => verifyOutcome(plan, result))
      if (result.status === "needs_review")
        return yield* Effect.fail(
          recovery(
            fail(
              "SHARED_METADATA_REVIEW_REQUIRED",
              "The original requested property values were not exactly verified; preserve the observed values and do not roll back.",
            ),
            plan,
            "outcome",
          ),
        )
      return {
        status: result.status === "applied" ? ("applied" as const) : ("not_applied" as const),
        operation_id: plan.operation_id,
        verified: true as const,
        requires_fresh_read: true as const,
        protection: sharedMetadataWriteProtection,
      }
    }
    const raw = yield* (yield* Notion).request(`v1/pages/${plan.page_id}`)
    const current = yield* metadataChecked(() => decodePage(library, raw, plan.page_id))
    const values = yield* observedValues(
      library,
      raw,
      current.record,
      plan.changes.map((change) => change.field),
    )
    const equal = (part: "before" | "after") =>
      values.every(
        (value) =>
          canonicalSharedJson(value.value) ===
          canonicalSharedJson(plan.changes.find((change) => change.field === value.field)?.[part]),
      )
    return yield* Effect.fail(
      recovery(
        fail(
          "SHARED_METADATA_WRITE_UNRESOLVED",
          "Current property values cannot prove the original unknown operation completed. Reconcile its original outcome without replaying PATCH.",
          { current_matches_before: equal("before"), current_matches_after: equal("after") },
        ),
        plan,
        "outcome",
      ),
    )
  })
}

export function executeSharedMetadataWrite<R = never>(
  library: SharedLibrary,
  input: {
    readonly plan: SharedMetadataWritePlan
    readonly mode: "create" | "reconcile"
    readonly beforePlanWrite?: (
      plan: SharedMetadataWritePlan,
    ) => Effect.Effect<void, SkillsError, R>
    readonly beforeDispatch?: (plan: SharedMetadataWritePlan) => Effect.Effect<void, SkillsError, R>
  },
) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedMetadataWritePlan(input.plan)
    yield* metadataChecked(() => verifyScope(library, plan))
    if (input.mode === "reconcile") return yield* reconcileSharedMetadataWrite(library, plan)
    if (input.mode !== "create")
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Metadata write mode must be create or reconcile."),
      )
    const existing = yield* querySharedRecords(library, {
      skillPageId: plan.skill_page_id,
      kind: "operation",
      entityId: sharedMetadataEntity,
      recordId: plan.operation_id,
    })
    if (existing.length !== 0) return yield* reconcileSharedMetadataWrite(library, plan)
    const pending = yield* loadPendingSharedMetadataWrites(library, {
      skillPageId: plan.skill_page_id,
    })
    const originalPending = pending[0]
    if (originalPending !== undefined)
      return yield* Effect.fail(
        recovery(
          fail(
            "SHARED_METADATA_WRITE_PENDING",
            "A previous original metadata operation must be reconciled first.",
          ),
          originalPending,
          "pending",
        ),
      )
    yield* verifyBefore(library, plan)
    if (input.beforeDispatch !== undefined) yield* input.beforeDispatch(plan)
    if (
      plan.changes.every(
        (change) => canonicalSharedJson(change.before) === canonicalSharedJson(change.after),
      )
    )
      return {
        status: "unchanged" as const,
        operation_id: plan.operation_id,
        verified: true as const,
        requires_fresh_read: true as const,
        protection: sharedMetadataWriteProtection,
      }
    if (input.beforePlanWrite !== undefined) yield* input.beforePlanWrite(plan)
    yield* appendSharedRecord(library, {
      mode: "create",
      recordId: plan.operation_id,
      operationId: plan.operation_id,
      skillPageId: plan.skill_page_id,
      kind: "operation",
      entityId: sharedMetadataEntity,
      payload: plan,
    }).pipe(Effect.mapError((error) => recovery(error, plan, "plan")))
    const ready = yield* Effect.gen(function* () {
      yield* verifyBefore(library, plan)
      if (input.beforeDispatch !== undefined) yield* input.beforeDispatch(plan)
    }).pipe(Effect.result)
    if (ready._tag === "Failure") {
      yield* outcome(library, plan, "not_sent", ready.failure.code)
      return yield* Effect.fail(recovery(ready.failure, plan, "pre_send"))
    }
    const properties = yield* metadataChecked(() => patchProperties(plan))
    const response = yield* (yield* Notion)
      .request(`v1/pages/${plan.page_id}`, { properties }, { method: "PATCH" })
      .pipe(Effect.result)
    if (response._tag === "Failure") {
      const details = property(response.failure.details)
      if (
        response.failure.code === "NOTION_REQUEST_FAILED" &&
        details.phase === "definitive_rejection" &&
        details.http_status === 400 &&
        details.notion_code === "validation_error"
      )
        yield* outcome(library, plan, "rejected", response.failure.code)
      return yield* Effect.fail(recovery(response.failure, plan, "properties_request"))
    }
    let observed: Outcome["observed"]
    const verified = yield* Effect.gen(function* () {
      for (const raw of [
        response.success,
        yield* (yield* Notion).request(`v1/pages/${plan.page_id}`),
      ]) {
        const context = yield* metadataChecked(() => decodePage(library, raw, plan.page_id))
        if (context.record.id !== plan.record_id || context.file_id !== plan.file_id)
          return yield* Effect.fail(
            fail(
              "SHARED_METADATA_WRITE_SCOPE",
              "Metadata write readback identifies a different shared entity.",
            ),
          )
        observed = yield* observedValues(
          library,
          raw,
          context.record,
          plan.changes.map((change) => change.field),
        )
        if (
          !observed.every(
            (value) =>
              canonicalSharedJson(value.value) ===
              canonicalSharedJson(
                plan.changes.find((change) => change.field === value.field)?.after,
              ),
          )
        )
          return yield* Effect.fail(
            fail(
              "SHARED_METADATA_WRITE_MISMATCH",
              "The complete requested property values differ from the frozen candidate.",
            ),
          )
      }
    }).pipe(Effect.result)
    if (verified._tag === "Failure") {
      yield* outcome(library, plan, "needs_review", verified.failure.code, observed)
      return yield* Effect.fail(
        recovery(
          fail(
            "SHARED_METADATA_REVIEW_REQUIRED",
            "Metadata readback did not exactly verify the original requested fields. Preserve the current properties; no rollback was attempted.",
            { cause_code: verified.failure.code },
          ),
          plan,
          "postcondition",
        ),
      )
    }
    yield* outcome(
      library,
      plan,
      "applied",
      "EXACT_PROPERTY_RESPONSE_AND_READBACK_VERIFIED",
      observed,
    )
    return {
      status: "applied" as const,
      operation_id: plan.operation_id,
      verified: true as const,
      requires_fresh_read: true as const,
      protection: sharedMetadataWriteProtection,
    }
  })
}

/** One small metadata-family query, reusing the consumer's common operation index. */
export function loadPendingSharedMetadataWrites(
  library: SharedLibrary,
  input: { readonly skillPageId: string; readonly headers?: readonly SharedOperationHeader[] },
) {
  return Effect.gen(function* () {
    const headers = input.headers ?? (yield* querySharedOperationIndex(library, input.skillPageId))
    const selected = headers.filter((header) => header.entity_id === sharedMetadataEntity)
    if (selected.length === 0) return [] as readonly SharedMetadataWritePlan[]
    const rows = yield* querySharedRecords(library, {
      skillPageId: input.skillPageId,
      kind: "operation",
      entityId: sharedMetadataEntity,
    })
    const byId = new Map(rows.map((row) => [row.record_id, row]))
    for (const header of selected) {
      const row = byId.get(header.record_id)
      if (row === undefined || row.hash !== header.hash)
        return yield* Effect.fail(
          fail(
            "SHARED_METADATA_WRITE_UNRESOLVED",
            "An indexed original metadata fact is unavailable or changed; do not start replacement intent.",
          ),
        )
    }
    const plans: SharedMetadataWritePlan[] = []
    const outcomes = new Map<string, Outcome>()
    for (const row of rows) {
      if (row.record_id.startsWith("outcome-")) {
        const result = yield* metadataChecked(() => decodeOutcome(row))
        outcomes.set(result.operation_id, result)
      } else {
        const plan = yield* validateSharedMetadataWritePlan(row.payload)
        if (
          row.record_id !== plan.operation_id ||
          row.operation_id !== plan.operation_id ||
          plan.library_id !== library.library_id ||
          plan.skill_page_id !== input.skillPageId
        )
          return yield* Effect.fail(
            fail(
              "SHARED_METADATA_WRITE_INVALID",
              "A shared metadata plan differs from its immutable record identity.",
            ),
          )
        plans.push(plan)
      }
    }
    const pending: SharedMetadataWritePlan[] = []
    for (const plan of plans) {
      const saved = outcomes.get(plan.operation_id)
      if (saved !== undefined) yield* metadataChecked(() => verifyOutcome(plan, saved))
      if (saved === undefined || saved.status === "needs_review") pending.push(plan)
    }
    return pending.sort(
      (a, b) =>
        a.observed_at - b.observed_at ||
        (a.operation_id < b.operation_id ? -1 : a.operation_id > b.operation_id ? 1 : 0),
    )
  })
}

/** Exact original recovery plus the existing auth-scoped replay barrier; no second ledger. */
export function executeSharedMetadataWriteWithJournal<R = never>(input: {
  readonly library: SharedLibrary
  readonly plan: SharedMetadataWritePlan
  readonly mode: "create" | "reconcile"
  readonly beforeDispatch?: (plan: SharedMetadataWritePlan) => Effect.Effect<void, SkillsError, R>
  readonly dryRun?: boolean
}) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedMetadataWritePlan(input.plan)
    const scope = yield* authScope
    const library = yield* loadSharedLibrary(input.library.skills.database_id)
    if (canonicalSharedJson(library) !== canonicalSharedJson(input.library))
      return yield* Effect.fail(
        fail(
          "SHARED_METADATA_WRITE_SCOPE",
          "The registered shared descriptor changed after metadata preparation.",
        ),
      )
    const pendingScope = {
      prefix: yield* sharedPendingObservationPrefix(scope, library.library_id, plan.skill_id),
      scope,
      library_id: library.library_id,
      skill_id: plan.skill_id,
      skill_page_id: plan.skill_page_id,
    }
    const local = yield* pendingFileOperations(pendingScope)
    const original = local.find((entry) => entry.plan.operation_id === plan.operation_id)
    if (
      input.mode === "create" &&
      local.some((entry) => entry.plan.operation_id !== plan.operation_id)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_PENDING_OPERATION",
          "Reconcile the original pending Skill operation before preparing a new metadata write.",
        ),
      )
    if (original !== undefined && canonicalSharedJson(original.plan) !== canonicalSharedJson(plan))
      return yield* Effect.fail(
        fail(
          "STATE_CORRUPT",
          "The original metadata dispatch receipt differs from the requested frozen plan.",
        ),
      )
    if (input.dryRun) {
      yield* verifyBefore(library, plan)
      if (input.beforeDispatch !== undefined) yield* input.beforeDispatch(plan)
      return {
        status: "planned" as const,
        operation_id: plan.operation_id,
        plan,
        dry_run: true as const,
        verified: true as const,
        protection: sharedMetadataWriteProtection,
      }
    }
    const result = yield* executeSharedMetadataWrite<R | Store | Crypto.Crypto>(library, {
      plan,
      mode: original === undefined ? input.mode : "reconcile",
      beforeDispatch: input.beforeDispatch,
      beforePlanWrite: (frozen) => retainPendingFileOperation(pendingScope, frozen),
    })
    if (result.status !== "unchanged") {
      yield* invalidateSnapshotCache(plan.record_id, scope)
      yield* (yield* Store).retireKeys([yield* pendingFileOperationKey(pendingScope.prefix, plan)])
    }
    return result
  })
}
