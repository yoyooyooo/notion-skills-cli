import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHttpProbe } from "./http-probe.ts"
import { repairApplyArgv } from "../../core/src/shared-native-repair.ts"

const main = new URL("../dist/ntn-skills.js", import.meta.url).pathname
const probe = createHttpProbe(),
  root = mkdtempSync(join(tmpdir(), "maintenance-cli-contract-"))
afterAll(() => probe.close())
async function invoke(args: readonly string[]) {
  const runtime = Bun.which("node")
  if (!runtime) throw new Error("The CLI contract needs the supported Node runtime")
  const before = probe.calls()
  const child = Bun.spawn([runtime, main, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NTN_SKILLS_DEV_ROOT: undefined,
      HOME: join(root, "home"),
      NOTION_API_TOKEN: "owned-cli-contract",
      NOTION_API_BASE_URL: probe.origin,
      NTN_SKILLS_HOME: join(root, "state"),
      NTN_SKILLS_CONFIG_HOME: join(root, "config"),
      NTN_SKILLS_CACHE_HOME: join(root, "cache"),
      NTN_SKILLS_DATA_HOME: join(root, "data"),
      NTN_SKILLS_SCHEDULER_ROOT: join(root, "scheduler"),
    },
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(probe.calls()).toBe(before)
  return { stdout, stderr, exit }
}

test("short maintenance command schemas use the same exact handlers as retained historical spelling", async () => {
  for (const path of [
    ["audit", "run"],
    ["file", "add"],
    ["file", "reconcile"],
    ["resource", "replace"],
  ]) {
    const short = await invoke(["schema", "ctl", ...path])
    const historical = await invoke(["schema", "ctl", "library", ...path])
    expect(short.exit, short.stdout + short.stderr).toBe(0)
    expect(historical.exit, historical.stdout + historical.stderr).toBe(0)
    expect(JSON.parse(short.stdout).schema.parameters).toEqual(
      JSON.parse(historical.stdout).schema.parameters,
    )
  }
}, 30000)

test("maintenance operation observation exposes explicit owner selectors without changing publication inputs", async () => {
  for (const action of ["show", "reconcile"]) {
    const result = await invoke(["schema", "ctl", "operation", action])
    expect(result.exit, result.stdout + result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).schema.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "target", required: false, max_occurrences: 1 }),
        expect.objectContaining({ name: "entry", required: false, max_occurrences: 1 }),
      ]),
    )
  }
  const help = await invoke(["ctl", "--help"])
  expect(help.exit).toBe(0)
  for (const name of ["audit", "file", "resource"]) expect(help.stdout).toContain(name)
}, 15000)

test("invalid original IDs and repeated management selectors fail before any request", async () => {
  for (const args of [
    ["ctl", "operation", "show", "body-write-adopt-invalid.hash"],
    ["ctl", "operation", "show", "metadata-write-" + "a".repeat(64), "--target", "not-a-page"],
    [
      "ctl",
      "operation",
      "show",
      "metadata-write-" + "a".repeat(64),
      "--entry",
      "first",
      "--entry",
      "second",
    ],
    [
      "ctl",
      "file",
      "add",
      "not-a-page",
      "references/new.md",
      "--entry",
      "not-an-entry",
      "--input",
      "missing",
    ],
  ]) {
    const result = await invoke(args)
    expect(result.exit).not.toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false })
  }
}, 15000)

test("a repair plan's exact next argv is accepted by the public parser", async () => {
  const argv = repairApplyArgv({
    databaseId: "00000000-0000-4000-8000-000000000003",
    operationId: "skill-repair-main-" + "a".repeat(64),
    page: "00000000-0000-4000-8000-000000000001",
    entry: "historical-missing-main",
  })
  const result = await invoke([...argv.slice(1), "--help"])
  expect(result.exit, result.stdout + result.stderr).toBe(0)
  expect(result.stdout).toContain("--operation")
})
