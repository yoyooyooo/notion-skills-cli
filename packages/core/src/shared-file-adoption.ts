import { repairUntouchedPropertiesDigest } from "./shared-native-repair-model.ts"
import { Effect, Schema } from "effect"
import { authScope, databaseId } from "./catalog.ts"
import {
  decode,
  entrypointFor,
  fail,
  listSchema,
  property,
  SkillsError,
  text,
  validateDisplayName,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { normalizePath, pageId } from "./ref.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { sharedSkillProperty } from "./shared-content.ts"
import { querySharedMetadataInventory } from "./shared-metadata-inventory.ts"
import { nativeFileIdentity } from "./shared-native-adoption-model.ts"
import { observeSharedBody } from "./shared-page-body.ts"
import {
  pendingFileOperations,
  sharedPendingObservationPrefix,
} from "./shared-pending-file-operations.ts"
import { querySharedOperationIndex } from "./shared-operation-index.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import {
  blankRepairBinding,
  pendingRepairHeaders,
  repairChecked,
} from "./shared-native-repair-model.ts"
import {
  makeManagedFileAdoptionPlan,
  managedFileOutcomeId,
  type ManagedFileAdoptionPlan,
} from "./shared-file-adoption-model.ts"
import { Store } from "./store.ts"

const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u
const entrypoints = new Set(["SKILL.md", "ROUTER.md", "PROMPT.md"])

export function repairPermission(error: SkillsError, context: Readonly<Record<string, unknown>>) {
  if (error.code !== "ACCESS_DENIED" && error.code !== "AUTH_REQUIRED") return error
  return fail(
    "REPAIR_PERMISSION",
    "Repair cannot continue without permission to read the exact page, relation, or original history.",
    { cause_code: error.code, cause: property(error.details), ...context },
  )
}

function permission<A, E, R>(
  effect: Effect.Effect<A, SkillsError, R>,
  context: Readonly<Record<string, unknown>>,
) {
  return effect.pipe(Effect.mapError((error) => repairPermission(error, context)))
}

export function repairPage(value: string, label: string) {
  const id = pageId(value)
  if (id === undefined)
    return Effect.fail(fail("INVALID_ARGUMENT", `${label} must be an exact Notion page ID or URL.`))
  return Effect.succeed(id)
}

type Actor = { readonly object: "user" | "bot"; readonly id: string }

export function readRepairPage(raw: unknown, expected?: string) {
  return repairChecked(() => {
    const row = property(raw)
    const id = typeof row.id === "string" ? pageId(row.id) : undefined
    if (row.object !== "page" || id === undefined || row.id !== id)
      throw fail("REPAIR_SCOPE", "The selected object is not one canonical Notion page.", {
        page_id: row.id,
      })
    if (expected !== undefined && id !== expected)
      throw fail("REPAIR_SCOPE", "Readback returned a different page.", { page_id: id, expected })
    if (row.in_trash === true || row.archived === true || row.is_archived === true)
      throw fail("REPAIR_ARCHIVED", "Archived or trashed pages are not repaired in place.", {
        page_id: id,
      })
    const created = row.created_time
    const edited = row.last_edited_time
    if (
      typeof created !== "string" ||
      typeof edited !== "string" ||
      !timestamp.test(created) ||
      !timestamp.test(edited) ||
      !Number.isFinite(Date.parse(created)) ||
      !Number.isFinite(Date.parse(edited))
    )
      throw fail("REPAIR_PARTIAL", "The page is missing a complete authoring timestamp.", {
        page_id: id,
      })
    const createdBy = actor(row.created_by, id, "created_by")
    const editedBy = actor(row.last_edited_by, id, "last_edited_by")
    const url = row.url
    if (
      typeof url !== "string" ||
      controls(url) ||
      !url.startsWith("https://") ||
      url.length > 500 ||
      !url.toLowerCase().includes(id.replaceAll("-", ""))
    )
      throw fail("REPAIR_PARTIAL", "The original page URL is missing or does not name this page.", {
        page_id: id,
      })
    return {
      id,
      url,
      created_time: created,
      last_edited_time: edited,
      created_by: createdBy,
      last_edited_by: editedBy,
      parent: property(row.parent),
      raw,
    }
  })
}

