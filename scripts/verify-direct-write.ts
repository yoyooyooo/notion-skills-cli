/** Owned public-CLI acceptance. Preserve this run after any failure; never restart it. */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  options: {
    cli: { type: "string" },
    node: { type: "string", default: "node" },
    entry: { type: "string" },
    run: { type: "string" },
    "legacy-database": { type: "string" },
    "resume-operation": { type: "string" },
    help: { type: "boolean" },
  },
})
if (values.help) {
  console.log(
    "bun scripts/verify-direct-write.ts --cli /ABS/INSTALLED/dist/ntn-skills.js --node /ABS/node --entry SKILLS_DB_UUID --run /ABS/RUN [--legacy-database AUTHORIZED_REFERENCES_DB_UUID] [--resume-operation ORIGINAL_NATIVE_CREATE_OPERATION]",
  )
  process.exit(0)
}
assert.ok(
  values.cli && isAbsolute(values.cli),
  "--cli must name the built or independently installed public CLI",
)
assert.ok(values.run && isAbsolute(values.run), "--run must be a new absolute evidence directory")
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value)
assert.ok(uuid(values.entry), "--entry must be the explicitly authorized Skills database UUID")
if (values["legacy-database"])
  assert.ok(uuid(values["legacy-database"]), "Use an exact authorized legacy fixture database UUID")
const entry = values.entry
const node = values.node ?? "node"
const cli = await realpath(values.cli)
const run = resolve(values.run)
await mkdir(run, { recursive: true, mode: 0o700 })
const manifestPath = join(run, "manifest.json")
type Manifest = {
  version: number
  marker: string
  cli: string
  cli_sha256: string
  entry: string
  legacy_database: string | null
  started_at: string
  status: string
  commands: Array<{
    number: number
    phase: string
    argv: string[]
    exit_code?: number | null
    milliseconds?: number
  }>
  result?: unknown
  failure?: string
  finished_at?: string
  resumptions?: Array<{
    at: string
    cli: string
    cli_sha256: string
    original_operation_id: string
    original_page_id: string
  }>
}
const previous: Manifest | undefined = values["resume-operation"]
  ? JSON.parse(await readFile(manifestPath, "utf8"))
  : undefined
const marker = previous?.marker ?? `AH564_${randomUUID().replaceAll("-", "")}`
const manifest: Manifest = previous ?? {
  version: 1,
  marker,
  cli,
  cli_sha256: createHash("sha256")
    .update(await readFile(cli))
    .digest("hex"),
  entry,
  legacy_database: values["legacy-database"] ?? null,
  started_at: new Date().toISOString(),
  status: "prepared",
  commands: [],
}
const originalCommands = previous ? [...previous.commands] : []
let resumedPage: string | undefined
if (previous) {
  assert.equal(previous.status, "failed")
  assert.equal(previous.entry, entry)
  assert.equal(previous.legacy_database, values["legacy-database"] ?? null)
  assert.equal(previous.resumptions, undefined, "Retain a failed recovery for explicit inspection")
  assert.match(marker, /^AH564_[a-f0-9]{32}$/u)
  const last = originalCommands.at(-1)!
  assert.equal(last.phase, "native-create", "Only the original create outcome may be resumed")
  assert.equal(last.exit_code, 2)
  assert.ok(originalCommands.slice(0, -1).every((command) => command.exit_code === 0))
  const failed = JSON.parse(
    await readFile(
      join(run, `${String(last.number).padStart(2, "0")}-native-create.stdout`),
      "utf8",
    ),
  )
  assert.equal(failed.error?.code, "INVALID_ARGUMENT")
  assert.equal(failed.error?.message, "Unknown SQLite domain address.")
  assert.equal(failed.error?.details?.stage, "outcome")
  assert.equal(failed.error?.details?.recovery?.mode, "reconcile")
  assert.equal(failed.error?.details?.recovery?.plan?.operation_id, values["resume-operation"])
  assert.equal(failed.error?.details?.native_create_operation_id, values["resume-operation"])
  assert.match(
    failed.error?.details?.key,
    /^operations\/shared-native-create-owned\/[a-f0-9]{64}\/skill-create-[a-f0-9]{64}\.json$/u,
  )
  resumedPage = failed.error?.details?.skill_page_id
  assert.ok(uuid(resumedPage))
  await writeFile(
    join(run, "manifest-before-recovery.json"),
    JSON.stringify(previous, null, 2) + "\n",
    {
      flag: "wx",
      mode: 0o600,
    },
  )
  manifest.resumptions = [
    {
      at: new Date().toISOString(),
      cli,
      cli_sha256: createHash("sha256")
        .update(await readFile(cli))
        .digest("hex"),
      original_operation_id: values["resume-operation"]!,
      original_page_id: resumedPage,
    },
  ]
  delete manifest.failure
  delete manifest.finished_at
} else {
  // A second invocation cannot allocate another workflow after an unknown write.
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  })
}
const save = () =>
  writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 })
