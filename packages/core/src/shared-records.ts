import { Crypto, Effect, Schema } from "effect"
import { decode, fail, listSchema, property, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import type { SharedLibrary } from "./shared-library.ts"
import { sha256 } from "./store.ts"

export const SharedRecordKindSchema = Schema.Literals([
  "file_event",
  "object",
  "source",
  "snapshot",
  "profile",
  "operation",
])
export type SharedRecordKind = typeof SharedRecordKindSchema.Type

export type SharedJson =
  | null
  | boolean
  | number
  | string
  | readonly SharedJson[]
  | { readonly [key: string]: SharedJson }

export type SharedRecord = {
  readonly page_id: string
  readonly record_id: string
  readonly operation_id: string
  readonly skill_page_id: string
  readonly kind: SharedRecordKind
  readonly entity_id: string
  readonly hash: string
  readonly payload: SharedJson
}

/** Profiles are library management facts and never attach to a placeholder Skill. */
export type SharedProfileRecord = Omit<SharedRecord, "kind" | "skill_page_id"> & {
  readonly kind: "profile"
  readonly skill_page_id: null
}
type AnySharedRecord = SharedRecord | SharedProfileRecord

export type QuerySharedRecordsInput = {
  readonly skillPageId: string
  readonly kind?: SharedRecordKind
  readonly entityId?: string
  readonly recordId?: string
  /** Operation plans can retain original body bytes despite their metadata-shaped endpoint. */
  readonly payloadContainsBody?: true
}

export type AppendSharedRecordInput = {
  readonly mode: "create" | "reconcile"
  readonly recordId: string
  readonly operationId: string
  readonly skillPageId: string
  readonly kind: SharedRecordKind
  readonly entityId: string
  readonly payload: unknown
  readonly payloadContainsBody?: true
}

export type QuerySharedProfileRecordsInput = {
  readonly entityId?: string
  readonly recordId?: string
}
export type AppendSharedProfileRecordInput = {
  readonly mode: "create" | "reconcile"
  readonly recordId: string
  readonly operationId: string
  readonly entityId: string
  readonly payload: unknown
}
type LibraryProfileSelection = QuerySharedProfileRecordsInput & {
  readonly libraryProfile: true
  readonly kind?: "profile"
}
type AppendRecordInput =
  | (AppendSharedRecordInput & { readonly libraryProfile: false })
  | (AppendSharedProfileRecordInput & {
      readonly libraryProfile: true
      readonly kind: "profile"
      readonly payloadContainsBody?: never
    })

type Field = "Name" | "Record ID" | "Kind" | "Entity ID" | "Hash" | "Payload" | "Skill"
const fields: readonly Field[] = [
  "Name",
  "Record ID",
  "Kind",
  "Entity ID",
  "Hash",
  "Payload",
  "Skill",
]
const maxPayloadBytes = 64 * 1024
const controls = /[\u0000-\u001f\u007f-\u009f]/u
const EnvelopeSchema = Schema.Struct({
  version: Schema.Literal(1),
  operation_id: Schema.String,
  payload: Schema.Unknown,
})

function invalid(message: string, details?: unknown) {
  return fail("INVALID_SHARED_RECORD", message, details)
}

function checked<A>(run: () => A): Effect.Effect<A, SkillsError> {
  return Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("Invalid shared record data."),
  })
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw invalid(`${label} must be an object.`)
  return property(value)
}

function identifier(value: unknown, label: string, maxLength = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    controls.test(value)
  )
    throw invalid(`${label} must be a nonempty bounded identifier.`)
  return value
}

