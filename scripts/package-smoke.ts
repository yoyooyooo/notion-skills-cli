import { createHash } from "node:crypto"
import {
  access,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    archive: { type: "string" },
    registry: { type: "string" },
    runtime: { type: "string" },
  },
  strict: true,
})
if (Boolean(values.archive) === Boolean(values.registry))
  throw new Error("Select exactly one --archive or --registry input.")
if (values.registry && !/^ntn-skills@\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i.test(values.registry))
  throw new Error("--registry must select an exact ntn-skills version.")
const scratch = await mkdtemp(join(tmpdir(), "ntn-skills-consumer-"))
console.error(JSON.stringify({ consumer_smoke_scratch: scratch }))
const runtime = values.runtime ? resolve(values.runtime) : Bun.which("node")
if (!runtime) throw new Error("Node.js 22.19.0 or newer must be installed for consumer checks.")
const dependency = values.archive
  ? `file:${resolve(values.archive)}`
  : values.registry!.split("@")[1]!
await writeFile(
  join(scratch, "package.json"),
  JSON.stringify({ private: true, dependencies: { "ntn-skills": dependency } }),
)
const env = {
  ...process.env,
  PATH: `${dirname(runtime)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
  NOTION_API_TOKEN: "",
  NOTION_WORKSPACE_ID: "",
  NOTION_API_BASE_URL: "",
  NTN_SKILLS_HOME: join(scratch, "state"),
  NTN_SKILLS_CONFIG_HOME: join(scratch, "config"),
  NTN_SKILLS_CACHE_HOME: join(scratch, "cache"),
  XDG_CONFIG_HOME: join(scratch, "xdg", "config"),
  XDG_STATE_HOME: join(scratch, "xdg", "state"),
  XDG_CACHE_HOME: join(scratch, "xdg", "cache"),
  NTN_SKILLS_NTN_BIN: join(scratch, "missing-ntn"),
}
async function run(
  command: string[],
  expectedExit = 0,
  overrides: Record<string, string | undefined> = {},
) {
  const child = Bun.spawn(command, {
    cwd: scratch,
    env: { ...env, ...overrides },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exit !== expectedExit)
    throw new Error(
      `Consumer command ${JSON.stringify(command)} exited ${exit}, expected ${expectedExit}; scratch=${scratch}: ${stderr || stdout}`,
    )
  if (command[0] === runtime && command[1] === executable && stderr)
    throw new Error(
      `CLI command ${JSON.stringify(command)} emitted unexpected stderr; scratch=${scratch}: ${stderr}`,
    )
  return stdout
}
await run([
  "npm",
  "install",
  "--omit=dev",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--registry=https://registry.npmjs.org",
])
const installed = join(scratch, "node_modules/ntn-skills")
const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"))
if (values.registry && values.registry !== `${manifest.name}@${manifest.version}`)
  throw new Error("Registry installation selected a different version.")
const executable = join(installed, manifest.bin["ntn-skills"])
const consumerBin = join(scratch, "node_modules/.bin/ntn-skills")
const check = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message)
}
const cli = async (
  args: string[],
  expectedExit = 0,
  overrides: Record<string, string | undefined> = {},
) => {
  const stdout = await run([runtime, executable, ...args], expectedExit, overrides)
  check(stdout.trim().split("\n").length === 1, `CLI emitted multiple values: ${args.join(" ")}`)
  const result = JSON.parse(stdout)
  check(result.ok === (expectedExit === 0), `CLI result disagrees with its exit: ${args.join(" ")}`)
  if (expectedExit !== 0)
    check(
      typeof result.error?.message === "string" && result.error.message.length > 0,
      "CLI error omitted a meaningful message.",
    )
  return result
}
const rejectedCommands: Array<{ args: string[]; exit: number; output: unknown }> = []
const rejected = async (args: string[], code = "INVALID_ARGUMENT", exit = 2) => {
  const result = await cli(args, exit)
  check(result.error.code === code, `Expected ${code}: ${JSON.stringify(result)}`)
  rejectedCommands.push({ args, exit, output: result })
  return result
}
const evidence: Record<string, unknown> = {}
check(
  (await run([consumerBin, "--version"])).trim() === `ntn-skills v${manifest.version}`,
  "Installed consumer bin cannot launch through its Node.js shebang.",
)
check(
  (await run([runtime, executable, "--version"])).trim() === `ntn-skills v${manifest.version}`,
  "CLI version differs from package.",
)
const helpCommands = [
  [],
  ["list"],
  ["database"],
  ["database", "list"],
  ["open"],
  ["read"],
  ["files"],
  ["create"],
  ["import"],
  ["export"],
  ["write"],
  ["config"],
  ["config", "show"],
  ["config", "set-default"],
  ["config", "clear-default"],
  ["config", "set-token"],
  ["config", "clear-token"],
  ["config", "set-cache-policy"],
  ["config", "clear-cache-policy"],
  ["source"],
  ["source", "add"],
  ["source", "list"],
  ["sync"],
  ["sync", "bind"],
  ["sync", "status"],
  ["sync", "plan"],
  ["sync", "apply"],
  ["sync", "reconcile"],
  ["sync", "unbind"],
  ["cache"],
  ["cache", "status"],
  ["cache", "clear"],
  ["resolve"],
  ["doctor"],
]
for (const command of helpCommands)
  check(
    (await run([runtime, executable, ...command, "--help"])).trim().length > 0,
    `Empty help for ${command.join(" ") || "root"}.`,
  )
evidence.help_commands = helpCommands.map((command) => command.join(" ") || "root")
for (const args of [
  ["list", "--database=frontend", "--database=ops"],
  ["read", "sample", "--refresh", "--refresh"],
  ["files", "sample", "--offline", "--offline"],
  ["open", "sample", "--refresh", "--offline"],
  ["list", "--max-age", "1"],
  ["list", "--max-age", "9007199254740992d"],
  ["list", "--max-age", "0", "--max-age=1s"],
  ["import", "missing.md", "--target", "a", "--target=b"],
  ["sync", "plan"],
  ["sync", "plan", "binding", "--all"],
  ["sync", "plan", "--all", "--from", "local"],
  ["sync", "apply"],
  ["sync", "apply", "--plan", "p_invalid", "--from", "local"],
  ["cache", "clear"],
  ["cache", "clear", "sample", "--all"],
  ["cache", "clear", "--all", "--database", "smoke"],
  ["cache", "clear", "--all", "--all"],
  ["config", "set-cache-policy"],
])
  await rejected(args)
const initialConfig = await cli(["config", "show"])
check(
  initialConfig.config.token_configured === false && !initialConfig.config.token,
  "Configuration is not sanitized.",
)
evidence.empty_cache_status = await cli(["cache", "status"])
const roots = (output: unknown, config: string, state: string, cache: string) => {
  check(
    typeof output === "object" &&
      output !== null &&
      "config_directory" in output &&
      output.config_directory === config &&
      "state_directory" in output &&
      output.state_directory === state &&
      "cache_directory" in output &&
      output.cache_directory === cache,
    "CLI selected incorrect config/state/cache roots.",
  )
}
roots(
  evidence.empty_cache_status,
  env.NTN_SKILLS_CONFIG_HOME,
  env.NTN_SKILLS_HOME,
  env.NTN_SKILLS_CACHE_HOME,
)
const xdgRoots = [
  join(env.XDG_CONFIG_HOME, "ntn-skills"),
  join(env.XDG_STATE_HOME, "ntn-skills"),
  join(env.XDG_CACHE_HOME, "ntn-skills"),
] as const
for (const [key, expected] of [
  ["NTN_SKILLS_CONFIG_HOME", [xdgRoots[0], env.NTN_SKILLS_HOME, env.NTN_SKILLS_CACHE_HOME]],
  ["NTN_SKILLS_HOME", [env.NTN_SKILLS_CONFIG_HOME, xdgRoots[1], env.NTN_SKILLS_CACHE_HOME]],
  ["NTN_SKILLS_CACHE_HOME", [env.NTN_SKILLS_CONFIG_HOME, env.NTN_SKILLS_HOME, xdgRoots[2]]],
] as const)
  roots(await cli(["cache", "status"], 0, { [key]: undefined }), ...expected)
evidence.xdg_cache_status = await cli(["cache", "status"], 0, {
  NTN_SKILLS_CONFIG_HOME: undefined,
  NTN_SKILLS_HOME: undefined,
  NTN_SKILLS_CACHE_HOME: undefined,
})
roots(evidence.xdg_cache_status, ...xdgRoots)

// These fixtures prove installed offline consumption and retention only; no provider observation is performed.
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const token = "offline-consumer-fixture-token"
const scope = digest(
  JSON.stringify([
    "offline-fixture-user",
    env.NOTION_WORKSPACE_ID,
    env.NOTION_API_BASE_URL,
    digest(token),
  ]),
)
const identityKey = digest(
  JSON.stringify([digest(token), env.NOTION_WORKSPACE_ID, env.NOTION_API_BASE_URL]),
)
const pageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const databaseId = "11111111-1111-4111-8111-111111111111"
const dataSourceId = "22222222-2222-4222-8222-222222222222"
const versionId = "offline-consumer-version"
const snapshotId = `s_${digest(JSON.stringify([scope, pageId, versionId]))}`
const ref = `skill://${pageId}/SKILL.md?snapshot=${snapshotId}`
const resolved = await cli([
  "resolve",
  "../assets/template.md",
  "--from",
  `skill://${pageId}/references/guide.md?snapshot=${snapshotId}`,
])
check(
  resolved.ref === `skill://${pageId}/assets/template.md?snapshot=${snapshotId}`,
  "Relative refs lost path or version.",
)
const main =
  '---\n"description": "Verify installed offline consumption"\n"name": "package-smoke"\n---\n\n# Package Smoke\n\nRead supporting files from the same snapshot.\n'
const supporting = "first\nsecond\nthird\n"
const contents = [
  { path: "SKILL.md", bytes: Buffer.from(main) },
  { path: "references/guide.md", bytes: Buffer.from(supporting) },
  { path: "references/nested/details.md", bytes: Buffer.from("# Nested details\n") },
  { path: "assets/example.bin", bytes: Buffer.from([0, 255, 1, 128]) },
]
const files = contents.map((file) => ({
  path: file.path,
  bytes: file.bytes.length,
  sha256: digest(file.bytes),
}))
const writePrivate = async (path: string, value: string | Uint8Array) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, value, { mode: 0o600 })
}
const skill = {
  id: pageId,
  name: "Package Smoke",
  alias: "package-smoke",
  description: "Verify installed offline consumption",
  database_id: databaseId,
  data_source_id: dataSourceId,
  ref: `skill://${pageId}/SKILL.md`,
}
const snapshotValue = {
  snapshot_id: snapshotId,
  scope,
  skill,
  skill_name: "package-smoke",
  version_id: versionId,
  created_at: 0,
  files,
}
for (const file of contents)
  await writePrivate(join(env.NTN_SKILLS_HOME, "objects", digest(file.bytes)), file.bytes)
