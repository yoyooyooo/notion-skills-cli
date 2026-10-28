#!/usr/bin/env bun
/**
 * Offline proof using controlled built-in package contents and real CLI commands.
 * Bun only bundles the unchanged production CLI entrypoint; every product action
 * runs the resulting self-contained JavaScript with Node. No Notion writes or
 * remote command is available through this runner. No custom Trash adapter.
 */
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"

const FileProofSchema = Schema.Struct({
  path: Schema.String,
  bytes: Schema.Number,
  sha256: Schema.String,
})
const InstallationSchema = Schema.Struct({
  state: Schema.String,
  path: Schema.String,
  data_dir: Schema.String,
  distributions: Schema.Array(
    Schema.Struct({
      agent_dir: Schema.String,
      path: Schema.String,
      state: Schema.String,
      reason: Schema.optional(Schema.String),
    }),
  ),
  available_content_id: Schema.String,
  installed_content_id: Schema.optional(Schema.String),
  distribution_error: Schema.optional(
    Schema.Struct({ code: Schema.String, message: Schema.String }),
  ),
})
const BuiltinInfoSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  package_version: Schema.String,
  content_id: Schema.String,
  installation: Schema.optional(InstallationSchema),
})
const CliResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  skills: Schema.optional(Schema.Array(BuiltinInfoSchema)),
  count: Schema.optional(Schema.Number),
  builtin: Schema.optional(BuiltinInfoSchema),
  content: Schema.optional(Schema.String),
  reused: Schema.optional(Schema.Boolean),
  installation: Schema.optional(InstallationSchema),
  error: Schema.optional(Schema.Struct({ code: Schema.String })),
})
const ReceiptSchema = Schema.Struct({
  format: Schema.String,
  version: Schema.Number,
  id: Schema.String,
  data_dir: Schema.String,
  path: Schema.String,
  package_version: Schema.String,
  content_id: Schema.String,
  files: Schema.Array(FileProofSchema),
})
const JournalSchema = Schema.Struct({ operation: Schema.String, operation_id: Schema.String })
const PhaseSchema = Schema.Struct({
  phase: Schema.optional(Schema.String),
  operation_id: Schema.String,
})
type FileProof = typeof FileProofSchema.Type
type ArtifactEvidence = {
  path: string
  retained_path: string
  bytes: number
  sha256: string
  package_version: string
  portable_files?: readonly FileProof[]
}
type LifecycleManifest = Record<string, unknown> & {
  commands: {
    label: string
    evidence: string
    executable: string
    argv: string[]
    exit: number | null
  }[]
  cases: Record<string, unknown>[]
  artifacts: Record<string, ArtifactEvidence>
  passed: boolean
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
const entrypoint = path.join(repo, "packages/cli/src/main.ts")
const catalog = path.join(repo, "packages/cli/src/builtins.ts")
const core = path.join(repo, "packages/core/src/index.ts")
const id = "notion/ntn-skills-maintain"
const name = "ntn-skills-maintain"
const packageVersion = "0.0.0-controlled-lifecycle"
const receiptName = ".ntn-builtin-install.json"
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const check: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message)
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const errorText = (error: unknown) =>
  error instanceof Error ? (error.stack ?? error.message) : String(error)
