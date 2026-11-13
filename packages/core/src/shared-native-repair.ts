import { Effect, Schema } from "effect"
import { authScope, databaseId } from "./catalog.ts"
import {
  ContentKindSchema,
  decode,
  entrypointFor,
  fail,
  property,
  SkillsError,
  text,
  validateDescription,
  validateDisplayName,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { pageId } from "./ref.ts"
import { sharedSkillProperty } from "./shared-content.ts"
import { sharedCreateDispatch } from "./shared-create-dispatch.ts"
import {
  assertOriginalOperationsClear,
  assertSkillIdentityUnique,
  fileIdentityConflict,
  listSkillFiles,
  observeManagedFile,
  repairPermission,
  readRepairPage,
  rejectOrdinaryChild,
  repairPage,
} from "./shared-file-adoption.ts"
import { managedFileOutcomeId, type ManagedFileAdoptionPlan } from "./shared-file-adoption-model.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { nativeFileIdentity } from "./shared-native-adoption-model.ts"
import { observeSharedBody } from "./shared-page-body.ts"
import {
  blankRepairBinding,
  historicalRepairOutcomeId,
  makeHistoricalMissingMainPlan,
  nativeRepairEntity,
  pendingRepairHeaders,
  repairChecked,
  repairUntouchedPropertiesDigest,
  repairProtection,
  validateHistoricalMissingMainPlan,
  type HistoricalMissingMainPlan,
} from "./shared-native-repair-model.ts"
import { validateManagedFileAdoptionPlan } from "./shared-file-adoption-model.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  validateSharedRecordEnvelope,
} from "./shared-records.ts"
import { Store, sha256 } from "./store.ts"
import { nativeObservedObjectIdentity } from "./shared-native-body-completion.ts"
import { retainedObservationBody } from "./shared-observation-operation.ts"

export {
  historicalRepairOutcomeId,
  nativeRepairEntity,
  repairProtection,
  validateHistoricalMissingMainPlan,
  type HistoricalMissingMainPlan,
} from "./shared-native-repair-model.ts"
export {
  managedFileOutcomeId,
  validateManagedFileAdoptionPlan,
  type ManagedFileAdoptionPlan,
} from "./shared-file-adoption-model.ts"

const RepairEntrySchema = Schema.Literals([
  "historical-missing-main",
  "managed-file",
  "ordinary-child",
])
export type RepairEntry = typeof RepairEntrySchema.Type
export type RepairPlan = HistoricalMissingMainPlan | ManagedFileAdoptionPlan

const MarkerSchema = Schema.Struct({
  version: Schema.Literal(1),
  operation_id: Schema.String,
  record_id: Schema.String,
})
const LocatorSchema = Schema.Struct({
  version: Schema.Literal(1),
  operation_id: Schema.String,
  database_id: Schema.String,
  page_id: Schema.String,
  skill_page_id: Schema.String,
  entry: Schema.Literals(["historical-missing-main", "managed-file"]),
})
const OutcomeSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literals(["historical_missing_main_outcome", "managed_file_outcome"]),
  status: Schema.Literal("applied"),
  operation_id: Schema.String,
  skill_page_id: Schema.String,
  file_page_id: Schema.String,
  skill_id: Schema.String,
  file_id: Schema.String,
  body_sha256: Schema.String,
  enabled: Schema.Boolean,
})

function permission<A, R>(
  effect: Effect.Effect<A, SkillsError, R>,
  context: Readonly<Record<string, unknown>>,
) {
  return effect.pipe(Effect.mapError((error) => repairPermission(error, context)))
}

export function recognizeRepairOperation(value: string) {
  const operationId = value.startsWith("outcome-") ? value.slice("outcome-".length) : value
  if (/^skill-repair-main-[a-f0-9]{64}$/u.test(operationId))
    return {
      family: "maintenance-repair" as const,
      entry: "historical-missing-main" as const,
      operation_id: operationId,
    }
  if (/^skill-repair-file-[a-f0-9]{64}$/u.test(operationId))
    return {
      family: "maintenance-repair" as const,
      entry: "managed-file" as const,
      operation_id: operationId,
    }
  return undefined
}

export function repairApplyArgv(input: {
  readonly databaseId: string
  readonly operationId: string
  readonly page: string
  readonly entry: RepairPlan["entry"]
  readonly path?: string
  readonly owner?: string
}) {
  return [
    "ntn-skills",
    "ctl",
    "repair",
    "apply",
    input.page,
    "--entry",
    input.entry,
    "--database",
    input.databaseId,
    "--operation",
    input.operationId,
    ...(input.path === undefined ? [] : ["--path", input.path]),
    ...(input.owner === undefined ? [] : ["--owner", input.owner]),
  ]
}

export function repairReconcileArgv(database: string, operationId: string, page: string) {
  return [
    "ntn-skills",
    "ctl",
    "repair",
    "reconcile",
    operationId,
    "--database",
    database,
    "--page",
    page,
  ] as const
}