const snapshotPath = join(env.NTN_SKILLS_HOME, "snapshots", `${snapshotId}.json`)
await writePrivate(snapshotPath, JSON.stringify(snapshotValue))
const sources = [
  { alias: "smoke", database_id: databaseId, title: "Smoke", data_source_ids: [dataSourceId] },
]
const localPath = join(scratch, "local-skill")
for (const file of contents) await writePrivate(join(localPath, file.path), file.bytes)
const binding = {
  id: "b_offline-consumer",
  label: "consumer-local",
  page_id: pageId,
  database_id: databaseId,
  data_source_id: dataSourceId,
  scope,
  logical_path: localPath,
  active: true,
  revision: 1,
}
const originalConfig = { token, sources, default_database: databaseId, sync_bindings: [binding] }
const configPath = join(env.NTN_SKILLS_CONFIG_HOME, "config.json")
await writePrivate(configPath, JSON.stringify(originalConfig))
const base = {
  format: "ntn-skills-sync-base",
  version: 1,
  binding_id: binding.id,
  generation: 0,
  initialized: false,
}
const contentFiles = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
const content = {
  name: skill.name,
  description: skill.description,
  main: "SKILL.md",
  files: contentFiles,
  content_id: digest(
    JSON.stringify([
      skill.name,
      skill.description,
      "SKILL.md",
      contentFiles.map((file) => [file.path, file.sha256]),
    ]),
  ),
}
// Record real inode/link evidence for seeded state; this plan is never applied or presented as provider proof.
async function fixturePathProof(location: string) {
  let current = parse(resolve(location)).root
  let pending = resolve(location).slice(current.length).split(sep).filter(Boolean)
  const root = await lstat(current, { bigint: true })
  const nodes: Array<{
    path: string
    kind: "directory" | "file" | "link"
    dev: string
    ino: string
    link?: string
  }> = [{ path: current, kind: "directory", dev: String(root.dev), ino: String(root.ino) }]
  let links = 0
  while (pending.length) {
    const component = pending.shift()!
    if (component === ".") continue
    if (component === "..") {
      current = dirname(current)
      continue
    }
    const next = join(current, component)
    const info = await lstat(next, { bigint: true })
    const kind: "link" | "directory" | "file" = info.isSymbolicLink()
      ? "link"
      : info.isDirectory()
        ? "directory"
        : "file"
    const node = { path: next, kind, dev: String(info.dev), ino: String(info.ino) }
    if (kind === "link") {
      if (++links > 40)
        throw new Error("Consumer scratch contains an unresolved symbolic-link cycle.")
      const link = await readlink(next)
      nodes.push({ ...node, link })
      pending = [...link.split(sep).filter(Boolean), ...pending]
      if (isAbsolute(link)) current = parse(link).root
    } else {
      nodes.push(node)
      current = next
    }
  }
  return { nodes, resolved_path: current, exists: true }
}
const rootProof = await fixturePathProof(localPath)
const fileProofs = await Promise.all(
  contentFiles.map(async (file) => ({
    path: file.path,
    proof: await fixturePathProof(join(localPath, file.path)),
  })),
)
function canonicalFixtureJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined"
  if (Array.isArray(value)) return `[${value.map(canonicalFixtureJson).join(",")}]`
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalFixtureJson(entry)}`)
    .join(",")}}`
}
const planBody = {
  format: "ntn-skills-sync-plan",
  version: 1,
  applicable: true,
  conflicts: [],
  bindings: [
    {
      binding,
      base,
      local: {
        logical_path: localPath,
        resolved_path: rootProof.resolved_path,
        exists: true,
        proof: { root: rootProof, files: fileProofs },
        file_hashes: contentFiles,
        content,
      },
      remote: snapshotValue,
      remote_content: content,
      mode: "exact",
      direction: "advance_baseline",
      source: "notion",
      intended: content,
      actions: contentFiles
        .map((file) => file.path)
        .sort()
        .map((path) => ({ path, action: "retain" })),
    },
  ],
}
const planId = `p_${digest(canonicalFixtureJson(planBody))}`
const retainedPlan = { ...planBody, plan_id: planId }
const retainedState = [
  { path: join(env.NTN_SKILLS_HOME, "sync", "bases", `${binding.id}.json`), value: base },
  { path: join(env.NTN_SKILLS_HOME, "sync", "plans", `${planId}.json`), value: retainedPlan },
  {
    path: join(
      env.NTN_SKILLS_HOME,
      "sync",
      "receipts",
      "o_33333333-3333-4333-8333-333333333333.json",
    ),
    value: {
      format: "ntn-skills-sync-receipt",
      version: 1,
      operation_id: "o_33333333-3333-4333-8333-333333333333",
      plan_id: planId,
      created_at: 0,
      status: "pending",
      groups: [{ page_id: pageId, stage: "prepared" }],
      bindings: [
        {
          binding_id: binding.id,
          page_id: pageId,
          resolved_path: rootProof.resolved_path,
          stage: "prepared",
          generation_before: 0,
          retained: [],
        },
      ],
    },
  },
]
for (const state of retainedState) await writePrivate(state.path, JSON.stringify(state.value))
const preservedConfig = async () => {
  const config = JSON.parse(await readFile(configPath, "utf8"))
  check(
    config.token === token &&
      config.default_database === databaseId &&
      JSON.stringify(config.sources) === JSON.stringify(sources) &&
      JSON.stringify(config.sync_bindings) === JSON.stringify([binding]),
    "Cache policy changed unrelated configuration.",
  )
}
await cli(["config", "set-cache-policy", "--read-max-age", "2h", "--catalog-max-age", "3m"])
await preservedConfig()
const persisted = await cli(["config", "show"])
check(
  persisted.config.effective_cache_policy.read_max_age_ms === 7200000 &&
    persisted.config.effective_cache_policy.catalog_max_age_ms === 180000 &&
    persisted.config.token_configured &&
    !persisted.config.token,
  "Policy failed to persist safely into a new process.",
)
await cli(["config", "set-cache-policy", "--read-max-age", "0"])
check(
  (await cli(["config", "show"])).config.effective_cache_policy.catalog_max_age_ms === 180000,
  "Partial policy update lost the catalog default.",
)
await cli(["config", "clear-cache-policy"])
await preservedConfig()
evidence.policy_after_clear = (await cli(["config", "show"])).config.effective_cache_policy
check(
  JSON.stringify(evidence.policy_after_clear) ===
    JSON.stringify({ read_max_age_ms: 300000, catalog_max_age_ms: 60000 }),
  "Clearing policy did not restore effective defaults.",
)
check(!JSON.stringify(persisted).includes(token), "Policy output exposed a credential.")
const beforeSnapshot = await readFile(snapshotPath)
const beforeObjects = await Promise.all(
  files.map((file) => readFile(join(env.NTN_SKILLS_HOME, "objects", file.sha256))),
)
const pinnedRead = await cli(["read", ref, "--offline"])
check(
  pinnedRead.content === main && pinnedRead.source === "local_snapshot",
  "Installed snapshot read differs.",
)
const raw = await run([runtime, executable, "read", ref, "--raw", "--offline"])
check(raw === main, "Pinned raw read did not preserve exact text.")
const listed = await cli(["files", snapshotId, "--offline"])
check(
  listed.files.length === files.length &&
    listed.files.every((file: { path: string }) =>
      files.some((expected) => expected.path === file.path),
    ),
  "Installed snapshot file listing omitted supporting files.",
)
const range = await cli([
  "read",
  "references/guide.md",
  "--from",
  ref,
  "--lines",
  "2-2",
  "--offline",
])
check(
  range.content === "second" && range.range.start === 2 && range.has_more,
  "Installed ranged relative read differs.",
)
const output = join(scratch, "portable.zip")
const exported = await cli(["export", ref, "--output", output, "--offline"])
const reused = await cli(["export", ref, "--output", output, "--offline"])
check(
  !exported.reused && reused.reused && exported.content_id === reused.content_id,
  "Portable export reuse differs.",
)
check(
  (await cli(["read", ref, "--database", "smoke", "--offline"])).content === main,
  "Offline registered alias constraint failed.",
)
for (const command of [
  ["read", ref],
  ["read", "references/guide.md", "--from", ref],
  ["open", snapshotId],
  ["files", ref],
  ["export", ref, "--output", join(scratch, "rejected.zip")],
])
  for (const policy of [["--refresh"], ["--max-age", "0"]]) await rejected([...command, ...policy])
