import { Crypto, Effect, Schema } from "effect"
import { decode, fail, listSchema, property, SkillsError, text } from "./model.ts"
import { Notion, withNotionRequestAttribution } from "./notion.ts"
import type { SharedLibrary } from "./shared-library.ts"
import { sha256 } from "./store.ts"

export type SharedJson =
  | null
  | boolean
  | number
  | string
  | readonly SharedJson[]
  | { readonly [key: string]: SharedJson }
/** One current library Profile. Content history and Skill-owned facts have no route here. */
export type SharedProfileRecord = {
  readonly page_id: string
  readonly record_id: string
  readonly operation_id: string
  readonly skill_page_id: null
  readonly kind: "profile"
  readonly entity_id: string
  readonly hash: string
  readonly payload: SharedJson
}
export type QuerySharedProfileRecordsInput = {
  readonly entityId?: string
  readonly recordId?: string
}
type Field = "Name" | "Record ID" | "Kind" | "Entity ID" | "Hash" | "Payload" | "Skill" | "Origin"
const fields: readonly Field[] = [
  "Name",
  "Record ID",
  "Kind",
  "Entity ID",
  "Hash",
  "Payload",
  "Skill",
  "Origin",
]
const controls = /[\u0000-\u001f\u007f-\u009f]/u
const MAX_PROFILE_ENVELOPE_BYTES = 64 * 1024
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

export function canonicalSharedJson(value: unknown): string {
  return renderJson(jsonValue(value, new Set(), 0))
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
    Origin: identifier(raw.Origin, "Origin property ID"),
  }
  if (new Set(Object.values(ids)).size !== fields.length)
    throw invalid("Shared record property IDs must be distinct.")
  return ids
}