const trapDirectory = join(run, "guard-bin")
await mkdir(trapDirectory, { recursive: true, mode: 0o700 })
await writeFile(
  join(trapDirectory, "ntn"),
  '#!/bin/sh\nprintf "%s\\n" forbidden-ntn-invocation >> "$NTN_SKILLS_FORBIDDEN_NTN_LOG"\nexit 97\n',
  { mode: 0o700 },
)
const trapLog = join(run, "forbidden-ntn.log")
const environment = {
  ...process.env,
  PATH: `${trapDirectory}:${process.env.PATH ?? ""}`,
  NTN_SKILLS_FORBIDDEN_NTN_LOG: trapLog,
  NOTION_API_BASE_URL: "https://api.notion.com",
  NTN_SKILLS_REQUEST_TRACE_LIMIT: "1000",
}
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const requiredString = (value: unknown, field: string) => {
  assert.equal(typeof value, "string", `Missing ${field}`)
  return String(value)
}
async function command(
  phase: string,
  args: string[],
  raw = false,
): Promise<Record<string, unknown>> {
  const original = originalCommands.find((command) => command.phase === phase)
  if (original) {
    assert.deepEqual(args, original.argv.slice(2), "Recovery must preserve the exact original argv")
    if (original.exit_code === 0) {
      const stdout = await readFile(
        join(run, `${String(original.number).padStart(2, "0")}-${phase}.stdout`),
        "utf8",
      )
      if (raw) return { content: stdout }
      const parsed = object(JSON.parse(stdout))
      assert.equal(parsed.ok, true)
      return parsed
    }
  }
  const number = manifest.commands.length + 1
  const record = { number, phase, argv: [node, cli, ...args] }
  manifest.commands.push(record)
  manifest.status = `running:${phase}`
  await save()
  const started = Date.now()
  const result = spawnSync(node, [cli, ...args], {
    env: environment,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 300_000,
  })
  Object.assign(record, { exit_code: result.status, milliseconds: Date.now() - started })
  await writeFile(
    join(run, `${String(number).padStart(2, "0")}-${phase}.stdout`),
    result.stdout ?? "",
    { mode: 0o600 },
  )
  await writeFile(
    join(run, `${String(number).padStart(2, "0")}-${phase}.stderr`),
    result.stderr ?? "",
    { mode: 0o600 },
  )
  await save()
  assert.equal(
    result.status,
    0,
    `${phase} failed; preserve its output and original operation. ${result.error?.name ?? ""}`,
  )
  if (raw) return { content: result.stdout }
  const parsed = object(JSON.parse(result.stdout))
  assert.equal(parsed.ok, true, `${phase} did not return ok:true`)
  return parsed
}
async function api(phase: string, path: string) {
  return object((await command(phase, ["ctl", "api", path])).response)
}
async function inputFile(path: string, content: string) {
  if (previous) assert.equal(await readFile(path, "utf8"), content, "Original input bytes changed")
  else await writeFile(path, content, { flag: "wx", mode: 0o600 })
}
function rootPage(result: Record<string, unknown>) {
  const id = object(object(result.record).locator).page_id
  assert.ok(uuid(id), "Successful create must return its exact native page identity")
  return id
}
async function archiveOwned(label: string, page: string, operation: string) {
  const plan = await command(`${label}-archive-plan`, [
    "ctl",
    "archive",
    page,
    "--operation",
    operation,
    "--dry-run",
  ])
  assert.equal(plan.verified, true)
  assert.ok(
    Array.isArray(plan.owned_page_ids) && plan.owned_page_ids.every(uuid),
    "Archive must prove the original operation's complete owned page set",
  )
  const ids: string[] = plan.owned_page_ids
  assert.ok(ids.includes(page), "The original operation does not own its selected root")
  for (const [index, target] of [...new Set(ids.filter((id) => id !== page)), page].entries()) {
    const archived = await command(`${label}-archive-${index}`, [
      "ctl",
      "archive",
      target,
      "--operation",
      operation,
    ])
    assert.equal(archived.archived, true)
    assert.equal(archived.verified, true)
    const observed = await api(`${label}-archive-readback-${index}`, `v1/pages/${target}`)
    assert.equal(observed.id, target)
    assert.ok(observed.in_trash === true || observed.archived === true)
  }
  return ids
}