await rejected([
  "import",
  localPath,
  "--target",
  `skill://${pageId}/references/guide.md?snapshot=${snapshotId}`,
])
await rejected(
  ["import", localPath, "--target", pageId, "--name", "Renamed Consumer", "--dry-run"],
  "NTN_UNAVAILABLE",
  1,
)
await rejected(
  ["sync", "bind", pageId, "--path", localPath, "--as", "candidate", "--dry-run"],
  "NTN_UNAVAILABLE",
  1,
)
await rejected(["sync", "apply", "--plan", `p_${"c".repeat(64)}`], "SYNC_PLAN_MISSING", 1)
await rejected(
  ["sync", "apply", "--plan", join(scratch, "missing-plan.json")],
  "SYNC_PLAN_MISSING",
  1,
)
const observationTime = Date.now() - 3600000
const latestKey = `latest/${scope}/${pageId}/44444444-4444-4444-8444-444444444444.json`
const catalogKey = `catalogs/${scope}/${digest(JSON.stringify(["database-selection-v2", "smoke", sources]))}.json`
const cacheFixtures = [
  { key: `identities/${identityKey}.json`, value: { scope } },
  {
    key: latestKey,
    value: {
      page_id: pageId,
      scope,
      started_at: observationTime,
      validated_at: observationTime,
      generation: 1,
      snapshot_id: snapshotId,
      invalidated: false,
    },
  },
  {
    key: catalogKey,
    value: {
      scope,
      generation: 1,
      fetched_at: observationTime,
      databases: sources,
      skills: [skill],
      coverage: {
        method: "explicit_database",
        exhaustive: true,
        queried_data_sources: [dataSourceId],
        failed_sources: [],
        search_index_limited: false,
      },
    },
  },
]
for (const fixture of cacheFixtures)
  await writePrivate(join(env.NTN_SKILLS_CACHE_HOME, fixture.key), JSON.stringify(fixture.value))
