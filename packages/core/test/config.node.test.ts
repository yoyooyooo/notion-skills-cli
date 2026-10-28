import { expect, test } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigSchema, type SkillsError } from "../src/model.ts"
import { trashPath } from "../src/local-locks.ts"
import { Store, StoreLive, configuredToken, configuration, setToken } from "../src/store.ts"

const rootKeys = [
  "NTN_SKILLS_HOME",
  "NTN_SKILLS_CONFIG_HOME",
  "NTN_SKILLS_CACHE_HOME",
  "NOTION_API_TOKEN",
]
async function isolated(
  operation: (
    directory: string,
    run: <A>(effect: Effect.Effect<A, SkillsError, Store>) => Promise<A>,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "ntn-sqlite-state-"))
  const previous = new Map(rootKeys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    NTN_SKILLS_HOME: join(directory, "state"),
    NTN_SKILLS_CONFIG_HOME: join(directory, "config"),
    NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
    NOTION_API_TOKEN: "environment-fixture",
  })
  const run = <A>(effect: Effect.Effect<A, SkillsError, Store>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(StoreLive.pipe(Layer.provide(NodeServices.layer))),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
      ),
    )
  try {
    await operation(directory, run)
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
  }
}

test("SQLite state keeps configuration private and independent from observation retirement", async () => {
  await isolated(async (directory, run) => {
    expect(await run(configuredToken)).toBe("environment-fixture")
    await run(setToken("configured-fixture\n"))
    expect(await run(configuredToken)).toBe("configured-fixture")
    expect(JSON.parse(await readFile(join(directory, "config/config.json"), "utf8")).token).toBe(
      "configured-fixture",
    )
    expect(
      (await readFile(join(directory, "state/state.sqlite"))).includes(
        Buffer.from("configured-fixture"),
      ),
    ).toBe(false)
    expect((await run(setToken())).token_configured).toBe(false)
    expect(await run(configuredToken)).toBe("environment-fixture")
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.writeJson("cache/identities/fixture.json", { scope: "scope" })
        yield* store.retireKeys(["cache/identities/fixture.json"])
        expect(
          yield* store.readJson(
            "cache/identities/fixture.json",
            Schema.Struct({ scope: Schema.String }),
          ),
        ).toBeUndefined()
        for (const key of [
          "objects/a",
          "config.json",
          "snapshots/s_a.json",
          "sync/plans/p_a.json",
          "cache/../../objects/a",
        ])
          expect((yield* store.retireKeys([key]).pipe(Effect.result))._tag).toBe("Failure")
      }),
    )
    expect(await run(configuration)).toEqual({})
  })
})

test("normal runtime blocks legacy state and corrupt SQLite rather than manufacturing empty state", async () => {
  await isolated(async (directory, run) => {
    await mkdir(join(directory, "state"), { recursive: true })
    await writeFile(join(directory, "state/config.json"), '{"sources":[]}')
    await expect(run(configuration)).rejects.toThrow()
    expect(await readFile(join(directory, "state/config.json"), "utf8")).toBe('{"sources":[]}')
    await writeFile(join(directory, "state/state.sqlite"), "corrupt SQLite fixture")
    await expect(run(configuration)).rejects.toThrow()
    expect(await readFile(join(directory, "state/state.sqlite"), "utf8")).toBe(
      "corrupt SQLite fixture",
    )
  })
})

test("retirement fences reservations across restart and older catalogs cannot overwrite newer observations", async () => {
  await isolated(async (_directory, run) => {
    const scope = "a".repeat(64)
    const page = "11111111-1111-4111-8111-111111111111"
    const key = `cache/latest/${scope}/${page}/first.json`
    const generation = await run(
      Effect.gen(function* () {
        return yield* (yield* Store).reserveCacheGeneration(scope, page)
      }),
    )
    await run(
      Effect.gen(function* () {
        yield* (yield* Store).retireKeys([`cache/latest/${scope}/${page}/.fence`])
      }),
    )
    const late = await run(
      Effect.gen(function* () {
        return yield* (yield* Store)
          .writeJson(key, { generation, validated_at: 1 })
          .pipe(Effect.result)
      }),
    )
    expect(late._tag === "Failure" && late.failure.code).toBe("CACHE_INVALIDATED")
    const next = await run(
      Effect.gen(function* () {
        return yield* (yield* Store).reserveCacheGeneration(scope, page)
      }),
    )
    expect(next).toBeGreaterThan(generation)
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.writeJson(key, { generation: next, validated_at: 2 })
        expect(yield* store.readJson(key, ConfigSchema)).toBeDefined()
        const selection = "b".repeat(64)
        const older = yield* store.reserveCacheGeneration(scope, `catalog-${selection}`)
        const newer = yield* store.reserveCacheGeneration(scope, `catalog-${selection}`)
        const catalog = `cache/catalogs/${scope}/${selection}.json`
        yield* store.writeJson(catalog, { generation: newer, sources: [] })
        yield* store.writeJson(catalog, {
          generation: older,
          sources: [{ alias: "old", database_id: "db", title: "old", data_source_ids: [] }],
        })
        expect((yield* store.readJson(catalog, ConfigSchema))?.sources).toEqual([])
        yield* store.retireKeys([catalog, key])
        expect(yield* store.readJson(catalog, ConfigSchema)).toBeUndefined()
      }),
    )
  })
})

test("ConfigProvider replaces host roots and token while persisted token keeps priority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ntn-config-provider-"))
  const provider = ConfigProvider.fromUnknown({
    HOME: join(directory, "home"),
    XDG_STATE_HOME: join(directory, "xdg-state"),
    NTN_SKILLS_CONFIG_HOME: join(directory, "explicit-config"),
    NOTION_API_TOKEN: " provider-token ",
  })
  try {
    const run = <A>(effect: Effect.Effect<A, SkillsError, Store>) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(StoreLive.pipe(Layer.provide(NodeServices.layer))),
          Effect.provide(ConfigProvider.layer(provider)),
        ),
      )
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        expect(store.root).toBe(join(directory, "xdg-state", "ntn-skills"))
        expect(store.configRoot).toBe(join(directory, "explicit-config"))
        expect(store.cacheRoot).toBe(join(directory, "home", ".cache", "ntn-skills"))
        expect(yield* configuredToken).toBe("provider-token")
        yield* setToken("persisted-token")
        expect(yield* configuredToken).toBe("persisted-token")
        yield* setToken()
        expect(yield* configuredToken).toBe("provider-token")
      }),
    )
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
  }
})
