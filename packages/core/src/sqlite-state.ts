import { Clock, Context, Crypto, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import {
  cacheCapacity,
  DEFAULT_CACHE_CAPACITY,
  rebuildableCacheKey,
  type CacheCapacity,
} from "./cache-retention-model.ts"
import { identitySegment, identityFromSegment } from "./cache-address.ts"
import { retainCompleteCatalog } from "./catalog-cache.ts"
import { trashPath } from "./local-locks.ts"
import { fail, property, SkillsError } from "./model.ts"
import { skillIdentity } from "./shared-content.ts"
import { probeSqliteRuntime } from "./sqlite-runtime-policy.ts"
import { CurrentSourceSyncPendingSchema } from "./shared-current-source-sync-model.ts"
import {
  CurrentSourceSyncBatchSchema,
  preservesCurrentSourceSyncBatch,
} from "./shared-current-source-sync-batch-model.ts"
import {
  ImportPlanSchema,
  currentImportPlanAddressInput,
  preservesCurrentImportPlan,
} from "./shared-current-import-plan-model.ts"
import {
  LibraryInitializationPendingSchema,
  preservesLibraryInitialization,
} from "./shared-library-model.ts"

// This physical schema identifies current local execution state, not content history.
const currentApplicationId = 0x4e544e43
const initializeCurrentSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const statement of [
        `CREATE TABLE state_format (version INTEGER NOT NULL CHECK(version=1));`,
        `INSERT INTO state_format VALUES (1);`,
        `CREATE TABLE snapshots (id TEXT PRIMARY KEY, scope TEXT NOT NULL, record_identity TEXT NOT NULL, locator TEXT NOT NULL, version_id TEXT NOT NULL, manifest TEXT NOT NULL);`,
        `CREATE TABLE cache_fences (scope TEXT NOT NULL, identity TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>=0), retired_through INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,identity));`,
        `CREATE TABLE observations (id TEXT PRIMARY KEY, scope TEXT NOT NULL, record_identity TEXT NOT NULL, generation INTEGER NOT NULL, validated_at REAL NOT NULL, snapshot_id TEXT, payload TEXT NOT NULL);`,
        `CREATE INDEX observations_record ON observations(scope,record_identity,generation DESC);`,
        `CREATE TABLE catalogs (scope TEXT NOT NULL, selection TEXT NOT NULL, generation INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(scope,selection));`,
        `CREATE TABLE identities (id TEXT PRIMARY KEY, scope TEXT NOT NULL);`,
        `CREATE TABLE view_observations (scope TEXT NOT NULL, selection TEXT NOT NULL, generation INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(scope,selection));`,
        `CREATE TABLE shared_local_records (key TEXT PRIMARY KEY, category TEXT NOT NULL CHECK(category IN ('cache','dispatch')), payload TEXT NOT NULL CHECK(json_valid(payload)), retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0,1)));`,
        `CREATE INDEX shared_local_records_active ON shared_local_records(category,retired,key);`,
        `CREATE TABLE local_content_restrictions (sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64), payload TEXT NOT NULL CHECK(json_valid(payload)));`,
        `CREATE TABLE cache_admissions (key TEXT PRIMARY KEY REFERENCES shared_local_records(key) ON DELETE CASCADE, admitted_at INTEGER NOT NULL CHECK(admitted_at>=0));`,
        `PRAGMA application_id = ${currentApplicationId};`,
      ])
        yield* sql.unsafe(statement)
    }),
  )
})

type SharedLocalCategory = "cache" | "dispatch"
function sharedFileObservationOwner(value: unknown) {
  const { generation, scope, library_id, skill_id, skill_page_id } = property(value)
  if (
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    typeof scope !== "string" ||
    typeof library_id !== "string" ||
    typeof skill_id !== "string" ||
    typeof skill_page_id !== "string"
  )
    throw fail(
      "INVALID_ARGUMENT",
      "A shared file observation requires an exact owner and positive safe generation.",
    )
  return {
    generation,
    scope,
    library_id,
    skill_id,
    skill_page_id,
    record_identity: skillIdentity(library_id, skill_id),
  }
}
const sharedCurrentTreeValidationPrefix = "cache/shared-current-tree-validation"
const currentNativeBodiesPrefix = "cache/current-native-bodies"
function fencedFileObservation(key: string): boolean {
  return key.startsWith(`${currentNativeBodiesPrefix}/`) && key.endsWith("/latest.json")
}
const mutableSharedLocalPrefixes = [sharedCurrentTreeValidationPrefix, "cache/current-source-sync"]
const sharedLocalDomains: readonly {
  readonly prefix: string
  readonly category: SharedLocalCategory
  readonly address: RegExp
}[] = [
  {
    prefix: "operations/current-source-sync-batch",
    category: "dispatch",
    address: /^operations\/current-source-sync-batch\/[a-f0-9]{64}\/pending\.json$/u,
  },
  {
    prefix: "operations/current-source-sync",
    category: "dispatch",
    address: /^operations\/current-source-sync\/[a-f0-9]{64}\/pending\.json$/u,
  },
  {
    prefix: "cache/current-source-sync",
    category: "cache",
    address: /^cache\/current-source-sync\/[a-f0-9]{64}\/latest\.json$/u,
  },
  {
    prefix: "operations/import-plan",
    category: "dispatch",
    address: /^operations\/import-plan\/[a-f0-9]{64}\/plan\.json$/u,
  },
  {
    prefix: currentNativeBodiesPrefix,
    category: "cache",
    address: /^cache\/current-native-bodies\/[a-f0-9]{64}\/latest\.json$/u,
  },
  {
    prefix: "cache/shared-page-identities",
    category: "cache",
    address:
      /^cache\/shared-page-identities\/[a-f0-9]{64}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/u,
  },
  {
    prefix: "cache/shared-github-blobs",
    category: "cache",
    address: /^cache\/shared-github-blobs\/[a-f0-9]{40}\.json$/u,
  },
  {
    prefix: sharedCurrentTreeValidationPrefix,
    category: "cache",
    address: /^cache\/shared-current-tree-validation\/[a-f0-9]{64}\/s_[a-f0-9]{64}\.json$/u,
  },
  {
    prefix: "cache/shared-derived-graphs",
    category: "cache",
    address: /^cache\/shared-derived-graphs\/[a-f0-9]{64}\/[a-f0-9]{64}\/[a-f0-9]{64}\.json$/u,
  },
  {
    prefix: "operations/shared-profile-pending",
    category: "dispatch",
    address: /^operations\/shared-profile-pending\/[a-f0-9]{64}\/[a-f0-9]{64}\/pending\.json$/u,
  },
  {
    prefix: "operations/current-write-pending",
    category: "dispatch",
    address: /^operations\/current-write-pending\/[a-f0-9]{64}\/pending\.json$/u,
  },
  {
    prefix: "operations/library-init-pending",
    category: "dispatch",
    address: /^operations\/library-init-pending\/[a-f0-9]{64}\/pending\.json$/u,
  },
]