function notionId(value: unknown, label: string): string {
  const id = identifier(value, label, 36)
  if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu.test(id))
    throw invalid(`${label} must be a Notion UUID.`)
  const compact = id.replaceAll("-", "").toLowerCase()
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`
}

function jsonValue(value: unknown, ancestors: Set<object>, depth: number): SharedJson {
  if (depth > 128) throw invalid("Shared record JSON is too deeply nested.")
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid("Shared record JSON contains a non-finite number.")
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value !== "object")
    throw invalid("Shared record payload must contain only JSON values.")
  if (ancestors.has(value)) throw invalid("Shared record JSON contains a cycle.")
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const entries: SharedJson[] = []
      for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
        if (!descriptor || !("value" in descriptor))
          throw invalid("Shared record JSON contains a sparse array or accessor.")
        entries.push(jsonValue(descriptor.value, ancestors, depth + 1))
      }
      if (
        Reflect.ownKeys(value).some(
          (key) =>
            key !== "length" &&
            (typeof key !== "string" ||
              !/^(?:0|[1-9]\d*)$/u.test(key) ||
              Number(key) >= value.length),
        )
      )
        throw invalid("Shared record JSON arrays cannot contain additional properties.")
      return entries
    }
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      throw invalid("Shared record payload must contain plain JSON objects.")
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const entries: Array<[string, SharedJson]> = []
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw invalid("Shared record JSON cannot contain symbol keys.")
      const descriptor = descriptors[key]
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        throw invalid("Shared record JSON cannot contain accessors or hidden properties.")
      entries.push([key, jsonValue(descriptor.value, ancestors, depth + 1)])
    }
    return Object.fromEntries<SharedJson>(entries)
  } finally {
    ancestors.delete(value)
  }
}

function renderJson(value: SharedJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(renderJson).join(",")}]`
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${renderJson(item)}`)
    .join(",")}}`
}

/** Stable JSON for the versioned record envelope. It does not normalize body text. */
export function canonicalSharedJson(value: unknown): string {
  return renderJson(jsonValue(value, new Set(), 0))
}

function boundedEnvelope(value: unknown) {
  const raw = object(value, "Record envelope")
  if (
    Object.keys(raw).length !== 3 ||
    !Object.hasOwn(raw, "version") ||
    !Object.hasOwn(raw, "operation_id") ||
    !Object.hasOwn(raw, "payload")
  )
    throw invalid("Shared record envelope must contain version, operation_id and payload only.")
  const envelope = decode(EnvelopeSchema, raw)
  const operationId = identifier(envelope.operation_id, "Operation ID")
  const payload = jsonValue(envelope.payload, new Set(), 0)
  const canonical = canonicalSharedJson({ version: 1, operation_id: operationId, payload })
  if (new TextEncoder().encode(canonical).byteLength > maxPayloadBytes)
    throw fail(
      "SHARED_RECORD_TOO_LARGE",
      "Shared record envelopes cannot exceed 64 KiB; store large objects separately.",
      { max_bytes: maxPayloadBytes },
    )
  return { operationId, payload, canonical }
}

/** Preflight the exact envelope before callers persist a dispatch receipt or send a write. */
export function validateSharedRecordEnvelope(operationId: string, payload: unknown): void {
  boundedEnvelope({ version: 1, operation_id: operationId, payload })
}

function fieldIds(library: SharedLibrary): Readonly<Record<Field, string>> {
  const raw = library.records.property_ids
  const ids = {
    Name: identifier(raw.Name, "Name property ID"),
    "Record ID": identifier(raw["Record ID"], "Record ID property ID"),
    Kind: identifier(raw.Kind, "Kind property ID"),
    "Entity ID": identifier(raw["Entity ID"], "Entity ID property ID"),
    Hash: identifier(raw.Hash, "Hash property ID"),
    Payload: identifier(raw.Payload, "Payload property ID"),
    Skill: identifier(raw.Skill, "Skill property ID"),
  }
  if (new Set(Object.values(ids)).size !== fields.length)
    throw invalid("Shared record property IDs must be distinct.")
  return ids
}

function getField(
  properties: Record<string, unknown>,
  field: Field,
  ids: Readonly<Record<Field, string>>,
) {
  const expected = identifier(ids[field], `${field} property ID`)
  const matches = Object.entries(properties).flatMap(([key, value]) => {
    const candidate = object(value, `Property ${key}`)
    return candidate.id === expected || key === expected ? [candidate] : []
  })
  if (matches.length !== 1)
    throw invalid(`Expected exactly one ${field} property.`, { property_id: expected })
  const match = matches[0]
  if (match === undefined) throw invalid(`Missing ${field} property.`)
  if (match.id !== undefined && match.id !== expected)
    throw invalid(`${field} property has a different ID.`)
  return match
}