export function loadPendingSharedRepairs(
  library: SharedLibrary,
  input: {
    readonly skillPageId: string
    readonly headers: readonly {
      readonly record_id: string
      readonly entity_id: string
      readonly page_id?: string
    }[]
  },
) {
  return Effect.gen(function* () {
    if (pageId(input.skillPageId) !== input.skillPageId || library.library_id === "")
      return yield* Effect.fail(
        fail("REPAIR_SCOPE", "Repair pending checks require one canonical Skill page.", {
          skill_page_id: input.skillPageId,
          library_id: library.library_id,
        }),
      )
    const pending = pendingRepairHeaders(input.skillPageId, input.headers)
    for (const header of input.headers) {
      const recognized = recognizeRepairOperation(header.record_id)
      if (
        !recognized ||
        header.record_id !== recognized.operation_id ||
        header.entity_id !== nativeRepairEntity
      )
        continue
      if (pending.some((value) => value.operation_id === recognized.operation_id)) continue
      const original = yield* readOriginalRepairProof(
        library,
        input.skillPageId,
        recognized.operation_id,
      )
      if (!original.complete)
        pending.push({
          operation_id: recognized.operation_id,
          entry: recognized.entry,
          record_id: recognized.operation_id,
          skill_page_id: input.skillPageId,
        })
    }
    return pending
  })
}

/** Consumption gate for one owner. Headers already belong to that Skill; this does not scan the library. */
export function assertSharedRepairPending(
  library: SharedLibrary,
  skillPageId: string,
  headers: readonly {
    readonly record_id: string
    readonly entity_id: string
    readonly page_id?: string
  }[],
) {
  return Effect.gen(function* () {
    const pending = yield* loadPendingSharedRepairs(library, { skillPageId, headers })
    if (pending.length === 0) return
    return yield* Effect.fail(
      fail(
        "SHARED_REPAIR_PENDING",
        "An identity repair has no proved outcome. This Skill stays out of current consumption until that original operation is reconciled.",
        {
          skill_page_id: skillPageId,
          operations: pending,
          manufactured_ack: false,
          next: {
            argv: [
              ...repairReconcileArgv(
                library.skills.database_id,
                pending[0]!.operation_id,
                skillPageId,
              ),
            ],
          },
        },
      ),
    )
  })
}

function repairKey(operationId: string, name: "locator" | "plan-post" | "outcome-post") {
  return authScope.pipe(
    Effect.map(
      (scope) => `operations/shared-maintenance-repair/${scope}/${operationId}/${name}.json`,
    ),
  )
}

function skillText(raw: unknown, library: SharedLibrary, name: string) {
  const field = sharedSkillProperty(raw, library, name)
  const kind = name === "Name" ? "title" : "rich_text"
  if (field.type !== kind || !Array.isArray(field[kind]) || field.has_more === true)
    throw fail("REPAIR_PARTIAL", "A Skill property is incomplete.", {
      property: name,
      page_id: property(raw).id,
    })
  for (const part of field[kind] as unknown[]) {
    const value = property(part)
    if (
      typeof value.plain_text !== "string" &&
      !(value.type === "text" && typeof property(value.text).content === "string")
    )
      throw fail("REPAIR_PARTIAL", "A Skill property is unreadable.", { property: name })
  }
  return text(field[kind])
}

function relations(raw: unknown, library: SharedLibrary, name: "Members" | "Requires") {
  if (library.skills.property_ids[name] === undefined) return null
  const field = sharedSkillProperty(raw, library, name)
  if (field.type !== "relation" || !Array.isArray(field.relation) || field.has_more === true)
    throw fail("REPAIR_PARTIAL", "A Skill relation is incomplete.", {
      property: name,
      page_id: property(raw).id,
    })
  return field.relation
    .map((item) => {
      const id = pageId(String(property(item).id ?? ""))
      if (id === undefined)
        throw fail("REPAIR_PARTIAL", "A Skill relation target is invalid.", { property: name })
      return id
    })
    .sort()
}

function planned(plan: RepairPlan) {
  return {
    state: "planned" as const,
    dry_run: true as const,
    verified: false as const,
    writes: 0 as const,
    plan_id: plan.operation_id,
    operation_id: plan.operation_id,
    entry: plan.entry,
    scopes: plan.scopes,
    plan,
    protection: repairProtection,
    next: {
      argv: repairApplyArgv({
        databaseId: plan.library.skills.database_id,
        operationId: plan.operation_id,
        page: boundPage(plan),
        entry: plan.entry,
        ...(plan.kind === "managed_file_adoption"
          ? { path: plan.path, owner: plan.skill_page_id }
          : {}),
      }),
    },
  }
}

export function planRepair(
  target: string,
  options: {
    readonly entry: string
    readonly database?: string
    readonly path?: string
    readonly owner?: string
    readonly dryRun: boolean
  },
) {
  return withReadOnlyNotion(
    Effect.gen(function* () {
      if (target === "all" || target === "*" || target.trim() === "")
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Repair one explicit page. There is no repair-all."),
        )
      if (!options.dryRun)
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            "Planning is read-only. Pass --dry-run, then apply that same frozen plan.",
          ),
        )
      const entry = yield* repairChecked(() =>
        Schema.decodeUnknownSync(RepairEntrySchema)(options.entry),
      )
      if (entry === "ordinary-child")
        return yield* rejectOrdinaryChild(
          options.database === undefined ? { target } : { target, database: options.database },
        )
      if (entry === "managed-file") {
        if (options.path === undefined || options.owner === undefined)
          return yield* Effect.fail(
            fail("INVALID_ARGUMENT", "Managed-file repair requires --path and --owner."),
          )
        return planned(
          yield* observeManagedFile({
            target,
            owner: options.owner,
            path: options.path,
            ...(options.database === undefined ? {} : { database: options.database }),
          }),
        )
      }
      if (options.path !== undefined || options.owner !== undefined)
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Historical repair does not take --path or --owner."),
        )
      return planned(
        yield* observeHistorical({
          target,
          ...(options.database === undefined ? {} : { database: options.database }),
        }),
      )
    }),
  )
}

