import { Effect, Schema } from "effect"
import { fail, listSchema, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson, type SharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"

export type CurrentResourceOwner =
  | { readonly kind: "skill"; readonly page_id: string }
  | { readonly kind: "source"; readonly page_id: string }
export type CurrentSharedOperationRecord = {
  readonly page_id: string
  readonly record_id: string
  readonly operation_id: string
  readonly entity_id: string
  readonly owner: CurrentResourceOwner | null
  readonly hash: string
  readonly payload: SharedJson
}
export type CurrentSharedResourceRecord = Omit<CurrentSharedOperationRecord, "owner"> & {
  readonly kind: "resource"
  readonly owner: CurrentResourceOwner
}
const MAX_BYTES = 64 * 1024
const Envelope = Schema.Struct({
  version: Schema.Literal(1),
  operation_id: Schema.String,
  payload: Schema.Unknown,
})
const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_RECORD_INVALID", message, details)
const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) => (error instanceof SkillsError ? error : invalid("Invalid current Record.")),
  })
function identity(input: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(input))
    throw invalid("Use a stable bounded Record identity.")
  return input
}
function uuid(input: string): string {
  if (
    !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu.test(input)
  )
    throw invalid("Use an exact Notion identity.")
  const id = pageId(input)
  if (id === undefined) throw invalid("Invalid Notion identity.")
  return id
}
function binding(library: SharedLibrary, name: string): string {
  const id = library.records.property_ids[name]
  if (!id)
    throw fail("CURRENT_SCHEMA_REQUIRED", "A current Records property is missing.", {
      missing: name,
      next: "migrate_current_content",
    })
  return id
}
export function currentRecordText(value: string) {
  const parts: { type: "text"; text: { content: string } }[] = []
  let part = ""
  for (const char of value) {
    if (part.length + char.length > 1900) {
      parts.push({ type: "text", text: { content: part } })
      part = ""
    }
    part += char
  }
  if (part) parts.push({ type: "text", text: { content: part } })
  if (parts.length > 100) throw invalid("Current text exceeds one complete property.")
  return parts
}
function field(raw: unknown, id: string, type: string) {
  const values = Object.entries(property(property(raw).properties)).flatMap(([key, value]) => {
    const item = property(value)
    return key === id || item.id === id ? [item] : []
  })
  if (values.length !== 1 || values[0]?.type !== type)
    throw invalid("A registered Record property is missing, repeated or has a different type.", {
      property_id: id,
    })
  return values[0]
}
function rich(raw: unknown, id: string): string {
  const value = field(raw, id, "rich_text")
  if (!Array.isArray(value.rich_text) || value.rich_text.length > 100 || value.has_more === true)
    throw invalid("A current Record property is incomplete.")
  return value.rich_text
    .map((item) => {
      const part = property(item),
        value = part.plain_text ?? property(part.text).content
      if (typeof value !== "string" || value.length > 2000)
        throw invalid("Invalid current Record text.")
      return value
    })
    .join("")
}
function relation(raw: unknown, id: string): string[] {
  const value = field(raw, id, "relation")
  if (!Array.isArray(value.relation) || value.relation.length > 1 || value.has_more === true)
    throw invalid("Current Record ownership must be complete and singular.")
  return value.relation.map((item) => {
    const id = property(item).id
    if (typeof id !== "string") throw invalid("Invalid current Record owner.")
    return uuid(id)
  })
}
function envelope(operationId: string, payload: unknown) {
  identity(operationId)
  const encoded = canonicalSharedJson({ version: 1, operation_id: operationId, payload })
  if (new TextEncoder().encode(encoded).length > MAX_BYTES)
    throw fail(
      "CURRENT_RECORD_TOO_LARGE",
      "One current Record exceeds 64 KiB. Keep input bytes outside its intent and supply them again when resuming.",
      { max_bytes: MAX_BYTES },
    )
  const decoded = Schema.decodeUnknownSync(Envelope)(JSON.parse(encoded), {
    onExcessProperty: "error",
  })
  const normalized: SharedJson = JSON.parse(canonicalSharedJson(decoded.payload))
  return { encoded, payload: normalized }
}
function decodeRecord(library: SharedLibrary, input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* checked(() => {
      const row = property(input),
        parent = property(row.parent)
      if (
        row.object !== "page" ||
        typeof row.id !== "string" ||
        row.in_trash === true ||
        row.archived === true ||
        parent.type !== "data_source_id" ||
        typeof parent.data_source_id !== "string" ||
        uuid(parent.data_source_id) !== uuid(library.records.data_source_id) ||
        (parent.database_id !== undefined && parent.database_id !== library.records.database_id)
      )
        throw invalid("Current Records must be live pages in the registered table.")
      const recordId = identity(rich(row, binding(library, "Record ID"))),
        entityId = identity(rich(row, binding(library, "Entity ID")))
      const kind = property(field(row, binding(library, "Kind"), "select").select).name
      if (kind !== "resource" && kind !== "operation")
        throw invalid("The selected identity belongs to another Record kind.")
      const encoded = rich(row, binding(library, "Payload"))
      if (new TextEncoder().encode(encoded).length > MAX_BYTES)
        throw invalid("Current Record payload is too large.")
      const body = Schema.decodeUnknownSync(Envelope)(JSON.parse(encoded), {
        onExcessProperty: "error",
      })
      const canonical = envelope(body.operation_id, body.payload)
      const skill = relation(row, binding(library, "Skill"))
      const source = relation(row, binding(library, "Origin"))
      if (skill.length + source.length > 1)
        throw invalid("A current Record cannot claim several owner kinds.")
      const hash = rich(row, binding(library, "Hash"))
      if (!/^[a-f0-9]{64}$/u.test(hash)) throw invalid("Current Record hash is missing.")
      return {
        page_id: uuid(row.id),
        record_id: recordId,
        operation_id: body.operation_id,
        entity_id: entityId,
        kind,
        skill,
        source,
        hash,
        ...canonical,
      }
    })
    if ((yield* sha256(decoded.encoded)) !== decoded.hash)
      return yield* Effect.fail(invalid("Current Record payload differs from its hash."))
    return decoded
  })
}
function queryRows(library: SharedLibrary, filter: unknown, containsBody: boolean) {
  return Effect.gen(function* () {
    const api = yield* Notion,
      params = new URLSearchParams()
    for (const name of [
      "Name",
      "Record ID",
      "Kind",
      "Entity ID",
      "Hash",
      "Payload",
      "Skill",
      "Resource",
      "Origin",
    ])
      params.append("filter_properties", binding(library, name))
    const rows: unknown[] = [],
      physical = new Set<string>(),
      cursors = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const raw = yield* api.request(
        `v1/data_sources/${library.records.data_source_id}/query?${params}`,
        { page_size: 100, filter, ...(cursor === undefined ? {} : { start_cursor: cursor }) },
        { method: "POST", ...(containsBody ? { content: "body" as const } : {}) },
      )
      const list = yield* checked(() => {
        const outer = property(raw)
        if (
          outer.object !== "list" ||
          (outer.request_status !== undefined && property(outer.request_status).type !== "complete")
        )
          throw invalid("Current Record enumeration is incomplete.")
        const result = Schema.decodeUnknownSync(listSchema(Schema.Unknown))(raw)
        if (
          result.has_more
            ? !result.next_cursor || cursors.has(result.next_cursor)
            : result.next_cursor !== null
        )
          throw invalid("Current Record pagination did not complete or advance.")
        for (const row of result.results) {
          const id = property(row).id
          if (typeof id !== "string" || physical.has(uuid(id)))
            throw invalid("Current Record query repeats a physical page.")
          physical.add(uuid(id))
        }
        return result
      })
      rows.push(...list.results)
      if (!list.has_more) break
      cursor = list.next_cursor!
      cursors.add(cursor)
    }
    return rows
  })
}
function operationRecord(
  row: Awaited<ReturnType<typeof decodeRecord>> extends Effect.Effect<infer A, infer _E, infer _R>
    ? A
    : never,
): CurrentSharedOperationRecord {
  return {
    page_id: row.page_id,
    record_id: row.record_id,
    operation_id: row.operation_id,
    entity_id: row.entity_id,
    owner:
      row.skill[0] !== undefined
        ? { kind: "skill" as const, page_id: row.skill[0] }
        : row.source[0] !== undefined
          ? { kind: "source" as const, page_id: row.source[0] }
          : null,
    hash: row.hash,
    payload: row.payload,
  }
}
export function queryCurrentSharedOperationRecord(
  library: SharedLibrary,
  input: { readonly recordId: string; readonly entityId: string },
) {
  return Effect.gen(function* () {
    const filter = yield* checked(() => ({
      or: [
        {
          property: binding(library, "Record ID"),
          rich_text: { equals: identity(input.recordId) },
        },
        {
          property: binding(library, "Entity ID"),
          rich_text: { equals: identity(input.entityId) },
        },
      ],
    }))
    const rows = yield* queryRows(library, filter, false)
    if (rows.length === 0) return undefined
    if (rows.length !== 1)
      return yield* Effect.fail(
        fail(
          "CURRENT_OPERATION_CONFLICT",
          "Several current Records claim the same operation target.",
          {
            record_page_ids: rows.map((row) => property(row).id),
            record_id: input.recordId,
            entity_id: input.entityId,
          },
        ),
      )
    const row = yield* decodeRecord(library, rows[0])
    if (
      row.kind !== "operation" ||
      row.record_id !== input.recordId ||
      row.entity_id !== input.entityId
    )
      return yield* Effect.fail(
        fail(
          "CURRENT_OPERATION_CONFLICT",
          "Current operation identity is occupied by a different target.",
        ),
      )
    return operationRecord(row)
  })
}
/** Validate the bounded wire envelope before any handoff state is changed. */
export function assertCurrentOperationRecordSize(operationId: string, payload: unknown): void {
  const prepared = envelope(operationId, payload)
  // One bounded action marker and the finite cursor must still fit after handoff.
  if (new TextEncoder().encode(prepared.encoded).length > MAX_BYTES - 2048)
    throw fail(
      "CURRENT_RECORD_TOO_LARGE",
      "The current predecessor and successor leave no room for one in-flight action.",
      { phase: "input_rejected", max_bytes: MAX_BYTES, reserved_action_bytes: 2048 },
    )
}