function getField(
  properties: Record<string, unknown>,
  field: string,
  ids: Readonly<Record<string, string | undefined>>,
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

function boundedEnvelope(value: unknown) {
  const raw = object(value, "Profile envelope")
  const envelope = Schema.decodeUnknownSync(EnvelopeSchema)(raw, { onExcessProperty: "error" })
  const operationId = identifier(envelope.operation_id, "Operation ID")
  const payload = jsonValue(envelope.payload, new Set(), 0)
  const canonical = canonicalSharedJson({ version: 1, operation_id: operationId, payload })
  if (new TextEncoder().encode(canonical).length > MAX_PROFILE_ENVELOPE_BYTES)
    throw fail("SHARED_RECORD_TOO_LARGE", "A current Profile envelope cannot exceed 64 KiB.", {
      max_bytes: MAX_PROFILE_ENVELOPE_BYTES,
    })
  return { operationId, payload, canonical }
}
/** Validate before saving a finite pending Profile intent or dispatching its write. */
export function validateSharedRecordEnvelope(operationId: string, payload: unknown): void {
  boundedEnvelope({ version: 1, operation_id: operationId, payload })
}
function emptyRelation(
  properties: Record<string, unknown>,
  label: string,
  ids: Readonly<Record<string, string | undefined>>,
) {
  const field = getField(properties, label, ids)
  if (
    field.type !== "relation" ||
    !Array.isArray(field.relation) ||
    field.relation.length !== 0 ||
    field.has_more !== false
  )
    throw invalid("A current Profile requires complete, empty ownership relations.", {
      property: label,
    })
}
function verifiedRecord(
  rawValue: unknown,
  library: SharedLibrary,
  selected: QuerySharedProfileRecordsInput,
) {
  return Effect.gen(function* () {
    const parsed = yield* checked(() => {
      const raw = object(rawValue, "Profile page")
      if (
        raw.object !== "page" ||
        raw.in_trash === true ||
        raw.archived === true ||
        raw.is_archived === true
      )
        throw invalid("A current Profile must be a live page.")
      const pageId = notionId(raw.id, "Profile page ID"),
        parent = object(raw.parent, "Profile parent")
      if (
        parent.type !== "data_source_id" ||
        notionId(parent.data_source_id, "Parent data source ID") !==
          notionId(library.records.data_source_id, "Records data source ID") ||
        (parent.database_id !== undefined &&
          notionId(parent.database_id, "Parent database ID") !==
            notionId(library.records.database_id, "Records database ID"))
      )
        throw invalid("The Profile belongs to another Records table.", { page_id: pageId })
      const properties = object(raw.properties, "Profile properties"),
        ids = fieldIds(library)
      const kind = getField(properties, "Kind", ids)
      if (kind.type !== "select" || object(kind.select, "Kind selection").name !== "profile")
        throw invalid("The selected identity belongs to another Record kind.")
      emptyRelation(properties, "Skill", ids)
      emptyRelation(properties, "Origin", ids)
      const recordId = identifier(
        richText(getField(properties, "Record ID", ids), "Record ID"),
        "Record ID",
      )
      const entityId = identifier(
        richText(getField(properties, "Entity ID", ids), "Entity ID"),
        "Entity ID",
      )
      if (
        (selected.recordId !== undefined && selected.recordId !== recordId) ||
        (selected.entityId !== undefined && selected.entityId !== entityId)
      )
        throw invalid("The Profile response is outside its exact selected identity.", {
          page_id: pageId,
        })
      const encoded = richText(getField(properties, "Payload", ids), "Payload")
      if (new TextEncoder().encode(encoded).length > MAX_PROFILE_ENVELOPE_BYTES)
        throw fail("SHARED_RECORD_TOO_LARGE", "A current Profile payload cannot exceed 64 KiB.")
      const envelope = boundedEnvelope(JSON.parse(encoded))
      const hash = richText(getField(properties, "Hash", ids), "Hash")
      if (!/^[a-f0-9]{64}$/u.test(hash))
        throw invalid("The Profile requires a SHA-256 envelope hash.")
      return {
        canonical: envelope.canonical,
        record: {
          page_id: pageId,
          record_id: recordId,
          operation_id: envelope.operationId,
          skill_page_id: null,
          kind: "profile",
          entity_id: entityId,
          hash,
          payload: envelope.payload,
        } satisfies SharedProfileRecord,
      }
    })
    if ((yield* sha256(parsed.canonical)) !== parsed.record.hash)
      return yield* Effect.fail(
        invalid("The current Profile payload differs from its hash.", {
          record_id: parsed.record.record_id,
        }),
      )
    return parsed.record
  })
}
/** Complete paginated Profile metadata; no Skill bodies, old Records, or payload cache. */
export function querySharedProfileRecords(
  library: SharedLibrary,
  input: QuerySharedProfileRecordsInput = {},
) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const query = yield* checked(() => {
      const ids = fieldIds(library),
        filters: unknown[] = []
      const exact = input.recordId !== undefined && input.entityId !== undefined
      if (exact)
        filters.push({
          or: [
            {
              property: ids["Record ID"],
              rich_text: { equals: identifier(input.recordId, "Record ID") },
            },
            {
              property: ids["Entity ID"],
              rich_text: { equals: identifier(input.entityId, "Entity ID") },
            },
          ],
        })
      else {
        filters.push({ property: ids.Kind, select: { equals: "profile" } })
        if (input.recordId !== undefined)
          filters.push({
            property: ids["Record ID"],
            rich_text: { equals: identifier(input.recordId, "Record ID") },
          })
        if (input.entityId !== undefined)
          filters.push({
            property: ids["Entity ID"],
            rich_text: { equals: identifier(input.entityId, "Entity ID") },
          })
      }
      const parameters = new URLSearchParams()
      for (const field of fields.filter((field) => field !== "Name"))
        parameters.append("filter_properties", ids[field])
      return {
        path: `v1/data_sources/${notionId(library.records.data_source_id, "Records data source ID")}/query?${parameters}`,
        filter: filters.length === 1 ? filters[0] : { and: filters },
        entityPropertyId: ids["Entity ID"],
      }
    })
    const rows: SharedProfileRecord[] = [],
      physical = new Set<string>(),
      cursors = new Set<string>()
    const records = new Map<string, string>(),
      entities = new Map<string, string>()
    let cursor: string | undefined
    for (;;) {
      const raw = yield* api.request(
        query.path,
        {
          page_size: 100,
          filter: query.filter,
          ...(cursor === undefined ? {} : { start_cursor: cursor }),
        },
        { method: "POST", entityPropertyId: query.entityPropertyId },
      )
      const page = yield* checked(() => {
        const outer = object(raw, "Profile query response")
        if (
          outer.object !== "list" ||
          (outer.request_status !== undefined &&
            object(outer.request_status, "Query status").type !== "complete")
        )
          throw invalid("Profile enumeration is incomplete.")
        const value = decode(listSchema(Schema.Unknown), outer)
        if (value.has_more) {
          const next = identifier(value.next_cursor, "Profile cursor", 2048)
          if (cursors.has(next)) throw invalid("Profile enumeration repeated a cursor.")
          cursors.add(next)
        } else if (value.next_cursor !== null)
          throw invalid("Complete Profile enumeration returned an unexpected cursor.")
        return value
      })
      for (const value of page.results) {
        const row = yield* verifiedRecord(value, library, input)
        if (physical.has(row.page_id))
          return yield* Effect.fail(
            invalid("Profile enumeration repeated a page.", { page_id: row.page_id }),
          )
        physical.add(row.page_id)
        const previous = records.get(row.record_id) ?? entities.get(row.entity_id)
        if (previous !== undefined)
          return yield* Effect.fail(
            fail(
              "SHARED_PROFILE_DUPLICATE",
              "A stable Profile identity has multiple current pages.",
              {
                profile_id: row.entity_id,
                record_id: row.record_id,
                page_ids: [previous, row.page_id],
              },
            ),
          )
        records.set(row.record_id, row.page_id)
        entities.set(row.entity_id, row.page_id)
        rows.push(row)
      }
      if (!page.has_more) return rows
      cursor = page.next_cursor!
    }
  }).pipe((effect) => withNotionRequestAttribution(effect, { skill_page_id: null }))
}

