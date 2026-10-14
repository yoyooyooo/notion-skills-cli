import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, FileSystem, Layer, PlatformError } from "effect"
import { ConfigSchema, type SkillsError } from "../src/model.ts"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { trashPath } from "../src/local-locks.ts"
import {
  Store,
  StoreLive,
  configuredSources,
  configuredToken,
  publicConfiguration,
  setToken,
  configuration,
} from "../src/store.ts"

const config = {
  sources: [{ alias: "personal", database_id: "db", title: "Skills", data_source_ids: ["ds"] }],
}
const keys = [
  "NTN_SKILLS_HOME",
  "NTN_SKILLS_CONFIG_HOME",
  "NTN_SKILLS_CACHE_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "NOTION_API_TOKEN",
]

async function isolated<A>(
  overrides: Record<string, string>,
  operation: (
    files: Map<string, Uint8Array>,
    run: <T>(effect: Effect.Effect<T, SkillsError, Store>) => Promise<T>,
  ) => Promise<A>,
) {
  const original = new Map(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  Object.assign(process.env, overrides)
  const files = new Map<string, Uint8Array>()
  const failure = (path: string) =>
    PlatformError.systemError({
      _tag: "NotFound",
      module: "FileSystem",
      method: "readFile",
      pathOrDescriptor: path,
    })
  const fs = FileSystem.makeNoop({
    exists: (path) => Effect.succeed(files.has(path)),
    readFileString: (path) =>
      files.has(path)
        ? Effect.succeed(new TextDecoder().decode(files.get(path)!))
        : Effect.fail(failure(path)),
    readFile: (path) =>
      files.has(path) ? Effect.succeed(files.get(path)!) : Effect.fail(failure(path)),
    makeDirectory: () => Effect.void,
    chmod: () => Effect.void,
    writeFile: (path, bytes) =>
      Effect.sync(() => {
        files.set(path, bytes)
      }),
    copy: (from, to, options) =>
      Effect.sync(() => {
        if (files.has(to) && options?.overwrite === false)
          throw new Error("Destination already exists")
        files.set(to, files.get(from)!)
      }),
    rename: (from, to) =>
      Effect.sync(() => {
        files.set(to, files.get(from)!)
        files.delete(from)
      }),
  })
  const host = Layer.mergeAll(NodeServices.layer, Layer.succeed(FileSystem.FileSystem, fs))
  const live = StoreLive.pipe(Layer.provide(host))
  const run = <T>(effect: Effect.Effect<T, SkillsError, Store>) =>
    Effect.runPromise(effect.pipe(Effect.provide(live)))
  try {
    return await operation(files, run)
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test("configuration defaults to ~/.config and keeps snapshots in the state directory", async () => {
  await isolated({ NTN_SKILLS_HOME: "/test/state" }, async (files, run) => {
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.writeJson("config.json", config)
        yield* store.writeBytes("objects/content", new Uint8Array([1, 2, 3]))
      }),
    )
    const home = process.env.HOME ?? process.env.USERPROFILE
    expect(
      JSON.parse(new TextDecoder().decode(files.get(`${home}/.config/ntn-skills/config.json`)!)),
    ).toEqual(config)
    expect(files.get("/test/state/objects/content")).toEqual(new Uint8Array([1, 2, 3]))
    expect(files.has("/test/state/config.json")).toBe(false)
  })
})

test("XDG_CONFIG_HOME and explicit configuration override select independent configuration roots", async () => {
  for (const [overrides, destination] of [
    [{ XDG_CONFIG_HOME: "/test/xdg" }, "/test/xdg/ntn-skills/config.json"],
    [
      { XDG_CONFIG_HOME: "/test/xdg", NTN_SKILLS_CONFIG_HOME: "/test/explicit" },
      "/test/explicit/config.json",
    ],
  ] as const) {
    await isolated({ NTN_SKILLS_HOME: "/test/state", ...overrides }, async (files, run) => {
      await run(
        Effect.gen(function* () {
          const store = yield* Store
          yield* store.writeJson("config.json", config)
        }),
      )
      expect(JSON.parse(new TextDecoder().decode(files.get(destination)!))).toEqual(config)
      expect(await run(configuredSources)).toEqual(config.sources)
    })
  }
})

