import { afterAll, expect, test } from "bun:test"
import { createHttpProbe } from "./http-probe.ts"

// The verification runner builds the production bundle once before CLI tests.
// This test deliberately consumes that exact artifact instead of rebuilding it.
const main = new URL("../dist/ntn-skills.js", import.meta.url).pathname
const probe = createHttpProbe()
afterAll(() => probe.close())

async function invoke(args: readonly string[]) {
  const node = Bun.which("node")
  if (node === null) throw new Error("Node.js is required for the CLI contract test.")
  const before = probe.calls()
  const child = Bun.spawn([node, main, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NOTION_API_TOKEN: "controlled-resource-state-offline-token",
      NOTION_API_BASE_URL: probe.origin,
      NTN_SKILLS_CONFIG_HOME: "/nonexistent/ntn-resource-state-contract/config",
      NTN_SKILLS_HOME: "/nonexistent/ntn-resource-state-contract/state",
      NTN_SKILLS_CACHE_HOME: "/nonexistent/ntn-resource-state-contract/cache",
      NTN_SKILLS_DATA_HOME: "/nonexistent/ntn-resource-state-contract/data",
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

test("resource-state production schema exposes independent candidate, observation and caller-pin inputs offline", async () => {
  const result = await invoke(["schema", "ctl", "library", "state"])
  expect(result.exit, result.stdout + result.stderr).toBe(0)
  const output: unknown = JSON.parse(result.stdout)
  expect(output).toMatchObject({
    ok: true,
    command: ["ctl", "library", "state"],
    schema: {
      parameters: expect.arrayContaining([
        expect.objectContaining({
          name: "target",
          kind: "argument",
          type: "string",
          required: true,
        }),
        expect.objectContaining({ name: "entry", kind: "flag", required: true }),
        expect.objectContaining({ name: "observe", kind: "flag", type: "boolean", default: false }),
        expect.objectContaining({
          name: "candidate",
          kind: "flag",
          type: "string",
          required: false,
          max_occurrences: 1,
        }),
        expect.objectContaining({
          name: "session-pin",
          kind: "flag",
          type: "string",
          required: false,
          max_occurrences: 1,
        }),
      ]),
    },
  })
}, 15000)

test("resource-state production help documents unobserved and explicit pin boundaries offline", async () => {
  const result = await invoke(["ctl", "library", "state", "--help"])
  expect(result.exit, result.stdout + result.stderr).toBe(0)
  const help = result.stdout.replace(/\s+/gu, " ")
  expect(help).toContain("current bodies and unresolved operation payloads stay unobserved")
  expect(help).toContain("without adopting or reconciling")
  expect(help).toContain("--candidate")
  expect(help).toContain("without loading its byte objects")
  expect(help).toContain("semantic read-only Notion capability")
}, 15000)

test("resource-state repeated candidate and session pins fail before online access", async () => {
  for (const flag of ["--candidate", "--session-pin"]) {
    const result = await invoke([
      "ctl",
      "library",
      "state",
      "00000000-0000-4000-8000-000000000001",
      "--entry",
      "00000000-0000-4000-8000-000000000002",
      flag,
      "first",
      flag,
      "second",
    ])
    expect(result.exit).toBe(2)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    })
  }
}, 15000)
