import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, mkdir, readFile, realpath, writeFile, cp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect, Schema } from "effect"
import { Notion } from "../../core/src/notion.ts"
import { property } from "../../core/src/model.ts"
import { LocalSkillInventorySchema } from "../../core/src/shared-inventory-model.ts"
import { sharedCreateFixture } from "../../core/test/shared-create-fixture.ts"
import { id } from "../../core/test/shared-snapshot-fixture.ts"

const main =
  process.env.NTN_SKILLS_TEST_EXECUTABLE ??
  new URL("../dist/ntn-skills.js", import.meta.url).pathname
const field = (value: Record<string, unknown>, name: string) => {
  const result = value[name]
  if (typeof result !== "string") throw new Error(`Expected ${name} in the public CLI response`)
  return result
}

test("public Node batch imports two complete native Skills over HTTP and repeats without writes using real SQLite", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ntn-batch-http-")))
  const state = join(directory, "state")
  const inputs = join(directory, "inputs")
  const f = sharedCreateFixture({
    readback: (wire) =>
      wire.replace(/<h1>(.*?)<\/h1>/u, "### $1").replace(/(Complete \w+\.)/u, "<p>$1</p>\n"),
  })
  f.skills.clear()
  f.files.clear()
  f.base.records.clear()
  const errors: string[] = []
  const commands: unknown[] = []
  let hiddenIdentityQueries = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      try {
        const url = new URL(request.url)
        const method = request.method
        if (method !== "GET" && method !== "POST" && method !== "PATCH")
          throw new Error(`Unexpected ${method}`)
        if (url.pathname === "/v1/users/me")
          return Response.json({
            object: "user",
            id: id(99),
            type: "bot",
            bot: { workspace_id: id(100) },
          })
        const body = method === "GET" ? undefined : await request.json()
        const parent = property(property(body).parent).data_source_id
        const filter = property(property(body).filter)
        if (
          ((url.pathname === `/v1/data_sources/${f.library.skills.data_source_id}/query` &&
            filter.property === f.library.skills.property_ids["Skill ID"]) ||
            (url.pathname === `/v1/data_sources/${f.library.files.data_source_id}/query` &&
              filter.property === f.library.files.property_ids["File ID"])) &&
          property(filter.rich_text).equals !== undefined
        ) {
          hiddenIdentityQueries++
          return Response.json({ object: "list", results: [], has_more: false, next_cursor: null })
        }
        if (
          method === "POST" &&
          url.pathname === "/v1/pages" &&
          (parent === f.library.skills.data_source_id || parent === f.library.files.data_source_id)
        ) {
          // Observe only the real client's saved dispatch. The service never changes client state.
          const db = new Database(join(state, "state.sqlite"), { readonly: true })
          try {
            const rows = db
              .query(
                "SELECT key,payload FROM shared_local_records WHERE category='dispatch' AND retired=0 AND key LIKE 'operations/shared-native-create/%'",
              )
              .all()
              .map(property)
            if (rows.length === 0) throw new Error("Native POST preceded its durable dispatch")
            for (const row of rows)
              f.base.json.set(field(row, "key"), JSON.parse(field(row, "payload")))
          } finally {
            db.close()
          }
        }
        return Response.json(
          await f.run(
            Effect.flatMap(Notion, (api) =>
              api.request(url.pathname.slice(1) + url.search, body, { method }),
            ),
          ),
        )
      } catch (error) {
        const message = String(error)
        errors.push(message)
        return Response.json(
          { object: "error", code: "validation_error", message },
          { status: 400 },
        )
      }
    },
  })
  const node = Bun.which("node")
  if (node === null) throw new Error("Node is required for the public import batch contract")
  const env = {
    ...process.env,
    HOME: join(directory, "home"),
    NTN_SKILLS_HOME: state,
    NTN_SKILLS_CONFIG_HOME: join(directory, "config"),
    NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
    NTN_SKILLS_DATA_HOME: join(directory, "data"),
    NTN_SKILLS_SCHEDULER_ROOT: join(directory, "scheduler"),
    NTN_SKILLS_NOTION_INTERVAL_MS: "100",
    NOTION_API_TOKEN: "controlled-import-batch-token",
    NOTION_WORKSPACE_ID: "",
    NOTION_API_BASE_URL: server.url.origin,
  }
  const invoke = async (args: string[], exits = [0]) => {
    const child = Bun.spawn([node, main, ...args], {
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
    const output = property(JSON.parse(stdout))
    commands.push({ args, exit, output, stderr })
    await writeFile(join(directory, "commands.json"), JSON.stringify(commands, null, 2))
    expect(errors, stderr + stdout).toEqual([])
    expect(exits, stderr + stdout).toContain(exit)
    expect(output.ok, stdout).toBe(true)
    return output
  }
  try {
    for (const name of ["first", "second"]) {
      await mkdir(join(inputs, name), { recursive: true })
      await writeFile(
        join(inputs, name, "SKILL.md"),
        `---\nname: http-batch-${name}\ndescription: Whole Skill batch\n---\n\n# ${name}\n\nComplete ${name}.\n`,
      )
    }
    const audit = await invoke(
      [
        "ctl",
        "library",
        "audit",
        "run",
        "--entry",
        f.library.skills.database_id,
        "--census",
        "--depth",
        "metadata",
      ],
      [0, 3, 4],
    )
    const remote = await invoke(
      ["ctl", "library", "inventory", "remote", "--audit-run", field(audit, "run_id")],
      [0, 4],
    )
    expect(audit).toMatchObject({
      inspection_scope: "registered_table_census",
      skill_states: "unobserved",
      items: [],
    })
    const local = await invoke(["ctl", "library", "inventory", "local", "--root", inputs])
    const review = await invoke(
      [
        "ctl",
        "library",
        "inventory",
        "reconcile",
        "--remote",
        field(remote, "inventory_id"),
        "--local",
        field(local, "inventory_id"),
      ],
      [0, 4],
    )
    const inventory = Schema.decodeUnknownSync(LocalSkillInventorySchema)(local)
    const inputPath = join(directory, "input.json"),
      batchPath = join(directory, "batch.json")
    await writeFile(
      inputPath,
      JSON.stringify({
        version: 1,
        reconciliation_id: field(review, "inventory_id"),
        items: inventory.entities.map((entity) => ({
          entity_id: entity.entity_id,
          approved_manifest: entity.manifest_sha256,
          decision: { kind: "native" },
        })),
      }),
    )
    const prepared = await invoke([
      "ctl",
      "library",
      "inventory",
      "prepare-imports",
      "--entry",
      f.library.skills.database_id,
      "--input",
      inputPath,
      "--output",
      batchPath,
    ])
    expect(prepared.counts).toEqual({ total: 2, prepared: 2, preparation_failed: 0 })
    expect(f.writes()).toHaveLength(0)
    const batchBytes = await readFile(batchPath)
    const applyArgs = [
      "ctl",
      "library",
      "inventory",
      "apply-imports",
      batchPath,
      "--entry",
      f.library.skills.database_id,
    ]
    const applied = await invoke(applyArgs)
    expect(applied.all_confirmed).toBe(true)
    expect(applied.counts).toMatchObject({ total: 2, confirmed: 2, reused: 0 })
    expect(hiddenIdentityQueries).toBeGreaterThanOrEqual(2)
    expect(f.nativeCreates()).toHaveLength(2)
    expect([...f.skills.values()].map((page) => f.base.bodies.get(String(page.id))).sort()).toEqual(
      ["### first\n\n<p>Complete first.</p>\n", "### second\n\n<p>Complete second.</p>\n"],
    )
    for (const page of f.skills.values())
      expect(property(property(page.properties).enabled).checkbox).toBe(false)
    f.clear()
    const repeated = await invoke(applyArgs)
    expect(repeated.counts).toMatchObject({ confirmed: 2, reused: 2 })
    expect(f.writes()).toHaveLength(0)
    const relocated = join(directory, "relocated-inputs")
    await cp(inputs, relocated, { recursive: true })
    const newLocal = await invoke(["ctl", "library", "inventory", "local", "--root", relocated])
    const newAudit = await invoke(
      [
        "ctl",
        "library",
        "audit",
        "run",
        "--entry",
        f.library.skills.database_id,
        "--all",
        "--depth",
        "metadata",
      ],
      [0, 3, 4],
    )
    const newRemote = await invoke(
      ["ctl", "library", "inventory", "remote", "--audit-run", field(newAudit, "run_id")],
      [0, 4],
    )
    const newReview = await invoke(
      [
        "ctl",
        "library",
        "inventory",
        "reconcile",
        "--remote",
        field(newRemote, "inventory_id"),
        "--local",
        field(newLocal, "inventory_id"),
      ],
      [0, 4],
    )
    const newInventory = Schema.decodeUnknownSync(LocalSkillInventorySchema)(newLocal)
    expect(newInventory.entities.map((entity) => entity.input_content_sha256).sort()).toEqual(
      inventory.entities.map((entity) => entity.input_content_sha256).sort(),
    )
    const newInputPath = join(directory, "reuse-input.json"),
      reusePath = join(directory, "reuse-batch.json")
    await writeFile(
      newInputPath,
      JSON.stringify({
        version: 1,
        reconciliation_id: field(newReview, "inventory_id"),
        items: newInventory.entities.map((entity) => ({
          entity_id: entity.entity_id,
          approved_manifest: entity.manifest_sha256,
          decision: { kind: "native" },
        })),
      }),
    )
    f.clear()
    await invoke([
      "ctl",
      "library",
      "inventory",
      "prepare-imports",
      "--entry",
      f.library.skills.database_id,
      "--input",
      newInputPath,
      "--output",
      reusePath,
    ])
    const reusedInput = await invoke([
      "ctl",
      "library",
      "inventory",
      "apply-imports",
      reusePath,
      "--entry",
      f.library.skills.database_id,
    ])
    expect(reusedInput.counts).toMatchObject({ confirmed: 2, reused: 2, failed: 0 })
    expect(f.currentBodies()).toHaveLength(0)
    expect(f.writes()).toHaveLength(0)
    await writeFile(join(inputs, "first", "SKILL.md"), "Changed after completion.\n")
    const reconciled = await invoke([
      "ctl",
      "library",
      "inventory",
      "reconcile-imports",
      batchPath,
      "--entry",
      f.library.skills.database_id,
    ])
    expect(reconciled.all_confirmed).toBe(true)
    expect(f.writes()).toHaveLength(0)
    expect(await readFile(batchPath)).toEqual(batchBytes)
  } finally {
    server.stop(true)
  }
}, 180_000)
