import { Effect, Schema } from "effect"
import { decode, fail, listSchema, property, text, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { normalizePath, pageId } from "./ref.ts"
import type { SharedLibrary, TableBinding } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import {
  sharedMetadataEntryFromPage,
  sharedSkillProperty,
  sharedSkillTextProperty,
} from "./shared-content.ts"
import { sha256 } from "./store.ts"
import {
  auditFinding,
  emptyAuditInventory,
  type AuditCoverage,
  type AuditDirectFinding,
  type AuditFinding,
  type AuditInventory,
  type AuditTable,
} from "./shared-audit-model.ts"

export const auditRowId = (raw: unknown) => String(property(raw).id ?? "unidentified-physical-row")
/** Transport tracing is not a version of the native page. All real page,
 * property, relation, edit, archive and parent observations remain frozen. */
export const auditSemanticRow = (raw: unknown): unknown =>
  raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "request_id"))
    : raw
export function auditField(raw: unknown, table: TableBinding, name: string) {
  return (
    Object.values(property(property(raw).properties))
      .map(property)
      .find((value) => value.id === table.property_ids[name]) ?? {}
  )
}
export const auditRich = (raw: unknown, table: TableBinding, name: string) =>
  text(auditField(raw, table, name).rich_text)
export const auditRelationIds = (
  raw: unknown,
  table: TableBinding,
  name: string,
): readonly string[] => {
  const value = auditField(raw, table, name).relation
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const id = property(item).id
        return typeof id === "string" && pageId(id) !== undefined ? [pageId(id)!] : []
      })
    : []
}
export const auditFailureCoverage = (error: SkillsError) =>
  ["AUTH_REQUIRED", "ACCESS_DENIED", "NOT_FOUND"].includes(error.code)
    ? ("permission_limited" as const)
    : ("partial" as const)
export const isAuditPause = (error: SkillsError) =>
  ["REQUEST_BUDGET_EXHAUSTED", "AUTH_REQUIRED", "RATE_LIMITED"].includes(error.code)

function nextCursor(raw: unknown, seen: Set<string>): string | undefined {
  const value = property(raw)
  if (value.has_more === false && value.next_cursor === null) return undefined
  if (
    value.has_more !== true ||
    typeof value.next_cursor !== "string" ||
    value.next_cursor === "" ||
    seen.has(value.next_cursor) ||
    seen.size >= 10_000
  )
    throw fail("AUDIT_INVENTORY_INCOMPLETE", "Inventory pagination did not advance completely.")
  seen.add(value.next_cursor)
  return value.next_cursor
}

/** Relations are expanded by registered property ID, independently of consumer
 * decoding, so an invalid business ID cannot hide >25 relation values. */
function completeRelation(raw: unknown, table: TableBinding, name: string) {
  return Effect.gen(function* () {
    const initial = auditField(raw, table, name)
    if (initial.type !== "relation" || !Array.isArray(initial.relation))
      return yield* Effect.fail(
        fail("AUDIT_RELATION_INVALID", "A registered relation is malformed.", { property: name }),
      )
    if (initial.has_more !== true) return raw
    const api = yield* Notion
    const values: unknown[] = []
    const ids = new Set<string>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const query = new URLSearchParams({
        page_size: "100",
        ...(cursor ? { start_cursor: cursor } : {}),
      })
      const response = yield* api.request(
        `v1/pages/${auditRowId(raw)}/properties/${String(initial.id)}?${query}`,
      )
      const result = yield* Effect.try({
        try: () => {
          const metadata = property(property(response).property_item)
          const decoded = decode(listSchema(Schema.Unknown), response)
          if (
            property(response).object !== "list" ||
            property(response).type !== "property_item" ||
            metadata.id !== initial.id ||
            metadata.type !== "relation" ||
            (decoded.has_more
              ? typeof metadata.next_url !== "string" || metadata.next_url === ""
              : metadata.next_url !== null)
          )
            throw fail(
              "AUDIT_RELATION_INCOMPLETE",
              "Relation pagination returned another property.",
            )
          for (const item of decoded.results) {
            const field = property(item)
            const target = property(field.relation).id
            const id = typeof target === "string" ? pageId(target) : undefined
            if (field.id !== initial.id || field.type !== "relation" || !id || ids.has(id))
              throw fail(
                "AUDIT_RELATION_INCOMPLETE",
                "Relation pagination repeats or loses a target identity.",
              )
            ids.add(id)
            values.push({ id })
          }
          return nextCursor(response, cursors)
        },
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail("AUDIT_RELATION_INCOMPLETE", "Relation pagination is incomplete."),
      })
      cursor = result
    } while (cursor !== undefined)
    if (
      initial.relation.some((item) => !ids.has(String(property(item).id))) ||
      values.length <= initial.relation.length
    )
      return yield* Effect.fail(
        fail("AUDIT_RELATION_DRIFT", "Relation membership changed during pagination."),
      )
    const properties = Object.fromEntries(
      Object.entries(property(property(raw).properties)).map(([key, value]) => [
        key,
        property(value).id === initial.id
          ? { ...property(value), relation: values, has_more: false }
          : value,
      ]),
    )
    return { ...property(raw), properties }
  })
}