function richText(field: Record<string, unknown>, label: string) {
  if (field.type !== "rich_text" || !Array.isArray(field.rich_text))
    throw invalid(`${label} must be a rich_text property.`)
  if (field.has_more !== undefined && field.has_more !== false)
    throw invalid(`${label} rich text is incomplete.`)
  for (const value of field.rich_text) {
    const entry = object(value, `${label} rich text`)
    if (typeof entry.plain_text === "string") continue
    if (entry.type === "text" && typeof object(entry.text, `${label} text`).content === "string")
      continue
    throw invalid(`${label} contains unreadable rich text.`)
  }
  return text(field.rich_text)
}

type SkillRecordSelection = QuerySharedRecordsInput & { readonly libraryProfile?: false }
type SelectedRecords = SkillRecordSelection | LibraryProfileSelection

function decodeRecord(rawValue: unknown, library: SharedLibrary, selected: SelectedRecords) {
  const raw = object(rawValue, "Record page")
  if (
    raw.object !== "page" ||
    raw.in_trash === true ||
    raw.archived === true ||
    raw.is_archived === true
  )
    throw invalid("Records query returned a non-page or inactive page.")
  const pageId = notionId(raw.id, "Record page ID")
  const parent = object(raw.parent, "Record parent")
  if (
    parent.type !== "data_source_id" ||
    notionId(parent.data_source_id, "Record parent data source ID") !==
      notionId(library.records.data_source_id, "Records data source ID")
  )
    throw invalid("Record belongs to another data source.", { page_id: pageId })
  if (
    parent.database_id !== undefined &&
    notionId(parent.database_id, "Record parent database ID") !==
      notionId(library.records.database_id, "Records database ID")
  )
    throw invalid("Record belongs to another database.", { page_id: pageId })
  const properties = object(raw.properties, "Record properties")
  const ids = fieldIds(library)
  const kindProperty = getField(properties, "Kind", ids)
  if (kindProperty.type !== "select") throw invalid("Kind must be a select property.")
  const kind = decode(SharedRecordKindSchema, object(kindProperty.select, "Kind selection").name)
  const relation = getField(properties, "Skill", ids)
  if (
    relation.type !== "relation" ||
    !Array.isArray(relation.relation) ||
    relation.has_more !== false
  )
    throw invalid("Record must have a complete Skill relation.")
  let skillPageId: string | null
  if (selected.libraryProfile === true) {
    if (kind !== "profile" || relation.relation.length !== 0)
      throw invalid("A library Profile must have Kind=profile and an empty Skill relation.")
    skillPageId = null
  } else {
    if (relation.relation.length !== 1)
      throw invalid("Record must have exactly one complete Skill relation.")
    skillPageId = notionId(object(relation.relation[0], "Skill relation").id, "Related Skill ID")
    if (skillPageId !== notionId(selected.skillPageId, "Selected Skill ID"))
      throw invalid("Record belongs to another Skill.", { page_id: pageId })
  }
  const recordId = identifier(
    richText(getField(properties, "Record ID", ids), "Record ID"),
    "Record ID",
  )
  const entityId = identifier(
    richText(getField(properties, "Entity ID", ids), "Entity ID"),
    "Entity ID",
  )
  if (
    (selected.recordId !== undefined && recordId !== selected.recordId) ||
    (selected.entityId !== undefined && entityId !== selected.entityId) ||
    (selected.kind !== undefined && kind !== selected.kind)
  )
    throw invalid("Records query returned a row outside the selected filter.", { page_id: pageId })
  const hash = richText(getField(properties, "Hash", ids), "Hash")
  if (!/^[0-9a-f]{64}$/u.test(hash))
    throw invalid("Record Hash must be a lowercase SHA-256 digest.")
  const encoded = richText(getField(properties, "Payload", ids), "Payload")
  if (new TextEncoder().encode(encoded).byteLength > maxPayloadBytes)
    throw fail("SHARED_RECORD_TOO_LARGE", "Stored shared record payload exceeds 64 KiB.")
  let envelope: unknown
  try {
    envelope = JSON.parse(encoded)
  } catch {
    throw invalid("Record Payload must be valid JSON.")
  }
  const parsed = boundedEnvelope(envelope)
  const common = {
    page_id: pageId,
    record_id: recordId,
    operation_id: parsed.operationId,
    kind,
    entity_id: entityId,
    hash,
    payload: parsed.payload,
  }
  const record: AnySharedRecord =
    skillPageId === null
      ? { ...common, kind: "profile", skill_page_id: null }
      : { ...common, skill_page_id: skillPageId }
  return { canonical: parsed.canonical, record }
}