function observeHistorical(input: { readonly target: string; readonly database?: string }) {
  return Effect.gen(function* () {
    const selected = yield* repairPage(input.target, "Skill page")
    const api = yield* Notion
    const raw = yield* permission(api.request(`v1/pages/${selected}`), {
      page_id: selected,
      scope: "skill_page",
    })
    const page = yield* readRepairPage(raw, selected)
    if (page.parent.type !== "data_source_id")
      return yield* Effect.fail(
        fail("REPAIR_ENTRY", "This is not a Skill database row.", {
          page_id: selected,
          parent_type: page.parent.type,
        }),
      )
    const database =
      typeof page.parent.database_id === "string" ? pageId(page.parent.database_id) : undefined
    if (input.database !== undefined && database !== (yield* databaseId(input.database)))
      return yield* Effect.fail(
        fail("REPAIR_SCOPE", "The Skill page is outside the selected database.", {
          page_id: selected,
        }),
      )
    const library = yield* loadSharedLibrary(String(page.parent.database_id ?? ""))
    if (page.parent.data_source_id !== library.skills.data_source_id)
      return yield* Effect.fail(
        fail("REPAIR_SCOPE", "The page is not in this library's Skills table.", {
          page_id: selected,
        }),
      )
    const facts = yield* repairChecked(() => {
      const skillId = skillText(raw, library, "Skill ID")
      const main = skillText(raw, library, "Main File ID")
      const enabled = sharedSkillProperty(raw, library, "Enabled")
      if (enabled.type !== "checkbox" || typeof enabled.checkbox !== "boolean")
        throw fail("REPAIR_PARTIAL", "Enabled is not a complete checkbox.", { page_id: selected })
      if (skillId === "" && enabled.checkbox === false)
        throw fail(
          "REPAIR_ENTRY",
          "A blank disabled draft stays on adopt. This repair does not clear identifiers and adopt again.",
          { page_id: selected, entry: "adopt" },
        )
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(skillId))
        throw fail("REPAIR_PARTIAL", "The existing Skill ID is not a legal identity.", {
          page_id: selected,
        })
      if (!blankRepairBinding(main))
        throw fail(
          "REPAIR_BOUND",
          "Main File ID is already bound. Repair does not clear it and adopt again.",
          { page_id: selected, file_id: main },
        )
      const kindField = sharedSkillProperty(raw, library, "Kind")
      if (kindField.type !== "select" || kindField.select === null)
        throw fail("REPAIR_PARTIAL", "Kind is incomplete.", { page_id: selected })
      const kind = decode(ContentKindSchema, property(kindField.select).name)
      const defaults = sharedSkillProperty(raw, library, "Default Context")
      if (defaults.type !== "checkbox" || typeof defaults.checkbox !== "boolean")
        throw fail("REPAIR_PARTIAL", "Default Context is incomplete.", { page_id: selected })
      return {
        name: validateDisplayName(skillText(raw, library, "Name")),
        description: validateDescription(skillText(raw, library, "Description")),
        kind,
        enabled: enabled.checkbox,
        default_context: defaults.checkbox,
        skill_id: skillId,
        main_file_id: "" as const,
        source: skillText(raw, library, "Source"),
        projection: skillText(raw, library, "Projection"),
        references: skillText(raw, library, "References"),
        members: relations(raw, library, "Members"),
        requires: relations(raw, library, "Requires"),
      }
    })
    const entrypoint = entrypointFor(facts.kind)
    if (entrypoint !== "SKILL.md" && entrypoint !== "ROUTER.md" && entrypoint !== "PROMPT.md")
      return yield* Effect.fail(
        fail("REPAIR_PARTIAL", "Kind has no entrypoint.", { page_id: selected }),
      )
    const fileId = yield* nativeFileIdentity(facts.skill_id, entrypoint)
    yield* assertSkillIdentityUnique(library, selected, facts.skill_id)
    const linked = yield* listSkillFiles(library, selected)
    for (const row of linked) {
      if (row.archived)
        return yield* Effect.fail(
          fail("REPAIR_ARCHIVED", "A linked Files row is archived.", {
            page_id: row.page_id,
            skill_page_id: selected,
          }),
        )
      if (row.owners.length !== 1 || row.owners[0] !== selected)
        return yield* Effect.fail(
          fail("REPAIR_MULTIOWNER", "A linked Files row does not have this single owner.", {
            page_id: row.page_id,
            owners: row.owners,
          }),
        )
      if (row.file_id === "" || row.path === entrypoint || row.file_id === fileId)
        return yield* Effect.fail(
          fail(
            "REPAIR_CONFLICT",
            "A linked Files row collides with the missing main identity or is itself unregistered.",
            { page_id: row.page_id, path: row.path, file_id: row.file_id, skill_page_id: selected },
          ),
        )
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(row.file_id))
        return yield* Effect.fail(
          fail("REPAIR_FOREIGN_ID", "A linked File ID is not legal and was not reset.", {
            page_id: row.page_id,
            file_id: row.file_id,
          }),
        )
    }
    yield* fileIdentityConflict(library, fileId, selected)
    const plan = yield* Effect.gen(function* () {
      const body = yield* permission(observeSharedBody(selected), {
        page_id: selected,
        scope: "body",
      })
      return yield* makeHistoricalMissingMainPlan({
        library,
        skillPageId: selected,
        entrypoint,
        facts,
        preimage: {
          url: page.url,
          created_time: page.created_time,
          last_edited_time: page.last_edited_time,
          created_by: page.created_by,
          last_edited_by: page.last_edited_by,
          body_sha256: body.fingerprint.sha256,
          body_bytes: body.bytes,
          body_completion: body.native_body_completion ?? null,
          untouched_properties_sha256: yield* repairUntouchedPropertiesDigest(
            raw,
            library.skills.property_ids["Main File ID"]!,
          ),
        },
      })
    })
    yield* assertOriginalOperationsClear(
      library,
      selected,
      facts.skill_id,
      new Set([plan.operation_id, historicalRepairOutcomeId(plan.operation_id)]),
    )
    return plan
  })
}