for (const selector of [pageId, "package-smoke"]) {
  const current = await cli(["read", selector, "--database", "smoke", "--offline"])
  check(
    current.content === main &&
      current.snapshot_id === snapshotId &&
      current.source === "local_cache" &&
      current.freshness.policy === "offline" &&
      current.freshness.stale &&
      current.freshness.validated_at === new Date(observationTime).toISOString(),
    "Seeded current read lost content, snapshot or stale observation metadata.",
  )
}
const opened = await cli(["open", pageId, "--offline"])
check(
  opened.snapshot_id === snapshotId &&
    opened.files.length === files.length &&
    opened.source === "local_cache",
  "Offline current open lost its complete snapshot.",
)
const currentFiles = await cli(["files", pageId, "--offline"])
check(
  currentFiles.files.length === files.length && currentFiles.source === "local_cache",
  "Offline current files lost complete cached content.",
)
const currentExport = await cli([
  "export",
  pageId,
  "--output",
  join(scratch, "current-export"),
  "--format",
  "directory",
  "--offline",
])
check(
  currentExport.content_id === exported.content_id,
  "Offline current export differed from its pinned version.",
)
for (const file of contents)
  check(
    (await readFile(join(scratch, "current-export", file.path))).equals(file.bytes),
    "Offline directory export changed file bytes.",
  )