function verifiedRecord(raw: unknown, library: SharedLibrary, selected: SelectedRecords) {
  return Effect.gen(function* () {
    const parsed = yield* checked(() => decodeRecord(raw, library, selected))
    const hash = yield* sha256(parsed.canonical)
    if (hash !== parsed.record.hash)
      return yield* Effect.fail(
        invalid("Shared record payload does not match its Hash.", {
          record_id: parsed.record.record_id,
        }),
      )
    return parsed.record
  })
}

function sameFact(
  left: Omit<AnySharedRecord, "page_id">,
  right: Omit<AnySharedRecord, "page_id">,
): boolean {
  return (
    left.record_id === right.record_id &&
    left.operation_id === right.operation_id &&
    left.skill_page_id === right.skill_page_id &&
    left.kind === right.kind &&
    left.entity_id === right.entity_id &&
    left.hash === right.hash
  )
}

function queryRecords(
  library: SharedLibrary,
  selected: SkillRecordSelection,
  content?: "body",
): Effect.Effect<readonly SharedRecord[], SkillsError, Notion | Crypto.Crypto>
function queryRecords(
  library: SharedLibrary,
  selected: LibraryProfileSelection,
  content?: "body",
): Effect.Effect<readonly SharedProfileRecord[], SkillsError, Notion | Crypto.Crypto>
function queryRecords(
  library: SharedLibrary,
  selected: SelectedRecords,
  content?: "body",
): Effect.Effect<readonly AnySharedRecord[], SkillsError, Notion | Crypto.Crypto> {
  return Effect.gen(function* () {
    const api = yield* Notion
    const query = yield* checked(() => {
      const dataSourceId = notionId(library.records.data_source_id, "Records data source ID")
      notionId(library.records.database_id, "Records database ID")
      const ids = fieldIds(library)
      const filters: unknown[] =
        selected.libraryProfile === true
          ? [{ property: ids.Skill, relation: { is_empty: true } }]
          : [
              {
                property: ids.Skill,
                relation: { contains: notionId(selected.skillPageId, "Skill page ID") },
              },
            ]
      if (selected.kind !== undefined)
        filters.push({
          property: ids.Kind,
          select: { equals: decode(SharedRecordKindSchema, selected.kind) },
        })
      if (selected.entityId !== undefined)
        filters.push({
          property: ids["Entity ID"],
          rich_text: { equals: identifier(selected.entityId, "Entity ID") },
        })
      if (selected.recordId !== undefined)
        filters.push({
          property: ids["Record ID"],
          rich_text: { equals: identifier(selected.recordId, "Record ID") },
        })
      const parameters = new URLSearchParams()
      for (const field of fields.filter((field) => field !== "Name"))
        parameters.append("filter_properties", identifier(ids[field], `${field} property ID`))
      return {
        path: `v1/data_sources/${dataSourceId}/query?${parameters.toString()}`,
        filter: filters.length === 1 ? filters[0] : { and: filters },
      }
    })
    const records = new Map<string, AnySharedRecord>()
    const pages = new Set<string>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const value = yield* api.request(
        query.path,
        {
          page_size: 100,
          filter: query.filter,
          ...(cursor === undefined ? {} : { start_cursor: cursor }),
        },
        { method: "POST", ...(content ? { content } : {}) },
      )
      const page = yield* checked(() => {
        const raw = object(value, "Records query response")
        if (raw.object !== "list") throw invalid("Records query must return a list.")
        if (
          raw.request_status !== undefined &&
          object(raw.request_status, "Records query status").type !== "complete"
        )
          throw invalid("Records query is incomplete.")
        const result = decode(listSchema(Schema.Unknown), raw)
        if (!result.has_more && result.next_cursor !== null)
          throw invalid("Completed Records query returned an unexpected cursor.")
        if (result.has_more) {
          const next = identifier(result.next_cursor, "Records cursor", 2048)
          if (cursors.has(next)) throw invalid("Records query repeated a pagination cursor.")
          cursors.add(next)
        }
        return result
      })
      for (const raw of page.results) {
        const record = yield* verifiedRecord(raw, library, selected)
        if (pages.has(record.page_id))
          return yield* Effect.fail(
            invalid("Records query repeated a page.", { page_id: record.page_id }),
          )
        pages.add(record.page_id)
        const previous = records.get(record.record_id)
        if (previous !== undefined && !sameFact(previous, record))
          return yield* Effect.fail(
            fail("SHARED_RECORD_CONFLICT", "The same Record ID names incompatible shared facts.", {
              record_id: record.record_id,
              page_ids: [previous.page_id, record.page_id],
            }),
          )
        if (previous === undefined || record.page_id < previous.page_id)
          records.set(record.record_id, record)
      }
      if (!page.has_more)
        return [...records.values()].sort((a, b) =>
          a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0,
        )
      cursor = yield* checked(() => identifier(page.next_cursor, "Records cursor", 2048))
    }
  })
}