export function readAuditInventory(
  library: SharedLibrary,
  kind: AuditTable,
  selection?: { readonly owner_page_id: string },
) {
  return Effect.gen(function* () {
    const table = library[kind]
    if (table === undefined) return []
    const owner = selection?.owner_page_id
    const relationProperty = table.property_ids.Skill
    if (owner !== undefined && (pageId(owner) !== owner || kind === "skills" || !relationProperty))
      return yield* Effect.fail(
        fail(
          "AUDIT_OWNER_FILTER_UNAVAILABLE",
          "An owner-scoped inventory requires one exact page and a Skill relation.",
          { table: kind },
        ),
      )
    const parameters = new URLSearchParams()
    for (const [name, id] of Object.entries(table.property_ids))
      if (name !== "Payload") parameters.append("filter_properties", id)
    const api = yield* Notion
    const rows: unknown[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    const filter =
      owner === undefined
        ? undefined
        : { property: relationProperty, relation: { contains: owner } }
    do {
      const response = yield* api.request(
        `v1/data_sources/${table.data_source_id}/query?${parameters}`,
        {
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
          ...(filter === undefined ? {} : { filter }),
        },
      )
      const page = yield* Effect.try({
        try: () => {
          const value = property(response)
          const status = property(value.request_status)
          if (
            value.object !== "list" ||
            (value.request_status !== undefined &&
              (status.type !== "complete" || status.incomplete_reason != null))
          )
            throw fail(
              "AUDIT_INVENTORY_INCOMPLETE",
              "Notion did not confirm complete inventory visibility.",
              { table: kind },
            )
          const parsed = decode(listSchema(Schema.Unknown), response)
          return { rows: parsed.results, cursor: nextCursor(response, cursors) }
        },
        catch: () =>
          fail(
            "AUDIT_INVENTORY_INCOMPLETE",
            "The registered data-source inventory is incomplete.",
            { table: kind },
          ),
      })
      rows.push(...page.rows)
      cursor = page.cursor
    } while (cursor !== undefined)
    const completed: unknown[] = []
    for (const original of rows) {
      let raw = original
      const errors: unknown[] = []
      const relationFields =
        kind === "skills"
          ? ["Members", "Requires", "Origin"]
          : kind === "sources"
            ? Object.keys(table.property_ids).filter(
                (name) => auditField(raw, table, name).type === "relation",
              )
            : ["Skill", "Origin"]
      for (const name of relationFields) {
        if (table.property_ids[name] === undefined) continue
        const result = yield* completeRelation(raw, table, name).pipe(Effect.result)
        if (result._tag === "Success") raw = result.success
        else {
          if (isAuditPause(result.failure)) return yield* Effect.fail(result.failure)
          errors.push({
            property: name,
            code: result.failure.code,
            details: result.failure.details ?? null,
          })
        }
      }
      completed.push(errors.length ? { ...property(raw), audit_relation_errors: errors } : raw)
    }
    return completed
  })
}

const ownerStatus = (
  files: AuditCoverage | "unobserved" | "not_configured",
  records: AuditCoverage | "unobserved" | "not_configured",
  sources: AuditCoverage | "unobserved" | "not_configured",
) => ({ files, records, sources })

function directFinding(
  code: string,
  objectId: string,
  location: string,
  message: string,
  evidence: unknown,
  coverage: AuditFinding["coverage"],
  severity: AuditFinding["severity"] = coverage === "full" ? "error" : "warning",
): AuditDirectFinding {
  return { code, severity, object_id: objectId, location, message, evidence, coverage }
}

/** Selected page, direct Requires and Origin pages, and that page's File and
 * Record headers. Unfiltered table scans stay on the census path. */
export function readReachableAudit(
  library: SharedLibrary,
  root: string,
  onRootObserved?: (raw: unknown) => void,
) {
  return Effect.gen(function* () {
    const findings: AuditDirectFinding[] = []
    const blank = (
      status: ReturnType<typeof ownerStatus>,
      dependencies: readonly string[] = [],
    ): AuditInventory => ({
      ...emptyAuditInventory(),
      scope: {
        kind: "reachable",
        root_page_id: root,
        dependencies: [...dependencies],
        owner_coverage: [{ owner_page_id: root, ...status }],
        direct_findings: findings,
      },
    })
    if (pageId(root) !== root)
      return { inventory: blank(ownerStatus("unobserved", "unobserved", "unobserved")) }
    const api = yield* Notion
    const loaded = yield* api.request(`v1/pages/${root}`).pipe(Effect.result)
    if (loaded._tag === "Failure") {
      if (isAuditPause(loaded.failure)) return yield* Effect.fail(loaded.failure)
      findings.push(
        directFinding(
          "TARGET_PAGE_UNAVAILABLE",
          root,
          "target",
          "The exact target page could not be read. Deletion is not established.",
          { code: loaded.failure.code, details: loaded.failure.details ?? null },
          auditFailureCoverage(loaded.failure),
        ),
      )
      return { inventory: blank(ownerStatus("unobserved", "unobserved", "unobserved")) }
    }
    let raw = loaded.success
    const row = property(raw)
    const parent = property(row.parent).data_source_id
    if (
      row.object !== "page" ||
      auditRowId(raw) !== root ||
      parent !== library.skills.data_source_id
    ) {
      findings.push(
        directFinding(
          "TARGET_PAGE_OUTSIDE_LIBRARY",
          root,
          "target",
          "The exact page is not a Skill row in this registered library. No library scan was substituted.",
          { parent: row.parent ?? null, in_trash: row.in_trash === true || row.archived === true },
          "full",
          "error",
        ),
      )
      return { inventory: blank(ownerStatus("unobserved", "unobserved", "unobserved")) }
    }
    if (row.in_trash === true || row.archived === true)
      findings.push(
        directFinding(
          "TARGET_PAGE_TRASHED",
          root,
          "target",
          "The exact target page is in trash. Owned rows were not inferred to be deleted.",
          { in_trash: true },
          "full",
          "warning",
        ),
      )
    onRootObserved?.(raw)
    const relationNames = ["Requires", "Origin", "Members"].filter(
      (name) => library.skills.property_ids[name] !== undefined,
    )
    const relationErrors: unknown[] = []
    for (const name of relationNames) {
      const result = yield* completeRelation(raw, library.skills, name).pipe(Effect.result)
      if (result._tag === "Success") raw = result.success
      else if (isAuditPause(result.failure)) return yield* Effect.fail(result.failure)
      else
        relationErrors.push({
          property: name,
          code: result.failure.code,
          details: result.failure.details ?? null,
        })
    }
    if (relationErrors.length) raw = { ...property(raw), audit_relation_errors: relationErrors }
    const dependencies = [
      ...new Set([
        ...auditRelationIds(raw, library.skills, "Requires"),
        ...auditRelationIds(raw, library.skills, "Origin"),
      ]),
    ]
      .filter((id) => id !== root)
      .sort()
    const skills = [raw]
    const sources: unknown[] = []
    let sourceStatus: AuditCoverage | "unobserved" | "not_configured" =
      library.sources === undefined ? "not_configured" : "full"
    if (library.sources !== undefined && library.skills.property_ids.Origin === undefined) {
      sourceStatus = "unobserved"
      findings.push(
        directFinding(
          "SOURCE_RELATION_UNOBSERVED",
          root,
          "Origin",
          "This library has Sources, but the Skill page has no Origin relation to read.",
          {},
          "partial",
        ),
      )
    }
    for (const id of dependencies) {
      const response = yield* api.request(`v1/pages/${id}`).pipe(Effect.result)
      if (response._tag === "Failure") {
        if (isAuditPause(response.failure)) return yield* Effect.fail(response.failure)
        const coverage = auditFailureCoverage(response.failure)
        if (coverage === "permission_limited") sourceStatus = "permission_limited"
        else if (sourceStatus === "full") sourceStatus = "partial"
        findings.push(
          directFinding(
            "DEPENDENCY_PAGE_UNAVAILABLE",
            id,
            `dependency/${id}`,
            "The exact Requires or Origin page could not be read. Deletion is not established.",
            { code: response.failure.code, details: response.failure.details ?? null },
            coverage,
          ),
        )
        continue
      }
      const dependency = property(response.success)
      const dataSource = property(dependency.parent).data_source_id
      const trashed = dependency.in_trash === true || dependency.archived === true
      if (trashed)
        findings.push(
          directFinding(
            "DEPENDENCY_PAGE_TRASHED",
            id,
            `dependency/${id}`,
            "The exact dependency page is in trash.",
            { parent: dependency.parent ?? null },
            "full",
            "warning",
          ),
        )
      else if (dataSource === library.skills.data_source_id) skills.push(response.success)
      else if (library.sources !== undefined && dataSource === library.sources.data_source_id)
        sources.push(response.success)
      else
        findings.push(
          directFinding(
            "DEPENDENCY_OUTSIDE_LIBRARY",
            id,
            `dependency/${id}`,
            "The exact dependency page belongs to another data source.",
            { parent: dependency.parent ?? null },
            "full",
          ),
        )
    }
    const owned = (kind: "files" | "records") =>
      readAuditInventory(library, kind, { owner_page_id: root }).pipe(Effect.result)
    const filesResult = yield* owned("files")
    const recordsResult = yield* owned("records")
    const settle = (
      result: typeof filesResult,
      table: "files" | "records",
    ): { readonly rows: unknown[]; readonly status: AuditCoverage | "unobserved" } => {
      if (result._tag === "Success") return { rows: result.success, status: "full" }
      if (isAuditPause(result.failure)) throw result.failure
      findings.push(
        directFinding(
          "OWNER_ROWS_UNOBSERVED",
          root,
          table,
          "The owner-scoped header query did not complete. An empty library census was not substituted.",
          { code: result.failure.code, details: result.failure.details ?? null },
          auditFailureCoverage(result.failure),
        ),
      )
      return { rows: [], status: auditFailureCoverage(result.failure) }
    }
    let files: { readonly rows: unknown[]; readonly status: AuditCoverage | "unobserved" }
    let records: { readonly rows: unknown[]; readonly status: AuditCoverage | "unobserved" }
    try {
      files = settle(filesResult, "files")
      records = settle(recordsResult, "records")
    } catch (error) {
      if (error instanceof SkillsError) return yield* Effect.fail(error)
      return yield* Effect.fail(
        fail("AUDIT_INVENTORY_INCOMPLETE", "The reachable owner query did not complete."),
      )
    }
    if (relationErrors.length && sourceStatus === "full") sourceStatus = "partial"
    if (findings.length > 64) {
      findings.length = 63
      findings.push(
        directFinding(
          "REACHABLE_FINDINGS_TRUNCATED",
          root,
          "target",
          "Additional reachable findings were omitted. This report is not a complete library census.",
          {},
          "partial",
        ),
      )
    }
    return {
      inventory: {
        skills,
        files: files.rows,
        records: records.rows,
        sources,
        complete: [],
        scope: {
          kind: "reachable" as const,
          root_page_id: root,
          dependencies,
          owner_coverage: [
            {
              owner_page_id: root,
              files: files.status,
              records: records.status,
              sources: sourceStatus,
            },
          ],
          direct_findings: findings,
        },
      },
    }
  })
}

function relationErrors(raw: unknown): readonly unknown[] {
  const errors = property(raw).audit_relation_errors
  return Array.isArray(errors) ? errors : []
}
export const validBusinessId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(value)

/** Directory exclusion is not adoption authority. Check the visible lifecycle
 * before suppressing missing-identity errors for an unfinished draft. */
export function inspectAuditDraft(library: SharedLibrary, inventory: AuditInventory, raw: unknown) {
  if (
    auditRich(raw, library.skills, "Skill ID") !== "" ||
    auditField(raw, library.skills, "Enabled").checkbox !== false
  )
    return undefined
  const entry = sharedMetadataEntryFromPage(
    raw,
    {
      alias: library.library_id,
      title: "Skills",
      role: "content",
      database_id: library.skills.database_id,
      data_source_ids: [library.skills.data_source_id],
      shared_library: library,
    },
    library.skills.data_source_id,
  )
  if (entry.state !== "unregistered") return undefined
  const findings: AuditFinding[] = []
  const add = (
    code: string,
    severity: AuditFinding["severity"],
    location: string,
    message: string,
    evidence: unknown,
    coverage: AuditFinding["coverage"] = "full",
  ) =>
    findings.push(
      auditFinding({
        code,
        severity,
        object_id: entry.page_id,
        scope_key: `skill:${entry.page_id}`,
        location,
        message,
        evidence,
        coverage,
      }),
    )
  add(
    "UNREGISTERED_DRAFT",
    "info",
    "registration",
    "This disabled page has no registered Skill identity. It is not consumer content or an adoption approval.",
    { enabled: false, adoption: "not_evaluated" },
  )
  for (const name of ["Main File ID", "Source", "Projection", "References"]) {
    try {
      if (sharedSkillTextProperty(raw, library, name) !== "")
        add(
          "UNREGISTERED_LIFECYCLE_BOUND",
          "error",
          name,
          "An unregistered page retains a managed binding. Preserve its original lifecycle before adoption.",
          { property: name },
        )
    } catch (error) {
      add(
        "UNREGISTERED_LIFECYCLE_UNOBSERVED",
        "warning",
        name,
        "The draft's managed field was not observed completely.",
        { property: name, code: error instanceof SkillsError ? error.code : "INVALID_RESPONSE" },
        "partial",
      )
    }
  }
  for (const name of ["Members", "Requires", "Origin", "Supporting Files"]) {
    if (library.skills.property_ids[name] === undefined) continue
    try {
      const field = sharedSkillProperty(raw, library, name)
      if (
        field.type !== "relation" ||
        !Array.isArray(field.relation) ||
        (field.has_more !== undefined && field.has_more !== false) ||
        field.relation.some((value) => pageId(String(property(value).id)) === undefined)
      )
        throw fail("AUDIT_RELATION_INCOMPLETE", "The draft relation is incomplete.")
      if (field.relation.length)
        add(
          "UNREGISTERED_LIFECYCLE_BOUND",
          "error",
          name,
          "An unregistered page retains managed relations.",
          { property: name, targets: field.relation.map((value) => property(value).id) },
        )
    } catch (error) {
      add(
        "UNREGISTERED_LIFECYCLE_UNOBSERVED",
        "warning",
        name,
        "The draft's managed relation was not observed completely.",
        { property: name, code: error instanceof SkillsError ? error.code : "INVALID_RESPONSE" },
        "partial",
      )
    }
  }
  for (const table of ["files", "records"] as const) {
    const owned = inventory[table].filter((value) =>
      auditRelationIds(value, library[table], "Skill").includes(entry.page_id),
    )
    const scoped =
      inventory.scope?.kind === "reachable"
        ? inventory.scope.owner_coverage.find((row) => row.owner_page_id === entry.page_id)?.[table]
        : undefined
    const observed =
      scoped !== undefined
        ? scoped === "full" && !inventory[table].some((value) => relationErrors(value).length)
        : inventory.complete.includes(table) &&
          !inventory[table].some((value) => relationErrors(value).length)
    if (owned.length)
      add(
        "UNREGISTERED_LIFECYCLE_BOUND",
        "error",
        table,
        "Related physical rows remain attached to this unregistered page.",
        { table, page_ids: owned.map(auditRowId) },
      )
    if (!observed)
      add(
        "UNREGISTERED_LIFECYCLE_UNOBSERVED",
        "warning",
        table,
        "The reverse owner inventory is incomplete; absence of lifecycle history is not established.",
        { table, owner_query: scoped ?? "unobserved" },
        "partial",
      )
  }
  return {
    entry,
    findings,
    state: {
      registration: "unregistered",
      enabled: false,
      adoption: "not_evaluated",
      lifecycle: findings.some((value) => value.code === "UNREGISTERED_LIFECYCLE_BOUND")
        ? "bound"
        : findings.some((value) => value.coverage !== "full")
          ? "unobserved"
          : "unbound",
      content: "unobserved",
      history: "unobserved",
    },
  }
}

export function inspectAuditInventory(
  library: SharedLibrary,
  inventory: AuditInventory,
): readonly AuditFinding[] {
  const findings: AuditFinding[] = []
  const add = (
    code: string,
    raw: unknown,
    location: string,
    message: string,
    evidence: unknown,
    coverage: AuditFinding["coverage"] = "full",
  ) =>
    findings.push(
      auditFinding({
        code,
        severity: coverage === "full" ? "error" : "warning",
        object_id: auditRowId(raw),
        scope_key: "inventory",
        location,
        message,
        evidence,
        coverage,
      }),
    )
  const claims = new Map<string, unknown[]>()
  const claim = (key: string, raw: unknown) => claims.set(key, [...(claims.get(key) ?? []), raw])
  const skills = new Map(inventory.skills.map((raw) => [auditRowId(raw), raw]))
  for (const kind of ["skills", "files", "records"] as const) {
    const table = library[kind]
    const physical = new Set<string>()
    for (const raw of inventory[kind]) {
      const row = property(raw)
      const id = auditRowId(raw)
      if (physical.has(id))
        add(
          "DUPLICATE_PHYSICAL_PAGE",
          raw,
          kind,
          "Pagination returned the same physical page more than once.",
          { table: kind },
          "partial",
        )
      physical.add(id)
      if (
        row.object !== "page" ||
        pageId(id) !== id ||
        property(row.parent).data_source_id !== table.data_source_id
      )
        add(
          "ROW_SCOPE_INVALID",
          raw,
          kind,
          "The physical row does not belong to its registered table.",
          { table: kind },
          "partial",
        )
      for (const error of relationErrors(raw))
        add(
          "RELATION_UNOBSERVED",
          raw,
          String(property(error).property),
          "The complete native relation could not be observed.",
          error,
          "partial",
        )
      const field = kind === "skills" ? "Skill ID" : kind === "files" ? "File ID" : "Record ID"
      const identity = auditRich(raw, table, field)
      let draft = false
      if (kind === "skills") {
        try {
          const observed = inspectAuditDraft(library, inventory, raw)
          if (observed) {
            draft = true
            findings.push(...observed.findings)
          }
        } catch (error) {
          add(
            "SKILL_METADATA_INVALID",
            raw,
            "registration",
            "The native page cannot be classified from its complete registered properties.",
            { code: error instanceof SkillsError ? error.code : "INVALID_RESPONSE" },
          )
        }
      }
      if (!draft && !validBusinessId(identity))
        add("BUSINESS_ID_INVALID", raw, field, "The row has no valid stable business identity.", {
          value: identity,
        })
      const owners = kind === "skills" ? [] : auditRelationIds(raw, table, "Skill")
      if (
        kind === "files" &&
        owners.length !== 1 &&
        !relationErrors(raw).some((error) => property(error).property === "Skill")
      )
        add(
          owners.length > 1 ? "FILE_MULTIPLE_OWNERS" : "FILE_OWNER_MISSING",
          raw,
          "Skill",
          "A File must have exactly one complete Skill owner relation.",
          { owners },
        )
      const recordKind = String(property(auditField(raw, table, "Kind").select).name ?? "")
      if (
        kind === "records" &&
        !["profile", "archive"].includes(recordKind) &&
        owners.length !== 1 &&
        !relationErrors(raw).some((error) => property(error).property === "Skill")
      )
        add(
          "RECORD_OWNER_INVALID",
          raw,
          "Skill",
          "The retained record does not have one exact owner.",
          { owners, kind: recordKind },
        )
      const skillsCensusComplete =
        inventory.complete.includes("skills") && inventory.scope?.kind !== "reachable"
      if (kind !== "skills")
        for (const owner of owners)
          if (!skills.has(owner) && skillsCensusComplete)
            add(
              "OWNER_NOT_IN_INVENTORY",
              raw,
              "Skill",
              "The owner is absent from the visible Skills census; deletion is not established.",
              { owner_page_id: owner },
              "permission_limited",
            )
          else if (!skills.has(owner))
            add(
              "OWNER_CENSUS_UNOBSERVED",
              raw,
              "Skill",
              "The owner is outside the observed Skill rows. Deletion is not established, and this is not a complete library census.",
              { owner_page_id: owner, library_census: "unobserved" },
              "partial",
            )
      if (identity)
        claim(
          canonicalSharedJson([
            kind,
            kind === "skills" ? [] : [...owners].sort(),
            ...(kind === "records" && ["profile", "archive"].includes(recordKind)
              ? [recordKind]
              : []),
            identity,
          ]),
          raw,
        )
      if (kind === "skills") {
        const main = auditRich(raw, table, "Main File ID")
        if (!draft && !validBusinessId(main))
          add(
            "MAIN_FILE_ID_INVALID",
            raw,
            "Main File ID",
            "The main body has no stable File identity.",
            { value: main },
          )
        else if (validBusinessId(main)) claim(canonicalSharedJson(["files", [id], main]), raw)
      }
      if (kind === "files") {
        const path = auditRich(raw, table, "Path")
        try {
          if (!path || normalizePath(path) !== path) throw new Error()
        } catch {
          add("FILE_PATH_INVALID", raw, "Path", "The File path is not canonical and relative.", {
            path,
          })
        }
        if (path) claim(canonicalSharedJson(["path", owners, path]), raw)
      }
      if (kind === "records" && !/^[a-f0-9]{64}$/u.test(auditRich(raw, table, "Hash")))
        add(
          "RECORD_HASH_INVALID",
          raw,
          "Hash",
          "The retained record header has no valid content digest.",
          {},
        )
    }
  }
  for (const [key, rows] of claims)
    if (rows.length > 1) {
      const recordCopies =
        key.startsWith('["records"') &&
        new Set(
          rows.map((raw) =>
            canonicalSharedJson([
              property(auditField(raw, library.records, "Kind").select).name ?? null,
              auditRich(raw, library.records, "Entity ID"),
              auditRich(raw, library.records, "Hash"),
            ]),
          ),
        ).size === 1
      const libraryClaim = inventory.scope?.kind !== "reachable"
      for (const raw of rows) {
        if (recordCopies)
          findings.push(
            auditFinding({
              code: "RECORD_DUPLICATE_COPY",
              severity: "warning",
              object_id: auditRowId(raw),
              scope_key: "inventory",
              location: key,
              message:
                "Several physical Records rows share one owner-scoped identity and equal fact headers. Equivalence is only possible until full payloads are compared.",
              evidence: {
                page_ids: rows.map(auditRowId).sort(),
                equivalence: "possible_equivalent",
                payload_verification: "not_established_by_metadata_headers",
                full_payload_required: true,
                library_census: libraryClaim ? "not_limited_by_target_scope" : "unobserved",
              },
              coverage: "full",
            }),
          )
        else if (libraryClaim || rows.length > 1)
          add(
            key.startsWith('["path"') ? "DUPLICATE_FILE_PATH" : "DUPLICATE_BUSINESS_ID",
            raw,
            key,
            libraryClaim
              ? "Several physical rows claim the same stable identity or owner-relative path."
              : "Observed rows conflict. A full-library conflict is not established.",
            {
              page_ids: rows.map(auditRowId).sort(),
              library_census: libraryClaim ? "not_limited_by_target_scope" : "unobserved",
              ...(key.startsWith('["records"') ? { fact_conflict: true } : {}),
            },
          )
      }
    }
  const requires = new Map(
    inventory.skills.map((raw) => [
      auditRowId(raw),
      auditRelationIds(raw, library.skills, "Requires"),
    ]),
  )
  const visiting = new Set<string>(),
    visited = new Set<string>()
  const visit = (id: string, chain: readonly string[]) => {
    if (visiting.has(id)) {
      const cycle = [...chain.slice(chain.indexOf(id)), id]
      add(
        "REQUIRES_CYCLE",
        skills.get(id),
        "Requires",
        "The explicit Requires relation contains a cycle.",
        { page_ids: cycle },
      )
      return
    }
    if (visited.has(id)) return
    visiting.add(id)
    const skillsCensusComplete =
      inventory.complete.includes("skills") && inventory.scope?.kind !== "reachable"
    for (const target of requires.get(id) ?? []) {
      if (!skills.has(target) && skillsCensusComplete)
        add(
          "REQUIRES_TARGET_UNAVAILABLE",
          skills.get(id),
          `Requires/${target}`,
          "A required identity is outside the visible library census.",
          { target_page_id: target },
          "permission_limited",
        )
      else if (!skills.has(target))
        add(
          "REQUIRES_TARGET_UNOBSERVED",
          skills.get(id) ?? id,
          `Requires/${target}`,
          "The required page was not in this observation. Deletion and a full-library conflict are not established.",
          { target_page_id: target, library_census: "unobserved" },
          "partial",
        )
      else visit(target, [...chain, id])
    }
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of [...requires.keys()].sort()) visit(id, [])
  if (inventory.scope?.kind === "reachable")
    for (const direct of inventory.scope.direct_findings)
      findings.push(
        auditFinding({
          ...direct,
          scope_key: "inventory",
        }),
      )
  return findings
}

/** All child metadata, relation values and Records headers participate. Body
 * reuse cannot be justified by only the main page's last_edited_time. */
export function auditSkillSignature(library: SharedLibrary, inventory: AuditInventory, id: string) {
  const sorted = (values: readonly unknown[]) =>
    [...values].sort((a, b) => auditRowId(a).localeCompare(auditRowId(b)))
  const sourceDefinition = (raw: unknown) => ({
    id: auditRowId(raw),
    parent: property(raw).parent ?? null,
    // Poll receipts and reverse backlinks do not change this Skill's selected
    // bytes. Configuration, policy and enabled state do invalidate the result.
    properties: Object.fromEntries(
      [
        "Name",
        "Source ID",
        "Description",
        "Provider",
        "Location",
        "Ref",
        "Selection",
        "Options",
        "Enabled",
        "Policy",
      ].map((name) => [name, auditField(raw, library.sources!, name)]),
    ),
  })
  return sha256(
    canonicalSharedJson({
      library,
      scope: inventory.scope ?? null,
      skill: auditSemanticRow(inventory.skills.find((raw) => auditRowId(raw) === id) ?? null),
      files: sorted(
        inventory.files.filter((raw) => auditRelationIds(raw, library.files, "Skill").includes(id)),
      ).map(auditSemanticRow),
      records: sorted(
        inventory.records.filter((raw) =>
          auditRelationIds(raw, library.records, "Skill").includes(id),
        ),
      ).map(auditSemanticRow),
      sources:
        library.sources === undefined
          ? []
          : sorted(
              inventory.sources.filter((raw) =>
                auditRelationIds(
                  inventory.skills.find((raw) => auditRowId(raw) === id),
                  library.skills,
                  "Origin",
                ).includes(auditRowId(raw)),
              ),
            ).map(sourceDefinition),
    }),
  )
}
