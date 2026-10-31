import { Context, Crypto, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { fail, property, SkillsError } from "./model.ts"
import type { Base, SyncBinding, SyncReceipt } from "./sync.ts"
import { makeUpstreamRepository, upstreamMigration } from "./upstream-state.ts"
import {
  makePublicationIntegrityRepository,
  publicationIntegrityMigration,
} from "./publication-integrity-state.ts"
import { probeSqliteRuntime } from "./sqlite-runtime-policy.ts"

const migrations = {
  "0001_local_state": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const statement of [
      `CREATE TABLE state_format (version INTEGER NOT NULL CHECK(version=1));`,
      `INSERT INTO state_format VALUES (1);`,
      `CREATE TABLE snapshots (id TEXT PRIMARY KEY, scope TEXT NOT NULL, page_id TEXT NOT NULL, version_id TEXT NOT NULL, manifest TEXT NOT NULL);`,
      `CREATE TABLE cache_fences (scope TEXT NOT NULL, identity TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>=0), retired_through INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,identity));`,
      `CREATE TABLE observations (id TEXT PRIMARY KEY, scope TEXT NOT NULL, page_id TEXT NOT NULL, generation INTEGER NOT NULL, validated_at REAL NOT NULL, snapshot_id TEXT, payload TEXT NOT NULL);`,
      `CREATE INDEX observations_page ON observations(scope,page_id,generation DESC);`,
      `CREATE TABLE catalogs (scope TEXT NOT NULL, selection TEXT NOT NULL, generation INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(scope,selection));`,
      `CREATE TABLE identities (id TEXT PRIMARY KEY, scope TEXT NOT NULL);`,
      `CREATE TABLE bindings (id TEXT PRIMARY KEY, label TEXT NOT NULL, scope TEXT NOT NULL, page_id TEXT NOT NULL, logical_path TEXT NOT NULL, active INTEGER NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL);`,
      `CREATE UNIQUE INDEX active_binding_label ON bindings(label) WHERE active=1;`,
      `CREATE TABLE bases (binding_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, content_id TEXT, payload TEXT NOT NULL);`,
      `CREATE TABLE plans (id TEXT PRIMARY KEY, payload TEXT NOT NULL);`,
      `CREATE TABLE sync_receipts (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);`,
      `CREATE TABLE receipt_edges (operation_id TEXT NOT NULL REFERENCES sync_receipts(id), binding_id TEXT NOT NULL, stage TEXT NOT NULL, generation_before INTEGER NOT NULL, generation_after INTEGER, payload TEXT NOT NULL, PRIMARY KEY(operation_id,binding_id));`,
      `CREATE TABLE publications (id TEXT PRIMARY KEY, operation TEXT NOT NULL, state TEXT NOT NULL, scope TEXT, page_id TEXT, payload TEXT NOT NULL);`,
      `CREATE TABLE publication_intents (operation_id TEXT NOT NULL REFERENCES publications(id), sequence INTEGER NOT NULL, path TEXT NOT NULL, method TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(operation_id,sequence));`,
      `CREATE TABLE migration_imports (source_hash TEXT PRIMARY KEY, stage TEXT NOT NULL, manifest TEXT NOT NULL);`,
    ])
      yield* sql.unsafe(statement)
  }),
  "0002_database_init_events": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE database_init_events (operation_id TEXT NOT NULL, event_index INTEGER NOT NULL CHECK(event_index>=0), payload TEXT NOT NULL, PRIMARY KEY(operation_id,event_index))`
  }),
  "0003_upstream_state": upstreamMigration,
  "0004_content_record_identity": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const historical = yield* sql<{
      id: string
    }>`SELECT id FROM snapshots WHERE json_extract(manifest,'$.record.id') IS NULL UNION ALL SELECT id FROM plans WHERE EXISTS(SELECT 1 FROM json_each(json_extract(plans.payload,'$.bindings')) WHERE json_extract(value,'$.remote.record.id') IS NULL)`
    if (historical.length)
      return yield* Effect.fail(
        fail(
          "STATE_MIGRATION_REQUIRED",
          "Run the independent record migration artifact before opening historical snapshots or plans.",
        ),
      )
    yield* sql`ALTER TABLE snapshots RENAME COLUMN page_id TO record_identity`
    yield* sql`ALTER TABLE snapshots ADD COLUMN locator TEXT`
    yield* sql`UPDATE snapshots SET locator=json_extract(manifest,'$.record.locator'),record_identity=json_extract(manifest,'$.record.id')`
    yield* sql`ALTER TABLE observations RENAME COLUMN page_id TO record_identity`
    yield* sql`UPDATE observations SET record_identity='notion_page:'||record_identity WHERE record_identity NOT LIKE 'notion_page:%'`
    yield* sql`UPDATE cache_fences SET identity='notion_page:'||identity WHERE length(identity)=36 AND identity LIKE '%-%'`
    yield* sql`CREATE TABLE historical_snapshot_mappings (historical_id TEXT PRIMARY KEY, record_identity TEXT NOT NULL, manifest TEXT NOT NULL)`
    yield* sql`INSERT INTO historical_snapshot_mappings SELECT id,record_identity,manifest FROM snapshots`
    yield* sql`DELETE FROM observations`
    yield* sql`DELETE FROM catalogs`
  }),
  "0005_publication_integrity_ledgers": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE publication_integrity_ledgers (key TEXT PRIMARY KEY, payload TEXT NOT NULL)`
  }),
  "0006_typed_publication_integrity": publicationIntegrityMigration,
  "0007_operation_reviews": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE IF NOT EXISTS operation_reviews (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`
  }),
  "0008_view_observations": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE view_observations (scope TEXT NOT NULL, selection TEXT NOT NULL, generation INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(scope,selection))`
  }),
  "0009_shared_local_records": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE shared_local_records (key TEXT PRIMARY KEY, category TEXT NOT NULL CHECK(category IN ('cache','dispatch')), payload TEXT NOT NULL CHECK(json_valid(payload)), retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0,1)))`
    yield* sql`CREATE INDEX shared_local_records_active ON shared_local_records(category,retired,key)`
  }),
  "0010_local_content_restrictions": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE local_content_restrictions (sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64), payload TEXT NOT NULL CHECK(json_valid(payload)))`
  }),
}