async function exists(location: string) {
  try {
    await fs.lstat(location)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}
async function save(location: string, value: unknown) {
  await fs.mkdir(path.dirname(location), { recursive: true, mode: 0o700 })
  await fs.writeFile(location, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
}
type InventoryEntry = {
  path: string
  kind: string
  mode: number
  dev: string
  ino: string
  bytes?: number
  sha256?: string
  link?: string
}
async function inventory(root: string): Promise<InventoryEntry[]> {
  if (!(await exists(root))) return []
  const result: InventoryEntry[] = []
  async function walk(location: string, relative: string) {
    const stat = await fs.lstat(location, { bigint: true })
    const base = {
      path: relative,
      mode: Number(stat.mode),
      dev: String(stat.dev),
      ino: String(stat.ino),
    }
    if (stat.isDirectory()) {
      result.push({ ...base, kind: "directory" })
      for (const child of (await fs.readdir(location)).sort())
        await walk(path.join(location, child), relative ? `${relative}/${child}` : child)
    } else if (stat.isFile()) {
      const bytes = await fs.readFile(location)
      result.push({ ...base, kind: "file", bytes: bytes.length, sha256: sha256(bytes) })
    } else if (stat.isSymbolicLink())
      result.push({ ...base, kind: "link", link: await fs.readlink(location) })
    else result.push({ ...base, kind: "other" })
  }
  await walk(root, "")
  return result
}
function files(entries: InventoryEntry[], omitReceipt = false) {
  return entries
    .filter((item) => item.kind === "file" && (!omitReceipt || item.path !== receiptName))
    .map(({ path: relative, bytes, sha256 }) => {
      check(
        bytes !== undefined && sha256 !== undefined,
        `File inventory lacks byte proof: ${relative}`,
      )
      return { path: relative, bytes, sha256 }
    })
}
async function execute(executable: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const started = new Date().toISOString()
  return await new Promise<{
    executable: string
    argv: string[]
    cwd: string
    started: string
    ended: string
    exit: number | null
    signal: string | null
    timed_out: boolean
    stdout: string
    stderr: string
    spawn_error?: string
  }>((resolve) => {
    const child = spawn(executable, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "",
      stderr = "",
      spawnError: string | undefined,
      timedOut = false
    child.stdout?.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr?.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", (error) => {
      spawnError = error.message
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, 120_000)
    child.on("close", (exit, signal) => {
      clearTimeout(timer)
      resolve({
        executable,
        argv,
        cwd,
        started,
        ended: new Date().toISOString(),
        exit,
        signal,
        timed_out: timedOut,
        stdout,
        stderr,
        ...(spawnError ? { spawn_error: spawnError } : {}),
      })
    })
  })
}
async function prerequisites() {
  const node = Bun.which("node")
  check(node, "Node.js is required; install Node before running this offline proof.")
  check(
    typeof Bun.build === "function",
    "Launch with Bun; Bun.build bundles the two Node CLI artifacts.",
  )
  check(
    process.platform === "darwin",
    "This proof requires the production macOS system Trash capability.",
  )
  await fs.access("/usr/bin/trash", fs.constants.X_OK)
  for (const location of [entrypoint, catalog, core]) await fs.access(location, fs.constants.R_OK)
  return { node, trash: "/usr/bin/trash", entrypoint, catalog, core, bun: Bun.version }
}
const help = `Usage: bun .cursor/skills/verify-ntn-skills/scripts/builtin-lifecycle.ts [run|doctor|--help]

No arguments runs the complete offline built-in lifecycle proof.
Bun builds two self-contained Node CLI artifacts from packages/cli/src/main.ts.
A narrowly scoped Bun onLoad plugin supplies controlled built-in package contents;
all list/read/export/install/status/update operations run node ARTIFACT ARGV.
Both packages have the same ID, name and version, with different actual file bytes.
Doctor checks only Node, system Trash and the production build entrypoint.
No Notion authorization is assumed; this runner has no remote/publish path.
Evidence stays in an independent temporary directory, including after failure.
Owned scratch moves to system Trash at the end; nothing is permanently deleted.
`

async function run(mode: "run" | "doctor") {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "ntn-builtin-lifecycle-evidence-")),
  )
  await fs.chmod(root, 0o700)
  const evidence = path.join(root, "evidence")
  const scratch = path.join(root, "scratch")
  await fs.mkdir(evidence, { mode: 0o700 })
  await fs.mkdir(scratch, { mode: 0o700 })
  const manifest: LifecycleManifest = {
    format: "ntn-skills-builtin-lifecycle-evidence",
    version: 2,
    started: new Date().toISOString(),
    mode,
    root,
    evidence,
    scratch,
    repo,
    controlled_builtin_package_contents: true,
    product_execution: "Node.js artifacts; public CLI only",
    remote_operations: [],
    production_trash_adapter: true,
    commands: [],
    cases: [],
    artifacts: {},
    passed: false,
    negative_inventory_scope:
      "Complete canonical and distribution target trees, including receipts, hidden files, directories and inode identities; central management lock history is retained separately.",
  }
  let commandNumber = 0
  const recordCommand = async (
    label: string,
    executable: string,
    argv: string[],
    env: NodeJS.ProcessEnv,
  ) => {
    const result = await execute(executable, argv, scratch, env)
    const relative = `commands/${String(++commandNumber).padStart(3, "0")}-${label}.json`
    await save(path.join(evidence, relative), result)
    manifest.commands.push({ label, evidence: relative, executable, argv, exit: result.exit })
    return result
  }
  const capture = async (label: string, target: string) => {
    const entries = await inventory(target)
    const destination = path.join(evidence, "trees", label)
    await fs.mkdir(destination, { recursive: true, mode: 0o700 })
    await save(path.join(destination, "inventory.json"), { target, entries })
    if (entries.length)
      await fs.cp(target, path.join(destination, "files"), {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
      })
    if (await exists(path.join(target, receiptName))) {
      await fs.copyFile(path.join(target, receiptName), path.join(destination, "receipt.json"))
    }
    return entries
  }
  let failure: unknown
  try {
    const doctor = await prerequisites()
    const nodeVersion = await recordCommand("doctor-node", doctor.node, ["--version"], process.env)
    check(
      nodeVersion.exit === 0 && !nodeVersion.timed_out,
      "Node prerequisite failed; inspect doctor command evidence.",
    )
    manifest.doctor = { ...doctor, node_version: nodeVersion.stdout.trim() }
    await save(path.join(evidence, "doctor.json"), manifest.doctor)
    if (mode === "doctor") {
      manifest.passed = true
    } else {
      const productionSources = await Promise.all(
        [entrypoint, catalog, core].map(async (location) => ({
          path: location,
          sha256: sha256(await fs.readFile(location)),
        })),
      )
      manifest.production_sources = productionSources
      const profiles = path.join(scratch, "profiles")
      await fs.mkdir(profiles, { recursive: true, mode: 0o700 })
      await fs.mkdir(path.join(scratch, "exports"), { mode: 0o700 })
      const noBin = path.join(scratch, "empty-bin")
      await fs.mkdir(noBin, { mode: 0o700 })
      const missingNtn = path.join(noBin, "missing-ntn")
      const environment = (label: string): NodeJS.ProcessEnv => {
        const isolated = path.join(scratch, "environments", label)
        return {
          ...process.env,
          HOME: path.join(isolated, "home"),
          PATH: noBin,
          NOTION_API_TOKEN: "",
          NTN_SKILLS_NTN_BIN: missingNtn,
          NTN_SKILLS_CONFIG_HOME: path.join(isolated, "config"),
          NTN_SKILLS_HOME: path.join(isolated, "state"),
          NTN_SKILLS_CACHE_HOME: path.join(isolated, "cache"),
          NTN_SKILLS_DATA_HOME: path.join(isolated, "data"),
          XDG_CONFIG_HOME: path.join(isolated, "xdg/config"),
          XDG_STATE_HOME: path.join(isolated, "xdg/state"),
          XDG_CACHE_HOME: path.join(isolated, "xdg/cache"),
          XDG_DATA_HOME: path.join(isolated, "xdg/data"),
          NO_COLOR: "1",
        }
      }
      const env = environment("upgrade")
      manifest.offline_environment = {
        NOTION_API_TOKEN: "",
        NTN_SKILLS_NTN_BIN: missingNtn,
        ntn_exists: await exists(missingNtn),
        PATH: noBin,
        HOME: env.HOME,
        NTN_SKILLS_DATA_HOME: env.NTN_SKILLS_DATA_HOME,
        XDG_DATA_HOME: env.XDG_DATA_HOME,
        NTN_SKILLS_CONFIG_HOME: env.NTN_SKILLS_CONFIG_HOME,
        NTN_SKILLS_HOME: env.NTN_SKILLS_HOME,
        NTN_SKILLS_CACHE_HOME: env.NTN_SKILLS_CACHE_HOME,
        XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
        XDG_STATE_HOME: env.XDG_STATE_HOME,
        XDG_CACHE_HOME: env.XDG_CACHE_HOME,
      }
      check(!(await exists(missingNtn)), "Offline ntn path unexpectedly exists.")
      const artifactPaths: Record<string, string> = {}
      const fixtureFiles: Record<string, { path: string; content: string }[]> = {}
      for (const variant of ["A", "B"] as const) {
        const fixture = [
          {
            path: "SKILL.md",
            content: `---\nname: ${name}\ndescription: Controlled lifecycle fixture for offline built-in package verification.\n---\n# Controlled package ${variant}\n\nActual main bytes for package ${variant}.\n`,
          },
          {
            path: "references/operations.md",
            content: `# Controlled operations ${variant}\n\nDifferent resource bytes supplied by package ${variant}.\n`,
          },
          {
            path: variant === "A" ? "references/removed.md" : "references/new.md",
            content: `# ${variant === "A" ? "Removed with A" : "Added with B"}\n\nControlled resource ${variant}.\n`,
          },
        ]
        fixtureFiles[variant] = fixture
        const fixtureModule = `import { defineBuiltin } from ${JSON.stringify(core)};\nconst encoder = new TextEncoder();\nexport const builtins = [defineBuiltin(${JSON.stringify(id)}, ${JSON.stringify(packageVersion)}, ${JSON.stringify(fixture)}.map(file => ({path: file.path, bytes: encoder.encode(file.content)})))];\n`
        await save(path.join(evidence, "fixtures", `${variant}.json`), {
          id,
          name,
          package_version: packageVersion,
          files: fixture,
        })
        const outfile = path.join(scratch, "artifacts", `ntn-skills-${variant}.mjs`)
        await fs.mkdir(path.dirname(outfile), { recursive: true, mode: 0o700 })
        let overridden = 0
        const build = await Bun.build({
          entrypoints: [entrypoint],
          outdir: path.dirname(outfile),
          naming: path.basename(outfile),
          target: "node",
          format: "esm",
          packages: "bundle",
          minify: false,
          plugins: [
            {
              name: `controlled-builtin-package-${variant}`,
              setup(builder) {
                builder.onLoad({ filter: /[\\/]src[\\/]builtins\.ts$/ }, (args) => {
                  if (path.resolve(args.path) !== catalog) return undefined
                  overridden++
                  return {
                    contents: fixtureModule,
                    loader: "ts",
                    resolveDir: path.dirname(catalog),
                  }
                })
              },
            },
          ],
        })
        await save(path.join(evidence, "builds", `${variant}.json`), {
          success: build.success,
          logs: build.logs.map((log) => String(log)),
          overridden,
          entrypoints: [entrypoint],
          outdir: path.dirname(outfile),
          naming: path.basename(outfile),
          outfile,
          target: "node",
          format: "esm",
          packages: "bundle",
          minify: false,
          plugin_scope: catalog,
          fixture_core_import: core,
          resolveDir: path.dirname(catalog),
          outputs: build.outputs.map((output) => ({
            path: output.path,
            size: output.size,
            kind: output.kind,
          })),
        })
        check(
          build.success && overridden === 1,
          `Package ${variant} must bundle successfully with exactly one catalog override.`,
        )
        const artifact = await fs.readFile(outfile)
        const retained = path.join(evidence, "artifacts", path.basename(outfile))
        await fs.mkdir(path.dirname(retained), { recursive: true, mode: 0o700 })
        await fs.copyFile(outfile, retained)
        artifactPaths[variant] = outfile
        manifest.artifacts[variant] = {
          path: outfile,
          retained_path: retained,
          bytes: artifact.length,
          sha256: sha256(artifact),
          package_version: packageVersion,
        }
      }
      const cli = async (
        variant: "A" | "B",
        label: string,
        args: string[],
        expectedError?: string,
        childEnv = env,
      ) => {
        check(
          args[0] === "builtin" &&
            ["list", "read", "export", "status", "install", "update", "--help"].includes(args[1]!),
          "Only offline builtin CLI commands are permitted.",
        )
        const result = await recordCommand(
          label,
          doctor.node,
          [artifactPaths[variant]!, "ctl", ...args],
          childEnv,
        )
        check(
          !result.timed_out && !result.spawn_error,
          `${label}: CLI did not complete; inspect command evidence.`,
        )
        let decoded: typeof CliResultSchema.Type
        try {
          decoded = Schema.decodeUnknownSync(CliResultSchema)(JSON.parse(result.stdout.trim()))
        } catch {
          throw new Error(
            `${label}: CLI did not return the expected JSON schema; inspect command evidence.`,
          )
        }
        const json = { ...decoded, skills: decoded.skills ?? [] }
        if (expectedError)
          check(
            result.exit === 1 && json.ok === false && json.error?.code === expectedError,
            `${label}: expected exit 1 and ${expectedError}.`,
          )
        else
          check(
            result.exit === 0 && json.ok === true,
            `${label}: expected successful JSON CLI result.`,
          )
        return json
      }
      const info: Record<string, typeof BuiltinInfoSchema.Type> = {}
      for (const variant of ["A", "B"] as const) {
        const helpResult = await recordCommand(
          `${variant}-builtin-help`,
          doctor.node,
          [artifactPaths[variant]!, "ctl", "builtin", "--help"],
          env,
        )
        check(
          helpResult.exit === 0 &&
            helpResult.stdout.includes("install") &&
            helpResult.stdout.includes("update"),
          `${variant}: builtin help must expose install/update.`,
        )
        const listed = await cli(variant, `${variant}-list`, ["builtin", "list"])
        const listedSkill = listed.skills[0]
        check(
          listed.count === 1 && listedSkill?.id === id && listedSkill.name === name,
          `${variant}: expected one exact fixture catalog entry.`,
        )
        check(listedSkill, `${variant}: fixture catalog metadata is missing.`)
        check(
          listedSkill.installation?.state === "not_installed" &&
            listedSkill.installation.path ===
              path.join(env.NTN_SKILLS_DATA_HOME!, "skills", name) &&
            listedSkill.installation.distributions.some(
              (entry) =>
                entry.agent_dir === path.join(env.HOME!, ".agents") && entry.state === "missing",
            ),
          `${variant}: list must include central/default installation status.`,
        )
        info[variant] = listedSkill
        for (const fixture of fixtureFiles[variant]!) {
          const read = await cli(variant, `${variant}-read-${fixture.path.replaceAll("/", "-")}`, [
            "builtin",
            "read",
            id,
            "--path",
            fixture.path,
          ])
          check(
            read.content === fixture.content && read.builtin?.content_id === listedSkill.content_id,
            `${variant}: builtin read must return exact package bytes.`,
          )
        }
        const exportRoot = path.join(scratch, "exports", variant)
        await cli(variant, `${variant}-export`, ["builtin", "export", id, "--output", exportRoot])
        const exported = await capture(`${variant}-portable-export`, exportRoot)
        check(
          await exists(path.join(exportRoot, ".ntn-skills.json")),
          `${variant}: portable export manifest is missing.`,
        )
        for (const fixture of fixtureFiles[variant]!)
          check(
            sha256(await fs.readFile(path.join(exportRoot, fixture.path))) ===
              sha256(fixture.content),
            `${variant}: exported fixture bytes differ.`,
          )
        const artifactEvidence = manifest.artifacts[variant]
        check(artifactEvidence, `${variant}: built artifact evidence is missing.`)
        artifactEvidence.portable_files = files(exported)
      }
      check(
        info.A && info.B,
        "Both A and B catalog entries must be observed before lifecycle verification.",
      )
      check(
        manifest.artifacts.A && manifest.artifacts.B,
        "Both A and B artifact records must exist before lifecycle verification.",
      )
      check(
        info.A.package_version === info.B.package_version &&
          info.A.content_id !== info.B.content_id,
        "Equal package versions must have distinct content IDs from different complete contents.",
      )
      check(
        manifest.artifacts.A.sha256 !== manifest.artifacts.B.sha256,
        "The two built CLI artifacts must differ.",
      )
      manifest.catalogs = info
      const targetFor = (agent: string) => path.join(agent, "skills", name)
      const centralFor = (childEnv: NodeJS.ProcessEnv) => {
        const data =
          childEnv.NTN_SKILLS_DATA_HOME || path.join(childEnv.XDG_DATA_HOME!, "ntn-skills")
        return targetFor(data)
      }
      const status = async (
        variant: "A" | "B",
        label: string,
        state: string,
        agents: string[] = [],
        childEnv = env,
      ) => {
        const result = await cli(
          variant,
          label,
          ["builtin", "status", id, ...agents.flatMap((agent) => ["--agent-dir", agent])],
          undefined,
          childEnv,
        )
        const installation = result.skills[0]?.installation
        check(
          result.count === 1 && installation?.state === state,
          `${label}: expected installation state ${state}.`,
        )
        check(installation, `${label}: installation metadata is missing.`)
        check(
          installation.path === centralFor(childEnv) &&
            installation.data_dir === path.dirname(path.dirname(installation.path)),
          `${label}: installation must identify central storage.`,
        )
        return installation
      }
      const assertLinks = async (
        installation: typeof InstallationSchema.Type,
        agents: string[],
        expectedFiles: readonly FileProof[],
      ) => {
        check(installation.distributions.length === agents.length, "Unexpected distribution count.")
        for (const agent of agents) {
          const destination = targetFor(agent)
          check(
            installation.distributions.some(
              (entry) =>
                entry.agent_dir === agent && entry.path === destination && entry.state === "linked",
            ) &&
              (await fs.lstat(destination)).isSymbolicLink() &&
              (await fs.readlink(destination)) === installation.path &&
              (await fs.realpath(destination)) === installation.path,
            `Distribution must be an owned link to central storage: ${destination}`,
          )
          for (const file of expectedFiles)
            check(
              sha256(await fs.readFile(path.join(destination, file.path))) === file.sha256,
              `Distribution exposes different bytes: ${destination}/${file.path}`,
            )
        }
      }
      const shared = path.join(env.HOME!, ".agents")
      const profile = path.join(profiles, "upgrade")
      const otherProfile = path.join(profiles, "other-agent")
      const initialBefore = await inventory(scratch)
      await status("A", "A-initial-status", "not_installed")
      check(same(initialBefore, await inventory(scratch)), "Initial status must create no roots.")
      const install = await cli("A", "A-install-default", ["builtin", "install", id])
      check(
        install.reused === false && install.installation?.state === "current",
        "A installation must publish a current tree.",
      )
      const target = centralFor(env)
      const before = await capture("upgrade-before-A", target)
      check(
        same(files(before, true), manifest.artifacts.A.portable_files),
        "Installed A complete tree must equal its portable export plus receipt.",
      )
      const aReceipt = Schema.decodeUnknownSync(ReceiptSchema)(
        JSON.parse(await fs.readFile(path.join(target, receiptName), "utf8")),
      )
      check(
        aReceipt.format === "ntn-skills-builtin-install" &&
          aReceipt.version === 2 &&
          aReceipt.id === id &&
          aReceipt.data_dir === env.NTN_SKILLS_DATA_HOME &&
          aReceipt.path === target &&
          !("agent_dir" in JSON.parse(await fs.readFile(path.join(target, receiptName), "utf8"))) &&
          aReceipt.content_id === info.A.content_id &&
          same(aReceipt.files, files(before, true)),
        "A v2 receipt must identify central storage and baseline every exported file.",
      )
      check(install.installation, "Default installation metadata is missing.")
      await assertLinks(install.installation, [shared], files(before, true))
      const addTargets = await cli("A", "A-add-two-targets", [
        "builtin",
        "install",
        id,
        "--agent-dir",
        profile,
        "--agent-dir",
        otherProfile,
      ])
      check(
        addTargets.installation && same(before, await inventory(target)),
        "Adding targets must reuse central bytes.",
      )
      await assertLinks(
        addTargets.installation,
        [shared, profile, otherProfile],
        files(before, true),
      )
      const linksBefore = await Promise.all(
        [shared, profile, otherProfile].map((agent) => inventory(targetFor(agent))),
      )
      await status("A", "A-current-status", "current")
      const available = await status("B", "B-sees-A-status", "update_available")
      check(
        available.installed_content_id === info.A.content_id &&
          available.available_content_id === info.B.content_id,
        "B must compare installed and available content IDs.",
      )
      const oldRoot = before[0]!
      const update = await cli("B", "B-update-registered-targets", ["builtin", "update", id])
      check(
        update.reused === false && update.installation?.state === "current",
        "B update must replace A.",
      )
      const after = await capture("upgrade-after-B", target)
      check(
        same(files(after, true), manifest.artifacts.B.portable_files),
        "Updated B complete tree must equal its portable export plus receipt.",
      )
      check(
        !(await exists(path.join(target, "references/removed.md"))) &&
          (await exists(path.join(target, "references/new.md"))),
        "Complete replacement must remove A resource and publish B resource.",
      )
      const bReceipt = Schema.decodeUnknownSync(ReceiptSchema)(
        JSON.parse(await fs.readFile(path.join(target, receiptName), "utf8")),
      )
      check(
        bReceipt.version === 2 &&
          bReceipt.data_dir === env.NTN_SKILLS_DATA_HOME &&
          bReceipt.path === target &&
          bReceipt.content_id === info.B.content_id &&
          same(bReceipt.files, files(after, true)),
        "B v2 receipt must baseline every exported file in central storage.",
      )
      check(update.installation, "Updated installation metadata is missing.")
      await assertLinks(update.installation, [shared, profile, otherProfile], files(after, true))
      check(
        same(
          linksBefore,
          await Promise.all(
            [shared, profile, otherProfile].map((agent) => inventory(targetFor(agent))),
          ),
        ),
        "Updating central content must preserve every distribution link identity.",
      )
      const transactionRoot = path.join(env.NTN_SKILLS_DATA_HOME!, ".ntn-skills/builtin", name)
      const transactionNames = (await fs.readdir(transactionRoot)).sort()
      const transactions: {
        directory: string
        journal: typeof JournalSchema.Type
        files: FileProof[]
      }[] = []
      for (const transactionName of transactionNames) {
        const directory = path.join(transactionRoot, transactionName)
        const journal = Schema.decodeUnknownSync(JournalSchema)(
          JSON.parse(await fs.readFile(path.join(directory, "journal.json"), "utf8")),
        )
        const entries = await inventory(directory)
        transactions.push({ directory, journal, files: files(entries) })
      }
      const updateTransactions = transactions.filter((item) => item.journal.operation === "update")
      check(updateTransactions.length === 1, "Exactly one actual update transaction must exist.")
      const transaction = updateTransactions[0]!
      const records: (typeof PhaseSchema.Type)[] = []
      for (const file of transaction.files)
        if (file.path.endsWith(".json") && file.path !== "journal.json")
          records.push(
            Schema.decodeUnknownSync(PhaseSchema)(
              JSON.parse(await fs.readFile(path.join(transaction.directory, file.path), "utf8")),
            ),
          )
      for (const phase of ["retained", "published", "trash_started", "trashed", "completed"])
        check(
          records.some(
            (record) =>
              record.phase === phase && record.operation_id === transaction.journal.operation_id,
          ),
          `Production update receipt is missing ${phase}.`,
        )
      check(
        !(await exists(path.join(transaction.directory, "previous"))),
        "The old tree must leave the transaction after system Trash retention.",
      )
      await capture("upgrade-management", path.join(env.NTN_SKILLS_DATA_HOME!, ".ntn-skills"))
      await status("B", "B-current-status", "current")
      for (const action of ["update", "install"] as const) {
        const result = await cli("B", `B-current-${action}`, ["builtin", action, id])
        check(
          result.reused === true && result.installation?.state === "current",
          `Current ${action} must be idempotent.`,
        )
        check(same(after, await inventory(target)), `Current ${action} changed the installed tree.`)
      }
      await capture("upgrade-after-idempotent", target)
      manifest.cases.push(
        {
          case: "same-version-A-to-B-complete-tree-update",
          passed: true,
          transaction: transaction.directory,
        },
        { case: "current-install-and-update-idempotency", passed: true },
        { case: "default-and-two-persisted-distributions", passed: true },
      )
      for (const change of ["modified-main", "added-hidden", "removed-resource"] as const) {
        const changeEnv = environment(change)
        await cli("A", `${change}-install-A`, ["builtin", "install", id], undefined, changeEnv)
        const destination = centralFor(changeEnv)
        await capture(`${change}-original`, destination)
        if (change === "modified-main")
          await fs.appendFile(path.join(destination, "SKILL.md"), "\nOwned local main change.\n")
        else if (change === "added-hidden")
          await fs.writeFile(
            path.join(destination, ".owned-hidden"),
            "Owned hidden local file.\n",
            { flag: "wx", mode: 0o600 },
          )
        else {
          const retainedResource = path.join(scratch, "retained-local-resources", change)
          await fs.mkdir(path.dirname(retainedResource), { recursive: true, mode: 0o700 })
          await fs.rename(path.join(destination, "references/operations.md"), retainedResource)
          await save(path.join(evidence, `${change}-resource-retention.json`), {
            path: retainedResource,
            sha256: sha256(await fs.readFile(retainedResource)),
            method: "rename; no permanent deletion",
          })
        }
        await status("B", `${change}-status`, "modified", [], changeEnv)
        const beforeRejected = await capture(`${change}-before-rejected-update`, destination)
        await cli(
          "B",
          `${change}-update-rejected`,
          ["builtin", "update", id],
          "BUILTIN_MODIFIED",
          changeEnv,
        )
        const afterRejected = await capture(`${change}-after-rejected-update`, destination)
        check(
          same(beforeRejected, afterRejected),
          `${change}: rejected update must preserve the complete target inventory and every byte.`,
        )
        manifest.cases.push({
          case: change,
          expected_error: "BUILTIN_MODIFIED",
          complete_inventory_equal: true,
          passed: true,
        })
      }
      const unmanaged = path.join(profiles, "unmanaged")
      const unmanagedTarget = targetFor(unmanaged)
      await fs.mkdir(path.join(unmanagedTarget, "references"), { recursive: true, mode: 0o700 })
      await fs.writeFile(path.join(unmanagedTarget, "SKILL.md"), "# Owned unmanaged skill\n", {
        flag: "wx",
        mode: 0o600,
      })
      await fs.writeFile(
        path.join(unmanagedTarget, "references/.hidden"),
        "Preserve unmanaged content.\n",
        { flag: "wx", mode: 0o600 },
      )
      const unmanagedEnv = environment("unmanaged")
      const unmanagedStatus = await status(
        "B",
        "unmanaged-status",
        "not_installed",
        [unmanaged],
        unmanagedEnv,
      )
      check(
        unmanagedStatus.distributions.some(
          (entry) => entry.agent_dir === unmanaged && entry.state === "conflict",
        ),
        "Foreign destination must be a distribution conflict.",
      )
      const unmanagedBefore = await capture("unmanaged-before", unmanagedTarget)
      for (const action of ["install", "update"] as const)
        await cli(
          "B",
          `unmanaged-${action}-rejected`,
          ["builtin", action, id, "--agent-dir", unmanaged],
          "BUILTIN_DISTRIBUTION_CONFLICT",
          unmanagedEnv,
        )
      check(
        same(unmanagedBefore, await capture("unmanaged-after", unmanagedTarget)),
        "Unmanaged rejection must preserve the complete target tree.",
      )
      manifest.cases.push({
        case: "foreign-target-install-and-update-rejected",
        expected_error: "BUILTIN_DISTRIBUTION_CONFLICT",
        complete_inventory_equal: true,
        passed: true,
      })
      for (const kind of ["foreign-link", "retargeted-link"] as const) {
        const linkEnv = environment(kind)
        const agent = path.join(profiles, kind)
        const link = targetFor(agent)
        const foreign = path.join(scratch, "foreign-content", kind)
        await fs.mkdir(foreign, { recursive: true, mode: 0o700 })
        await fs.writeFile(path.join(foreign, "SKILL.md"), "# Preserve foreign content\n", {
          flag: "wx",
        })
        if (kind === "retargeted-link") {
          await cli(
            "A",
            `${kind}-install`,
            ["builtin", "install", id, "--agent-dir", agent],
            undefined,
            linkEnv,
          )
          const held = path.join(scratch, "retained-links", kind)
          await fs.mkdir(path.dirname(held), { recursive: true, mode: 0o700 })
          await fs.rename(link, held)
        } else await fs.mkdir(path.dirname(link), { recursive: true, mode: 0o700 })
        await fs.symlink(foreign, link)
        const state = kind === "retargeted-link" ? "update_available" : "not_installed"
        const observed = await status("B", `${kind}-status`, state, [agent], linkEnv)
        check(
          observed.distributions.some((entry) => entry.path === link && entry.state === "conflict"),
          "Foreign links must report a distribution conflict.",
        )
        const preserved = await capture(`${kind}-before`, link)
        const foreignBefore = await capture(`${kind}-foreign-before`, foreign)
        const centralBefore = await capture(`${kind}-central-before`, centralFor(linkEnv))
        for (const action of ["install", "update"] as const)
          await cli(
            "B",
            `${kind}-${action}-rejected`,
            ["builtin", action, id, "--agent-dir", agent],
            "BUILTIN_DISTRIBUTION_CONFLICT",
            linkEnv,
          )
        check(
          same(preserved, await capture(`${kind}-after`, link)) &&
            same(foreignBefore, await capture(`${kind}-foreign-after`, foreign)) &&
            same(centralBefore, await capture(`${kind}-central-after`, centralFor(linkEnv))),
          "Distribution conflict must preserve the link, foreign bytes and central installation.",
        )
        manifest.cases.push({
          case: kind,
          expected_error: "BUILTIN_DISTRIBUTION_CONFLICT",
          complete_inventory_equal: true,
          passed: true,
        })
      }
      const interruptedEnv = environment("interrupted-journal")
      await cli("A", "interrupted-install-A", ["builtin", "install", id], undefined, interruptedEnv)
      const interruptedTarget = centralFor(interruptedEnv)
      const interruptedDirectory = path.join(
        interruptedEnv.NTN_SKILLS_DATA_HOME!,
        ".ntn-skills/builtin",
        name,
        randomUUID(),
      )
      await fs.mkdir(interruptedDirectory, { recursive: true, mode: 0o700 })
      // Deliberately incomplete fixture state; the CLI must fence it without guessing recovery.
      await fs.writeFile(path.join(interruptedDirectory, "journal.json"), "{incomplete", {
        flag: "wx",
      })
      const interruptedBefore = await capture("interrupted-before", interruptedTarget)
      const journalBefore = await capture("interrupted-journal-before", interruptedDirectory)
      await status("B", "interrupted-status", "interrupted", [], interruptedEnv)
      for (const action of ["install", "update"] as const)
        await cli(
          "B",
          `interrupted-${action}-rejected`,
          ["builtin", action, id],
          "BUILTIN_INTERRUPTED",
          interruptedEnv,
        )
      check(
        same(interruptedBefore, await capture("interrupted-after", interruptedTarget)) &&
          same(journalBefore, await capture("interrupted-journal-after", interruptedDirectory)),
        "An ambiguous journal must preserve the complete installed tree and pending transaction.",
      )
      manifest.cases.push({
        case: "incomplete-journal-fixture-fenced",
        expected_error: "BUILTIN_INTERRUPTED",
        complete_inventory_equal: true,
        passed: true,
      })
      for (const source of ["xdg", "home"] as const) {
        const defaultEnv = environment(`default-${source}`)
        delete defaultEnv.NTN_SKILLS_DATA_HOME
        if (source === "home") delete defaultEnv.XDG_DATA_HOME
        const expectedData =
          source === "xdg"
            ? path.join(defaultEnv.XDG_DATA_HOME!, "ntn-skills")
            : path.join(defaultEnv.HOME!, ".local/share/ntn-skills")
        const result = await cli(
          "A",
          `${source}-default-install`,
          ["builtin", "install", id],
          undefined,
          defaultEnv,
        )
        check(
          result.installation?.data_dir === expectedData &&
            result.installation.path === targetFor(expectedData),
          "Default data resolution must stay inside the isolated XDG or HOME root.",
        )
        await assertLinks(
          result.installation,
          [path.join(defaultEnv.HOME!, ".agents")],
          files(before, true),
        )
        manifest.cases.push({ case: `${source}-default-data-root`, passed: true })
      }
      for (const legacyCase of ["matching", "older", "modified"] as const) {
        const legacyEnv = environment(`legacy-${legacyCase}`)
        const agent = path.join(profiles, `legacy-${legacyCase}`)
        const legacyTarget = targetFor(agent)
        await fs.mkdir(path.dirname(legacyTarget), { recursive: true, mode: 0o700 })
        // Legacy receipts baseline the complete portable export, including its generated manifest.
        await fs.cp(path.join(scratch, "exports", "A"), legacyTarget, {
          recursive: true,
          dereference: false,
          errorOnExist: true,
          force: false,
        })
        await save(path.join(legacyTarget, receiptName), {
          format: aReceipt.format,
          version: 1,
          id,
          agent_dir: agent,
          path: legacyTarget,
          package_version: aReceipt.package_version,
          content_id: aReceipt.content_id,
          files: aReceipt.files,
        })
        if (legacyCase === "modified")
          await fs.appendFile(path.join(legacyTarget, "SKILL.md"), "\nPreserve legacy edit.\n")
        const legacyBefore = await capture(`legacy-${legacyCase}-before`, legacyTarget)
        const observed = await status(
          "A",
          `legacy-${legacyCase}-status`,
          "not_installed",
          [agent],
          legacyEnv,
        )
        check(
          observed.distributions.some(
            (entry) => entry.path === legacyTarget && entry.state === "conflict",
          ),
          "Every receipt-v1 directory must remain an unregistered conflict in the v2 runtime.",
        )
        const variant = legacyCase === "older" ? "B" : "A"
        for (const action of ["install", "update"] as const)
          await cli(
            variant,
            `legacy-${legacyCase}-${action}-rejected`,
            ["builtin", action, id, "--agent-dir", agent],
            "BUILTIN_DISTRIBUTION_CONFLICT",
            legacyEnv,
          )
        check(
          same(legacyBefore, await capture(`legacy-${legacyCase}-after`, legacyTarget)) &&
            !(await exists(legacyEnv.NTN_SKILLS_DATA_HOME!)),
          "Legacy rejection must preserve every byte/inode and leave central storage absent.",
        )
        manifest.cases.push({
          case: `legacy-${legacyCase}-preserved`,
          expected_error: "BUILTIN_DISTRIBUTION_CONFLICT",
          complete_inventory_equal: true,
          passed: true,
        })
      }
      for (const field of ["retained_path", "legacy_proof"] as const) {
        const fencedEnv = environment(`legacy-registry-${field}`)
        const agent = path.join(profiles, `legacy-registry-${field}`)
        await cli(
          "A",
          `legacy-registry-${field}-install`,
          ["builtin", "install", id, "--agent-dir", agent],
          undefined,
          fencedEnv,
        )
        const registryPath = path.join(
          fencedEnv.NTN_SKILLS_DATA_HOME!,
          ".ntn-skills/distributions",
          `${name}.json`,
        )
        const registry = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
          distributions: Record<string, unknown>[]
        }
        check(registry.distributions[0], "The fixture must have a real registered distribution.")
        registry.distributions[0][field] =
          field === "retained_path"
            ? path.join(scratch, `retained-${field}`)
            : { dev: "1", ino: "2" }
        await save(registryPath, registry)
        const dataBefore = await capture(
          `legacy-registry-${field}-data-before`,
          fencedEnv.NTN_SKILLS_DATA_HOME!,
        )
        const agentBefore = await capture(`legacy-registry-${field}-agent-before`, agent)
        const observed = await status(
          "A",
          `legacy-registry-${field}-status`,
          "current",
          [agent],
          fencedEnv,
        )
        check(
          observed.distribution_error?.code === "BUILTIN_MIGRATION_REQUIRED",
          "Status must expose legacy registry ownership as migration required.",
        )
        for (const action of ["install", "update"] as const)
          await cli(
            "B",
            `legacy-registry-${field}-${action}-rejected`,
            ["builtin", action, id, "--agent-dir", agent],
            "BUILTIN_MIGRATION_REQUIRED",
            fencedEnv,
          )
        check(
          same(
            dataBefore,
            await capture(`legacy-registry-${field}-data-after`, fencedEnv.NTN_SKILLS_DATA_HOME!),
          ) && same(agentBefore, await capture(`legacy-registry-${field}-agent-after`, agent)),
          "Legacy registry fences must preserve the central tree, journal, registry and distribution links.",
        )
        manifest.cases.push({
          case: `legacy-registry-${field}-fenced`,
          expected_error: "BUILTIN_MIGRATION_REQUIRED",
          complete_inventory_equal: true,
          passed: true,
        })
      }
      const missingProfile = path.join(profiles, "missing-profile")
      const missingEnv = environment("missing")
      const scratchBefore = await inventory(scratch)
      await status(
        "B",
        "missing-default-and-explicit-status",
        "not_installed",
        [missingProfile],
        missingEnv,
      )
      check(
        !(await exists(missingProfile)) && same(scratchBefore, await inventory(scratch)),
        "Missing central/default/explicit status must be read-only and create no roots.",
      )
      await save(path.join(evidence, "missing-profile-read-only.json"), {
        profile: missingProfile,
        home: missingEnv.HOME,
        data_dir: missingEnv.NTN_SKILLS_DATA_HOME,
        before: scratchBefore,
        after: await inventory(scratch),
      })
      manifest.cases.push({ case: "missing-default-and-explicit-status-read-only", passed: true })
      const sourcesAfter = await Promise.all(
        productionSources.map(async ({ path: location }) => ({
          path: location,
          sha256: sha256(await fs.readFile(location)),
        })),
      )
      await save(path.join(evidence, "production-sources.json"), {
        before: productionSources,
        after: sourcesAfter,
      })
      check(
        same(productionSources, sourcesAfter),
        "Production source hashes changed during the proof.",
      )
      await capture("all-profiles-final", profiles)
      const trashRoot = path.join(homedir(), ".Trash")
      let retainedTree: string | undefined
      // Inspect names and inode identities only; open contents only for this owned tree.
      try {
        for (const child of await fs.readdir(trashRoot)) {
          const candidate = path.join(trashRoot, child)
          try {
            const stat = await fs.lstat(candidate, { bigint: true })
            if (String(stat.dev) === oldRoot.dev && String(stat.ino) === oldRoot.ino) {
              retainedTree = candidate
              break
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          }
        }
      } catch (error) {
        await save(path.join(evidence, "trash-retention.json"), {
          observation: "blocked",
          reason: "retention observation blocked",
          error: errorText(error),
          adapter: "production retainInTrash -> /usr/bin/trash",
          operation_id: transaction.journal.operation_id,
          previous_path: path.join(transaction.directory, "previous"),
          system_trash: trashRoot,
          previous_root_identity: { dev: oldRoot.dev, ino: oldRoot.ino },
          transaction_records: records,
        })
        throw new Error(
          `Retention observation blocked: cannot inspect the owned old-tree inode in system Trash. ${errorText(error)}`,
        )
      }
      check(
        retainedTree,
        "Production receipts report Trash success, but the owned old-tree inode could not be located in system Trash.",
      )
      const retained = await capture("upgrade-A-retained-in-system-Trash", retainedTree)
      check(
        same(before, retained),
        "System Trash must retain the complete original A tree, including receipt and inode identities.",
      )
      await save(path.join(evidence, "trash-retention.json"), {
        adapter: "production retainInTrash -> /usr/bin/trash",
        operation_id: transaction.journal.operation_id,
        previous_path: path.join(transaction.directory, "previous"),
        retained_path: retainedTree,
        previous_root_identity: { dev: oldRoot.dev, ino: oldRoot.ino },
        complete_tree_equal: true,
        transaction_records: records,
      })
      manifest.passed = true
    }
  } catch (error) {
    failure = error
    manifest.failure = errorText(error)
    await save(path.join(evidence, "failure.json"), {
      error: errorText(error),
      at: new Date().toISOString(),
    })
    try {
      await fs.cp(scratch, path.join(evidence, "failed-scratch"), {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
      })
    } catch (copyError) {
      manifest.failure_evidence_copy_error = errorText(copyError)
    }
  } finally {
    // Preserve a complete final scratch inventory before its sole cleanup action.
    try {
      await save(path.join(evidence, "scratch-final-inventory.json"), await inventory(scratch))
    } catch (error) {
      manifest.final_inventory_error = errorText(error)
      failure ??= error
      manifest.passed = false
    }
    await save(path.join(evidence, "manifest.json"), {
      ...manifest,
      ended: new Date().toISOString(),
    })
    const cleanup: Record<string, unknown> = {
      scratch,
      evidence,
      permanent_deletion: false,
      adapter: "/usr/bin/trash",
      started: new Date().toISOString(),
    }
    try {
      check(
        process.platform === "darwin",
        "System Trash is unavailable on this platform; scratch retained.",
      )
      await fs.access("/usr/bin/trash", fs.constants.X_OK)
      const result = await recordCommand(
        "cleanup-system-trash",
        "/usr/bin/trash",
        [scratch],
        process.env,
      )
      cleanup.command = result
      cleanup.scratch_exists_after = await exists(scratch)
      check(
        result.exit === 0 && !result.timed_out && !(await exists(scratch)),
        "System Trash cleanup failed; inspect retained scratch and cleanup receipt.",
      )
      cleanup.passed = true
    } catch (error) {
      cleanup.passed = false
      cleanup.error = errorText(error)
      cleanup.retained_scratch = (await exists(scratch)) ? scratch : null
      failure ??= error
      manifest.passed = false
    }
    cleanup.ended = new Date().toISOString()
    await save(path.join(evidence, "cleanup.json"), cleanup)
    await save(path.join(evidence, "manifest.json"), {
      ...manifest,
      ended: new Date().toISOString(),
      cleanup: "cleanup.json",
    })
    console.log(`Builtin lifecycle evidence retained: ${evidence}`)
  }
  if (failure) {
    console.error(errorText(failure))
    process.exitCode = 1
  }
}

const mode = process.argv[2] ?? "run"
if (mode === "--help" || mode === "-h") console.log(help)
else if ((mode === "run" || mode === "doctor") && process.argv.length <= 3) await run(mode)
else {
  console.error(help)
  process.exitCode = 2
}