function controls(value: string) {
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value)
}

function actor(value: unknown, page: string, label: string): Actor {
  const row = property(value)
  const id = typeof row.id === "string" ? pageId(row.id) : undefined
  if ((row.object !== "user" && row.object !== "bot") || id === undefined)
    throw fail("REPAIR_PARTIAL", "Author metadata is incomplete.", { page_id: page, field: label })
  return { object: row.object, id }
}

function rich(raw: unknown, library: SharedLibrary, table: "skills" | "files", name: string) {
  const binding = library[table]
  const id = binding.property_ids[name]
  if (id === undefined)
    throw fail("REPAIR_PARTIAL", "The library is missing a required property.", {
      property: name,
      table,
    })
  const matches = Object.values(property(property(raw).properties))
    .map(property)
    .filter((field) => field.id === id)
  const field = matches[0]
  if (matches.length !== 1 || field === undefined)
    throw fail("REPAIR_PARTIAL", "A required property is missing or ambiguous.", {
      property: name,
      page_id: property(raw).id,
    })
  if (field.type === "title") return titled(field, name, property(raw).id)
  if (field.type !== "rich_text" || !Array.isArray(field.rich_text) || field.has_more === true)
    throw fail("REPAIR_PARTIAL", "A required text property is incomplete.", {
      property: name,
      page_id: property(raw).id,
    })
  for (const part of field.rich_text) {
    const value = property(part)
    if (
      typeof value.plain_text !== "string" &&
      !(value.type === "text" && typeof property(value.text).content === "string")
    )
      throw fail("REPAIR_PARTIAL", "A required text property is unreadable.", { property: name })
  }
  return text(field.rich_text)
}

function titled(field: Record<string, unknown>, name: string, page: unknown) {
  if (!Array.isArray(field.title) || field.has_more === true)
    throw fail("REPAIR_PARTIAL", "The page title is incomplete.", { property: name, page_id: page })
  return text(field.title)
}

function checkbox(raw: unknown, library: SharedLibrary, name: string) {
  const field = sharedSkillProperty(raw, library, name)
  if (field.type !== "checkbox" || typeof field.checkbox !== "boolean" || field.has_more === true)
    throw fail("REPAIR_PARTIAL", `${name} is not a complete checkbox.`, {
      page_id: property(raw).id,
    })
  return field.checkbox
}

function displayStatus(value: unknown, page: string): "following" | "custom" | "tombstone" {
  if (value === "following" || value === "custom" || value === "tombstone") return value
  throw fail("REPAIR_PARTIAL", "The Files row status is incomplete.", { page_id: page })
}

function fileOwners(raw: unknown, library: SharedLibrary) {
  const id = library.files.property_ids.Skill
  if (id === undefined)
    throw fail("REPAIR_PARTIAL", "The Files table has no Skill relation.", {
      page_id: property(raw).id,
    })
  const field = Object.values(property(property(raw).properties))
    .map(property)
    .find((value) => value.id === id)
  if (field === undefined || field.type !== "relation" || !Array.isArray(field.relation))
    throw fail("REPAIR_PARTIAL", "The Files row relation is incomplete.", {
      page_id: property(raw).id,
    })
  if (field.has_more === true || field.relation.length !== 1)
    throw fail(
      field.relation.length > 1 || field.has_more === true ? "REPAIR_MULTIOWNER" : "REPAIR_SCOPE",
      field.relation.length > 1 || field.has_more === true
        ? "The Files row has more than one owner. Repair will not pick one."
        : "The Files row has no owner relation.",
      {
        page_id: property(raw).id,
        owners: field.relation.map((item) => property(item).id),
      },
    )
  const owner = pageId(String(property(field.relation[0]).id ?? ""))
  if (owner === undefined)
    throw fail("REPAIR_PARTIAL", "The Files row owner is not a page ID.", {
      page_id: property(raw).id,
    })
  return [owner]
}

