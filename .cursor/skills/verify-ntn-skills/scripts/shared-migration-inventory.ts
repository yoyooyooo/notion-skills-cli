/**
 * Offline AH-513 inventory. Run with Node 24; this never imports the application
 * runtime, opens current state, discovers credentials, or executes source files.
 * The output is evidence for `ctl library migration plan`, not a migration.
 */
import { createHash } from "node:crypto"
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import type { Stats } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { SharedMigrationInput } from "../../../../packages/core/src/shared-migration-plan.ts"

export type InventoryArguments = {
  catalog: string
  backup: string
  targetLibrary: string
  run: string
}
const businessDomains = [
  "subscription_add",
  "subscription_update",
  "subscription_remove",
  "upstream_fork",
  "upstream_track",
] as const
const operationTables = [
  "upstream_commands",
  "upstream_operations",
  "integrity_operations",
  "operation_reviews",
] as const
type OperationTable = (typeof operationTables)[number]
type StorageRole =
  | "plan_operation"
  | "cache"
  | "support"
  | "durable_history"
  | "review"
  | "unclassified"
const objectHash = /^[a-f0-9]{64}$/u
const own = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")

export class InventoryError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.code = code
    this.details = details
  }
}
function stop(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new InventoryError(code, message, details)
}
function string(value: unknown, label: string, nonempty = false): string {
  if (typeof value !== "string" || (nonempty && value === ""))
    stop("INVENTORY_INPUT_INVALID", `${label} must be a${nonempty ? " nonempty" : ""} string.`)
  return value
}
function stamp(info: Stats): string {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":")
}
function checkDirectory(path: string): void {
  let info
  try {
    info = lstatSync(path)
  } catch {
    stop("INPUT_UNAVAILABLE", "An explicit input directory is unavailable.", { path })
  }
  if (!info.isDirectory() || info.isSymbolicLink())
    stop(
      "INPUT_NOT_DIRECTORY",
      "An explicit input directory must be a real directory, not a symlink.",
      { path },
    )
}
function hashFile(path: string): { sha256: string; bytes: number; stamp: string } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd)
    if (!before.isFile()) stop("INPUT_NOT_FILE", "Inventory only reads regular files.", { path })
    const hash = createHash("sha256")
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let bytes = 0
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null)
      if (count === 0) break
      hash.update(buffer.subarray(0, count))
      bytes += count
    }
    const after = fstatSync(fd)
    if (stamp(before) !== stamp(after) || bytes !== before.size)
      stop("INPUT_CHANGED", "An input file changed while its bytes were being verified.", { path })
    return { sha256: hash.digest("hex"), bytes, stamp: stamp(after) }
  } finally {
    closeSync(fd)
  }
}
function readJson(path: string): { value: unknown; sha256: string; bytes: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd)
    if (!before.isFile()) stop("INPUT_NOT_FILE", "The catalog must be one regular file.", { path })
    const bytes = readFileSync(fd)
    if (stamp(before) !== stamp(fstatSync(fd)))
      stop("INPUT_CHANGED", "The catalog changed while it was read.", { path })
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    } catch {
      stop("CATALOG_JSON_INVALID", "The explicit catalog must contain valid UTF-8 JSON.", { path })
    }
    return { value, sha256: digest(bytes), bytes: bytes.length }
  } finally {
    closeSync(fd)
  }
}
function exclusiveJson(path: string, value: unknown, pretty = false): string {
  const encoded = `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`
  writeFileSync(path, encoded, { flag: "wx", mode: 0o600 })
  return digest(encoded)
}
function contains(parent: string, child: string): boolean {
  const offset = relative(parent, child)
  return offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
}
function coverage(value: unknown): SharedMigrationInput["catalog"]["coverage"] {
  const raw = own(value)
  if (
    typeof raw.exhaustive !== "boolean" ||
    typeof raw.search_index_limited !== "boolean" ||
    !Array.isArray(raw.queried_data_sources) ||
    !Array.isArray(raw.failed_sources)
  )
    stop(
      "CATALOG_COVERAGE_INVALID",
      "Preserve explicit catalog coverage; missing coverage cannot be inferred from a row count.",
    )
  return {
    method: string(raw.method, "coverage.method"),
    exhaustive: raw.exhaustive,
    search_index_limited: raw.search_index_limited,
    queried_data_sources: raw.queried_data_sources.map((id) =>
      string(id, "queried data-source identity"),
    ),
    failed_sources: raw.failed_sources.map((value) => {
      const failed = own(value)
      return {
        id: string(failed.id, "failed source identity"),
        code: string(failed.code, "failed source code"),
        database_id: string(failed.database_id, "failed database identity"),
        alias: string(failed.alias, "failed source alias"),
        title: string(failed.title, "failed source title"),
        ...(failed.data_source_id === undefined
          ? {}
          : { data_source_id: string(failed.data_source_id, "failed data-source identity") }),
      }
    }),
  }
}
type FileIndex = { path: unknown; sha256: unknown; bytes: unknown; valid: boolean }
type ObjectCheck = {
  sha256: string
  path: string
  verified: boolean
  code?: string
  actual_sha256?: string
  bytes?: number
  stamp?: string
}
function fileIndex(value: unknown, optional: boolean): { files: FileIndex[]; complete: boolean } {
  if (value === undefined && optional) return { files: [], complete: true }
  if (!Array.isArray(value)) return { files: [], complete: false }
  const files = value.map((value) => {
    const file = own(value)
    return {
      path: file.path ?? null,
      sha256: file.sha256 ?? null,
      bytes: file.bytes ?? null,
      valid:
        typeof file.path === "string" &&
        file.path !== "" &&
        typeof file.sha256 === "string" &&
        objectHash.test(file.sha256) &&
        typeof file.bytes === "number" &&
        Number.isSafeInteger(file.bytes) &&
        file.bytes >= 0,
    }
  })
  return { files, complete: files.every((file) => file.valid) }
}
function sourceOptions(value: unknown): string[] {
  const found: string[] = []
  const work = [{ value, path: "$" }]
  const names = new Set([
    "external_assets",
    "external_markdown",
    "include",
    "exclude",
    "patch",
    "sharedTargetSet",
    "shared_target_set",
    "roots",
    "mapping",
  ])
  while (work.length > 0) {
    const current = work.pop()
    if (current === undefined || current.value === null || typeof current.value !== "object")
      continue
    for (const [key, nested] of Object.entries(current.value)) {
      const path = `${current.path}.${key}`
      if (names.has(key)) found.push(path)
      if (nested !== null && typeof nested === "object") work.push({ value: nested, path })
    }
  }
  return found.sort()
}
function rowPointer(
  database: string,
  databaseSha: string,
  table: string,
  key: string,
  payloadSha: string,
): string {
  return `sqlite-backup:${database}#database_sha256=${databaseSha}&table=${table}&operation_or_snapshot_id=${encodeURIComponent(key)}&payload_sha256=${payloadSha}`
}

