import { Effect } from "effect"
import { fail, property } from "./model.ts"
import { Notion } from "./notion.ts"
import { fileIntentChecked } from "./shared-file-intent.ts"
import { LIBRARY_MARKER, libraryFromDatabase } from "./shared-library.ts"
import type { SharedLibrary, TableBinding } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { guardedSourceMutation, sourceRich } from "./shared-source-definitions.ts"

export const fileRequestProperty = "Management Request"
export const fileRequestResultProperty = "Management Result"
export const fileRequestReceiptProperty = "Management Receipt"
export const fileRequestSchema = {
  [fileRequestProperty]: { select: { options: [{ name: "none" }, { name: "restore-follow" }] } },
  [fileRequestResultProperty]: { rich_text: {} },
  [fileRequestReceiptProperty]: { rich_text: {} },
} as const

type FilePropertySchema = Readonly<Record<string, Readonly<Record<string, unknown>>>>
function inspect(table: TableBinding, raw: unknown, schema: FilePropertySchema) {
  const row = property(raw)
  if (
    row.object !== "data_source" ||
    row.id !== table.data_source_id ||
    property(row.parent).database_id !== table.database_id ||
    row.in_trash === true
  )
    throw fail(
      "SHARED_FILE_REQUEST_SCHEMA",
      "The request schema is outside the registered library table.",
    )
  const fields = Object.entries(property(row.properties))
  const ids: Record<string, string> = {},
    missing: Record<string, unknown> = {},
    unregistered: Record<string, unknown> = {}
  for (const [name, shape] of Object.entries(schema)) {
    const id = table.property_ids[name]
    const matches = fields.filter(([key, value]) =>
      id === undefined ? key === name : property(value).id === id,
    )
    if (matches.length === 0 && id === undefined) {
      missing[name] = shape
      continue
    }
    const value = property(matches[0]?.[1])
    if (
      matches.length !== 1 ||
      typeof value.id !== "string" ||
      value.type !== Object.keys(shape)[0] ||
      Object.entries(table.property_ids).some(
        ([other, existing]) => other !== name && existing === value.id,
      )
    )
      throw fail(
        "SHARED_FILE_REQUEST_SCHEMA",
        "Request fields require distinct stable identities and declared types.",
        { property: name },
      )
    if ("select" in shape) {
      const options = property(value.select).options
      const expected = property(shape.select).options
      if (
        !Array.isArray(options) ||
        !Array.isArray(expected) ||
        !expected.every((choice) =>
          options.some((option) => property(option).name === property(choice).name),
        )
      )
        throw fail(
          "SHARED_FILE_REQUEST_SCHEMA",
          "The declared select choices are missing from the registered property.",
        )
    }
    if ("rollup" in shape) {
      const expected = property(shape.rollup),
        actual = property(value.rollup)
      if (
        actual.relation_property_id !== decodeURIComponent(String(expected.relation_property_id)) ||
        actual.rollup_property_id !== decodeURIComponent(String(expected.rollup_property_id)) ||
        actual.function !== expected.function
      )
        throw fail(
          "SHARED_FILE_REQUEST_SCHEMA",
          "The registered rollup no longer follows its exact one-hop property identities.",
          { property: name, expected, actual },
        )
    }
    if (id === undefined) unregistered[name] = shape
    ids[name] = value.id
  }
  return { ids, missing, unregistered }
}

