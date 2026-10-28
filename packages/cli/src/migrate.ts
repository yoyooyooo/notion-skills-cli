#!/usr/bin/env node
/** Explicit offline importer. It is never imported by the normal CLI entrypoint. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Crypto, Effect, FileSystem, Option, Path, Schema, Stdio, Stream } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { SqlClient } from "effect/sql"
import { sqliteState } from "../../core/src/sqlite-state.ts"
import { migrateSqliteRecords } from "./migrate-records.ts"
import { probeSqliteRuntime } from "../../core/src/sqlite-runtime-policy.ts"
import {
  BaseSchema,
  BindingSchema,
  PlanSchema,
  ReceiptSchema,
  stableSyncJson,
} from "../../core/src/sync.ts"
import { PublicationReceiptSchema } from "../../core/src/publication-model.ts"
import { convertLegacyPublication, LegacyPublicationSchema } from "./legacy-publication.ts"
import { OperationReviewSchema } from "../../core/src/command-operations.ts"
import { ObservationSchema, ScopeSchema } from "../../core/src/cache.ts"
import {
  CatalogSchema,
  ConfigSchema,
  SnapshotSchema,
  decode,
  fail,
  property,
} from "../../core/src/model.ts"
const HistoricalSnapshotSchema = Schema.Struct({
  snapshot_id: Schema.String,
  scope: Schema.String,
  skill: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    alias: Schema.String,
    description: Schema.String,
    default_context: Schema.optionalKey(Schema.Boolean),
    database_id: Schema.String,
    data_source_id: Schema.String,
    ref: Schema.String,
  }),
  skill_name: Schema.String,
  version_id: Schema.String,
  created_at: Schema.Number,
  files: SnapshotSchema.fields.files,
  references: SnapshotSchema.fields.references,
})
const HistoricalEdgeSchema = Schema.Struct({
  ...PlanSchema.fields.bindings.value.fields,
  remote: HistoricalSnapshotSchema,
})
const HistoricalPlanSchema = Schema.Struct({
  ...PlanSchema.fields,
  bindings: Schema.Array(HistoricalEdgeSchema),
})
const HistoricalPublicationSchema = Schema.Struct({
  ...LegacyPublicationSchema.fields,
  portable: Schema.Struct({
    name: Schema.String,
    description: Schema.String,
    main: Schema.String,
    files: Schema.mutable(
      Schema.Array(Schema.Struct({ path: Schema.String, sha256: Schema.String })),
    ),
  }),
})

const command = Command.make(
  "ntn-skills-migrate",
  {
    state: Argument.String("legacy-state-directory"),
    config: Flag.String("config-directory"),
    cache: Flag.String("cache-directory"),
    backup: Flag.String("backup-directory"),
    stopped: Flag.Boolean("old-writers-stopped"),
    format: Flag.String("input-format").pipe(Flag.withDefault("json-v1")),
  },
  ({
    state: source,
    config: configInput,
    cache: cacheInput,
    backup: backupInput,
    stopped,
    format,
  }) =>
    Effect.gen(function* () {
      yield* probeSqliteRuntime
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const crypto = yield* Crypto.Crypto
      // Resolve existing ancestors too: aliases must denote the same physical roots.
      const canonical = (input: string): Effect.Effect<string, unknown> =>
        Effect.gen(function* () {
          const absolute = path.resolve(input)
          if (yield* fs.exists(absolute)) return yield* fs.realPath(absolute)
          return path.join(yield* canonical(path.dirname(absolute)), path.basename(absolute))
        })
      const root = yield* canonical(source)
      const configRoot = yield* canonical(configInput)
      const cacheRoot = yield* canonical(cacheInput)
      const backupRoot = yield* canonical(backupInput)
      if (format !== "json-v1" && format !== "sqlite-v1")
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Input format must be json-v1 or sqlite-v1."),
        )
      if (format === "sqlite-v1")
        return yield* migrateSqliteRecords(root, configRoot, backupRoot, stopped)
      const identity = (directory: string) =>
        Effect.gen(function* () {
          const info = yield* fs.stat(directory)
          if (info.type !== "Directory" || Option.isNone(info.ino))
            return yield* Effect.fail(
              fail("MIGRATION_BLOCKED", "Migration requires identifiable physical directories."),
            )
          return {
            path: directory,
            dev: String(info.dev),
            ino: String(info.ino.value),
            birthtime: Option.isSome(info.birthtime) ? info.birthtime.value.toISOString() : null,
          }
        })
      if (!stopped)
        return yield* Effect.fail(
          fail(
            "MIGRATION_WRITERS_ACTIVE",
            "Stop every old CLI writer, including jobs and host prefetch, then pass --old-writers-stopped. Arbitrary old binaries do not honor the new migration marker.",
          ),
        )
      if (
        [root, configRoot, cacheRoot].some(
          (p) => backupRoot === p || backupRoot.startsWith(p + path.sep),
        )
      )
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Backup must be outside all application roots."),
        )
      const markerPath = `${root}/sqlite-migration.json`
      const digest = (bytes: Uint8Array | string) =>
        crypto
          .digest("SHA-256", typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes)
          .pipe(
            Effect.map((hash) => Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("")),
          )
      const durable = (destination: string, bytes: Uint8Array) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* fs.makeDirectory(path.dirname(destination), { recursive: true, mode: 0o700 })
            const staged = `${destination}.${yield* crypto.randomUUIDv4()}.pending`
            const file = yield* fs.open(staged, { flag: "wx", mode: 0o600 })
            yield* file.writeAll(bytes)
            yield* file.sync
            yield* fs.rename(staged, destination)
            yield* (yield* fs.open(path.dirname(destination), { flag: "r" })).sync
          }),
        )
      let marker: Record<string, unknown> | undefined
      if (yield* fs.exists(markerPath))
        marker = property(JSON.parse(yield* fs.readFileString(markerPath)))
      if (marker) {
        if (
          marker.version !== 2 ||
          !marker.roots ||
          !marker.input ||
          !Array.isArray(marker.backup_manifest)
        )
          return yield* Effect.fail(
            fail(
              "MIGRATION_BLOCKED",
              "This journal has no verified root/input binding and cannot be recovered automatically. Retain it and its backup for manual inspection.",
            ),
          )
        if (!["validated", "importing", "imported", "switched"].includes(String(marker.stage)))
          return yield* Effect.fail(
            fail("MIGRATION_BLOCKED", "The migration journal stage is invalid."),
          )
        const roots = property(marker.roots)
        for (const [label, directory] of Object.entries({
          state: root,
          config: configRoot,
          cache: cacheRoot,
          backup: backupRoot,
        })) {
          if (
            !roots[label] ||
            property(roots[label]).path !== directory ||
            !(yield* fs.exists(directory)) ||
            JSON.stringify(roots[label]) !== JSON.stringify(yield* identity(directory))
          )
            return yield* Effect.fail(
              fail(
                "MIGRATION_ROOT_MISMATCH",
                "Migration roots differ from the validated journal; no recovery writes were performed.",
              ),
            )
        }
        if (marker.backup !== backupRoot)
          return yield* Effect.fail(
            fail("MIGRATION_ROOT_MISMATCH", "Migration backup differs from the validated journal."),
          )
      }
      if ((yield* fs.exists(`${root}/state.sqlite`)) && !marker)
        return yield* Effect.fail(
          fail(
            "MIGRATION_BLOCKED",
            "An existing SQLite database has no matching migration journal; do not merge authorities.",
          ),
        )
      // The explicit stop-writers precondition is also checked against every retained live/unknown lock.
      if (yield* fs.exists(`${root}/sync/locks`)) {
        for (const name of yield* fs.readDirectory(`${root}/sync/locks`)) {
          if (/^[a-f0-9]{64}$/.test(name))
            return yield* Effect.fail(
              fail(
                "MIGRATION_WRITERS_ACTIVE",
                "A retained writer fence requires inspection before migration.",
                { lock_path: `${root}/sync/locks/${name}` },
              ),
            )
        }
      }
      const input = marker ? property(marker.input) : undefined
      const selectedConfig = input
        ? String(input.config_source)
        : (yield* fs.exists(`${configRoot}/config.json`))
          ? `${configRoot}/config.json`
          : `${root}/config.json`
      if (
        selectedConfig !== `${configRoot}/config.json` &&
        selectedConfig !== `${root}/config.json`
      )
        return yield* Effect.fail(
          fail("MIGRATION_BLOCKED", "The journal configuration source is outside its bound roots."),
        )
      const configExists = yield* fs.exists(selectedConfig)
      const liveConfigRaw = configExists ? yield* fs.readFileString(selectedConfig) : "{}"
      const finishing = marker?.stage === "imported" || marker?.stage === "switched"
      const backupConfig =
        selectedConfig === `${configRoot}/config.json`
          ? `${backupRoot}/config/config.json`
          : `${backupRoot}/state/config.json`
      const configRaw = input
        ? input.config_exists === true
          ? yield* fs.readFileString(backupConfig)
          : "{}"
        : liveConfigRaw
      const switchedRaw = JSON.stringify(
        Object.fromEntries(
          Object.entries(property(JSON.parse(configRaw))).filter(
            ([key]) => key !== "sync_bindings",
          ),
        ),
      )
      if (input) {
        if (
          (yield* digest(configRaw)) !== input.config_hash ||
          (yield* digest(switchedRaw)) !== input.switched_hash
        )
          return yield* Effect.fail(
            fail("MIGRATION_SOURCE_CHANGED", "The frozen configuration backup changed."),
          )
        const destinationExists = yield* fs.exists(`${configRoot}/config.json`)
        const destinationRaw = destinationExists
          ? yield* fs.readFileString(`${configRoot}/config.json`)
          : undefined
        const alreadySwitched = finishing && destinationRaw === switchedRaw
        const sourceSwitched = alreadySwitched && selectedConfig === `${configRoot}/config.json`
        if (
          !sourceSwitched &&
          (configExists !== input.config_exists ||
            (yield* digest(liveConfigRaw)) !== input.config_hash)
        )
          return yield* Effect.fail(
            fail("MIGRATION_SOURCE_CHANGED", "Configuration changed after validation."),
          )
        if (marker!.stage === "switched" && !alreadySwitched)
          return yield* Effect.fail(
            fail(
              "MIGRATION_SOURCE_CHANGED",
              "The switched configuration no longer matches the frozen migration output.",
            ),
          )
        if (selectedConfig !== `${configRoot}/config.json` && !alreadySwitched && destinationExists)
          return yield* Effect.fail(
            fail(
              "MIGRATION_SOURCE_CHANGED",
              "An unrelated configuration appeared at the destination.",
            ),
          )
      }
      const configValue = property(JSON.parse(configRaw))
      decode(ConfigSchema, configValue)
      const bindings = (configValue.sync_bindings ?? []) as unknown[]
      for (const b of bindings) decode(BindingSchema, b)
      const records: Array<{ key: string; value: unknown; sha256: string }> = []
      const manifest: Array<{ root: string; path: string; sha256: string; bytes: number }> = []
      for (const [base, label] of [
        [root, "state"],
        [cacheRoot, "cache"],
      ] as const) {
        if (!(yield* fs.exists(base))) continue
        for (const name of (yield* fs.readDirectory(base, { recursive: true })).sort()) {
          if (
            name === "sqlite-migration.json" ||
            name === "migration-review.json" ||
            name === "legacy-publication-migration-audit.json" ||
            name.startsWith("state.sqlite")
          )
            continue
          if (
            /^(?:sqlite-migration|migration-review|legacy-publication-migration-audit)\.json\.[a-f0-9-]{36}\.pending$/.test(
              name,
            )
          )
            continue
          const absolute = path.join(base, name)
          if (
            path.dirname(absolute) === configRoot &&
            /^config\.json\.[a-f0-9-]{36}\.pending$/.test(path.basename(absolute))
          )
            continue
          if ((yield* fs.stat(absolute)).type !== "File") continue
          const bytes = yield* fs.readFile(absolute)
          // A crash after config rename may precede the switched journal rename.
          // Normalize only the exact frozen output, never arbitrary edits.
          if (
            finishing &&
            absolute === `${configRoot}/config.json` &&
            new TextDecoder().decode(bytes) === switchedRaw
          ) {
            const prior = (marker!.manifest as typeof manifest).find(
              (entry) => entry.root === label && entry.path === name,
            )
            if (prior) manifest.push(prior)
            continue
          }
          const hash = yield* digest(bytes)
          manifest.push({ root: label, path: name, sha256: hash, bytes: bytes.length })
          if (!name.endsWith(".json")) continue
          const key =
            label === "cache"
              ? `cache/${name.split(path.sep).join("/")}`
              : name.split(path.sep).join("/")
          const schema = key.startsWith("snapshots/")
            ? SnapshotSchema
            : key.startsWith("sync/bases/")
              ? BaseSchema
              : key.startsWith("sync/plans/")
                ? Schema.Union([PlanSchema, HistoricalPlanSchema])
                : key.startsWith("sync/receipts/")
                  ? ReceiptSchema
                  : key.startsWith("publications/")
                    ? Schema.Union([LegacyPublicationSchema, HistoricalPublicationSchema])
                    : key.startsWith("cache/latest/")
                      ? ObservationSchema
                      : key.startsWith("cache/catalogs/")
                        ? CatalogSchema
                        : key.startsWith("cache/identities/")
                          ? ScopeSchema
                          : key.startsWith("cache-generations/")
                            ? Schema.Struct({
                                generation: Schema.Number,
                                retired_through: Schema.optional(Schema.Number),
                              })
                            : undefined
          if (!schema) continue
          let value = JSON.parse(new TextDecoder().decode(bytes)) as unknown
          if (key.startsWith("snapshots/") && property(value).skill !== undefined) {
            const old = property(property(value).skill)
            const { skill: _skill, skill_name: _name, ...rest } = property(value)
            const page = String(old.id)
            value = {
              ...rest,
              historical_snapshot_id: rest.snapshot_id,
              entrypoint: "SKILL.md",
              record: {
                id: `notion_page:${page}`,
                kind: "skill",
                locator: {
                  type: "notion_page",
                  page_id: page,
                  database_id: old.database_id,
                  data_source_id: old.data_source_id,
                },
                name: old.name,
                alias: old.alias,
                description: old.description,
                default_context: old.default_context === true,
                entrypoint: "SKILL.md",
                ref: old.ref,
              },
            }
          }
          if (key.startsWith("cache/")) continue
          decode(schema, value)
          const v = property(value)
          const identity = key.startsWith("snapshots/")
            ? v.snapshot_id
            : key.startsWith("sync/bases/")
              ? v.binding_id
              : key.startsWith("sync/plans/")
                ? v.plan_id
                : key.startsWith("sync/receipts/") || key.startsWith("publications/")
                  ? v.operation_id
                  : undefined
          if (identity !== undefined && key.split("/").at(-1) !== `${String(identity)}.json`)
            return yield* Effect.fail(
              fail(
                "STATE_CORRUPT",
                "A retained record identity disagrees with its source filename.",
                { key },
              ),
            )
          records.push({ key, value, sha256: hash })
        }
      }
      // Validate referenced bytes for snapshots, bases, reviewed plans and unfinished publications.
      const validateObjects = (value: unknown): Effect.Effect<void, unknown> =>
        Effect.gen(function* () {
          if (Array.isArray(value)) {
            for (const item of value) yield* validateObjects(item)
            return
          }
          if (!value || typeof value !== "object") return
          const v = property(value)
          if (typeof v.sha256 === "string" && typeof v.path === "string") {
            const bytes = yield* fs.readFile(`${root}/objects/${v.sha256}`)
            if (
              (yield* digest(bytes)) !== v.sha256 ||
              (typeof v.bytes === "number" && bytes.length !== v.bytes)
            )
              return yield* Effect.fail(
                fail("STATE_CORRUPT", "Migration reference bytes do not match their manifest.", {
                  path: v.path,
                }),
              )
            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* (yield* fs.open(`${root}/objects/${v.sha256}`, {
                  flag: "r",
                  noFollow: true,
                })).sync
                yield* (yield* fs.open(`${root}/objects`, { flag: "r" })).sync
              }),
            )
          }
          for (const child of Object.values(v)) yield* validateObjects(child)
        })
      for (const record of records) {
        if (!record.key.startsWith("cache/") && !record.key.startsWith("cache-generations/"))
          yield* validateObjects(record.value)
        if (record.key.startsWith("sync/plans/")) {
          const { plan_id, ...body } = property(record.value)
          if (
            plan_id !== `p_${yield* digest(stableSyncJson(body))}` ||
            record.key !== `sync/plans/${plan_id}.json`
          )
            return yield* Effect.fail(
              fail("STATE_CORRUPT", "Reviewed plan identity changed; migration cannot rehash it."),
            )
        }
        if (record.key.startsWith("sync/receipts/")) {
          const receipt = decode(ReceiptSchema, record.value)
          const retainedPlan = records.find((r) => r.key === `sync/plans/${receipt.plan_id}.json`)
          if (!retainedPlan)
            return yield* Effect.fail(
              fail("STATE_CORRUPT", "A retained operation has no reviewed plan."),
            )
          const plan = decode(Schema.Union([PlanSchema, HistoricalPlanSchema]), retainedPlan.value)
          if (
            receipt.bindings.length !== plan.bindings.length ||
            new Set(receipt.bindings.map((b) => b.binding_id)).size !== receipt.bindings.length
          )
            return yield* Effect.fail(
              fail("STATE_CORRUPT", "A retained operation participant set is invalid."),
            )
          for (const entry of receipt.bindings) {
            const edge = plan.bindings.find((e) => e.binding.id === entry.binding_id)
            if (
              !edge ||
              edge.binding.page_id !== entry.page_id ||
              edge.base.generation !== entry.generation_before ||
              edge.local.resolved_path !== entry.resolved_path
            )
              return yield* Effect.fail(
                fail("STATE_CORRUPT", "A retained operation edge differs from its frozen plan."),
              )
          }
        }
      }
      for (const binding of bindings) {
        const id = property(binding).id
        if (!records.some((r) => r.key === `sync/bases/${id}.json`))
          return yield* Effect.fail(
            fail("STATE_CORRUPT", "A binding has no retained common baseline.", { binding_id: id }),
          )
      }
      const sourceHash = yield* digest(
        JSON.stringify({ manifest, config: yield* digest(configRaw) }),
      )
      if (marker && marker.source_hash !== sourceHash)
        return yield* Effect.fail(
          fail(
            "MIGRATION_SOURCE_CHANGED",
            "Legacy input changed after validation; retain the backup and inspect old writers.",
          ),
        )
      const backupManifest = () =>
        Effect.gen(function* () {
          const entries: Array<{ path: string; sha256: string; bytes: number }> = []
          for (const name of (yield* fs.readDirectory(backupRoot, { recursive: true })).sort()) {
            const absolute = path.join(backupRoot, name)
            if ((yield* fs.stat(absolute)).type !== "File") continue
            const bytes = yield* fs.readFile(absolute)
            entries.push({ path: name, sha256: yield* digest(bytes), bytes: bytes.length })
          }
          return entries
        })
      if (
        marker &&
        JSON.stringify(yield* backupManifest()) !== JSON.stringify(marker.backup_manifest)
      )
        return yield* Effect.fail(
          fail(
            "MIGRATION_SOURCE_CHANGED",
            "The frozen migration backup changed; no recovery writes were performed.",
          ),
        )
      if (finishing) {
        if (!(yield* fs.exists(`${root}/state.sqlite`)))
          return yield* Effect.fail(
            fail(
              "MIGRATION_BLOCKED",
              "Imported migration database is missing; recovery cannot switch configuration.",
            ),
          )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(`${root}/state.sqlite`, { flag: "r", noFollow: true })
            const header = new Uint8Array(16)
            if (
              (yield* file.read(header)) !== 16 ||
              new TextDecoder().decode(header) !== "SQLite format 3\u0000"
            )
              return yield* Effect.fail(
                fail(
                  "STATE_CORRUPT",
                  "Imported SQLite header is missing or corrupt; recovery cannot switch configuration.",
                ),
              )
          }),
        )
        if (marker!.stage === "imported") {
          yield* durable(`${configRoot}/config.json`, new TextEncoder().encode(switchedRaw))
          marker!.stage = "switched"
          yield* durable(markerPath, new TextEncoder().encode(JSON.stringify(marker)))
        }
        return {
          migrated: true,
          reused: true,
          database: `${root}/state.sqlite`,
          backup: backupRoot,
          source_hash: sourceHash,
          review_artifact: `${root}/migration-review.json`,
        }
      }
      if (!marker) {
        yield* fs.makeDirectory(configRoot, { recursive: true, mode: 0o700 })
        yield* fs.makeDirectory(cacheRoot, { recursive: true, mode: 0o700 })
        yield* fs.makeDirectory(backupRoot, { recursive: false, mode: 0o700 })
        yield* fs.copy(root, `${backupRoot}/state`)
        yield* fs.copy(cacheRoot, `${backupRoot}/cache`)
        // Config backup is private and intentionally includes credentials; it never enters DB or evidence output.
        yield* fs.copy(configRoot, `${backupRoot}/config`)
        marker = {
          version: 2,
          stage: "validated",
          source_hash: sourceHash,
          backup: backupRoot,
          manifest,
          roots: {
            state: yield* identity(root),
            config: yield* identity(configRoot),
            cache: yield* identity(cacheRoot),
            backup: yield* identity(backupRoot),
          },
          input: {
            config_source: selectedConfig,
            config_exists: configExists,
            config_hash: yield* digest(configRaw),
            switched_hash: yield* digest(switchedRaw),
          },
          backup_manifest: yield* backupManifest(),
        }
        yield* durable(markerPath, new TextEncoder().encode(JSON.stringify(marker)))
      }
      const state = yield* sqliteState(root, fs, true)
      marker.stage = "importing"
      yield* durable(markerPath, new TextEncoder().encode(JSON.stringify(marker)))
      // Each imported domain operation is idempotent. The switched marker is withheld until all relations exist.
      for (const binding of bindings) {
        const base = records.find((r) => r.key === `sync/bases/${property(binding).id}.json`)!
        const existing = (yield* state.bindings()).find(
          (b) => property(b).id === property(binding).id,
        )
        if (!existing)
          yield* state.registerBindingWithBase(
            decode(BindingSchema, binding),
            decode(BaseSchema, base.value),
          )
      }
      const historicalPlans = records.filter(
        (record) =>
          record.key.startsWith("sync/plans/") &&
          Array.isArray(property(record.value).bindings) &&
          (property(record.value).bindings as unknown[]).some(
            (edge) => property(property(edge).remote).skill !== undefined,
          ),
      )
      const publicationAudits: unknown[] = []
      const unresolvedPublicationKeys = new Set<string>()
      for (const record of records.filter((record) => record.key.startsWith("publications/"))) {
        const original = record.value
        const metadata = property(original)
        const portable = property(metadata.portable)
        const prepared =
          portable.kind === undefined
            ? { ...metadata, portable: { ...portable, kind: "skill" } }
            : original
        const converted = convertLegacyPublication(prepared, record.sha256)
        if (converted.audit || prepared !== original)
          publicationAudits.push({
            ...converted.audit,
            operation_id: metadata.operation_id,
            original_wire: original,
            original_wire_sha256: record.sha256,
          })
        if (converted.value) record.value = converted.value
        else {
          unresolvedPublicationKeys.add(record.key)
          const auditRef = `${root}/legacy-publication-migration-audit.json#${metadata.operation_id}`
          const operation = decode(OperationReviewSchema, {
            format: 1,
            operation_id: metadata.operation_id,
            kind: "review",
            state: "unknown",
            reason: "UNRESOLVED_NO_REPLAY",
            provenance: {
              type: "external_migration",
              source_sha256: record.sha256,
              audit_ref: auditRef,
            },
            refs: { plan_ids: [], publication_ids: [metadata.operation_id], binding_ids: [] },
            next: { action: "inspect", audit_ref: auditRef },
          })
          yield* state.write(`operation-reviews/${metadata.operation_id}.json`, operation)
        }
      }
      yield* durable(
        `${root}/legacy-publication-migration-audit.json`,
        new TextEncoder().encode(
          JSON.stringify({ format: 1, source_hash: sourceHash, publications: publicationAudits }),
        ),
      )
      const historicalIds = new Set(
        historicalPlans.map((record) => String(property(record.value).plan_id)),
      )
      const audited = records.filter(
        (record) =>
          historicalPlans.includes(record) ||
          (record.key.startsWith("sync/receipts/") &&
            historicalIds.has(String(property(record.value).plan_id))) ||
          unresolvedPublicationKeys.has(record.key),
      )
      yield* state.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`CREATE TABLE IF NOT EXISTS historical_review_artifacts (source_hash TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(source_hash,key))`
          for (const record of audited)
            yield* sql`INSERT INTO historical_review_artifacts(source_hash,key,payload) VALUES(${sourceHash},${record.key},${JSON.stringify(record.value)}) ON CONFLICT(source_hash,key) DO NOTHING`
          for (const record of audited.filter((record) =>
            record.key.startsWith("sync/receipts/"),
          )) {
            const receipt = property(record.value),
              auditRef = `${root}/migration-review.json#${receipt.operation_id}`
            const operation = decode(OperationReviewSchema, {
              format: 1,
              operation_id: receipt.operation_id,
              kind: "review",
              state: "unknown",
              reason: "UNRESOLVED_NO_REPLAY",
              provenance: {
                type: "external_migration",
                source_sha256: record.sha256,
                audit_ref: auditRef,
              },
              refs: {
                plan_ids: [receipt.plan_id],
                publication_ids: [],
                binding_ids: (receipt.bindings as unknown[]).map(
                  (entry) => property(entry).binding_id,
                ),
              },
              next: { action: "inspect", audit_ref: auditRef },
            })
            yield* state.write(`operation-reviews/${receipt.operation_id}.json`, operation)
          }
        }),
      )
      const review = {
        format: "ntn-skills-migration-review",
        version: 1,
        source_hash: sourceHash,
        executable: false,
        plans: historicalPlans.map((record) => ({
          original_plan_id: property(record.value).plan_id,
          original_sha256: record.sha256,
          original_key: record.key,
          binding_ids: (property(record.value).bindings as unknown[]).map(
            (edge) => property(property(edge).binding).id,
          ),
          approval: "required",
          next: "Run sync plan against the migrated binding identities, review the fresh remote and filesystem guards, then explicitly apply the newly returned plan ID. The historical plan remains an immutable audit artifact.",
        })),
      }
      yield* durable(
        `${root}/migration-review.json`,
        new TextEncoder().encode(JSON.stringify(review)),
      )
      for (const record of records)
        if (!audited.includes(record)) yield* state.write(record.key, record.value)
      yield* state.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`INSERT INTO migration_imports(source_hash,stage,manifest) VALUES(${sourceHash},'switched',${JSON.stringify(manifest)}) ON CONFLICT(source_hash) DO UPDATE SET stage='switched'`
        }),
      )
      marker.stage = "imported"
      yield* durable(markerPath, new TextEncoder().encode(JSON.stringify(marker)))
      yield* durable(`${configRoot}/config.json`, new TextEncoder().encode(switchedRaw))
      marker.stage = "switched"
      yield* durable(markerPath, new TextEncoder().encode(JSON.stringify(marker)))
      return {
        migrated: true,
        reused: false,
        database: state.filename,
        backup: backupRoot,
        source_hash: sourceHash,
        imported_records: records.length,
        review_artifact: `${root}/migration-review.json`,
        historical_plans_requiring_reapproval: historicalPlans.length,
        bindings: bindings.length,
      }
    }).pipe(
      Effect.flatMap((result) =>
        Effect.gen(function* () {
          yield* Stream.make(JSON.stringify({ ok: true, ...result }) + "\n").pipe(
            Stream.run((yield* Stdio.Stdio).stdout()),
          )
        }),
      ),
    ),
)
NodeRuntime.runMain(
  Command.runWith(command, { version: "1", renderErrors: false })(process.argv.slice(2)).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
)
