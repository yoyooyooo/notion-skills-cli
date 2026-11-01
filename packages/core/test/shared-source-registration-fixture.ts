import * as NodeServices from "@effect/platform-node/NodeServices"
import { Crypto, Effect, Layer, Schema } from "effect"
import { fail, property, SkillsError, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import type { SharedLibrary } from "../src/shared-library-model.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { Store } from "../src/store.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

export function registrationStore(records = new Map<string, unknown>()) {
  const unexpected = () => Effect.die(new Error("Unexpected source registration Store operation."))
  const store: Store["Service"] = {
    root: "/controlled",
    configRoot: "/controlled/config",
    cacheRoot: "/controlled/cache",
    upstream: upstreamRepositoryFixture(),
    integrity: integrityRepositoryFixture(),
    reserveCacheGeneration: unexpected,
    listKeys: unexpected,
    retireKeys: unexpected,
    registerBindingWithBase: unexpected,
    advanceBaseAndReceipt: unexpected,
    backup: unexpected,
    output: unexpected,
    readBytes: unexpected,
    writeBytes: unexpected,
    readJson: (key, schema) =>
      Effect.try({
        try: () =>
          records.has(key)
            ? Schema.decodeUnknownSync(schema)(structuredClone(records.get(key)))
            : undefined,
        catch: () => fail("STATE_CORRUPT", "Controlled registration state corruption."),
      }),
    writeJson: (key, value) =>
      Effect.try({
        try: () => {
          if (
            records.has(key) &&
            canonicalSharedJson(records.get(key)) !== canonicalSharedJson(value)
          ) {
            throw fail("STATE_CONFLICT", "The registration dispatch identity is immutable.")
          }
          records.set(key, structuredClone(value))
        },
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail("STATE_CORRUPT", "Controlled registration state failure."),
      }),
  }
  return { store, records }
}

function fieldValue(id: string, raw: unknown) {
  const value = property(raw)
  if (value.rich_text !== undefined) return { ...value, id, type: "rich_text", has_more: false }
  if (value.title !== undefined) return { ...value, id, type: "title" }
  if (value.select !== undefined) return { ...value, id, type: "select" }
  if (value.relation !== undefined) return { ...value, id, type: "relation", has_more: false }
  throw new Error("Invalid source registration fixture property.")
}
function matches(row: Record<string, unknown>, input: unknown): boolean {
  const filter = property(input)
  if (Array.isArray(filter.and)) return filter.and.every((part) => matches(row, part))
  if (typeof filter.property !== "string") return false
  const value = property(property(row.properties)[filter.property])
  if (filter.relation !== undefined)
    return (
      Array.isArray(value.relation) &&
      value.relation.some((item) => property(item).id === property(filter.relation).contains)
    )
  if (filter.select !== undefined)
    return property(value.select).name === property(filter.select).equals
  if (filter.rich_text !== undefined)
    return text(value.rich_text) === property(filter.rich_text).equals
  return false
}

export function sourceRegistryFixture(
  library: SharedLibrary,
  options: { readonly unknownCreate?: "retained" | "absent"; readonly failQuery?: boolean } = {},
) {
  const rows: Record<string, unknown>[] = []
  const calls: { path: string; body: unknown; method?: string }[] = []
  const local = registrationStore()
  let nextPage = 100
  let failed = false
  const api: Notion["Service"] = {
    version: Effect.succeed("controlled"),
    credentialIdentity: Effect.succeed("source-credential"),
    request: (path, body, requestOptions) =>
      Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
        calls.push({ path, body, method: requestOptions?.method })
        const url = new URL(path, "https://api.notion.com/")
        if (url.pathname === `/v1/data_sources/${library.records.data_source_id}/query`) {
          if (options.failQuery)
            return Effect.fail(fail("ACCESS_DENIED", "Controlled denied query."))
          return Effect.succeed({
            object: "list",
            results: rows.filter((row) => matches(row, property(body).filter)),
            has_more: false,
            next_cursor: null,
          })
        }
        if (path === "v1/pages" && requestOptions?.method === "POST") {
          const row = {
            object: "page",
            id: `00000000-0000-4000-8000-${(nextPage++).toString(16).padStart(12, "0")}`,
            parent: {
              ...property(property(body).parent),
              database_id: library.records.database_id,
            },
            properties: Object.fromEntries(
              Object.entries(property(property(body).properties)).map(([key, value]) => [
                key,
                fieldValue(key, value),
              ]),
            ),
          }
          const unknown = options.unknownCreate !== undefined && !failed
          if (!unknown || options.unknownCreate === "retained") rows.push(row)
          if (unknown) {
            failed = true
            return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Controlled unknown source create."))
          }
          return Effect.succeed(row)
        }
        return Effect.fail(
          fail("UNEXPECTED", "Registration attempted a body or non-record operation."),
        )
      }),
  }
  const layer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(Notion, api),
    Layer.succeed(Store, local.store),
  )
  return {
    rows,
    calls,
    local,
    api,
    layer,
    run: <A, E>(effect: Effect.Effect<A, E, Notion | Crypto.Crypto | Store>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer))),
  }
}