test("legacy source registrations migrate once and retain the original document as a backup", async () => {
  await isolated(
    { NTN_SKILLS_HOME: "/test/state", XDG_CONFIG_HOME: "/test/xdg" },
    async (files, run) => {
      const raw = new TextEncoder().encode(
        JSON.stringify({ ...config, future_setting: "preserved" }),
      )
      files.set("/test/state/config.json", raw)
      expect(await run(configuredSources)).toEqual(config.sources)
      expect(files.get("/test/xdg/ntn-skills/config.json")).toEqual(raw)
      expect(files.has("/test/state/config.json")).toBe(false)
      const backup = [...files.keys()].find((path) =>
        /^\/test\/state\/config\.json\..+\.migrated$/.test(path),
      )!
      expect(files.get(backup)).toEqual(raw)
      expect(await run(configuredSources)).toEqual(config.sources)
      expect([...files.keys()].filter((path) => path.endsWith(".migrated"))).toEqual([backup])
    },
  )
})

test("existing configuration wins over legacy registrations without modifying either file", async () => {
  await isolated(
    { NTN_SKILLS_HOME: "/test/state", NTN_SKILLS_CONFIG_HOME: "/test/config" },
    async (files, run) => {
      const legacy = new TextEncoder().encode(JSON.stringify(config))
      const current = new TextEncoder().encode(JSON.stringify({ sources: [] }))
      files.set("/test/state/config.json", legacy)
      files.set("/test/config/config.json", current)
      expect(await run(configuredSources)).toEqual([])
      expect(files.get("/test/state/config.json")).toEqual(legacy)
      expect(files.get("/test/config/config.json")).toEqual(current)
    },
  )
})

test("invalid legacy configuration fails without creating or moving configuration", async () => {
  await isolated(
    { NTN_SKILLS_HOME: "/test/state", NTN_SKILLS_CONFIG_HOME: "/test/config" },
    async (files, run) => {
      const raw = new TextEncoder().encode('{"sources": "invalid"}')
      files.set("/test/state/config.json", raw)
      const result = await run(
        Effect.gen(function* () {
          const store = yield* Store
          return yield* store.readJson("config.json", ConfigSchema).pipe(Effect.result)
        }),
      )
      expect(result._tag === "Failure" && result.failure.code).toBe("STATE_CORRUPT")
      expect(files.get("/test/state/config.json")).toEqual(raw)
      expect(files.has("/test/config/config.json")).toBe(false)
    },
  )
})

test("configured credentials take priority, clearing restores environment fallback without losing other settings", async () => {
  await isolated(
    {
      NTN_SKILLS_HOME: "/test/state",
      NTN_SKILLS_CONFIG_HOME: "/test/config",
      NOTION_API_TOKEN: "environment-fixture-token",
    },
    async (files, run) => {
      const initial = { ...config, default_database: "database" }
      files.set("/test/config/config.json", new TextEncoder().encode(JSON.stringify(initial)))
      expect(await run(configuredToken)).toBe("environment-fixture-token")
      const saved = await run(setToken("  configured-fixture-token\n"))
      expect(saved).toEqual({ ...initial, token_configured: true })
      expect(JSON.stringify(saved)).not.toContain("configured-fixture-token")
      expect(await run(configuredToken)).toBe("configured-fixture-token")
      expect(await run(configuration)).toEqual({ ...initial, token: "configured-fixture-token" })
      expect(publicConfiguration(await run(configuration))).toEqual(saved)
      const invalid = await run(setToken("first-token\nsecond-token").pipe(Effect.result))
      expect(invalid._tag === "Failure" && invalid.failure.code).toBe("INVALID_ARGUMENT")
      expect(await run(configuredToken)).toBe("configured-fixture-token")
      expect(await run(setToken())).toEqual({ ...initial, token_configured: false })
      expect(await run(configuration)).toEqual(initial)
      expect(await run(configuredToken)).toBe("environment-fixture-token")
      process.env.NOTION_API_TOKEN = "  "
      expect(await run(configuredToken)).toBeUndefined()
    },
  )
})