function validateRepairPlan(input: unknown) {
  return Effect.gen(function* () {
    const kind = property(input).kind
    if (kind === "historical_missing_main") return yield* validateHistoricalMissingMainPlan(input)
    if (kind === "managed_file_adoption") return yield* validateManagedFileAdoptionPlan(input)
    return yield* Effect.fail(
      fail("REPAIR_ENTRY", "The frozen input is not a historical or managed-file repair plan."),
    )
  })
}

function outcomeId(plan: RepairPlan) {
  return plan.kind === "historical_missing_main"
    ? historicalRepairOutcomeId(plan.operation_id)
    : managedFileOutcomeId(plan.operation_id)
}

function skillPage(plan: RepairPlan) {
  return plan.skill_page_id
}

function boundPage(plan: RepairPlan) {
  return plan.kind === "historical_missing_main" ? plan.skill_page_id : plan.file_page_id
}

function expectedOutcome(plan: RepairPlan) {
  return {
    version: 1 as const,
    kind:
      plan.kind === "historical_missing_main"
        ? ("historical_missing_main_outcome" as const)
        : ("managed_file_outcome" as const),
    status: "applied" as const,
    operation_id: plan.operation_id,
    skill_page_id: plan.skill_page_id,
    file_page_id: boundPage(plan),
    skill_id: plan.skill_id,
    file_id: plan.file_id,
    body_sha256: plan.preimage.body_sha256,
    enabled:
      plan.kind === "historical_missing_main" ? plan.facts.enabled : plan.facts.owner_enabled,
  }
}

function retainOriginalBody(
  library: SharedLibrary,
  plan: RepairPlan,
  body: Effect.Success<ReturnType<typeof observeSharedBody>>,
  mode: "create" | "reconcile",
) {
  return Effect.gen(function* () {
    if (
      body.fingerprint.sha256 !== plan.preimage.body_sha256 ||
      body.bytes !== plan.preimage.body_bytes ||
      canonicalSharedJson(body.native_body_completion ?? null) !==
        canonicalSharedJson(plan.preimage.body_completion)
    )
      return yield* Effect.fail(
        fail(
          "WRITE_CONFLICT",
          "The complete original body changed before retention; no identity patch is authorized.",
        ),
      )
    const identity = yield* nativeObservedObjectIdentity(
      plan.preimage.body_sha256,
      plan.preimage.body_completion ?? undefined,
    )
    const payload = retainedObservationBody(body)
    yield* repairChecked(() =>
      validateSharedRecordEnvelope(identity.operation_id, payload, "object"),
    )
    const append = appendSharedRecord(library, {
      mode,
      skillPageId: plan.skill_page_id,
      kind: "object",
      recordId: identity.object_id,
      entityId: identity.object_id,
      operationId: identity.operation_id,
      payload,
      payloadContainsBody: true,
    })
    if (mode === "reconcile") return yield* append
    const dispatch = yield* sharedCreateDispatch(library, {
      operation_id: plan.operation_id,
      skill_id: plan.skill_id,
    })
    return yield* append.pipe(Effect.provideService(Notion, dispatch.api))
  })
}

function verifyRetainedRepairBody(library: SharedLibrary, plan: RepairPlan) {
  return Effect.gen(function* () {
    const identity = yield* nativeObservedObjectIdentity(
      plan.preimage.body_sha256,
      plan.preimage.body_completion ?? undefined,
    )
    const rows = yield* querySharedRecords(library, {
      skillPageId: plan.skill_page_id,
      kind: "object",
      recordId: identity.object_id,
      entityId: identity.object_id,
      payloadContainsBody: true,
    })
    const row = rows[0],
      markdown = property(row?.payload).markdown
    if (
      rows.length !== 1 ||
      row === undefined ||
      row.operation_id !== identity.operation_id ||
      row.skill_page_id !== plan.skill_page_id ||
      typeof markdown !== "string" ||
      (yield* sha256(markdown)) !== plan.preimage.body_sha256 ||
      new TextEncoder().encode(markdown).byteLength !== plan.preimage.body_bytes
    )
      return yield* Effect.fail(
        fail(
          "REPAIR_BODY_UNAVAILABLE",
          "The repair's complete original body is not retained under its exact owner and content identity.",
        ),
      )
    const expected = retainedObservationBody({
      page_id: boundPage(plan),
      markdown,
      fingerprint: { normalization_version: 1, sha256: plan.preimage.body_sha256 },
      bytes: plan.preimage.body_bytes,
      downloaded_at: 0,
      ...(plan.preimage.body_completion === null
        ? {}
        : { native_body_completion: plan.preimage.body_completion }),
    })
    if (canonicalSharedJson(row.payload) !== canonicalSharedJson(expected))
      return yield* Effect.fail(
        fail(
          "REPAIR_BODY_UNAVAILABLE",
          "The retained body completion proof differs from the original repair.",
        ),
      )
  })
}