const catalog = await cli(["list", "--database", "smoke", "--query", "package", "--offline"])
check(
  catalog.count === 1 &&
    catalog.skills[0].id === pageId &&
    catalog.source === "local_cache" &&
    catalog.freshness.stale &&
    catalog.coverage.exhaustive &&
    !catalog.coverage.search_index_limited &&
    catalog.fetched_at === observationTime,
  "Offline list lost cached identity, age or discovery coverage.",
)
evidence.seeded_offline_current = {
  snapshot_id: opened.snapshot_id,
  source: opened.source,
  freshness: opened.freshness,
  file_count: opened.files.length,
  catalog_count: catalog.count,
  coverage: catalog.coverage,
}
for (const command of [
  ["read", pageId],
  ["open", pageId],
  ["files", pageId],
  ["export", pageId, "--output", join(scratch, "warm.zip")],
  ["list", "--database", "smoke"],
]) {
  const warm = await cli([...command, "--max-age", "2h"])
  check(
    warm.source === "local_cache" &&
      warm.freshness.policy === "max_age" &&
      !warm.freshness.stale &&
      warm.freshness.validated_at === new Date(observationTime).toISOString(),
    "Eligible seeded cache read called unavailable provider or changed observation time.",
  )
}
evidence.seeded_eligible_cache_policy = {
  max_age_ms: 7200000,
  validated_at: new Date(observationTime).toISOString(),
  source: "local_cache",
}
await rejected(["read", pageId, "--refresh"], "NTN_UNAVAILABLE", 1)
await rejected(["files", pageId, "--max-age", "0"], "NTN_UNAVAILABLE", 1)
check(
  JSON.parse(await readFile(join(env.NTN_SKILLS_CACHE_HOME, latestKey), "utf8")).validated_at ===
    observationTime,
  "Failed online validation changed the seeded observation timestamp.",
)
const status = await cli(["sync", "status", binding.label])
const edge = status.bindings[0]
check(
  status.bindings.length === 1 &&
    edge.binding.page_id === pageId &&
    edge.baseline_initialized === false &&
    edge.baseline_generation === 0 &&
    edge.status === "needs_initialization" &&
    edge.provisional &&
    !edge.authoritative &&
    edge.remote_snapshot_id === snapshotId &&
    edge.remote_validated_at === observationTime &&
    edge.remote_freshness === "stale" &&
    edge.remote_stale === true &&
    edge.pending_receipts.length === 1,
  "Offline sync status fabricated convergence or omitted the retained receipt/stale observation.",
)
evidence.seeded_offline_sync_status = status
await rejected(["sync", "status", binding.label, "--refresh"], "NTN_UNAVAILABLE", 1)
const dryUnbind = await cli(["sync", "unbind", binding.label, "--dry-run"])
check(dryUnbind.dry_run && !dryUnbind.deactivated, "Dry-run unbind reported a deactivation.")
await preservedConfig()
const stateBeforeClear = await Promise.all(retainedState.map((state) => readFile(state.path)))
const cacheBeforeClear = await Promise.all(
  cacheFixtures.map((fixture) => readFile(join(env.NTN_SKILLS_CACHE_HOME, fixture.key))),
)
const preview = await cli(["cache", "clear", pageId, "--database", "smoke", "--dry-run"])
check(
  preview.dry_run &&
    preview.retired.length === 0 &&
    preview.entries.includes(`cache/${latestKey}`) &&
    preview.entries.includes(`cache/${catalogKey}`) &&
    preview.entries.every(
      (key: string) =>
        key.startsWith(`cache/latest/${scope}/${pageId}/`) ||
        key.startsWith(`cache/catalogs/${scope}/`),
    ),
  `Target cache-clear preview missed latest/catalog observations; scratch=${scratch}; preview=${JSON.stringify(preview)}`,
)
for (let index = 0; index < cacheFixtures.length; index++)
  check(
    (await readFile(join(env.NTN_SKILLS_CACHE_HOME, cacheFixtures[index]!.key))).equals(
      cacheBeforeClear[index]!,
    ),
    "Dry-run cache clear changed cache bytes.",
  )
