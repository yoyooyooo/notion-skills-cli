import { beforeAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, mkdir, readFile, realpath, writeFile, cp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { createServer } from "node:http"
import { Effect, Schema } from "effect"
import { Notion } from "../../core/src/notion.ts"
import { property } from "../../core/src/model.ts"
import { LocalSkillInventorySchema } from "../../core/src/shared-inventory-model.ts"
import { sharedCreateFixture } from "../../core/test/shared-create-fixture.ts"
import { id } from "../../core/test/shared-snapshot-fixture.ts"
import { json } from "../../core/test/notion-http-fixture.ts"

const main =
  process.env.NTN_SKILLS_TEST_EXECUTABLE ??
  new URL("../dist/ntn-skills.js", import.meta.url).pathname
beforeAll(async () => {
  if (process.env.NTN_SKILLS_TEST_EXECUTABLE !== undefined) return
  const build = Bun.spawn(["bun", "run", "build"], {
    cwd: new URL("../../../", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ])
  if (exit !== 0) throw new Error(`Production CLI build failed: ${stdout}\n${stderr}`)
}, 120_000)
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
  let transientReadFailures = 0
  let delayedReadTarget: string | undefined
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      const method = request.method
      if (method !== "GET" && method !== "POST" && method !== "PATCH")
        throw new Error(`Unexpected ${method}`)
      if (url.pathname === "/v1/users/me")
        return json(response, 200, {
          object: "user",
          id: id(99),
          type: "bot",
          bot: { workspace_id: id(100) },
        })
      request.setEncoding("utf8")
      let encoded = ""
      for await (const chunk of request) {
        if (typeof chunk !== "string") throw new Error("Expected a decoded HTTP request body")
        encoded += chunk
      }
      const body: unknown = encoded.length === 0 ? undefined : JSON.parse(encoded)
      // Exhaust the existing four-attempt HTTP read policy after the first
      // native POST has been acknowledged. The batch must continue its journal,
      // not create another page or require the caller to restart it.
      if (
        transientReadFailures > 0 &&
        f.nativeCreates().length === 1 &&
        url.pathname === `/v1/data_sources/${f.library.records.data_source_id}/query`
      ) {
        transientReadFailures--
        response.destroy()
        return
      }
      if (
        delayedReadTarget !== undefined &&
        url.pathname === `/v1/data_sources/${f.library.records.data_source_id}/query` &&
        JSON.stringify(body).includes(delayedReadTarget)
      )
        await new Promise((resolve) => setTimeout(resolve, 10000))
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
        return json(response, 200, {
          object: "list",
          results: [],
          has_more: false,
          next_cursor: null,
        })
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
      return json(
        response,
        200,
        await f.run(
          Effect.flatMap(Notion, (api) =>
            api.request(url.pathname.slice(1) + url.search, body, { method }),
          ),
        ),
      )
    } catch (error) {
      const message = String(error)
      errors.push(message)
      return json(response, 400, { object: "error", code: "validation_error", message })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new Error("Expected a loopback HTTP port")
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
    NOTION_API_BASE_URL: `http://127.0.0.1:${address.port}`,
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
    expect(errors, stderr + stdout).toEqual([])
    expect(exits, stderr + stdout).toContain(exit)
    const output = property(JSON.parse(stdout))
    commands.push({ args, exit, output, stderr })
    await writeFile(join(directory, "commands.json"), JSON.stringify(commands, null, 2))
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
    const batchPath = join(directory, "batch.json")
    const censusPaused = await invoke(
      [
        "ctl",
        "library",
        "inventory",
        "prepare-imports",
        "--entry",
        f.library.skills.database_id,
        "--root",
        inputs,
        "--native",
        "--output",
        batchPath,
        "--max-requests",
        "1",
      ],
      [75],
    )
    expect(censusPaused).toMatchObject({
      status: "paused",
      phase: "census",
      remote_writes: 0,
      batch_saved: false,
    })
    expect(f.writes()).toHaveLength(0)
    await expect(readFile(batchPath)).rejects.toMatchObject({ code: "ENOENT" })
    const censusId = field(property(censusPaused.preparation), "audit_run_id")
    const prepared = await invoke([
      "ctl",
      "library",
      "inventory",
      "prepare-imports",
      "--entry",
      f.library.skills.database_id,
      "--root",
      inputs,
      "--native",
      "--audit-run",
      censusId,
      "--output",
      batchPath,
    ])
    expect(prepared.preparation).toMatchObject({
      kind: "native_directories",
      skill_states: "unobserved",
      audit_run_id: censusId,
    })
    const originalBatch = property(JSON.parse(await readFile(batchPath, "utf8")))
    if (!Array.isArray(originalBatch.items)) throw new Error("Expected complete prepared items")
    const inputFingerprints = originalBatch.items.map((item) =>
      field(property(property(item).plan), "input_content_sha256"),
    )
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
    transientReadFailures = 4
    const applied = await invoke(applyArgs)
    expect(applied.all_confirmed).toBe(true)
    expect(applied.counts).toMatchObject({ total: 2, confirmed: 2, reused: 0 })
    expect(applied.counts).toMatchObject({ automatically_recovered: 1 })
    expect(applied.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          read_recovery: { first_error: expect.objectContaining({ code: "NOTION_UNAVAILABLE" }) },
        }),
      ]),
    )
    expect(transientReadFailures).toBe(0)
    expect(hiddenIdentityQueries).toBeGreaterThanOrEqual(2)
    expect(f.nativeCreates()).toHaveLength(2)
    expect([...f.skills.values()].map((page) => f.base.bodies.get(String(page.id))).sort()).toEqual(
      ["### first\n\n<p>Complete first.</p>\n", "### second\n\n<p>Complete second.</p>\n"],
    )
    for (const page of f.skills.values())
      expect(property(property(page.properties).enabled).checkbox).toBe(false)
    const target = [...f.skills.keys()][0]!
    const writesBeforeSdk = f.writes().length
    const sdkProcess = Bun.spawn(
      [
        node,
        "--input-type=module",
        "--eval",
        `
      const sdk = await import(process.argv[1]);
      const metrics = [];
      const options = { database:process.argv[3], metrics:true, onRequestMetrics:value => metrics.push(value) };
      const read = await sdk.readSkill(process.argv[2], { ...options, authoring:true });
      let ordinaryError, offlineAuthoringError;
      try { await sdk.readSkill(process.argv[2], options); } catch (error) { ordinaryError=error.code; }
      try { await sdk.readSkill(process.argv[2], { ...options, authoring:true, offline:true }); } catch (error) { offlineAuthoringError=error.code; }
      console.log(JSON.stringify({ read, ordinaryError, offlineAuthoringError, metrics }));
    `,
        new URL("./sdk.js", pathToFileURL(main)).href,
        target,
        f.library.skills.database_id,
      ],
      {
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [sdkOut, sdkErr, sdkExit] = await Promise.all([
      new Response(sdkProcess.stdout).text(),
      new Response(sdkProcess.stderr).text(),
      sdkProcess.exited,
    ])
    expect(sdkExit, sdkErr + sdkOut).toBe(0)
    const sdkRead = property(JSON.parse(sdkOut))
    expect(sdkRead).toMatchObject({
      read: { record: { enabled: false, locator: { page_id: target } } },
      ordinaryError: "CONTENT_DISABLED",
      offlineAuthoringError: "EXACT_TARGET_REQUIRED",
    })
    expect(sdkRead.metrics).toEqual(
      expect.arrayContaining([expect.objectContaining({ total_requests: 0 })]),
    )
    expect(
      Array.isArray(sdkRead.metrics) &&
        sdkRead.metrics.every((metric) => property(property(metric).requests).notion_write === 0),
    ).toBe(true)
    expect(f.writes()).toHaveLength(writesBeforeSdk)
    f.clear()
    const repeated = await invoke(applyArgs)
    expect(repeated.counts).toMatchObject({ confirmed: 2, reused: 2 })
    expect(f.writes()).toHaveLength(0)
    const delayed = [...f.skills.values()].find((row) =>
      JSON.stringify(row.properties).includes("http-batch-second"),
    )
    if (typeof delayed?.id !== "string") throw new Error("Expected the second imported page")
    delayedReadTarget = delayed.id
    const paused = await invoke([...applyArgs, "--duration-ms", "5000"], [75])
    expect(paused).toMatchObject({
      all_confirmed: false,
      execution_complete: false,
      halted: true,
      interruption: { code: "REQUEST_BUDGET_EXHAUSTED" },
      counts: { total: 2, confirmed: 1, reused: 1, interrupted: 1 },
    })
    expect(f.writes()).toHaveLength(0)
    delayedReadTarget = undefined
    const resumed = await invoke(applyArgs)
    expect(resumed.counts).toMatchObject({ total: 2, confirmed: 2, reused: 2, interrupted: 0 })
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
      inputFingerprints.sort(),
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
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}, 180_000)