function commitRecord(
  library: SharedLibrary,
  plan: RepairPlan,
  recordId: string,
  payload: unknown,
  marker: "plan-post" | "outcome-post",
) {
  return Effect.gen(function* () {
    const found = yield* querySharedRecords(library, {
      skillPageId: skillPage(plan),
      kind: "operation",
      entityId: nativeRepairEntity,
      recordId,
      payloadContainsBody: true,
    })
    if (found.length > 1)
      return yield* Effect.fail(
        fail("REPAIR_CONFLICT", "One repair record ID names more than one page.", {
          record_id: recordId,
          operation_id: plan.operation_id,
        }),
      )
    const store = yield* Store
    const key = yield* repairKey(plan.operation_id, marker)
    if (found[0] !== undefined)
      return yield* appendSharedRecord(library, {
        mode: "reconcile",
        recordId,
        operationId: plan.operation_id,
        skillPageId: skillPage(plan),
        kind: "operation",
        entityId: nativeRepairEntity,
        payload,
        payloadContainsBody: true,
      })
    const existing = yield* store.readJson(key, MarkerSchema)
    if (existing !== undefined)
      return yield* Effect.fail(
        fail(
          "REPAIR_RECORD_UNKNOWN",
          "The original record POST has no observed page. Repair does not send it again.",
          {
            operation_id: plan.operation_id,
            record_id: recordId,
            skill_page_id: skillPage(plan),
            manufactured_ack: false,
            next: {
              argv: [
                ...repairReconcileArgv(
                  plan.library.skills.database_id,
                  plan.operation_id,
                  boundPage(plan),
                ),
              ],
            },
          },
        ),
      )
    yield* store.writeJson(key, {
      version: 1 as const,
      operation_id: plan.operation_id,
      record_id: recordId,
    })
    return yield* appendSharedRecord(library, {
      mode: "create",
      recordId,
      operationId: plan.operation_id,
      skillPageId: skillPage(plan),
      kind: "operation",
      entityId: nativeRepairEntity,
      payload,
      payloadContainsBody: true,
    })
  })
}

function dispatchState(library: SharedLibrary, plan: RepairPlan) {
  return Effect.gen(function* () {
    const patch = patchBody(library, plan)
    const dispatch = yield* sharedCreateDispatch(library, {
      operation_id: plan.operation_id,
      skill_id: plan.skill_id,
      repair_binding: patch.binding,
    })
    const observed = yield* dispatch
      .acknowledged(patch.path, patch.body, "PATCH")
      .pipe(Effect.result)
    if (observed._tag === "Success")
      return { pending: observed.success, acknowledged: observed.success }
    if (["SHARED_CREATE_DISPATCH_UNKNOWN", "WRITE_OUTCOME_UNKNOWN"].includes(observed.failure.code))
      return { pending: true, acknowledged: false }
    return yield* Effect.fail(observed.failure)
  })
}

function readOriginalRepairProof(library: SharedLibrary, owner: string, operationId: string) {
  return Effect.gen(function* () {
    const rows = yield* querySharedRecords(library, {
      skillPageId: owner,
      kind: "operation",
      entityId: nativeRepairEntity,
      recordId: operationId,
      payloadContainsBody: true,
    })
    if (rows.length !== 1 || !rows[0]) return { complete: false as const, plan: undefined }
    const plan = yield* validateRepairPlan(rows[0].payload)
    if (
      plan.library_id !== library.library_id ||
      plan.skill_page_id !== owner ||
      plan.operation_id !== operationId ||
      rows[0].operation_id !== operationId ||
      rows[0].skill_page_id !== owner
    )
      return yield* Effect.fail(
        fail(
          "REPAIR_SCOPE",
          "The retained repair plan belongs to another original operation or owner.",
        ),
      )
    const outcomes = yield* querySharedRecords(library, {
      skillPageId: owner,
      kind: "operation",
      entityId: nativeRepairEntity,
      recordId: outcomeId(plan),
      payloadContainsBody: true,
    })
    if (outcomes.length === 0) return { complete: false as const, plan }
    if (
      outcomes.length !== 1 ||
      !outcomes[0] ||
      outcomes[0].operation_id !== operationId ||
      outcomes[0].skill_page_id !== owner ||
      canonicalSharedJson(outcomes[0].payload) !== canonicalSharedJson(expectedOutcome(plan))
    )
      return yield* Effect.fail(
        fail(
          "REPAIR_CONFLICT",
          "The exact repair outcome differs from its complete original plan.",
        ),
      )
    yield* verifyRetainedRepairBody(library, plan)
    return { complete: true as const, plan }
  })
}

function patchBody(library: SharedLibrary, plan: RepairPlan) {
  if (plan.kind === "historical_missing_main")
    return {
      path: `v1/pages/${plan.skill_page_id}`,
      body: {
        properties: {
          [library.skills.property_ids["Main File ID"]!]: {
            rich_text: [{ type: "text" as const, text: { content: plan.file_id } }],
          },
        },
      },
      binding: {
        kind: "historical_missing_main" as const,
        skill_page_id: plan.skill_page_id,
        file_id: plan.file_id,
      },
    }
  return {
    path: `v1/pages/${plan.file_page_id}`,
    body: {
      properties: {
        [library.files.property_ids["File ID"]!]: {
          rich_text: [{ type: "text" as const, text: { content: plan.file_id } }],
        },
      },
    },
    binding: {
      kind: "managed_file" as const,
      file_page_id: plan.file_page_id,
      skill_page_id: plan.skill_page_id,
      file_id: plan.file_id,
      path: plan.path,
    },
  }
}

function currentBinding(raw: unknown, library: SharedLibrary, plan: RepairPlan) {
  return repairChecked(() =>
    plan.kind === "historical_missing_main"
      ? skillText(raw, library, "Main File ID")
      : fileText(raw, library, "File ID"),
  )
}