test("blank configured credentials use the environment and invalid credential types fail without leaking values", async () => {
  await isolated(
    {
      NTN_SKILLS_HOME: "/test/state",
      NTN_SKILLS_CONFIG_HOME: "/test/config",
      NOTION_API_TOKEN: "environment-fixture-token",
    },
    async (files, run) => {
      files.set(
        "/test/config/config.json",
        new TextEncoder().encode(JSON.stringify({ token: "  " })),
      )
      expect(await run(configuredToken)).toBe("environment-fixture-token")
      files.set(
        "/test/config/config.json",
        new TextEncoder().encode(JSON.stringify({ token: { value: "private-fixture-token" } })),
      )
      const result = await run(configuredToken.pipe(Effect.result))
      expect(result._tag === "Failure" && result.failure.code).toBe("STATE_CORRUPT")
      expect(JSON.stringify(result)).not.toContain("private-fixture-token")
    },
  )
})

test("XDG cache precedence separates disposable observations from state and config", async () => {
  for (const [overrides, expected] of [
    [{ XDG_CACHE_HOME: "/test/xdg-cache" }, "/test/xdg-cache/ntn-skills"],
    [{ XDG_CACHE_HOME: "/test/xdg-cache", NTN_SKILLS_CACHE_HOME: "/test/cache" }, "/test/cache"],
  ] as const) {
    await isolated(
      { NTN_SKILLS_HOME: "/test/state", NTN_SKILLS_CONFIG_HOME: "/test/config", ...overrides },
      async (files, run) => {
        const roots = await run(
          Effect.gen(function* () {
            const store = yield* Store
            yield* store.writeJson("cache/identities/scope.json", { scope: "scope" })
            yield* store.writeJson("sync/baselines/b.json", { generation: 4 })
            yield* store.writeJson("config.json", {
              ...config,
              cache_policy: { read_max_age_ms: 0, catalog_max_age_ms: 1_000 },
            })
            return { state: store.root, config: store.configRoot, cache: store.cacheRoot }
          }),
        )
        expect(roots).toEqual({ state: "/test/state", config: "/test/config", cache: expected })
        expect(files.has(`${expected}/identities/scope.json`)).toBe(true)
        expect(files.has("/test/state/sync/baselines/b.json")).toBe(true)
        expect(files.has("/test/config/config.json")).toBe(true)
        expect(files.has("/test/state/cache/identities/scope.json")).toBe(false)
      },
    )
  }
})

test("cache retirement refuses persistent state and traversal before filesystem mutation", async () => {
  await isolated(
    { NTN_SKILLS_HOME: "/test/state", NTN_SKILLS_CACHE_HOME: "/test/cache" },
    async (files, run) => {
      for (const key of [
        "objects/content",
        "snapshots/s_snapshot.json",
        "sync/plans/p_plan.json",
        "config.json",
        "cache/../../state/objects/content",
      ]) {
        const result = await run(
          Effect.gen(function* () {
            const store = yield* Store
            return yield* store.retireKeys([key]).pipe(Effect.result)
          }),
        )
        expect(result._tag === "Failure" && result.failure.code).toBe("INVALID_ARGUMENT")
      }
      expect(files.size).toBe(0)
    },
  )
})