function relationIds(
  raw: unknown,
  library: SharedLibrary,
  table: "skills" | "files",
  name: string,
) {
  const id = library[table].property_ids[name]
  if (id === undefined) return null
  const matches = Object.values(property(property(raw).properties))
    .map(property)
    .filter((field) => field.id === id)
  const field = matches[0]
  if (
    matches.length !== 1 ||
    field === undefined ||
    field.type !== "relation" ||
    !Array.isArray(field.relation) ||
    field.has_more === true
  )
    throw fail("REPAIR_PARTIAL", "A relation is incomplete.", {
      property: name,
      page_id: property(raw).id,
    })
  return field.relation.map((item) => {
    const related = pageId(String(property(item).id ?? ""))
    if (related === undefined)
      throw fail("REPAIR_PARTIAL", "A relation target is not a page ID.", { property: name })
    return related
  })
}

export type ObservedFileRow = {
  readonly page_id: string
  readonly file_id: string
  readonly path: string
  readonly owners: readonly string[]
  readonly status: string
  readonly archived: boolean
}

export function listSkillFiles(library: SharedLibrary, skillPageId: string) {
  return Effect.gen(function* () {
    const ids = library.files.property_ids
    const query = new URLSearchParams()
    for (const name of ["File ID", "Skill", "Path", "Status"]) {
      const id = ids[name]
      if (id === undefined)
        return yield* Effect.fail(
          fail("REPAIR_PARTIAL", "The Files table is missing a required property.", {
            property: name,
          }),
        )
      query.append("filter_properties", id)
    }
    const api = yield* Notion
    const rows: ObservedFileRow[] = []
    const seen = new Set<string>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const raw = yield* permission(
        api.request(`v1/data_sources/${library.files.data_source_id}/query?${query}`, {
          page_size: 100,
          filter: { property: ids.Skill, relation: { contains: skillPageId } },
          ...(cursor === undefined ? {} : { start_cursor: cursor }),
        }),
        {
          data_source_id: library.files.data_source_id,
          skill_page_id: skillPageId,
          scope: "files",
        },
      )
      const batch = yield* repairChecked(() => {
        if (property(raw).object !== "list")
          throw fail("REPAIR_PARTIAL", "The Files relation census is incomplete.", {
            skill_page_id: skillPageId,
          })
        return decode(listSchema(Schema.Unknown), raw)
      })
      for (const row of batch.results) {
        const decoded = yield* repairChecked(() => decodeFileRow(row, library, skillPageId))
        if (seen.has(decoded.page_id))
          return yield* Effect.fail(
            fail("REPAIR_CONFLICT", "The Files census repeated a page.", {
              page_id: decoded.page_id,
              skill_page_id: skillPageId,
            }),
          )
        seen.add(decoded.page_id)
        rows.push(decoded)
      }
      if (!batch.has_more) {
        if (batch.next_cursor !== null)
          return yield* Effect.fail(
            fail("REPAIR_PARTIAL", "The Files census cursor did not finish.", {
              skill_page_id: skillPageId,
            }),
          )
        return rows
      }
      if (!batch.next_cursor || cursors.has(batch.next_cursor))
        return yield* Effect.fail(
          fail("REPAIR_PARTIAL", "The Files census did not advance.", {
            skill_page_id: skillPageId,
          }),
        )
      cursor = batch.next_cursor
      cursors.add(cursor)
    }
  })
}

function decodeFileRow(raw: unknown, library: SharedLibrary, skillPageId: string): ObservedFileRow {
  const row = property(raw)
  const id = typeof row.id === "string" ? pageId(row.id) : undefined
  if (row.object !== "page" || id === undefined || row.id !== id)
    throw fail("REPAIR_PARTIAL", "The Files census returned a non-page.", {
      skill_page_id: skillPageId,
    })
  const archived = row.in_trash === true || row.archived === true || row.is_archived === true
  const parent = property(row.parent)
  if (!archived && parent.data_source_id !== library.files.data_source_id)
    throw fail("REPAIR_SCOPE", "A related Files row belongs to another data source.", {
      page_id: id,
    })
  const owners = fileOwners(raw, library)
  const statusField = Object.values(property(row.properties))
    .map(property)
    .find((field) => field.id === library.files.property_ids.Status)
  const status = property(statusField?.select).name
  if (!archived && statusField?.type !== "select")
    throw fail("REPAIR_PARTIAL", "A Files row has no complete status.", { page_id: id })
  return {
    page_id: id,
    file_id: archived ? "" : rich(raw, library, "files", "File ID"),
    path: archived ? "" : rich(raw, library, "files", "Path"),
    owners,
    status: typeof status === "string" ? status : "",
    archived,
  }
}