type CurrentOperationRecordWrite = {
  readonly current: CurrentSharedOperationRecord | null
  readonly recordId: string
  readonly operationId: string
  readonly entityId: string
  readonly owner: CurrentResourceOwner | null
  readonly payload: unknown
}

export function writeCurrentSharedOperationRecord(
  library: SharedLibrary,
  input: CurrentOperationRecordWrite,
) {
  return writeOperationRecord(library, input, false)
}

/** Only the kernel's exact predecessor handoff may change this mutable Record's
 * operation. It does not provide a remote compare-and-swap. */
export function replaceCurrentSharedOperationRecord(
  library: SharedLibrary,
  input: CurrentOperationRecordWrite & { readonly current: CurrentSharedOperationRecord },
) {
  return writeOperationRecord(library, input, true)
}

function writeOperationRecord(
  library: SharedLibrary,
  input: CurrentOperationRecordWrite,
  replacing: boolean,
) {
  return Effect.gen(function* () {
    const prepared = yield* checked(() => {
      identity(input.recordId)
      identity(input.entityId)
      if (
        input.current !== null &&
        (input.current.record_id !== input.recordId ||
          input.current.entity_id !== input.entityId ||
          (!replacing && input.current.operation_id !== input.operationId))
      )
        throw fail("CURRENT_OPERATION_CONFLICT", "Cannot replace a different current operation.")
      if (input.owner !== null && input.owner.kind !== "skill" && input.owner.kind !== "source")
        throw invalid("A current Operation needs an exact Skill or Source owner.")
      const owner =
        input.owner === null ? null : { kind: input.owner.kind, page_id: uuid(input.owner.page_id) }
      if (
        input.current?.owner != null &&
        canonicalSharedJson(input.current.owner) !== canonicalSharedJson(owner)
      )
        throw fail("CURRENT_OPERATION_CONFLICT", "A bound current operation cannot change owner.")
      return { ...envelope(input.operationId, input.payload), owner }
    })
    const hash = yield* sha256(prepared.encoded),
      rich = (value: string) => ({ rich_text: currentRecordText(value) })
    const properties = {
      [binding(library, "Name")]: { title: currentRecordText(`operation: ${input.entityId}`) },
      [binding(library, "Record ID")]: rich(input.recordId),
      [binding(library, "Kind")]: { select: { name: "operation" } },
      [binding(library, "Entity ID")]: rich(input.entityId),
      [binding(library, "Hash")]: rich(hash),
      [binding(library, "Payload")]: rich(prepared.encoded),
      [binding(library, "Skill")]: {
        relation: prepared.owner?.kind === "skill" ? [{ id: prepared.owner.page_id }] : [],
      },
      [binding(library, "Origin")]: {
        relation: prepared.owner?.kind === "source" ? [{ id: prepared.owner.page_id }] : [],
      },
    }
    const raw = yield* (yield* Notion).request(
      input.current === null ? "v1/pages" : `v1/pages/${uuid(input.current.page_id)}`,
      {
        ...(input.current === null
          ? { parent: { type: "data_source_id", data_source_id: library.records.data_source_id } }
          : {}),
        properties,
      },
      { method: input.current === null ? "POST" : "PATCH" },
    )
    const row = yield* decodeRecord(library, raw).pipe(
      Effect.mapError((error) =>
        fail("WRITE_OUTCOME_UNKNOWN", "Current operation write returned an unverifiable result.", {
          cause_code: error.code,
          record_id: input.recordId,
        }),
      ),
    )
    if (
      row.kind !== "operation" ||
      row.record_id !== input.recordId ||
      row.entity_id !== input.entityId ||
      row.operation_id !== input.operationId ||
      row.hash !== hash ||
      canonicalSharedJson(operationRecord(row).owner) !== canonicalSharedJson(prepared.owner) ||
      (input.current !== null && row.page_id !== input.current.page_id)
    )
      return yield* Effect.fail(
        fail("WRITE_OUTCOME_UNKNOWN", "Current operation write differs from its intended result.", {
          record_id: input.recordId,
        }),
      )
    return operationRecord(row)
  })
}
export function archiveCurrentSharedOperationRecord(
  library: SharedLibrary,
  record: CurrentSharedOperationRecord,
) {
  return Effect.gen(function* () {
    const id = yield* checked(() => {
      binding(library, "Record ID")
      return uuid(record.page_id)
    })
    const raw = property(
      yield* (yield* Notion).request(`v1/pages/${id}`, { in_trash: true }, { method: "PATCH" }),
    )
    if (raw.object !== "page" || raw.id !== id || raw.in_trash !== true)
      return yield* Effect.fail(
        fail("WRITE_OUTCOME_UNKNOWN", "Current operation retirement was not confirmed.", {
          record_id: record.record_id,
        }),
      )
  })
}