function fileText(raw: unknown, library: SharedLibrary, name: string) {
  const field = Object.values(property(property(raw).properties))
    .map(property)
    .find((value) => value.id === library.files.property_ids[name])
  if (
    field === undefined ||
    field.type !== "rich_text" ||
    !Array.isArray(field.rich_text) ||
    field.has_more === true
  )
    throw fail("REPAIR_PARTIAL", "The Files property is incomplete.", {
      property: name,
      page_id: property(raw).id,
    })
  return text(field.rich_text)
}

function relaxedMatch(raw: unknown, library: SharedLibrary, plan: RepairPlan, bodySha: string) {
  return Effect.gen(function* () {
    if (plan.preimage.untouched_properties_sha256 === undefined)
      return yield* Effect.fail(
        fail(
          "REPAIR_PREIMAGE_INCOMPLETE",
          "The original plan does not bind untouched editable properties; it cannot authorize a new patch.",
        ),
      )
    const fieldId =
      plan.kind === "historical_missing_main"
        ? library.skills.property_ids["Main File ID"]!
        : library.files.property_ids["File ID"]!
    if (
      (yield* repairUntouchedPropertiesDigest(raw, fieldId)) !==
      plan.preimage.untouched_properties_sha256
    )
      return yield* Effect.fail(
        fail(
          "WRITE_CONFLICT",
          "Untouched metadata or relations changed. Repair preserves that edit and stops its remaining writes.",
        ),
      )
    return yield* repairChecked(() => {
      const page = property(raw)
      const binding =
        plan.kind === "historical_missing_main"
          ? skillText(raw, library, "Main File ID")
          : fileText(raw, library, "File ID")
      const skillId =
        plan.kind === "historical_missing_main"
          ? skillText(raw, library, "Skill ID")
          : plan.skill_id
      const enabled =
        plan.kind === "historical_missing_main"
          ? sharedSkillProperty(raw, library, "Enabled").checkbox
          : plan.facts.owner_enabled
      if (typeof page.url !== "string" || page.url !== plan.preimage.url)
        throw fail("WRITE_CONFLICT", "The original URL changed.", { page_id: boundPage(plan) })
      const created = property(page.created_by)
      if (
        created.id !== plan.preimage.created_by.id ||
        created.object !== plan.preimage.created_by.object
      )
        throw fail("WRITE_CONFLICT", "The original author changed.", { page_id: boundPage(plan) })
      if (skillId !== plan.skill_id || bodySha !== plan.preimage.body_sha256)
        throw fail("WRITE_CONFLICT", "The original skill identity or body changed.", {
          page_id: boundPage(plan),
          operation_id: plan.operation_id,
        })
      if (plan.kind === "historical_missing_main" && enabled !== plan.facts.enabled)
        throw fail("WRITE_CONFLICT", "Enabled changed. Repair will not switch it.", {
          page_id: plan.skill_page_id,
          enabled,
        })
      if (!blankRepairBinding(binding) && binding !== plan.file_id)
        throw fail("REPAIR_CONFLICT", "The identity binding changed to a different value.", {
          page_id: boundPage(plan),
          file_id: binding,
          expected: plan.file_id,
        })
      return binding
    })
  })
}

function appliedResult(plan: RepairPlan, state: "applied" | "reconciled") {
  const enabled =
    plan.kind === "historical_missing_main" ? plan.facts.enabled : plan.facts.owner_enabled
  return {
    state,
    verified: true as const,
    operation_id: plan.operation_id,
    entry: plan.entry,
    skill_page_id: plan.skill_page_id,
    file_page_id: boundPage(plan),
    skill_id: plan.skill_id,
    file_id: plan.file_id,
    body_sha256: plan.preimage.body_sha256,
    enabled,
    enabled_unchanged: true as const,
    page_recreated: false as const,
    protection: repairProtection,
    requires_fresh_read: true as const,
    next: {
      argv: [
        "ntn-skills",
        "read",
        plan.skill_page_id,
        "--database",
        plan.library.skills.database_id,
        "--authoring",
      ],
    },
  }
}

