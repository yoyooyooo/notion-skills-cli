import { Clock, Effect, Schema } from "effect"
import { fail, property, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { normalizePath, pageId } from "./ref.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256, Store } from "./store.ts"
import {
  SourceDefinitionInputSchema,
  SourceMutationAcknowledgementSchema,
  sourceDefinitionProperties,
  type SourceDefinitionInput,
  type SourceDefinition,
} from "./shared-sources-model.ts"
import { validateGitSource, validateSourceSelection } from "./upstream-source.ts"

export const sourceChecked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SOURCE_DEFINITION_INVALID", "Invalid source configuration or response."),
  })
export function sourceTable(library: SharedLibrary) {
  if (!library.sources)
    throw fail(
      "SOURCES_NOT_ATTACHED",
      "Attach the Sources database before managing live source definitions.",
    )
  return library.sources
}
export function sourceField(row: unknown, id: string) {
  const fields = Object.values(property(property(row).properties))
    .map(property)
    .filter((field) => field.id === id)
  if (fields.length !== 1)
    throw fail("SOURCE_DEFINITION_INVALID", "A required stable property is missing or ambiguous.", {
      property_id: id,
    })
  return fields[0]!
}
export function sourceRich(content: string) {
  const chunks: Array<{ type: "text"; text: { content: string } }> = []
  let current = ""
  for (const char of content) {
    if (current.length + char.length > 1900) {
      chunks.push({ type: "text", text: { content: current } })
      current = ""
    }
    current += char
  }
  if (current) chunks.push({ type: "text", text: { content: current } })
  if (chunks.length > 100)
    throw fail(
      "SOURCE_DEFINITION_TOO_LARGE",
      "One native source property exceeds 100 rich-text parts.",
    )
  return chunks
}
const bounded = (value: string, label: string, max = 2048) => {
  if (!value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value))
    throw fail("SOURCE_DEFINITION_INVALID", `Invalid ${label}.`)
}
const SourceMutationReceiptSchema = Schema.Struct({
  version: Schema.Literal(1),
  operation_id: Schema.String,
  request_hash: Schema.String,
  response_hash: Schema.String,
  acknowledged_at: Schema.Number,
  verified: Schema.Literal(true),
})
function observedSourceMutation(
  operation: string,
  current: unknown,
  acknowledgement?: typeof SourceMutationAcknowledgementSchema.Type,
  completed = false,
) {
  return {
    status: "observed_current" as const,
    original_outcome: completed || acknowledgement ? ("applied" as const) : ("unknown" as const),
    operation_id: operation,
    result: current,
    ...(acknowledgement === undefined
      ? {}
      : { response_page_id: property(acknowledgement.response).id }),
  }
}
function rejectCredentials(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectCredentials(item)
    return
  }
  if (value === null || typeof value !== "object") return
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:token|api[_-]?key|password|authorization|headers|credential|secret)$/iu.test(key))
      throw fail(
        "SOURCE_SECRET_FORBIDDEN",
        "Source definitions must not store credentials or arbitrary headers.",
      )
    rejectCredentials(child)
  }
}
export function validateSourceDefinition(value: unknown): SourceDefinitionInput {
  const result = Schema.decodeUnknownSync(SourceDefinitionInputSchema)(structuredClone(value), {
    onExcessProperty: "error",
  })
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/u.test(result.source_id))
    throw fail("SOURCE_DEFINITION_INVALID", "Use a stable bounded Source ID.")
  bounded(result.name, "source name", 200)
  if (result.description.length > 12000)
    throw fail("SOURCE_DEFINITION_TOO_LARGE", "Description exceeds 12000 characters.")
  rejectCredentials(result)
  const interval = result.options.check_interval_ms
  if (
    (result.policy === "auto" && interval === undefined) ||
    (interval !== undefined &&
      (typeof interval !== "number" ||
        !Number.isSafeInteger(interval) ||
        interval < 60_000 ||
        interval > 366 * 24 * 60 * 60 * 1000))
  )
    throw fail(
      "SOURCE_INTERVAL_INVALID",
      "Automatic checks require an explicit check_interval_ms between one minute and 366 days.",
    )
  validateSourceSelection(result.selection)
  const adapter = result.adapter
  if (adapter.type === "git") {
    validateGitSource(adapter.url, adapter.ref)
    if (!/^(?:https?:\/\/|ssh:\/\/|git@[A-Za-z0-9.-]+:)/u.test(adapter.url))
      throw fail(
        "SOURCE_LOCAL_PATH_FORBIDDEN",
        "Shared Git sources require HTTP(S) or SSH; local paths are machine-only resources.",
      )
    if (result.policy === "pinned" && !/^[a-f0-9]{40,64}$/u.test(adapter.ref))
      throw fail("SOURCE_PIN_REQUIRED", "Pinned Git sources require a full commit identity.")
  } else if (adapter.type === "linear") {
    if (result.policy === "pinned")
      throw fail(
        "SOURCE_PIN_REQUIRED",
        "Linear is mutable; freeze a fetched snapshot instead of claiming a historical API revision.",
      )
    if (adapter.resources.length < 1 || adapter.resources.length > 80)
      throw fail("SOURCE_DEFINITION_INVALID", "Select one to 80 exact Linear resources.")
    const paths = new Set<string>()
    for (const item of adapter.resources) {
      if (
        !/^(?:[A-Za-z][A-Za-z0-9]*-[0-9]+|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/u.test(
          item.id,
        ) ||
        (item.kind === "document" && !pageId(item.id))
      )
        throw fail("SOURCE_DEFINITION_INVALID", "Use an exact issue identifier or document UUID.")
      if (normalizePath(item.path) !== item.path || !item.path || paths.has(item.path))
        throw fail(
          "SOURCE_DEFINITION_INVALID",
          "Linear output paths must be unique safe relative paths.",
        )
      paths.add(item.path)
    }
    if (!paths.has("SKILL.md"))
      throw fail(
        "SOURCE_DEFINITION_INVALID",
        "Linear resource mapping requires an explicit SKILL.md entry.",
      )
  } else {
    const url = new URL(adapter.type === "registry" ? adapter.base_url : adapter.url)
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw fail("SOURCE_SECRET_FORBIDDEN", "Use a credential-free HTTPS source location.")
    if (
      result.policy === "pinned" &&
      !(adapter.type === "registry" ? adapter.version : adapter.ref)
    )
      throw fail("SOURCE_PIN_REQUIRED", "Pinned sources require an explicit revision.")
  }
  sourceRich(canonicalSharedJson(result.options))
  sourceRich(canonicalSharedJson(result.selection))
  return result
}