function localContentHash(key: string): string | undefined {
  if (key !== "content-restrictions" && !key.startsWith("content-restrictions/")) return undefined
  const match = /^content-restrictions\/local\/([a-f0-9]{64})\.json$/u.exec(key)
  if (match === null)
    throw fail("INVALID_ARGUMENT", "Invalid local content restriction address.", { key })
  return match[1]!
}
function localContentPayload(hash: string, value: unknown): string {
  const record = property(value)
  if (
    record.version !== 1 ||
    record.sha256 !== hash ||
    record.reason !== "local_resource" ||
    Object.keys(record).sort().join(",") !== "reason,sha256,version"
  )
    throw fail(
      "STATE_CORRUPT",
      "A local content restriction must preserve its exact hash and reason.",
    )
  return JSON.stringify({ version: 1, sha256: hash, reason: "local_resource" })
}

/** Freeze the entire current intent without depending on an owner-specific DTO.
 * JSON object key order has no meaning; ordered arrays remain part of the input. */
function currentIntentIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(currentIntentIdentity)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, currentIntentIdentity(item)]),
  )
}

/** Explicit shared-derived and dispatch domains; this is not an arbitrary JSON key store. */
function sharedLocalCategory(key: string): SharedLocalCategory | undefined {
  const domain = sharedLocalDomains.find(
    (entry) => key === entry.prefix || key.startsWith(`${entry.prefix}/`),
  )
  if (domain === undefined) return undefined
  if (!domain.address.test(key))
    throw fail("INVALID_ARGUMENT", "Invalid shared SQLite domain address.", { key })
  return domain.category
}