/** Stable optional properties share the existing original metadata dispatch journal. */
export function registerSharedFileProperties(
  library: SharedLibrary,
  input: {
    readonly namespace: string
    readonly properties: (library: SharedLibrary, role: "skills" | "files") => FilePropertySchema
    readonly writerContract: unknown
  },
  dryRun = false,
) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const entry = yield* api.request(`v1/databases/${library.skills.database_id}`)
    const current = yield* fileIntentChecked(() => libraryFromDatabase(entry))
    if (canonicalSharedJson(current) !== canonicalSharedJson(library))
      return yield* Effect.fail(
        fail("SHARED_FILE_REQUEST_SCHEMA", "The registered library changed before request setup."),
      )
    const inspected = []
    let observedLibrary = library
    for (const role of ["skills", "files"] as const) {
      const table = library[role]
      const raw = yield* api.request(`v1/data_sources/${table.data_source_id}`)
      const result = yield* fileIntentChecked(() =>
        inspect(table, raw, input.properties(observedLibrary, role)),
      )
      inspected.push({ role, table, ...result })
      observedLibrary = {
        ...observedLibrary,
        [role]: { ...table, property_ids: { ...table.property_ids, ...result.ids } },
      }
    }
    if (dryRun)
      return {
        status: "planned" as const,
        dry_run: true as const,
        remote_writes: 0 as const,
        tables: inspected.map(({ role, table, ids, missing, unregistered }) => ({
          role,
          data_source_id: table.data_source_id,
          registered: ids,
          create: missing,
          unregistered,
        })),
        writer_contract: input.writerContract,
      }
    let candidate = structuredClone(library)
    const operations: string[] = []
    for (const item of inspected) {
      let ids = item.ids
      const schema = input.properties(candidate, item.role)
      const intended = Object.fromEntries(
        Object.keys({ ...item.missing, ...item.unregistered }).map((name) => [name, schema[name]]),
      )
      if (Object.keys(item.unregistered).length > 0) {
        // A visible field does not settle an earlier unacknowledged schema PATCH.
        // Reuse the existing journal as a read-only replay-barrier check before registration.
        const prior = yield* guardedSourceMutation(
          library,
          {
            identity: `${input.namespace}-schema:${item.table.data_source_id}`,
            path: `v1/data_sources/${item.table.data_source_id}`,
            method: "PATCH",
            body: { properties: intended },
            dryRun: true,
          },
          Effect.gen(function* () {
            const raw = yield* api.request(`v1/data_sources/${item.table.data_source_id}`)
            const observed = yield* fileIntentChecked(() => inspect(item.table, raw, schema))
            return Object.keys(observed.missing).length === 0 ? raw : undefined
          }),
        )
        if ("original_outcome" in prior && prior.original_outcome === "unknown")
          return {
            status: "unknown" as const,
            operation_id: prior.operation_id,
            message:
              "The original schema dispatch remains unknown; current fields do not authorize another registration step.",
          }
        if (!("original_outcome" in prior) || prior.original_outcome !== "applied")
          return yield* Effect.fail(
            fail(
              "SHARED_FILE_REQUEST_SCHEMA",
              "An existing unregistered property cannot be claimed by name. Recover its acknowledged original schema registration or configure its stable identity explicitly.",
              { properties: Object.keys(item.unregistered) },
            ),
          )
      }
      if (Object.keys(item.missing).length > 0) {
        const mutation = yield* guardedSourceMutation(
          library,
          {
            identity: `${input.namespace}-schema:${item.table.data_source_id}`,
            path: `v1/data_sources/${item.table.data_source_id}`,
            method: "PATCH",
            body: {
              properties: Object.fromEntries(
                Object.keys(item.missing).map((name) => [name, schema[name]]),
              ),
            },
          },
          Effect.gen(function* () {
            const raw = yield* api.request(`v1/data_sources/${item.table.data_source_id}`)
            const observed = yield* fileIntentChecked(() => inspect(item.table, raw, schema))
            return Object.keys(observed.missing).length === 0 ? raw : undefined
          }),
        )
        operations.push(mutation.operation_id)
        if ("original_outcome" in mutation && mutation.original_outcome === "unknown")
          return {
            status: "unknown" as const,
            operation_id: mutation.operation_id,
            message:
              "Request fields are visible, but the original schema response remains unknown; no descriptor write was sent.",
          }
        if (!("result" in mutation))
          return yield* Effect.fail(
            fail(
              "SHARED_FILE_REQUEST_SCHEMA",
              "The original schema operation has no verified readback.",
            ),
          )
        ids = yield* fileIntentChecked(() => inspect(item.table, mutation.result, schema).ids)
      }
      candidate = {
        ...candidate,
        [item.role]: { ...item.table, property_ids: { ...item.table.property_ids, ...ids } },
      }
    }
    if (canonicalSharedJson(candidate) === canonicalSharedJson(library))
      return { status: "unchanged" as const, library, operations, remote_writes: 0 as const }
    const fresh = yield* api.request(`v1/databases/${library.skills.database_id}`)
    if (
      canonicalSharedJson(yield* fileIntentChecked(() => libraryFromDatabase(fresh))) !==
      canonicalSharedJson(library)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_REQUEST_SCHEMA",
          "The library descriptor changed during request setup; preserve the existing registration.",
        ),
      )
    const registration = yield* guardedSourceMutation(
      library,
      {
        identity: `${input.namespace}-registration`,
        path: `v1/databases/${library.skills.database_id}`,
        method: "PATCH",
        body: { description: sourceRich(LIBRARY_MARKER + JSON.stringify(candidate)) },
      },
      Effect.gen(function* () {
        const row = yield* api.request(`v1/databases/${library.skills.database_id}`)
        const observed = yield* fileIntentChecked(() => libraryFromDatabase(row))
        return canonicalSharedJson(observed) === canonicalSharedJson(candidate)
          ? observed
          : undefined
      }),
    )
    return {
      status:
        "original_outcome" in registration && registration.original_outcome === "unknown"
          ? ("unknown" as const)
          : ("verified_applied" as const),
      library: candidate,
      operations: [...operations, registration.operation_id],
      buttons: "UI/template setup required; no Button or automation was installed.",
    }
  })
}

/** User intent, human feedback, and a separate original-operation receipt. */
export function initializeSharedFileRequests(library: SharedLibrary, dryRun = false) {
  return registerSharedFileProperties(
    library,
    {
      namespace: "file-requests",
      properties: () => fileRequestSchema,
      writerContract: {
        user: [fileRequestProperty],
        cli: [fileRequestResultProperty, fileRequestReceiptProperty],
        user_choices: ["none", "restore-follow"],
        buttons:
          "Configure in Notion UI or a template; the API cannot create, configure or press Button properties.",
        authoritative_ownership: "existing immutable file events",
      },
    },
    dryRun,
  )
}