/** Observed storage family, not a decoder, impact closure, or remote outcome.
 * Keep unknown shapes visible; no family label can mark an operation complete. */
export function operationStorageFamily(
  table: OperationTable,
  key: string,
  raw: unknown,
  validJson: boolean,
): { family: string; role: StorageRole } {
  if (table === "upstream_operations") return { family: "upstream_batch", role: "plan_operation" }
  if (table === "integrity_operations")
    return { family: "publication_integrity", role: "plan_operation" }
  const value = own(raw)
  if (table === "operation_reviews")
    return validJson && value.kind === "review" && typeof value.operation_id === "string"
      ? { family: "operation_review", role: "review" }
      : { family: "unrecognized_review", role: "unclassified" }
  if (!validJson) return { family: "invalid_json", role: "unclassified" }
  if (typeof value.domain === "string" && businessDomains.some((domain) => domain === value.domain))
    return { family: `command:${value.domain}`, role: "plan_operation" }
  if (
    key.startsWith("materialized:") &&
    Object.keys(value).sort().join(",") === "content_hash,portable,revision" &&
    typeof value.content_hash === "string" &&
    objectHash.test(value.content_hash) &&
    typeof value.revision === "string" &&
    value.portable !== null &&
    typeof value.portable === "object" &&
    !Array.isArray(value.portable)
  )
    return { family: "materialized", role: "cache" }
  const prefixes: readonly [string, string, StorageRole, readonly string[]][] = [
    ["content-adoption:member:", "content_adoption_member", "support", ["plan_id"]],
    ["content-adoption:publication:", "content_adoption_publication", "support", ["plan_id"]],
    ["content-adoption:plan:", "content_adoption_plan", "durable_history", ["plan", "state"]],
    ["file-acceptance:", "file_acceptance", "durable_history", ["operation_id", "state"]],
    [
      "map-checkpoint-adoption:plan:",
      "map_checkpoint_adoption_plan",
      "durable_history",
      ["domain", "plan_id"],
    ],
    [
      "map-checkpoint-adoption:receipt:",
      "map_checkpoint_adoption_receipt",
      "durable_history",
      ["domain", "operation_id"],
    ],
    [
      "markdown-files:member:",
      "markdown_files_member",
      "support",
      ["plan_id", "original_operation_id", "original_publication_id"],
    ],
    [
      "publication-body-completion:plan:",
      "publication_body_completion_plan",
      "durable_history",
      ["domain", "plan_id", "operation_id"],
    ],
    [
      "publication-supersede:new:",
      "publication_supersede_new",
      "support",
      ["plan_id", "old_operation_id"],
    ],
    [
      "publication-supersede:original:",
      "publication_supersede_original",
      "durable_history",
      ["plan_id", "state"],
    ],
    [
      "publication-supersede:plan:",
      "publication_supersede_plan",
      "durable_history",
      ["plan", "state"],
    ],
    [
      "source-rich-text-repair:member:",
      "source_rich_text_repair",
      "durable_history",
      ["domain", "phase", "plan"],
    ],
    [
      "source-root-completion:member:",
      "source_root_completion",
      "durable_history",
      ["domain", "phase", "plan"],
    ],
    [
      "source-root-fidelity:member:",
      "source_root_fidelity",
      "durable_history",
      ["domain", "phase", "plan"],
    ],
    ["upstream-observation:", "upstream_observation", "support", ["subscription", "members"]],
    ["upstream-rebuild:", "upstream_rebuild", "durable_history", ["operation_id", "state"]],
  ]
  for (const [prefix, family, role, fields] of prefixes)
    if (key.startsWith(prefix) && fields.every((field) => Object.hasOwn(value, field)))
      return { family, role }
  if (
    /^uo_[a-f0-9]+:projections$/u.test(key) &&
    Object.hasOwn(value, "entries") &&
    Object.hasOwn(value, "operation_id")
  )
    return { family: "upstream_projections", role: "support" }
  if (/^up_[a-f0-9]+:accepted-config$/u.test(key) && typeof raw === "string")
    return { family: "accepted_config", role: "support" }
  if (
    /^up_[a-f0-9]+:subscription-map:checkpoint$/u.test(key) &&
    ["published", "subscription_id", "version"].every((field) => Object.hasOwn(value, field))
  )
    return { family: "subscription_map_checkpoint", role: "support" }
  if (
    /^up_[a-f0-9]+:subscription-map(?::intended)?$/u.test(key) &&
    (Object.hasOwn(value, "unpublished") ||
      [
        "members",
        "plan_hash",
        "publisher_subscription_id",
        "revision",
        "source_manifest",
        "version",
      ].every((field) => Object.hasOwn(value, field)))
  )
    return {
      family: key.endsWith(":intended") ? "subscription_map_intended" : "subscription_map",
      role: "support",
    }
  return { family: "unrecognized", role: "unclassified" }
}
function jsonType(value: unknown, valid: boolean): string {
  return !valid
    ? "invalid"
    : value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : typeof value
}

