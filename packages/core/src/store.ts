import { Context, Crypto, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { ConfigSchema, decode, fail, SkillsError } from "./model.ts"
import { withLocalLocks, trashPath } from "./local-locks.ts"

export class Store extends Context.Service<
  Store,
  {
    readonly root: string
    readonly configRoot: string
    readonly cacheRoot: string
    readonly reserveCacheGeneration: (
      scope: string,
      pageId: string,
    ) => Effect.Effect<number, SkillsError>
    readonly listKeys: (prefix: string) => Effect.Effect<readonly string[], SkillsError>
    readonly retireKeys: (
      keys: readonly string[],
    ) => Effect.Effect<readonly { key: string; retention_path: string }[], SkillsError>
    readonly readJson: <S extends Schema.ConstraintDecoder<unknown>>(
      key: string,
      schema: S,
    ) => Effect.Effect<S["Type"] | undefined, SkillsError>
    readonly writeJson: (key: string, value: unknown) => Effect.Effect<void, SkillsError>
    readonly readBytes: (key: string) => Effect.Effect<Uint8Array, SkillsError>
    readonly writeBytes: (key: string, bytes: Uint8Array) => Effect.Effect<void, SkillsError>
    readonly output: (
      destination: string,
      bytes: Uint8Array,
    ) => Effect.Effect<{ output: string; reused: boolean }, SkillsError>
  }
>()("ntn-skills/Store") {}

export const StoreLive = Layer.effect(
  Store,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const crypto = yield* Crypto.Crypto
    const home = process.env.HOME ?? process.env.USERPROFILE
    if (!process.env.NTN_SKILLS_HOME && !process.env.XDG_STATE_HOME && !home) {
      return yield* Effect.fail(
        fail("CONFIG_ERROR", "Set NTN_SKILLS_HOME or HOME to select the local state directory."),
      )
    }
    if (!process.env.NTN_SKILLS_CONFIG_HOME && !process.env.XDG_CONFIG_HOME && !home) {
      return yield* Effect.fail(
        fail(
          "CONFIG_ERROR",
          "Set NTN_SKILLS_CONFIG_HOME or HOME to select the configuration directory.",
        ),
      )
    }
    const root = path.resolve(
      process.env.NTN_SKILLS_HOME ??
        path.join(process.env.XDG_STATE_HOME ?? path.join(home!, ".local", "state"), "ntn-skills"),
    )
    const configRoot = path.resolve(
      process.env.NTN_SKILLS_CONFIG_HOME ??
        path.join(process.env.XDG_CONFIG_HOME ?? path.join(home!, ".config"), "ntn-skills"),
    )
    if (!process.env.NTN_SKILLS_CACHE_HOME && !process.env.XDG_CACHE_HOME && !home)
      return yield* Effect.fail(
        fail("CONFIG_ERROR", "Set NTN_SKILLS_CACHE_HOME or HOME to select the cache directory."),
      )
    const cacheRoot = path.resolve(
      process.env.NTN_SKILLS_CACHE_HOME ??
        path.join(process.env.XDG_CACHE_HOME ?? path.join(home!, ".cache"), "ntn-skills"),
    )
    const location = (key: string) =>
      key === "cache"
        ? cacheRoot
        : key.startsWith("cache/")
          ? path.join(cacheRoot, key.slice(6))
          : path.join(key === "config.json" ? configRoot : root, key)
    const writeBytes = (key: string, bytes: Uint8Array) =>
      Effect.gen(function* () {
        const destination = location(key)
        yield* fs.makeDirectory(path.dirname(destination), { recursive: true, mode: 0o700 })
        const id = yield* crypto.randomUUIDv4()
        const staged = `${destination}.${id}.pending`
        yield* fs.writeFile(staged, bytes, { flag: "wx", mode: 0o600 })
        yield* fs.rename(staged, destination)
      }).pipe(
        Effect.mapError(() =>
          fail("STORAGE_ERROR", "Could not atomically write local state.", { key }),
        ),
      )
    const GenerationSchema = Schema.Struct({
      generation: Schema.Number,
      retired_through: Schema.optional(Schema.Number),
    })
    const generationState = (scope: string, pageId: string) =>
      Effect.gen(function* () {
        const key = `cache-generations/${scope}/${pageId}.json`
        if (!(yield* fs.exists(location(key)))) return { generation: 0, retired_through: 0 }
        const raw = yield* fs.readFileString(location(key))
        return yield* Effect.try({
          try: () => {
            const value = decode(GenerationSchema, JSON.parse(raw))
            if (
              !Number.isSafeInteger(value.generation) ||
              value.generation < 0 ||
              (value.retired_through !== undefined &&
                (!Number.isSafeInteger(value.retired_through) || value.retired_through < 0))
            )
              throw fail("STATE_CORRUPT", "Cache generation state is invalid.")
            return { generation: value.generation, retired_through: value.retired_through ?? 0 }
          },
          catch: () => fail("STATE_CORRUPT", "Cache generation state is invalid."),
        })
      }).pipe(
        Effect.mapError((error) =>
          error instanceof SkillsError
            ? error
            : fail("STORAGE_ERROR", "Could not read cache generation state."),
        ),
      )
    return {
      root,
      configRoot,
      cacheRoot,
      reserveCacheGeneration: (scope, pageId) =>
        withLocalLocks(
          root,
          [`cache-generation:${scope}/${pageId}`],
          Effect.gen(function* () {
            if (!/^[a-f0-9]{64}$/.test(scope) || !/^[a-zA-Z0-9-]+$/.test(pageId))
              return yield* Effect.fail(
                fail("INVALID_ARGUMENT", "Cache generation identity is invalid."),
              )
            const key = `cache-generations/${scope}/${pageId}.json`
            const previous = yield* generationState(scope, pageId)
            const generation = previous.generation + 1
            if (!Number.isSafeInteger(generation))
              return yield* Effect.fail(fail("STATE_CORRUPT", "Cache generation exhausted."))
            yield* writeBytes(
              key,
              new TextEncoder().encode(JSON.stringify({ ...previous, generation })),
            )
            return generation
          }),
        ),
      listKeys: (prefix) =>
        Effect.gen(function* () {
          const directory = location(prefix)
          if (!(yield* fs.exists(directory))) return []
          const names = yield* fs.readDirectory(directory, { recursive: true })
          const keys: string[] = []
          for (const name of names)
            if ((yield* fs.stat(path.join(directory, name))).type === "File")
              keys.push(`${prefix.replace(/\/$/, "")}/${name.split(path.sep).join("/")}`)
          return keys.sort()
        }).pipe(
          Effect.mapError(() => fail("STORAGE_ERROR", "Could not enumerate local observations.")),
        ),
      retireKeys: (keys) =>
        Effect.gen(function* () {
          if (
            keys.some(
              (key) => !key.startsWith("cache/") || !location(key).startsWith(cacheRoot + path.sep),
            )
          )
            return yield* Effect.fail(
              fail("INVALID_ARGUMENT", "Only disposable cache observations may be retired."),
            )
          const retired: Array<{ key: string; retention_path: string }> = []
          const pages = [
            ...new Set(
              keys
                .filter(
                  (key) => key.startsWith("cache/latest/") || key.startsWith("cache/catalogs/"),
                )
                .map((key) => {
                  const parts = key.split("/")
                  return `${parts[2]}/${parts[1] === "catalogs" ? `catalog-${parts[3]!.replace(/\.json$/, "")}` : parts[3]}`
                }),
            ),
          ]
          return yield* withLocalLocks(
            root,
            pages.map((page) => `cache-generation:${page}`),
            Effect.gen(function* () {
              // Fence the entire batch before a retention failure can stop retirement.
              for (const page of pages) {
                const [scope, id] = page.split("/")
                const current = yield* generationState(scope!, id!)
                let generation = current.generation
                for (const key of keys) {
                  const parts = key.split("/")
                  const identity =
                    parts[1] === "catalogs"
                      ? `catalog-${parts[3]!.replace(/\.json$/, "")}`
                      : parts[3]
                  if (parts[2] !== scope || identity !== id || !(yield* fs.exists(location(key))))
                    continue
                  const raw = yield* fs.readFileString(location(key))
                  const observed = yield* Effect.try({
                    try: () => decode(GenerationSchema, JSON.parse(raw)),
                    catch: () => fail("STATE_CORRUPT", "Observation generation is invalid."),
                  }).pipe(Effect.result)
                  if (observed._tag === "Success")
                    generation = Math.max(generation, observed.success.generation)
                }
                yield* writeBytes(
                  `cache-generations/${page}.json`,
                  new TextEncoder().encode(
                    JSON.stringify({ generation, retired_through: generation }),
                  ),
                )
              }
              for (const key of keys) {
                if (!(yield* fs.exists(location(key)))) continue
                yield* trashPath(location(key))
                retired.push({ key, retention_path: "system_trash" })
              }
              return retired
            }),
          )
        }).pipe(
          Effect.mapError((error) =>
            error instanceof SkillsError
              ? error
              : fail("STORAGE_ERROR", "Could not retire cache observations."),
          ),
        ),
      writeBytes,
      readBytes: (key) =>
        fs.readFile(location(key)).pipe(
          Effect.mapError(() =>
            fail("SNAPSHOT_MISSING", "The requested snapshot file is unavailable locally.", {
              key,
            }),
          ),
        ),
      writeJson: (key, value) => {
        if (!key.startsWith("cache/latest/") && !key.startsWith("cache/catalogs/"))
          return writeBytes(key, new TextEncoder().encode(JSON.stringify(value)))
        const parts = key.split("/")
        const scope = parts[2]!
        const id =
          parts[1] === "catalogs" ? `catalog-${parts[3]!.replace(/\.json$/, "")}` : parts[3]!
        return withLocalLocks(
          root,
          [`cache-generation:${scope}/${id}`],
          Effect.gen(function* () {
            const state = yield* generationState(scope!, id!)
            if (
              !value ||
              typeof value !== "object" ||
              !("generation" in value) ||
              typeof value.generation !== "number" ||
              value.generation <= state.retired_through
            )
              return yield* Effect.fail(
                fail(
                  "CACHE_INVALIDATED",
                  "An in-flight observation was retired before publication.",
                ),
              )
            if (parts[1] === "catalogs" && (yield* fs.exists(location(key)))) {
              const raw = yield* fs.readFileString(location(key))
              const previous = yield* Effect.try({
                try: () => decode(GenerationSchema, JSON.parse(raw)),
                catch: () => fail("STATE_CORRUPT", "Catalog observation generation is invalid."),
              }).pipe(Effect.result)
              if (previous._tag === "Success" && previous.success.generation > value.generation)
                return
            }
            yield* writeBytes(key, new TextEncoder().encode(JSON.stringify(value)))
          }),
        ).pipe(
          Effect.mapError((error) =>
            error instanceof SkillsError
              ? error
              : fail("STORAGE_ERROR", "Could not publish cache observation."),
          ),
        )
      },
      readJson: (key, schema) =>
        Effect.gen(function* () {
          if (key === "config.json" && !(yield* fs.exists(location(key)))) {
            const legacy = path.join(root, key)
            if (yield* fs.exists(legacy)) {
              const raw = yield* fs.readFileString(legacy)
              yield* Effect.try({
                try: () => decode(ConfigSchema, JSON.parse(raw)),
                catch: () =>
                  fail("STATE_CORRUPT", "Legacy configuration failed schema validation."),
              })
              yield* fs.makeDirectory(configRoot, { recursive: true, mode: 0o700 })
              yield* fs.copy(legacy, location(key), { overwrite: false })
              yield* fs.chmod(location(key), 0o600)
              const id = yield* crypto.randomUUIDv4()
              yield* fs.rename(legacy, `${legacy}.${id}.migrated`)
            }
          }
          if (!(yield* fs.exists(location(key)))) return undefined
          const raw = yield* fs.readFileString(location(key))
          if (key.startsWith("cache/latest/") || key.startsWith("cache/catalogs/")) {
            const parts = key.split("/")
            const scope = parts[2]!
            const id =
              parts[1] === "catalogs" ? `catalog-${parts[3]!.replace(/\.json$/, "")}` : parts[3]!
            const state = yield* generationState(scope!, id!)
            const generation = yield* Effect.try({
              try: () => decode(GenerationSchema, JSON.parse(raw)).generation,
              catch: () => fail("STATE_CORRUPT", "Cache observation is invalid."),
            })
            if (generation <= state.retired_through) return undefined
          }
          return yield* Effect.try({
            try: () => decode(schema, JSON.parse(raw)),
            catch: () => fail("STATE_CORRUPT", "Local state failed schema validation.", { key }),
          })
        }).pipe(
          Effect.mapError((e) =>
            e instanceof SkillsError
              ? e
              : fail("STORAGE_ERROR", "Could not read local state.", { key }),
          ),
        ),
      output: (destination, bytes) =>
        Effect.gen(function* () {
          const full = path.resolve(destination)
          const reuse = Effect.gen(function* () {
            const info = yield* fs.stat(full)
            if (info.type !== "File")
              return yield* Effect.fail(
                fail("OUTPUT_CONFLICT", "Output is not a regular file.", { output: full }),
              )
            const existing = yield* fs.readFile(full)
            if (
              existing.length !== bytes.length ||
              existing.some((byte, index) => byte !== bytes[index])
            )
              return yield* Effect.fail(
                fail("OUTPUT_CONFLICT", "Existing output differs.", { output: full }),
              )
            return { output: full, reused: true }
          })
          if (yield* fs.exists(full)) return yield* reuse
          return yield* fs.writeFile(full, bytes, { flag: "wx", mode: 0o600 }).pipe(
            Effect.map(() => ({ output: full, reused: false })),
            Effect.catch((error) =>
              Effect.gen(function* () {
                if (yield* fs.exists(full)) return yield* reuse
                return yield* Effect.fail(error)
              }),
            ),
          )
        }).pipe(
          Effect.mapError((error) =>
            error instanceof SkillsError
              ? error
              : fail("OUTPUT_FAILED", "Could not write output; parent directory must exist.", {
                  destination,
                }),
          ),
        ),
    }
  }),
)

