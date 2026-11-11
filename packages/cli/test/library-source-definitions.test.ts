import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHttpProbe } from "./http-probe.ts"
import { access, chmod, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
const root = new URL("../../../", import.meta.url).pathname
const main = new URL("../dist/ntn-skills.js", import.meta.url).pathname
const node = Bun.which("node")!
const http = createHttpProbe()
afterAll(() => http.close())
beforeAll(async () => {
  const proc = Bun.spawn(["bun", "run", "build"], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [out, error, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code) throw new Error(out + error)
}, 120_000)
async function isolated() {
  const directory = await mkdtemp(join(tmpdir(), "ntn-sources-surface-"))
  const invoke = async (args: string[]) => {
    const requestsBefore = http.calls()
    const child = Bun.spawn([node, main, ...args], {
      cwd: directory,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: join(directory, "home"),
        NOTION_API_TOKEN: "controlled-offline-probe-token",
        NOTION_API_BASE_URL: http.origin,
        NTN_SKILLS_CONFIG_HOME: join(directory, "config"),
        NTN_SKILLS_HOME: join(directory, "state"),
        NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
        NTN_SKILLS_DATA_HOME: join(directory, "data"),
        XDG_STATE_HOME: join(directory, "xdg-state"),
        XDG_CONFIG_HOME: join(directory, "xdg-config"),
        XDG_CACHE_HOME: join(directory, "xdg-cache"),
        XDG_DATA_HOME: join(directory, "xdg-data"),
      },
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return {
      stdout,
      stderr,
      exit,
      online: http.calls() !== requestsBefore,
    }
  }
  return { directory, invoke }
}
test("installed-form source providers report Git, registry and Linear capabilities offline", async () => {
  const f = await isolated(),
    result = await f.invoke(["ctl", "library", "sources", "providers"])
  expect(result.exit, result.stderr).toBe(0)
  expect(result.online).toBe(false)
  const json = JSON.parse(result.stdout)
  expect(json.ok).toBe(true)
  expect(json.items.map((item: { type: string }) => item.type)).toEqual([
    "git",
    "registry",
    "github-market",
    "linear",
  ])
})
test("all current Sources subcommands expose help without probing authentication", async () => {
  const f = await isolated()
  for (const name of [
    "init",
    "attach",
    "list",
    "show",
    "members",
    "put",
    "bind",
    "check",
    "fetch",
    "prepare",
    "apply",
    "reconcile",
    "run",
    "run-list",
    "run-status",
    "admit",
    "admit-apply",
    "admit-reconcile",
    "member-prepare",
    "member-apply",
    "member-reconcile",
  ]) {
    const result = await f.invoke(["ctl", "library", "sources", name, "--help"])
    expect(result.exit, result.stderr).toBe(0)
    expect(result.stdout).toContain("USAGE")
    expect(result.online).toBe(false)
  }
}, 60_000)
test("Sources schema is available offline and prepare requires an explicit target/output", async () => {
  const f = await isolated()
  const result = await f.invoke(["schema", "ctl", "library", "sources", "prepare"])
  expect(result.exit, result.stderr).toBe(0)
  expect(result.online).toBe(false)
  expect(result.stdout).toContain("target")
  expect(result.stdout).toContain("output")
})

test("acknowledged Source continuation has explicit offline review, apply and original reconciliation contracts", async () => {
  const f = await isolated()
  for (const name of ["review", "apply"]) {
    const path = ["ctl", "library", "sources", "recovery", "continuation", name]
    const help = await f.invoke([...path, "--help"])
    expect(help.exit, help.stderr).toBe(0)
    expect(help.online).toBe(false)
    expect(help.stdout).toContain("plan")
    expect(help.stdout).toContain("--entry")
    expect(help.stdout).toContain(name === "review" ? "--target" : "--review-id")
    const schema = await f.invoke(["schema", ...path])
    expect(schema.exit, schema.stderr).toBe(0)
    expect(schema.online).toBe(false)
    expect(schema.stdout).toContain(name === "review" ? "output" : "dry-run")
  }
  const reconcile = await f.invoke(["ctl", "library", "sources", "recovery", "reconcile", "--help"])
  expect(reconcile.exit, reconcile.stderr).toBe(0)
  expect(reconcile.online).toBe(false)
  for (const args of [
    ["review", "original-plan.json", "--entry", "library"],
    ["apply", "original-plan.json", "--entry", "library", "--review", "review.json"],
  ]) {
    const result = await f.invoke([
      "ctl",
      "library",
      "sources",
      "recovery",
      "continuation",
      ...args,
    ])
    expect(result.exit).not.toBe(0)
    expect(result.online).toBe(false)
  }
}, 60_000)

test("source invocation IDs and inventory command contracts are available offline in a real empty Node store", async () => {
  const f = await isolated()
  const runs = await f.invoke(["ctl", "library", "sources", "run-list"])
  expect(runs.exit, runs.stderr).toBe(0)
  expect(runs.online).toBe(false)
  expect(JSON.parse(runs.stdout)).toMatchObject({
    ok: true,
    items: [],
    offline: true,
    remote_writes: 0,
  })
  for (const name of [
    "local",
    "remote",
    "reconcile",
    "review",
    "prepare-import",
    "apply-import",
    "reconcile-import",
  ]) {
    const help = await f.invoke(["ctl", "library", "inventory", name, "--help"])
    expect(help.exit, help.stderr).toBe(0)
    expect(help.online).toBe(false)
    const schema = await f.invoke(["schema", "ctl", "library", "inventory", name])
    expect(schema.exit, schema.stderr).toBe(0)
    expect(schema.online).toBe(false)
  }
}, 60_000)

test("ambiguous Source/update/import intent fails before reading credentials or contacting a library", async () => {
  const f = await isolated()
  const entry = "00000000-0000-4000-8000-000000000001"
  for (const argv of [
    ["sources", "run", "source", "--entry", entry, "--all-bound", "--target", entry],
    ["sources", "run", "source", "--entry", entry, "--all-bound", "--mode", "unknown"],
    ["sources", "run", "source", "--entry", entry, "--all-bound", "--max-requests", "0"],
    [
      "sources",
      "member-prepare",
      "source",
      "--entry",
      entry,
      "--target",
      entry,
      "--member",
      "skills/new",
      "--retain-removed",
      "--output",
      "plan.json",
    ],
    [
      "inventory",
      "prepare-import",
      "--entry",
      entry,
      "--review",
      "review",
      "--entity",
      "entity",
      "--approve-manifest",
      "a".repeat(64),
      "--native",
      "--source",
      "source",
      "--member",
      "member",
      "--output",
      "plan.json",
    ],
    [
      "inventory",
      "prepare-import",
      "--entry",
      entry,
      "--review",
      "review",
      "--entity",
      "entity",
      "--approve-manifest",
      "a".repeat(64),
      "--verify-existing",
      "--enable",
      "--output",
      "plan.json",
    ],
  ]) {
    const result = await f.invoke(["ctl", "library", ...argv])
    expect(result.exit).not.toBe(0)
    expect(result.online).toBe(false)
  }
}, 60_000)
test("a complete Source configuration containing secrets is rejected before contacting Notion", async () => {
  const f = await isolated(),
    file = join(f.directory, "source.json")
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      source_id: "invalid-secret",
      name: "Secret",
      description: "No remote writes",
      enabled: true,
      policy: "manual",
      adapter: { type: "git", url: "https://gitlab.com/group/repo.git", ref: "main" },
      selection: { roots: ["."], include: [], exclude: [], mapping: {} },
      options: { api_key: "controlled-fixture-secret" },
    }),
  )
  const result = await f.invoke([
    "ctl",
    "library",
    "sources",
    "put",
    "--entry",
    "00000000-0000-4000-8000-000000000001",
    "--input",
    file,
    "--expect",
    "absent",
  ])
  expect(result.exit).not.toBe(0)
  expect(result.online).toBe(false)
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "SOURCE_SECRET_FORBIDDEN" },
  })
  expect(result.stdout).not.toContain("controlled-fixture-secret")
})
