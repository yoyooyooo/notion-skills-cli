import { SqliteClient } from "@effect/sql-sqlite-node"
import { Context, Crypto, Effect, FileSystem, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { ConfigSchema, SnapshotSchema, decode, fail, property } from "../../core/src/model.ts"
import { stableSyncJson } from "../../core/src/sync.ts"
import { probeSqliteRuntime } from "../../core/src/sqlite-runtime-policy.ts"
import { convertLegacyPublication } from "./legacy-publication.ts"
import { OperationReviewSchema } from "../../core/src/command-operations.ts"

/** Offline SQL format conversion; never imported by the product CLI. Original plans are audit-only. */
export function migrateSqliteRecords(
  root: string,
  config: string,
  backup: string,
  stopped: boolean,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      yield* probeSqliteRuntime
      const fs = yield* FileSystem.FileSystem
      if (!stopped)
        return yield* Effect.fail(
          fail("MIGRATION_WRITERS_ACTIVE", "Stop old writers and pass --old-writers-stopped."),
        )
      const filename = `${root}/state.sqlite`
      if (!(yield* fs.exists(filename)))
        return yield* Effect.fail(fail("MIGRATION_BLOCKED", "SQLite input is missing."))
      if (
        backup === root ||
        backup.startsWith(root + "/") ||
        backup === config ||
        backup.startsWith(config + "/")
      )
        return yield* Effect.fail(fail("MIGRATION_BLOCKED", "Backup must be outside source roots."))
      const context = yield* Layer.build(SqliteClient.layer({ filename, busyTimeout: "2 seconds" }))
      const sql = Context.get(context, SqlClient.SqlClient)
      const sqlite = Context.get(context, SqliteClient.SqliteClient)
      const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table'`
      if (
        !["snapshots", "plans", "sync_receipts", "effect_sql_migrations"].every((name) =>
          tables.some((table) => table.name === name),
        )
      )
        return yield* Effect.fail(
          fail("MIGRATION_BLOCKED", "Input is not a recognized SQLite state format."),
        )
      const versions = yield* sql<{
        migration_id: number
      }>`SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id`
      if (
        !versions.length ||
        versions.some((version) => version.migration_id < 1 || version.migration_id > 7)
      )
        return yield* Effect.fail(
          fail("MIGRATION_BLOCKED", "Unsupported SQLite migration version."),
        )
      const format = yield* sql<{ version: number }>`SELECT version FROM state_format`
      if (format.length !== 1 || format[0]!.version !== 1)
        return yield* Effect.fail(fail("MIGRATION_BLOCKED", "Unsupported SQLite state version."))
      const snapshots = yield* sql<{
        id: string
        manifest: string
      }>`SELECT id,manifest FROM snapshots ORDER BY id`
      const plans = yield* sql<{
        id: string
        payload: string
      }>`SELECT id,payload FROM plans ORDER BY id`
      const publications = tables.some((table) => table.name === "publications")
        ? yield* sql<{
            id: string
            payload: string
          }>`SELECT id,payload FROM publications ORDER BY id`
        : []
      const digest = (value: string) => (yieldCrypto: Crypto.Crypto) =>
        yieldCrypto
          .digest("SHA-256", new TextEncoder().encode(value))
          .pipe(
            Effect.map((bytes) =>
              Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
            ),
          )
      const crypto = yield* Crypto.Crypto
      const converted: Array<{ id: string; manifest: string; recordId: string; locator: string }> =
        []
      for (const row of snapshots) {
        const value = property(JSON.parse(row.manifest))
        if (value.record !== undefined) {
          decode(SnapshotSchema, value)
          continue
        }
        const old = property(value.skill)
        if (
          typeof old.id !== "string" ||
          typeof old.name !== "string" ||
          typeof old.database_id !== "string" ||
          typeof old.data_source_id !== "string"
        )
          return yield* Effect.fail(fail("MIGRATION_BLOCKED", "Unrecognized historical snapshot."))
        const { skill: _skill, skill_name: _name, ...rest } = value
        const record = {
          id: `notion_page:${old.id}`,
          kind: "skill",
          locator: {
            type: "notion_page",
            page_id: old.id,
            database_id: old.database_id,
            data_source_id: old.data_source_id,
          },
          name: old.name,
          alias: old.alias,
          description: old.description,
          default_context: old.default_context === true,
          entrypoint: "SKILL.md",
          ref: old.ref,
        }
        const current = { ...rest, historical_snapshot_id: row.id, record, entrypoint: "SKILL.md" }
        decode(SnapshotSchema, current)
        converted.push({
          id: row.id,
          manifest: JSON.stringify(current),
          recordId: record.id,
          locator: JSON.stringify(record.locator),
        })
      }
      const historicalPlans: (typeof plans)[number][] = []
      for (const row of plans) {
        const value = property(JSON.parse(row.payload)),
          { plan_id, ...body } = value
        if (plan_id !== `p_${yield* digest(stableSyncJson(body))(crypto)}` || plan_id !== row.id)
          return yield* Effect.fail(
            fail("STATE_CORRUPT", "Frozen plan hash changed; migration cannot rehash it."),
          )
        if (
          Array.isArray(value.bindings) &&
          value.bindings.some((edge) => property(property(edge).remote).skill !== undefined)
        )
          historicalPlans.push(row)
      }
      const configPath = `${config}/config.json`
      if (yield* fs.exists(configPath))
        decode(ConfigSchema, JSON.parse(yield* fs.readFileString(configPath)))
      if (yield* fs.exists(backup))
        return yield* Effect.fail(
          fail("MIGRATION_BLOCKED", "Use a new backup destination; existing evidence is retained."),
        )
      yield* fs.makeDirectory(backup, { recursive: false, mode: 0o700 })
      yield* sqlite.backup(`${backup}/state.sqlite`)
      for (const folder of ["objects", "snapshots", "uploads"])
        if (yield* fs.exists(`${root}/${folder}`))
          yield* fs.copy(`${root}/${folder}`, `${backup}/${folder}`)
      if (yield* fs.exists(configPath)) yield* fs.copyFile(configPath, `${backup}/config.json`)
      const sourceHash = yield* digest(JSON.stringify([versions, snapshots, plans, publications]))(
        crypto,
      )
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`CREATE TABLE IF NOT EXISTS historical_review_artifacts (source_hash TEXT NOT NULL,key TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(source_hash,key))`
          yield* sql`CREATE TABLE IF NOT EXISTS operation_reviews (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`
          const reviewOperation = (
            id: string,
            hash: string,
            refs: { plan_ids: string[]; publication_ids: string[]; binding_ids: string[] },
          ) => {
            const auditRef = `${backup}/record-migration.json#${id}`
            const value = decode(OperationReviewSchema, {
              format: 1,
              operation_id: id,
              kind: "review",
              state: "unknown",
              reason: "UNRESOLVED_NO_REPLAY",
              provenance: { type: "external_migration", source_sha256: hash, audit_ref: auditRef },
              refs,
              next: { action: "inspect", audit_ref: auditRef },
            })
            return sql`INSERT INTO operation_reviews(id,payload) VALUES(${id},${JSON.stringify(value)}) ON CONFLICT DO NOTHING`
          }
          for (const row of publications) {
            const raw = property(JSON.parse(row.payload)),
              portable = property(raw.portable),
              hash = yield* digest(row.payload)(crypto)
            const prepared =
              portable.kind === undefined
                ? { ...raw, portable: { ...portable, kind: "skill" } }
                : raw
            const converted = convertLegacyPublication(prepared, hash)
            if (converted.audit || prepared !== raw)
              yield* sql`INSERT INTO historical_review_artifacts VALUES(${sourceHash},${`publications/${row.id}.json`},${row.payload}) ON CONFLICT DO NOTHING`
            if (converted.value)
              yield* sql`UPDATE publications SET payload=${JSON.stringify(converted.value)} WHERE id=${row.id}`
            else {
              yield* reviewOperation(row.id, hash, {
                plan_ids: [],
                publication_ids: [row.id],
                binding_ids: [],
              })
              yield* sql`DELETE FROM publication_intents WHERE operation_id=${row.id}`
              yield* sql`DELETE FROM publications WHERE id=${row.id}`
            }
          }
          for (const row of snapshots.filter((row) =>
            converted.some((value) => value.id === row.id),
          ))
            yield* sql`INSERT INTO historical_review_artifacts VALUES(${sourceHash},${`snapshots/${row.id}.json`},${row.manifest}) ON CONFLICT DO NOTHING`
          const columns = yield* sql<{ name: string }>`PRAGMA table_info(snapshots)`
          for (const row of converted) {
            if (columns.some((column) => column.name === "record_identity"))
              yield* sql`UPDATE snapshots SET manifest=${row.manifest},record_identity=${row.recordId},locator=${row.locator} WHERE id=${row.id}`
            else yield* sql`UPDATE snapshots SET manifest=${row.manifest} WHERE id=${row.id}`
          }
          for (const plan of historicalPlans) {
            yield* sql`INSERT INTO historical_review_artifacts VALUES(${sourceHash},${`sync/plans/${plan.id}.json`},${plan.payload}) ON CONFLICT DO NOTHING`
            const receipts = yield* sql<{
              id: string
              payload: string
            }>`SELECT id,payload FROM sync_receipts WHERE plan_id=${plan.id}`
            for (const receipt of receipts) {
              yield* sql`INSERT INTO historical_review_artifacts VALUES(${sourceHash},${`sync/receipts/${receipt.id}.json`},${receipt.payload}) ON CONFLICT DO NOTHING`
              const original = property(JSON.parse(receipt.payload))
              yield* reviewOperation(receipt.id, yield* digest(receipt.payload)(crypto), {
                plan_ids: [plan.id],
                publication_ids: [],
                binding_ids: (original.bindings as unknown[]).map((entry) =>
                  String(property(entry).binding_id),
                ),
              })
              yield* sql`DELETE FROM receipt_edges WHERE operation_id=${receipt.id}`
              yield* sql`DELETE FROM sync_receipts WHERE id=${receipt.id}`
            }
            yield* sql`DELETE FROM plans WHERE id=${plan.id}`
          }
          yield* sql`DELETE FROM observations`
          yield* sql`DELETE FROM catalogs`
        }),
      )
      const review = {
        format: "ntn-skills-record-migration",
        version: 1,
        source_hash: sourceHash,
        backup,
        converted_snapshots: converted.length,
        historical_plans: historicalPlans.map((row) => ({
          original_plan_id: row.id,
          executable: false,
          approval: "required",
        })),
        config_changed: false,
        baselines_changed: false,
      }
      yield* fs.writeFileString(`${backup}/record-migration.json`, JSON.stringify(review) + "\n")
      return { migrated: true, ...review }
    }),
  )
}