/**
 * Ownership discovery defaults to file_event and cannot pull all stored objects.
 * Object content requires an explicit entity. Hash verification is local.
 */
export function querySharedRecords(library: SharedLibrary, input: QuerySharedRecordsInput) {
  if (input.kind === "object" && input.entityId === undefined)
    return Effect.fail(
      invalid(
        "Object records require an explicit Entity ID; bulk ownership discovery never loads object bodies.",
      ),
    )
  return queryRecords(
    library,
    { ...input, libraryProfile: false, kind: input.kind ?? "file_event" },
    input.kind === "object" || input.payloadContainsBody === true ? "body" : undefined,
  )
}

/** One paginated metadata query for library Profiles, with no Skill or object body reads. */
export function querySharedProfileRecords(
  library: SharedLibrary,
  input: QuerySharedProfileRecordsInput = {},
) {
  return queryRecords(library, { ...input, libraryProfile: true, kind: "profile" })
}

function textChunks(value: string) {
  const chunks: string[] = []
  let current = ""
  for (const point of value) {
    if (current.length + point.length > 2000) {
      chunks.push(current)
      current = ""
    }
    current += point
  }
  if (current !== "") chunks.push(current)
  return chunks.map((content) => ({ type: "text", text: { content } }))
}

/**
 * This boundary issues at most one create request. After an unknown result, the
 * caller must keep the original IDs and use reconcile; absence never authorizes replay.
 */