export function assertOriginalOperationsClear(
  library: SharedLibrary,
  skillPageId: string,
  skillId: string,
  allowed: ReadonlySet<string>,
) {
  return Effect.gen(function* () {
    const scope = yield* authScope
    const prefix = yield* sharedPendingObservationPrefix(scope, library.library_id, skillId)
    const pending = yield* pendingFileOperations({
      prefix,
      scope,
      library_id: library.library_id,
      skill_id: skillId,
      skill_page_id: skillPageId,
    })
    if (pending.length > 0)
      return yield* Effect.fail(
        fail(
          "REPAIR_UNKNOWN_OPERATION",
          "A local authoring operation is still unresolved. Repair will not start another one.",
          {
            skill_page_id: skillPageId,
            operations: pending.map((entry) => ({
              operation_id: entry.plan.operation_id,
              kind: entry.plan.kind,
            })),
          },
        ),
      )
    const headers = yield* permission(querySharedOperationIndex(library, skillPageId), {
      skill_page_id: skillPageId,
      scope: "records",
    })
    const ids = new Set(headers.map((header) => header.record_id))
    for (const header of headers) {
      if (allowed.has(header.record_id) || header.record_id.startsWith("outcome-")) continue
      if (!ids.has(`outcome-${header.record_id}`))
        return yield* Effect.fail(
          fail(
            "REPAIR_UNKNOWN_OPERATION",
            "An original operation has no retained outcome. Repair will not guess or replay it.",
            {
              skill_page_id: skillPageId,
              record_id: header.record_id,
              entity_id: header.entity_id,
              record_page_id: header.page_id,
            },
          ),
        )
    }
    const store = yield* Store
    for (const key of yield* store.listKeys("operations/shared-sources/")) {
      if (!/\/source-op-[a-f0-9]{64}\.json$/u.test(key)) continue
      const pendingDispatch = property(yield* store.readJson(key, Schema.Unknown))
      const identity = typeof pendingDispatch.identity === "string" ? pendingDispatch.identity : ""
      const operationId = identity.split(":")[0] ?? ""
      if (operationId !== "" && allowed.has(operationId)) continue
      const acknowledgement = yield* store.readJson(
        key.replace("/source-op-", "/source-ack-"),
        Schema.Unknown,
      )
      if (acknowledgement !== undefined) continue
      if (!canonicalSharedJson(pendingDispatch.body ?? null).includes(skillPageId)) continue
      return yield* Effect.fail(
        fail(
          "REPAIR_UNKNOWN_OPERATION",
          "A local original dispatch has no acknowledgement. Current page equality cannot close it.",
          {
            skill_page_id: skillPageId,
            operation_id:
              typeof pendingDispatch.operation === "string"
                ? pendingDispatch.operation
                : operationId,
            path: pendingDispatch.path,
          },
        ),
      )
    }
  })
}

export function assertSkillIdentityUnique(
  library: SharedLibrary,
  skillPageId: string,
  skillId: string,
) {
  return Effect.gen(function* () {
    const inventory = yield* permission(querySharedMetadataInventory(library, "skills"), {
      skill_page_id: skillPageId,
      scope: "skill_inventory",
    })
    const seen = new Set<string>()
    const clones: string[] = []
    for (const row of inventory.pages) {
      const page = yield* repairChecked(() => {
        const id = pageId(String(property(row).id ?? ""))
        if (id === undefined)
          throw fail("REPAIR_PARTIAL", "The Skills census returned a non-page.", {
            skill_page_id: skillPageId,
          })
        return id
      })
      if (seen.has(page))
        return yield* Effect.fail(
          fail(
            "REPAIR_CLONE",
            "The Skills census repeated a page. Nothing was cleared or merged.",
            {
              page_id: page,
              skill_id: skillId,
            },
          ),
        )
      seen.add(page)
      const value = yield* repairChecked(() => rich(row, library, "skills", "Skill ID"))
      if (value === skillId) clones.push(page)
    }
    if (!seen.has(skillPageId) || clones.length !== 1 || clones[0] !== skillPageId)
      return yield* Effect.fail(
        fail(
          "REPAIR_CLONE",
          "This legal Skill ID is not a single original page. Duplicate or foreign IDs are not repaired or reset.",
          { skill_page_id: skillPageId, skill_id: skillId, pages: clones },
        ),
      )
  })
}