function sameFact(
  left: Omit<SharedProfileRecord, "page_id">,
  right: Omit<SharedProfileRecord, "page_id">,
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

export function writeCurrentSharedProfileRecord(
  library: SharedLibrary,
  input: {
    readonly current: SharedProfileRecord | null
    readonly recordId: string
    readonly operationId: string
    readonly entityId: string
    readonly payload: unknown
  },
): Effect.Effect<SharedProfileRecord, SkillsError, Notion | Crypto.Crypto> {
  return Effect.gen(function* () {
    const prepared = yield* checked(() => {
      const ids = fieldIds(library)
      const recordId = identifier(input.recordId, "Record ID")
      const entityId = identifier(input.entityId, "Entity ID")
      if (!/^profile-current-[a-f0-9]{64}$/u.test(recordId))
        throw invalid("A current Profile requires its stable Record ID.")
      if (
        input.current !== null &&
        (input.current.kind !== "profile" ||
          input.current.skill_page_id !== null ||
          input.current.record_id !== recordId ||
          input.current.entity_id !== entityId)
      )
        throw invalid("The observed current Profile has another identity.")
      const page =
        input.current === null ? null : notionId(input.current.page_id, "Profile page ID")
      const envelope = boundedEnvelope({
        version: 1,
        operation_id: input.operationId,
        payload: input.payload,
      })
      return { ids, recordId, entityId, page, ...envelope }
    })
    const hash = yield* sha256(prepared.canonical)
    const expected = {
      record_id: prepared.recordId,
      operation_id: prepared.operationId,
      skill_page_id: null,
      kind: "profile" as const,
      entity_id: prepared.entityId,
      hash,
      payload: prepared.payload,
    }
    const rich = (value: string) => ({ rich_text: textChunks(value) })
    const value = yield* (yield* Notion).request(
      prepared.page === null ? "v1/pages" : `v1/pages/${prepared.page}`,
      {
        ...(prepared.page === null
          ? { parent: { type: "data_source_id", data_source_id: library.records.data_source_id } }
          : {}),
        properties: {
          [prepared.ids.Name]: { title: textChunks(`profile: ${prepared.entityId}`) },
          [prepared.ids["Record ID"]]: rich(prepared.recordId),
          [prepared.ids.Kind]: { select: { name: "profile" } },
          [prepared.ids["Entity ID"]]: rich(prepared.entityId),
          [prepared.ids.Hash]: rich(hash),
          [prepared.ids.Payload]: rich(prepared.canonical),
          [prepared.ids.Skill]: { relation: [] },
          [prepared.ids.Origin]: { relation: [] },
        },
      },
      { method: prepared.page === null ? "POST" : "PATCH" },
    )
    const verified = yield* verifiedRecord(value, library, {
      recordId: prepared.recordId,
      entityId: prepared.entityId,
    }).pipe(
      Effect.mapError((error) =>
        fail(
          "WRITE_OUTCOME_UNKNOWN",
          "The Profile response could not be verified; reconcile current rules.",
          {
            record_id: prepared.recordId,
            operation_id: prepared.operationId,
            cause_code: error.code,
          },
        ),
      ),
    )
    if (
      verified.kind !== "profile" ||
      verified.skill_page_id !== null ||
      (prepared.page !== null && verified.page_id !== prepared.page) ||
      !sameFact(verified, expected)
    )
      return yield* Effect.fail(
        fail(
          "WRITE_OUTCOME_UNKNOWN",
          "The Profile response differs from the requested current rules.",
          {
            record_id: prepared.recordId,
            operation_id: prepared.operationId,
          },
        ),
      )
    return verified
  })
}