evidence.cache_clear_dry_run = preview
let trashCheck = "not_run_non_darwin"
if (process.platform === "darwin") {
  const home = process.env.HOME
  if (!home) throw new Error("System Trash retention proof requires the consumer HOME.")
  const trashDirectory = join(home, ".Trash")
  let trashBefore: Set<string> | undefined
  try {
    trashBefore = new Set(await readdir(trashDirectory))
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error ? error.code : undefined
    if (code !== "EPERM" && code !== "EACCES") throw error
    evidence.trash_contents_not_observed = { reason: code, operation: "read_trash_directory" }
  }
  const cleared = await cli(["cache", "clear", "--all"])
  check(
    !cleared.dry_run &&
      cleared.retired.length >= cacheFixtures.length &&
      cleared.retired.every(
        (entry: { retention_path: string }) => entry.retention_path === "system_trash",
      ),
    "Cache clear failed to report system Trash retention.",
  )
  for (const fixture of cacheFixtures)
    check(
      !(await access(join(env.NTN_SKILLS_CACHE_HOME, fixture.key)).then(
        () => true,
        () => false,
      )),
      "Retired cache observation remains active.",
    )
  const cacheAfterClear = await cli(["cache", "status"])
  evidence.cache_after_clear = cacheAfterClear
  check(
    cacheAfterClear.observations.length === 0 && cacheAfterClear.catalogs.length === 0,
    "Retired observations survived into a new process.",
  )
  if (trashBefore) {
    const newTrashNames = (await readdir(trashDirectory)).filter((name) => !trashBefore.has(name))
    const retained = []
    for (const name of newTrashNames) {
      const location = join(trashDirectory, name)
      if (!(await lstat(location)).isFile()) continue
      retained.push(await readFile(location))
    }
    for (const bytes of cacheBeforeClear)
      check(
        retained.some((candidate) => candidate.equals(bytes)),
        "System Trash did not retain the selected cache observation bytes.",
      )
    trashCheck = "system_trash_bytes_retained"
  } else {
    trashCheck = "system_trash_command_succeeded_contents_unreadable"
  }
  const afterClearStatus = await cli(["sync", "status", binding.label])
  check(
    afterClearStatus.bindings[0].remote_freshness === "unknown" &&
      afterClearStatus.bindings[0].baseline_generation === 0 &&
      afterClearStatus.bindings[0].pending_receipts.length === 1,
    "Cache retirement removed sync state or claimed a remote observation.",
  )
  await rejected(["read", pageId, "--offline"], "CACHE_SCOPE_UNAVAILABLE", 1)
  evidence.cache_clear_system_trash = cleared
} else {
  const rejectedClear = await cli(["cache", "clear", "--all"], 1)
  check(
    rejectedClear.error.code === "RETENTION_UNAVAILABLE",
    "Cache retirement without a system recycle capability must fail explicitly.",
  )
  for (let index = 0; index < cacheFixtures.length; index++)
    check(
      (await readFile(join(env.NTN_SKILLS_CACHE_HOME, cacheFixtures[index]!.key))).equals(
        cacheBeforeClear[index]!,
      ),
      "Unavailable retention changed cache bytes instead of retaining them in place.",
    )
  const cacheAfterClear = await cli(["cache", "status"])
  check(
    cacheAfterClear.observations.length === 0 && cacheAfterClear.catalogs.length === 0,
    "Unavailable retention left part of the cleared observation batch active.",
  )
  evidence.cache_after_clear = cacheAfterClear
  const afterClearStatus = await cli(["sync", "status", binding.label])
  check(
    afterClearStatus.bindings[0].remote_freshness === "unknown" &&
      afterClearStatus.bindings[0].baseline_generation === 0 &&
      afterClearStatus.bindings[0].pending_receipts.length === 1,
    "Unavailable retention lost sync state or still exposed an invalidated observation.",
  )
  evidence.sync_status_after_failed_clear = afterClearStatus
  evidence.cache_clear_retention_unavailable = rejectedClear
  trashCheck = "retention_unavailable_bytes_preserved"
}
for (let index = 0; index < retainedState.length; index++)
  check(
    (await readFile(retainedState[index]!.path)).equals(stateBeforeClear[index]!),
    "Cache clear changed baseline/plan/receipt bytes.",
  )