export const configuration = Effect.gen(function* () {
  const store = yield* Store
  return (yield* store.readJson("config.json", ConfigSchema)) ?? { sources: [] }
})
export const configuredSources = configuration.pipe(Effect.map((config) => config.sources ?? []))

export const configuredToken = configuration.pipe(
  Effect.map((config) => config.token?.trim() || process.env.NOTION_API_TOKEN?.trim() || undefined),
)

export function publicConfiguration(config: typeof ConfigSchema.Type) {
  const { token, ...visible } = config
  return { ...visible, token_configured: Boolean(token?.trim()) }
}

export function setToken(input?: string) {
  return Effect.gen(function* () {
    const token = input?.trim()
    if (input !== undefined && (!token || /\s/.test(token)))
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Provide one non-empty token through standard input."),
      )
    const { token: _previous, ...config } = yield* configuration
    const next = { ...config, ...(token ? { token } : {}) }
    const store = yield* Store
    yield* store.writeJson("config.json", next)
    return publicConfiguration(next)
  })
}

export const sha256 = (input: string | Uint8Array) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const hash = yield* crypto.digest(
      "SHA-256",
      typeof input === "string" ? new TextEncoder().encode(input) : input,
    )
    return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("")
  }).pipe(Effect.mapError(() => fail("CRYPTO_ERROR", "Could not compute a content identity.")))
