import { Context, Crypto, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { ConfigSchema, decode, fail, SkillsError } from "./model.ts"

export class Store extends Context.Service<
  Store,
  {
    readonly root: string
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
    const location = (key: string) => path.join(key === "config.json" ? configRoot : root, key)
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
    return {
      root,
      writeBytes,
      readBytes: (key) =>
        fs.readFile(location(key)).pipe(
          Effect.mapError(() =>
            fail("SNAPSHOT_MISSING", "The requested snapshot file is unavailable locally.", {
              key,
            }),
          ),
        ),
      writeJson: (key, value) => writeBytes(key, new TextEncoder().encode(JSON.stringify(value))),
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
