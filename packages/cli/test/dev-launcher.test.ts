import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import manifest from "../package.json" with { type: "json" }

const root = fileURLToPath(new URL("../../../", import.meta.url))
const entry =
  process.env.NTN_SKILLS_TEST_EXECUTABLE ?? join(root, "packages/cli/dist/ntn-skills.js")

async function invoke(args: string[], devRoot?: string, cwd = root, path = process.env.PATH) {
  const node = Bun.which("node")
  if (!node) throw new Error("Node is required")
  const env = { ...process.env, NTN_SKILLS_DEV_ROOT: devRoot, PATH: path }
  const child = Bun.spawn([node, entry, ...args], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exit }
}

test("npm entry is the default, and an explicit invalid development root never falls back", async () => {
  const normal = await invoke(["--version"])
  expect(normal.exit, normal.stderr).toBe(0)
  expect(normal.stdout.trim()).toBe(`ntn-skills v${manifest.version}`)
  for (const path of ["", "relative/source", "/absent/ntn-skill-checkout"]) {
    const result = await invoke(["--version"], path)
    expect(result.exit).toBe(2)
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "INVALID_DEV_ROOT" },
    })
    expect(result.stdout).toBe("")
  }
})

test("npm mode needs no Bun and an unavailable explicit source runtime does not fall back", async () => {
  const normal = await invoke(["--version"], undefined, root, "/no-executables")
  expect(normal.exit, normal.stderr).toBe(0)
  const source = await invoke(["--version"], root, root, "/no-executables")
  expect(source.exit).toBe(1)
  expect(JSON.parse(source.stderr)).toMatchObject({
    ok: false,
    error: { code: "DEV_RUNTIME_UNAVAILABLE" },
  })
  expect(source.stdout).toBe("")
})

test("development selection runs Bun with exact arguments and caller cwd, preserving exit status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ntn source selector "))
  const repo = join(dir, "checkout with spaces"),
    cwd = join(dir, "caller with spaces")
  await mkdir(join(repo, "scripts"), { recursive: true })
  await mkdir(cwd)
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({ name: "notion-skills-cli-monorepo" }),
  )
  await writeFile(
    join(repo, "scripts/dev.ts"),
    "console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),bun:!!process.versions.bun}));process.exitCode=7;\n",
  )
  const args = ["read", "skill://literal/a b.md", "$(do-not-execute)", "--flag=one two"]
  const result = await invoke(args, repo, cwd)
  expect(result.exit, result.stderr).toBe(7)
  const observed = JSON.parse(result.stdout)
  expect(observed.args).toEqual(args)
  expect(observed.cwd).toEndWith("caller with spaces")
  expect(observed.bun).toBe(true)
})

test("real source mode runs stateful offline inventory without building or changing the source input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ntn-source-mode-")),
    input = join(dir, "input")
  await mkdir(input)
  const body =
    "---\nname: source-smoke\ndescription: local source launcher\n---\n\n# Source smoke\n"
  await writeFile(join(input, "SKILL.md"), body)
  const before = await stat(join(root, "packages/cli/dist/ntn-skills.js"))
  const node = Bun.which("node")
  if (!node) throw new Error("Node is required")
  const child = Bun.spawn([node, entry, "ctl", "library", "inventory", "local", "--root", input], {
    cwd: dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NTN_SKILLS_DEV_ROOT: root,
      NTN_SKILLS_HOME: join(dir, "state"),
      NTN_SKILLS_CONFIG_HOME: join(dir, "config"),
      NTN_SKILLS_CACHE_HOME: join(dir, "cache"),
      NTN_SKILLS_DATA_HOME: join(dir, "data"),
      NTN_SKILLS_VERIFY_CLI_TIMING_FILE: join(dir, "source-execution.json"),
      NOTION_API_TOKEN: "",
      NOTION_API_BASE_URL: "http://127.0.0.1:1",
    },
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exit, stdout + stderr).toBe(0)
  expect(JSON.parse(stdout)).toMatchObject({
    ok: true,
    coverage: "full",
    remote_writes: 0,
    source_writes: 0,
  })
  expect(await readFile(join(input, "SKILL.md"), "utf8")).toBe(body)
  const after = await stat(join(root, "packages/cli/dist/ntn-skills.js"))
  expect(after.mtimeMs).toBe(before.mtimeMs)
  expect(JSON.parse(await readFile(join(dir, "source-execution.json"), "utf8"))).toMatchObject({
    entry: join(root, "packages/cli/src/main.ts"),
    build_included: false,
    status: "completed",
    exit_code: 0,
  })
}, 30000)
