import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const roots: string[] = []
const runner = new URL("../../../scripts/verify-projected-builtins.mjs", import.meta.url).pathname
const fixture = `
import { appendFileSync } from "node:fs"
const args = process.argv.slice(2)
appendFileSync(process.env.PROJECTED_TEST_TRACE, JSON.stringify(args) + "\\n")
const scenario = process.env.PROJECTED_TEST_CASE
const files = [{ path: "SKILL.md" }, { path: "references/guide.md" }]
const builtin = { id: "notion/test", notion_name: "test", description: "Current workflow", content_id: "package-a", package_version: "1.0.0" }
const texts = { "SKILL.md": "# Current\\n", "references/guide.md": "Exact reference\\r\\n" }
const emit = (value) => process.stdout.write(JSON.stringify({ ok: true, ...value }) + "\\n")
if (args[0] === "ctl" && args[1] === "builtin" && args[2] === "list") emit({ skills: [builtin] })
else if (args[0] === "ctl" && args[1] === "builtin" && args[2] === "read") {
  const path = args.includes("--path") ? args[args.indexOf("--path") + 1] : "SKILL.md"
  emit({ builtin: { ...builtin, content_id: scenario === "package-switch" && path !== "SKILL.md" ? "package-b" : builtin.content_id }, files, path, content: texts[path] })
} else if (args[0] === "list") {
  const next = args.includes("--cursor")
  emit({ coverage: { exhaustive: scenario !== "incomplete", failed_sources: [] },
    records: next ? [{ name: "test", description: builtin.description, enabled: true, ref: "skill://test/main", locator: { page_id: "page-a" } }] : [],
    has_more: !next, next_cursor: next ? null : "page-2" })
} else if (args[0] === "files") emit({ snapshot_id: "snapshot-a", files })
else if (args[0] === "read") {
  const child = args.includes("--from"), path = child ? args[1] : "SKILL.md"
  emit({ ref: "skill://test/fixed", snapshot_id: child && scenario === "snapshot-switch" ? "snapshot-b" : "snapshot-a",
    path, content: texts[path] + (child && scenario === "drift" ? "changed" : ""),
    effects: { remote_writes: "none" } })
} else throw new Error("Unexpected command: " + JSON.stringify(args))
`

async function run(scenario = "complete", help = false) {
  const root = await mkdtemp(join(tmpdir(), "projected-builtins-"))
  roots.push(root)
  const cli = join(root, "controlled-cli.mjs"),
    trace = join(root, "trace.jsonl")
  await writeFile(cli, fixture)
  const result = spawnSync(
    "node",
    [runner, "--cli", cli, ...(help ? ["--help"] : ["--library", "entry-a"])],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, PROJECTED_TEST_TRACE: trace, PROJECTED_TEST_CASE: scenario },
    },
  )
  if (result.error) throw result.error
  const calls = (await readFile(trace, "utf8").catch(() => "")).trim()
  return {
    ...result,
    calls: calls ? calls.split("\n").map((line) => JSON.parse(line) as string[]) : [],
  }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("projected guidance verifies complete consumer bytes through one fixed selection and reports its proof limits", async () => {
  const result = await run()
  expect(result.status).toBe(0)
  const report = JSON.parse(result.stdout)
  expect(report).toMatchObject({
    ok: true,
    proof_scope: {
      consumer_file_bytes: true,
      discovery_description: true,
      generated_notion_pages: false,
      source_ownership: false,
      paired_runtime: false,
      model_delivery: false,
    },
  })
  expect(report.skills[0].files).toHaveLength(2)
  expect(report.skills[0].files.every((file: { matches: boolean }) => file.matches)).toBe(true)
  expect(result.calls.filter((args) => args[0] === "list")).toEqual([
    ["list", "--library", "entry-a", "--limit", "500", "--json", "--refresh"],
    ["list", "--library", "entry-a", "--limit", "500", "--json", "--cursor", "page-2"],
  ])
  expect(result.calls).toContainEqual([
    "read",
    "references/guide.md",
    "--from",
    "skill://test/fixed",
    "--json",
  ])
  expect(
    result.calls.every(
      (args) =>
        ["list", "read", "files"].includes(args[0]!) ||
        (args[0] === "ctl" && args[1] === "builtin" && ["list", "read"].includes(args[2]!)),
    ),
  ).toBe(true)
})

test.each([
  ["incomplete", "CATALOG_INCOMPLETE"],
  ["snapshot-switch", "SELECTION_CHANGED"],
  ["package-switch", "PACKAGE_SELECTION_CHANGED"],
])(
  "projected guidance rejects %s instead of producing a successful receipt",
  async (scenario, code) => {
    const result = await run(scenario)
    const report = JSON.parse(result.stdout)
    expect(result.status).toBe(1)
    expect(report.ok).toBe(false)
    expect(report.error?.code ?? report.skills[0]?.error?.code).toBe(code)
  },
)

test("projected guidance reports actual byte drift without accepting matching path metadata", async () => {
  const result = await run("drift")
  const report = JSON.parse(result.stdout)
  expect(result.status).toBe(1)
  expect(report.ok).toBe(false)
  expect(
    report.skills[0].files.find((file: { path: string }) => file.path === "references/guide.md"),
  ).toMatchObject({ matches: false })
})

test("projected guidance help never starts the supplied CLI and names the unverified boundaries", async () => {
  const result = await run("complete", true)
  expect(result.status).toBe(0)
  expect(result.calls).toEqual([])
  expect(result.stdout).toContain("consumer file bytes")
  expect(result.stdout).toContain("does not verify generated Notion pages or Source ownership")
})
