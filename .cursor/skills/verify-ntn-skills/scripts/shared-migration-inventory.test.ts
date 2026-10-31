import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import {
  collectMigrationInventory,
  InventoryError,
  parseInventoryArguments,
} from "./shared-migration-inventory.ts"

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const read = (path: string): any => JSON.parse(readFileSync(path, "utf8"))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "shared-migration-inventory-test-"))
  const backup = join(root, "backup")
  mkdirSync(backup, { mode: 0o700 })
  mkdirSync(join(backup, "objects"), { mode: 0o700 })
  const database = join(backup, "state.sqlite")
  const db = new DatabaseSync(database)
  db.exec(
    "CREATE TABLE snapshots(id TEXT PRIMARY KEY,scope TEXT,record_identity TEXT,version_id TEXT,manifest TEXT,locator TEXT)",
  )
  db.exec("CREATE TABLE upstream_commands(operation_id TEXT PRIMARY KEY,payload TEXT)")
  db.exec(
    "CREATE TABLE upstream_operations(operation_id TEXT PRIMARY KEY,plan_id TEXT,state TEXT,payload TEXT)",
  )
  db.exec(
    "CREATE TABLE integrity_operations(operation_id TEXT PRIMARY KEY,publication_operation_id TEXT,intended_hash TEXT,state TEXT,page_id TEXT,payload TEXT)",
  )
  const main = Buffer.from("Current cached main is not current Notion evidence")
  const source = Buffer.from([0, 255, 4, 18, 0])
  const mainHash = sha(main)
  const sourceHash = sha(source)
  writeFileSync(join(backup, "objects", mainHash), main, { mode: 0o600 })
  writeFileSync(join(backup, "objects", sourceHash), source, { mode: 0o600 })
  const record = {
    id: "notion_page:page-a",
    kind: "skill",
    locator: {
      type: "notion_page",
      page_id: "page-a",
      database_id: "db-a",
      data_source_id: "ds-a",
    },
    name: "Private original",
    alias: "private",
    description: "Catalog summary",
    default_context: false,
    entrypoint: "SKILL.md",
    ref: "original-ref",
    upstream: { repo: "display-only" },
    unknown_original: { value: true },
  }
  const payloads: string[] = []
  for (const id of ["snapshot-a", "snapshot-b"]) {
    const manifest = {
      snapshot_id: id,
      scope: "old-scope",
      version_id: "old-version",
      record,
      entrypoint: "SKILL.md",
      files: [{ path: "SKILL.md", sha256: mainHash, bytes: main.length }],
      source_files: [{ path: "source.bin", sha256: sourceHash, bytes: source.length }],
      references: [
        {
          id: "old-page",
          path: "Reference.md",
          markdown: "private-manifest-content-".repeat(8000),
        },
      ],
    }
    const serialized = JSON.stringify(manifest, null, 2)
    payloads.push(serialized)
    db.prepare("INSERT INTO snapshots VALUES (?,?,?,?,?,?)").run(
      id,
      "old-scope",
      record.id,
      "old-version",
      serialized,
      JSON.stringify(record.locator),
    )
  }
  const command = {
    operation_id: "original-add",
    domain: "subscription_add",
    scope: "original-command-scope",
    database_id: "original-db",
    state: "unknown",
    phase: "awaiting_verify",
    status: "completed",
    input: {
      source: {
        provider: { type: "github", url: "https://github.com/example/skills", ref: "main" },
        external_assets: false,
        external_markdown: ["Reference.md"],
      },
      include: [],
      mapping: {},
    },
    intent: {
      method: "POST",
      path: "v1/pages",
      payload: { keep: { every: ["field"] } },
      origin: { scope: "original-command-scope" },
    },
    unknown_original: { preserve: "exactly" },
  }
  const upstream = {
    operation_id: "upstream-original",
    state: "writing",
    phase: "apply",
    scope: "old-scope",
    plan_id: "old-plan",
    entries: [{ frozen: true }],
  }
  const integrity = {
    operation_id: "integrity-original",
    scope: "old-scope",
    marker: { state: "committed" },
    intended_hash: mainHash,
    complete_original_payload: [1, 2, 3],
  }
  db.prepare("INSERT INTO upstream_commands VALUES (?,?)").run(
    "command-key",
    JSON.stringify(command),
  )
  db.prepare("INSERT INTO upstream_commands VALUES (?,?)").run(
    "materialized-cache",
    JSON.stringify({ portable: { files: [{ content: "Not a business command" }] } }),
  )
  db.prepare("INSERT INTO upstream_operations VALUES (?,?,?,?)").run(
    upstream.operation_id,
    upstream.plan_id,
    upstream.state,
    JSON.stringify(upstream),
  )
  db.prepare("INSERT INTO integrity_operations VALUES (?,?,?,?,?,?)").run(
    integrity.operation_id,
    "publication-original",
    mainHash,
    "committed",
    "page-a",
    JSON.stringify(integrity),
  )
  db.close()
  const catalog = join(root, "catalog.json")
  const catalogValue = {
    ok: true,
    scope: "current-observation-scope",
    records: [record],
    count: 1,
    coverage: {
      method: "explicit_database",
      exhaustive: false,
      queried_data_sources: ["ds-a"],
      failed_sources: [
        {
          id: "source-failed",
          code: "INVALID_UPSTREAM",
          database_id: "other-db",
          alias: "other",
          title: "Failed source",
        },
      ],
      search_index_limited: false,
    },
  }
  writeFileSync(catalog, JSON.stringify(catalogValue), { mode: 0o600 })
  return {
    root,
    backup,
    database,
    catalog,
    record,
    payloads,
    command,
    upstream,
    integrity,
    mainHash,
    sourceHash,
    catalogValue,
    args: { catalog, backup, targetLibrary: "exact-target-library", run: join(root, "run") },
  }
}

