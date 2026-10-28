#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { parseArgs } from "node:util"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import {
  aliasFor,
  CoverageSchema,
  ContentRecordSchema,
  ContentKindSchema,
  notionPage,
  CatalogSourceSchema,
} from "../../../../packages/core/src/model.ts"
import {
  importDocument,
  importEntrypoint,
  importFiles,
} from "../../../../packages/core/src/import.ts"
import { BUNDLE, MANIFEST, readPortable } from "../../../../packages/core/src/portable.ts"

const consumptionFreshness = Schema.Struct({
  policy: Schema.String,
  validated_at: Schema.optional(Schema.String),
  age_ms: Schema.optional(Schema.Number),
  max_age_ms: Schema.optional(Schema.Number),
  stale: Schema.optional(Schema.Boolean),
})
const consumptionIdentity = {
  ok: Schema.Literal(true),
  scope: Schema.String,
  record: ContentRecordSchema,
  entrypoint: Schema.String,
  snapshot_id: Schema.String,
  version_id: Schema.String,
  ref: Schema.String,
  source: Schema.String,
  freshness: consumptionFreshness,
}
const consumptionCatalog = Schema.Struct({
  ok: Schema.Literal(true),
  scope: Schema.String,
  fetched_at: Schema.Number,
  databases: Schema.Array(CatalogSourceSchema),
  records: Schema.Array(ContentRecordSchema),
  count: Schema.Number,
  source: Schema.String,
  freshness: consumptionFreshness,
  coverage: CoverageSchema,
})
const consumptionRead = Schema.Struct({ ...consumptionIdentity, content: Schema.String })
const consumptionFiles = Schema.Struct({
  ...consumptionIdentity,
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, bytes: Schema.Number, ref: Schema.String }),
  ),
})
const consumptionExport = Schema.Struct({
  ...consumptionIdentity,
  operation: Schema.Literal("export"),
  format: Schema.Literal("directory"),
  output: Schema.String,
  reused: Schema.Boolean,
  content_id: Schema.String,
  main_path: Schema.String,
  projection: Schema.Literal("snapshot"),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      bytes: Schema.Number,
      hash: Schema.String,
      role: Schema.Literals(["manifest", "source_bundle", "entrypoint", "resource"]),
    }),
  ),
})
const consumptionManifest = Schema.Struct({
  format: Schema.Literal("ntn-skills"),
  version: Schema.Literal(2),
  kind: ContentKindSchema,
  name: Schema.String,
  description: Schema.String,
  main: Schema.String,
})
const consumptionFailure = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
})

const repo = resolve(fileURLToPath(new URL("../../../../", import.meta.url)))
const sourceLaunch = ["bun", join(repo, "scripts/dev.ts")]
const split = process.argv.indexOf("--", 2)
const { values, positionals } = parseArgs({
  args: process.argv.slice(2, split < 0 ? undefined : split),
  options: {
    help: { type: "boolean", short: "h" },
    live: { type: "boolean" },
    run: { type: "string" },
    plan: { type: "string" },
    database: { type: "string" },
    target: { type: "string" },
    "installed-bin": { type: "string" },
    input: { type: "string", multiple: true },
  },
  allowPositionals: true,
  strict: true,
})
const usage =
  "Usage: bun .cursor/skills/verify-ntn-skills/scripts/control.ts MODE --run ABSOLUTE_DIRECTORY [--live] [--plan ABSOLUTE_JSON] [-- CLI_ARGS]\nModes: init, doctor, cli, package, consumption, prepare, import, verify, reuse, cleanup\nDoctor is offline by default; --live explicitly runs the official Notion doctor. Help never initializes a run or starts a child."