test("process-safe observation retirement fences in-flight publication and retains generation across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ntn-cache-fence-"))
  const original = new Map(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    NTN_SKILLS_HOME: join(directory, "state"),
    NTN_SKILLS_CONFIG_HOME: join(directory, "config"),
    NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
  })
  const host = StoreLive.pipe(Layer.provide(NodeServices.layer))
  const run = <A>(effect: Effect.Effect<A, SkillsError, Store>) =>
    Effect.runPromise(effect.pipe(Effect.provide(host)))
  const scope = "a".repeat(64)
  const page = "11111111-1111-4111-8111-111111111111"
  const key = `cache/latest/${scope}/${page}/pending.json`
  try {
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.writeJson("cache/identities/fixture.json", { scope })
        yield* store.writeJson("sync/baselines/fixture.json", { generation: 9 })
        expect(yield* store.listKeys("cache")).toEqual(["cache/identities/fixture.json"])
        expect(yield* store.listKeys("cache/identities")).toEqual(["cache/identities/fixture.json"])
        expect(yield* store.readJson("sync/baselines/fixture.json", ConfigSchema)).toBeDefined()
      }),
    )
    const generation = await run(
      Effect.gen(function* () {
        return yield* (yield* Store).reserveCacheGeneration(scope, page)
      }),
    )
    // No observation exists yet: clearing still fences the saved reservation.
    await run(
      Effect.gen(function* () {
        yield* (yield* Store).retireKeys([`cache/latest/${scope}/${page}/.fence`])
      }),
    )
    const rejected = await run(
      Effect.gen(function* () {
        return yield* (yield* Store).writeJson(key, { generation }).pipe(Effect.result)
      }),
    )
    expect(rejected._tag === "Failure" && rejected.failure.code).toBe("CACHE_INVALIDATED")
    const next = await run(
      Effect.gen(function* () {
        return yield* (yield* Store).reserveCacheGeneration(scope, page)
      }),
    )
    expect(next).toBeGreaterThan(generation)
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.writeJson(key, { generation: next })
        expect(yield* store.readJson(key, ConfigSchema)).toBeDefined()
      }),
    )
    const catalogId = `catalog-${"b".repeat(64)}`
    const older = await run(
      Effect.gen(function* () {
        return yield* (yield* Store).reserveCacheGeneration(scope, catalogId)
      }),
    )
    const newer = await run(
      Effect.gen(function* () {
        return yield* (yield* Store).reserveCacheGeneration(scope, catalogId)
      }),
    )
    const catalogKey = `cache/catalogs/${scope}/${"b".repeat(64)}.json`
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.writeJson(catalogKey, { generation: newer, sources: [] })
        yield* store.writeJson(catalogKey, {
          generation: older,
          sources: [{ alias: "stale", database_id: "db", title: "stale", data_source_ids: [] }],
        })
        expect((yield* store.readJson(catalogKey, ConfigSchema))?.sources).toEqual([])
      }),
    )
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        const contentBytes = yield* store.readBytes(key)
        const catalogBytes = yield* store.readBytes(catalogKey)
        const retirement = yield* store.retireKeys([key, catalogKey]).pipe(Effect.result)
        if (process.platform === "darwin") expect(retirement._tag).toBe("Success")
        else {
          expect(retirement._tag === "Failure" && retirement.failure.code).toBe(
            "RETENTION_UNAVAILABLE",
          )
          expect(yield* store.readBytes(key)).toEqual(contentBytes)
          expect(yield* store.readBytes(catalogKey)).toEqual(catalogBytes)
        }
        expect(yield* store.readJson(key, ConfigSchema)).toBeUndefined()
        expect(yield* store.readJson(catalogKey, ConfigSchema)).toBeUndefined()
        const late = yield* store
          .writeJson(catalogKey, { generation: newer, sources: [] })
          .pipe(Effect.result)
        expect(late._tag === "Failure" && late.failure.code).toBe("CACHE_INVALIDATED")
        const lateContent = yield* store.writeJson(key, { generation: next }).pipe(Effect.result)
        expect(lateContent._tag === "Failure" && lateContent.failure.code).toBe("CACHE_INVALIDATED")
      }),
    )
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
  }
})