export function collectMigrationInventory(arguments_: InventoryArguments) {
  if (!process.versions.node.startsWith("24."))
    stop("NODE_24_REQUIRED", "Run this read-only collector with Node.js 24.")
  for (const [name, value] of Object.entries({
    catalog: arguments_.catalog,
    backup: arguments_.backup,
    run: arguments_.run,
  }))
    if (!isAbsolute(value))
      stop("ABSOLUTE_PATH_REQUIRED", `--${name} must be an explicit absolute path.`)
  if (arguments_.targetLibrary.trim() === "")
    stop("TARGET_LIBRARY_REQUIRED", "--target-library must be an explicit stable library identity.")
  const backup = resolve(arguments_.backup)
  const catalogPath = resolve(arguments_.catalog)
  const run = resolve(arguments_.run)
  checkDirectory(backup)
  checkDirectory(join(backup, "objects"))
  const canonicalBackup = realpathSync(backup)
  const canonicalRun = join(realpathSync(dirname(run)), basename(run))
  if (contains(canonicalBackup, canonicalRun) || contains(canonicalRun, canonicalBackup))
    stop("RUN_OVERLAPS_INPUT", "The new run directory must be separate from the backup.")
  try {
    mkdirSync(run, { mode: 0o700 })
  } catch {
    stop(
      "RUN_NOT_FRESH",
      "--run must name a new directory whose parent already exists; an existing run is never reused.",
      { run },
    )
  }
  let db: DatabaseSync | undefined
  try {
    const database = join(canonicalBackup, "state.sqlite")
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      let present = false
      try {
        lstatSync(`${database}${suffix}`)
        present = true
      } catch (error) {
        if (own(error).code !== "ENOENT") throw error
      }
      if (present)
        stop(
          "BACKUP_HAS_SQLITE_SIDECAR",
          "Use a completed standalone SQLite backup; live journal sidecars are outside this inventory contract.",
          { suffix },
        )
    }
    const catalog = readJson(catalogPath)
    const root = own(catalog.value)
    if (root.ok === false || !Array.isArray(root.records))
      stop(
        "CATALOG_INPUT_INVALID",
        "The explicit input must be a successful CLI catalog response with records.",
      )
    const scope = string(root.scope, "catalog scope", true)
    const observedCoverage = coverage(root.coverage)
    const databaseBefore = hashFile(database)
    const collectorSha = hashFile(fileURLToPath(import.meta.url)).sha256
    const fingerprintsSha = exclusiveJson(
      join(run, "source-fingerprints.json"),
      {
        version: 1,
        catalog: { path: catalogPath, sha256: catalog.sha256, bytes: catalog.bytes },
        database: { path: database, sha256: databaseBefore.sha256, bytes: databaseBefore.bytes },
        collector: {
          path: fileURLToPath(import.meta.url),
          sha256: collectorSha,
          node: process.version,
        },
        selected_command_domains: businessDomains,
      },
      true,
    )
    db = new DatabaseSync(database, { readOnly: true, allowExtension: false })
    db.exec("PRAGMA query_only=ON")
    db.exec("PRAGMA trusted_schema=OFF")
    db.exec("BEGIN")
    const quick = db
      .prepare("PRAGMA quick_check")
      .all()
      .map((row) => Object.values(row))
    if (quick.length !== 1 || quick[0]?.length !== 1 || quick[0]?.[0] !== "ok")
      stop("BACKUP_QUICK_CHECK_FAILED", "SQLite quick_check did not confirm database integrity.")
    for (const table of [
      "snapshots",
      "upstream_commands",
      "upstream_operations",
      "integrity_operations",
    ]) {
      const found = db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name=?")
        .get(table)
      if (found === undefined)
        stop(
          "BACKUP_SCHEMA_UNSUPPORTED",
          "A required backup table is missing; no migration or repair is attempted.",
          { table },
        )
    }

    const pageRecords = new Map<string, string[]>()
    const entries: SharedMigrationInput["catalog"]["entries"] = root.records.map(
      (record, index) => {
        const original = own(record)
        const legacyId =
          typeof original.id === "string" && original.id !== ""
            ? original.id
            : `unidentified-catalog-row:${index}`
        const locator = own(original.locator)
        const page = typeof locator.page_id === "string" ? locator.page_id : undefined
        const entrypoint =
          typeof original.entrypoint === "string" && original.entrypoint !== ""
            ? original.entrypoint
            : undefined
        if (page !== undefined) pageRecords.set(page, [...(pageRecords.get(page) ?? []), legacyId])
        return {
          legacy_id: legacyId,
          record,
          metadata: { evidence_kind: "catalog_summary", record },
          metadata_complete: false,
          files_complete: false,
          legacy_mode: "unknown",
          legacy_layout: "unknown",
          files:
            page !== undefined && entrypoint !== undefined
              ? [
                  {
                    legacy_id: `catalog-page-body:${page}:${entrypoint}`,
                    path: entrypoint,
                    ownership: "unknown",
                    raw: {
                      evidence_kind: "unverified_main_file_candidate",
                      page_id: page,
                      entrypoint,
                      catalog_record_id: legacyId,
                    },
                  },
                ]
              : [],
        }
      },
    )
    const objects = new Map<string, ObjectCheck>()
    let objectReferences = 0
    const inspectObject = (sha: string) => {
      objectReferences += 1
      if (objects.has(sha)) return
      const path = join(canonicalBackup, "objects", sha)
      try {
        const actual = hashFile(path)
        objects.set(sha, {
          sha256: sha,
          path,
          verified: actual.sha256 === sha,
          ...(actual.sha256 === sha ? {} : { code: "OBJECT_HASH_MISMATCH" }),
          actual_sha256: actual.sha256,
          bytes: actual.bytes,
          stamp: actual.stamp,
        })
      } catch (error) {
        const code =
          error instanceof InventoryError
            ? error.code
            : typeof own(error).code === "string"
              ? (own(error).code as string)
              : "OBJECT_UNAVAILABLE"
        objects.set(sha, { sha256: sha, path, verified: false, code })
      }
    }
    const pins: Array<{
      legacy_id: string
      raw: Record<string, unknown>
      complete: false
      references: string[]
      retention_ref: string
      retention_verified: false
      files: FileIndex[]
      sourceFiles: FileIndex[]
      indexComplete: boolean
    }> = []
    let manifestBytes = 0
    let malformedManifests = 0
    for (const row of db
      .prepare(
        "SELECT id,scope,record_identity,version_id,manifest,locator FROM snapshots ORDER BY id",
      )
      .iterate()) {
      const id = string(row.id, "snapshot table row identity", true)
      const serialized = string(row.manifest, "snapshot manifest")
      const manifestSha = digest(serialized)
      const bytes = Buffer.byteLength(serialized, "utf8")
      manifestBytes += bytes
      let manifest: Record<string, unknown> = {}
      let parsed = true
      try {
        const value: unknown = JSON.parse(serialized)
        manifest = own(value)
        parsed = value !== null && typeof value === "object" && !Array.isArray(value)
      } catch {
        parsed = false
      }
      if (!parsed) malformedManifests += 1
      const files = fileIndex(manifest.files, false)
      const sourceFiles = fileIndex(manifest.source_files, true)
      for (const file of [...files.files, ...sourceFiles.files])
        if (typeof file.sha256 === "string" && objectHash.test(file.sha256))
          inspectObject(file.sha256)
      const recordIdentity = typeof row.record_identity === "string" ? row.record_identity : null
      const pointer = rowPointer(database, databaseBefore.sha256, "snapshots", id, manifestSha)
      pins.push({
        legacy_id: id,
        complete: false,
        references: recordIdentity === null ? [] : [recordIdentity],
        retention_ref: pointer,
        retention_verified: false,
        files: files.files,
        sourceFiles: sourceFiles.files,
        indexComplete: parsed && files.complete && sourceFiles.complete,
        raw: {
          evidence_kind: "cached_snapshot_candidate",
          asserted_user_pin: false,
          backup_row: {
            database,
            database_sha256: databaseBefore.sha256,
            table: "snapshots",
            key: { id },
            manifest_sha256: manifestSha,
            manifest_bytes: bytes,
          },
          scope: row.scope,
          record_identity: recordIdentity,
          version_id: row.version_id,
          locator_serialized: row.locator,
          manifest_identity: {
            snapshot_id: manifest.snapshot_id ?? null,
            scope: manifest.scope ?? null,
            record_id: own(manifest.record).id ?? null,
            version_id: manifest.version_id ?? null,
          },
          manifest_json_valid: parsed,
          files: files.files,
          source_files: sourceFiles.files,
          original_manifest_retained_in_backup: true,
          interpretation_complete: false,
        },
      })
    }

    const operations: SharedMigrationInput["preservation"]["operations"]["items"][number][] = []
    const operationIndex: Record<string, unknown>[] = []
    const storageRows: Record<string, unknown>[] = []
    const reviewRows: Record<string, unknown>[] = []
    const tableCounts: Record<string, number | null> = {}
    const familyCounts: Record<string, number> = {}
    const sourceOptionReviews: Record<string, unknown>[] = []
    const operationCounts: Record<string, number> = {}
    const commandTotal = db.prepare("SELECT count(*) AS count FROM upstream_commands").get()?.count
    const commandInvalid = db
      .prepare("SELECT count(*) AS count FROM upstream_commands WHERE NOT json_valid(payload)")
      .get()?.count
    // Preserve the original SQL selection exactly, including ambiguous JSON.
    // The sidecar is a larger enumeration, never a reinterpretation of that set.
    const parameters = businessDomains.map(() => "?").join(",")
    const selectedCommands = new Set(
      db
        .prepare(
          `SELECT operation_id FROM upstream_commands WHERE CASE WHEN json_valid(payload) THEN json_extract(payload,'$.domain') END IN (${parameters})`,
        )
        .all(...businessDomains)
        .map((row) => string(row.operation_id, "selected command identity", true)),
    )
    for (const table of operationTables) {
      const present =
        db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name=?").get(table) !==
        undefined
      if (!present) {
        tableCounts[table] = null
        continue
      }
      const column = table === "operation_reviews" ? "id" : "operation_id"
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${column}`).iterate()
      let count = 0
      tableCounts[table] = 0
      for (const row of rows) {
        tableCounts[table] = (tableCounts[table] ?? 0) + 1
        const key = string(row[column], "operation table row identity", true)
        const serialized = string(row.payload, "original operation payload")
        let raw: unknown
        let validJson = true
        try {
          raw = JSON.parse(serialized)
        } catch {
          raw = serialized
          validJson = false
        }
        const original = own(raw)
        const pointer = rowPointer(database, databaseBefore.sha256, table, key, digest(serialized))
        const selected =
          table !== "operation_reviews" &&
          (table !== "upstream_commands" || selectedCommands.has(key))
        const observedFamily = operationStorageFamily(table, key, raw, validJson)
        const indexed = {
          table,
          key: { [column]: key },
          payload_sha256: digest(serialized),
          payload_bytes: Buffer.byteLength(serialized, "utf8"),
          valid_json: validJson,
          json_type: jsonType(raw, validJson),
          top_level_keys: Object.keys(own(raw)).sort(),
          ...observedFamily,
          selected_for_plan: selected,
          row_metadata: Object.fromEntries(
            Object.entries(row).filter(([name]) => name !== "payload"),
          ),
          retention_ref: pointer,
          references_complete: false,
          current_terminal_outcome_verified: false,
        }
        storageRows.push(indexed)
        familyCounts[observedFamily.family] = (familyCounts[observedFamily.family] ?? 0) + 1
        if (table === "operation_reviews")
          reviewRows.push({
            ...indexed,
            payload_json: serialized,
            interpretation_complete: false,
          })
        if (!selected) continue
        count += 1
        const legacyId =
          typeof original.operation_id === "string" && original.operation_id !== ""
            ? original.operation_id
            : key
        const references =
          typeof original.record_identity === "string"
            ? [original.record_identity]
            : typeof original.page_id === "string"
              ? (pageRecords.get(original.page_id) ?? [])
              : []
        operations.push({
          legacy_id: legacyId,
          raw,
          complete: false,
          references,
          retention_ref: pointer,
          retention_verified: true,
          terminal_verified: false,
        })
        operationIndex.push({
          table,
          key: { operation_id: key },
          legacy_id: legacyId,
          payload_sha256: digest(serialized),
          payload_bytes: Buffer.byteLength(serialized, "utf8"),
          valid_json: validJson,
          row_metadata: Object.fromEntries(
            Object.entries(row).filter(([name]) => name !== "payload"),
          ),
          retention_ref: pointer,
          current_terminal_outcome_verified: false,
        })
        const options = sourceOptions(raw)
        if (options.length > 0) sourceOptionReviews.push({ table, key, paths: options })
      }
      if (table !== "operation_reviews") operationCounts[table] = count
    }
    db.exec("ROLLBACK")
    db.close()
    db = undefined
    const databaseAfter = hashFile(database)
    if (
      databaseAfter.sha256 !== databaseBefore.sha256 ||
      databaseAfter.bytes !== databaseBefore.bytes
    )
      stop(
        "BACKUP_CHANGED",
        "The SQLite backup changed during inventory; no frozen input is published.",
      )
    if (hashFile(catalogPath).sha256 !== catalog.sha256)
      stop("CATALOG_CHANGED", "The catalog changed during inventory; no frozen input is published.")
    for (const object of objects.values())
      if (object.stamp !== undefined) {
        try {
          const final = lstatSync(object.path)
          if (!final.isFile() || final.isSymbolicLink() || stamp(final) !== object.stamp) {
            object.verified = false
            object.code = "OBJECT_CHANGED_DURING_INVENTORY"
          }
        } catch {
          object.verified = false
          object.code = "OBJECT_UNAVAILABLE_AFTER_READ"
        }
      }
    const verifiedFile = (file: FileIndex) => {
      const checked = typeof file.sha256 === "string" ? objects.get(file.sha256) : undefined
      return file.valid && checked?.verified === true && checked.bytes === file.bytes
    }
    let verifiedCandidates = 0
    for (const candidate of pins) {
      const verified =
        candidate.indexComplete &&
        candidate.files.every(verifiedFile) &&
        candidate.sourceFiles.every(verifiedFile)
      candidate.raw.file_index_complete = candidate.indexComplete
      candidate.raw.cached_bytes_verified = verified
      candidate.raw.files_with_unverified_bytes = candidate.files.filter(
        (file) => !verifiedFile(file),
      ).length
      candidate.raw.source_files_with_unverified_bytes = candidate.sourceFiles.filter(
        (file) => !verifiedFile(file),
      ).length
      if (verified) verifiedCandidates += 1
    }
    const objectEvidence = [...objects.values()]
      .sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0))
      .map(({ stamp: _stamp, ...item }) => item)
    const objectIndexText =
      objectEvidence.map((item) => JSON.stringify(item)).join("\n") +
      (objectEvidence.length ? "\n" : "")
    writeFileSync(join(run, "object-verification.jsonl"), objectIndexText, {
      flag: "wx",
      mode: 0o600,
    })
    const allReferencedObjectsVerified = verifiedCandidates === pins.length
    const frozen: SharedMigrationInput = {
      version: 1,
      scope,
      target_library_id: arguments_.targetLibrary,
      approved_legacy_ids: [],
      backup: {
        verified: allReferencedObjectsVerified,
        reference: `sqlite-backup:${database}#sha256=${databaseBefore.sha256}&object_index_sha256=${digest(objectIndexText)}`,
      },
      catalog: { coverage: observedCoverage, entries },
      preservation: {
        sources: { complete: false, items: [] },
        views: { complete: false, items: [] },
        routers: {
          complete: false,
          items: entries
            .filter((entry) => own(entry.record).kind === "router")
            .map((entry) => ({
              legacy_id: entry.legacy_id,
              raw: entry.record,
              complete: false,
              references: [],
              retention_ref: `catalog:${catalog.sha256}:record:${encodeURIComponent(entry.legacy_id)}`,
              retention_verified: true,
            })),
        },
        pins: {
          complete: false,
          items: pins.map(
            ({
              files: _files,
              sourceFiles: _sourceFiles,
              indexComplete: _indexComplete,
              ...item
            }) => item,
          ),
        },
        operations: { complete: false, items: operations },
      },
    }
    const inputPath = join(run, "input.json")
    const inputSha = exclusiveJson(inputPath, frozen)
    exclusiveJson(join(run, "operation-index.json"), operationIndex)
    const storageIndexPath = join(run, "operation-storage-index.json")
    const reviewPath = join(run, "operation-reviews.json")
    const storageIndexSha = exclusiveJson(storageIndexPath, {
      version: 1,
      kind: "operation_storage_index",
      database_sha256: databaseBefore.sha256,
      collector_sha256: collectorSha,
      selected_command_domains: businessDomains,
      table_counts: tableCounts,
      rows: storageRows,
      references_complete: false,
      current_terminal_outcomes_verified: 0,
    })
    const reviewSha = exclusiveJson(reviewPath, {
      version: 1,
      kind: "retained_operation_reviews",
      database_sha256: databaseBefore.sha256,
      table_present: tableCounts.operation_reviews !== null,
      items: reviewRows,
      interpretation_complete: false,
    })
    const counts = {
      catalog_records: entries.length,
      cached_snapshot_candidates: pins.length,
      operation_payloads: operations.length,
      unique_object_hashes: objects.size,
    }
    const summary = {
      version: 1,
      mode: "read_only_inventory",
      collected_at: new Date().toISOString(),
      run,
      input: { path: inputPath, sha256: inputSha },
      counts,
      backup: {
        database,
        database_sha256: databaseBefore.sha256,
        database_bytes: databaseBefore.bytes,
        database_verified: true,
        quick_check: "ok",
        database_unchanged: true,
        complete_object_pass: allReferencedObjectsVerified,
      },
      objects: {
        references_checked: objectReferences,
        unique_checked: objects.size,
        cache_hits: objectReferences - objects.size,
        files_hashed: objectEvidence.filter((item) => item.actual_sha256 !== undefined).length,
        bytes_hashed: objectEvidence.reduce((total, item) => total + (item.bytes ?? 0), 0),
        verified: objectEvidence.filter((item) => item.verified).length,
        failed: objectEvidence.filter((item) => !item.verified).length,
        evidence: join(run, "object-verification.jsonl"),
        sha256: digest(objectIndexText),
      },
      snapshots: {
        manifest_bytes_hashed: manifestBytes,
        serialized_manifests_copied: 0,
        malformed_manifests: malformedManifests,
        cached_candidates_with_verified_bytes: verifiedCandidates,
        asserted_user_pins: 0,
        completeness_asserted: false,
      },
      catalog: {
        path: catalogPath,
        sha256: catalog.sha256,
        scope,
        coverage: root.coverage,
        current_bodies_read: 0,
        metadata_complete: false,
        files_complete: false,
      },
      operations: {
        tables: operationCounts,
        selected_command_domains: businessDomains,
        command_rows_total: commandTotal,
        command_rows_with_invalid_json: commandInvalid,
        command_rows_excluded:
          typeof commandTotal === "number"
            ? commandTotal - (operationCounts.upstream_commands ?? 0)
            : null,
        current_terminal_outcomes_verified: 0,
        row_index: join(run, "operation-index.json"),
      },
      operation_storage: {
        version: 1,
        row_count: storageRows.length,
        table_counts: tableCounts,
        families: familyCounts,
        index: { path: storageIndexPath, sha256: storageIndexSha },
        reviews: { path: reviewPath, sha256: reviewSha },
        source_fingerprints: {
          path: join(run, "source-fingerprints.json"),
          sha256: fingerprintsSha,
        },
        selected_operations_unchanged: true,
        references_complete: false,
        current_terminal_outcomes_verified: 0,
      },
      source_options_requiring_review: sourceOptionReviews,
      unknown: [
        "approved migration scope",
        "current Notion bodies and metadata",
        "tracked/fork/local and historical layouts",
        "complete Sources/Views/Router inventories",
        "user pin designations",
        "complete durable-row references, family interpretation and current terminal outcomes",
        "AK registrations",
      ],
      safeguards: {
        apply_allowed: false,
        production_writes: 0,
        network_requests: 0,
        imported_scripts_executed: 0,
        credentials_read: false,
        active_hosts: ["pro", "mini"],
        other_hosts: "deferred",
      },
    }
    exclusiveJson(join(run, "summary.json"), summary, true)
    return {
      ok: true,
      run,
      input: inputPath,
      input_sha256: inputSha,
      summary: join(run, "summary.json"),
      counts,
      apply_allowed: false,
    }
  } catch (error) {
    const failure =
      error instanceof InventoryError
        ? error
        : new InventoryError(
            "INVENTORY_FAILED",
            "The explicit backup inventory could not finish; the owned run and original inputs are retained.",
            { system_code: typeof own(error).code === "string" ? own(error).code : null },
          )
    try {
      exclusiveJson(
        join(run, "failure.json"),
        { ok: false, code: failure.code, message: failure.message, details: failure.details, run },
        true,
      )
    } catch {
      /* Never overwrite prior run evidence. */
    }
    throw failure
  } finally {
    if (db !== undefined) db.close()
  }
}