try {
  const identity = await api("identity", "v1/users/me")
  assert.ok(uuid(identity.id), "Direct Notion identity preflight failed")
  const library = await api("library-entry", `v1/databases/${entry}`)
  assert.equal(library.id, entry)
  // Check the installed public cleanup command before the first creation.
  await command("archive-help", ["ctl", "archive", "--help"], true)
  const legacy = values["legacy-database"]
  if (legacy) {
    const database = await api("legacy-entry", `v1/databases/${legacy}`)
    assert.equal(database.id, legacy)
    assert.ok(Array.isArray(database.data_sources) && database.data_sources.length === 1)
    const source = requiredString(object(database.data_sources[0]).id, "legacy data source")
    const schema = object((await api("legacy-schema", `v1/data_sources/${source}`)).properties)
    assert.equal(object(schema.Description).type, "rich_text")
    assert.equal(object(schema.References).type, "rich_text")
    assert.equal(object(schema.Files).type, "files")
    assert.equal(
      object(schema.Kind).type,
      "select",
      "Legacy publication needs its declared Kind field",
    )
    assert.equal(
      object(schema.Publication).type,
      "rich_text",
      "Legacy publication needs its completion marker field",
    )
  }
  const input = join(run, "native-input")
  await mkdir(join(input, "references"), { recursive: true, mode: 0o700 })
  await inputFile(
    join(input, "SKILL.md"),
    `# Owned direct HTTP verification\n\n${marker}_INITIAL\n\n[Supporting file](references/guide.md)\n`,
  )
  await inputFile(
    join(input, "references", "guide.md"),
    `# Supporting file\n\n${marker}_RESOURCE\n`,
  )
  const name = `AH-564 Direct HTTP ${marker.slice(6)}`
  const created = await command("native-create", [
    "create",
    input,
    "--database",
    entry,
    "--name",
    name,
    "--description",
    `${marker} owned native acceptance`,
  ])
  assert.equal(created.verified, true)
  const page = rootPage(created)
  const createOperation = requiredString(created.create_operation_id, "create operation")
  if (previous) {
    assert.equal(createOperation, values["resume-operation"])
    assert.equal(page, resumedPage, "Recovery must return the original page")
    assert.equal(object(object(created.request_metrics).requests).notion_write, 0)
  }
  const replacement = join(run, "replacement.md")
  await writeFile(
    replacement,
    `# Owned direct HTTP verification\n\n${marker}_WRITTEN\n\n[Supporting file](references/guide.md)\n`,
    { flag: "wx", mode: 0o600 },
  )
  const written = await command("native-body-write", [
    "write",
    requiredString(created.ref, "created pinned ref"),
    "--database",
    entry,
    "--input",
    replacement,
  ])
  assert.equal(written.verified, true)
  assert.ok(written.body_write_operation_id)
  const updated = await command("native-field-write", [
    "update",
    requiredString(written.ref, "written pinned ref"),
    "--database",
    entry,
    "--name",
    `${name} verified`,
    "--description",
    `${marker}_FIELDS`,
  ])
  assert.equal(updated.verified, true)
  assert.ok(updated.metadata_operation_id)
  const observed = await command("native-readback", [
    "read",
    page,
    "--database",
    entry,
    "--refresh",
    "--metrics",
  ])
  assert.equal(object(observed.record).description, `${marker}_FIELDS`)
  assert.equal(object(observed.record).name, `${name} verified`)
  assert.ok(
    requiredString(observed.content, "native body").includes(
      `${marker}_WRITTEN`.replace(/_/gu, "\\_"),
    ),
  )
  const resource = await command("native-resource-readback", [
    "read",
    page,
    "--path",
    "references/guide.md",
    "--database",
    entry,
    "--refresh",
  ])
  assert.ok(
    requiredString(resource.content, "native resource body").includes(
      `${marker}_RESOURCE`.replace(/_/gu, "\\_"),
    ),
  )
  assert.ok(Array.isArray(observed.file_bindings), "Readback must expose stable native File IDs")
  const guide = observed.file_bindings
    .map(object)
    .find((file) => file.path === "references/guide.md")
  assert.ok(guide && uuid(guide.page_id))
  const href = `https://www.notion.so/${guide.page_id.replaceAll("-", "")}`
  const linkedInput = join(run, "native-link.md")
  await writeFile(
    linkedInput,
    `# Owned direct HTTP verification\n\n${marker}_WRITTEN\n\n[Supporting file](${href})\n`,
    { flag: "wx", mode: 0o600 },
  )
  const linkedWrite = await command("native-link-write", [
    "write",
    requiredString(observed.ref, "observed pinned ref"),
    "--database",
    entry,
    "--input",
    linkedInput,
  ])
  assert.equal(linkedWrite.verified, true)
  const linked = await command("native-link-readback", [
    "read",
    page,
    "--database",
    entry,
    "--refresh",
    "--metrics",
  ])
  const entries = object(linked.native_references).entries
  assert.ok(Array.isArray(entries))
  const observedHref = `https://app.notion.com/p/${guide.page_id.replaceAll("-", "")}`
  const link = entries
    .map(object)
    .find((item) => item.href === observedHref && item.from === "SKILL.md")
  assert.ok(link, "The actual native page URL must resolve through the observed library")
  assert.equal(link.kind, "file")
  assert.equal(link.file_id, guide.file_id)
  assert.equal(link.page_id, guide.page_id)
  assert.equal(link.skill_page_id, page)
  assert.equal(link.path, guide.path)
  assert.equal(link.availability, "available")
  const nativeMarkdown = await api(
    "native-link-raw-body",
    `v1/pages/${page}/markdown?markdown_version=v2`,
  )
  const rawBody = requiredString(nativeMarkdown.markdown, "complete native Markdown")
  assert.equal(nativeMarkdown.truncated, false)
  assert.ok(rawBody.includes(`](${observedHref})`))
  const sourceFiles = object(linked.native_references).source_files
  assert.ok(Array.isArray(sourceFiles))
  const source = sourceFiles.map(object).find((file) => file.path === "SKILL.md")
  assert.equal(
    source?.body_sha256,
    createHash("sha256").update(rawBody.replace(/\r\n/gu, "\n")).digest("hex"),
  )
  const linkedResource = await command("native-link-resource", [
    "read",
    requiredString(link.ref, "compiled exact File ref"),
  ])
  assert.equal(linkedResource.content, resource.content)
  const historical = await command("native-link-old-pin", [
    "read",
    requiredString(observed.ref, "original pinned ref"),
    "--offline",
  ])
  assert.equal(
    historical.content,
    observed.content,
    "Native link compilation must not rewrite old snapshots",
  )
  const nativeReferences = {
    href,
    entry: link,
    source_files: object(linked.native_references).source_files,
    old_snapshot_id: observed.snapshot_id,
    new_snapshot_id: linked.snapshot_id,
  }
  let attachment: unknown = {
    status: "not_run",
    reason:
      "No authorized legacy References+Files database was supplied; native shared creation accepts UTF-8 files only.",
  }
  if (legacy) {
    const directory = join(run, "legacy-input")
    await mkdir(join(directory, "assets"), { recursive: true, mode: 0o700 })
    await writeFile(
      join(directory, "SKILL.md"),
      `# Owned attachment verification\n\n${marker.replaceAll("_", "-")}-LEGACY\n`,
      { flag: "wx", mode: 0o600 },
    )
    const bytes = Buffer.concat([
      Buffer.from(`${marker}_BINARY\n`),
      Buffer.from([0, 255, 1, 128, 13, 10]),
    ])
    await writeFile(join(directory, "assets", "probe.bin"), bytes, { flag: "wx", mode: 0o600 })
    const uploaded = await command("legacy-upload-create", [
      "create",
      directory,
      "--database",
      legacy,
      "--storage",
      "notion_blocks",
      "--name",
      `${name} attachment`,
      "--description",
      `${marker} owned multipart acceptance`,
    ])
    assert.equal(uploaded.verified, true)
    const legacyPage = rootPage(uploaded)
    const operation = requiredString(uploaded.operation_id, "legacy publication operation")
    const files = await command("legacy-files", [
      "files",
      legacyPage,
      "--database",
      legacy,
      "--refresh",
    ])
    assert.ok(Array.isArray(files.files))
    const binary = files.files.map(object).find((file) => file.path === "assets/probe.bin")
    assert.ok(binary, "The actual uploaded source bundle did not restore the binary attachment")
    const output = join(run, "downloaded-probe.bin")
    await command("legacy-binary-readback", [
      "read",
      requiredString(binary.ref, "binary pinned ref"),
      "--output",
      output,
    ])
    assert.deepEqual(await readFile(output), bytes)
    attachment = {
      status: "verified",
      page_id: legacyPage,
      operation_id: operation,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      archived_page_ids: await archiveOwned("legacy", legacyPage, operation),
    }
  }
  const archived = await archiveOwned("native", page, createOperation)
  let forbiddenCalls = false
  try {
    await access(trapLog)
    forbiddenCalls = true
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
  }
  assert.equal(
    forbiddenCalls,
    false,
    "The public workflows invoked the removed official ntn subprocess",
  )
  manifest.status = "passed"
  manifest.result = {
    native_public_cli: "verified",
    create_operation_id: createOperation,
    body_write_operation_id: written.body_write_operation_id,
    metadata_operation_id: updated.metadata_operation_id,
    native_page_id: page,
    native_references: nativeReferences,
    archived_page_ids: archived,
    immutable_records: "retained",
    attachment,
    official_ntn_invocations: 0,
  }
} catch (error) {
  manifest.status = "failed"
  manifest.failure = error instanceof Error ? error.message : "Unknown acceptance failure"
  process.exitCode = 1
} finally {
  manifest.finished_at = new Date().toISOString()
  await save()
  console.log(
    JSON.stringify(
      {
        status: manifest.status,
        manifest: manifestPath,
        result: manifest.result,
        failure: manifest.failure,
      },
      null,
      2,
    ),
  )
}
