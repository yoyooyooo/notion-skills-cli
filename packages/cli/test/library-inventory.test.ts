import { afterAll, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHttpProbe } from "./http-probe.ts"

// Integration owns the production build; these tests consume its exact bundle.
const main = new URL("../dist/ntn-skills.js", import.meta.url).pathname
const probe = createHttpProbe()
const directory = mkdtempSync(join(tmpdir(), "ntn-library-inventory-contract-"))
afterAll(() => probe.close())
async function invoke(args: readonly string[]) {
  const node = Bun.which("node")
  if (node === null) throw new Error("Node is required for the public CLI contract.")
  const before = probe.calls()
  const child = Bun.spawn([node, main, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NOTION_API_TOKEN: "controlled-inventory-offline-token",
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

test("inventory schemas expose explicit repeatable roots/provenance and offline review identities", async () => {
  for (const command of ["local", "remote", "reconcile", "review"]) {
    const result = await invoke(["schema", "ctl", "library", "inventory", command])
    expect(result.exit, result.stdout + result.stderr).toBe(0)
    const parameters: unknown = JSON.parse(result.stdout).schema.parameters
    expect(parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "output", max_occurrences: 1 })]),
    )
    if (command === "local")
      expect(parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "root", min_occurrences: 1, max_occurrences: null }),
          expect.objectContaining({ name: "allow-target", max_occurrences: null }),
          expect.objectContaining({ name: "provenance", max_occurrences: null }),
          expect.objectContaining({ name: "max-bytes", max_occurrences: 1 }),
        ]),
      )
    if (command === "remote")
      expect(parameters).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "audit-run", required: true })]),
      )
  }
}, 20000)

test("public local inventory preserves exact binary bytes and executable modes without network or source writes", async () => {
  const root = join(directory, "fixture")
  mkdirSync(root)
  writeFileSync(join(root, "SKILL.md"), "# Controlled\r\n")
  const bytes = new Uint8Array([0, 255, 13, 10, 3])
  writeFileSync(join(root, "tool.bin"), bytes)
  chmodSync(join(root, "tool.bin"), 0o755)
  const result = await invoke(["ctl", "library", "inventory", "local", "--root", root])
  expect(result.exit, result.stdout + result.stderr).toBe(0)
  const output = JSON.parse(result.stdout)
  expect(output).toMatchObject({ ok: true, coverage: "full", remote_writes: 0, source_writes: 0 })
  expect(output.entities).toHaveLength(1)
  expect(output.entities[0].files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "tool.bin", bytes: 5, mode: "100755", status: "verified" }),
    ]),
  )
  expect(new Uint8Array(readFileSync(join(root, "tool.bin")))).toEqual(bytes)
  expect(readFileSync(join(root, "SKILL.md"), "utf8")).toBe("# Controlled\r\n")
  const partial = await invoke([
    "ctl",
    "library",
    "inventory",
    "local",
    "--root",
    root,
    "--max-entries",
    "1",
  ])
  expect(partial.exit).toBe(4)
  expect(JSON.parse(partial.stdout)).toMatchObject({
    ok: true,
    coverage: "partial",
    remote_writes: 0,
  })
}, 15000)

test("invalid local scopes and incomplete review selectors fail without any provider call", async () => {
  for (const args of [
    ["local", "--root", "relative/path"],
    ["local", "--root", directory, "--max-bytes", "0"],
    ["review", "inventory-" + "a".repeat(64), "--remote", "inventory-" + "b".repeat(64)],
  ]) {
    const result = await invoke(["ctl", "library", "inventory", ...args])
    expect(result.exit).toBe(2)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    })
  }
}, 15000)

test("native inventory recovery exposes the original outer plan, explicit review and readonly reconciliation", async () => {
  for (const command of ["review", "apply", "reconcile"]) {
    const result = await invoke(["schema", "ctl", "library", "inventory", "recovery", command])
    expect(result.exit, result.stdout + result.stderr).toBe(0)
    const parameters: unknown = JSON.parse(result.stdout).schema.parameters
    expect(parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "entry", required: true })]),
    )
    if (command === "apply")
      expect(parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "review", required: true }),
          expect.objectContaining({ name: "review-id", required: true }),
          expect.objectContaining({ name: "dry-run" }),
        ]),
      )
    else
      expect(parameters).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "target", required: true })]),
      )
    const help = await invoke(["ctl", "library", "inventory", "recovery", command, "--help"])
    expect(help.exit, help.stdout + help.stderr).toBe(0)
    expect(help.stdout).toContain("original")
  }
}, 20_000)

test("public import batch commands expose bounded serial preparation, execution and read-only original reconciliation", async () => {
  for (const command of ["prepare-imports", "apply-imports", "reconcile-imports"]) {
    const result = await invoke(["schema", "ctl", "library", "inventory", command])
    expect(result.exit, result.stdout + result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).schema.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "entry", required: true }),
        expect.objectContaining({ name: "output" }),
        expect.objectContaining({ name: "max-requests" }),
      ]),
    )
    const help = await invoke(["ctl", "library", "inventory", command, "--help"])
    expect(help.exit, help.stdout + help.stderr).toBe(0)
    expect(help.stdout).toContain(command)
  }
}, 20_000)

test("invalid and duplicate import batch inputs are rejected before any authentication or remote work", async () => {
  const input = join(directory, "invalid-batch.json")
  const entry = "00000000-0000-4000-8000-000000000003"
  const item = {
    entity_id: "entity",
    approved_manifest: "a".repeat(64),
    decision: { kind: "native" },
  }
  for (const items of [[], [item, item]]) {
    writeFileSync(
      input,
      JSON.stringify({ version: 1, reconciliation_id: "inventory-" + "b".repeat(64), items }),
    )
    const result = await invoke([
      "ctl",
      "library",
      "inventory",
      "prepare-imports",
      "--entry",
      entry,
      "--input",
      input,
      "--output",
      join(directory, "never-created.json"),
    ])
    expect(result.exit).not.toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "INVENTORY_BATCH_INVALID" },
    })
  }
  for (const command of ["apply-imports", "reconcile-imports"]) {
    const result = await invoke(["ctl", "library", "inventory", command, input, "--entry", entry])
    expect(result.exit).not.toBe(0)
    expect(JSON.parse(result.stdout).error.code).toBe("INVENTORY_BATCH_INVALID")
  }
}, 20_000)

test("directory preparation requires explicit native scope and rejects incomplete roots before HTTP", async () => {
  const entry = "00000000-0000-4000-8000-000000000003"
  const base = [
    "ctl",
    "library",
    "inventory",
    "prepare-imports",
    "--entry",
    entry,
    "--output",
    join(directory, "directory-batch.json"),
  ]
  for (const flags of [
    [],
    ["--native"],
    ["--root", directory],
    ["--input", "missing.json", "--root", directory, "--native"],
    ["--input", "missing.json", "--audit-run", "audit-00000000-0000-4000-8000-000000000001"],
    ["--root", "relative/path", "--native"],
  ]) {
    const result = await invoke([...base, ...flags])
    expect(result.exit).toBe(2)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    })
  }
  const empty = join(directory, "empty-native-directory")
  mkdirSync(empty)
  const result = await invoke([...base, "--root", empty, "--native"])
  expect(result.exit).not.toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "INVENTORY_DIRECTORY_EMPTY" },
  })
}, 20_000)
