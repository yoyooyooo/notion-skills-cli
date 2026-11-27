import * as NodeServices from "@effect/platform-node/NodeServices"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { mkdtemp, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "vitest"
import { invalidateCurrentLibraryCatalog } from "../src/cache.ts"
import { trashPath } from "../src/local-locks.ts"
import { CatalogSchema, fail } from "../src/model.ts"
import { Store, StoreLive } from "../src/store.ts"
import { currentId, currentLibrary } from "./shared-current-fixture.ts"

const scope = "a".repeat(64)
const foreignScope = "b".repeat(64)
const targetDatabase = currentLibrary.skills.database_id
const unrelatedDatabase = currentId(90)
const directoryKey = (selection: string, selectedScope = scope) =>
  `cache/catalogs/${selectedScope}/${selection}.json`

function catalog(database = targetDatabase, selectedScope = scope) {
  return {
    scope: selectedScope,
    fetched_at: 1,
    generation: 1,
    databases: [
      {
        alias: "test-library",
        database_id: database,
        title: "Test Library",
        data_source_ids: [currentLibrary.skills.data_source_id],
        role: "content",
        shared_library: currentLibrary,
      },
    ],
    records: [],
    coverage: {
      method: "explicit_library",
      exhaustive: true,
      queried_data_sources: [currentLibrary.skills.data_source_id],
      failed_sources: [],
      search_index_limited: false,
    },
  }
}

// The live F03 cache had this v1 descriptor shape inside an older catalog slot.
// Identifiers and metadata here are synthetic; current consumers still reject it.
function legacyCatalog(selectedScope = scope) {
  const current = catalog(targetDatabase, selectedScope)
  return {
    ...current,
    databases: current.databases.map((database) => ({
      ...database,
      shared_library: {
        ...currentLibrary,
        version: 1,
        library_id: `library-${currentId(92)}`,
        parent_page_id: currentLibrary.library_id,
      },
    })),
  }
}

type Fixture = {
  readonly store: Store["Service"]
  readonly db: DatabaseSync
  readonly run: <A, E>(effect: Effect.Effect<A, E, Store>) => Promise<A>
  readonly seed: (selection: string, value: unknown, selectedScope?: string) => string
}

async function withStore(use: (fixture: Fixture) => Promise<void>) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "catalog-retirement-")))
  const state = join(directory, "state")
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* Store
          const db = new DatabaseSync(join(state, "state.sqlite"))
          try {
            const run: Fixture["run"] = (effect) =>
              Effect.runPromise(effect.pipe(Effect.provideService(Store, store)))
            // Populate historical on-disk rows, without asking the new publication
            // boundary to accept an obsolete consumer schema as a new observation.
            const seed: Fixture["seed"] = (selection, value, selectedScope = scope) => {
              db.prepare(
                "INSERT INTO catalogs(scope,selection,generation,payload) VALUES(?,?,1,?)",
              ).run(selectedScope, selection, JSON.stringify(value))
              db.prepare(
                "INSERT INTO cache_fences(scope,identity,generation,retired_through) VALUES(?,?,1,0)",
              ).run(selectedScope, `catalog-${selection}`)
              return directoryKey(selection, selectedScope)
            }
            yield* Effect.promise(() => use({ store, db, run, seed }))
          } finally {
            db.close()
          }
        }).pipe(
          Effect.provide(StoreLive.pipe(Layer.provideMerge(NodeServices.layer))),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                NTN_SKILLS_HOME: state,
                NTN_SKILLS_CONFIG_HOME: join(directory, "config"),
                NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
              }),
            ),
          ),
        ),
      ),
    )
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
  }
}

test("retiring a Library handles mixed v1/v2 catalogs without consuming legacy descriptors", async () => {
  await withStore(async ({ store, db, run, seed }) => {
    const legacy = legacyCatalog()
    const oldKey = seed("01-legacy", legacy)
    seed("02-legacy-search", {
      ...legacy,
      coverage: { ...legacy.coverage, method: "search_and_registered", exhaustive: false },
    })
    seed("03-current", catalog())
    const unrelated = catalog(unrelatedDatabase)
    const unrelatedKey = seed("04-unrelated", unrelated)
    const foreign = legacyCatalog(foreignScope)
    const foreignKey = seed("01-legacy", foreign, foreignScope)
    const journalKey = `operations/current-write-pending/${"c".repeat(64)}/pending.json`
    const journalPayload = JSON.stringify({ version: 99, pending: "retain-original-intent" })
    db.prepare(
      "INSERT INTO shared_local_records(key,category,payload,retired) VALUES(?,'dispatch',?,0)",
    ).run(journalKey, journalPayload)

    const missingSelection = "05-reserved-before-publication"
    const missingGeneration = await run(
      store.reserveCacheGeneration(scope, `catalog-${missingSelection}`),
    )
    const strict = await run(store.readJson(oldKey, CatalogSchema).pipe(Effect.result))
    expect(strict).toMatchObject({ _tag: "Failure", failure: { code: "STATE_CORRUPT" } })

    await run(invalidateCurrentLibraryCatalog(scope, targetDatabase))

    expect(await run(store.listKeys(`cache/catalogs/${scope}`))).toEqual([unrelatedKey])
    expect(await run(store.readJson(unrelatedKey, CatalogSchema))).toEqual(
      Schema.decodeUnknownSync(CatalogSchema)(unrelated),
    )
    expect(await run(store.readJson(foreignKey, Schema.Unknown))).toEqual(foreign)
    expect(
      db.prepare("SELECT payload,retired FROM shared_local_records WHERE key=?").get(journalKey),
    ).toEqual({ payload: journalPayload, retired: 0 })
    expect(
      db
        .prepare(
          "SELECT scope,identity,generation,retired_through FROM cache_fences WHERE scope=? ORDER BY identity",
        )
        .all(foreignScope),
    ).toEqual([
      { scope: foreignScope, identity: "catalog-01-legacy", generation: 1, retired_through: 0 },
    ])
    const late = await run(
      store
        .writeJson(directoryKey(missingSelection), {
          ...catalog(),
          generation: missingGeneration,
        })
        .pipe(Effect.result),
    )
    expect(late).toMatchObject({ _tag: "Failure", failure: { code: "CACHE_INVALIDATED" } })
    const strictForeign = await run(store.readJson(foreignKey, CatalogSchema).pipe(Effect.result))
    expect(strictForeign).toMatchObject({ _tag: "Failure", failure: { code: "STATE_CORRUPT" } })
  })
})