export function currentOwnedResourceFromPage(
  library: SharedLibrary,
  raw: unknown,
  input: { readonly owner: CurrentResourceOwner; readonly objectId: string },
) {
  return Effect.gen(function* () {
    const row = yield* decodeRecord(library, raw)
    const actualOwner = input.owner.kind === "skill" ? row.skill : row.source
    if (
      row.kind !== "resource" ||
      row.record_id !== input.objectId ||
      row.entity_id !== input.objectId ||
      row.operation_id !== `store-${input.objectId}` ||
      actualOwner.length !== 1 ||
      actualOwner[0] !== uuid(input.owner.page_id)
    )
      return yield* Effect.fail(
        invalid("Current resource identity and owner differ from its descriptor."),
      )
    const resource = yield* checked(() => field(raw, binding(library, "Resource"), "files"))
    return {
      record: {
        page_id: row.page_id,
        record_id: row.record_id,
        operation_id: row.operation_id,
        entity_id: row.entity_id,
        kind: "resource",
        owner: input.owner,
        hash: row.hash,
        payload: row.payload,
      } satisfies CurrentSharedResourceRecord,
      resource,
    }
  })
}

export function queryCurrentOwnedResourceRecord(
  library: SharedLibrary,
  input: { readonly owner: CurrentResourceOwner; readonly objectId: string },
) {
  return Effect.gen(function* () {
    const filter = yield* checked(() => ({
      and: [
        {
          property: binding(library, input.owner.kind === "skill" ? "Skill" : "Origin"),
          relation: { contains: uuid(input.owner.page_id) },
        },
        {
          or: [
            {
              property: binding(library, "Record ID"),
              rich_text: { equals: identity(input.objectId) },
            },
            {
              property: binding(library, "Entity ID"),
              rich_text: { equals: identity(input.objectId) },
            },
          ],
        },
      ],
    }))
    const rows = yield* queryRows(library, filter, true)
    if (rows.length === 0) return undefined
    if (rows.length !== 1)
      return yield* Effect.fail(
        fail(
          "CURRENT_RESOURCE_DUPLICATE",
          "Several current rows claim the same resource owner and identity.",
        ),
      )
    return yield* currentOwnedResourceFromPage(library, rows[0], input)
  })
}