export function applyRepair(
  input: unknown,
  options: { readonly database: string; readonly operationId: string },
) {
  return Effect.gen(function* () {
    const plan = yield* validateRepairPlan(input)
    const database = yield* databaseId(options.database)
    if (plan.operation_id !== options.operationId || database !== plan.library.skills.database_id)
      return yield* Effect.fail(
        fail(
          "REPAIR_PARTIAL",
          "Apply requires the exact frozen operation and its library database.",
          {
            operation_id: plan.operation_id,
            provided: options.operationId,
          },
        ),
      )
    const library = yield* loadSharedLibrary(plan.library.skills.database_id)
    if (canonicalSharedJson(library) !== canonicalSharedJson(plan.library))
      return yield* Effect.fail(
        fail("REPAIR_SCOPE", "The registered library changed after the repair plan was frozen.", {
          operation_id: plan.operation_id,
        }),
      )
    const outcomeRows = yield* querySharedRecords(library, {
      skillPageId: skillPage(plan),
      kind: "operation",
      entityId: nativeRepairEntity,
      recordId: outcomeId(plan),
      payloadContainsBody: true,
    })
    if (outcomeRows.length > 1)
      return yield* Effect.fail(
        fail("REPAIR_CONFLICT", "The repair outcome is ambiguous.", {
          operation_id: plan.operation_id,
        }),
      )
    const api = yield* Notion
    const raw = yield* permission(api.request(`v1/pages/${boundPage(plan)}`), {
      page_id: boundPage(plan),
      scope: "readback",
    })
    const body = yield* permission(observeSharedBody(boundPage(plan)), {
      page_id: boundPage(plan),
      scope: "body",
    })
    if (outcomeRows[0] !== undefined) {
      const proof = yield* readOriginalRepairProof(library, plan.skill_page_id, plan.operation_id)
      if (!proof.complete || canonicalSharedJson(proof.plan) !== canonicalSharedJson(plan))
        return yield* Effect.fail(
          fail(
            "REPAIR_CONFLICT",
            "The completion has no matching original repair and retained body.",
          ),
        )
      const outcome = yield* repairChecked(() =>
        Schema.decodeUnknownSync(OutcomeSchema)(outcomeRows[0]!.payload, {
          onExcessProperty: "error",
        }),
      )
      yield* relaxedMatch(raw, library, plan, body.fingerprint.sha256)
      const binding = yield* currentBinding(raw, library, plan)
      if (
        outcome.operation_id !== plan.operation_id ||
        outcome.file_id !== plan.file_id ||
        outcome.body_sha256 !== plan.preimage.body_sha256 ||
        binding !== plan.file_id ||
        canonicalSharedJson(outcome) !== canonicalSharedJson(expectedOutcome(plan))
      )
        return yield* Effect.fail(
          fail("REPAIR_CONFLICT", "The retained outcome does not match the frozen repair.", {
            operation_id: plan.operation_id,
          }),
        )
      return appliedResult(plan, "reconciled")
    }
    const local = yield* dispatchState(library, plan)
    const store = yield* Store
    const planMarker = yield* store.readJson(
      yield* repairKey(plan.operation_id, "plan-post"),
      MarkerSchema,
    )
    if (!local.pending && planMarker === undefined) {
      const fresh =
        plan.kind === "historical_missing_main"
          ? yield* observeHistorical({ target: plan.skill_page_id, database })
          : yield* observeManagedFile({
              target: plan.file_page_id,
              owner: plan.skill_page_id,
              path: plan.path,
              database,
            })
      if (canonicalSharedJson(fresh) !== canonicalSharedJson(plan))
        return yield* Effect.fail(
          fail(
            "WRITE_CONFLICT",
            "The page, body, or frontier changed after the repair plan was frozen. Nothing was written.",
            {
              operation_id: plan.operation_id,
              fresh_operation_id: fresh.operation_id,
              page_id: boundPage(plan),
            },
          ),
        )
    } else {
      yield* relaxedMatch(raw, library, plan, body.fingerprint.sha256)
      yield* assertOriginalOperationsClear(
        library,
        skillPage(plan),
        plan.skill_id,
        new Set([plan.operation_id, outcomeId(plan)]),
      )
    }
    yield* store.writeJson(yield* repairKey(plan.operation_id, "locator"), {
      version: 1 as const,
      operation_id: plan.operation_id,
      database_id: database,
      page_id: boundPage(plan),
      skill_page_id: skillPage(plan),
      entry: plan.entry,
    })
    const patch = patchBody(library, plan)
    yield* repairChecked(() =>
      validateSharedRecordEnvelope(
        `retain-${plan.preimage.body_sha256}`,
        retainedObservationBody(body),
        "object",
      ),
    )
    const dispatch = yield* sharedCreateDispatch(
      library,
      { operation_id: plan.operation_id, skill_id: plan.skill_id, repair_binding: patch.binding },
      Effect.gen(function* () {
        yield* commitRecord(library, plan, plan.operation_id, plan, "plan-post")
        yield* retainOriginalBody(library, plan, body, "create")
        const now = yield* observeSharedBody(boundPage(plan))
        const current = yield* (yield* Notion).request(`v1/pages/${boundPage(plan)}`)
        yield* relaxedMatch(current, library, plan, now.fingerprint.sha256)
      }),
    )
    yield* dispatch.api.request(patch.path, patch.body, { method: "PATCH" }).pipe(
      Effect.mapError((error) =>
        fail(error.code, error.message, {
          ...property(error.details),
          operation_id: plan.operation_id,
          page_id: boundPage(plan),
          manufactured_ack: false,
          next: {
            argv: [...repairReconcileArgv(database, plan.operation_id, boundPage(plan))],
          },
        }),
      ),
    )
    const finalBody = yield* observeSharedBody(boundPage(plan))
    const finalPage = yield* api.request(`v1/pages/${boundPage(plan)}`)
    const finalBinding = yield* relaxedMatch(finalPage, library, plan, finalBody.fingerprint.sha256)
    if (finalBinding !== plan.file_id)
      return yield* Effect.fail(
        fail(
          "REPAIR_CONFLICT",
          "The acknowledged repair did not retain its expected exact identity.",
        ),
      )
    yield* commitRecord(library, plan, outcomeId(plan), expectedOutcome(plan), "outcome-post")
    return appliedResult(plan, "applied")
  })
}