test.each([
  { name: "null", value: null },
  { name: "unknown future schema", value: { version: 99, directories: [unrelatedDatabase] } },
  { name: "invalid database ID", value: { ...catalog(), databases: [{ database_id: 42 }] } },
  { name: "non-ID string", value: catalog("unknown-database") },
  { name: "compact target UUID", value: catalog(targetDatabase.replaceAll("-", "").toUpperCase()) },
  { name: "mismatched payload scope", value: catalog(unrelatedDatabase, foreignScope) },
  {
    name: "partial unrelated directory",
    value: {
      ...catalog(unrelatedDatabase),
      coverage: { exhaustive: false },
    },
  },
])(
  "retiring a Library conservatively fences $name in its own cache namespace",
  async ({ value }) => {
    await withStore(async ({ store, run, seed }) => {
      const key = seed("unknown", value)
      await run(invalidateCurrentLibraryCatalog(scope, targetDatabase))
      expect(await run(store.readJson(key, Schema.Unknown))).toBeUndefined()
      const late = await run(store.writeJson(key, catalog()).pipe(Effect.result))
      expect(late).toMatchObject({ _tag: "Failure", failure: { code: "CACHE_INVALIDATED" } })
    })
  },
)

test("retirement does not parse retained full catalog or View payloads", async () => {
  await withStore(async ({ store, db, run, seed }) => {
    seed("retained", {
      ...catalog(),
      invalidated: true,
      records: [{ obsolete_record: true }],
      last_complete: legacyCatalog(),
      last_failure: { code: "NOTION_UNAVAILABLE", observed_at: 1 },
    })
    db.prepare(
      "INSERT INTO view_observations(scope,selection,generation,payload) VALUES(?,?,1,?)",
    ).run(scope, "old-view", JSON.stringify({ obsolete_view: true }))
    db.prepare(
      "INSERT INTO cache_fences(scope,identity,generation,retired_through) VALUES(?,?,1,0)",
    ).run(scope, "views-old-view")
    await run(invalidateCurrentLibraryCatalog(scope, targetDatabase))
    expect(await run(store.listKeys(`cache/catalogs/${scope}`))).toEqual([])
    expect(await run(store.listKeys(`cache/views/${scope}`))).toEqual([])
  })
})

test.each(["list", "read", "retire"] as const)(
  "retirement preserves the original %s I/O failure",
  async (boundary) => {
    await withStore(async ({ store, db, run, seed }) => {
      seed("current", catalog())
      const failure = fail("STORAGE_ERROR", `${boundary} failed`, { original: true })
      const controlled: Store["Service"] = {
        ...store,
        listKeys: boundary === "list" ? () => Effect.fail(failure) : store.listKeys,
        readJson: boundary === "read" ? () => Effect.fail(failure) : store.readJson,
        retireKeys: boundary === "retire" ? () => Effect.fail(failure) : store.retireKeys,
      }
      const result = await run(
        invalidateCurrentLibraryCatalog(scope, targetDatabase).pipe(
          Effect.provideService(Store, controlled),
          Effect.result,
        ),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure).toBe(failure)
      expect(db.prepare("SELECT count(*) AS n FROM catalogs").get()).toEqual({ n: 1 })
      expect(db.prepare("SELECT retired_through FROM cache_fences").get()).toEqual({
        retired_through: 0,
      })
    })
  },
)

test("retirement does not swallow malformed stored JSON", async () => {
  await withStore(async ({ db, run, seed }) => {
    seed("broken-json", catalog())
    db.prepare("UPDATE catalogs SET payload=? WHERE selection=?").run("{", "broken-json")
    const result = await run(
      invalidateCurrentLibraryCatalog(scope, targetDatabase).pipe(Effect.result),
    )
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "STATE_CORRUPT" } })
    expect(db.prepare("SELECT payload FROM catalogs").get()).toEqual({ payload: "{" })
    expect(db.prepare("SELECT retired_through FROM cache_fences").get()).toEqual({
      retired_through: 0,
    })
  })
})