/** Native observation metadata is not executable provider configuration. Keep
 * unknown configuration fields strict, but do not feed read receipts to the
 * adapter's exact input schema. */
export function sourceConfiguration(
  definition: SourceDefinitionInput | SourceDefinition,
): SourceDefinitionInput {
  const {
    page_id: _page,
    fingerprint: _fingerprint,
    status: _status,
    last_revision: _revision,
    last_checked: _checked,
    last_result: _result,
    ...configuration
  } = definition as SourceDefinition
  return validateSourceDefinition(configuration)
}
export function sourceDefinitionPropertiesFor(
  library: SharedLibrary,
  input: SourceDefinitionInput,
) {
  const value = validateSourceDefinition(input),
    ids = sourceTable(library).property_ids
  const a = value.adapter
  const location =
    a.type === "linear" ? "https://linear.app" : a.type === "registry" ? a.base_url : a.url
  const ref =
    a.type === "linear" ? "" : a.type === "registry" ? (a.version ?? "") : (a.ref ?? "HEAD")
  const details =
    a.type === "linear"
      ? { resources: a.resources }
      : a.type === "registry"
        ? { owner: a.owner, slug: a.slug }
        : {}
  return {
    [ids.Name!]: { title: sourceRich(value.name) },
    [ids["Source ID"]!]: { rich_text: sourceRich(value.source_id) },
    [ids.Description!]: { rich_text: sourceRich(value.description) },
    [ids.Provider!]: { select: { name: a.type } },
    [ids.Location!]: { rich_text: sourceRich(location) },
    [ids.Ref!]: { rich_text: sourceRich(ref) },
    [ids.Selection!]: { rich_text: sourceRich(canonicalSharedJson(value.selection)) },
    [ids.Options!]: {
      rich_text: sourceRich(
        canonicalSharedJson({ version: 1, adapter: details, settings: value.options }),
      ),
    },
    [ids.Enabled!]: { checkbox: value.enabled },
    [ids.Policy!]: { select: { name: value.policy } },
  }
}
function sourceRow(library: SharedLibrary, raw: unknown) {
  const row = property(raw),
    table = sourceTable(library),
    ids = table.property_ids
  if (
    row.object !== "page" ||
    typeof row.id !== "string" ||
    pageId(row.id) !== row.id ||
    row.in_trash === true ||
    row.archived === true ||
    property(row.parent).data_source_id !== table.data_source_id
  )
    throw fail(
      "SOURCE_DEFINITION_SCOPE",
      "Source page is unavailable or belongs to another library.",
    )
  const value = (name: string) => sourceField(row, ids[name]!)
  const rich = (name: string) => text(value(name).rich_text)
  const selected = (name: string) => property(value(name).select).name
  return { row, value, rich, selected, page_id: row.id }
}
export function decodeSourceDefinition(
  library: SharedLibrary,
  raw: unknown,
): SourceDefinitionInput {
  const { value, rich, selected } = sourceRow(library, raw)
  const type = selected("Provider"),
    options = property(JSON.parse(rich("Options"))),
    details = property(options.adapter)
  const adapterKeys = Object.keys(details).sort().join(",")
  if (adapterKeys !== (type === "linear" ? "resources" : type === "registry" ? "owner,slug" : ""))
    throw fail("SOURCE_DEFINITION_INVALID", "Adapter options contain unknown or missing fields.")
  if (type === "linear" && (rich("Location") !== "https://linear.app" || rich("Ref") !== ""))
    throw fail(
      "SOURCE_DEFINITION_INVALID",
      "Linear uses the fixed official endpoint and explicit resource mapping, not a configurable host or revision.",
    )
  if (options.version !== 1 || Object.keys(options).sort().join(",") !== "adapter,settings,version")
    throw fail(
      "SOURCE_DEFINITION_INVALID",
      "Options requires the versioned adapter/settings envelope.",
    )
  let adapter: unknown
  if (type === "linear") adapter = { type, resources: details.resources }
  else if (type === "registry")
    adapter = {
      type,
      base_url: rich("Location"),
      owner: details.owner,
      slug: details.slug,
      ...(rich("Ref") ? { version: rich("Ref") } : {}),
    }
  else adapter = { type, url: rich("Location"), ref: rich("Ref") }
  return validateSourceDefinition({
    version: 1,
    source_id: rich("Source ID"),
    name: text(value("Name").title),
    description: rich("Description"),
    enabled: value("Enabled").checkbox,
    policy: selected("Policy"),
    adapter,
    selection: JSON.parse(rich("Selection")),
    options: options.settings,
  })
}
const listFields = [
  "Name",
  "Source ID",
  "Description",
  "Provider",
  "Location",
  "Ref",
  "Enabled",
  "Policy",
  "Status",
  "Last Revision",
  "Last Checked",
  "Last Result",
]
export function listSourceDefinitions(library: SharedLibrary, sourceId?: string) {
  return Effect.gen(function* () {
    const table = yield* sourceChecked(() => sourceTable(library)),
      api = yield* Notion
    const query = new URLSearchParams()
    for (const name of listFields) query.append("filter_properties", table.property_ids[name]!)
    const result: Array<{
      page_id: string
      source_id: string
      name: string
      description: string
      provider: string
      location: string
      ref: string
      enabled: boolean
      policy: string
      status: string
      last_revision: string
      last_checked: number | null
      last_result: string
    }> = []
    const pages = new Set<string>(),
      identities = new Set<string>(),
      cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const raw = property(
        yield* api.request(`v1/data_sources/${table.data_source_id}/query?${query}`, {
          page_size: 100,
          ...(sourceId
            ? {
                filter: {
                  property: table.property_ids["Source ID"],
                  rich_text: { equals: sourceId },
                },
              }
            : {}),
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      )
      yield* sourceChecked(() => {
        if (
          raw.object !== "list" ||
          !Array.isArray(raw.results) ||
          typeof raw.has_more !== "boolean" ||
          (raw.request_status && property(raw.request_status).type !== "complete")
        )
          throw fail("SOURCES_INCOMPLETE", "Incomplete Sources inventory.")
      })
      for (const item of raw.results as unknown[]) {
        const decoded = yield* sourceChecked(() => {
          const { page_id, rich, value, selected } = sourceRow(library, item),
            id = rich("Source ID")
          if (!id || pages.has(page_id) || identities.has(id) || (sourceId && id !== sourceId))
            throw fail("SOURCE_ID_CONFLICT", "Repeated, missing or out-of-scope Source identity.")
          pages.add(page_id)
          identities.add(id)
          return {
            page_id,
            source_id: id,
            name: text(value("Name").title),
            description: rich("Description"),
            provider: String(selected("Provider")),
            location: rich("Location"),
            ref: rich("Ref"),
            enabled: value("Enabled").checkbox === true,
            policy: String(selected("Policy")),
            status: String(selected("Status") ?? "ready"),
            last_revision: rich("Last Revision"),
            last_checked: sourceCheckTime(value("Last Checked")),
            last_result: rich("Last Result"),
          }
        })
        result.push(decoded)
      }
      cursor = yield* sourceChecked(() => {
        if (!raw.has_more) {
          if (raw.next_cursor !== null)
            throw fail("SOURCES_INCOMPLETE", "Unexpected terminal cursor.")
          return undefined
        }
        if (typeof raw.next_cursor !== "string" || !raw.next_cursor || cursors.has(raw.next_cursor))
          throw fail("SOURCES_INCOMPLETE", "Invalid Sources pagination cursor.")
        cursors.add(raw.next_cursor)
        return raw.next_cursor
      })
    } while (cursor)
    return result
  })
}
export function readSourceDefinition(library: SharedLibrary, selector: string) {
  return Effect.gen(function* () {
    let id = pageId(selector)
    if (!id) {
      const rows = yield* listSourceDefinitions(library, selector)
      if (rows.length !== 1)
        return yield* Effect.fail(fail("SOURCE_NOT_FOUND", "Select an exact Source ID or page ID."))
      id = rows[0]!.page_id
    }
    const api = yield* Notion
    const raw = structuredClone(property(yield* api.request(`v1/pages/${id}`)))
    // Large JSON must never be accepted from an inline property preview.
    for (const name of ["Options", "Selection"]) {
      const prop = yield* sourceChecked(() =>
        sourceField(raw, sourceTable(library).property_ids[name]!),
      )
      if (!Array.isArray(prop.rich_text))
        return yield* Effect.fail(
          fail("SOURCE_DEFINITION_INVALID", "Configuration is not rich text."),
        )
      if (prop.rich_text.length < 25 && prop.has_more !== true) continue
      const items: unknown[] = [],
        cursors = new Set<string>()
      let cursor: string | undefined
      do {
        const query = new URLSearchParams({
          page_size: "100",
          ...(cursor ? { start_cursor: cursor } : {}),
        })
        const page = property(yield* api.request(`v1/pages/${id}/properties/${prop.id}?${query}`))
        yield* sourceChecked(() => {
          if (page.object !== "list" || !Array.isArray(page.results))
            throw fail("SOURCES_INCOMPLETE", "Configuration property pagination is incomplete.")
          for (const entry of page.results) {
            const item = property(entry)
            if (item.id !== prop.id || item.type !== "rich_text")
              throw fail("SOURCE_DEFINITION_SCOPE", "Unexpected property item.")
            items.push(item.rich_text)
          }
          if (page.has_more) {
            if (typeof page.next_cursor !== "string" || cursors.has(page.next_cursor))
              throw fail("SOURCES_INCOMPLETE", "Repeated configuration cursor.")
            cursors.add(page.next_cursor)
            cursor = page.next_cursor
          } else {
            if (page.next_cursor !== null)
              throw fail("SOURCES_INCOMPLETE", "Invalid terminal property cursor.")
            cursor = undefined
          }
        })
      } while (cursor)
      prop.rich_text = items
    }
    const definition = yield* sourceChecked(() => decodeSourceDefinition(library, raw))
    const fingerprint = yield* sha256(canonicalSharedJson(definition))
    return {
      ...definition,
      page_id: id,
      fingerprint,
      status: String(
        property(sourceField(raw, sourceTable(library).property_ids.Status!).select).name ??
          "ready",
      ),
      last_revision: text(
        sourceField(raw, sourceTable(library).property_ids["Last Revision"]!).rich_text,
      ),
      last_checked: yield* sourceChecked(() =>
        sourceCheckTime(sourceField(raw, sourceTable(library).property_ids["Last Checked"]!)),
      ),
      last_result: text(
        sourceField(raw, sourceTable(library).property_ids["Last Result"]!).rich_text,
      ),
    } satisfies SourceDefinition
  })
}

function sourceCheckTime(field: Record<string, unknown>): number | null {
  const start = property(field.date).start
  if (start === undefined || start === null) return null
  if (typeof start !== "string" || !Number.isFinite(Date.parse(start)))
    throw fail("SOURCE_CHECK_TIME_INVALID", "Last Checked is not a complete timestamp.")
  return Date.parse(start)
}

/** One local frozen dispatch per exact mutation. A repeated unknown dispatch only
 * observes current state. This is not cross-machine CAS or automatic retry. */
export function guardedSourceMutation<R, R2 = never>(
  library: SharedLibrary,
  input: {
    identity: string
    path: string
    method: "POST" | "PATCH"
    body: unknown
    dryRun?: boolean
    /** Original multi-stage operations may reconcile this exact mutation, never dispatch a later generation. */
    repeat?: "never"
    beforeDispatch?: Effect.Effect<void, SkillsError, R2>
  },
  observe: Effect.Effect<unknown | undefined, SkillsError, R>,
) {
  return Effect.gen(function* () {
    const api = yield* Notion,
      store = yield* Store
    const scope = yield* sha256(
      canonicalSharedJson([
        yield* api.credentialIdentity,
        library.library_id,
        library.sources?.data_source_id ?? null,
      ]),
    )
    const request = {
      identity: input.identity,
      path: input.path,
      method: input.method,
      body: input.body,
    }
    const root = `operations/shared-sources/${scope}/`
    let operation = `source-op-${yield* sha256(canonicalSharedJson(request))}`
    let key = ""
    let receiptKey = ""
    let acknowledgementKey = ""
    let frozen: { version: number; operation: string } & typeof request
    // A previously VERIFIED A->B does not forbid a later explicitly guarded
    // A->B after B->A. Unacknowledged attempts remain immutable replay barriers.
    for (let generation = 0; ; generation++) {
      if (generation >= 1000)
        return yield* Effect.fail(
          fail(
            "SOURCE_OPERATION_LIMIT",
            "Source mutation history exceeds the bounded continuation depth.",
          ),
        )
      key = `${root}${operation}.json`
      receiptKey = `${root}source-receipt-${operation.slice("source-op-".length)}.json`
      acknowledgementKey = `${root}source-ack-${operation.slice("source-op-".length)}.json`
      frozen = { version: 1, operation, ...request }
      const pending = yield* store.readJson(key, Schema.Unknown)
      const completion = yield* store.readJson(receiptKey, Schema.Unknown)
      const acknowledged = yield* store.readJson(
        acknowledgementKey,
        SourceMutationAcknowledgementSchema,
      )
      if (pending === undefined) {
        if (completion !== undefined || acknowledged !== undefined)
          return yield* Effect.fail(
            fail("SOURCE_OPERATION_CONFLICT", "Source completion has no original dispatch."),
          )
        // Credential rotation cannot authorize the same frozen dispatch again.
        // Match only its exact opaque address; other scopes' private contents
        // and ACKs remain unreadable, so current equality is still not proof.
        const originalAddress = new RegExp(
          `^operations/shared-sources/[a-f0-9]{64}/${operation}\\.json$`,
          "u",
        )
        if (
          (yield* store.listKeys("operations/shared-sources/")).some(
            (otherKey) => otherKey !== key && originalAddress.test(otherKey),
          )
        ) {
          const current = yield* observe
          if (current !== undefined) return observedSourceMutation(operation, current)
          return yield* Effect.fail(
            fail(
              "SOURCE_WRITE_UNKNOWN",
              "This exact mutation already has an original dispatch in another local scope; observe it without repeating the request.",
              { operation_id: operation, identity: input.identity },
            ),
          )
        }
        break
      }
      if (canonicalSharedJson(pending) !== canonicalSharedJson(frozen))
        return yield* Effect.fail(
          fail("SOURCE_OPERATION_CONFLICT", "Frozen source mutation changed."),
        )
      if (
        acknowledged &&
        (acknowledged.operation_id !== operation ||
          acknowledged.request_hash !== (yield* sha256(canonicalSharedJson(frozen))) ||
          acknowledged.response_hash !==
            (yield* sha256(canonicalSharedJson(acknowledged.response))) ||
          !Number.isSafeInteger(acknowledged.acknowledged_at) ||
          acknowledged.acknowledged_at < 0)
      )
        return yield* Effect.fail(
          fail(
            "SOURCE_OPERATION_CONFLICT",
            "The original acknowledged response differs from its frozen dispatch.",
          ),
        )
      const receipt =
        completion === undefined
          ? undefined
          : yield* sourceChecked(() =>
              Schema.decodeUnknownSync(SourceMutationReceiptSchema)(completion, {
                onExcessProperty: "error",
              }),
            )
      if (
        receipt &&
        (receipt.operation_id !== operation ||
          receipt.request_hash !== (yield* sha256(canonicalSharedJson(frozen))) ||
          (acknowledged !== undefined && receipt.response_hash !== acknowledged.response_hash))
      )
        return yield* Effect.fail(
          fail(
            "SOURCE_OPERATION_CONFLICT",
            "Acknowledged source receipt does not match its dispatch.",
          ),
        )
      const current = yield* observe
      if (current !== undefined) {
        // Read-only reconciliation may save local proof after the original ACK;
        // it never invents an ACK from current equality or repeats the request.
        if (!receipt && acknowledged) {
          const { response: _response, ...proof } = acknowledged
          yield* store.writeJson(receiptKey, { ...proof, verified: true })
        }
        return observedSourceMutation(operation, current, acknowledged, receipt !== undefined)
      }
      if (!receipt && acknowledged)
        return yield* Effect.fail(
          fail(
            "SOURCE_WRITE_MISMATCH",
            "The original request was acknowledged, but current readback differs. Preserve its response and reconcile without repeating the mutation.",
            { operation_id: operation, identity: input.identity, acknowledged: true },
          ),
        )
      if (!receipt || input.method === "POST" || input.repeat === "never")
        return yield* Effect.fail(
          fail(
            "SOURCE_WRITE_UNKNOWN",
            "Original source mutation is unresolved or its created object disappeared; do not repeat it.",
            { operation_id: operation, identity: input.identity },
          ),
        )
      operation = `source-op-${yield* sha256(canonicalSharedJson([operation, receipt]))}`
    }
    // A changed request cannot evade an unresolved attempt on the same logical
    // definition. Readers may still observe it; a second mutation must wait.
    for (const otherKey of yield* store.listKeys(root)) {
      if (otherKey === key || !/\/source-op-[a-f0-9]{64}\.json$/u.test(otherKey)) continue
      const other = property(yield* store.readJson(otherKey, Schema.Unknown))
      if (other.identity !== input.identity || other.path !== input.path) continue
      const acknowledged = yield* store.readJson(
        otherKey.replace("/source-op-", "/source-receipt-"),
        Schema.Unknown,
      )
      if (acknowledged === undefined)
        return yield* Effect.fail(
          fail(
            "SOURCE_WRITE_PENDING",
            "An earlier unresolved request owns this logical source mutation; changed input cannot replace it.",
            { operation_id: other.operation, identity: input.identity },
          ),
        )
    }
    if (input.dryRun)
      return { status: "planned", dry_run: true, operation_id: operation, request: input.body }
    if (input.beforeDispatch !== undefined) yield* input.beforeDispatch
    yield* store.writeJson(key, frozen)
    const response = yield* api
      .request(input.path, input.body, { method: input.method })
      .pipe(
        Effect.mapError((error) =>
          fail(
            "SOURCE_WRITE_UNKNOWN",
            "Source request did not produce a verified result; inspect the original operation.",
            { operation_id: operation, cause_code: error.code },
          ),
        ),
      )
    const acknowledgement = yield* Effect.gen(function* () {
      const proof = {
        version: 1 as const,
        operation_id: operation,
        request_hash: yield* sha256(canonicalSharedJson(frozen!)),
        response_hash: yield* sha256(canonicalSharedJson(response)),
        acknowledged_at: yield* Clock.currentTimeMillis,
        response,
      }
      yield* store.writeJson(acknowledgementKey, proof)
      return proof
    }).pipe(
      Effect.mapError((error) =>
        fail(
          "SOURCE_WRITE_UNKNOWN",
          "The response could not be durably acknowledged. Preserve the original dispatch and do not repeat it.",
          { operation_id: operation, cause_code: error.code },
        ),
      ),
    )
    const current = yield* observe
    if (current === undefined)
      return yield* Effect.fail(
        fail(
          "SOURCE_WRITE_MISMATCH",
          "Source mutation readback differs; preserve the original request.",
          { operation_id: operation },
        ),
      )
    yield* store.writeJson(receiptKey, {
      version: 1,
      operation_id: operation,
      request_hash: acknowledgement.request_hash,
      response_hash: acknowledgement.response_hash,
      acknowledged_at: acknowledgement.acknowledged_at,
      verified: true,
    })
    return {
      status: "applied",
      verified: true,
      operation_id: operation,
      result: current,
      response_page_id: property(response).id,
    }
  })
}
export function putSourceDefinition(
  library: SharedLibrary,
  input: unknown,
  expected: string,
  dryRun = false,
) {
  return Effect.gen(function* () {
    const definition = yield* sourceChecked(() => validateSourceDefinition(input))
    const rows = yield* listSourceDefinitions(library, definition.source_id)
    const existing = rows.length
      ? yield* readSourceDefinition(library, rows[0]!.page_id)
      : undefined
    const fingerprint = yield* sha256(canonicalSharedJson(definition))
    if (existing?.fingerprint === fingerprint)
      return { status: "unchanged", definition: existing, writes: 0 }
    if ((existing?.fingerprint ?? "absent") !== expected)
      return yield* Effect.fail(
        fail(
          "SOURCE_DEFINITION_CHANGED",
          "Source definition differs from the explicit expected fingerprint.",
        ),
      )
    const props = yield* sourceChecked(() => sourceDefinitionPropertiesFor(library, definition))
    const writes = {
      ...props,
      [sourceTable(library).property_ids.Status!]: { select: { name: "ready" } },
      [sourceTable(library).property_ids["Last Result"]!]: {
        rich_text: sourceRich(
          "Configuration updated; selected Skill versions and custom bodies remain unchanged.",
        ),
      },
    }
    const request = existing
      ? { properties: writes }
      : {
          parent: { type: "data_source_id", data_source_id: sourceTable(library).data_source_id },
          properties: {
            ...props,
            [sourceTable(library).property_ids.Status!]: { select: { name: "ready" } },
          },
        }
    const observe = Effect.gen(function* () {
      const currentRows = yield* listSourceDefinitions(library, definition.source_id)
      if (currentRows.length === 0) return undefined
      const current = yield* readSourceDefinition(library, currentRows[0]!.page_id)
      return current.fingerprint === fingerprint && current.status === "ready" ? current : undefined
    })
    return yield* guardedSourceMutation(
      library,
      {
        identity: definition.source_id,
        path: existing ? `v1/pages/${existing.page_id}` : "v1/pages",
        method: existing ? "PATCH" : "POST",
        body: request,
        dryRun,
      },
      observe,
    )
  })
}

export function bindSourceDefinition(
  library: SharedLibrary,
  input: { source: string; target: string; member: string; expected: string; dryRun?: boolean },
) {
  return Effect.gen(function* () {
    const source = yield* readSourceDefinition(library, input.source),
      api = yield* Notion
    const target = pageId(input.target)
    if (
      !target ||
      !input.member ||
      (normalizePath(input.member) !== input.member && input.member !== ".")
    )
      return yield* Effect.fail(
        fail("SOURCE_BINDING_INVALID", "Select an exact Skill and safe member key."),
      )
    const ids = library.skills.property_ids,
      raw = property(yield* api.request(`v1/pages/${target}`))
    if (raw.in_trash || property(raw.parent).data_source_id !== library.skills.data_source_id)
      return yield* Effect.fail(
        fail("SOURCE_BINDING_SCOPE", "Target is outside the selected library."),
      )
    const previous = yield* sourceChecked(() => sourceField(raw, ids.Origin!))
    if (previous.has_more || !Array.isArray(previous.relation) || previous.relation.length > 1)
      return yield* Effect.fail(
        fail(
          "SOURCE_BINDING_CONFLICT",
          "Multiple origin definitions require an explicit composition.",
        ),
      )
    const old = previous.relation.length ? String(property(previous.relation[0]).id) : "none"
    const member = text(sourceField(raw, ids["Source Member"]!).rich_text)
    if (old === source.page_id && member === input.member)
      return { status: "unchanged", source, target, member }
    if (old !== input.expected)
      return yield* Effect.fail(
        fail("SOURCE_BINDING_CHANGED", "Expected origin relation no longer matches."),
      )
    const props = {
      [ids.Origin!]: { relation: [{ id: source.page_id }] },
      [ids["Source Member"]!]: { rich_text: sourceRich(input.member) },
    }
    return yield* guardedSourceMutation(
      library,
      {
        identity: `${source.source_id}:${target}`,
        path: `v1/pages/${target}`,
        method: "PATCH",
        body: { properties: props },
        dryRun: input.dryRun,
      },
      Effect.gen(function* () {
        const row = yield* api.request(`v1/pages/${target}`),
          rel = sourceField(row, ids.Origin!)
        return !rel.has_more &&
          Array.isArray(rel.relation) &&
          rel.relation.length === 1 &&
          property(rel.relation[0]).id === source.page_id &&
          text(sourceField(row, ids["Source Member"]!).rich_text) === input.member
          ? {
              target,
              source_page_id: source.page_id,
              member: input.member,
              content_pin_changed: false,
            }
          : undefined
      }),
    )
  })
}

/** Query the forward Origin relation; a Sources row's inline reverse relation
 * is not a complete membership inventory after Notion's first-page limit. */
export function listSourceMembers(library: SharedLibrary, selector: string) {
  return Effect.gen(function* () {
    const definition = yield* readSourceDefinition(library, selector),
      api = yield* Notion
    const ids = library.skills.property_ids,
      query = new URLSearchParams()
    for (const name of ["Name", "Skill ID", "Kind", "Enabled", "Origin", "Source Member", "Source"])
      query.append("filter_properties", ids[name]!)
    const result: Array<{
      page_id: string
      skill_id: string
      name: string
      kind: string
      enabled: boolean
      member: string
      selected_version: string
    }> = []
    const pages = new Set<string>(),
      identities = new Set<string>(),
      cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const raw = property(
        yield* api.request(`v1/data_sources/${library.skills.data_source_id}/query?${query}`, {
          page_size: 100,
          filter: { property: ids.Origin, relation: { contains: definition.page_id } },
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      )
      yield* sourceChecked(() => {
        if (
          raw.object !== "list" ||
          !Array.isArray(raw.results) ||
          typeof raw.has_more !== "boolean" ||
          (raw.request_status !== undefined && property(raw.request_status).type !== "complete")
        )
          throw fail("SOURCE_MEMBERS_INCOMPLETE", "Source membership query is incomplete.")
        for (const item of raw.results) {
          const row = property(item),
            origin = sourceField(row, ids.Origin!),
            skill = text(sourceField(row, ids["Skill ID"]!).rich_text)
          if (
            row.object !== "page" ||
            typeof row.id !== "string" ||
            property(row.parent).data_source_id !== library.skills.data_source_id ||
            row.in_trash ||
            row.archived ||
            pages.has(row.id) ||
            !skill ||
            identities.has(skill) ||
            origin.has_more ||
            !Array.isArray(origin.relation) ||
            origin.relation.length !== 1 ||
            property(origin.relation[0]).id !== definition.page_id
          )
            throw fail(
              "SOURCE_MEMBERS_CONFLICT",
              "Source membership is ambiguous, duplicated or outside its registered relation.",
            )
          const kind = property(sourceField(row, ids.Kind!).select).name,
            enabled = sourceField(row, ids.Enabled!).checkbox
          if (
            typeof kind !== "string" ||
            !["skill", "router", "prompt"].includes(kind) ||
            typeof enabled !== "boolean"
          )
            throw fail("SOURCE_MEMBERS_CONFLICT", "Bound content has invalid metadata.")
          pages.add(row.id)
          identities.add(skill)
          result.push({
            page_id: row.id,
            skill_id: skill,
            name: text(sourceField(row, ids.Name!).title),
            kind,
            enabled,
            member: text(sourceField(row, ids["Source Member"]!).rich_text),
            selected_version: text(sourceField(row, ids.Source!).rich_text),
          })
        }
        if (raw.has_more) {
          if (
            typeof raw.next_cursor !== "string" ||
            !raw.next_cursor ||
            cursors.has(raw.next_cursor)
          )
            throw fail("SOURCE_MEMBERS_INCOMPLETE", "Invalid source-members cursor.")
          cursor = raw.next_cursor
          cursors.add(cursor)
        } else {
          if (raw.next_cursor !== null)
            throw fail("SOURCE_MEMBERS_INCOMPLETE", "Unexpected terminal source-members cursor.")
          cursor = undefined
        }
      })
    } while (cursor)
    return {
      source_id: definition.source_id,
      source_page_id: definition.page_id,
      items: result,
      metadata_only: true,
      provider_requests: 0,
    }
  })
}