/** Complete current resources for one owner, used for one write's reuse and
 * reachability cleanup. No event or former-content lookups are involved. */
export function listCurrentOwnedResourceRecords(
  library: SharedLibrary,
  owner: CurrentResourceOwner,
) {
  return Effect.gen(function* () {
    const filter = yield* checked(() => {
      const ownerFilter = {
        property: binding(library, owner.kind === "skill" ? "Skill" : "Origin"),
        relation: { contains: uuid(owner.page_id) },
      }
      const kind = (name: string) => ({
        property: binding(library, "Kind"),
        select: { equals: name },
      })
      return {
        or: [
          { and: [ownerFilter, kind("resource")] },
          {
            and: [
              ownerFilter,
              kind("operation"),
              {
                property: binding(library, "Record ID"),
                rich_text: { starts_with: "operation-current-" },
              },
            ],
          },
        ],
      }
    })
    const rows = yield* queryRows(library, filter, true)
    const result: Effect.Success<ReturnType<typeof currentOwnedResourceFromPage>>[] = []
    const identities = new Set<string>()
    let operations = 0
    for (const raw of rows) {
      const decoded = yield* decodeRecord(library, raw)
      if (decoded.kind === "operation") {
        if (
          (owner.kind === "skill" ? decoded.skill[0] : decoded.source[0]) !== uuid(owner.page_id) ||
          !/^operation-current-[a-f0-9]{64}$/u.test(decoded.record_id) ||
          !new RegExp(`^current-${owner.kind}:[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$`, "u").test(
            decoded.entity_id,
          ) ||
          ++operations > 1
        )
          return yield* Effect.fail(
            invalid("The complete owner inventory contains conflicting current intents."),
          )
        continue
      }
      const objectId = yield* checked(() => rich(raw, binding(library, "Record ID")))
      if (identities.has(objectId))
        return yield* Effect.fail(
          invalid("Current resources repeat a logical identity within one owner.", {
            object_id: objectId,
          }),
        )
      identities.add(objectId)
      result.push(yield* currentOwnedResourceFromPage(library, raw, { owner, objectId }))
    }
    return result
  })
}