test("collects a private reproducible input with compact exact snapshot pointers and raw operations", () => {
  const f = fixture()
  const databaseHash = sha(readFileSync(f.database))
  const databaseFiles = readdirSync(f.backup).sort()
  const result = collectMigrationInventory(f.args)
  const input = read(result.input)
  const summary = read(result.summary)
  assert.equal(input.approved_legacy_ids.length, 0)
  assert.deepEqual(input.catalog.entries[0].record, f.record)
  assert.equal(input.catalog.entries[0].metadata_complete, false)
  assert.equal(input.catalog.entries[0].files_complete, false)
  assert.equal(input.catalog.entries[0].legacy_mode, "unknown")
  assert.equal(input.catalog.entries[0].files[0].ownership, "unknown")
  assert.equal(input.catalog.entries[0].files[0].body, undefined)
  assert.deepEqual(input.catalog.coverage, f.catalogValue.coverage)
  assert.equal(input.preservation.pins.complete, false)
  assert.equal(input.preservation.pins.items.length, 2)
  assert.equal(input.preservation.pins.items[0].complete, false)
  assert.equal(input.preservation.pins.items[0].retention_verified, false)
  const candidate = input.preservation.pins.items[0].raw
  assert.equal(candidate.evidence_kind, "cached_snapshot_candidate")
  assert.equal(candidate.asserted_user_pin, false)
  assert.equal(candidate.cached_bytes_verified, true)
  assert.equal(candidate.backup_row.table, "snapshots")
  assert.equal(candidate.backup_row.manifest_sha256, sha(f.payloads[0]!))
  assert.deepEqual(candidate.backup_row.key, { id: "snapshot-a" })
  assert.equal(readFileSync(result.input, "utf8").includes("private-manifest-content"), false)
  assert.ok(readFileSync(result.input).length < f.payloads[0]!.length / 4)
  assert.deepEqual(
    input.preservation.operations.items.map((item: any) => item.raw),
    [f.command, f.upstream, f.integrity],
  )
  assert.ok(
    input.preservation.operations.items.every((item: any) => item.terminal_verified === false),
  )
  assert.equal(input.preservation.sources.complete, false)
  assert.equal(input.preservation.views.complete, false)
  assert.equal(input.preservation.routers.complete, false)
  assert.equal(summary.backup.database_verified, true)
  assert.equal(summary.backup.complete_object_pass, true)
  assert.equal(summary.objects.files_hashed, 2)
  assert.equal(summary.objects.references_checked, 4)
  assert.equal(summary.objects.cache_hits, 2)
  assert.equal(summary.snapshots.serialized_manifests_copied, 0)
  assert.equal(summary.operations.command_rows_excluded, 1)
  assert.ok(
    summary.source_options_requiring_review[0].paths.includes("$.input.source.external_assets"),
  )
  assert.ok(
    summary.source_options_requiring_review[0].paths.includes("$.input.source.external_markdown"),
  )
  assert.equal(summary.input.sha256, sha(readFileSync(result.input)))
  assert.equal(
    read(join(f.args.run, "source-fingerprints.json")).catalog.sha256,
    sha(readFileSync(f.catalog)),
  )
  for (const name of readdirSync(f.args.run))
    assert.equal(lstatSync(join(f.args.run, name)).mode & 0o777, 0o600)
  assert.equal(lstatSync(f.args.run).mode & 0o777, 0o700)
  assert.equal(sha(readFileSync(f.database)), databaseHash)
  assert.deepEqual(readdirSync(f.backup).sort(), databaseFiles)
  const repeated = collectMigrationInventory({ ...f.args, run: join(f.root, "another-run") })
  assert.equal(repeated.input_sha256, result.input_sha256)
})