export function fileIdentityConflict(library: SharedLibrary, fileId: string, allowedPage: string) {
  return Effect.gen(function* () {
    const propertyId = library.files.property_ids["File ID"]!
    const api = yield* Notion
    const raw = yield* permission(
      api.request(`v1/data_sources/${library.files.data_source_id}/query`, {
        page_size: 100,
        filter: { property: propertyId, rich_text: { equals: fileId } },
      }),
      { scope: "files", file_id: fileId },
    )
    const batch = yield* repairChecked(() => {
      if (property(raw).object !== "list" || property(raw).has_more === true)
        throw fail("REPAIR_CONFLICT", "The File ID census is ambiguous.", { file_id: fileId })
      return decode(listSchema(Schema.Unknown), raw)
    })
    const pages = batch.results.map((row) => String(property(row).id))
    if (pages.some((page) => page !== allowedPage))
      return yield* Effect.fail(
        fail(
          "REPAIR_CONFLICT",
          "Another Files row already uses this deterministic file identity.",
          {
            file_id: fileId,
            pages,
          },
        ),
      )
  })
}

export function observeManagedFile(input: {
  readonly target: string
  readonly owner: string
  readonly path: string
  readonly database?: string
}) {
  return Effect.gen(function* () {
    const selected = yield* repairPage(input.target, "Files row")
    const owner = yield* repairPage(input.owner, "Owner")
    const path = yield* repairChecked(() => {
      const canonical = normalizePath(input.path)
      if (canonical !== input.path || entrypoints.has(canonical))
        throw fail(
          "REPAIR_CONFLICT",
          "A managed Files row cannot take the authoritative entrypoint body. The Skill page remains that body.",
          { path: input.path, page_id: selected, owner },
        )
      return canonical
    })
    const api = yield* Notion
    const selectedRaw = yield* permission(api.request(`v1/pages/${selected}`), {
      page_id: selected,
      scope: "file_page",
    })
    const page = yield* readRepairPage(selectedRaw, selected)
    if (page.parent.type !== "data_source_id")
      return yield* Effect.fail(
        fail("REPAIR_ENTRY", "This page is not a Files row. Choose the matching repair entry.", {
          page_id: selected,
          parent_type: page.parent.type,
        }),
      )
    const ownerRaw = yield* permission(api.request(`v1/pages/${owner}`), {
      page_id: owner,
      scope: "owner_skill",
    })
    const ownerPage = yield* readRepairPage(ownerRaw, owner)
    if (
      ownerPage.parent.type !== "data_source_id" ||
      typeof ownerPage.parent.database_id !== "string"
    )
      return yield* Effect.fail(
        fail("REPAIR_SCOPE", "The owner is not a Skill database row.", { page_id: owner }),
      )
    const library = yield* loadSharedLibrary(ownerPage.parent.database_id)
    if (
      input.database !== undefined &&
      library.skills.database_id !== (yield* databaseId(input.database))
    )
      return yield* Effect.fail(
        fail("REPAIR_SCOPE", "The owner is outside the selected shared library.", {
          page_id: owner,
        }),
      )
    if (
      page.parent.data_source_id !== library.files.data_source_id ||
      ownerPage.parent.data_source_id !== library.skills.data_source_id
    )
      return yield* Effect.fail(
        fail("REPAIR_SCOPE", "The selected row is not in this library's Files table.", {
          page_id: selected,
          owner,
        }),
      )
    const rowFacts = yield* repairChecked(() => {
      const actualPath = rich(selectedRaw, library, "files", "Path")
      const owners = fileOwners(selectedRaw, library)
      const status = displayStatus(
        property(
          Object.values(property(property(selectedRaw).properties))
            .map(property)
            .find((field) => field.id === library.files.property_ids.Status)?.select,
        ).name,
        selected,
      )
      if (actualPath !== path)
        throw fail("REPAIR_SCOPE", "The Files row path differs from the explicit path.", {
          page_id: selected,
          path: actualPath,
          expected: path,
        })
      if (owners.length !== 1 || owners[0] !== owner)
        throw fail(
          owners.length > 1 ? "REPAIR_MULTIOWNER" : "REPAIR_SCOPE",
          owners.length > 1
            ? "The Files row has more than one owner. Repair will not pick one."
            : "The Files row is not related to the explicit owner.",
          { page_id: selected, owners, owner },
        )
      return {
        name: validateDisplayName(rich(selectedRaw, library, "files", "Name")),
        path,
        file_id: "" as const,
        status,
        projection: rich(selectedRaw, library, "files", "Projection"),
        current_file_id: rich(selectedRaw, library, "files", "File ID"),
      }
    })
    const ownerFacts = yield* repairChecked(() => ({
      skill_id: rich(ownerRaw, library, "skills", "Skill ID"),
      main_file_id: rich(ownerRaw, library, "skills", "Main File ID"),
      enabled: checkbox(ownerRaw, library, "Enabled"),
    }))
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(ownerFacts.skill_id))
      return yield* Effect.fail(
        fail("REPAIR_PARTIAL", "The owner Skill ID is not a legal identity.", {
          page_id: owner,
          skill_id: ownerFacts.skill_id,
        }),
      )
    if (
      ownerFacts.main_file_id !== "" &&
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(ownerFacts.main_file_id)
    )
      return yield* Effect.fail(
        fail(
          "REPAIR_FOREIGN_ID",
          "The owner Main File ID is not a legal identity and was not reset.",
          {
            page_id: owner,
            file_id: ownerFacts.main_file_id,
          },
        ),
      )
    const expectedFileId = yield* nativeFileIdentity(ownerFacts.skill_id, path)
    if (!blankRepairBinding(rowFacts.current_file_id))
      return yield* Effect.fail(
        fail(
          rowFacts.current_file_id === expectedFileId ? "REPAIR_BOUND" : "REPAIR_FOREIGN_ID",
          rowFacts.current_file_id === expectedFileId
            ? "The Files row already has its file identity. Repair does not rewrite it."
            : "A foreign File ID is not cleared or replaced automatically.",
          { page_id: selected, file_id: rowFacts.current_file_id, expected: expectedFileId },
        ),
      )
    const linked = yield* listSkillFiles(library, owner)
    for (const row of linked) {
      if (row.archived)
        return yield* Effect.fail(
          fail("REPAIR_ARCHIVED", "A related Files row is archived.", {
            page_id: row.page_id,
            skill_page_id: owner,
          }),
        )
      if (row.owners.length !== 1 || row.owners[0] !== owner)
        return yield* Effect.fail(
          fail("REPAIR_MULTIOWNER", "A related Files row does not have exactly this owner.", {
            page_id: row.page_id,
            owners: row.owners,
          }),
        )
      if (row.page_id !== selected && row.file_id === "")
        return yield* Effect.fail(
          fail(
            "REPAIR_CONFLICT",
            "Another unregistered Files row is linked. Repair adopts only the explicitly selected row.",
            { page_id: row.page_id, selected },
          ),
        )
      if (row.page_id !== selected && (row.path === path || row.file_id === expectedFileId))
        return yield* Effect.fail(
          fail("REPAIR_CONFLICT", "Another row already owns this path or file identity.", {
            page_id: row.page_id,
            path: row.path,
          }),
        )
    }
    if (!linked.some((row) => row.page_id === selected))
      return yield* Effect.fail(
        fail(
          "REPAIR_SCOPE",
          "The selected Files row is absent from the owner's complete relation.",
          {
            page_id: selected,
            owner,
          },
        ),
      )
    yield* assertSkillIdentityUnique(library, owner, ownerFacts.skill_id)
    yield* fileIdentityConflict(library, expectedFileId, selected)
    const body = yield* permission(observeSharedBody(selected), {
      page_id: selected,
      scope: "body",
    })
    const plan = yield* makeManagedFileAdoptionPlan({
      library,
      filePageId: selected,
      facts: {
        name: rowFacts.name,
        path: rowFacts.path,
        file_id: rowFacts.file_id,
        status: rowFacts.status,
        projection: rowFacts.projection,
        skill_page_id: owner,
        skill_id: ownerFacts.skill_id,
        owner_main_file_id: ownerFacts.main_file_id,
        owner_enabled: ownerFacts.enabled,
      },
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
          selectedRaw,
          library.files.property_ids["File ID"]!,
        ),
      },
    })
    const pending = pendingRepairHeaders(
      owner,
      (yield* permission(querySharedOperationIndex(library, owner), {
        skill_page_id: owner,
        scope: "records",
      })).map((header) => ({
        record_id: header.record_id,
        entity_id: header.entity_id,
        page_id: header.page_id,
      })),
    )
    if (pending.some((item) => item.operation_id !== plan.operation_id))
      return yield* Effect.fail(
        fail(
          "REPAIR_UNKNOWN_OPERATION",
          "The owner has another unfinished repair. This Files row is not adopted over it.",
          { skill_page_id: owner, operations: pending, page_id: selected },
        ),
      )
    yield* assertOriginalOperationsClear(
      library,
      owner,
      ownerFacts.skill_id,
      new Set([
        plan.operation_id,
        managedFileOutcomeId(plan.operation_id),
        ...pending.map((item) => item.operation_id),
        ...pending.map((item) => `outcome-${item.operation_id}`),
      ]),
    )
    return plan
  })
}