function storageError(error: unknown): SkillsError {
  if (error instanceof SkillsError) return error
  const outer = property(error)
  if (outer._tag === "MigrationError" && outer.cause !== undefined) return storageError(outer.cause)
  const reason = property(outer.reason)
  const cause = property(reason.cause)
  const native =
    typeof cause.errcode === "number"
      ? cause.errcode
      : typeof cause.errno === "number"
        ? cause.errno
        : undefined
  const primary = native === undefined ? undefined : native & 0xff
  const code = typeof cause.code === "string" ? cause.code : undefined
  const details = {
    phase: "sqlite_state",
    error_tag: outer._tag,
    reason: reason._tag,
    operation: reason.operation,
    ...(native === undefined ? {} : { sqlite_code: native }),
    ...(code === undefined ? {} : { native_code: code }),
  }
  if (
    primary === 11 ||
    primary === 26 ||
    code?.startsWith("SQLITE_CORRUPT") ||
    code === "SQLITE_NOTADB"
  )
    return fail(
      "STATE_CORRUPT",
      "SQLite reports corrupt database bytes; restore a complete backup before continuing.",
      details,
    )
  if (
    [5, 6, 7, 13, 15, 18].includes(primary ?? -1) ||
    ["LockTimeoutError", "Busy", "WouldBlock", "TimedOut"].includes(String(reason._tag)) ||
    outer.kind === "Locked"
  )
    return fail(
      "STATE_BUSY",
      "Local state is busy or resource capacity is exhausted; the bounded SQLite wait expired when a lock was held.",
      details,
    )
  if (
    [3, 8, 10, 14, 22, 23].includes(primary ?? -1) ||
    [
      "ConnectionError",
      "AuthenticationError",
      "AuthorizationError",
      "AlreadyExists",
      "NotFound",
      "PermissionDenied",
      "BadResource",
    ].includes(String(reason._tag))
  )
    return fail(
      "STATE_UNAVAILABLE",
      "SQLite state could not be opened or accessed; check its directory, permissions and storage availability.",
      details,
    )
  if (
    [1, 17, 20, 21, 25].includes(primary ?? -1) ||
    ["SqlSyntaxError", "BadArgument"].includes(String(reason._tag)) ||
    outer._tag === "MigrationError" ||
    code === "ERR_LOAD_SQLITE_EXTENSION" ||
    code === "ERR_INVALID_STATE" ||
    code?.startsWith("ERR_INVALID_ARG")
  )
    return fail(
      "STATE_CONFIG_ERROR",
      "SQLite runtime or schema configuration is incompatible; use the supported Node.js runtime and matching state format.",
      details,
    )
  if (primary === 19 || reason._tag === "ConstraintError" || reason._tag === "UniqueViolation")
    return fail("STATE_CONFLICT", "SQLite rejected a conflicting local state update.", details)
  return fail(
    "STORAGE_ERROR",
    "SQLite operation failed without evidence of database corruption.",
    details,
  )
}
export function sqliteState(
  root: string,
  fs: FileSystem.FileSystem,
  capacityInput: CacheCapacity = DEFAULT_CACHE_CAPACITY,
) {
  return Effect.gen(function* () {
    const capacity = cacheCapacity(capacityInput)
    const crypto = yield* Crypto.Crypto
    const digest = (text: string) =>
      crypto
        .digest("SHA-256", new TextEncoder().encode(text))
        .pipe(
          Effect.map((bytes) =>
            Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
          ),
        )
    yield* probeSqliteRuntime
    const { SqliteClient } = yield* Effect.promise(() => import("@effect/sql-sqlite-node"))
    const filename = `${root}/state.sqlite`
    const client = SqliteClient.layer({ filename, busyTimeout: "2 seconds" })
    const context = yield* Effect.gen(function* () {
      if (!(yield* fs.exists(filename))) {
        {
          for (const entry of [
            "sync/bases",
            "sync/plans",
            "sync/receipts",
            "publications",
            "cache-generations",
            "snapshots",
            "config.json",
            "sqlite-migration.json",
          ])
            if (yield* fs.exists(`${root}/${entry}`))
              return yield* Effect.fail(
                fail(
                  "STATE_CUTOVER_REQUIRED",
                  "This root contains state from the retired protocol. Initialize an explicitly selected new current state root; the old root and its objects remain available for read-only extraction.",
                ),
              )
        }
        yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 })
        yield* Effect.scoped(
          Effect.gen(function* () {
            const crypto = yield* Crypto.Crypto
            const path = yield* Path.Path
            const staged = `${root}/.state-${yield* crypto.randomUUIDv4()}.sqlite`
            yield* Effect.addFinalizer(() => fs.remove(staged, { force: true }).pipe(Effect.orDie))
            yield* Effect.scoped(
              Effect.gen(function* () {
                const initialized = yield* Layer.build(
                  SqliteClient.layer({
                    filename: staged,
                    busyTimeout: "2 seconds",
                    disableWAL: true,
                  }),
                )
                const sql = Context.get(initialized, SqlClient.SqlClient)
                yield* sql`PRAGMA synchronous = FULL`
                yield* initializeCurrentSchema.pipe(Effect.provide(initialized))
                const format = yield* sql<{ version: number }>`SELECT version FROM state_format`
                if (format.length !== 1 || format[0]!.version !== 1)
                  return yield* Effect.fail(
                    fail("STATE_CONFIG_ERROR", "Initialized SQLite state format is incompatible."),
                  )
                const journal = yield* sql<{ journal_mode: string }>`PRAGMA journal_mode`
                if (journal[0]?.journal_mode !== "delete")
                  return yield* Effect.fail(
                    fail(
                      "STATE_CONFIG_ERROR",
                      "SQLite staging must use a self-contained database.",
                    ),
                  )
              }),
            )
            if ((yield* fs.exists(`${staged}-wal`)) || (yield* fs.exists(`${staged}-shm`)))
              return yield* Effect.fail(
                fail("STATE_CORRUPT", "SQLite staging retained uncheckpointed sidecar files."),
              )
            const file = yield* fs.open(staged, { flag: "r", noFollow: true })
            yield* file.sync
            yield* fs.link(staged, filename).pipe(
              Effect.catchIf(
                (error) => error.reason._tag === "AlreadyExists",
                () => Effect.void,
              ),
            )
            let current = root
            while (true) {
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const directory = yield* fs.open(current, { flag: "r" })
                  yield* directory.sync
                }),
              )
              const parent = path.dirname(current)
              if (parent === current) break
              current = parent
            }
          }),
        )
      }
      // Verify the final winner after atomic link and before opening a writable driver.
      // A historical SQLite file must never gain WAL/SHM files or schema changes.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(filename, { flag: "r", noFollow: true })
          const bytes = new Uint8Array(100)
          let read = 0
          while (read < bytes.length) {
            const count = yield* file.read(bytes.subarray(read))
            if (count === 0) break
            read += count
          }
          if (
            read !== 100 ||
            new TextDecoder().decode(bytes.subarray(0, 16)) !== "SQLite format 3\u0000"
          )
            return yield* Effect.fail(
              fail(
                "STATE_CORRUPT",
                "SQLite header is missing or corrupt; an empty replacement is forbidden.",
              ),
            )
          if (
            new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(68, false) !==
            currentApplicationId
          )
            return yield* Effect.fail(
              fail(
                "STATE_CUTOVER_REQUIRED",
                "This SQLite root uses the retired protocol. Initialize an explicitly selected new current state root; the database, sidecars and objects are preserved for read-only extraction.",
                { state_root: root, next_action: "initialize_new_current_root" },
              ),
            )
        }),
      )
      return yield* Layer.build(client)
    }).pipe(Effect.mapError(storageError))
    const clientService = Context.get(context, SqlClient.SqlClient)
    yield* clientService`PRAGMA foreign_keys = ON`.pipe(Effect.mapError(storageError))
    yield* clientService`PRAGMA synchronous = FULL`.pipe(Effect.mapError(storageError))
    const format = yield* clientService<{ version: number }>`SELECT version FROM state_format`.pipe(
      Effect.mapError(storageError),
    )
    if (format.length !== 1 || format[0]!.version !== 1)
      return yield* Effect.fail(
        fail("STATE_CONFIG_ERROR", "Unsupported SQLite state format; use a matching CLI version."),
      )
    const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      effect.pipe(Effect.provide(context), Effect.mapError(storageError))
    const json = (value: unknown) => JSON.stringify(value)
    const parse = (value: string) =>
      Effect.try({
        try: () => JSON.parse(value) as unknown,
        catch: () => fail("STATE_CORRUPT", "Invalid domain state JSON in SQLite."),
      })
    const read = (key: string) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const parts = key.split("/")
          const sharedCategory = yield* Effect.try({
            try: () => sharedLocalCategory(key),
            catch: storageError,
          })
          const restrictedHash = yield* Effect.try({
            try: () => localContentHash(key),
            catch: storageError,
          })
          let rows: readonly Record<string, unknown>[] = []
          if (restrictedHash !== undefined) {
            rows =
              yield* sql`SELECT payload FROM local_content_restrictions WHERE sha256=${restrictedHash}`
          } else if (sharedCategory !== undefined) {
            rows =
              yield* sql`SELECT payload FROM shared_local_records WHERE key=${key} AND category=${sharedCategory} AND retired=0`
          } else if (parts[0] === "snapshots")
            rows =
              yield* sql`SELECT manifest AS payload FROM snapshots WHERE id=${parts[1]!.replace(/\.json$/, "")}`
          else if (parts[0] === "cache-generations")
            rows =
              yield* sql`SELECT json_object('generation',generation,'retired_through',retired_through) AS payload FROM cache_fences WHERE scope=${parts[1]} AND identity=${identityFromSegment(parts[2]!.replace(/\.json$/, ""))}`
          else if (parts[0] === "cache" && parts[1] === "latest")
            rows =
              yield* sql`SELECT o.payload FROM observations o LEFT JOIN cache_fences f ON f.scope=o.scope AND f.identity=o.record_identity WHERE o.id=${key} AND (o.generation>COALESCE(f.retired_through,0) OR json_extract(o.payload,'$.access_denied') IN ('AUTH_REQUIRED','ACCESS_DENIED'))`
          else if (parts[0] === "cache" && parts[1] === "catalogs")
            rows =
              yield* sql`SELECT c.payload FROM catalogs c LEFT JOIN cache_fences f ON f.scope=c.scope AND f.identity='catalog-'||c.selection WHERE c.scope=${parts[2]} AND c.selection=${parts[3]!.replace(/\.json$/, "")} AND c.generation>COALESCE(f.retired_through,0)`
          else if (parts[0] === "cache" && parts[1] === "views")
            rows =
              yield* sql`SELECT c.payload FROM view_observations c LEFT JOIN cache_fences f ON f.scope=c.scope AND f.identity='views-'||c.selection WHERE c.scope=${parts[2]} AND c.selection=${parts[3]!.replace(/\.json$/, "")} AND c.generation>COALESCE(f.retired_through,0)`
          else if (parts[0] === "cache" && parts[1] === "identities")
            rows =
              yield* sql`SELECT json_object('scope',scope) AS payload FROM identities WHERE id=${parts[2]!.replace(/\.json$/, "")}`
          else
            return yield* Effect.fail(
              fail("INVALID_ARGUMENT", "Unknown SQLite domain address.", { key }),
            )
          if (!rows[0]) return undefined
          if (typeof rows[0].payload !== "string")
            return yield* Effect.fail(
              fail("STATE_CORRUPT", "Domain query returned an invalid payload."),
            )
          const parsed = yield* parse(rows[0].payload)
          if (fencedFileObservation(key)) {
            const owner = yield* Effect.try({
              try: () => sharedFileObservationOwner(parsed),
              catch: storageError,
            })
            const fences = yield* sql<{
              retired_through: number
            }>`SELECT retired_through FROM cache_fences WHERE scope=${owner.scope} AND identity=${owner.record_identity}`
            if (owner.generation <= (fences[0]?.retired_through ?? 0)) return undefined
          }
          if (restrictedHash !== undefined)
            yield* Effect.try({
              try: () => localContentPayload(restrictedHash, parsed),
              catch: storageError,
            })
          return parsed
        }),
      )
    const write = (
      key: string,
      value: unknown,
      options?: { readonly expectedCurrentWritePending: unknown },
    ) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          if (
            options !== undefined &&
            !/^operations\/current-write-pending\/[a-f0-9]{64}\/pending\.json$/u.test(key)
          )
            return yield* Effect.fail(
              fail(
                "INVALID_ARGUMENT",
                "Expected-current replacement only addresses a current write pending key.",
                { key },
              ),
            )
          const v = property(value)
          const parts = key.split("/")
          const sharedCategory = yield* Effect.try({
            try: () => sharedLocalCategory(key),
            catch: storageError,
          })
          const restrictedHash = yield* Effect.try({
            try: () => localContentHash(key),
            catch: storageError,
          })
          yield* sql.withTransaction(
            Effect.gen(function* () {
              if (restrictedHash !== undefined) {
                const payload = yield* Effect.try({
                  try: () => localContentPayload(restrictedHash, value),
                  catch: storageError,
                })
                yield* sql`INSERT INTO local_content_restrictions(sha256,payload) VALUES(${restrictedHash},${payload}) ON CONFLICT(sha256) DO NOTHING`
                const stored = yield* sql<{
                  payload: string
                }>`SELECT payload FROM local_content_restrictions WHERE sha256=${restrictedHash}`
                if (stored[0]?.payload !== payload)
                  return yield* Effect.fail(
                    fail(
                      "STATE_CONFLICT",
                      "A durable local content restriction cannot be replaced.",
                    ),
                  )
              } else if (sharedCategory !== undefined) {
                const payload = yield* Effect.try({
                  try: () => {
                    const encoded = json(value)
                    if (typeof encoded !== "string")
                      throw fail(
                        "INVALID_ARGUMENT",
                        "A shared local record requires a frozen JSON payload.",
                        { key },
                      )
                    return encoded
                  },
                  catch: (error) =>
                    error instanceof SkillsError
                      ? error
                      : fail(
                          "INVALID_ARGUMENT",
                          "A shared local record could not be encoded as JSON.",
                          { key },
                        ),
                })
                if (rebuildableCacheKey(key)) {
                  // Acquire the SQLite writer slot before reading the shared total.
                  // Concurrent processes cannot both admit against the same spare bytes.
                  yield* sql`UPDATE cache_admissions SET admitted_at=admitted_at WHERE key=${key}`
                  const existing = yield* sql<{
                    payload: string
                  }>`SELECT payload FROM shared_local_records WHERE key=${key}`
                  if (existing[0] === undefined) {
                    const totals = yield* sql<{
                      bytes: number
                    }>`SELECT COALESCE(SUM(LENGTH(CAST(payload AS BLOB))),0) AS bytes FROM shared_local_records WHERE category='cache' AND (key LIKE 'cache/shared-github-blobs/%' OR key LIKE 'cache/shared-derived-graphs/%' OR key LIKE 'cache/current-source-sync/%')`
                    if (
                      (totals[0]?.bytes ?? 0) + new TextEncoder().encode(payload).length >
                      capacity.max_bytes
                    )
                      return
                  }
                }
                if (fencedFileObservation(key)) {
                  const owner = yield* Effect.try({
                    try: () => sharedFileObservationOwner(value),
                    catch: storageError,
                  })
                  // Claim the existing SQLite writer slot before reading the
                  // fence and current payload; parallel publishers cannot race a
                  // deferred transaction's read-to-write upgrade.
                  yield* sql`UPDATE cache_fences SET generation=generation WHERE scope=${owner.scope} AND identity=${owner.record_identity}`
                  const fences = yield* sql<{
                    retired_through: number
                  }>`SELECT retired_through FROM cache_fences WHERE scope=${owner.scope} AND identity=${owner.record_identity}`
                  const retiredThrough = fences[0]?.retired_through ?? 0
                  if (owner.generation <= retiredThrough)
                    return yield* Effect.fail(
                      fail(
                        "CACHE_INVALIDATED",
                        "An in-flight file observation was retired before publication.",
                        {
                          phase: "cache_publication",
                          cache_key: key,
                          scope: owner.scope,
                          record_identity: owner.record_identity,
                          generation: owner.generation,
                          retired_through: retiredThrough,
                        },
                      ),
                    )
                  const rows = yield* sql<{
                    payload: string
                    category: string
                    retired: number
                  }>`SELECT payload,category,retired FROM shared_local_records WHERE key=${key}`
                  const previous = rows[0]
                  if (previous !== undefined) {
                    const parsed = yield* parse(previous.payload)
                    const prior = yield* Effect.try({
                      try: () => sharedFileObservationOwner(parsed),
                      catch: () =>
                        fail(
                          "STATE_CORRUPT",
                          "The shared file observation slot has an invalid owner or generation.",
                        ),
                    })
                    if (previous.category !== "cache")
                      return yield* Effect.fail(
                        fail(
                          "STATE_CORRUPT",
                          "The shared file observation slot has an invalid generation.",
                        ),
                      )
                    // A rebuilt physical page keeps the same logical owner.
                    // The existing generation order fences late old-page writes;
                    // equal generations still require an identical full payload.
                    for (const field of ["scope", "library_id", "skill_id"] as const)
                      if (prior[field] !== owner[field])
                        return yield* Effect.fail(
                          fail(
                            "STATE_CONFLICT",
                            "A shared file observation slot cannot change its owner.",
                            { key, field },
                          ),
                        )
                    if (owner.generation < prior.generation) return
                    if (owner.generation === prior.generation) {
                      if (previous.payload !== payload)
                        return yield* Effect.fail(
                          fail(
                            "STATE_CONFLICT",
                            "One shared file observation generation cannot have different content.",
                            { key },
                          ),
                        )
                      // A completion from before cache clearing must not resurrect its eligibility.
                      return
                    }
                    yield* sql`UPDATE shared_local_records SET payload=${payload},retired=0 WHERE key=${key} AND category='cache'`
                  } else {
                    yield* sql`INSERT INTO shared_local_records(key,category,payload,retired) VALUES(${key},'cache',${payload},0)`
                  }
                  return
                }
                if (key.startsWith("operations/current-source-sync-batch/")) {
                  const decodeBatch = (input: unknown) =>
                    Effect.try({
                      try: () =>
                        Schema.decodeUnknownSync(CurrentSourceSyncBatchSchema)(input, {
                          onExcessProperty: "error",
                        }),
                      catch: () => fail("STATE_CORRUPT", "Invalid unfinished full Source batch."),
                    })
                  const next = yield* decodeBatch(value)
                  if (key !== `operations/current-source-sync-batch/${next.scope}/pending.json`)
                    return yield* Effect.fail(
                      fail("STATE_CONFLICT", "Full batch scope differs from its address."),
                    )
                  yield* sql`UPDATE shared_local_records SET payload=payload WHERE key=${key} AND category='dispatch' AND retired=0`
                  const rows = yield* sql<{
                    payload: string
                    category: string
                    retired: number
                  }>`SELECT payload,category,retired FROM shared_local_records WHERE key=${key}`
                  const previous = rows[0]
                  if (previous !== undefined) {
                    const before = yield* decodeBatch(yield* parse(previous.payload))
                    if (
                      previous.category !== "dispatch" ||
                      previous.retired !== 0 ||
                      !preservesCurrentSourceSyncBatch(before, next)
                    )
                      return yield* Effect.fail(
                        fail(
                          "STATE_CONFLICT",
                          "A full batch must preserve its frozen scope and completed prefix.",
                        ),
                      )
                    yield* sql`UPDATE shared_local_records SET payload=${payload} WHERE key=${key} AND category='dispatch' AND retired=0`
                  } else {
                    if (next.results.length !== 0)
                      return yield* Effect.fail(
                        fail(
                          "STATE_CONFLICT",
                          "A full batch must start with an empty completed prefix.",
                        ),
                      )
                    yield* sql`INSERT INTO shared_local_records(key,category,payload,retired) VALUES(${key},'dispatch',${payload},0)`
                  }
                  return
                }
                if (key.startsWith("operations/current-source-sync/")) {
                  const decodePending = (input: unknown) =>
                    Effect.try({
                      try: () =>
                        Schema.decodeUnknownSync(CurrentSourceSyncPendingSchema)(input, {
                          onExcessProperty: "error",
                        }),
                      catch: () =>
                        fail("STATE_CORRUPT", "Invalid unfinished Source synchronization."),
                    })
                  const next = yield* decodePending(value)
                  if (next.phase === "projection" && next.next_index > next.targets.length)
                    return yield* Effect.fail(
                      fail(
                        "STATE_CORRUPT",
                        "Source sync projection cursor exceeds its target scope.",
                      ),
                    )
                  if (key !== `operations/current-source-sync/${next.scope}/pending.json`)
                    return yield* Effect.fail(
                      fail("STATE_CONFLICT", "Source sync scope differs from its address."),
                    )
                  yield* sql`UPDATE shared_local_records SET payload=payload WHERE key=${key} AND category='dispatch' AND retired=0`
                  const rows = yield* sql<{
                    payload: string
                    category: string
                    retired: number
                  }>`SELECT payload,category,retired FROM shared_local_records WHERE key=${key}`
                  const previous = rows[0]
                  if (previous !== undefined) {
                    const before = yield* decodePending(yield* parse(previous.payload))
                    const identity = (row: typeof next) =>
                      JSON.stringify(
                        currentIntentIdentity({
                          version: row.version,
                          kind: row.kind,
                          library: row.library,
                          scope: row.scope,
                          manager_id: row.manager_id,
                          execution_id: row.execution_id,
                          full_batch: row.full_batch,
                          input: row.input,
                        }),
                      )
                    if (
                      previous.category !== "dispatch" ||
                      previous.retired !== 0 ||
                      identity(before) !== identity(next) ||
                      (before.phase === "content" &&
                        next.phase === "projection" &&
                        next.next_index !== 0) ||
                      (before.phase === "projection" &&
                        (next.phase !== "projection" ||
                          JSON.stringify(currentIntentIdentity(before.targets)) !==
                            JSON.stringify(currentIntentIdentity(next.targets)) ||
                          (next.next_index !== before.next_index &&
                            next.next_index !== before.next_index + 1)))
                    )
                      return yield* Effect.fail(
                        fail(
                          "STATE_CONFLICT",
                          "Source sync must preserve its owner, frozen input and completed phase.",
                          { key },
                        ),
                      )
                    yield* sql`UPDATE shared_local_records SET payload=${payload} WHERE key=${key} AND category='dispatch' AND retired=0`
                  } else {
                    if (next.phase !== "content")
                      return yield* Effect.fail(
                        fail(
                          "STATE_CONFLICT",
                          "Source synchronization must start with a frozen content input.",
                        ),
                      )
                    yield* sql`INSERT INTO shared_local_records(key,category,payload,retired) VALUES(${key},'dispatch',${payload},0)`
                  }
                  return
                }
                if (key.startsWith("operations/import-plan/")) {
                  const next = yield* Effect.try({
                    try: () =>
                      Schema.decodeUnknownSync(ImportPlanSchema)(value, {
                        onExcessProperty: "error",
                      }),
                    catch: () => fail("STATE_CORRUPT", "Invalid frozen import plan."),
                  })
                  const address = yield* digest(currentImportPlanAddressInput(next))
                  if (
                    key !== `operations/import-plan/${address}/plan.json` ||
                    !preservesCurrentImportPlan(next, next)
                  )
                    return yield* Effect.fail(
                      fail(
                        "STATE_CONFLICT",
                        "The import plan differs from its bound address or definition.",
                      ),
                    )
                  yield* sql`UPDATE shared_local_records SET payload=payload WHERE key=${key} AND category='dispatch' AND retired=0`
                  const rows = yield* sql<{
                    payload: string
                    category: string
                    retired: number
                  }>`SELECT payload,category,retired FROM shared_local_records WHERE key=${key}`
                  const previous = rows[0]
                  if (previous !== undefined) {
                    const before = yield* parse(previous.payload)
                    if (
                      previous.category !== "dispatch" ||
                      previous.retired !== 0 ||
                      !preservesCurrentImportPlan(before, next)
                    )
                      return yield* Effect.fail(
                        fail(
                          "STATE_CONFLICT",
                          "Frozen import input and completed progress cannot be replaced.",
                          { key },
                        ),
                      )
                    yield* sql`UPDATE shared_local_records SET payload=${payload} WHERE key=${key} AND category='dispatch' AND retired=0`
                  } else {
                    yield* sql`INSERT INTO shared_local_records(key,category,payload,retired) VALUES(${key},'dispatch',${payload},0)`
                  }
                  return
                }
                if (key.startsWith("operations/library-init-pending/")) {
                  const next = yield* Effect.try({
                    try: () =>
                      Schema.decodeUnknownSync(LibraryInitializationPendingSchema)(value, {
                        onExcessProperty: "error",
                      }),
                    catch: () =>
                      fail("STATE_CORRUPT", "Invalid unfinished library initialization."),
                  })
                  if (key !== `operations/library-init-pending/${next.scope}/pending.json`)
                    return yield* Effect.fail(
                      fail(
                        "STATE_CONFLICT",
                        "Initialization scope does not match its state address.",
                      ),
                    )
                  yield* sql`UPDATE shared_local_records SET payload=payload WHERE key=${key} AND category='dispatch' AND retired=0`
                  const rows = yield* sql<{
                    payload: string
                    category: string
                    retired: number
                  }>`SELECT payload,category,retired FROM shared_local_records WHERE key=${key}`
                  const previous = rows[0]
                  if (previous !== undefined) {
                    const before = yield* Effect.try({
                      try: () =>
                        Schema.decodeUnknownSync(LibraryInitializationPendingSchema)(
                          JSON.parse(previous.payload),
                          { onExcessProperty: "error" },
                        ),
                      catch: () => fail("STATE_CORRUPT", "Invalid stored library initialization."),
                    })
                    if (
                      previous.category !== "dispatch" ||
                      previous.retired !== 0 ||
                      !preservesLibraryInitialization(before, next)
                    )
                      return yield* Effect.fail(
                        fail(
                          "STATE_CONFLICT",
                          "Unfinished initialization cannot replace its parent, operation or known table identities.",
                          { key },
                        ),
                      )
                    yield* sql`UPDATE shared_local_records SET payload=${payload} WHERE key=${key} AND category='dispatch' AND retired=0`
                  } else
                    yield* sql`INSERT INTO shared_local_records(key,category,payload,retired) VALUES(${key},'dispatch',${payload},0)`
                  return
                }
                if (key.startsWith("operations/current-write-pending/")) {
                  // Take the writer slot before comparing a predecessor. The compare
                  // and replacement are one SQLite transaction, never delete/insert.
                  if (options !== undefined)
                    yield* sql`UPDATE shared_local_records SET payload=payload WHERE key=${key} AND category='dispatch' AND retired=0`
                  const rows = yield* sql<{
                    payload: string
                    category: string
                    retired: number
                  }>`SELECT payload,category,retired FROM shared_local_records WHERE key=${key}`
                  const previous = rows[0]
                  if (options !== undefined) {
                    const before =
                      previous === undefined ? undefined : property(yield* parse(previous.payload))
                    const after = property(value)
                    const same = (a: unknown, b: unknown) =>
                      JSON.stringify(currentIntentIdentity(a)) ===
                      JSON.stringify(currentIntentIdentity(b))
                    const beforeIntent = property(before?.intent),
                      nextIntent = property(after.intent)
                    const predecessor = property(after.predecessor)
                    if (
                      previous === undefined ||
                      previous.category !== "dispatch" ||
                      previous.retired !== 0 ||
                      !same(before, options.expectedCurrentWritePending) ||
                      !same(
                        [
                          before?.version,
                          before?.scope,
                          before?.library_id,
                          before?.library,
                          before?.record_id,
                          beforeIntent.owner,
                        ],
                        [
                          after.version,
                          after.scope,
                          after.library_id,
                          after.library,
                          after.record_id,
                          nextIntent.owner,
                        ],
                      ) ||
                      beforeIntent.operation_id === nextIntent.operation_id ||
                      (before?.owner_page_id != null &&
                        before.owner_page_id !== after.owner_page_id) ||
                      predecessor.owner_page_id !== after.owner_page_id ||
                      predecessor.completion !== before?.completion ||
                      !same(predecessor.intent, beforeIntent) ||
                      property(after.lifecycle).phase !== "replacing"
                    )
                      return yield* Effect.fail(
                        fail(
                          "STATE_CONFLICT",
                          "The current predecessor changed before its explicit replacement.",
                          { key },
                        ),
                      )
                    yield* sql`UPDATE shared_local_records SET payload=${payload} WHERE key=${key} AND category='dispatch' AND retired=0`
                    return
                  }
                  if (previous !== undefined) {
                    const before = property(yield* parse(previous.payload)),
                      after = property(value)
                    const identity = (row: Record<string, unknown>) => {
                      return JSON.stringify([
                        row.version,
                        row.scope,
                        row.library_id,
                        currentIntentIdentity(row.library),
                        row.record_id,
                        currentIntentIdentity(row.intent),
                        row.completion,
                        currentIntentIdentity(row.predecessor),
                      ])
                    }
                    if (
                      previous.category !== "dispatch" ||
                      previous.retired !== 0 ||
                      identity(before) !== identity(after) ||
                      (before.owner_page_id != null && before.owner_page_id !== after.owner_page_id)
                    )
                      return yield* Effect.fail(
                        fail(
                          "STATE_CONFLICT",
                          "A pending current write cannot change its owner or input.",
                          { key },
                        ),
                      )
                    yield* sql`UPDATE shared_local_records SET payload=${payload} WHERE key=${key} AND category='dispatch' AND retired=0`
                  } else
                    yield* sql`INSERT INTO shared_local_records(key,category,payload,retired) VALUES(${key},'dispatch',${payload},0)`
                  return
                }
                // Content proofs are rebuilt only after complete verification. Replacing one cannot
                // renew or recreate a current observation; its independent fence remains authoritative.
                if (mutableSharedLocalPrefixes.some((prefix) => key.startsWith(`${prefix}/`)))
                  yield* sql`INSERT INTO shared_local_records(key,category,payload,retired) VALUES(${key},${sharedCategory},${payload},0) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,retired=0 WHERE shared_local_records.category=excluded.category AND (excluded.category='cache' OR shared_local_records.retired=0)`
                // All other shared lookups and dispatch evidence retain their frozen payloads.
                else
                  yield* sql`INSERT INTO shared_local_records(key,category,payload,retired) VALUES(${key},${sharedCategory},${payload},0) ON CONFLICT(key) DO NOTHING`
                const stored = yield* sql<{
                  category: string
                  payload: string
                  retired: number
                }>`SELECT category,payload,retired FROM shared_local_records WHERE key=${key}`
                const previous = stored[0]
                if (
                  previous === undefined ||
                  previous.category !== sharedCategory ||
                  previous.payload !== payload
                )
                  return yield* Effect.fail(
                    fail(
                      "STATE_CONFLICT",
                      "A frozen shared local record cannot be overwritten by different content.",
                      { key },
                    ),
                  )
                if (sharedCategory === "dispatch" && previous.retired === 1)
                  return yield* Effect.fail(
                    fail(
                      "STATE_CONFLICT",
                      "A retired shared dispatch receipt cannot authorize a new dispatch; reconcile the original shared facts.",
                      { key },
                    ),
                  )
                // Disposable immutable lookups can be rebuilt from the same exact payload.
                if (sharedCategory === "cache" && previous.retired === 1)
                  yield* sql`UPDATE shared_local_records SET retired=0 WHERE key=${key} AND category='cache'`
                if (rebuildableCacheKey(key)) {
                  const now = yield* Clock.currentTimeMillis
                  yield* sql`INSERT INTO cache_admissions(key,admitted_at) VALUES(${key},${now}) ON CONFLICT(key) DO NOTHING`
                }
              } else if (parts[0] === "snapshots" && value === undefined) {
                yield* sql`DELETE FROM snapshots WHERE id=${parts[1]!.replace(/\.json$/, "")}`
              } else if (parts[0] === "snapshots")
                yield* sql`INSERT INTO snapshots(id,scope,record_identity,locator,version_id,manifest) VALUES(${v.snapshot_id},${v.scope},${property(v.record).id},${json(property(v.record).locator)},${v.version_id},${json(value)}) ON CONFLICT(id) DO NOTHING`
              else if (parts[0] === "cache-generations")
                yield* sql`INSERT INTO cache_fences(scope,identity,generation,retired_through) VALUES(${parts[1]},${identityFromSegment(parts[2]!.replace(/\.json$/, ""))},${v.generation},${v.retired_through ?? 0}) ON CONFLICT(scope,identity) DO UPDATE SET generation=MAX(generation,excluded.generation),retired_through=MAX(retired_through,excluded.retired_through)`
              else if (parts[0] === "cache" && parts[1] === "identities")
                yield* sql`INSERT INTO identities(id,scope) VALUES(${parts[2]!.replace(/\.json$/, "")},${v.scope}) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope`
              else if (
                parts[0] === "cache" &&
                (parts[1] === "latest" || parts[1] === "catalogs" || parts[1] === "views")
              ) {
                const scope = parts[2]!
                const identity =
                  parts[1] === "catalogs"
                    ? `catalog-${parts[3]!.replace(/\.json$/, "")}`
                    : parts[1] === "views"
                      ? `views-${parts[3]!.replace(/\.json$/, "")}`
                      : identityFromSegment(parts[3]!)
                const fence = yield* sql<{
                  retired_through: number
                }>`SELECT retired_through FROM cache_fences WHERE scope=${scope} AND identity=${identity}`
                const retiredThrough = fence[0]?.retired_through ?? 0
                if (typeof v.generation !== "number" || v.generation <= retiredThrough)
                  return yield* Effect.fail(
                    fail(
                      "CACHE_INVALIDATED",
                      "An in-flight observation was retired before publication.",
                      {
                        phase: "cache_publication",
                        cache_key: key,
                        scope,
                        record_identity: identity,
                        generation: v.generation,
                        retired_through: retiredThrough,
                      },
                    ),
                  )
                if (parts[1] === "latest") {
                  const current = yield* sql<{
                    id: string
                    generation: number
                  }>`SELECT id,generation FROM observations WHERE scope=${scope} AND record_identity=${identity} ORDER BY generation DESC,id LIMIT 1`
                  const latest = current[0]
                  // Current observations are reusable cache slots, not immutable history.
                  // Preserve the slot's address: older running readers may already have
                  // enumerated it, and deleting it could hide a known access denial.
                  if (latest !== undefined && Number(v.generation) > latest.generation)
                    yield* sql`UPDATE observations SET generation=${v.generation},validated_at=${v.validated_at},snapshot_id=${v.snapshot_id ?? null},payload=${json(value)} WHERE id=${latest.id}`
                  // Equal generations retain their existing tie semantics. An older
                  // completion cannot replace the current value or grow the lookup.
                  else if (latest === undefined || Number(v.generation) === latest.generation)
                    yield* sql`INSERT INTO observations(id,scope,record_identity,generation,validated_at,snapshot_id,payload) VALUES(${key},${scope},${identity},${v.generation},${v.validated_at},${v.snapshot_id ?? null},${json(value)}) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload WHERE observations.payload=excluded.payload`
                } else if (parts[1] === "views")
                  yield* sql`INSERT INTO view_observations(scope,selection,generation,payload) VALUES(${scope},${parts[3]!.replace(/\.json$/, "")},${v.generation},${json(value)}) ON CONFLICT(scope,selection) DO UPDATE SET generation=excluded.generation,payload=excluded.payload WHERE excluded.generation>=view_observations.generation`
                else {
                  const selection = parts[3]!.replace(/\.json$/, "")
                  // Hold the same writer slot for reading retained discovery
                  // facts and replacing this generation. No second cache owns it.
                  yield* sql`UPDATE catalogs SET generation=generation WHERE scope=${scope} AND selection=${selection}`
                  const prior = yield* sql<{
                    generation: number
                    payload: string
                  }>`SELECT generation,payload FROM catalogs WHERE scope=${scope} AND selection=${selection}`
                  if (prior[0] !== undefined && Number(v.generation) < prior[0].generation) return
                  const merged = yield* Effect.try({
                    try: () =>
                      retainCompleteCatalog(
                        value,
                        prior[0] === undefined ? undefined : JSON.parse(prior[0].payload),
                      ),
                    catch: storageError,
                  })
                  yield* sql`INSERT INTO catalogs(scope,selection,generation,payload) VALUES(${scope},${selection},${v.generation},${json(merged)}) ON CONFLICT(scope,selection) DO UPDATE SET generation=excluded.generation,payload=excluded.payload WHERE excluded.generation>=catalogs.generation`
                }
              } else
                return yield* Effect.fail(
                  fail("INVALID_ARGUMENT", "Unknown SQLite domain address.", { key }),
                )
            }),
          )
        }),
      )
    const list = (prefix: string) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const rows = yield* SqlSchema.findAll({
            Request: Schema.Void,
            Result: Schema.Struct({ key: Schema.String }),
            execute: () => sql`
      SELECT 'snapshots/'||id||'.json' AS key FROM snapshots UNION ALL
      SELECT id FROM observations UNION ALL SELECT 'cache/catalogs/'||scope||'/'||selection||'.json' FROM catalogs UNION ALL
      SELECT 'cache/views/'||scope||'/'||selection||'.json' FROM view_observations UNION ALL
      SELECT 'cache/identities/'||id||'.json' FROM identities UNION ALL
      SELECT key FROM shared_local_records WHERE retired=0 UNION ALL
      SELECT 'content-restrictions/local/'||sha256||'.json' FROM local_content_restrictions
    `,
          })(undefined)
          const fences = yield* sql<{
            scope: string
            identity: string
          }>`SELECT scope,identity FROM cache_fences`
          return [
            ...rows.map((r) => r.key),
            ...fences.map(
              (row) => `cache-generations/${row.scope}/${identitySegment(row.identity)}.json`,
            ),
          ]
            .filter((key) => key.startsWith(prefix.replace(/\/$/, "") + "/"))
            .sort()
        }),
      )
    const reserve = (scope: string, identity: string) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql<{
                generation: number
              }>`INSERT INTO cache_fences(scope,identity,generation,retired_through) VALUES(${scope},${identity},1,0) ON CONFLICT(scope,identity) DO UPDATE SET generation=generation+1 RETURNING generation`
              const value = rows[0]!.generation
              if (!Number.isSafeInteger(value))
                return yield* Effect.fail(fail("STATE_CORRUPT", "Cache generation exhausted."))
              return value
            }),
          )
        }),
      )
    const retire = (keys: readonly string[]) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              for (const key of keys) {
                const sharedCategory = yield* Effect.try({
                  try: () => sharedLocalCategory(key),
                  catch: storageError,
                })
                if (sharedCategory !== undefined) {
                  if (fencedFileObservation(key)) {
                    const rows = yield* sql<{
                      payload: string
                    }>`SELECT payload FROM shared_local_records WHERE key=${key} AND category='cache'`
                    if (rows[0] !== undefined) {
                      const parsed = yield* parse(rows[0].payload)
                      const saved = yield* Effect.try({
                        try: () => sharedFileObservationOwner(parsed),
                        catch: storageError,
                      })
                      // Fence every generation already reserved, including a newer
                      // request that has not reached this slot before cache clearing.
                      yield* sql`UPDATE cache_fences SET retired_through=generation WHERE scope=${saved.scope} AND identity=${saved.record_identity}`
                    }
                  }
                  // Current Profile and Skill/Source writes retain only unfinished intent.
                  // Completion permits the next intent at the same address.
                  if (
                    key.startsWith("operations/shared-profile-pending/") ||
                    key.startsWith("operations/current-source-sync/") ||
                    key.startsWith("operations/current-source-sync-batch/") ||
                    key.startsWith("operations/library-init-pending/") ||
                    key.startsWith("operations/current-write-pending/")
                  )
                    yield* sql`DELETE FROM shared_local_records WHERE key=${key} AND category='dispatch'`
                  else
                    yield* sql`UPDATE shared_local_records SET retired=1 WHERE key=${key} AND category=${sharedCategory}`
                  continue
                }
                const p = key.split("/")
                if (
                  p[0] !== "cache" ||
                  !["latest", "catalogs", "views", "identities"].includes(p[1]!) ||
                  p.some((part) => part === ".." || part === ".")
                )
                  return yield* Effect.fail(
                    fail("INVALID_ARGUMENT", "Only disposable observations may be retired."),
                  )
                if (p[1] === "latest" || p[1] === "catalogs" || p[1] === "views") {
                  const identity =
                    p[1] === "catalogs"
                      ? `catalog-${p[3]!.replace(/\.json$/, "")}`
                      : p[1] === "views"
                        ? `views-${p[3]!.replace(/\.json$/, "")}`
                        : identityFromSegment(p[3]!)
                  yield* sql`UPDATE cache_fences SET retired_through=generation WHERE scope=${p[2]} AND identity=${identity}`
                  if (p[1] === "latest") {
                    // Clearing disposable content eligibility cannot grant access.
                    // Keep only a latest explicit denial, inside the same fence
                    // transaction; older publishers still fail retired_through.
                    const denial = yield* sql<{
                      id: string
                    }>`SELECT id FROM observations WHERE scope=${p[2]} AND record_identity=${identity} AND json_extract(payload,'$.access_denied') IN ('AUTH_REQUIRED','ACCESS_DENIED') AND generation=(SELECT MAX(generation) FROM observations WHERE scope=${p[2]} AND record_identity=${identity}) LIMIT 1`
                    if (denial[0])
                      yield* sql`DELETE FROM observations WHERE scope=${p[2]} AND record_identity=${identity} AND id<>${denial[0].id}`
                    else
                      yield* sql`DELETE FROM observations WHERE scope=${p[2]} AND record_identity=${identity}`
                  } else if (p[1] === "views")
                    yield* sql`DELETE FROM view_observations WHERE scope=${p[2]} AND selection=${p[3]!.replace(/\.json$/, "")}`
                  else
                    yield* sql`DELETE FROM catalogs WHERE scope=${p[2]} AND selection=${p[3]!.replace(/\.json$/, "")}`
                } else if (p[1] === "identities") {
                  // Keep the credential-to-scope association while its latest
                  // authorization fact is a denial. The next real auth request
                  // must reserve before dispatch so a late success cannot erase it.
                  yield* sql`DELETE FROM identities WHERE id=${p[2]!.replace(/\.json$/, "")} AND NOT EXISTS(SELECT 1 FROM observations o WHERE o.scope=identities.scope AND o.record_identity='access:scope' AND json_extract(o.payload,'$.access_denied') IN ('AUTH_REQUIRED','ACCESS_DENIED') AND o.generation=(SELECT MAX(generation) FROM observations WHERE scope=o.scope AND record_identity=o.record_identity))`
                }
              }
              return keys.map((key) => ({
                key,
                retention_path: key.startsWith("operations/current-source-sync-batch/")
                  ? "sqlite_current_source_sync_batch_cleared"
                  : key.startsWith("operations/current-source-sync/")
                    ? "sqlite_current_source_sync_cleared"
                    : key.startsWith("operations/library-init-pending/")
                      ? "sqlite_library_initialization_cleared"
                      : key.startsWith("operations/current-write-pending/")
                        ? "sqlite_current_write_cleared"
                        : key.startsWith("operations/shared-profile-pending/")
                          ? "sqlite_current_profile_cleared"
                          : sharedLocalCategory(key) === "dispatch"
                            ? "sqlite_shared_dispatch_retirement"
                            : "sqlite_observation_retirement",
              }))
            }),
          )
        }),
      )
    const rebuildableCacheRecords = () =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql<{
            key: string
            payload: string
            retired: number
            admitted_at: number | null
          }>`SELECT r.key,r.payload,r.retired,a.admitted_at FROM shared_local_records r LEFT JOIN cache_admissions a ON a.key=r.key WHERE category='cache' AND (r.key LIKE 'cache/shared-github-blobs/%' OR r.key LIKE 'cache/shared-derived-graphs/%' OR r.key LIKE 'cache/current-source-sync/%') ORDER BY r.key`
        }),
      )
    const reclaimDerived = (
      entries: readonly { readonly key: string; readonly sha256: string }[],
    ) =>
      run(
        Effect.gen(function* () {
          if (entries.length === 0) return { reclaimed: [], archive: null }
          if (
            new Set(entries.map((entry) => entry.key)).size !== entries.length ||
            entries.some(
              (entry) => !rebuildableCacheKey(entry.key) || !/^[a-f0-9]{64}$/u.test(entry.sha256),
            )
          )
            return yield* Effect.fail(
              fail(
                "INVALID_ARGUMENT",
                "Only exact previewed rebuildable cache rows may be reclaimed.",
              ),
            )
          const sql = yield* SqlClient.SqlClient
          const records: Array<{
            key: string
            payload: string
            retired: number
            admitted_at: number | null
          }> = []
          for (const entry of entries) {
            const rows = yield* sql<{
              payload: string
              retired: number
              admitted_at: number | null
            }>`SELECT r.payload,r.retired,a.admitted_at FROM shared_local_records r LEFT JOIN cache_admissions a ON a.key=r.key WHERE r.key=${entry.key} AND category='cache'`
            const row = rows[0]
            if (row === undefined || (yield* digest(row.payload)) !== entry.sha256)
              return yield* Effect.fail(
                fail("CACHE_RECLAIM_STALE", "A previewed cache record changed before retention.", {
                  key: entry.key,
                }),
              )
            records.push({ key: entry.key, ...row })
          }
          const directory = `${root}/cache-recovery`
          yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
          const originalPath = `${directory}/ntn-cache-recovery-${yield* crypto.randomUUIDv4()}.json`
          const payload = JSON.stringify({
            version: 1,
            kind: "rebuildable_cache_retention",
            records,
          })
          const checksum = yield* digest(payload)
          yield* fs.writeFileString(originalPath, payload, { flag: "wx", mode: 0o600 })
          yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* fs.open(originalPath, { flag: "r" })
              yield* handle.sync
              const parent = yield* fs.open(directory, { flag: "r" })
              yield* parent.sync
            }),
          )
          if ((yield* digest(yield* fs.readFileString(originalPath))) !== checksum)
            return yield* Effect.fail(
              fail(
                "RETENTION_FAILED",
                "The exact cache archive could not be verified; original rows remain.",
              ),
            )
          yield* trashPath(originalPath)
          if (yield* fs.exists(originalPath))
            return yield* Effect.fail(
              fail(
                "RETENTION_FAILED",
                "System Trash did not retire the verified archive; original rows remain.",
              ),
            )
          const reclaimed = yield* sql.withTransaction(
            Effect.gen(function* () {
              const result: string[] = []
              for (const row of records) {
                const deleted = yield* sql<{
                  key: string
                }>`DELETE FROM shared_local_records WHERE key=${row.key} AND category='cache' AND payload=${row.payload} AND retired=${row.retired} AND (SELECT admitted_at FROM cache_admissions WHERE key=${row.key}) IS ${row.admitted_at} RETURNING key`
                for (const item of deleted) result.push(item.key)
              }
              return result
            }),
          )
          return {
            reclaimed,
            archive: {
              original_path: originalPath,
              sha256: checksum,
              trash_confirmed: true as const,
            },
          }
        }),
      )
    const backup = (destination: string) =>
      run(
        Effect.gen(function* () {
          const sqlite = yield* SqliteClient.SqliteClient
          yield* fs.makeDirectory(destination, { recursive: false, mode: 0o700 })
          yield* sqlite.backup(`${destination}/state.sqlite`)
          for (const folder of ["objects", "snapshots", "uploads"])
            if (yield* fs.exists(`${root}/${folder}`))
              yield* fs.copy(`${root}/${folder}`, `${destination}/${folder}`)
          return { directory: destination, database: `${destination}/state.sqlite` }
        }),
      )
    return {
      filename,
      run,
      read,
      write,
      list,
      reserve,
      retire,
      reclaimDerived,
      rebuildableCacheRecords,
      backup,
    }
  })
}