test("database verification never substitutes for corrupt source_files bytes", () => {
  const f = fixture()
  writeFileSync(join(f.backup, "objects", f.sourceHash), "changed bytes")
  const result = collectMigrationInventory(f.args)
  const input = read(result.input)
  const summary = read(result.summary)
  assert.equal(summary.backup.database_verified, true)
  assert.equal(summary.backup.complete_object_pass, false)
  assert.equal(input.backup.verified, false)
  assert.equal(summary.objects.failed, 1)
  assert.ok(
    input.preservation.pins.items.every(
      (item: any) => item.raw.source_files_with_unverified_bytes === 1,
    ),
  )
  assert.ok(
    input.preservation.pins.items.every((item: any) => item.raw.cached_bytes_verified === false),
  )
})

test("a linked object cannot cause the collector to read outside the explicit backup", () => {
  const f = fixture()
  const outside = join(f.root, "outside-object")
  const outsideContent = "must not be read through a backup object link"
  writeFileSync(outside, outsideContent, { mode: 0o600 })
  const linkedHash = sha(outsideContent)
  symlinkSync(outside, join(f.backup, "objects", linkedHash))
  const db = new DatabaseSync(f.database)
  const manifest = {
    snapshot_id: "snapshot-link",
    scope: "old-scope",
    version_id: "v",
    record: f.record,
    files: [{ path: "linked.md", sha256: linkedHash, bytes: Buffer.byteLength(outsideContent) }],
  }
  db.prepare("INSERT INTO snapshots VALUES (?,?,?,?,?,?)").run(
    "snapshot-link",
    "old-scope",
    f.record.id,
    "v",
    JSON.stringify(manifest),
    JSON.stringify(f.record.locator),
  )
  db.close()
  const result = collectMigrationInventory(f.args)
  const object = readFileSync(join(f.args.run, "object-verification.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((item) => item.sha256 === linkedHash)
  assert.equal(object.verified, false)
  assert.equal(object.actual_sha256, undefined)
  assert.equal(read(result.summary).objects.files_hashed, 2)
  assert.equal(read(result.input).backup.verified, false)
})

test("existing runs, input overlap, relative paths and SQLite sidecars fail without overwriting evidence", () => {
  const f = fixture()
  mkdirSync(f.args.run)
  const sentinel = join(f.args.run, "keep")
  writeFileSync(sentinel, "original")
  assert.throws(
    () => collectMigrationInventory(f.args),
    (error) => error instanceof InventoryError && error.code === "RUN_NOT_FRESH",
  )
  assert.equal(readFileSync(sentinel, "utf8"), "original")
  assert.deepEqual(readdirSync(f.args.run), ["keep"])
  assert.throws(
    () => collectMigrationInventory({ ...f.args, run: join(f.backup, "forbidden-run") }),
    (error) => error instanceof InventoryError && error.code === "RUN_OVERLAPS_INPUT",
  )
  assert.throws(
    () => collectMigrationInventory({ ...f.args, catalog: "relative.json" }),
    (error) => error instanceof InventoryError && error.code === "ABSOLUTE_PATH_REQUIRED",
  )
  writeFileSync(`${f.database}-wal`, "unsettled")
  const blockedRun = join(f.root, "sidecar-run")
  assert.throws(
    () => collectMigrationInventory({ ...f.args, run: blockedRun }),
    (error) => error instanceof InventoryError && error.code === "BACKUP_HAS_SQLITE_SIDECAR",
  )
  assert.equal(read(join(blockedRun, "failure.json")).code, "BACKUP_HAS_SQLITE_SIDECAR")
  assert.equal(readdirSync(blockedRun).includes("input.json"), false)
})

test("arguments name every input explicitly and cannot silently override a previous flag", () => {
  const args = [
    "--catalog",
    "/explicit/catalog.json",
    "--backup",
    "/explicit/backup",
    "--target-library",
    "library",
    "--run",
    "/explicit/new-run",
  ]
  assert.deepEqual(parseInventoryArguments(args), {
    catalog: "/explicit/catalog.json",
    backup: "/explicit/backup",
    targetLibrary: "library",
    run: "/explicit/new-run",
  })
  assert.throws(() => parseInventoryArguments([...args, "--run", "/replacement"]))
  assert.throws(() => parseInventoryArguments(["--catalog", "/explicit/catalog.json"]))
})
