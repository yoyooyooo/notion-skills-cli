import { Config, Context, Crypto, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { ConfigSchema, SnapshotSchema, decode, fail, property, SkillsError } from "./model.ts"
import type { Base, SyncBinding, SyncReceipt } from "./sync.ts"
import type { UpstreamRepository } from "./upstream-state.ts"
import type { PublicationIntegrityRepository } from "./publication-integrity-state.ts"

export class Store extends Context.Service<
  Store,
  {
    readonly root: string
    readonly configRoot: string
    readonly cacheRoot: string
    readonly upstream: UpstreamRepository
    readonly integrity: PublicationIntegrityRepository
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
    readonly registerBindingWithBase: (
      binding: SyncBinding,
      base: Base,
    ) => Effect.Effect<void, SkillsError>
    readonly advanceBaseAndReceipt: (
      bindingId: string,
      expectedGeneration: number,
      next: Base,
      receipt: SyncReceipt,
    ) => Effect.Effect<void, SkillsError>
    readonly backup: (
      destination: string,
    ) => Effect.Effect<{ directory: string; database: string }, SkillsError>
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
    const settings = yield* Config.all({
      home: Config.option(Config.String("HOME")),
      userProfile: Config.option(Config.String("USERPROFILE")),
      state: Config.option(Config.String("NTN_SKILLS_HOME")),
      config: Config.option(Config.String("NTN_SKILLS_CONFIG_HOME")),
      cache: Config.option(Config.String("NTN_SKILLS_CACHE_HOME")),
      xdgState: Config.option(Config.String("XDG_STATE_HOME")),
      xdgConfig: Config.option(Config.String("XDG_CONFIG_HOME")),
      xdgCache: Config.option(Config.String("XDG_CACHE_HOME")),
    }).pipe(Effect.mapError(() => fail("CONFIG_ERROR", "Local root configuration is invalid.")))
    const home = Option.getOrUndefined(settings.home) ?? Option.getOrUndefined(settings.userProfile)
    const resolveRoot = (
      explicit: Option.Option<string>,
      xdg: Option.Option<string>,
      suffix: readonly string[],
    ) => {
      const root = Option.getOrUndefined(explicit)
      const base = Option.getOrUndefined(xdg)
      if (root !== undefined) return Effect.succeed(path.resolve(root))
      if (base !== undefined) return Effect.succeed(path.resolve(base, "ntn-skills"))
      if (home !== undefined) return Effect.succeed(path.resolve(home, ...suffix, "ntn-skills"))
      return Effect.fail(fail("CONFIG_ERROR", "Set explicit state/config/cache roots or HOME."))
    }
    const root = yield* resolveRoot(settings.state, settings.xdgState, [".local", "state"])
    const configRoot = yield* resolveRoot(settings.config, settings.xdgConfig, [".config"])
    const cacheRoot = yield* resolveRoot(settings.cache, settings.xdgCache, [".cache"])
    if (yield* fs.exists(path.join(configRoot, "config.json"))) {
      const rawConfig = yield* fs.readFileString(path.join(configRoot, "config.json"))
      const oldBindings = yield* Effect.try({
        try: () => property(JSON.parse(rawConfig)).sync_bindings,
        catch: () => fail("STATE_CORRUPT", "Configuration JSON is corrupt."),
      })
      if (oldBindings !== undefined)
        return yield* Effect.fail(
          fail(
            "STATE_MIGRATION_REQUIRED",
            "Stop old writers and migrate the retained bindings before creating SQLite state.",
          ),
        )
    }
    const { sqliteState } = yield* Effect.promise(() => import("./sqlite-state.ts"))
    const state = yield* sqliteState(root, fs)
    const location = (key: string) =>
      key === "config.json" ? path.join(configRoot, key) : path.join(root, key)
    // Sync every ancestor, including existing directories: another publisher may have
    // created one without reaching its own parent-entry durability barrier yet.
    const syncDirectoryChain = (directory: string) =>
      Effect.gen(function* () {
        let current = directory
        while (true) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* fs.open(current, { flag: "r" })
              yield* handle.sync
            }),
          )
          const parent = path.dirname(current)
          if (parent === current) break
          current = parent
        }
      })
    const durableExisting = (key: string, bytes: Uint8Array) =>
      Effect.scoped(
        Effect.gen(function* () {
          const destination = location(key)
          const existing = yield* fs.readFile(destination)
          let equivalentSnapshot = false
          if (key.startsWith("snapshots/")) {
            const pair = yield* Effect.try({
              try: () => {
                const actual = JSON.parse(new TextDecoder().decode(existing)) as unknown
                const proposed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
                decode(SnapshotSchema, actual)
                decode(SnapshotSchema, proposed)
                return [property(actual), property(proposed)] as const
              },
              catch: () => fail("STATE_CORRUPT", "Snapshot manifest is invalid.", { key }),
            })
            const identity = (snapshot: Record<string, unknown>) => {
              const { created_at: _createdAt, ...content } = snapshot
              return JSON.stringify(content)
            }
            equivalentSnapshot = identity(pair[0]) === identity(pair[1])
          }
          if (
            !equivalentSnapshot &&
            (existing.length !== bytes.length ||
              existing.some((byte, index) => byte !== bytes[index]))
          )
            return yield* Effect.fail(
              fail("STATE_CORRUPT", "An immutable local content identity cannot be overwritten.", {
                key,
              }),
            )
          const file = yield* fs.open(destination, { flag: "r", noFollow: true })
          yield* file.sync
          yield* syncDirectoryChain(path.dirname(destination))
        }),
      )
    const writeBytes = (key: string, bytes: Uint8Array) =>
      Effect.scoped(
        Effect.gen(function* () {
          const destination = location(key)
          if (key !== "config.json" && (yield* fs.exists(destination)))
            return yield* durableExisting(key, bytes)
          yield* fs.makeDirectory(path.dirname(destination), { recursive: true, mode: 0o700 })
          const staged = `${destination}.${yield* crypto.randomUUIDv4()}.pending`
          const file = yield* fs.open(staged, { flag: "wx", mode: 0o600, noFollow: true })
          yield* Effect.addFinalizer(() => fs.remove(staged, { force: true }).pipe(Effect.orDie))
          yield* file.writeAll(bytes)
          yield* file.sync
          if (key === "config.json") {
            yield* fs.rename(staged, destination)
            yield* syncDirectoryChain(path.dirname(destination))
          } else {
            // link is an atomic no-replace install. rename can overwrite a competing
            // immutable publisher before its different bytes have been rejected.
            yield* fs.link(staged, destination).pipe(
              Effect.catchIf(
                (error) => error.reason._tag === "AlreadyExists",
                () => Effect.void,
              ),
            )
            yield* durableExisting(key, bytes)
          }
        }),
      ).pipe(
        Effect.mapError((error) =>
          error instanceof SkillsError
            ? error
            : fail("STORAGE_ERROR", "Could not durably publish local content.", { key }),
        ),
      )
    const readBytes = (key: string) =>
      fs
        .readFile(location(key))
        .pipe(
          Effect.mapError(() =>
            fail("SNAPSHOT_MISSING", "The requested content file is unavailable locally.", { key }),
          ),
        )
    const validateObjects = (snapshot: typeof SnapshotSchema.Type) =>
      Effect.gen(function* () {
        for (const file of snapshot.files) {
          if (!/^[a-f0-9]{64}$/.test(file.sha256))
            return yield* Effect.fail(fail("STATE_CORRUPT", "Snapshot object identity is invalid."))
          const bytes = yield* readBytes(`objects/${file.sha256}`)
          const hash = yield* crypto.digest("SHA-256", bytes)
          if (
            bytes.length !== file.bytes ||
            Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("") !== file.sha256
          )
            return yield* Effect.fail(
              fail("STATE_CORRUPT", "Snapshot references a missing or corrupt durable object.", {
                path: file.path,
              }),
            )
          yield* durableExisting(`objects/${file.sha256}`, bytes)
        }
      })
    const recoverSnapshot = (key: string) =>
      Effect.gen(function* () {
        const bytes = yield* readBytes(key)
        const snapshot = yield* Effect.try({
          try: () => decode(SnapshotSchema, JSON.parse(new TextDecoder().decode(bytes))),
          catch: () => fail("STATE_CORRUPT", "Retained snapshot manifest is invalid."),
        })
        const digest = yield* crypto.digest(
          "SHA-256",
          new TextEncoder().encode(
            JSON.stringify([
              snapshot.scope,
              snapshot.historical_snapshot_id
                ? property(snapshot.record.locator).page_id
                : snapshot.record.id,
              snapshot.version_id,
            ]),
          ),
        )
        const id = `s_${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`
        if (snapshot.snapshot_id !== id || key !== `snapshots/${id}.json`)
          return yield* Effect.fail(
            fail("STATE_CORRUPT", "Retained snapshot identity does not match its manifest."),
          )
        yield* validateObjects(snapshot)
        yield* durableExisting(key, bytes)
        yield* state.write(key, snapshot)
        return snapshot
      })
    return {
      upstream: state.upstream,
      integrity: state.integrity,
      root,
      configRoot,
      cacheRoot,
      reserveCacheGeneration: state.reserve,
      listKeys: state.list,
      retireKeys: state.retire,
      registerBindingWithBase: state.registerBindingWithBase,
      advanceBaseAndReceipt: state.advanceBaseAndReceipt,
      backup: state.backup,
      writeBytes,
      readBytes,
      writeJson: (key: string, value: unknown) =>
        Effect.gen(function* () {
          if (key === "config.json") {
            const { sync_bindings: _bindings, ...config } = property(value)
            return yield* writeBytes(key, new TextEncoder().encode(JSON.stringify(config)))
          }
          if (key.startsWith("snapshots/")) {
            const snapshot = yield* Effect.try({
              try: () => decode(SnapshotSchema, value),
              catch: () => fail("STATE_CORRUPT", "Snapshot manifest is invalid."),
            })
            yield* validateObjects(snapshot)
            // File publication precedes pointer registration. A crash can leave an unreferenced file,
            // never a committed successful snapshot whose objects have not been made durable.
            yield* writeBytes(key, new TextEncoder().encode(JSON.stringify(value)))
            const bytes = yield* readBytes(key)
            const canonical = yield* Effect.try({
              try: () => decode(SnapshotSchema, JSON.parse(new TextDecoder().decode(bytes))),
              catch: () => fail("STATE_CORRUPT", "Invalid canonical snapshot."),
            })
            if (
              canonical.snapshot_id !== snapshot.snapshot_id ||
              canonical.scope !== snapshot.scope ||
              canonical.record.id !== snapshot.record.id ||
              canonical.version_id !== snapshot.version_id
            )
              return yield* Effect.fail(
                fail("STATE_CORRUPT", "Canonical snapshot identity differs from its publication."),
              )
            yield* validateObjects(canonical)
            yield* state.write(key, canonical)
            const registered = yield* state.read(key)
            if (JSON.stringify(registered) !== JSON.stringify(canonical))
              return yield* Effect.fail(
                fail(
                  "STATE_CORRUPT",
                  "SQLite snapshot differs from its canonical immutable manifest.",
                ),
              )
            return
          }
          yield* state.write(key, value)
        }).pipe(
          Effect.mapError((e) =>
            e instanceof SkillsError
              ? e
              : fail("STORAGE_ERROR", "Could not publish domain state.", { key }),
          ),
        ),
      readJson: <S extends Schema.ConstraintDecoder<unknown>>(key: string, schema: S) =>
        Effect.gen(function* () {
          let value: unknown
          if (key === "config.json") {
            let config: Record<string, unknown> = {}
            if (yield* fs.exists(location(key))) {
              const raw = yield* fs.readFileString(location(key))
              config = yield* Effect.try({
                try: () => property(JSON.parse(raw)),
                catch: () => fail("STATE_CORRUPT", "Configuration JSON is corrupt."),
              })
              if (config.sync_bindings !== undefined)
                return yield* Effect.fail(
                  fail(
                    "STATE_MIGRATION_REQUIRED",
                    "Configuration still contains old bindings; run ntn-skills-migrate after stopping old writers.",
                  ),
                )
            }
            const bindings = yield* state.bindings()
            value = { ...config, ...(bindings.length ? { sync_bindings: bindings } : {}) }
          } else {
            value = yield* state.read(key)
            if (
              value === undefined &&
              key.startsWith("snapshots/") &&
              (yield* fs.exists(location(key)))
            )
              value = yield* recoverSnapshot(key)
          }
          if (value === undefined) return undefined
          return yield* Effect.try({
            try: () => {
              const decoded = decode(schema, value)
              return key === "config.json"
                ? ({ ...property(value), ...property(decoded) } as S["Type"])
                : decoded
            },
            catch: () =>
              fail("STATE_CORRUPT", "Local domain state failed schema validation.", { key }),
          })
        }).pipe(
          Effect.mapError((e) =>
            e instanceof SkillsError
              ? e
              : fail("STORAGE_ERROR", "Could not read local state.", { key }),
          ),
        ),
      output: (destination: string, bytes: Uint8Array) =>
        Effect.gen(function* () {
          const full = path.resolve(destination)
          if (yield* fs.exists(full)) {
            const info = yield* fs.stat(full)
            const existing = info.type === "File" ? yield* fs.readFile(full) : undefined
            if (
              !existing ||
              existing.length !== bytes.length ||
              existing.some((byte, index) => byte !== bytes[index])
            )
              return yield* Effect.fail(
                fail("OUTPUT_CONFLICT", "Existing output differs or is not a file.", {
                  output: full,
                }),
              )
            return { output: full, reused: true }
          }
          yield* fs.writeFile(full, bytes, { flag: "wx", mode: 0o600 })
          return { output: full, reused: false }
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
  return (yield* (yield* Store).readJson("config.json", ConfigSchema)) ?? { sources: [] }
})
export const configuredSources = configuration.pipe(Effect.map((config) => config.sources ?? []))
export const configuredToken = Effect.gen(function* () {
  const config = yield* configuration
  if (config.token?.trim()) return config.token.trim()
  const token = yield* Config.option(Config.String("NOTION_API_TOKEN")).pipe(
    Effect.mapError(() => fail("CONFIG_ERROR", "The credential configuration is invalid.")),
  )
  return Option.getOrUndefined(token)?.trim() || undefined
})
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
    yield* (yield* Store).writeJson("config.json", next)
    return publicConfiguration(next)
  })
}
export const sha256 = (input: string | Uint8Array) =>
  Effect.gen(function* () {
    const hash = yield* (yield* Crypto.Crypto).digest(
      "SHA-256",
      typeof input === "string" ? new TextEncoder().encode(input) : input,
    )
    return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("")
  }).pipe(Effect.mapError(() => fail("CRYPTO_ERROR", "Could not compute a content identity.")))