/** A request value lets the finite writer persist its action before dispatch. */
export function currentOwnedResourceCreateRequest(
  library: SharedLibrary,
  input: {
    readonly owner: CurrentResourceOwner
    readonly objectId: string
    readonly payload: unknown
    readonly upload?: { readonly id: string; readonly name: string }
  },
) {
  return Effect.gen(function* () {
    const prepared = yield* checked(() => {
      identity(input.objectId)
      uuid(input.owner.page_id)
      if (input.upload !== undefined) {
        uuid(input.upload.id)
        if (!input.upload.name || input.upload.name.length > 255)
          throw invalid("Invalid original filename.")
      }
      return envelope(`store-${input.objectId}`, input.payload)
    })
    const hash = yield* sha256(prepared.encoded),
      rich = (value: string) => ({ rich_text: currentRecordText(value) })
    return {
      path: "v1/pages",
      body: {
        parent: { type: "data_source_id", data_source_id: library.records.data_source_id },
        properties: {
          [binding(library, "Name")]: { title: currentRecordText(`resource: ${input.objectId}`) },
          [binding(library, "Record ID")]: rich(input.objectId),
          [binding(library, "Entity ID")]: rich(input.objectId),
          [binding(library, "Kind")]: { select: { name: "resource" } },
          [binding(library, "Hash")]: rich(hash),
          [binding(library, "Payload")]: rich(prepared.encoded),
          [binding(library, "Skill")]: {
            relation: input.owner.kind === "skill" ? [{ id: input.owner.page_id }] : [],
          },
          [binding(library, "Origin")]: {
            relation: input.owner.kind === "source" ? [{ id: input.owner.page_id }] : [],
          },
          [binding(library, "Resource")]: {
            files:
              input.upload === undefined
                ? []
                : [
                    {
                      name: input.upload.name,
                      type: "file_upload",
                      file_upload: { id: input.upload.id },
                    },
                  ],
          },
        },
      },
      options: { method: "POST" as const, content: "body" as const },
    }
  })
}