await preservedConfig()
check((await cli(["read", ref, "--offline"])).content === main, "Cache clear lost pinned content.")
check(
  (await readFile(snapshotPath)).equals(beforeSnapshot),
  "Offline reads/cache clear changed the immutable snapshot.",
)
for (let index = 0; index < files.length; index++)
  check(
    (await readFile(join(env.NTN_SKILLS_HOME, "objects", files[index]!.sha256))).equals(
      beforeObjects[index]!,
    ),
    "Offline reads/cache clear changed immutable objects.",
  )
const unbound = await cli(["sync", "unbind", binding.label])
check(
  unbound.deactivated && !unbound.binding.active && unbound.binding.revision === 2,
  "Unbind did not persist deactivation/revision.",
)
check(
  (await cli(["sync", "status"])).bindings.length === 0,
  "New process still lists a deactivated binding.",
)
const afterUnbindConfig = JSON.parse(await readFile(configPath, "utf8"))
check(
  afterUnbindConfig.token === token &&
    afterUnbindConfig.default_database === databaseId &&
    JSON.stringify(afterUnbindConfig.sources) === JSON.stringify(sources) &&
    afterUnbindConfig.sync_bindings[0].active === false,
  "Unbind changed unrelated configuration.",
)
for (let index = 0; index < retainedState.length; index++)
  check(
    (await readFile(retainedState[index]!.path)).equals(stateBeforeClear[index]!),
    "Unbind changed baseline/plan/receipt bytes.",
  )