if (values.help || positionals[0] === "help") {
  console.log(usage)
  process.exit(0)
}
const mode = positionals[0]
if (positionals.length !== 1 || !values.run || !isAbsolute(values.run)) throw new Error(usage)
const root = resolve(values.run)
const scratch = join(root, "scratch")
const evidence = join(root, "evidence")
const marker = join(root, "verification-run.json")
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
async function save(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
}
async function load(path: string) {
  return JSON.parse(await readFile(path, "utf8"))
}
async function exists(path: string) {
  return Bun.file(path).exists()
}
async function trash(path: string) {
  if (process.platform !== "darwin")
    throw new Error(
      "Automatic cleanup requires verified macOS /usr/bin/trash; preserve scratch on other hosts until a recycle-bin command is verified.",
    )
  await access("/usr/bin/trash", constants.X_OK)
  const child = Bun.spawn(["/usr/bin/trash", path], { stdout: "pipe", stderr: "pipe" })
  const [, , exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exit) throw new Error("System trash operation failed; scratch was retained.")
}
const env: Record<string, string | undefined> & {
  NTN_SKILLS_CONFIG_HOME: string
  NTN_SKILLS_HOME: string
  NTN_SKILLS_CACHE_HOME: string
  NTN_SKILLS_DATA_HOME: string
} = {
  ...process.env,
  NTN_SKILLS_CONFIG_HOME: join(scratch, "config"),
  NTN_SKILLS_HOME: join(scratch, "state"),
  NTN_SKILLS_CACHE_HOME: join(scratch, "cache"),
  NTN_SKILLS_DATA_HOME: join(scratch, "data"),
  XDG_CONFIG_HOME: join(scratch, "xdg", "config"),
  XDG_STATE_HOME: join(scratch, "xdg", "state"),
  XDG_CACHE_HOME: join(scratch, "xdg", "cache"),
  XDG_DATA_HOME: join(scratch, "xdg", "data"),
}
// Use the official transport; personal configuration and temporary transports are excluded.
delete env.NTN_SKILLS_NTN_BIN
async function command(args: string[], cwd = repo, childEnv = env) {
  if (args.includes("set-token") || args.some((arg) => /^(?:Bearer |secret_|ntn_)/.test(arg)))
    throw new Error("Do not pass credentials to the verification harness.")
  const record = join(evidence, "commands", `${Date.now()}-${randomUUID()}.json`)
  const started = new Date().toISOString()
  const child = Bun.spawn(args, {
    cwd,
    env: childEnv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let timeout = false
  let escalation: NodeJS.Timeout | undefined
  const timer = setTimeout(
    () => {
      timeout = true
      child.kill()
      escalation = setTimeout(() => child.kill("SIGKILL"), 2_000)
    },
    15 * 60 * 1000,
  )
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    let output: unknown
    try {
      output = JSON.parse(stdout)
    } catch {
      output = stdout
    }
    await save(record, {
      command: args,
      cwd,
      started,
      finished: new Date().toISOString(),
      exit,
      pid: child.pid,
      signal: child.signalCode,
      observed_exit: true,
      timeout,
      output:
        args[0] === "ntn" && output && typeof output === "object"
          ? {
              ...output,
              ...("results" in output && Array.isArray(output.results)
                ? {
                    results: output.results.map((row: any) => ({
                      id: row.id,
                      type: row.type,
                      ...(row.child_page ? { child_page: row.child_page } : {}),
                    })),
                  }
                : {}),
            }
          : output,
      stderr: {
        bytes: Buffer.byteLength(stderr),
        sha256: digest(Buffer.from(stderr)),
        raw_retained: false,
      },
    })
    return { output: output as any, exit, record }
  } finally {
    clearTimeout(timer)
    clearTimeout(escalation)
  }
}
async function cli(args: string[]) {
  const result = await command([...sourceLaunch, ...args])
  if (result.exit || result.output?.ok !== true)
    throw new Error(`CLI failed; inspect ${result.record}`)
  return result.output
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
type Entry = {
  name: string
  input: string
  files: string[]
  file_hashes: { path: string; sha256: string; bytes: number }[]
}
type Plan = { database: string; entries: Entry[] }
async function plan(): Promise<Plan> {
  check(values.plan && isAbsolute(values.plan), "Live modes require --plan ABSOLUTE_JSON")
  const selected = await load(values.plan)
  check(
    typeof selected.database === "string" &&
      Array.isArray(selected.entries) &&
      selected.entries.length > 0,
    "Invalid import plan",
  )
  const names = new Set<string>()
  for (const entry of selected.entries as Entry[]) {
    check(
      typeof entry.name === "string" &&
        /^[a-z]+(?:-[a-z]+)*$/.test(entry.name) &&
        !names.has(entry.name) &&
        isAbsolute(entry.input),
      "Invalid/duplicate entry or non-absolute input",
    )
    names.add(entry.name)
    check(
      Array.isArray(entry.files) &&
        Array.isArray(entry.file_hashes) &&
        JSON.stringify(entry.files.toSorted()) ===
          JSON.stringify(entry.file_hashes.map((file) => file.path).toSorted()),
      "Plan file set differs from its hashes",
    )
    for (const file of entry.file_hashes) {
      const path = resolve(entry.input, file.path)
      check(
        !isAbsolute(file.path) && !relative(entry.input, path).startsWith(".."),
        "Unsafe source path",
      )
      const bytes = await readFile(path)
      check(
        bytes.length === file.bytes && digest(bytes) === file.sha256,
        `Frozen input changed: ${entry.name}/${file.path}`,
      )
    }
  }
  const recordedPlan = join(evidence, "plan.json")
  if (await exists(recordedPlan)) {
    const previous = await load(recordedPlan)
    check(
      previous.database === selected.database &&
        JSON.stringify(
          previous.entries.map(({ name, input, files, file_hashes }: Entry) => ({
            name,
            input,
            files,
            file_hashes,
          })),
        ) ===
          JSON.stringify(
            selected.entries.map(({ name, input, files, file_hashes }: Entry) => ({
              name,
              input,
              files,
              file_hashes,
            })),
          ),
      "Plan changed within this run; use a new run",
    )
  }
  await save(join(evidence, "plan.json"), {
    database: selected.database,
    entries: selected.entries.map(({ name, input, files, file_hashes }: Entry) => ({
      name,
      input,
      files,
      file_hashes,
    })),
  })
  return selected
}
async function receipts() {
  return (await exists(join(evidence, "imports.json")))
    ? await load(join(evidence, "imports.json"))
    : []
}
async function online(id: string) {
  return cli(["files", id, "--refresh"])
}
async function children(id: string) {
  const output: any[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  do {
    const path = `v1/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`
    const result = await command([
      "ntn",
      "api",
      path,
      "--notion-version",
      "2026-03-11",
      "-X",
      "GET",
    ])
    check(
      result.exit === 0 && Array.isArray(result.output.results),
      `Child-page inspection failed: ${result.record}`,
    )
    output.push(...result.output.results)
    if (!result.output.has_more) break
    check(
      typeof result.output.next_cursor === "string" && !seen.has(result.output.next_cursor),
      "Invalid child-page pagination",
    )
    cursor = result.output.next_cursor
    seen.add(cursor!)
  } while (cursor)
  return output
    .filter((row) => row.type === "child_page")
    .map((row) => ({ id: row.id, title: row.child_page.title }))
}
async function main() {
  if (mode === "init") {
    check(!(await exists(marker)), "Run already exists; choose a new directory")
    await mkdir(root, { recursive: true, mode: 0o700 })
    check(
      !(await lstat(root)).isSymbolicLink() && (await readdir(root)).length === 0,
      "Verification run must be an empty owned directory without symlinks",
    )
    await chmod(root, 0o700)
    await mkdir(env.NTN_SKILLS_CONFIG_HOME, { recursive: true, mode: 0o700 })
    await mkdir(env.NTN_SKILLS_HOME, { recursive: true, mode: 0o700 })
    await mkdir(env.NTN_SKILLS_CACHE_HOME, { recursive: true, mode: 0o700 })
    await mkdir(env.NTN_SKILLS_DATA_HOME, { recursive: true, mode: 0o700 })
    await mkdir(join(scratch, "builtin-home"), { recursive: true, mode: 0o700 })
    await mkdir(evidence, { recursive: true, mode: 0o700 })
    await save(marker, { repo, root, scratch, evidence, created: new Date().toISOString() })
    return { ready: true, run: root, evidence }
  }
  check(await exists(marker), "Run init first")
  const identity = await load(marker)
  check(
    identity.repo === repo && identity.root === root && identity.scratch === scratch,
    "Run ownership differs",
  )
  if (mode === "cleanup") {
    const logs = await readdir(join(evidence, "commands")).catch(() => [])
    const temporary = new Set<string>()
    for (const file of logs) {
      const record = await load(join(evidence, "commands", file))
      if (record.command[1] === "scripts/package-check.ts" && record.output?.scratch) {
        temporary.add(record.output.scratch)
        if (record.output.smoke?.scratch) temporary.add(record.output.smoke.scratch)
      }
    }
    for (const path of temporary) {
      check(
        isAbsolute(path) && /\/ntn-skills-(?:pack|consumer)-[^/]+$/.test(path),
        "Refusing unrecognized package scratch",
      )
      await trash(path)
    }
    try {
      await realpath(scratch)
      await trash(scratch)
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error
    }
    await save(join(evidence, "cleanup.json"), {
      local_scratch_trashed: true,
      package_scratch_trashed: [...temporary],
      remote_skills_retained: true,
      evidence_retained: true,
    })
    check(
      (await exists(marker)) && (await exists(join(evidence, "cleanup.json"))),
      "Cleanup lost evidence",
    )
    return { cleaned: true, evidence }
  }
  check(
    (await realpath(scratch)) === join(await realpath(root), "scratch"),
    "Scratch directory must belong to this run and not be a symlink",
  )
  if (mode === "doctor") {
    const entry = join(repo, "packages/cli/dist/ntn-skills.js")
    const version = await command([...sourceLaunch, "--version"])
    const help = await command([...sourceLaunch, "--help"])
    check(
      version.exit === 0 && help.exit === 0,
      "Offline CLI readiness failed; inspect command evidence",
    )
    const result = {
      ready: true,
      mode: values.live ? "live" : "offline",
      authentication: values.live ? "probed by official Notion doctor" : "not probed",
      entry: { path: entry, sha256: digest(await readFile(entry)) },
      source: {
        path: join(repo, "packages/cli/src/main.ts"),
        sha256: digest(await readFile(join(repo, "packages/cli/src/main.ts"))),
      },
      version: version.output,
      scope: {
        config: env.NTN_SKILLS_CONFIG_HOME,
        state: env.NTN_SKILLS_HOME,
        cache: env.NTN_SKILLS_CACHE_HOME,
        data: env.NTN_SKILLS_DATA_HOME,
      },
      ...(values.live ? { live: await cli(["ctl", "doctor"]) } : {}),
    }
    await save(join(evidence, "doctor.json"), result)
    return result
  }
  if (mode === "cli") {
    check(split >= 0 && process.argv.length > split + 1, "cli requires -- CLI_ARGS")
    const cliArgs = process.argv.slice(split + 1)
    // Offline builtin commands isolate native Skill roots; publish retains HOME for official ntn login.
    // Both paths always use the scratch application and XDG data roots above.
    const childEnv =
      cliArgs[0] === "ctl" &&
      cliArgs[1] === "builtin" &&
      ["list", "read", "export", "status", "install", "update"].includes(cliArgs[2] ?? "")
        ? { ...env, HOME: join(scratch, "builtin-home") }
        : env
    const result = await command([...sourceLaunch, ...cliArgs], repo, childEnv)
    return { exit: result.exit, evidence: result.record, output: result.output }
  }
  if (mode === "package") {
    const result = await command(["bun", "scripts/package-check.ts"])
    check(
      result.exit === 0 &&
        result.output.smoke?.checks?.includes("complete_pinned_snapshot_unchanged") &&
        result.output.smoke?.checks?.includes("builtin_offline_catalog_and_provenance") &&
        result.output.smoke?.checks?.includes("builtin_main_reference_export_bytes") &&
        result.output.smoke?.checks?.includes(
          "builtin_three_skill_installation_and_reference_bytes",
        ) &&
        result.output.smoke?.checks?.includes(
          "builtin_independent_receipts_and_modified_sibling_isolation",
        ) &&
        result.output.smoke?.checks?.includes("builtin_copied_entrypoint_not_adopted") &&
        result.output.smoke?.checks?.includes("builtin_export_reuse_and_customization_conflict") &&
        result.output.smoke?.checks?.includes("builtin_exact_id_and_remote_name_isolation") &&
        result.output.smoke?.checks?.includes(
          "seeded_offline_current_read_open_files_export_list",
        ) &&
        result.output.smoke?.checks?.includes("broker_metadata_only_discovery") &&
        result.output.smoke?.checks?.includes("broker_list_selected_pinned_activation") &&
        result.output.smoke?.checks?.includes("broker_pinned_directory_manifest_bytes_identity") &&
        result.output.smoke?.checks?.includes(
          "broker_directory_reuse_and_conflict_preserves_bytes",
        ) &&
        result.output.smoke?.checks?.includes("broker_portable_workflow_entrypoint") &&
        result.output.smoke?.checks?.includes("synthetic_same_user_credential_scope_isolation") &&
        result.output.smoke?.checks?.includes(
          "public_token_stdin_saved_config_environment_precedence",
        ),
      `Package smoke failed: ${result.record}`,
    )
    const retainArchive = async (path: string, integrity: string) => {
      const archive = await readFile(path)
      check(
        `sha512-${createHash("sha512").update(archive).digest("base64")}` === integrity,
        "Package archive integrity differs",
      )
      const retained = join(evidence, "package", path.split(/[\\/]/).at(-1)!)
      await mkdir(dirname(retained), { recursive: true, mode: 0o700 })
      await writeFile(retained, archive, { mode: 0o600 })
      return retained
    }
    const retained = await retainArchive(result.output.archive, result.output.integrity)
    const retainedMigration = await retainArchive(
      result.output.migration_archive,
      result.output.migration_integrity,
    )
    const consumerEvidence = join(evidence, "installed-consumer.json")
    await writeFile(consumerEvidence, await readFile(result.output.smoke.evidence), { mode: 0o600 })
    result.output.consumer_evidence = consumerEvidence
    result.output.retained_archive = retained
    result.output.retained_migration_archive = retainedMigration
    await save(join(evidence, "package.json"), result.output)
    return { checked: true, evidence: result.record, checks: result.output.smoke.checks }
  }
  if (mode === "consumption") {
    check(values.database, "consumption requires an explicit --database selector")
    const installed = values["installed-bin"]
    if (installed) {
      check(isAbsolute(installed), "--installed-bin must be an absolute installed JavaScript bin")
      const manifest = Schema.decodeUnknownSync(
        Schema.Struct({
          name: Schema.String,
          bin: Schema.Record(Schema.String, Schema.String),
        }),
      )(await load(join(dirname(dirname(installed)), "package.json")))
      check(
        manifest.name === "ntn-skills" &&
          resolve(dirname(dirname(installed)), manifest.bin?.["ntn-skills"] ?? "") ===
            resolve(installed),
        "--installed-bin must be the npm ntn-skills package's declared bin",
      )
    }
    const label = installed ? "installed" : "source"
    const launch = installed ? ["node", installed] : sourceLaunch
    const drive = async (args: string[], expectedExit = 0) => {
      const result = await command([...launch, ...args])
      check(result.exit === expectedExit, `Unexpected CLI exit; inspect ${result.record}`)
      check(
        result.output?.ok === (expectedExit === 0),
        `Unexpected CLI JSON; inspect ${result.record}`,
      )
      return result.output as unknown
    }
    const catalog = Schema.decodeUnknownSync(consumptionCatalog)(
      await drive(["list", "--database", values.database, "--refresh"]),
    )
    check(
      typeof catalog.scope === "string" &&
        catalog.scope.length > 0 &&
        catalog.freshness &&
        catalog.coverage?.exhaustive === true &&
        catalog.coverage.search_index_limited === false &&
        catalog.coverage.failed_sources.length === 0 &&
        catalog.count === catalog.records.length,
      "Discovery must retain scope, freshness and complete explicit-database coverage",
    )
    for (const row of catalog.records)
      check(
        row.id &&
          ((row.locator.type === "notion_page" &&
            row.locator.page_id &&
            row.id === `notion_page:${row.locator.page_id}`) ||
            (row.locator.type === "notion_subscription" &&
              row.kind === "router" &&
              row.entrypoint === "ROUTER.md" &&
              row.locator.subscription_id &&
              row.locator.target_database_id &&
              row.id === `notion_subscription:${row.locator.subscription_id}`)) &&
          row.locator.database_id &&
          row.locator.data_source_id &&
          row.ref &&
          !("content" in row) &&
          !("body" in row) &&
          !("files" in row) &&
          !("snapshot_id" in row) &&
          !("manifest" in row),
        "Catalog must expose Notion page or subscription Router identities without activation content",
      )
    const skills = catalog.records.map((row) => Schema.decodeUnknownSync(ContentRecordSchema)(row))
    const selected = values.target
      ? skills.find(
          (row) =>
            row.id === values.target ||
            row.ref === values.target ||
            (row.locator.type === "notion_page" && row.locator.page_id === values.target),
        )
      : skills[0]
    check(selected, "No selected page ID in scoped catalog; supply an accessible database/--target")
    const activation = Schema.decodeUnknownSync(consumptionRead)(
      await drive(["read", selected.ref, "--database", values.database, "--refresh"]),
    )
    check(
      activation.scope === catalog.scope &&
        activation.record.id === selected.id &&
        activation.content.length > 0 &&
        activation.source === "notion" &&
        activation.freshness &&
        activation.snapshot_id.startsWith("s_") &&
        activation.version_id &&
        new URL(activation.ref).searchParams.get("snapshot") === activation.snapshot_id,
      "Activation must return selected page identity, complete instructions and pinned snapshot",
    )
    const files = Schema.decodeUnknownSync(consumptionFiles)(
      await drive(["files", activation.snapshot_id, "--offline"]),
    )
    const output = join(evidence, `consumption-${label}-directory`)
    const args = [
      "export",
      activation.snapshot_id,
      "--offline",
      "--projection",
      "snapshot",
      "--format",
      "directory",
      "--output",
      output,
    ]
    const exported = Schema.decodeUnknownSync(consumptionExport)(await drive(args))
    const rawManifest: unknown = await load(join(output, ".ntn-skills.json"))
    check(
      typeof rawManifest === "object" &&
        rawManifest !== null &&
        !("snapshot_id" in rawManifest) &&
        !("version_id" in rawManifest) &&
        !("page_id" in rawManifest) &&
        !("scope" in rawManifest),
      "Portable manifest must exclude local identities and credential scope",
    )
    const manifest = Schema.decodeUnknownSync(consumptionManifest)(rawManifest)
    check(
      exported.operation === "export" &&
        exported.format === "directory" &&
        exported.source === "local_snapshot" &&
        exported.freshness.policy === "pinned" &&
        exported.scope === activation.scope &&
        exported.record.id === selected.id &&
        exported.snapshot_id === activation.snapshot_id &&
        exported.version_id === activation.version_id &&
        manifest.format === "ntn-skills" &&
        manifest.version === 2 &&
        manifest.kind === exported.record.kind &&
        manifest.main === exported.main_path &&
        exported.entrypoint === activation.entrypoint &&
        exported.main_path === activation.entrypoint &&
        exported.projection === "snapshot",
      "Directory export must retain fixed identities and portable manifest entrypoint",
    )
    const hashes = async (directory: string) => {
      const inventory = []
      for (const path of (await readdir(directory, { recursive: true })).sort()) {
        if (!(await lstat(join(directory, path))).isFile()) continue
        const bytes = await readFile(join(directory, path))
        inventory.push({ path, bytes: bytes.length, sha256: digest(bytes) })
      }
      return inventory
    }
    const inventory = await hashes(output)
    const entry = join(output, exported.main_path)
    check(
      !isAbsolute(exported.main_path) &&
        relative(output, resolve(entry)).split(/[\\/]/)[0] !== ".." &&
        (await readFile(entry, "utf8")) === activation.content &&
        exported.files.length === inventory.length &&
        exported.files.every(
          (file) =>
            inventory.some(
              (actual) =>
                actual.path === file.path &&
                actual.bytes === file.bytes &&
                actual.sha256 === file.hash,
            ) &&
            file.role ===
              (file.path === MANIFEST
                ? "manifest"
                : file.path === BUNDLE
                  ? "source_bundle"
                  : file.path === exported.entrypoint
                    ? "entrypoint"
                    : "resource"),
        ),
      "Export main_path and reported files must be actual materialized files",
    )
    check(
      files.files
        .filter((file) => file.path !== ".ntn-skills.json")
        .every((file) =>
          exported.files.some((actual) => actual.path === file.path && actual.bytes === file.bytes),
        ),
      "Snapshot export omitted or changed a pinned file",
    )
    for (const file of files.files)
      check(
        new URL(file.ref).searchParams.get("snapshot") === activation.snapshot_id,
        "Supporting file reference lost activation snapshot",
      )
    const reused = Schema.decodeUnknownSync(consumptionExport)(await drive(args))
    check(
      reused.reused === true &&
        reused.content_id === exported.content_id &&
        JSON.stringify(await hashes(output)) === JSON.stringify(inventory),
      "Repeated export must reuse identical directory without changing bytes",
    )
    const conflictOutput = join(scratch, `consumption-${label}-conflict`)
    const conflictArgs = [...args.slice(0, -1), conflictOutput]
    await drive(conflictArgs)
    await writeFile(join(conflictOutput, exported.main_path), "owned output conflict fixture\n")
    const beforeConflict = await hashes(conflictOutput)
    const conflict = Schema.decodeUnknownSync(consumptionFailure)(await drive(conflictArgs, 1))
    check(
      conflict.error.code === "OUTPUT_CONFLICT" &&
        JSON.stringify(await hashes(conflictOutput)) === JSON.stringify(beforeConflict),
      "Output conflict must preserve every occupied file",
    )
    const pinned = Schema.decodeUnknownSync(consumptionRead)(
      await drive(["read", activation.ref, "--offline"]),
    )
    check(
      pinned.content === activation.content &&
        pinned.source === "local_snapshot" &&
        pinned.snapshot_id === activation.snapshot_id &&
        pinned.freshness.policy === "pinned",
      "Offline pinned read must retain selected activation instructions and identities",
    )
    const summary = {
      proof: "live-read-only-cli-consumption",
      runtime: label,
      executable: launch,
      catalog,
      activation,
      files,
      exported,
      manifest,
      inventory,
      main_path: entry,
      reused,
      conflict,
      pinned,
      remote_writes: false,
      credential_scope_isolation: "See seeded installed-consumer smoke; not exercised by live mode",
    }
    const path = join(evidence, `consumption-${label}.json`)
    await save(path, summary)
    return { consumed: true, evidence: path, snapshot_id: activation.snapshot_id, main_path: entry }
  }
  if (mode === "prepare") {
    check(
      values.database && values.input?.length,
      "prepare requires --database and one or more --input directories",
    )
    const entries: Entry[] = []
    for (const input of values.input) {
      const directory = await realpath(resolve(input))
      const inputFiles = []
      const files: string[] = []
      for (const name of await readdir(directory, { recursive: true })) {
        const metadata = await lstat(join(directory, name))
        check(!metadata.isSymbolicLink(), "Skill source must not contain symbolic links")
        if (metadata.isFile()) {
          const path = name.split("\\").join("/")
          inputFiles.push({ path, bytes: await readFile(join(directory, name)) })
          if (path !== ".ntn-skills.json") files.push(path)
        }
      }
      files.sort()
      const file_hashes = []
      for (const path of files) {
        const bytes = await readFile(join(directory, path))
        file_hashes.push({ path, bytes: bytes.length, sha256: digest(bytes) })
      }
      const portable = readPortable(importFiles(inputFiles))
      const main = portable
        ? portable.files.find((file) => file.path === portable.main)!
        : importEntrypoint(inputFiles).main
      const metadata = importDocument(
        main,
        portable ? { name: portable.name, description: portable.description } : {},
      )
      const name = aliasFor(metadata.name)
      const catalog = Schema.decodeUnknownSync(consumptionCatalog)(
        await cli(["list", "--database", values.database, "--refresh"]),
      )
      const existing = catalog.records
        .map((row) => Schema.decodeUnknownSync(ContentRecordSchema)(row))
        .filter((row) => row.alias === name)
      check(existing.length <= 1, `Ambiguous import target: ${name}`)
      const target = existing[0]
      const dry = await cli([
        ...(target
          ? ["replace", directory, "--target", notionPage(target).locator.page_id]
          : ["create", directory]),
        "--database",
        values.database,
        "--dry-run",
      ])
      check(
        dry.input_type === "directory",
        "prepare accepts Skill directories; drive single Markdown/ZIP paths with cli mode",
      )
      check(!entries.some((entry) => entry.name === name), `Duplicate invocation: ${name}`)
      entries.push({ name, input: directory, files, file_hashes })
    }
    const output = join(evidence, "plan.json")
    await save(output, { database: values.database, entries })
    return { prepared: entries.length, plan: output }
  }
  const selected = await plan()
  if (mode === "import") {
    const imported = await receipts()
    for (const entry of selected.entries) {
      if (imported.some((row: any) => row.name === entry.name && row.result?.verified)) continue
      const before = await cli(["list", "--database", selected.database, "--refresh"])
      const existing = before.records.filter((row: any) => row.alias === entry.name)
      check(existing.length <= 1, `Ambiguous import target: ${entry.name}`)
      const baseline = existing.length ? await online(existing[0].ref) : undefined
      const publication = [
        ...(baseline
          ? ["replace", entry.input, "--target", notionPage(baseline.record).locator.page_id]
          : ["create", entry.input]),
        "--database",
        selected.database,
      ]
      const dry = await cli([...publication, "--dry-run"])
      const after = await cli(["list", "--database", selected.database, "--refresh"])
      check(
        JSON.stringify(before.records) === JSON.stringify(after.records),
        `Dry-run changed remote catalog: ${entry.name}`,
      )
      if (baseline)
        check(
          (await online(baseline.record.ref)).version_id === baseline.version_id,
          `Dry-run changed remote content: ${entry.name}`,
        )
      await save(join(evidence, `${entry.name}-dry-run.json`), {
        result: dry,
        remote_catalog_unchanged: true,
        remote_version_unchanged: Boolean(baseline),
        network_reads_expected: true,
      })
      const result = await cli(publication)
      check(
        result.verified && result.record.alias === entry.name,
        `Import identity failed: ${entry.name}`,
      )
      imported.push({ name: entry.name, result })
      await save(join(evidence, "imports.json"), imported)
      console.log(
        JSON.stringify({
          imported: entry.name,
          action: result.action,
          files: result.files.length,
          page_id: notionPage(result.record).locator.page_id,
        }),
      )
    }
    return { imported: imported.length, evidence }
  }
  const imported = await receipts()
  check(
    selected.entries.every((entry) =>
      imported.some((row: any) => row.name === entry.name && row.result?.verified),
    ),
    "Imports incomplete",
  )
  if (mode === "verify") {
    const verified = (await exists(join(evidence, "verification.json")))
      ? await load(join(evidence, "verification.json"))
      : []
    for (const entry of selected.entries) {
      if (verified.some((row: any) => row.name === entry.name)) continue
      const first = imported.find((row: any) => row.name === entry.name).result
      const snapshot = await online(first.record.ref)
      check(
        snapshot.version_id === first.version_id &&
          snapshot.record.alias === entry.name &&
          notionPage(snapshot.record).locator.database_id === selected.database,
        `Remote import changed: ${entry.name}`,
      )
      // Snapshot manifests remain immutable files; mutable state is owned by the CLI's SQL store.
      const cached = await load(
        join(env.NTN_SKILLS_HOME, "snapshots", `${snapshot.snapshot_id}.json`),
      )
      const refs = entry.files.filter(
        (path) => path.startsWith("references/") && /\.md$/i.test(path),
      )
      check(
        JSON.stringify(
          cached.references
            .slice(1)
            .map((page: any) => page.path)
            .sort(),
        ) === JSON.stringify(refs.toSorted()),
        `Reference paths differ: ${entry.name}`,
      )
      const actualChildren = await children(notionPage(snapshot.record).locator.page_id)
      check(
        JSON.stringify(actualChildren.map((page: any) => page.id).sort()) ===
          JSON.stringify(
            cached.references
              .slice(1)
              .map((page: any) => page.id)
              .sort(),
          ),
        `Duplicate/missing child pages: ${entry.name}`,
      )
      await save(join(evidence, `${entry.name}-children.json`), actualChildren)
      const expectedSnapshot = [...entry.files, "ntn-skills-source.zip"].sort()
      check(
        JSON.stringify(snapshot.files.map((file: any) => file.path).sort()) ===
          JSON.stringify(expectedSnapshot),
        `Snapshot files differ: ${entry.name}`,
      )
      const destination = join(evidence, "exported", entry.name)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      const exported = await cli(["export", snapshot.ref, "--output", destination])
      check(
        JSON.stringify(
          exported.files
            .map((file: any) => file.path)
            .filter((path: string) => path !== ".ntn-skills.json")
            .sort(),
        ) === JSON.stringify(entry.files.toSorted()),
        `Export set differs: ${entry.name}`,
      )
      for (const file of entry.file_hashes)
        check(
          digest(await readFile(join(destination, file.path))) === file.sha256,
          `Export bytes differ: ${entry.name}/${file.path}`,
        )
      for (const path of ["SKILL.md", ...refs]) {
        const result =
          path === "SKILL.md"
            ? await cli(["read", snapshot.ref])
            : await cli(["read", path, "--from", snapshot.ref])
        const file = cached.files.find((file: any) => file.path === path)
        check(
          result.source === "local_snapshot" &&
            result.snapshot_id === snapshot.snapshot_id &&
            digest(Buffer.from(result.content)) === file.sha256,
          `Pinned read differs: ${entry.name}/${path}`,
        )
      }
      const asset = entry.files.find(
        (path) => /^(scripts|assets|evals)\//.test(path) || path === "SKILL.zh_CN.md",
      )
      if (asset) {
        const output = join(evidence, "read-assets", entry.name, asset)
        await mkdir(dirname(output), { recursive: true, mode: 0o700 })
        await cli(["read", snapshot.ref.replace("/SKILL.md?", `/${asset}?`), "--output", output])
        check(
          digest(await readFile(output)) ===
            entry.file_hashes.find((file) => file.path === asset)!.sha256,
          `Asset read differs: ${entry.name}/${asset}`,
        )
      }
      verified.push({
        name: entry.name,
        page_id: notionPage(snapshot.record).locator.page_id,
        url: `https://www.notion.so/${notionPage(snapshot.record).locator.page_id.replaceAll("-", "")}`,
        snapshot_id: snapshot.snapshot_id,
        version_id: snapshot.version_id,
        ref: snapshot.ref,
        files: entry.files.length,
        references: refs.length,
        child_pages: actualChildren.length,
        source_bytes_preserved: true,
        content_id: exported.content_id,
        official_transport: true,
      })
      await save(join(evidence, "verification.json"), verified)
      console.log(
        JSON.stringify({
          verified: entry.name,
          files: entry.files.length,
          references: refs.length,
        }),
      )
    }
    return { verified: verified.length, evidence }
  }
  if (mode === "reuse") {
    const verified = await load(join(evidence, "verification.json"))
    check(verified.length === selected.entries.length, "Consumer verification incomplete")
    const repeated = (await exists(join(evidence, "reimports.json")))
      ? await load(join(evidence, "reimports.json"))
      : []
    for (const entry of selected.entries) {
      if (repeated.some((row: any) => row.name === entry.name)) continue
      const first = verified.find((row: any) => row.name === entry.name)
      const result = await cli([
        "replace",
        entry.input,
        "--target",
        first.page_id,
        "--database",
        selected.database,
      ])
      check(
        result.action === "reuse" &&
          result.reused &&
          result.verified &&
          notionPage(result.record).locator.page_id === first.page_id &&
          result.snapshot_id === first.snapshot_id,
        `Reimport changed identity/content: ${entry.name}`,
      )
      repeated.push({
        name: entry.name,
        page_id: notionPage(result.record).locator.page_id,
        snapshot_id: result.snapshot_id,
        action: result.action,
        reused: true,
      })
      await save(join(evidence, "reimports.json"), repeated)
      console.log(
        JSON.stringify({ reused: entry.name, page_id: notionPage(result.record).locator.page_id }),
      )
    }
    const catalog = await cli(["list", "--database", selected.database, "--refresh"])
    check(
      catalog.coverage.exhaustive && !catalog.coverage.failed_sources.length,
      "Catalog coverage incomplete",
    )
    for (const entry of selected.entries)
      check(
        catalog.records.filter((row: any) => row.alias === entry.name).length === 1,
        `Duplicate/missing skill: ${entry.name}`,
      )
    await save(join(evidence, "final-catalog.json"), catalog)
    const summary = {
      complete: true,
      database: selected.database,
      imported: imported.length,
      file_count: verified.reduce((n: number, row: any) => n + row.files, 0),
      reference_count: verified.reduce((n: number, row: any) => n + row.references, 0),
      verified,
      repeated_imports: repeated,
      transport:
        "canonical scripts/dev.ts fresh build followed by Node.js CLI with default official ntn; isolated config and state",
    }
    await save(join(evidence, "summary.json"), summary)
    return summary
  }
  throw new Error(`Unknown mode: ${mode}`)
}
try {
  console.log(JSON.stringify(await main()))
} catch (error) {
  if (await exists(marker)) {
    await save(join(evidence, "failure.json"), {
      mode,
      message: error instanceof Error ? error.message : "Verification failed",
      at: new Date().toISOString(),
    })
    console.error(
      `Verification failed; evidence retained at ${evidence}. Run cleanup after the failed attempt, then use a new run for a corrected attempt.`,
    )
  } else console.error(error instanceof Error ? error.message : "Verification failed")
  process.exitCode = 1
}