export function rejectOrdinaryChild(input: {
  readonly target: string
  readonly database?: string
}) {
  return Effect.gen(function* () {
    const selected = yield* repairPage(input.target, "Child page")
    const api = yield* Notion
    const raw = yield* permission(api.request(`v1/pages/${selected}`), {
      page_id: selected,
      scope: "page",
    })
    const page = yield* readRepairPage(raw, selected)
    const parentType = String(page.parent.type ?? "")
    if (parentType === "data_source_id") {
      const dataSource = String(page.parent.data_source_id ?? "")
      return yield* Effect.fail(
        fail(
          "REPAIR_ENTRY",
          "This page is already a database row. Use historical-missing-main or managed-file for that row.",
          { page_id: selected, parent_type: parentType, data_source_id: dataSource },
        ),
      )
    }
    if (parentType !== "page_id" && parentType !== "block_id" && parentType !== "workspace")
      return yield* Effect.fail(
        fail("REPAIR_SCOPE", "The child page parent is not a supported placement branch.", {
          page_id: selected,
          parent_type: parentType,
        }),
      )
    const body = yield* permission(observeSharedBody(selected), {
      page_id: selected,
      scope: "body",
    })
    const database = input.database === undefined ? undefined : yield* databaseId(input.database)
    return yield* Effect.fail(
      fail(
        "REPAIR_UNSUPPORTED",
        "Moving an ordinary child page cannot prove the same page becomes the managed Files row.",
        {
          branch: "ordinary_child_page_same_page_placement",
          page_id: selected,
          parent_type: parentType,
          parent_id: page.parent.page_id ?? page.parent.block_id ?? null,
          database_id: database ?? null,
          body_sha256: body.fingerprint.sha256,
          body_bytes: body.bytes,
          descendants: "not_crawled",
          writes: 0,
          page_recreated: false,
        },
      ),
    )
  })
}

export function entrypointPath(kind: "skill" | "router" | "prompt") {
  const path = entrypointFor(kind)
  if (path !== "SKILL.md" && path !== "ROUTER.md" && path !== "PROMPT.md")
    return Effect.fail(
      fail("REPAIR_PARTIAL", "The page kind has no canonical entrypoint.", { kind }),
    )
  return Effect.succeed(path)
}