function appendRecord(
  library: SharedLibrary,
  input: AppendRecordInput,
): Effect.Effect<AnySharedRecord, SkillsError, Notion | Crypto.Crypto> {
  return Effect.gen(function* () {
    const prepared = yield* checked(() => {
      if (input.mode !== "create" && input.mode !== "reconcile")
        throw invalid("Record mode must be create or reconcile.")
      const ids = fieldIds(library)
      const recordId = identifier(input.recordId, "Record ID")
      const entityId = identifier(input.entityId, "Entity ID")
      const skillPageId =
        input.libraryProfile === true ? null : notionId(input.skillPageId, "Skill page ID")
      const kind = decode(SharedRecordKindSchema, input.kind)
      const envelope = boundedEnvelope({
        version: 1,
        operation_id: input.operationId,
        payload: input.payload,
      })
      return { ids, recordId, entityId, skillPageId, kind, ...envelope }
    })
    const hash = yield* sha256(prepared.canonical)
    const expected: Omit<AnySharedRecord, "page_id"> = {
      record_id: prepared.recordId,
      operation_id: prepared.operationId,
      skill_page_id: prepared.skillPageId,
      kind: prepared.kind,
      entity_id: prepared.entityId,
      hash,
      payload: prepared.payload,
    }
    // Do not filter by kind/entity: that would hide a conflicting fact using this ID.
    const existing =
      prepared.skillPageId === null
        ? yield* queryRecords(library, { libraryProfile: true, recordId: prepared.recordId })
        : yield* queryRecords(
            library,
            { skillPageId: prepared.skillPageId, recordId: prepared.recordId },
            prepared.kind === "object" || input.payloadContainsBody === true ? "body" : undefined,
          )
    const found = existing[0]
    if (found !== undefined) {
      if (!sameFact(found, expected))
        return yield* Effect.fail(
          fail("SHARED_RECORD_CONFLICT", "Record ID already names a different shared fact.", {
            record_id: prepared.recordId,
            operation_id: prepared.operationId,
            page_id: found.page_id,
          }),
        )
      return found
    }
    if (input.mode === "reconcile")
      return yield* Effect.fail(
        fail(
          "SHARED_RECORD_UNRESOLVED",
          "The original shared record has not been observed; reconcile never repeats its create request.",
          { record_id: prepared.recordId, operation_id: prepared.operationId },
        ),
      )
    const api = yield* Notion
    const rich = (value: string) => ({ rich_text: textChunks(value) })
    const created = yield* api
      .request(
        "v1/pages",
        {
          parent: { type: "data_source_id", data_source_id: library.records.data_source_id },
          properties: {
            [prepared.ids.Name]: { title: textChunks(`${prepared.kind}: ${prepared.entityId}`) },
            [prepared.ids["Record ID"]]: rich(prepared.recordId),
            [prepared.ids.Kind]: { select: { name: prepared.kind } },
            [prepared.ids["Entity ID"]]: rich(prepared.entityId),
            [prepared.ids.Hash]: rich(hash),
            [prepared.ids.Payload]: rich(prepared.canonical),
            [prepared.ids.Skill]: {
              relation: prepared.skillPageId === null ? [] : [{ id: prepared.skillPageId }],
            },
          },
        },
        {
          method: "POST",
          ...(prepared.kind === "object" || input.payloadContainsBody === true
            ? { content: "body" as const }
            : {}),
        },
      )
      .pipe(
        Effect.mapError((error) =>
          fail(error.code, error.message, {
            ...property(error.details),
            record_id: prepared.recordId,
            operation_id: prepared.operationId,
            next_mode: "reconcile",
          }),
        ),
      )
    const selection: SelectedRecords =
      prepared.skillPageId === null
        ? {
            libraryProfile: true,
            recordId: prepared.recordId,
            kind: "profile",
            entityId: prepared.entityId,
          }
        : {
            skillPageId: prepared.skillPageId,
            recordId: prepared.recordId,
            kind: prepared.kind,
            entityId: prepared.entityId,
          }
    const verified = yield* verifiedRecord(created, library, selection).pipe(
      Effect.mapError((error) =>
        fail(
          "WRITE_OUTCOME_UNKNOWN",
          "The record creation returned an unverifiable result; retain the original IDs and reconcile before continuing.",
          {
            record_id: prepared.recordId,
            operation_id: prepared.operationId,
            cause_code: error.code,
            next_mode: "reconcile",
          },
        ),
      ),
    )
    if (!sameFact(verified, expected))
      return yield* Effect.fail(
        fail(
          "WRITE_OUTCOME_UNKNOWN",
          "Created record differs from the requested shared fact; reconcile the original operation.",
          {
            record_id: prepared.recordId,
            operation_id: prepared.operationId,
            next_mode: "reconcile",
          },
        ),
      )
    return verified
  })
}

/** Existing Skill-scoped callers retain their exact relation and return type. */
export function appendSharedRecord(
  library: SharedLibrary,
  input: AppendSharedRecordInput,
): Effect.Effect<SharedRecord, SkillsError, Notion | Crypto.Crypto> {
  return appendRecord(library, { ...input, libraryProfile: false }).pipe(
    Effect.flatMap((record) =>
      record.skill_page_id === null
        ? Effect.fail(invalid("A Skill-scoped record cannot be a library Profile."))
        : Effect.succeed(record),
    ),
  )
}

/** Library management shares the existing canonical envelope and unknown-write boundary. */
export function appendSharedProfileRecord(
  library: SharedLibrary,
  input: AppendSharedProfileRecordInput,
): Effect.Effect<SharedProfileRecord, SkillsError, Notion | Crypto.Crypto> {
  return appendRecord(library, { ...input, libraryProfile: true, kind: "profile" }).pipe(
    Effect.flatMap((record) =>
      record.skill_page_id !== null
        ? Effect.fail(invalid("A library Profile cannot have a Skill binding."))
        : Effect.succeed(record),
    ),
  )
}
