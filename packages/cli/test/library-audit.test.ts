import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHttpProbe } from "./http-probe.ts"

// Integration owns the one production build. Never build from a CLI test.
const main = new URL("../dist/ntn-skills.js", import.meta.url).pathname
const probe = createHttpProbe()
const directory = mkdtempSync(join(tmpdir(), "ntn-library-audit-contract-"))
afterAll(() => probe.close())
async function invoke(args: readonly string[]) {
  const node = Bun.which("node")
  if (node === null) throw new Error("Node is required for the installed CLI contract.")
  const before = probe.calls()
  const child = Bun.spawn([node, main, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NOTION_API_TOKEN: "controlled-audit-offline-token",
      NOTION_API_BASE_URL: probe.origin,
      NTN_SKILLS_HOME: join(directory, "state"),
      NTN_SKILLS_CONFIG_HOME: join(directory, "config"),
      NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
      NTN_SKILLS_DATA_HOME: join(directory, "data"),
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

test("audit production schemas expose explicit scope/depth/budgets, resume and offline report", async () => {
  for (const command of ["run", "resume", "report", "list"]) {
    const result = await invoke(["schema", "ctl", "library", "audit", command])
    expect(result.exit, result.stdout + result.stderr).toBe(0)
    const parameters: unknown = JSON.parse(result.stdout).schema.parameters
    expect(parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "output", max_occurrences: 1 })]),
    )
    if (command === "run" || command === "resume")
      expect(parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "max-requests", max_occurrences: 1 }),
          expect.objectContaining({ name: "max-bytes", max_occurrences: 1 }),
          expect.objectContaining({ name: "duration-ms", max_occurrences: 1 }),
        ]),
      )
    if (command === "run")
      expect(parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "target", required: false }),
          expect.objectContaining({ name: "all", type: "boolean" }),
          expect.objectContaining({ name: "depth", required: false }),
          expect.objectContaining({ name: "graph", required: false }),
          expect.objectContaining({ name: "incremental", type: "boolean" }),
        ]),
      )
  }
}, 20000)

test("audit help distinguishes paused/partial/findings and the offline report contract", async () => {
  const run = await invoke(["ctl", "library", "audit", "run", "--help"])
  expect(run.exit).toBe(0)
  const help = run.stdout.replace(/\s+/gu, " ")
  expect(help).toContain("Exit 0")
  expect(help).toContain("75: paused/resumable")
  expect(help).toContain("byte budget permits one admitted response overshoot")
  expect(help).toContain("No adoption, repair, operation replay")
  const report = await invoke(["ctl", "library", "audit", "report", "--help"])
  expect(report.exit).toBe(0)
  expect(report.stdout.replace(/\s+/gu, " ")).toContain(
    "No Notion/provider calls or credential refresh",
  )
}, 15000)

test("audit invalid scope/budgets and nonexistent offline reports make zero network calls", async () => {
  const entry = "00000000-0000-4000-8000-000000000003"
  for (const args of [
    ["run", "--entry", entry],
    ["run", "--entry", entry, "--all", "--target", entry],
    ["run", "--entry", entry, "--all", "--max-requests", "0"],
    ["run", "--entry", entry, "--all", "--max-requests", "1", "--max-requests", "2"],
    ["resume", "../../config.json"],
  ]) {
    const result = await invoke(["ctl", "library", "audit", ...args])
    expect(result.exit).toBe(2)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    })
  }
  const report = await invoke([
    "ctl",
    "library",
    "audit",
    "report",
    "audit-00000000-0000-4000-8000-000000000001",
  ])
  expect(report.exit).toBe(1)
  expect(JSON.parse(report.stdout)).toMatchObject({
    ok: false,
    error: { code: "AUDIT_RUN_NOT_FOUND" },
  })
  const list = await invoke(["ctl", "library", "audit", "list"])
  expect(list.exit).toBe(0)
  expect(JSON.parse(list.stdout)).toMatchObject({
    ok: true,
    matching_runs: 0,
    runs: [],
    remote_writes: 0,
  })
}, 20000)