for (const file of contents)
  check(
    (await readFile(join(localPath, file.path))).equals(file.bytes),
    "Unbind changed local content.",
  )
await writeFile(join(env.NTN_SKILLS_HOME, "objects", files[0]!.sha256), "corrupt", { mode: 0o600 })
await rejected(["read", ref, "--offline"], "STATE_CORRUPT", 1)
await writePrivate(join(env.NTN_SKILLS_HOME, "objects", files[0]!.sha256), contents[0]!.bytes)
evidence.rejected_commands = rejectedCommands
check(
  !JSON.stringify(evidence).includes(token),
  "Consumer evidence exposed a configured credential.",
)
await writePrivate(
  join(scratch, "offline-command-evidence.json"),
  JSON.stringify(
    {
      proof: "seeded offline installed-consumer behavior; no live Notion proof",
      trash_check: trashCheck,
      outputs: evidence,
    },
    null,
    2,
  ),
)
console.log(
  JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    runtime: (await run([runtime, "--version"])).trim(),
    proof: "seeded_offline_consumer",
    trash_check: trashCheck,
    checks: [
      "installed_bin",
      "version",
      "all_offline_help",
      "resolve",
      "sanitized_config",
      "invalid_arguments",
      "root_precedence",
      "policy_process_persistence",
      "policy_clear_preserves_config",
      "complete_pinned_snapshot_unchanged",
      "raw_pinned_read",
      "relative_range",
      "snapshot_files",
      "portable_export_reuse",
      "offline_alias",
      "pinned_policy_rejection",
      "import_target_and_bind_prerequisites",
      "saved_plan_missing_rejected",
      "seeded_offline_current_read_open_files_export_list",
      "seeded_eligible_max_age_cache",
      "failed_refresh_retains_observation",
      "seeded_offline_sync_status",
      "sync_status_refresh_prerequisite",
      "unbind_dry_run",
      "cache_clear_dry_run",
      ...(process.platform === "darwin"
        ? [
            "cache_clear_system_trash_command",
            ...(trashCheck === "system_trash_bytes_retained"
              ? ["cache_clear_system_trash_bytes"]
              : []),
            "cache_clear_retains_sync_pinned_state",
          ]
        : ["cache_clear_retention_unavailable_bytes_preserved"]),
      "unbind_process_retention",
      "corruption_rejected",
    ],
    evidence: join(scratch, "offline-command-evidence.json"),
    scratch,
  }),
)