export function parseInventoryArguments(argv: readonly string[]): InventoryArguments {
  const values = new Map<string, string>()
  const allowed = new Set(["--catalog", "--backup", "--target-library", "--run"])
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (
      flag === undefined ||
      !allowed.has(flag) ||
      values.has(flag) ||
      value === undefined ||
      value.startsWith("--")
    )
      stop(
        "INVALID_ARGUMENT",
        "Use each required named argument exactly once: --catalog ABS --backup ABS --target-library ID --run NEW_OWNED_ABS.",
      )
    values.set(flag, value)
  }
  if (values.size !== 4)
    stop(
      "INVALID_ARGUMENT",
      "Required arguments: --catalog ABS --backup ABS --target-library ID --run NEW_OWNED_ABS.",
    )
  return {
    catalog: string(values.get("--catalog"), "--catalog", true),
    backup: string(values.get("--backup"), "--backup", true),
    targetLibrary: string(values.get("--target-library"), "--target-library", true),
    run: string(values.get("--run"), "--run", true),
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  if (process.argv.slice(2).length === 1 && process.argv[2] === "--help") {
    process.stdout.write(
      "Node 24 read-only shared migration inventory\nnode .cursor/skills/verify-ntn-skills/scripts/shared-migration-inventory.ts --catalog ABS --backup ABS --target-library ID --run NEW_OWNED_ABS\nReads only the explicit catalog and standalone backup/state.sqlite plus referenced backup/objects hashes. Creates a new private run with complete input.json, summary.json and byte-verification evidence. Cached snapshots remain candidates, approval is empty, and this does not execute a migration or an import.\n",
    )
  } else {
    try {
      process.stdout.write(
        `${JSON.stringify(collectMigrationInventory(parseInventoryArguments(process.argv.slice(2))))}\n`,
      )
    } catch (error) {
      const failure =
        error instanceof InventoryError
          ? error
          : new InventoryError("INVENTORY_FAILED", "The read-only inventory failed.")
      process.stdout.write(
        `${JSON.stringify({ ok: false, code: failure.code, message: failure.message, details: failure.details })}\n`,
      )
      process.exitCode = 1
    }
  }
}