function loadRepairView(
  operationId: string,
  options: { readonly database?: string; readonly page?: string },
) {
  return Effect.gen(function* () {
    const recognized = recognizeRepairOperation(operationId)
    if (recognized === undefined || recognized.operation_id !== operationId)
      return yield* Effect.fail(
        fail("REPAIR_ENTRY", "That ID is not a maintenance-repair operation.", {
          operation_id: operationId,
        }),
      )
    const store = yield* Store
    const locator = yield* store.readJson(yield* repairKey(operationId, "locator"), LocatorSchema)
    const page = options.page ?? locator?.page_id
    const database = options.database ?? locator?.database_id
    if (page === undefined || database === undefined)
      return yield* Effect.fail(
        fail(
          "REPAIR_NOT_FOUND",
          "No retained repair locator exists. Pass the original --page and --database. Repair will not guess them.",
          { operation_id: operationId },
        ),
      )
    const selected = yield* repairPage(page, "Page")
    const databaseResolved = yield* databaseId(database)
    if (
      locator !== undefined &&
      (locator.page_id !== selected ||
        locator.database_id !== databaseResolved ||
        locator.operation_id !== operationId)
    )
      return yield* Effect.fail(
        fail("REPAIR_SCOPE", "The supplied page does not match the retained repair locator.", {
          operation_id: operationId,
          page_id: selected,
        }),
      )
    const library = yield* loadSharedLibrary(databaseResolved)
    const skill = locator?.skill_page_id ?? selected
    return { recognized, selected, library, skill }
  })
}

export function applyRepairByOperation(input: {
  readonly page: string
  readonly entry: string
  readonly operationId: string
  readonly database: string
  readonly path?: string
  readonly owner?: string
}) {
  return Effect.gen(function* () {
    const recognized = recognizeRepairOperation(input.operationId)
    if (
      recognized === undefined ||
      recognized.operation_id !== input.operationId ||
      recognized.entry !== input.entry
    )
      return yield* Effect.fail(
        fail("REPAIR_ENTRY", "Apply requires the same repair entry and original operation id.", {
          operation_id: input.operationId,
          entry: input.entry,
        }),
      )
    const database = yield* databaseId(input.database)
    const library = yield* loadSharedLibrary(database)
    const page = yield* repairPage(input.page, "Page")
    const owner =
      input.entry === "managed-file" ? yield* repairPage(input.owner ?? "", "Owner") : page
    const stored = yield* querySharedRecords(library, {
      skillPageId: owner,
      kind: "operation",
      entityId: nativeRepairEntity,
      recordId: input.operationId,
      payloadContainsBody: true,
    })
    if (stored.length > 1)
      return yield* Effect.fail(
        fail("REPAIR_CONFLICT", "The frozen repair plan is stored more than once.", {
          operation_id: input.operationId,
          skill_page_id: owner,
        }),
      )
    if (stored[0] !== undefined) {
      const plan = yield* validateRepairPlan(stored[0].payload)
      if (plan.operation_id !== input.operationId)
        return yield* Effect.fail(
          fail("REPAIR_PARTIAL", "The retained plan is a different operation.", {
            operation_id: input.operationId,
          }),
        )
      return yield* applyRepair(plan, { database, operationId: input.operationId })
    }
    const marker = yield* (yield* Store).readJson(
      yield* repairKey(input.operationId, "plan-post"),
      MarkerSchema,
    )
    if (marker !== undefined)
      return yield* Effect.fail(
        fail(
          "REPAIR_RECORD_UNKNOWN",
          "The original plan POST was not observed. Apply will not invent a replacement plan or resend it.",
          { operation_id: input.operationId, skill_page_id: owner, manufactured_ack: false },
        ),
      )
    const fresh =
      input.entry === "historical-missing-main"
        ? yield* observeHistorical({ target: page, database })
        : yield* observeManagedFile({
            target: page,
            owner,
            path: input.path ?? "",
            database,
          })
    if (fresh.operation_id !== input.operationId)
      return yield* Effect.fail(
        fail(
          "REPAIR_PARTIAL",
          "The current page does not hash to the frozen operation. Refusing to mint another repair.",
          {
            operation_id: input.operationId,
            fresh_operation_id: fresh.operation_id,
            page_id: page,
          },
        ),
      )
    return yield* applyRepair(fresh, { database, operationId: input.operationId })
  })
}

export function showRepair(
  operationId: string,
  options: { readonly database?: string; readonly page?: string } = {},
) {
  return withReadOnlyNotion(
    Effect.gen(function* () {
      const view = yield* loadRepairView(operationId, options)
      const proof = yield* readOriginalRepairProof(view.library, view.skill, operationId)
      const local =
        proof.plan === undefined
          ? { pending: false, acknowledged: false }
          : yield* dispatchState(view.library, proof.plan)
      const verified = proof.complete && local.acknowledged
      return {
        state: verified ? ("complete" as const) : ("observed" as const),
        verified,
        operation_id: operationId,
        entry: view.recognized.entry,
        acknowledgement: local.acknowledged,
        dispatch_pending: local.pending,
        plan_retained: proof.plan !== undefined,
        outcome_retained: proof.complete,
        manufactured_ack: false as const,
        protection: repairProtection,
        next: {
          argv: [
            ...repairReconcileArgv(view.library.skills.database_id, operationId, view.selected),
          ],
        },
      }
    }),
  )
}

export function reconcileRepair(
  operationId: string,
  options: { readonly database?: string; readonly page?: string } = {},
) {
  return withReadOnlyNotion(
    Effect.gen(function* () {
      const shown = yield* showRepair(operationId, options)
      if (!shown.verified)
        return yield* Effect.fail(
          fail(
            shown.dispatch_pending && !shown.acknowledgement
              ? "SHARED_CREATE_DISPATCH_UNKNOWN"
              : "REPAIR_RECORD_UNKNOWN",
            "The original repair outcome is not acknowledged. Current body equality cannot manufacture it, and the missing POST is not repeated.",
            {
              operation_id: operationId,
              acknowledgement: shown.acknowledgement,
              manufactured_ack: false,
              next: shown.next,
            },
          ),
        )
      return { ...shown, state: "reconciled" as const }
    }),
  )
}
