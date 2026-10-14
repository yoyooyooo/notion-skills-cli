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

const repo = resolve(fileURLToPath(new URL("../../../../", import.meta.url)))
const split = process.argv.indexOf("--", 2)
const { values, positionals } = parseArgs({
  args: process.argv.slice(2, split < 0 ? undefined : split),
  options: {
    run: { type: "string" },
    plan: { type: "string" },
    database: { type: "string" },
    input: { type: "string", multiple: true },
  },
  allowPositionals: true,
  strict: true,
})
const mode = positionals[0]
if (positionals.length !== 1 || !values.run || !isAbsolute(values.run))
  throw new Error(
    "Use control.ts MODE --run ABSOLUTE_DIRECTORY [--plan ABSOLUTE_JSON] [-- CLI_ARGS]",
  )
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
} = {
  ...process.env,
  NTN_SKILLS_CONFIG_HOME: join(scratch, "config"),
  NTN_SKILLS_HOME: join(scratch, "state"),
  NTN_SKILLS_CACHE_HOME: join(scratch, "cache"),
  XDG_CONFIG_HOME: join(scratch, "xdg", "config"),
  XDG_STATE_HOME: join(scratch, "xdg", "state"),
  XDG_CACHE_HOME: join(scratch, "xdg", "cache"),
}
// Use the official transport; personal configuration and temporary transports are excluded.
delete env.NTN_SKILLS_NTN_BIN
async function command(args: string[], cwd = repo) {
  if (args.includes("set-token") || args.some((arg) => /^(?:Bearer |secret_|ntn_)/.test(arg)))
    throw new Error("Do not pass credentials to the verification harness.")
  const record = join(evidence, "commands", `${Date.now()}-${randomUUID()}.json`)
  const started = new Date().toISOString()
  const child = Bun.spawn(args, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  let timeout = false
  const timer = setTimeout(
    () => {
      timeout = true
      child.kill()
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
  }
}
async function cli(args: string[]) {
  const result = await command(["bun", "run", "dev", ...args])
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
  return cli(["open", id, "--refresh"])
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
    const result = await cli(["doctor"])
    await save(join(evidence, "doctor.json"), result)
    return result
  }
  if (mode === "cli") {
    check(split >= 0 && process.argv.length > split + 1, "cli requires -- CLI_ARGS")
    const result = await command(["bun", "run", "dev", ...process.argv.slice(split + 1)])
    return { exit: result.exit, evidence: result.record, output: result.output }
  }
  if (mode === "package") {
    const result = await command(["bun", "scripts/package-check.ts"])
    check(
      result.exit === 0 &&
        result.output.smoke?.checks?.includes("complete_pinned_snapshot_unchanged") &&
        result.output.smoke?.checks?.includes("seeded_offline_current_read_open_files_export_list"),
      `Package smoke failed: ${result.record}`,
    )
    const archive = await readFile(result.output.archive)
    check(
      `sha512-${createHash("sha512").update(archive).digest("base64")}` === result.output.integrity,
      "Package archive integrity differs",
    )
    const retained = join(evidence, "package", `${result.output.name}-${result.output.version}.tgz`)
    await mkdir(dirname(retained), { recursive: true, mode: 0o700 })
    await writeFile(retained, archive, { mode: 0o600 })
    const consumerEvidence = join(evidence, "installed-consumer.json")
    await writeFile(consumerEvidence, await readFile(result.output.smoke.evidence), { mode: 0o600 })
    result.output.consumer_evidence = consumerEvidence
    result.output.retained_archive = retained
    await save(join(evidence, "package.json"), result.output)
    return { checked: true, evidence: result.record, checks: result.output.smoke.checks }
  }
  if (mode === "prepare") {
    check(
      values.database && values.input?.length,
      "prepare requires --database and one or more --input directories",
    )
    const entries: Entry[] = []
    for (const input of values.input) {
      const directory = await realpath(resolve(input))
      const dry = await cli(["import", directory, "--database", values.database, "--dry-run"])
      check(
        dry.input_type === "directory",
        "prepare accepts Skill directories; drive single Markdown/ZIP paths with cli mode",
      )
      const files: string[] = []
      for (const name of await readdir(directory, { recursive: true })) {
        const metadata = await lstat(join(directory, name))
        check(!metadata.isSymbolicLink(), "Skill source must not contain symbolic links")
        if (metadata.isFile() && name !== ".ntn-skills.json") files.push(name.split("\\").join("/"))
      }
      files.sort()
      const file_hashes = []
      for (const path of files) {
        const bytes = await readFile(join(directory, path))
        file_hashes.push({ path, bytes: bytes.length, sha256: digest(bytes) })
      }
      const name = (dry.name ?? dry.skill.name).toLowerCase().replaceAll(" ", "-")
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
      const existing = before.skills.filter((row: any) => row.alias === entry.name)
      check(existing.length <= 1, `Ambiguous import target: ${entry.name}`)
      const baseline = existing.length ? await online(existing[0].id) : undefined
      const dry = await cli(["import", entry.input, "--database", selected.database, "--dry-run"])
      const after = await cli(["list", "--database", selected.database, "--refresh"])
      check(
        JSON.stringify(before.skills) === JSON.stringify(after.skills),
        `Dry-run changed remote catalog: ${entry.name}`,
      )
      if (baseline)
        check(
          (await online(baseline.skill.id)).version_id === baseline.version_id,
          `Dry-run changed remote content: ${entry.name}`,
        )
      await save(join(evidence, `${entry.name}-dry-run.json`), {
        result: dry,
        remote_catalog_unchanged: true,
        remote_version_unchanged: Boolean(baseline),
        network_reads_expected: true,
      })
      const result = await cli(["import", entry.input, "--database", selected.database])
      check(
        result.verified && result.skill.alias === entry.name,
        `Import identity failed: ${entry.name}`,
      )
      imported.push({ name: entry.name, result })
      await save(join(evidence, "imports.json"), imported)
      console.log(
        JSON.stringify({
          imported: entry.name,
          action: result.action,
          files: result.files.length,
          page_id: result.skill.id,
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
      const snapshot = await online(first.skill.id)
      check(
        snapshot.version_id === first.version_id &&
          snapshot.skill.alias === entry.name &&
          snapshot.skill.database_id === selected.database,
        `Remote import changed: ${entry.name}`,
      )
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
      const actualChildren = await children(snapshot.skill.id)
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
        page_id: snapshot.skill.id,
        url: `https://www.notion.so/${snapshot.skill.id.replaceAll("-", "")}`,
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
      const result = await cli(["import", entry.input, "--database", selected.database])
      check(
        result.action === "reuse" &&
          result.reused &&
          result.verified &&
          result.skill.id === first.page_id &&
          result.snapshot_id === first.snapshot_id,
        `Reimport changed identity/content: ${entry.name}`,
      )
      repeated.push({
        name: entry.name,
        page_id: result.skill.id,
        snapshot_id: result.snapshot_id,
        action: result.action,
        reused: true,
      })
      await save(join(evidence, "reimports.json"), repeated)
      console.log(JSON.stringify({ reused: entry.name, page_id: result.skill.id }))
    }
    const catalog = await cli(["list", "--database", selected.database, "--refresh"])
    check(
      catalog.coverage.exhaustive && !catalog.coverage.failed_sources.length,
      "Catalog coverage incomplete",
    )
    for (const entry of selected.entries)
      check(
        catalog.skills.filter((row: any) => row.alias === entry.name).length === 1,
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
      transport: "bun run dev with default official ntn; isolated config and state",
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