type SharedLocalCategory = "cache" | "dispatch"
const sharedLocalDomains: readonly {
  readonly prefix: string
  readonly category: SharedLocalCategory
  readonly address: RegExp
}[] = [
  {
    prefix: "cache/shared-file-observations",
    category: "cache",
    address: /^cache\/shared-file-observations\/[a-f0-9]{64}\/[0-9]{20}\.json$/u,
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
    prefix: "operations/shared-observation-pending",
    category: "dispatch",
    address: /^operations\/shared-observation-pending\/[a-f0-9]{64}\/[a-f0-9]{64}\.json$/u,
  },
  {
    prefix: "operations/shared-snapshot-history",
    category: "dispatch",
    address: /^operations\/shared-snapshot-history\/[a-f0-9]{64}\/snapshot-[a-f0-9]{64}\.json$/u,
  },
  {
    prefix: "operations/shared-profile-pending",
    category: "dispatch",
    address:
      /^operations\/shared-profile-pending\/[a-f0-9]{64}\/[a-f0-9]{64}\/profile-[a-f0-9]{64}\.json$/u,
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
export function sqliteState(root: string, fs: FileSystem.FileSystem, importing = false) {
  return Effect.gen(function* () {
    yield* probeSqliteRuntime
    const { SqliteClient, SqliteMigrator } = yield* Effect.promise(
      () => import("@effect/sql-sqlite-node"),
    )
    const loader = SqliteMigrator.fromRecord(migrations)
    const filename = `${root}/state.sqlite`
    const client = SqliteClient.layer({ filename, busyTimeout: "2 seconds" })
    const live = SqliteMigrator.layer({ loader }).pipe(Layer.provideMerge(client))
    const context = yield* Effect.gen(function* () {
      if (!importing && (yield* fs.exists(`${root}/sqlite-migration.json`))) {
        const text = yield* fs.readFileString(`${root}/sqlite-migration.json`)
        const journal = yield* Effect.try({
          try: () => property(JSON.parse(text)),
          catch: () => fail("STATE_CORRUPT", "Migration journal JSON is corrupt."),
        })
        if (journal.stage !== "switched")
          return yield* Effect.fail(
            fail(
              "STATE_MIGRATION_REQUIRED",
              "An interrupted migration must finish before SQLite state may be used.",
            ),
          )
      }
      if (!(yield* fs.exists(filename))) {
        if (!importing) {
          for (const entry of [
            "sync/bases",
            "sync/plans",
            "sync/receipts",
            "publications",
            "cache-generations",
            "snapshots",
            "config.json",
          ])
            if (yield* fs.exists(`${root}/${entry}`))
              return yield* Effect.fail(
                fail(
                  "STATE_MIGRATION_REQUIRED",
                  "Stop old writers and run the independent ntn-skills-migrate tool before using this state root.",
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
                  SqliteMigrator.layer({ loader }).pipe(
                    Layer.provideMerge(
                      SqliteClient.layer({
                        filename: staged,
                        busyTimeout: "2 seconds",
                        disableWAL: true,
                      }),
                    ),
                  ),
                )
                const sql = Context.get(initialized, SqlClient.SqlClient)
                yield* sql`PRAGMA synchronous = FULL`
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
      if (yield* fs.exists(filename)) {
        const validHeader = yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(filename, { flag: "r", noFollow: true })
            const bytes = new Uint8Array(16)
            return (
              (yield* file.read(bytes)) === 16 &&
              new TextDecoder().decode(bytes) === "SQLite format 3\u0000"
            )
          }),
        )
        if (!validHeader)
          return yield* Effect.fail(
            fail(
              "STATE_CORRUPT",
              "SQLite header is missing or corrupt; an empty replacement is forbidden.",
            ),
          )
      }
      return yield* Layer.build(live).pipe(
        Effect.catchDefect((defect) =>
          defect instanceof SqliteMigrator.MigrationError
            ? Effect.fail(storageError(defect))
            : Effect.die(defect),
        ),
      )
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
    const historical = yield* clientService<{
      id: string
    }>`SELECT id FROM snapshots WHERE json_extract(manifest,'$.record.id') IS NULL UNION ALL SELECT id FROM plans WHERE EXISTS(SELECT 1 FROM json_each(json_extract(plans.payload,'$.bindings')) WHERE json_extract(value,'$.remote.record.id') IS NULL)`.pipe(
      Effect.mapError(storageError),
    )
    if (historical.length)
      return yield* Effect.fail(
        fail(
          "STATE_MIGRATION_REQUIRED",
          "Historical retained records require the independent record migration artifact.",
        ),
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
          } else if (parts[0] === "database-init") {
            if (parts.length !== 3 || !/^(0|[1-9][0-9]*)\.json$/.test(parts[2]!))
              return yield* Effect.fail(
                fail("INVALID_ARGUMENT", "Invalid database init event address.", { key }),
              )
            rows =
              yield* sql`SELECT payload FROM database_init_events WHERE operation_id=${parts[1]} AND event_index=${Number(parts[2]!.slice(0, -5))}`
          } else if (parts[0] === "operation-reviews") {
            rows =
              yield* sql`SELECT payload FROM operation_reviews WHERE id=${parts[1]!.replace(/\.json$/, "")}`
          } else if (parts[0] === "snapshots")
            rows =
              yield* sql`SELECT manifest AS payload FROM snapshots WHERE id=${parts[1]!.replace(/\.json$/, "")}`
          else if (parts[0] === "cache-generations")
            rows =
              yield* sql`SELECT json_object('generation',generation,'retired_through',retired_through) AS payload FROM cache_fences WHERE scope=${parts[1]} AND identity=${parts[2]!.replace(/\.json$/, "")}`
          else if (parts[0] === "cache" && parts[1] === "latest")
            rows =
              yield* sql`SELECT o.payload FROM observations o LEFT JOIN cache_fences f ON f.scope=o.scope AND f.identity=o.record_identity WHERE o.id=${key} AND o.generation>COALESCE(f.retired_through,0)`
          else if (parts[0] === "cache" && parts[1] === "catalogs")
            rows =
              yield* sql`SELECT c.payload FROM catalogs c LEFT JOIN cache_fences f ON f.scope=c.scope AND f.identity='catalog-'||c.selection WHERE c.scope=${parts[2]} AND c.selection=${parts[3]!.replace(/\.json$/, "")} AND c.generation>COALESCE(f.retired_through,0)`
          else if (parts[0] === "cache" && parts[1] === "views")
            rows =
              yield* sql`SELECT c.payload FROM view_observations c LEFT JOIN cache_fences f ON f.scope=c.scope AND f.identity='views-'||c.selection WHERE c.scope=${parts[2]} AND c.selection=${parts[3]!.replace(/\.json$/, "")} AND c.generation>COALESCE(f.retired_through,0)`
          else if (parts[0] === "cache" && parts[1] === "identities")
            rows =
              yield* sql`SELECT json_object('scope',scope) AS payload FROM identities WHERE id=${parts[2]!.replace(/\.json$/, "")}`
          else if (parts[0] === "sync" && parts[1] === "bases")
            rows =
              yield* sql`SELECT payload FROM bases WHERE binding_id=${parts[2]!.replace(/\.json$/, "")}`
          else if (parts[0] === "sync" && parts[1] === "plans")
            rows =
              yield* sql`SELECT payload FROM plans WHERE id=${parts[2]!.replace(/\.json$/, "")}`
          else if (parts[0] === "sync" && parts[1] === "receipts")
            rows =
              yield* sql`SELECT payload FROM sync_receipts WHERE id=${parts[2]!.replace(/\.json$/, "")}`
          else if (parts[0] === "publications")
            rows =
              yield* sql`SELECT payload FROM publications WHERE id=${parts[1]!.replace(/\.json$/, "")}`
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
          if (restrictedHash !== undefined)
            yield* Effect.try({
              try: () => localContentPayload(restrictedHash, parsed),
              catch: storageError,
            })
          return parsed
        }),
      )
    const writeReceipt = (sql: SqlClient.SqlClient, value: unknown) =>
      Effect.gen(function* () {
        const v = property(value)
        yield* sql`INSERT INTO sync_receipts(id,plan_id,status,payload) VALUES(${v.operation_id},${v.plan_id},${v.status},${json(value)}) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload`
        for (const edge of v.bindings as unknown[]) {
          const e = property(edge)
          yield* sql`INSERT INTO receipt_edges(operation_id,binding_id,stage,generation_before,generation_after,payload) VALUES(${v.operation_id},${e.binding_id},${e.stage},${e.generation_before},${e.generation_after ?? null},${json(edge)}) ON CONFLICT(operation_id,binding_id) DO UPDATE SET stage=excluded.stage,generation_after=excluded.generation_after,payload=excluded.payload`
        }
      })
    const writeBase = (sql: SqlClient.SqlClient, value: unknown) => {
      const v = property(value)
      return sql`INSERT INTO bases(binding_id,generation,content_id,payload) VALUES(${v.binding_id},${v.generation},${property(v.content).content_id ?? null},${json(value)}) ON CONFLICT(binding_id) DO UPDATE SET generation=excluded.generation,content_id=excluded.content_id,payload=excluded.payload`
    }
    const write = (key: string, value: unknown) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
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
                // Insert before checking: the unique key and transaction also cover competing processes.
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
              } else if (parts[0] === "database-init") {
                if (parts.length !== 3 || !/^(0|[1-9][0-9]*)\.json$/.test(parts[2]!))
                  return yield* Effect.fail(
                    fail("INVALID_ARGUMENT", "Invalid database init event address.", { key }),
                  )
                const index = Number(parts[2]!.slice(0, -5))
                if (!Number.isSafeInteger(index))
                  return yield* Effect.fail(
                    fail("INVALID_ARGUMENT", "Invalid database init event index."),
                  )
                const prior = yield* sql<{
                  payload: string
                }>`SELECT payload FROM database_init_events WHERE operation_id=${parts[1]} AND event_index=${index}`
                if (prior[0] && prior[0].payload !== json(value))
                  return yield* Effect.fail(
                    fail("STATE_CONFLICT", "A database init event cannot be overwritten."),
                  )
                yield* sql`INSERT INTO database_init_events(operation_id,event_index,payload) VALUES(${parts[1]},${index},${json(value)}) ON CONFLICT(operation_id,event_index) DO NOTHING`
              } else if (parts[0] === "operation-reviews") {
                yield* sql`INSERT INTO operation_reviews(id,payload) VALUES(${v.operation_id},${json(value)}) ON CONFLICT(id) DO NOTHING`
              } else if (parts[0] === "snapshots" && value === undefined) {
                yield* sql`DELETE FROM snapshots WHERE id=${parts[1]!.replace(/\.json$/, "")}`
              } else if (parts[0] === "snapshots")
                yield* sql`INSERT INTO snapshots(id,scope,record_identity,locator,version_id,manifest) VALUES(${v.snapshot_id},${v.scope},${property(v.record).id},${json(property(v.record).locator)},${v.version_id},${json(value)}) ON CONFLICT(id) DO NOTHING`
              else if (parts[0] === "cache-generations")
                yield* sql`INSERT INTO cache_fences(scope,identity,generation,retired_through) VALUES(${parts[1]},${parts[2]!.replace(/\.json$/, "")},${v.generation},${v.retired_through ?? 0}) ON CONFLICT(scope,identity) DO UPDATE SET generation=MAX(generation,excluded.generation),retired_through=MAX(retired_through,excluded.retired_through)`
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
                      : parts[3]!
                const fence = yield* sql<{
                  retired_through: number
                }>`SELECT retired_through FROM cache_fences WHERE scope=${scope} AND identity=${identity}`
                if (
                  !importing &&
                  (typeof v.generation !== "number" ||
                    v.generation <= (fence[0]?.retired_through ?? 0))
                )
                  return yield* Effect.fail(
                    fail(
                      "CACHE_INVALIDATED",
                      "An in-flight observation was retired before publication.",
                    ),
                  )
                if (parts[1] === "latest")
                  yield* sql`INSERT INTO observations(id,scope,record_identity,generation,validated_at,snapshot_id,payload) VALUES(${key},${scope},${identity},${v.generation},${v.validated_at},${v.snapshot_id ?? null},${json(value)}) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload WHERE observations.payload=excluded.payload`
                else if (parts[1] === "views")
                  yield* sql`INSERT INTO view_observations(scope,selection,generation,payload) VALUES(${scope},${parts[3]!.replace(/\.json$/, "")},${v.generation},${json(value)}) ON CONFLICT(scope,selection) DO UPDATE SET generation=excluded.generation,payload=excluded.payload WHERE excluded.generation>=view_observations.generation`
                else
                  yield* sql`INSERT INTO catalogs(scope,selection,generation,payload) VALUES(${scope},${parts[3]!.replace(/\.json$/, "")},${v.generation},${json(value)}) ON CONFLICT(scope,selection) DO UPDATE SET generation=excluded.generation,payload=excluded.payload WHERE excluded.generation>=catalogs.generation`
              } else if (parts[0] === "sync" && parts[1] === "bases") yield* writeBase(sql, value)
              else if (parts[0] === "sync" && parts[1] === "plans") {
                const prior = yield* sql<{
                  payload: string
                }>`SELECT payload FROM plans WHERE id=${v.plan_id}`
                if (prior[0] && prior[0].payload !== json(value))
                  return yield* Effect.fail(
                    fail("STATE_CORRUPT", "A frozen plan identity cannot be overwritten."),
                  )
                yield* sql`INSERT INTO plans(id,payload) VALUES(${v.plan_id},${json(value)}) ON CONFLICT(id) DO NOTHING`
              } else if (parts[0] === "sync" && parts[1] === "receipts")
                yield* writeReceipt(sql, value)
              else if (parts[0] === "publications") {
                yield* sql`INSERT INTO publications(id,operation,state,scope,page_id,payload) VALUES(${v.operation_id},${v.operation},${v.state},${v.scope ?? null},${v.page_id ?? null},${json(value)}) ON CONFLICT(id) DO UPDATE SET state=excluded.state,scope=excluded.scope,page_id=excluded.page_id,payload=excluded.payload`
                for (const [sequence, intent] of (v.intents as unknown[]).entries()) {
                  const i = property(intent)
                  yield* sql`INSERT INTO publication_intents(operation_id,sequence,path,method,status,payload) VALUES(${v.operation_id},${sequence},${i.path},${i.method},${i.status},${json(intent)}) ON CONFLICT(operation_id,sequence) DO UPDATE SET status=excluded.status,payload=excluded.payload`
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
      SELECT 'database-init/'||operation_id||'/'||event_index||'.json' FROM database_init_events UNION ALL
      SELECT 'cache-generations/'||scope||'/'||identity||'.json' FROM cache_fences UNION ALL
      SELECT id FROM observations UNION ALL SELECT 'cache/catalogs/'||scope||'/'||selection||'.json' FROM catalogs UNION ALL
      SELECT 'cache/views/'||scope||'/'||selection||'.json' FROM view_observations UNION ALL
      SELECT 'cache/identities/'||id||'.json' FROM identities UNION ALL
      SELECT key FROM shared_local_records WHERE retired=0 UNION ALL
      SELECT 'content-restrictions/local/'||sha256||'.json' FROM local_content_restrictions UNION ALL
      SELECT 'sync/bases/'||binding_id||'.json' FROM bases UNION ALL SELECT 'sync/plans/'||id||'.json' FROM plans UNION ALL
      SELECT 'sync/receipts/'||id||'.json' FROM sync_receipts UNION ALL SELECT 'publications/'||id||'.json' FROM publications UNION ALL SELECT 'operation-reviews/'||id||'.json' FROM operation_reviews
    `,
          })(undefined)
          return rows
            .map((r) => r.key)
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
                  // Dispatch payloads remain auditable after completion and never join cache clearing.
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
                        : p[3]!
                  yield* sql`UPDATE cache_fences SET retired_through=generation WHERE scope=${p[2]} AND identity=${identity}`
                  if (p[1] === "latest")
                    yield* sql`DELETE FROM observations WHERE scope=${p[2]} AND record_identity=${identity}`
                  else if (p[1] === "views")
                    yield* sql`DELETE FROM view_observations WHERE scope=${p[2]} AND selection=${p[3]!.replace(/\.json$/, "")}`
                  else
                    yield* sql`DELETE FROM catalogs WHERE scope=${p[2]} AND selection=${p[3]!.replace(/\.json$/, "")}`
                } else if (p[1] === "identities")
                  yield* sql`DELETE FROM identities WHERE id=${p[2]!.replace(/\.json$/, "")}`
              }
              return keys.map((key) => ({
                key,
                retention_path:
                  sharedLocalCategory(key) === "dispatch"
                    ? "sqlite_shared_dispatch_retirement"
                    : "sqlite_observation_retirement",
              }))
            }),
          )
        }),
      )
    const bindings = () =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const rows = yield* sql<{ payload: string }>`SELECT payload FROM bindings ORDER BY id`
          return yield* Effect.forEach(rows, (r) => parse(r.payload))
        }),
      )
    const registerBindingWithBase = (binding: SyncBinding, base: Base) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const b = property(binding)
          if (
            base.binding_id !== binding.id ||
            !Number.isSafeInteger(binding.revision) ||
            binding.revision < 1 ||
            !Number.isSafeInteger(base.generation) ||
            base.generation < 0
          )
            return yield* Effect.fail(
              fail("STATE_CORRUPT", "Invalid binding and baseline transaction."),
            )
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const prior = yield* sql<{
                revision: number
              }>`SELECT revision FROM bindings WHERE id=${b.id}`
              if (prior[0] && prior[0].revision !== Number(b.revision) - 1)
                return yield* Effect.fail(fail("SYNC_PLAN_STALE", "Binding revision changed."))
              yield* sql`INSERT INTO bindings(id,label,scope,page_id,logical_path,active,revision,payload) VALUES(${b.id},${b.label},${b.scope},${b.page_id},${b.logical_path},${b.active ? 1 : 0},${b.revision},${json(binding)}) ON CONFLICT(id) DO UPDATE SET label=excluded.label,active=excluded.active,revision=excluded.revision,payload=excluded.payload`
              yield* writeBase(sql, base)
            }),
          )
        }),
      )
    const advanceBaseAndReceipt = (
      bindingId: string,
      expectedGeneration: number,
      next: Base,
      receipt: SyncReceipt,
    ) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const edge = (property(receipt).bindings as unknown[])
                .map(property)
                .find((item) => item.binding_id === bindingId)
              const base = property(next)
              if (
                !edge ||
                edge.stage !== "complete" ||
                edge.generation_after !== base.generation ||
                base.binding_id !== bindingId
              )
                return yield* Effect.fail(
                  fail("STATE_CORRUPT", "Baseline and receipt edge must advance together."),
                )
              const rows = yield* sql<{
                generation: number
              }>`SELECT generation FROM bases WHERE binding_id=${bindingId}`
              if (rows[0]?.generation !== expectedGeneration)
                return yield* Effect.fail(
                  fail("SYNC_PLAN_STALE", "The common baseline generation changed.", {
                    binding_id: bindingId,
                  }),
                )
              yield* writeBase(sql, next)
              yield* writeReceipt(sql, receipt)
            }),
          )
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
      upstream: makeUpstreamRepository(clientService),
      integrity: makePublicationIntegrityRepository(clientService),
      filename,
      run,
      read,
      write,
      list,
      reserve,
      retire,
      bindings,
      registerBindingWithBase,
      advanceBaseAndReceipt,
      backup,
    }
  })
}
