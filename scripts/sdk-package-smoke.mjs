import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { channel } from "node:diagnostics_channel"
import { spawn } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs"
import fsPromises, {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire, syncBuiltinESMExports } from "node:module"
import { isAbsolute, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"

const args = process.argv.slice(2)
if (
  ![6, 8].includes(args.length) ||
  args[0] !== "--archive" ||
  args[2] !== "--fixture" ||
  args[4] !== "--outdir" ||
  ![args[1], args[3], args[5]].every(isAbsolute) ||
  (args.length === 8 &&
    (args[6] !== "--case" || !["view-dynamics", "scalar-inventory"].includes(args[7])))
)
  throw new Error(
    "Usage: node scripts/sdk-package-smoke.mjs --archive /package.tgz --fixture /fixture.json --outdir /new/absolute/directory [--case view-dynamics|scalar-inventory]",
  )
const [archive, fixturePath, root] = [args[1], args[3], args[5]]
const viewDynamicsOnly = args[7] === "view-dynamics"
const scalarInventoryOnly = args[7] === "scalar-inventory"
await mkdir(root, { mode: 0o700 })
const hash = (value) => createHash("sha256").update(value).digest("hex")
function assertNoTransport(reports, traceEnabled) {
  assert.equal(reports.length, 1)
  const metrics = reports[0]
  assert.ok(metrics, "A closed transport boundary must report its zero-attempt ledger")
  assert.equal(metrics.total_requests, 0)
  assert.deepEqual(metrics.requests, {
    notion_metadata: 0,
    notion_body: 0,
    notion_write: 0,
    provider: 0,
  })
  for (const key of [
    "request_bytes",
    "response_bytes",
    "unknown_request_bytes",
    "unknown_response_bytes",
    "in_flight",
    "trace_dropped",
  ])
    assert.equal(metrics[key], 0, key)
  assert.deepEqual(metrics.outcomes, { success: 0, failure: 0, cancelled: 0 })
  assert.deepEqual(metrics.trace, [])
  assert.equal(metrics.trace_enabled, traceEnabled)
}
const fixture = JSON.parse(await readFile(fixturePath, "utf8"))
const env = JSON.parse(await readFile(fixture.env, "utf8"))
const originalCwd = process.cwd()
const originalToken = process.env.NOTION_API_TOKEN
// Setup only, against the owned clone. This is the existing disposable-cache
// retirement operation; the signed payload is preserved and never rewritten.
function fixtureCurrentReceipt(database, key, retirePayload) {
  const db = new DatabaseSync(database, { readOnly: retirePayload === undefined })
  try {
    const query = db.prepare(
      "SELECT category,payload,retired FROM shared_local_records WHERE key=?",
    )
    let row = query.get(key)
    assert.ok(row)
    assert.equal(row.category, "cache")
    if (retirePayload !== undefined) {
      assert.equal(row.retired, 0)
      assert.equal(row.payload, retirePayload)
      const update = db
        .prepare(
          "UPDATE shared_local_records SET retired=1 WHERE key=? AND category='cache' AND retired=0 AND payload=?",
        )
        .run(key, retirePayload)
      assert.equal(update.changes, 1)
      row = query.get(key)
      assert.equal(row.retired, 1)
      assert.equal(row.payload, retirePayload)
    }
    return { key, ...row, receipt: JSON.parse(row.payload) }
  } finally {
    db.close()
  }
}
const cases = []
// Observe the actual Node FileSystem boundary used by Store.readBytes. The
// positive control below must hit node:fs.readFile; other readFile variants are
// recorded too, never assumed absent from a zero HTTP count. Results and errors
// pass through unchanged, and only owned-clone object paths enter this ledger.
let activeObjectProbe
let activeInitializationProbe
let objectReadSequence = 0
const objectReadEvents = []
const objectEvent = (probe, fields) => {
  const event = { version: 1, sequence: ++objectReadSequence, label: probe.label, ...fields }
  objectReadEvents.push(event)
  const ledger = probe.label.startsWith("ownership-")
    ? "ownership-object-reads.jsonl"
    : "entrypoint-object-reads.jsonl"
  fs.appendFileSync(join(root, ledger), JSON.stringify(event) + "\n", {
    mode: 0o600,
  })
  return event
}
function observeObjectRead(api, path) {
  const probe = activeObjectProbe
  if (!probe || typeof path !== "string" || !path.startsWith(probe.objects + "/")) return
  const sha256 = path.slice(probe.objects.length + 1)
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error("Unexpected owned object path")
  const start = objectEvent(probe, { event: "start", api, sha256 })
  probe.pending++
  return (error, bytes) => {
    probe.pending--
    const value = bytes === undefined ? undefined : Buffer.from(bytes)
    objectEvent(probe, {
      event: "end",
      read_id: start.sequence,
      api,
      sha256,
      code: error?.code ?? null,
      bytes: value?.length ?? null,
      content_sha256: value ? hash(value) : null,
    })
  }
}
const originalReadFile = fs.readFile
fs.readFile = function (...args) {
  const initialization = activeInitializationProbe
  if (initialization && initialization.configPath === args[0]) {
    const callback = args.at(-1)
    args[args.length - 1] = function () {
      initialization.config_reads++
      // Store construction is paused before receiving its config bytes. Notion
      // cannot be acquired, and no operation Effect can start at this cutpoint.
      initialization.controller.abort()
      return callback.apply(this, arguments)
    }
  }
  const end = observeObjectRead("node:fs.readFile", args[0])
  if (!end) return originalReadFile.apply(this, args)
  const callback = args.at(-1)
  args[args.length - 1] = function (error, bytes) {
    end(error, bytes)
    return callback.apply(this, arguments)
  }
  try {
    return originalReadFile.apply(this, args)
  } catch (error) {
    end(error)
    throw error
  }
}
const originalReadFileSync = fs.readFileSync
fs.readFileSync = function (...args) {
  const end = observeObjectRead("node:fs.readFileSync", args[0])
  try {
    const bytes = originalReadFileSync.apply(this, args)
    end?.(null, bytes)
    return bytes
  } catch (error) {
    end?.(error)
    throw error
  }
}
const originalPromiseReadFile = fsPromises.readFile
fsPromises.readFile = function (...args) {
  const end = observeObjectRead("node:fs/promises.readFile", args[0])
  const result = originalPromiseReadFile.apply(this, args)
  return !end
    ? result
    : result.then(
        (bytes) => {
          end(null, bytes)
          return bytes
        },
        (error) => {
          end(error)
          throw error
        },
      )
}
syncBuiltinESMExports()
async function traceObjectReads(label, objects, run) {
  assert.equal(activeObjectProbe, undefined, "Object read observations must not overlap")
  const probe = { label, objects, pending: 0 }
  activeObjectProbe = probe
  objectEvent(probe, {
    event: "phase_start",
    coverage: ["node:fs.readFile", "node:fs.readFileSync", "node:fs/promises.readFile"],
  })
  try {
    return await run()
  } finally {
    activeObjectProbe = undefined
    objectEvent(probe, { event: "phase_end", pending_reads: probe.pending })
    assert.equal(probe.pending, 0, "Object reads must settle before the observation closes")
  }
}
function objectReadProof(label, selected, forbidden = []) {
  const events = objectReadEvents.filter((event) => event.label === label)
  const starts = events.filter((event) => event.event === "start")
  const ends = events.filter((event) => event.event === "end")
  assert.equal(events[0]?.event, "phase_start")
  assert.equal(events.at(-1)?.event, "phase_end")
  assert.equal(events.at(-1)?.pending_reads, 0)
  assert.equal(ends.length, starts.length)
  for (const start of starts)
    assert.equal(ends.filter((end) => end.read_id === start.sequence).length, 1)
  for (const file of selected)
    assert.ok(
      ends.some(
        (event) =>
          event.api === "node:fs.readFile" &&
          event.sha256 === file.sha256 &&
          event.code === null &&
          event.bytes === file.bytes &&
          event.content_sha256 === file.sha256,
      ),
      file.path + ": actual Store.readBytes positive control",
    )
  for (const file of forbidden)
    assert.equal(
      starts.filter((event) => event.sha256 === file.sha256).length,
      0,
      file.path + ": unselected object was read",
    )
  return {
    label,
    reads: starts.length,
    object_sha256s: [...new Set(starts.map((event) => event.sha256))],
    verified_source_objects: selected.map((file) => file.sha256),
    forbidden_object_reads: 0,
    coverage:
      "owned Store.readBytes through Node readFile APIs; selected objects are positive controls",
  }
}
// Effect memoizes the Fetch reference on its first use. Install one dispatcher
// before importing the installed SDK, then scope only the controlled source map.
const originalFetch = globalThis.fetch
let activeSourceProbe
const sourceTransportEvents = []
function sourceTransportEvent(probe, fields) {
  const event = { version: 1, label: probe.label, ...fields }
  sourceTransportEvents.push(event)
  fs.appendFileSync(join(root, "ownership-source-requests.jsonl"), JSON.stringify(event) + "\n", {
    mode: 0o600,
  })
}
async function controlledSourceFetch(input, init) {
  if (activeInitializationProbe) activeInitializationProbe.fetch_calls++
  const probe = activeSourceProbe
  if (!probe) return originalFetch(input, init)
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.origin === probe.notionOrigin) return originalFetch(input, init)
  const file = probe.files.find((candidate) => candidate.url === url.href)
  sourceTransportEvent(probe, {
    event: "request",
    url: url.href,
    path: file?.path ?? null,
    sha256: file?.sha256 ?? null,
  })
  assert.ok(file, "Unexpected request outside the controlled ownership transport")
  assert.equal(init?.method ?? (input instanceof Request ? input.method : "GET"), "GET")
  assert.equal(file.role, "required", "An ownership-suppressed source reached the transport")
  probe.pending++
  try {
    const bytes = await readFile(file.source_file)
    assert.equal(bytes.length, file.bytes)
    assert.equal(hash(bytes), file.sha256)
    init?.signal?.throwIfAborted()
    sourceTransportEvent(probe, {
      event: "response",
      path: file.path,
      sha256: file.sha256,
      bytes: bytes.length,
      content_sha256: hash(bytes),
    })
    return new Response(bytes, { headers: { "content-length": String(bytes.length) } })
  } finally {
    probe.pending--
  }
}
async function traceSourceRequests(label, notionOrigin, files, run) {
  assert.equal(activeSourceProbe, undefined)
  const probe = { label, notionOrigin, files, pending: 0 }
  activeSourceProbe = probe
  sourceTransportEvent(probe, { event: "phase_start", transport: "controlled-fetch-response" })
  try {
    return await run()
  } finally {
    activeSourceProbe = undefined
    sourceTransportEvent(probe, { event: "phase_end", pending: probe.pending })
    assert.equal(probe.pending, 0)
  }
}
function sourceTransportProof(label, expected, excluded) {
  const events = sourceTransportEvents.filter((event) => event.label === label)
  const requests = events.filter((event) => event.event === "request")
  const responses = events.filter((event) => event.event === "response")
  assert.equal(events[0]?.event, "phase_start")
  assert.equal(events.at(-1)?.event, "phase_end")
  assert.equal(events.at(-1)?.pending, 0)
  assert.deepEqual(
    requests.map((event) => event.sha256).sort(),
    expected.map((file) => file.sha256).sort(),
  )
  assert.equal(responses.length, requests.length)
  for (const file of expected)
    assert.ok(
      responses.some(
        (event) =>
          event.sha256 === file.sha256 &&
          event.content_sha256 === file.sha256 &&
          event.bytes === file.bytes,
      ),
      file.path + ": controlled source response positive control",
    )
  for (const file of excluded)
    assert.equal(requests.filter((event) => event.sha256 === file.sha256).length, 0)
  return {
    transport: "controlled-fetch-response",
    requests: requests.length,
    response_bytes: responses.reduce((total, event) => total + event.bytes, 0),
    verified_paths: expected.map((file) => file.path),
    excluded_requests: 0,
  }
}
let commandNumber = 0
async function command(argv, options = {}) {
  const started = performance.now()
  const child = spawn(argv[0], argv.slice(1), {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  })
  let stdout = "",
    stderr = ""
  child.stdout.setEncoding("utf8").on("data", (text) => {
    stdout += text
  })
  child.stderr.setEncoding("utf8").on("data", (text) => {
    stderr += text
  })
  const [code, signal] = await once(child, "close")
  const result = { code, signal, stdout, stderr, elapsed_ms: performance.now() - started }
  await writeFile(
    join(root, `command-${++commandNumber}.json`),
    JSON.stringify({ argv, ...result }, null, 2) + "\n",
    { mode: 0o600 },
  )
  return result
}
async function test(name, run) {
  if (
    (viewDynamicsOnly || scalarInventoryOnly) &&
    name !== "scalar logical reads share one complete projected inventory within each refresh"
  )
    return
  const started = performance.now()
  try {
    const evidence = await run()
    cases.push({ name, status: "passed", elapsed_ms: performance.now() - started, evidence })
  } catch (error) {
    cases.push({
      name,
      status: "failed",
      elapsed_ms: performance.now() - started,
      error: String(error),
    })
  }
  console.log(`${cases.at(-1).status}: ${name}`)
}
await writeFile(
  join(root, "package.json"),
  JSON.stringify(
    {
      private: true,
      type: "module",
      dependencies: { "ntn-skills": `file:${archive}` },
      devDependencies: { typescript: "5.9.3" },
    },
    null,
    2,
  ) + "\n",
)
globalThis.fetch = controlledSourceFetch
try {
  const installed = await command(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"])
  if (installed.code !== 0) throw new Error("Independent npm install failed; see command-1.json")
  const require = createRequire(join(root, "package.json"))
  const sdkPath = require.resolve("ntn-skills/sdk")
  const sdk = await import(pathToFileURL(sdkPath).href)
  const cli = require.resolve("ntn-skills/dist/ntn-skills.js")
  const manifest = require("ntn-skills/package.json")
  const options = { env, cwd: fixture.cwd, metrics: true }
  const input = (targets, purpose = "use") => ({
    version: 1,
    targets,
    purpose,
    freshness: { policy: "offline" },
  })
  const invokeCli = async (argv, cwd = fixture.cwd, operationEnv = env) => {
    const result = await command([process.execPath, cli, ...argv], {
      cwd,
      env: { ...operationEnv, PATH: process.env.PATH },
    })
    return { ...result, value: JSON.parse(result.stdout) }
  }
  const withoutMetrics = (value) => {
    const copy = structuredClone(value)
    delete copy.ok
    delete copy.request_metrics
    if (copy.preparation_metrics)
      for (const field of [
        "derived_cache_hits",
        "derived_cache_misses",
        "elapsed_ms",
        "required_ready_ms",
        "root_ready_ms",
      ])
        delete copy.preparation_metrics[field]
    // This is the byte size of each transport envelope, not the source text.
    if (copy.usage) delete copy.usage.context_bytes
    return copy
  }

  if (fixture.catalog)
    await test("installed list/catalog SDK and CLI preserve complete metadata pagination and Default View", async () => {
      const reports = []
      const selection = {
        ...options,
        database: fixture.database,
        offline: true,
        onRequestMetrics: (value) => reports.push(value),
      }
      const observed = await traceObjectReads(
        "metadata-directory",
        join(fixture.cwd, "state", "objects"),
        async () => {
          const complete = await sdk.listCatalog(selection)
          assert.deepEqual(
            complete.records.map((record) => record.id),
            fixture.catalog_records,
          )
          const view = await sdk.listCatalog({ ...selection, defaultView: true })
          assert.deepEqual(
            view.records.map((record) => record.id),
            fixture.default_view.records.map((record) => record.id),
          )
          assert.equal(view.view.id, fixture.default_view.id)
          assert.equal(view.capability_directory, true)
          const first = await sdk.listSkills({ ...selection, limit: 2 })
          assert.equal(first.count, 2)
          assert.equal(first.total_count, complete.count)
          assert.equal(first.has_more, true)
          const records = [...first.records]
          let page = first
          while (page.has_more) {
            page = await sdk.listSkills({ ...selection, limit: 2, cursor: page.next_cursor })
            records.push(...page.records)
          }
          assert.equal(page.next_cursor, null)
          assert.deepEqual(records, complete.records)
          await assert.rejects(
            sdk.listSkills({ ...selection, query: "different query", cursor: first.next_cursor }),
            { code: "LIST_CURSOR_STALE" },
          )
          const query = await sdk.listSkills({ ...selection, query: "fixture resources" })
          assert.equal(query.count, 1)
          assert.equal(query.has_more, false)
          const unscoped = await sdk.listSkills({ ...options, offline: true })
          assert.equal(unscoped.has_more, false)
          assert.equal(unscoped.coverage.exhaustive, false)
          const record = fixture.snapshots[0].record
          const namedRef = `skill://${encodeURIComponent(record.name)}/SKILL.md`
          const aliasRef = `skill://${encodeURIComponent(record.alias)}/SKILL.md`
          const selected = sdk.resolveCatalogReference(namedRef, complete)
          assert.deepEqual(selected, { record, scope: fixture.scope, ref: record.ref })
          assert.deepEqual(sdk.resolveCatalogReference(aliasRef, complete), selected)
          for (const projected of [view, first, query, unscoped])
            assert.throws(() => sdk.resolveCatalogReference(namedRef, projected), {
              code: "CATALOG_INCOMPLETE",
            })
          assert.throws(() => sdk.resolveCatalogReference("missing-name", complete), {
            code: "SKILL_NOT_FOUND",
          })
          return { complete, first, view, selected, namedRef, aliasRef }
        },
      )
      const objectProof = objectReadProof("metadata-directory", [])
      assert.equal(objectProof.reads, 0, "Metadata discovery must not read any body object")
      for (const report of reports) {
        assert.ok(report)
        assert.equal(report.total_requests, 0)
        assert.equal(report.trace_enabled, true)
        assert.equal(report.trace_dropped, 0)
      }
      const cliPage = await invokeCli([
        "list",
        "--database",
        fixture.database,
        "--offline",
        "--json",
        "--limit",
        "2",
      ])
      assert.equal(cliPage.code, 0)
      assert.deepEqual(cliPage.value.records, observed.first.records)
      assert.equal(cliPage.value.next_cursor, observed.first.next_cursor)
      const inspect = await invokeCli(["read", fixture.roots[0], "--offline", "--json"])
      assert.equal(inspect.code, 0)
      const use = await invokeCli(["use", fixture.roots[0], "--offline", "--json"])
      assert.equal(use.code, 0)
      const { ok: _ok, ...proof } = use.value
      const used = await sdk.decodeConsumeResult(proof)
      assert.equal(used.status, "ready")
      assert.deepEqual(
        used.preparation.nodes
          .filter((node) => node.state === "prepared")
          .map((node) => node.id)
          .sort(),
        [fixture.snapshots[0].record.id, fixture.snapshots[3].record.id].sort(),
      )
      assert.equal(
        used.preparation.nodes.find((node) => node.id === fixture.snapshots[0].record.id).content,
        inspect.value.content,
      )
      const selectedInput = input([observed.selected.ref])
      const selected = await sdk.consume(selectedInput, options)
      await sdk.decodeConsumeResult(selected, selectedInput)
      assert.equal(selected.status, "ready")
      assert.equal(selected.preparation.roots[0].target, observed.selected.ref)
      assert.deepEqual(selected.preparation.required_closure, used.preparation.required_closure)
      assert.deepEqual(selected.entries, used.entries)
      for (const ref of [observed.namedRef, observed.aliasRef]) {
        const direct = await sdk.consume(input([ref]), { ...options, database: fixture.database })
        assert.equal(direct.status, "failed", "Machine consume remains an exact-target contract")
        assert.equal(direct.error.code, "EXACT_TARGET_REQUIRED")
        const named = await invokeCli([
          "use",
          ref,
          "--database",
          fixture.database,
          "--offline",
          "--json",
        ])
        assert.equal(named.code, 0)
        assert.equal(named.value.preparation.roots[0].target, observed.selected.ref)
        assert.deepEqual(
          named.value.preparation.required_closure,
          used.preparation.required_closure,
        )
        const read = await invokeCli([
          "read",
          ref,
          "--database",
          fixture.database,
          "--offline",
          "--json",
        ])
        assert.equal(read.code, 0)
        assert.equal(read.value.content, inspect.value.content)
        for (const command of ["read", "use"]) {
          const partial = await invokeCli([command, ref, "--offline", "--json"])
          assert.equal(partial.code, 1)
          assert.equal(partial.value.error.code, "CATALOG_INCOMPLETE")
        }
      }
      return {
        catalog_count: observed.complete.count,
        default_view_count: observed.view.count,
        pagination_count: observed.first.count,
        name_selection: {
          input: observed.namedRef,
          alias: observed.aliasRef,
          canonical: observed.selected.ref,
        },
        object_reads: objectProof,
        request_metrics: reports,
      }
    })

  await test("installed SDK versions and generated declaration closure", async () => {
    assert.equal(sdk.SDK_VERSION, 1)
    assert.equal(sdk.CONSUMER_CONTRACT_VERSION, 1)
    assert.equal(sdk.RESOURCE_READ_CONTRACT_VERSION, 1)
    assert.equal(sdk.READ_OUTPUT_PROOF_VERSION, 1)
    assert.equal(sdk.PACKAGE_VERSION, manifest.version)
    assert.equal(sdk.parseDuration("2m"), 120000)
    assert.throws(
      () => sdk.parseDuration("2ms"),
      (error) => error instanceof sdk.SkillsError && error.code === "INVALID_ARGUMENT",
    )
    await writeFile(
      join(root, "consumer.ts"),
      `import { consume, readSkill, readResources, listCatalog, listSkills, listSkill, resolveCatalogReference, decodeConsumeResult, decodeResourceReadResult, SDK_VERSION, RESOURCE_READ_CONTRACT_VERSION, READ_OUTPUT_PROOF_VERSION, parseDuration, type ConsumeInput, type ConsumeResult, type ReadSkillResult, type ResourceReadInput, type ResourceReadResult, type RequestMetricsSnapshot, type ListCatalogResult, type ListSkillsResult, type ListSkillResult } from "ntn-skills/sdk";
  const input = { version: 1, targets: ["page"], purpose: "use" } satisfies ConsumeInput;
  const version: 1 = SDK_VERSION;
  const received: Promise<ConsumeResult> = consume(input, { cwd: ".", env: {}, signal: new AbortController().signal, metrics: true, execution: { priority: "prefetch", queueBudgetMs: 100, timeBudgetMs: 200, rateShare: .1 }, onRequestMetrics: (snapshot: RequestMetricsSnapshot | null) => void snapshot });
  const read: Promise<ReadSkillResult> = readSkill("file", { offline: true, metrics: true, maxAge: parseDuration("1s") });
  const resources = { version: 1, refs: ["fixed-file"], budget: { maxFiles: 16, maxBytes: 1048576, timeBudgetMs: 30000 } } satisfies ResourceReadInput;
  const catalog: Promise<ListCatalogResult> = listCatalog({ cwd: ".", env: {}, defaultView: true, offline: true });
  const page: Promise<ListSkillsResult> = listSkills({ cwd: ".", env: {}, query: "review", limit: 20, cursor: "returned-cursor" });
  const files: Promise<ListSkillResult> = listSkill("skill://name/?snapshot=returned-pin", { cwd: ".", env: {}, offline: true, metrics: true });
  const selection = (directory: ListCatalogResult) => resolveCatalogReference("skill://name/SKILL.md", directory);
  const resourceVersion: 1 = RESOURCE_READ_CONTRACT_VERSION;
  const outputProofVersion: 1 = READ_OUTPUT_PROOF_VERSION;
  const outputProof = (result: ReadSkillResult) => "output" in result ? [result.sha256, result.entrypoint_sha256] : [];
  const batch: Promise<ResourceReadResult> = readResources(resources, { cwd: ".", env: {}, offline: true, metrics: true, signal: new AbortController().signal });
  void [received, read, batch, catalog, page, files, selection, decodeConsumeResult({}, input), decodeResourceReadResult({}, resources), version, resourceVersion, outputProofVersion, outputProof];
  // @ts-expect-error purpose is a closed protocol domain
  const wrong: ConsumeInput = { version: 1, targets: [], purpose: "activate" };
  void wrong;
  `,
    )
    const checked = await command([
      process.execPath,
      require.resolve("typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--target",
      "ES2023",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "consumer.ts",
    ])
    assert.equal(checked.code, 0, checked.stdout + checked.stderr)
    return {
      sdk_version: sdk.SDK_VERSION,
      resource_read_contract_version: sdk.RESOURCE_READ_CONTRACT_VERSION,
      package_version: sdk.PACKAGE_VERSION,
      sdk_sha256: hash(await readFile(sdkPath)),
    }
  })

  let ready
  for (const count of [1, 2, 3])
    await test(`${count} roots share one Required node, CLI and SDK agree`, async () => {
      const reports = []
      const request = input(fixture.roots.slice(0, count))
      const result = await sdk.consume(request, {
        ...options,
        onRequestMetrics: (value) => reports.push(value),
      })
      assert.equal(result.status, "ready", JSON.stringify(result))
      assert.equal(reports.length, 1)
      assert.equal(reports[0].total_requests, 0)
      assert.equal(reports[0].in_flight, 0)
      assert.equal(reports[0].trace_enabled, true)
      assert.equal(result.entries.length, count + 1)
      const legacy = await invokeCli([
        "ctl",
        "prepare",
        ...request.targets,
        "--offline",
        "--metrics",
      ])
      assert.equal(legacy.code, 0, legacy.stderr)
      assert.equal(legacy.value.request_metrics.total_requests, 0)
      assert.deepEqual(withoutMetrics(result.preparation), withoutMetrics(legacy.value))
      for (const node of result.preparation.nodes.filter((node) => node.state === "prepared")) {
        const [read, old] = await Promise.all([
          sdk.readSkill(node.ref, { ...options, offline: true }),
          invokeCli(["read", node.ref, "--offline"]),
        ])
        assert.equal(old.code, 0)
        assert.deepEqual(read, withoutMetrics(old.value))
        assert.equal(node.content, read.content)
        assert.equal(hash(Buffer.from(read.content)), node.body_sha256)
      }
      ready = result
      await writeFile(join(root, `ready-${count}.json`), JSON.stringify(result, null, 2) + "\n", {
        mode: 0o600,
      })
      await writeFile(
        join(root, `bindings-${count}.json`),
        JSON.stringify(result.preparation.session_bindings, null, 2) + "\n",
        { mode: 0o600 },
      )
      return {
        prepared_nodes: result.entries.length,
        source_http: reports[0].total_requests,
        sdk_calls: 1,
      }
    })

  await test("fixed names list only their manifest and returned resources do not prepare the main", async () => {
    const snapshot = fixture.snapshots[0]
    const resource = snapshot.files.find((file) => file.sha256 === fixture.resource.sha256)
    const main = snapshot.files.find((file) => file.path === snapshot.entrypoint)
    assert.ok(resource && main)
    const cwd = join(root, "fixed-name-manifest")
    await cp(fixture.cwd, cwd, { recursive: true, errorOnExist: true, force: false })
    const objects = join(cwd, env.NTN_SKILLS_HOME, "objects")
    const preservedObjects = join(root, "fixed-name-preserved-objects")
    await rename(objects, preservedObjects)
    const reports = []
    const fixedOptions = {
      ...options,
      cwd,
      database: fixture.database,
      offline: true,
      onRequestMetrics: (value) => reports.push(value),
    }
    const named = (name) =>
      `skill://${encodeURIComponent(name)}/${resource.path}?snapshot=${snapshot.snapshot_id}`
    const listed = await traceObjectReads("fixed-name-manifest", objects, async () => {
      const value = await sdk.listSkill(named(snapshot.record.name), fixedOptions)
      assert.equal(value.snapshot_id, snapshot.snapshot_id)
      assert.equal(value.version_id, snapshot.version_id)
      assert.equal(value.scope, fixture.scope)
      assert.equal(value.record.id, snapshot.record.id)
      assert.deepEqual(value.files, [
        { path: resource.path, bytes: resource.bytes, ref: fixture.resource.ref },
      ])
      for (const ref of [named(snapshot.record.alias), fixture.resource.ref])
        assert.deepEqual((await sdk.listSkill(ref, fixedOptions)).files, value.files)
      await assert.rejects(sdk.listSkill(named("wrong-historical-name"), fixedOptions), {
        code: "SNAPSHOT_CONFLICT",
      })
      await assert.rejects(
        sdk.listSkill(`skill://missing/?snapshot=s_${"e".repeat(64)}`, fixedOptions),
        {
          code: "SNAPSHOT_MISSING",
        },
      )
      return value
    })
    const manifestProof = objectReadProof("fixed-name-manifest", [])
    assert.equal(manifestProof.reads, 0, "Manifest-only name selection cannot open a body object")
    await rename(preservedObjects, objects)
    const read = await traceObjectReads("fixed-name-selected-resource", objects, () =>
      sdk.readResources({ version: 1, refs: [listed.files[0].ref] }, fixedOptions),
    )
    assert.equal(read.status, "ready", JSON.stringify(read))
    assert.equal(read.files.length, 1)
    assert.equal(read.files[0].sha256, resource.sha256)
    const resourceProof = objectReadProof("fixed-name-selected-resource", [resource], [main])
    for (const report of reports) {
      assert.ok(report)
      assert.equal(report.total_requests, 0)
      assert.equal(report.trace_dropped, 0)
      assert.equal(report.in_flight, 0)
    }
    return {
      name: snapshot.record.name,
      alias: snapshot.record.alias,
      manifest: manifestProof,
      resource: resourceProof,
      request_metrics: reports,
    }
  })

  await test("fixed binary resource output preserves Core shape and exact bytes", async () => {
    const reports = []
    const result = await sdk.readSkill(fixture.resource.ref, {
      ...options,
      offline: true,
      output: "sdk-resource.bin",
      onRequestMetrics: (value) => reports.push(value),
    })
    assert.equal("ok" in result, false)
    assert.equal(result.output, join(fixture.cwd, "sdk-resource.bin"))
    assert.equal(hash(await readFile(result.output)), fixture.resource.sha256)
    assert.equal(result.sha256, fixture.resource.sha256)
    const snapshotId = new URL(fixture.resource.ref).searchParams.get("snapshot")
    const snapshot = fixture.snapshots.find((value) => value.snapshot_id === snapshotId)
    assert.ok(snapshot)
    const main = snapshot.files.find((file) => file.path === snapshot.entrypoint)
    assert.ok(main)
    assert.equal(result.entrypoint_sha256, main.sha256)
    const legacy = await invokeCli([
      "read",
      fixture.resource.ref,
      "--offline",
      "--output",
      "cli-resource.bin",
    ])
    assert.equal(legacy.code, 0)
    assert.equal(hash(await readFile(legacy.value.output)), fixture.resource.sha256)
    assert.deepEqual(
      { ...result, output: "same" },
      { ...withoutMetrics(legacy.value), output: "same" },
    )
    assert.equal(reports.length, 1)
    assert.equal(reports[0].total_requests, 0)
  })

  await test("partial cache keeps fixed and validated-current entrypoints usable without reading unselected objects", async () => {
    const sample = fixture.entrypoint
    assert.ok(sample, "Generate the complete entrypoint fixture with this checkout")
    const snapshot = fixture.snapshots.find((value) => value.record.name === sample.name)
    assert.ok(snapshot)
    const main = snapshot.files.find((file) => file.path === snapshot.entrypoint)
    const selected = sample.files.find((file) => file.role === "selected")
    const missing = sample.files.find((file) => file.role === "missing")
    const corrupt = sample.files.find((file) => file.role === "corrupt")
    assert.ok(main && selected && missing && corrupt)
    assert.ok(missing.bytes >= 2 * 1024 * 1024 && corrupt.bytes >= 2 * 1024 * 1024)
    const complete = join(root, "entrypoint-complete-source"),
      partial = join(root, "entrypoint-partial-source")
    await cp(fixture.cwd, complete, { recursive: true, errorOnExist: true, force: false })
    await cp(fixture.cwd, partial, { recursive: true, errorOnExist: true, force: false })
    const state = join(partial, env.NTN_SKILLS_HOME),
      objects = join(state, "objects")
    const preserved = join(root, "entrypoint-preserved")
    await mkdir(preserved, { mode: 0o700 })
    const mainBytes = await readFile(join(objects, main.sha256))
    assert.equal(hash(mainBytes), main.sha256)
    const currentOptions = { ...options, cwd: partial }
    const consumeEntry = (result) => {
      assert.equal(result.status, "ready", JSON.stringify(result))
      assert.equal(result.entries.length, 1)
      const entry = result.entries[0]
      assert.equal(entry.manifest.complete, true)
      assert.equal(entry.manifest.snapshot_id, snapshot.snapshot_id)
      assert.equal(entry.manifest.version_id, snapshot.version_id)
      assert.deepEqual(entry.manifest.files, snapshot.files)
      assert.deepEqual(entry.materialization, {
        status: "entry_ready",
        paths: [snapshot.entrypoint],
      })
      assert.equal(entry.source_body.sha256, main.sha256)
      assert.equal(entry.source_body.bytes, main.bytes)
      assert.equal(
        result.preparation.nodes[0].content,
        new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(mainBytes),
      )
      return entry
    }
    const exportComplete = async (label) => {
      const output = join(root, "entrypoint-export-" + label)
      const result = await invokeCli(
        ["export", sample.ref, "--offline", "--projection", "snapshot", "--output", output],
        complete,
      )
      assert.equal(result.code, 0, result.stdout + result.stderr)
      const files = []
      for (const file of snapshot.files) {
        const bytes = await readFile(join(output, file.path))
        assert.equal(bytes.length, file.bytes)
        assert.equal(hash(bytes), file.sha256)
        files.push({ path: file.path, bytes: bytes.length, sha256: hash(bytes) })
      }
      return { output, files }
    }
    const before = await exportComplete("before")
    // The fixture publisher already performed real validation. Preserve its
    // receipt, then force a legacy-cache upgrade through this installed public SDK
    // so the independent observation also proves every source byte was checked.
    const receiptKey = `cache/shared-current-tree-validation/${snapshot.scope}/${snapshot.snapshot_id}.json`
    const database = join(state, "state.sqlite")
    const publishedReceipt = fixtureCurrentReceipt(database, receiptKey)
    assert.equal(publishedReceipt.retired, 0)
    assert.equal(publishedReceipt.receipt.scope, snapshot.scope)
    assert.equal(publishedReceipt.receipt.snapshot_id, snapshot.snapshot_id)
    await writeFile(
      join(preserved, "published-current-receipt.json"),
      JSON.stringify(publishedReceipt, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    )
    const retirement = fixtureCurrentReceipt(database, receiptKey, publishedReceipt.payload)
    await writeFile(
      join(preserved, "current-receipt-retirement.json"),
      JSON.stringify(retirement, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    )
    const warm = await traceObjectReads("full-current-validation", objects, () =>
      sdk.consume(input([sample.current_ref], "inspect"), currentOptions),
    )
    consumeEntry(warm)
    const warmProof = objectReadProof("full-current-validation", snapshot.files)
    const revalidated = fixtureCurrentReceipt(database, receiptKey)
    assert.equal(revalidated.retired, 0)
    assert.equal(revalidated.payload, publishedReceipt.payload)
    const receipt = revalidated.receipt
    assert.equal(receipt.scope, snapshot.scope)
    assert.equal(receipt.snapshot_id, snapshot.snapshot_id)
    assert.equal(receipt.version_id, snapshot.version_id)
    await writeFile(
      join(root, "entrypoint-validated-current.json"),
      JSON.stringify(
        {
          result: warm,
          receipt,
          receipt_storage: "SQLite shared_local_records",
          retirement_preserved_payload: true,
          object_reads: warmProof,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    )
    await rename(join(objects, missing.sha256), join(preserved, "missing-source.bin"))
    await rename(join(objects, corrupt.sha256), join(preserved, "corrupt-source.bin"))
    const badBytes = Buffer.alloc(corrupt.bytes, 0xff),
      badHash = hash(badBytes)
    assert.notEqual(badHash, corrupt.sha256)
    await writeFile(join(objects, corrupt.sha256), badBytes, { mode: 0o600, flag: "wx" })
    const partialState = async () => {
      await assert.rejects(lstat(join(objects, missing.sha256)), { code: "ENOENT" })
      const bad = await readFile(join(objects, corrupt.sha256))
      assert.equal(bad.length, corrupt.bytes)
      assert.equal(hash(bad), badHash)
      return {
        missing_sha256: missing.sha256,
        corrupt_expected_sha256: corrupt.sha256,
        corrupt_actual_sha256: badHash,
        corrupt_bytes: bad.length,
      }
    }
    const damagedBefore = await partialState()
    const proofs = []
    for (const [label, target] of [
      ["fixed-entrypoint", sample.ref],
      ["validated-current-entrypoint", sample.current_ref],
    ]) {
      const result = await traceObjectReads(label, objects, () =>
        sdk.consume(input([target], "inspect"), currentOptions),
      )
      consumeEntry(result)
      const proof = objectReadProof(label, [main], [selected, missing, corrupt])
      assert.deepEqual(proof.object_sha256s, [main.sha256])
      proofs.push(proof)
      await writeFile(
        join(root, "entrypoint-" + label + ".json"),
        JSON.stringify(result, null, 2) + "\n",
        { mode: 0o600 },
      )
    }
    const read = await traceObjectReads("fixed-main-read", objects, () =>
      sdk.readSkill(sample.ref, { ...currentOptions, offline: true }),
    )
    assert.equal(
      read.content,
      new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(mainBytes),
    )
    proofs.push(objectReadProof("fixed-main-read", [main], [selected, missing, corrupt]))
    const directory = await invokeCli(["files", snapshot.snapshot_id, "--offline"], partial)
    assert.equal(directory.code, 0, directory.stdout + directory.stderr)
    assert.deepEqual(
      directory.value.files.map((file) => ({ path: file.path, bytes: file.bytes })),
      snapshot.files.map(({ path, bytes }) => ({ path, bytes })),
    )
    const resource = await traceObjectReads("selected-small-resource", objects, () =>
      sdk.readResources({ version: 1, refs: [selected.ref] }, { ...currentOptions, offline: true }),
    )
    assert.equal(resource.status, "ready", JSON.stringify(resource))
    assert.deepEqual(resource.materialization, {
      status: "selected_files_ready",
      paths: [selected.path],
    })
    assert.equal(resource.files[0].content, selected.content)
    assert.equal(resource.manifest.files.length, snapshot.files.length)
    proofs.push(objectReadProof("selected-small-resource", [selected], [main, missing, corrupt]))
    const failures = []
    for (const [file, code] of [
      [missing, "SNAPSHOT_MISSING"],
      [corrupt, "STATE_CORRUPT"],
    ]) {
      await assert.rejects(
        () =>
          sdk.readSkill(file.ref, {
            ...currentOptions,
            offline: true,
            output: join(root, "entrypoint-rejected-" + file.role + ".bin"),
          }),
        (error) => error instanceof sdk.SkillsError && error.code === code,
      )
      failures.push({ path: file.path, code })
    }
    const rejectedExport = await invokeCli(
      [
        "export",
        sample.ref,
        "--offline",
        "--projection",
        "snapshot",
        "--output",
        join(root, "entrypoint-partial-export"),
      ],
      partial,
    )
    assert.notEqual(rejectedExport.code, 0)
    assert.equal(
      rejectedExport.value.error?.code,
      "STATE_CORRUPT",
      JSON.stringify(rejectedExport.value),
    )
    assert.deepEqual(
      await partialState(),
      damagedBefore,
      "Entry reads and failed selection/export must not repair or overwrite damaged objects",
    )
    const after = await exportComplete("after")
    assert.deepEqual(after.files, before.files)
    const evidence = {
      source_state:
        "controlled current validated in full, then owned partial cache; not a cold source",
      snapshot_id: snapshot.snapshot_id,
      main_sha256: main.sha256,
      directory_files: directory.value.files.length,
      warm_validation: warmProof,
      selected_reads: proofs,
      partial_state: damagedBefore,
      failures,
      partial_export: { status: "rejected", code: rejectedExport.value.error.code },
      complete_export_before: before,
      complete_export_after: after,
    }
    await writeFile(
      join(root, "entrypoint-partial-evidence.json"),
      JSON.stringify(evidence, null, 2) + "\n",
      { mode: 0o600 },
    )
    return evidence
  })

  await test("cold current ownership skips suppressed source bytes and preserves complete installed exports", async () => {
    const sample = fixture.ownership
    assert.ok(sample, "Generate the ownership fixture with this checkout")
    const cwd = join(root, "ownership-current")
    await cp(sample.seed, cwd, { recursive: true, errorOnExist: true, force: false })
    const state = join(cwd, env.NTN_SKILLS_HOME),
      objects = join(state, "objects")
    const required = sample.source_files.filter((file) => file.role === "required"),
      excluded = sample.source_files.filter((file) => file.role === "excluded")
    assert.deepEqual(required.map((file) => file.path).sort(), ["SKILL.md", "assets/following.bin"])
    assert.equal(excluded.length, 2)
    assert.ok(excluded.every((file) => file.bytes >= 2 * 1024 * 1024))
    for (const file of sample.source_files)
      await assert.rejects(lstat(join(objects, file.sha256)), { code: "ENOENT" })
    const database = new DatabaseSync(join(state, "state.sqlite"), { readOnly: true })
    try {
      assert.equal(
        database
          .prepare(
            "SELECT count(*) AS count FROM shared_local_records WHERE key LIKE 'snapshots/%'",
          )
          .get().count,
        0,
        "The installed current operation must start without any snapshot",
      )
    } finally {
      database.close()
    }
    const notion = structuredClone(sample.notion)
    const requests = [],
      unexpected = []
    let phase = "setup"
    const richText = (parts) =>
      (parts ?? []).map((part) => part.plain_text ?? part.text?.content ?? "").join("")
    const matches = (row, filter) => {
      if (!filter) return true
      if (Array.isArray(filter.and)) return filter.and.every((value) => matches(row, value))
      if (Array.isArray(filter.or)) return filter.or.some((value) => matches(row, value))
      const field = row.properties[filter.property]
      if (!field) return false
      if (filter.relation?.is_empty === true) return field.relation?.length === 0
      if (filter.relation)
        return field.relation?.some((item) => item.id === filter.relation.contains) ?? false
      if (filter.select) return field.select?.name === filter.select.equals
      if (filter.rich_text) return richText(field.rich_text) === filter.rich_text.equals
      return false
    }
    const page = (values, body) => {
      const cursor = body?.start_cursor
      assert.ok(cursor === undefined || /^offset-[0-9]+$/u.test(cursor))
      const offset = cursor === undefined ? 0 : Number(cursor.slice(7))
      const end = Math.min(values.length, offset + Math.min(100, body?.page_size ?? 100))
      return {
        object: "list",
        results: values.slice(offset, end),
        has_more: end < values.length,
        next_cursor: end < values.length ? `offset-${end}` : null,
      }
    }
    const server = createServer(async (request, response) => {
      const url = new URL(request.url, "http://127.0.0.1")
      const call = { phase, method: request.method, path: url.pathname }
      requests.push(call)
      fs.appendFileSync(
        join(root, "ownership-notion-requests.jsonl"),
        JSON.stringify(call) + "\n",
        { mode: 0o600 },
      )
      try {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const raw = Buffer.concat(chunks).toString("utf8")
        const body = raw === "" ? undefined : JSON.parse(raw)
        const { library } = notion
        let value
        if (request.method === "GET" && url.pathname === "/v1/users/me")
          value = { object: "user", id: "00000000-0000-4000-8000-000000000099" }
        else if (
          request.method === "GET" &&
          url.pathname === `/v1/databases/${library.skills.database_id}`
        )
          value = notion.database
        else if (request.method === "GET" && url.pathname === `/v1/pages/${notion.main.id}`)
          value = notion.main
        else if (
          request.method === "GET" &&
          notion.files.some((file) => url.pathname === `/v1/pages/${file.id}`)
        )
          value = notion.files.find((file) => url.pathname === `/v1/pages/${file.id}`)
        else if (request.method === "GET" && /^\/v1\/pages\/[^/]+\/markdown$/u.test(url.pathname)) {
          const id = url.pathname.split("/")[3]
          assert.equal(typeof notion.bodies[id], "string")
          value = { id, markdown: notion.bodies[id], truncated: false, unknown_block_ids: [] }
        } else if (
          request.method === "POST" &&
          url.pathname === `/v1/data_sources/${library.skills.data_source_id}/query`
        )
          value = page([notion.main], body)
        else if (
          request.method === "POST" &&
          url.pathname === `/v1/data_sources/${library.files.data_source_id}/query`
        )
          value = page(
            notion.files.filter((file) => matches(file, body?.filter)),
            body,
          )
        else if (
          request.method === "POST" &&
          url.pathname === `/v1/data_sources/${library.records.data_source_id}/query`
        ) {
          const selected = new Set(url.searchParams.getAll("filter_properties"))
          value = page(
            notion.records
              .filter((row) => matches(row, body?.filter))
              .map((row) => ({
                ...row,
                properties:
                  selected.size === 0
                    ? row.properties
                    : Object.fromEntries(
                        Object.entries(row.properties).filter(([key, field]) =>
                          selected.has(field.id ?? key),
                        ),
                      ),
              })),
            body,
          )
        } else throw new Error("Unexpected controlled Notion request")
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify(value))
      } catch (error) {
        unexpected.push({ ...call, error: String(error) })
        response.writeHead(400, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            object: "error",
            status: 400,
            code: "validation_error",
            message: "Unexpected controlled ownership request",
          }),
        )
      }
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const notionOrigin = `http://127.0.0.1:${server.address().port}`
    const currentEnv = { ...env, NOTION_API_BASE_URL: notionOrigin }
    const currentOptions = {
      ...options,
      cwd,
      env: currentEnv,
      database: notion.library.skills.database_id,
    }
    const currentInput = {
      version: 1,
      targets: [notion.main.id],
      purpose: "inspect",
      freshness: { policy: "refresh" },
    }
    const evidence = {
      version: 1,
      status: "running",
      source_state: sample.source_cache,
      transport: "controlled source Response and loopback Notion; installed Node Store",
      source_id: sample.source_id,
      excluded: excluded.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
      phases: [],
    }
    try {
      for (const [label, expected] of [
        ["ownership-cold", sample.oracle.cold],
        ["ownership-metadata-refresh", sample.oracle.metadata],
      ]) {
        phase = label
        if (label === "ownership-metadata-refresh")
          notion.main = structuredClone(notion.metadata_main)
        const reports = []
        const result = await traceSourceRequests(label, notionOrigin, sample.source_files, () =>
          traceObjectReads(label, objects, () =>
            sdk.consume(currentInput, {
              ...currentOptions,
              onRequestMetrics: (report) => reports.push(report),
            }),
          ),
        )
        await writeFile(join(root, label + ".json"), JSON.stringify(result, null, 2) + "\n", {
          mode: 0o600,
          flag: "wx",
        })
        assert.equal(result.status, "ready", JSON.stringify(result))
        assert.equal(result.entries.length, 1)
        const entry = result.entries[0]
        assert.equal(entry.manifest.complete, true)
        assert.deepEqual(entry.manifest.files, expected.files)
        const main = expected.files.find((file) => file.path === "SKILL.md")
        const following = expected.files.find((file) => file.path === "assets/following.bin")
        assert.ok(main && following)
        assert.equal(entry.source_body.sha256, main.sha256)
        assert.equal(entry.source_body.bytes, main.bytes)
        assert.equal(result.preparation.nodes[0].content, expected.main)
        assert.ok(expected.main.includes(sample.source_main_marker))
        assert.deepEqual(await sdk.decodeConsumeResult(result, currentInput), result)
        const cold = label === "ownership-cold"
        const sourceProof = sourceTransportProof(label, cold ? required : [], excluded)
        const objectProof = objectReadProof(
          label,
          cold ? [main, following] : [...required, main],
          excluded,
        )
        assert.equal(reports.length, 1)
        assert.equal(reports[0].in_flight, 0)
        assert.equal(reports[0].provider_requests.http ?? 0, cold ? required.length : 0)
        for (const file of excluded)
          await assert.rejects(lstat(join(objects, file.sha256)), { code: "ENOENT" })
        assert.deepEqual(unexpected, [])
        assert.equal(
          requests.filter((call) => call.method !== "GET" && !call.path.endsWith("/query")).length,
          0,
        )
        const output = join(root, label + "-export")
        const beforeExport = requests.length
        const exported = await invokeCli(
          [
            "export",
            entry.source_body.ref,
            "--offline",
            "--projection",
            "snapshot",
            "--output",
            output,
          ],
          cwd,
          currentEnv,
        )
        assert.equal(exported.code, 0, exported.stdout + exported.stderr)
        assert.equal(requests.length, beforeExport)
        const inventory = []
        for (const path of (await readdir(output, { recursive: true })).sort()) {
          const info = await lstat(join(output, path))
          if (info.isDirectory()) continue
          assert.equal(info.isFile(), true)
          const bytes = await readFile(join(output, path))
          inventory.push({ path, bytes: bytes.length, sha256: hash(bytes) })
        }
        assert.deepEqual(inventory, expected.export_files)
        evidence.phases.push({
          label,
          snapshot_id: entry.manifest.snapshot_id,
          manifest_files: entry.manifest.files,
          source_requests: sourceProof,
          object_reads: objectProof,
          notion_requests: requests.filter((call) => call.phase === label).length,
          notion_writes: 0,
          full_export: { output, files: inventory, matches_full_byte_oracle: true },
        })
      }
      assert.notEqual(sample.oracle.cold.main, sample.oracle.metadata.main)
      assert.deepEqual(
        sample.oracle.cold.files.filter((file) => file.path !== "SKILL.md"),
        sample.oracle.metadata.files.filter((file) => file.path !== "SKILL.md"),
      )
      evidence.status = "passed"
      return evidence
    } catch (error) {
      evidence.status = "failed"
      evidence.error = String(error)
      evidence.unexpected_notion_requests = unexpected
      throw error
    } finally {
      activeSourceProbe = undefined
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      await writeFile(
        join(root, "ownership-current-evidence.json"),
        JSON.stringify(evidence, null, 2) + "\n",
        { mode: 0o600, flag: "wx" },
      )
    }
  })

  await test("scalar logical reads share one complete projected inventory within each refresh", async () => {
    const sample = fixture.scalarInventory
    assert.ok(sample, "Generate the scalar inventory fixture with this checkout")
    assert.equal(sample.row_count, 101)
    const sdkCwd = join(root, "scalar-inventory-sdk"),
      cliCwd = join(root, "scalar-inventory-cli"),
      relationsCwd = join(root, "scalar-inventory-relations")
    for (const cwd of [sdkCwd, cliCwd, ...(!viewDynamicsOnly ? [relationsCwd] : [])]) {
      await cp(sample.seed, cwd, { recursive: true, errorOnExist: true, force: false })
      const state = join(cwd, env.NTN_SKILLS_HOME)
      const database = new DatabaseSync(join(state, "state.sqlite"), { readOnly: true })
      try {
        assert.equal(
          database.prepare("SELECT count(*) AS count FROM shared_local_records").get().count,
          0,
        )
        assert.equal(database.prepare("SELECT count(*) AS count FROM snapshots").get().count, 0)
      } finally {
        database.close()
      }
      const objects = await readdir(join(state, "objects")).catch((error) => {
        if (error.code === "ENOENT") return []
        throw error
      })
      assert.deepEqual(objects, [])
    }
    const notion = structuredClone(sample.notion)
    const requests = [],
      unexpected = []
    let phase = "setup"
    let denyCurrent = false
    let denyAuthentication = false
    let viewObservation
    let incompleteViewInventory = false
    const richText = (parts) =>
      (parts ?? []).map((part) => part.plain_text ?? part.text?.content ?? "").join("")
    const matches = (row, filter) => {
      if (!filter) return true
      if (Array.isArray(filter.and)) return filter.and.every((item) => matches(row, item))
      if (Array.isArray(filter.or)) return filter.or.some((item) => matches(row, item))
      const field = row.properties[filter.property]
      if (!field) return false
      if (filter.relation?.is_empty === true) return field.relation?.length === 0
      if (filter.relation)
        return field.relation?.some((item) => item.id === filter.relation.contains) ?? false
      if (filter.select) return field.select?.name === filter.select.equals
      if (filter.rich_text) return richText(field.rich_text) === filter.rich_text.equals
      if (filter.checkbox) return field.checkbox === filter.checkbox.equals
      throw new Error("Unsupported controlled inventory filter")
    }
    const project = (rows, fields) =>
      rows.map((row) => ({
        ...row,
        properties:
          fields.length === 0
            ? row.properties
            : Object.fromEntries(
                Object.entries(row.properties).filter(([key, field]) =>
                  fields.includes(field.id ?? key),
                ),
              ),
      }))
    const page = (rows, body) => {
      const cursor = body?.start_cursor
      assert.ok(cursor === undefined || /^offset-[0-9]+$/u.test(cursor))
      const offset = cursor === undefined ? 0 : Number(cursor.slice(7))
      const end = Math.min(rows.length, offset + Math.min(100, body?.page_size ?? 100))
      return {
        object: "list",
        results: rows.slice(offset, end),
        has_more: end < rows.length,
        next_cursor: end < rows.length ? `offset-${end}` : null,
      }
    }
    const server = createServer(async (request, response) => {
      const url = new URL(request.url, "http://127.0.0.1")
      const fields = url.searchParams.getAll("filter_properties")
      const call = {
        phase,
        sequence: requests.length + 1,
        method: request.method,
        path: url.pathname,
        filter_properties: fields,
      }
      requests.push(call)
      let value,
        status = 200
      try {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const bytes = Buffer.concat(chunks)
        const body = bytes.length === 0 ? undefined : JSON.parse(bytes.toString("utf8"))
        Object.assign(call, { request_bytes: bytes.length, body: body ?? null })
        const { library } = notion
        if (denyAuthentication && request.method === "GET" && url.pathname === "/v1/users/me") {
          status = 401
          value = {
            object: "error",
            status,
            code: "unauthorized",
            message: "Controlled credential rejection",
          }
        } else if (
          denyCurrent &&
          request.method === "GET" &&
          url.pathname === `/v1/pages/${notion.main.id}`
        ) {
          status = 403
          value = {
            object: "error",
            status,
            code: "restricted_resource",
            message: "Controlled current permission denial",
          }
        } else if (request.method === "GET" && url.pathname === "/v1/users/me")
          value = { object: "user", id: "00000000-0000-4000-8000-000000000099" }
        else if (
          request.method === "GET" &&
          url.pathname === `/v1/databases/${library.skills.database_id}`
        )
          value = notion.database
        else if (viewObservation && request.method === "GET" && url.pathname === "/v1/views") {
          assert.equal(url.searchParams.get("database_id"), library.skills.database_id)
          value = {
            object: "list",
            results: [{ object: "view", id: sample.view_dynamics.view.id }],
            has_more: false,
            next_cursor: null,
          }
        } else if (
          viewObservation &&
          request.method === "GET" &&
          url.pathname === `/v1/views/${sample.view_dynamics.view.id}`
        )
          value = { ...sample.view_dynamics.view, filter: viewObservation.filter }
        else if (
          viewObservation &&
          request.method === "POST" &&
          url.pathname === `/v1/views/${sample.view_dynamics.view.id}/queries`
        ) {
          assert.deepEqual(body, { page_size: 100 })
          value = {
            object: "list",
            id: viewObservation.query_id,
            view_id: sample.view_dynamics.view.id,
            expires_at: new Date(Date.now() + 900000).toISOString(),
            total_count: viewObservation.member_page_ids.length,
            results: viewObservation.member_page_ids.map((id) => ({ object: "page", id })),
            has_more: false,
            next_cursor: null,
            request_status: { type: "complete", incomplete_reason: null },
          }
          Object.assign(call, {
            view_observation: viewObservation.id,
            view_filter: viewObservation.filter,
            view_member_page_ids: viewObservation.member_page_ids,
          })
        } else if (request.method === "GET" && url.pathname === `/v1/pages/${notion.main.id}`)
          value = notion.main
        else if (
          request.method === "GET" &&
          notion.files.some((file) => url.pathname === `/v1/pages/${file.id}`)
        )
          value = notion.files.find((file) => url.pathname === `/v1/pages/${file.id}`)
        else if (request.method === "GET" && /^\/v1\/pages\/[^/]+\/markdown$/u.test(url.pathname)) {
          const id = url.pathname.split("/")[3]
          assert.equal(
            typeof notion.bodies[id],
            "string",
            "An unselected target body was requested",
          )
          value = { id, markdown: notion.bodies[id], truncated: false, unknown_block_ids: [] }
        } else if (request.method === "POST" && url.pathname.endsWith("/query")) {
          const rows =
            url.pathname === `/v1/data_sources/${library.skills.data_source_id}/query`
              ? notion.skills
              : url.pathname === `/v1/data_sources/${library.files.data_source_id}/query`
                ? notion.files
                : url.pathname === `/v1/data_sources/${library.records.data_source_id}/query`
                  ? notion.records
                  : undefined
          assert.ok(rows, "An unexpected data source was queried")
          value = page(
            project(
              rows.filter((row) => matches(row, body?.filter)),
              fields,
            ),
            body,
          )
          if (
            incompleteViewInventory &&
            url.pathname === `/v1/data_sources/${library.skills.data_source_id}/query`
          )
            value.request_status = {
              type: "incomplete",
              incomplete_reason: "query_result_limit_reached",
            }
          Object.assign(call, {
            page_ids: value.results.map((row) => row.id),
            returned_properties: [
              ...new Set(
                value.results.flatMap((row) =>
                  Object.values(row.properties).map((field) => field.id),
                ),
              ),
            ].sort(),
            has_more: value.has_more,
            next_cursor: value.next_cursor,
          })
        } else throw new Error("Unexpected controlled inventory request")
      } catch (error) {
        unexpected.push({ ...call, error: String(error) })
        status = 400
        value = {
          object: "error",
          status,
          code: "validation_error",
          message: "Unexpected controlled inventory request",
        }
      }
      const bytes = Buffer.from(JSON.stringify(value))
      Object.assign(call, {
        status,
        decoded_response_bytes: bytes.length,
        response_sha256: hash(bytes),
      })
      fs.appendFileSync(
        join(root, "scalar-inventory-notion-requests.jsonl"),
        JSON.stringify(call) + "\n",
        { mode: 0o600 },
      )
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": String(bytes.length),
      })
      response.end(bytes)
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const currentEnv = {
      ...env,
      NOTION_API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      NTN_SKILLS_REQUEST_TRACE_LIMIT: "10000",
    }
    const evidence = {
      version: 1,
      status: "running",
      source_state: sample.source_cache,
      transport: "loopback Notion; independently installed Node SDK and CLI",
      row_count: sample.row_count,
      projection: sample.projection,
      external: sample.external,
      phases: [],
      cache_lifecycle: [],
    }
    const relationReads = new Map()
    const viewDynamics = async () => {
      const input = sample.view_dynamics
      assert.ok(input, "Generate the Tags/View dynamics observation with this checkout")
      assert.equal(typeof input.tags_property_id, "string")
      assert.equal(input.observations.length, 3)
      const phaseRoot = join(root, "view-dynamics")
      const cwd = join(phaseRoot, "consumer")
      await mkdir(phaseRoot, { mode: 0o700 })
      await cp(sample.seed, cwd, { recursive: true, errorOnExist: true, force: false })
      const objectRoot = join(cwd, env.NTN_SKILLS_HOME, "objects")
      const objectInventory = async () => {
        const files = await readdir(objectRoot).catch((error) => {
          if (error.code === "ENOENT") return []
          throw error
        })
        return Promise.all(
          files.sort().map(async (path) => {
            const bytes = await readFile(join(objectRoot, path))
            return { path, bytes: bytes.length, sha256: hash(bytes) }
          }),
        )
      }
      assert.deepEqual(await objectInventory(), [])
      const database = new DatabaseSync(join(cwd, env.NTN_SKILLS_HOME, "state.sqlite"), {
        readOnly: true,
      })
      try {
        assert.equal(
          database.prepare("SELECT count(*) AS count FROM shared_local_records").get().count,
          0,
        )
      } finally {
        database.close()
      }
      notion.main = structuredClone(sample.notion.main)
      notion.skills = structuredClone(sample.notion.skills)
      const selection = {
        ...options,
        cwd,
        env: currentEnv,
        database: notion.library.skills.database_id,
      }
      const result = {
        source: "controlled Notion API observations; no production filter execution",
        phases: [],
      }
      evidence.view_dynamics = result
      let objects
      const setObservation = (index) => {
        viewObservation = input.observations[index]
        for (const [id, names] of viewObservation.tags) {
          const row = notion.skills.find((entry) => entry.id === id)
          assert.ok(row)
          const tags = {
            id: input.tags_property_id,
            type: "multi_select",
            multi_select: names.map((name) => ({ id: name, name, color: "default" })),
          }
          row.properties.tags = tags
          if (id === notion.main.id) notion.main.properties.tags = structuredClone(tags)
        }
      }
      const observe = async (
        label,
        invoke,
        { entry, metadataOnly = true, error: expectedError },
      ) => {
        assert.ok(entry)
        phase = label
        const reports = []
        let value, error
        try {
          value = await invoke((metrics) => reports.push(metrics))
        } catch (caught) {
          error = { code: caught.code ?? null, message: String(caught) }
        }
        const calls = requests.filter((call) => call.phase === label)
        const metrics = reports[0]
        const afterObjects = await objectInventory()
        const observed = {
          label,
          entry,
          input_observation: structuredClone(viewObservation),
          result: value,
          error,
          request_metrics: metrics,
          calls,
          object_inventory: afterObjects,
        }
        result.phases.push(observed)
        await writeFile(
          join(phaseRoot, label + ".json"),
          JSON.stringify(observed, null, 2) + "\n",
          { mode: 0o600, flag: "wx" },
        )
        assert.equal(reports.length, 1)
        assert.ok(metrics)
        assert.equal(metrics.in_flight, 0)
        assert.equal(metrics.trace_enabled, true)
        assert.equal(metrics.trace_dropped, 0)
        assert.equal(metrics.unknown_request_bytes, 0)
        assert.equal(metrics.unknown_response_bytes, 0)
        assert.equal(metrics.total_requests, calls.length)
        assert.equal(
          metrics.trace.filter((event) => event.event === "attempt").length,
          calls.length,
        )
        assert.equal(
          metrics.response_bytes,
          calls.reduce((sum, call) => sum + call.decoded_response_bytes, 0),
        )
        assert.equal(metrics.requests.notion_write, 0)
        assert.equal(metrics.requests.provider, 0)
        assert.deepEqual(unexpected, [])
        assert.equal(error?.code, expectedError)
        if (objects !== undefined) assert.deepEqual(afterObjects, objects)
        if (metadataOnly) {
          assert.equal(metrics.requests.notion_body, 0)
          for (const call of calls) {
            assert.ok(
              call.path === "/v1/users/me" ||
                call.path === `/v1/databases/${notion.library.skills.database_id}` ||
                call.path === "/v1/views" ||
                call.path === `/v1/views/${input.view.id}` ||
                call.path === `/v1/views/${input.view.id}/queries` ||
                call.path === `/v1/data_sources/${notion.library.skills.data_source_id}/query`,
              "Directory work requested unrelated content: " + call.path,
            )
            if (call.path === `/v1/data_sources/${notion.library.skills.data_source_id}/query`) {
              assert.deepEqual([...call.filter_properties].sort(), [...sample.projection].sort())
              assert.deepEqual(call.returned_properties, [...sample.projection].sort())
            }
          }
        }
        return observed
      }
      const sdkEntry = (operation, input, policy = {}) => ({
        surface: "installed SDK",
        module: sdkPath,
        operation,
        input,
        options: { database: selection.database, cwd, ...policy },
      })
      const directory = async (label, policy = {}, extra = {}) =>
        observe(
          label,
          (onRequestMetrics) =>
            sdk.listCatalog({ ...selection, defaultView: true, ...policy, onRequestMetrics }),
          { entry: sdkEntry("listCatalog", null, { defaultView: true, ...policy }), ...extra },
        )
      const members = (phase, observation) => {
        assert.deepEqual(
          phase.result.records.map((record) => record.id),
          observation.member_record_ids,
        )
        assert.equal(phase.result.view.id, input.view.id)
        assert.equal(phase.result.view_query.total_count, observation.member_page_ids.length)
        assert.equal(phase.result.coverage.exhaustive, true)
        assert.deepEqual(phase.result.coverage.failed_sources, [])
        const queries = phase.calls.filter((call) => call.view_member_page_ids)
        if (phase.result.source === "notion") {
          assert.equal(queries.length, 1)
          assert.deepEqual(queries[0].view_member_page_ids, observation.member_page_ids)
          const inventory = phase.calls.filter(
            (call) =>
              call.path === `/v1/data_sources/${notion.library.skills.data_source_id}/query`,
          )
          assert.deepEqual(
            inventory.map((call) => call.body.start_cursor ?? null),
            [null, "offset-100"],
          )
          assert.deepEqual(
            inventory.flatMap((call) => call.page_ids),
            sample.notion.skills.map((row) => row.id),
          )
        }
      }
      try {
        setObservation(0)
        const cold = await observe(
          "view-body-baseline",
          (onRequestMetrics) => sdk.readSkill(sample.root_ref, { ...selection, onRequestMetrics }),
          { entry: sdkEntry("readSkill", sample.root_ref), metadataOnly: false },
        )
        assert.equal(cold.result.content, sample.oracle.cold.contents["SKILL.md"])
        assert.deepEqual(cold.result.native_references, sample.oracle.cold.native_references)
        objects = cold.object_inventory
        assert.ok(objects.length > 0)
        const initial = await directory("view-initial")
        members(initial, input.observations[0])
        setObservation(1)
        const warm = await directory("view-tags-warm")
        members(warm, input.observations[0])
        assert.equal(warm.request_metrics.total_requests, 0)
        assert.equal(warm.result.fetched_at, initial.result.fetched_at)
        const refreshArgv = [
          "list",
          "--default-view",
          "--database",
          selection.database,
          "--refresh",
          "--metrics",
          "--json",
        ]
        const refreshed = await observe(
          "view-tags-refresh-cli",
          async (report) => {
            const invocation = await invokeCli(refreshArgv, cwd, currentEnv)
            report(invocation.value.request_metrics)
            assert.equal(invocation.code, 0, invocation.stdout + invocation.stderr)
            assert.equal(invocation.value.has_more, false)
            return withoutMetrics(invocation.value)
          },
          {
            entry: { surface: "installed CLI", argv: [process.execPath, cli, ...refreshArgv], cwd },
          },
        )
        members(refreshed, input.observations[1])
        assert.equal(
          refreshed.result.records.some((record) => record.id === cold.result.record.id),
          false,
        )
        const outside = await observe(
          "view-outside-current",
          (onRequestMetrics) => sdk.readSkill(sample.root_ref, { ...selection, onRequestMetrics }),
          { entry: sdkEntry("readSkill", sample.root_ref) },
        )
        assert.equal(outside.request_metrics.total_requests, 0)
        assert.equal(outside.result.snapshot_id, cold.result.snapshot_id)
        assert.equal(outside.result.content, cold.result.content)
        setObservation(2)
        const expired = await directory("view-filter-expired", { maxAge: 0 })
        members(expired, input.observations[2])
        const ordinary = await observe(
          "view-ordinary-directory",
          (onRequestMetrics) => sdk.listCatalog({ ...selection, refresh: true, onRequestMetrics }),
          { entry: sdkEntry("listCatalog", null, { refresh: true }) },
        )
        assert.deepEqual(
          ordinary.result.records.map((record) => record.id).sort(),
          [...input.ordinary_record_ids].sort(),
        )
        assert.equal(ordinary.result.view, undefined)
        incompleteViewInventory = true
        try {
          await directory(
            "view-incomplete-refresh",
            { refresh: true },
            { error: "VIEW_INCOMPLETE" },
          )
        } finally {
          incompleteViewInventory = false
        }
        const offline = await directory("view-offline-last-complete", { offline: true })
        members(offline, input.observations[2])
        assert.equal(offline.request_metrics.total_requests, 0)
        assert.equal(offline.result.fetched_at, expired.result.fetched_at)
        const listed = await observe(
          "view-old-pin-files",
          (onRequestMetrics) =>
            sdk.listSkill(cold.result.snapshot_id, {
              ...selection,
              offline: true,
              onRequestMetrics,
            }),
          { entry: sdkEntry("listSkill", cold.result.snapshot_id, { offline: true }) },
        )
        assert.deepEqual(
          listed.result.files.map(({ path, bytes }) => ({ path, bytes })),
          sample.oracle.cold.files.map(({ path, bytes }) => ({ path, bytes })),
        )
        assert.equal(listed.result.scope, cold.result.scope)
        assert.equal(listed.result.record.id, cold.result.record.id)
        assert.equal(listed.result.snapshot_id, cold.result.snapshot_id)
        assert.equal(listed.result.version_id, cold.result.version_id)
        for (const [index, file] of listed.result.files.entries()) {
          const expected = sample.oracle.cold.files.find((entry) => entry.path === file.path)
          assert.ok(expected)
          const pinned = await observe(
            `view-old-pin-file-${index}`,
            (onRequestMetrics) =>
              sdk.readSkill(file.ref, { ...selection, offline: true, onRequestMetrics }),
            { entry: sdkEntry("readSkill", file.ref, { offline: true }) },
          )
          assert.equal(pinned.request_metrics.total_requests, 0)
          assert.equal(pinned.result.snapshot_id, cold.result.snapshot_id)
          assert.equal(pinned.result.scope, cold.result.scope)
          assert.equal(pinned.result.record.id, cold.result.record.id)
          assert.equal(pinned.result.path, file.path)
          assert.equal(pinned.result.content, sample.oracle.cold.contents[file.path])
          assert.equal(Buffer.byteLength(pinned.result.content), expected.bytes)
          assert.equal(hash(pinned.result.content), expected.sha256)
        }
        result.status = "passed"
      } catch (error) {
        result.status = "failed"
        result.error = String(error)
        throw error
      } finally {
        incompleteViewInventory = false
        viewObservation = undefined
        await writeFile(join(phaseRoot, "report.json"), JSON.stringify(result, null, 2) + "\n", {
          mode: 0o600,
          flag: "wx",
        })
      }
    }
    try {
      if (viewDynamicsOnly) {
        await viewDynamics()
        evidence.status = "passed"
        return evidence
      }
      for (const [label, kind, cwd, expected] of [
        ["scalar-cold", "sdk", sdkCwd, sample.oracle.cold],
        ["scalar-refresh", "sdk", sdkCwd, sample.oracle.refreshed],
        ["scalar-cli-cold", "cli-from", cliCwd, sample.oracle.cold],
        ["scalar-relations", "sdk", relationsCwd, sample.oracle.relations],
        ["scalar-relations-physical", "sdk", relationsCwd, sample.oracle.relations],
      ]) {
        phase = label
        const refreshed = label === "scalar-refresh"
        const relations = label.startsWith("scalar-relations")
        assert.ok(expected, "Generate the scalar relation oracle with this checkout")
        notion.main = structuredClone(
          relations
            ? sample.notion.relations_main
            : refreshed
              ? sample.notion.refreshed_main
              : sample.notion.main,
        )
        notion.skills = structuredClone(
          relations
            ? sample.notion.relations_skills
            : refreshed
              ? sample.notion.refreshed_skills
              : sample.notion.skills,
        )
        const reports = []
        let result
        if (kind === "sdk") {
          result = await sdk.readSkill(
            label === "scalar-relations-physical" ? notion.main.id : sample.root_ref,
            {
              ...options,
              cwd,
              env: currentEnv,
              database: notion.library.skills.database_id,
              refresh: true,
              onRequestMetrics: (report) => reports.push(report),
            },
          )
        } else {
          const invocation = await invokeCli(
            [
              "read",
              sample.resource_path,
              "--from",
              sample.root_ref,
              "--database",
              notion.library.skills.database_id,
              "--refresh",
              "--metrics",
            ],
            cwd,
            currentEnv,
          )
          assert.equal(invocation.code, 0, invocation.stdout + invocation.stderr)
          reports.push(invocation.value.request_metrics)
          result = withoutMetrics(invocation.value)
        }
        await writeFile(join(root, label + ".json"), JSON.stringify(result, null, 2) + "\n", {
          mode: 0o600,
          flag: "wx",
        })
        assert.equal(result.has_more, false)
        assert.equal(result.path, kind === "sdk" ? "SKILL.md" : sample.resource_path)
        assert.equal(result.content, expected.contents[result.path])
        assert.deepEqual(result.native_references, expected.native_references)
        assert.deepEqual(result.members, expected.members)
        assert.deepEqual(result.required, expected.required)
        if (relations) {
          assert.equal(result.record.id, sample.oracle.relations.root_id)
          assert.equal(result.members.length, 1)
          assert.equal(result.required.length, 1)
          const database = new DatabaseSync(join(cwd, env.NTN_SKILLS_HOME, "state.sqlite"), {
            readOnly: true,
          })
          let manifest
          try {
            const row = database
              .prepare("SELECT manifest FROM snapshots WHERE id=?")
              .get(result.snapshot_id)
            assert.ok(row, "The complete current snapshot was not persisted")
            manifest = JSON.parse(row.manifest)
          } finally {
            database.close()
          }
          assert.equal(manifest.scope, result.scope)
          assert.equal(manifest.snapshot_id, result.snapshot_id)
          assert.equal(manifest.version_id, result.version_id)
          assert.deepEqual(manifest.record, result.record)
          assert.deepEqual(manifest.members, result.members)
          assert.deepEqual(manifest.required, result.required)
          assert.deepEqual(manifest.files, expected.files)
          await writeFile(
            join(root, label + "-manifest.json"),
            JSON.stringify(manifest, null, 2) + "\n",
            { mode: 0o600, flag: "wx" },
          )
          relationReads.set(label, { result, manifest })
        }
        const disabled = result.native_references.entries.find(
          (entry) => entry.page_id === sample.external.disabled,
        )
        assert.equal(disabled?.availability, "disabled")
        assert.equal(result.native_references.unresolved.length, 0)
        if (label === "scalar-cold") {
          const beforeUse = requests.length
          const structured = await invokeCli(
            ["use", result.ref, "--offline", "--json"],
            cwd,
            currentEnv,
          )
          assert.equal(structured.code, 0, structured.stdout + structured.stderr)
          const rootNode = structured.value.preparation.nodes.find(
            (node) => node.state === "prepared",
          )
          assert.deepEqual(rootNode.references, result.native_references.entries)
          const compact = await command([process.execPath, cli, "use", result.ref, "--offline"], {
            cwd,
            env: { ...currentEnv, PATH: process.env.PATH },
          })
          assert.equal(compact.code, 0, compact.stdout + compact.stderr)
          for (const reference of rootNode.references) {
            assert.ok(
              compact.stdout.includes(reference.ref),
              "Compact use omitted a native reference entry",
            )
            assert.ok(
              compact.stdout.includes(`${reference.name} [${reference.availability}]`),
              "Compact use omitted reference availability",
            )
          }
          assert.equal(
            requests.length,
            beforeUse,
            "Pinned use must not reread remote linked bodies",
          )
          evidence.compact_use = {
            reference_count: rootNode.references.length,
            unavailable: rootNode.references.filter(
              (reference) => reference.availability !== "available",
            ).length,
            http_requests: requests.length - beforeUse,
            stdout_sha256: hash(compact.stdout),
          }
        }
        assert.equal(reports.length, 1)
        const metrics = reports[0]
        assert.equal(metrics.in_flight, 0)
        assert.equal(metrics.trace_enabled, true)
        assert.equal(metrics.trace_dropped, 0)
        assert.equal(metrics.requests.notion_write, 0)
        assert.equal(metrics.requests.provider, 0)
        assert.equal(metrics.unknown_request_bytes, 0)
        assert.equal(metrics.unknown_response_bytes, 0)
        assert.equal(metrics.outcomes.failure, 0)
        assert.equal(metrics.outcomes.cancelled, 0)
        const calls = requests.filter((call) => call.phase === label)
        assert.equal(metrics.total_requests, calls.length)
        assert.equal(
          metrics.trace.filter((event) => event.event === "attempt").length,
          calls.length,
        )
        assert.equal(
          metrics.response_bytes,
          calls.reduce((total, call) => total + call.decoded_response_bytes, 0),
        )
        assert.deepEqual(unexpected, [])
        const externalReads = calls.filter((call) =>
          notion.skills.some(
            (row) => row.id !== notion.main.id && call.path.startsWith(`/v1/pages/${row.id}`),
          ),
        )
        assert.equal(externalReads.length, 0)
        const fullPageReads = calls.filter(
          (call) => call.method === "GET" && call.path === `/v1/pages/${notion.main.id}`,
        )
        assert.ok(
          fullPageReads.length > 0,
          "Six projected fields must not replace the full current page",
        )
        const queries = calls.filter(
          (call) =>
            call.method === "POST" &&
            call.path === `/v1/data_sources/${notion.library.skills.data_source_id}/query`,
        )
        for (const query of queries) {
          assert.deepEqual([...query.filter_properties].sort(), [...sample.projection].sort())
          assert.deepEqual(query.returned_properties, [...sample.projection].sort())
          assert.equal(query.body.filter, undefined)
          assert.equal(query.body.page_size, 100)
        }
        await writeFile(
          join(root, label + "-metrics.json"),
          JSON.stringify(metrics, null, 2) + "\n",
          { mode: 0o600, flag: "wx" },
        )
        const beforeExport = requests.length
        const output = join(root, label + "-export")
        const exported = await invokeCli(
          [
            "export",
            result.snapshot_id,
            "--offline",
            "--projection",
            "snapshot",
            "--output",
            output,
          ],
          cwd,
          currentEnv,
        )
        assert.equal(exported.code, 0, exported.stdout + exported.stderr)
        assert.equal(requests.length, beforeExport)
        const inventory = []
        for (const path of (await readdir(output, { recursive: true })).sort()) {
          const info = await lstat(join(output, path))
          if (info.isDirectory()) continue
          assert.equal(info.isFile(), true)
          const bytes = await readFile(join(output, path))
          inventory.push({ path, bytes: bytes.length, sha256: hash(bytes) })
        }
        assert.deepEqual(inventory, expected.export_files)
        let resourceRef
        if (label === "scalar-cold") {
          const directory = await invokeCli(
            ["files", result.snapshot_id, "--offline", "--metrics"],
            cwd,
            currentEnv,
          )
          assert.equal(directory.code, 0, directory.stdout + directory.stderr)
          assert.equal(directory.value.request_metrics.total_requests, 0)
          resourceRef = directory.value.files.find((file) => file.path !== result.entrypoint)?.ref
          assert.equal(typeof resourceRef, "string")
          assert.equal(requests.length, beforeExport)
        }
        evidence.phases.push({
          label,
          kind,
          ref: result.ref,
          snapshot_id: result.snapshot_id,
          resource_ref: resourceRef,
          content_bytes: Buffer.byteLength(result.content),
          content_sha256: hash(result.content),
          native_references: result.native_references,
          skills_queries: queries,
          skills_response_bytes: queries.reduce(
            (total, call) => total + call.decoded_response_bytes,
            0,
          ),
          notion_requests: calls.length,
          notion_response_bytes: metrics.response_bytes,
          notion_writes: 0,
          external_target_reads: externalReads.length,
          full_current_page_reads: fullPageReads.length,
          full_export: { output, files: inventory, matches_full_page_oracle: true },
        })
      }
      assert.notEqual(
        sample.oracle.cold.contents["SKILL.md"],
        sample.oracle.refreshed.contents["SKILL.md"],
      )
      const disabledDescriptions = evidence.phases.map(
        (entry) =>
          entry.native_references.entries.find((ref) => ref.page_id === sample.external.disabled)
            .description,
      )
      assert.notEqual(disabledDescriptions[0], disabledDescriptions[1])
      const logicalRelations = relationReads.get("scalar-relations")
      const physicalRelations = relationReads.get("scalar-relations-physical")
      assert.deepEqual(
        { ...logicalRelations.result, freshness: undefined },
        { ...physicalRelations.result, freshness: undefined },
      )
      assert.deepEqual(logicalRelations.manifest, physicalRelations.manifest)
      evidence.relation_equivalence = {
        logical: "scalar-relations",
        physical: "scalar-relations-physical",
        scope: logicalRelations.result.scope,
        snapshot_id: logicalRelations.result.snapshot_id,
        complete_result_except_freshness: true,
        complete_manifest: true,
        members: logicalRelations.result.members,
        required: logicalRelations.result.required,
      }
      for (const observed of evidence.phases) {
        const passes = observed.label === "scalar-relations-physical" ? 3 : 1
        assert.equal(
          observed.skills_queries.length,
          2 * passes,
          observed.label + ": expected complete 101-row inventory passes: " + passes,
        )
        assert.deepEqual(
          observed.skills_queries.map((query) => query.body.start_cursor ?? null),
          Array.from({ length: passes }, () => [null, "offset-100"]).flat(),
        )
        assert.deepEqual(
          observed.skills_queries.map((query) => query.page_ids.length),
          Array.from({ length: passes }, () => [100, 1]).flat(),
        )
        assert.deepEqual(
          observed.skills_queries.map((query) => [query.has_more, query.next_cursor]),
          Array.from({ length: passes }, () => [
            [true, "offset-100"],
            [false, null],
          ]).flat(),
        )
        assert.deepEqual(
          observed.skills_queries.flatMap((query) => query.page_ids),
          Array.from({ length: passes }, () => sample.notion.skills.map((row) => row.id)).flat(),
        )
      }
      // Reuse the same installed package, loopback source and cache. The second
      // entry is a separate CLI process; neither path may renew a warm TTL.
      notion.main = structuredClone(sample.notion.refreshed_main)
      notion.skills = structuredClone(sample.notion.refreshed_skills)
      const readCurrent = async (
        label,
        {
          ref = sample.root_ref,
          policy = {},
          cliProcess = false,
          catalog = false,
          resources = false,
          error,
        } = {},
      ) => {
        phase = label
        const reports = []
        let result, failure
        if (cliProcess) {
          const argv = [
            "read",
            ref,
            "--database",
            notion.library.skills.database_id,
            "--json",
            "--metrics",
          ]
          if (policy.offline) argv.push("--offline")
          if (policy.refresh) argv.push("--refresh")
          const invocation = await invokeCli(argv, sdkCwd, currentEnv)
          reports.push(invocation.value.request_metrics)
          if (invocation.code === 0) result = withoutMetrics(invocation.value)
          else failure = invocation.value.error?.code
        } else {
          try {
            const operationOptions = {
              ...options,
              cwd: sdkCwd,
              env: currentEnv,
              database: notion.library.skills.database_id,
              ...policy,
              onRequestMetrics: (report) => reports.push(report),
            }
            result = catalog
              ? await sdk.listCatalog(operationOptions)
              : resources
                ? await sdk.readResources({ version: 1, refs: [ref] }, operationOptions)
                : await sdk.readSkill(ref, operationOptions)
            if (resources && result.status === "failed") failure = result.error.code
          } catch (cause) {
            assert.ok(cause instanceof sdk.SkillsError)
            failure = cause.code
          }
        }
        assert.equal(reports.length, 1)
        const metrics = reports[0]
        const calls = requests.filter((call) => call.phase === label)
        const observed = {
          label,
          entry: cliProcess
            ? "installed-cli"
            : catalog
              ? "installed-sdk-catalog"
              : resources
                ? "installed-sdk-resources"
                : "installed-sdk",
          policy,
          ref,
          result,
          error: failure,
          request_metrics: metrics,
          calls,
        }
        evidence.cache_lifecycle.push(observed)
        await writeFile(join(root, label + ".json"), JSON.stringify(observed, null, 2) + "\n", {
          mode: 0o600,
          flag: "wx",
        })
        assert.equal(failure, error)
        assert.equal(metrics.in_flight, 0)
        assert.equal(metrics.trace_enabled, true)
        assert.equal(metrics.trace_dropped, 0)
        assert.equal(metrics.unknown_request_bytes, 0)
        assert.equal(metrics.unknown_response_bytes, 0)
        assert.equal(metrics.requests.notion_write, 0)
        assert.equal(metrics.requests.provider, 0)
        assert.equal(metrics.total_requests, calls.length)
        assert.equal(
          metrics.request_bytes,
          calls.reduce((total, call) => total + call.request_bytes, 0),
        )
        assert.equal(
          metrics.response_bytes,
          calls.reduce((total, call) => total + call.decoded_response_bytes, 0),
        )
        assert.equal(
          metrics.trace.filter((event) => event.event === "attempt").length,
          calls.length,
        )
        assert.deepEqual(unexpected, [])
        assert.equal(
          calls.filter((call) =>
            Object.values(sample.external).some((id) => call.path.startsWith(`/v1/pages/${id}`)),
          ).length,
          0,
        )
        return observed
      }
      const clearObservations = async (label, all = false) => {
        phase = label
        const invocation = await invokeCli(
          [
            "ctl",
            "cache",
            "clear",
            ...(all
              ? ["--all"]
              : [sample.root_ref, "--database", notion.library.skills.database_id]),
          ],
          sdkCwd,
          currentEnv,
        )
        const calls = requests.filter((call) => call.phase === label)
        const observed = { label, entry: "installed-cli", result: invocation.value, calls }
        evidence.cache_lifecycle.push(observed)
        await writeFile(join(root, label + ".json"), JSON.stringify(observed, null, 2) + "\n", {
          mode: 0o600,
          flag: "wx",
        })
        assert.equal(invocation.code, 0, JSON.stringify(invocation.value))
        assert.equal(invocation.value.operation, "cache_clear")
        assert.equal(calls.length, 0)
      }
      const warm = await readCurrent("cache-warm-sdk")
      assert.equal(warm.request_metrics.total_requests, 0)
      assert.equal(warm.result.content, sample.oracle.refreshed.contents["SKILL.md"])
      const cliWarm = await readCurrent("cache-warm-cli", { cliProcess: true })
      assert.equal(cliWarm.request_metrics.total_requests, 0)
      assert.equal(cliWarm.result.freshness.validated_at, warm.result.freshness.validated_at)
      // The unit harness owns the 300000ms default-clock boundary. This installed
      // run exercises the explicit max-age expiry policy without a five-minute sleep.
      const expired = await readCurrent("cache-expired-unchanged", { policy: { maxAge: 1 } })
      assert.equal(expired.result.source, "notion")
      assert.equal(expired.result.freshness.policy, "max_age")
      assert.equal(expired.result.freshness.max_age_ms, 1)
      assert.ok(expired.request_metrics.total_requests > 0)
      assert.equal(expired.request_metrics.requests.notion_body, 0)
      assert.equal(expired.result.snapshot_id, warm.result.snapshot_id)
      assert.equal(expired.result.content, warm.result.content)
      denyCurrent = true
      const denied = await readCurrent("cache-denied-refresh", {
        policy: { refresh: true },
        error: "ACCESS_DENIED",
      })
      assert.ok(denied.calls.some((call) => call.status === 403))
      await readCurrent("cache-denied-current-sdk", { error: "ACCESS_DENIED" })
      await readCurrent("cache-denied-current-cli", { cliProcess: true, error: "ACCESS_DENIED" })
      const offline = await readCurrent("cache-denied-offline", { policy: { offline: true } })
      assert.equal(offline.request_metrics.total_requests, 0)
      assert.equal(offline.result.snapshot_id, expired.result.snapshot_id)
      assert.equal(offline.result.content, expired.result.content)
      assert.equal(offline.result.freshness.validated_at, expired.result.freshness.validated_at)
      assert.equal(offline.result.freshness.stale, true)
      const old = evidence.phases.find((entry) => entry.label === "scalar-cold")
      for (const [label, extra] of [
        ["cache-denied-default-pin", {}],
        ["cache-denied-fixed-resource", { resources: true }],
      ]) {
        const blocked = await readCurrent(label, {
          ref: extra.resources ? old.resource_ref : old.ref,
          error: "ACCESS_DENIED",
          ...extra,
        })
        assert.equal(blocked.request_metrics.total_requests, 0)
      }
      await clearObservations("cache-denied-clear-target")
      const stillDenied = await readCurrent("cache-denied-pin-after-clear", {
        ref: old.ref,
        error: "ACCESS_DENIED",
        cliProcess: true,
      })
      assert.equal(stillDenied.request_metrics.total_requests, 0)
      const pinned = await readCurrent("cache-denied-old-pin", {
        ref: old.ref,
        policy: { offline: true },
        cliProcess: true,
      })
      assert.equal(pinned.request_metrics.total_requests, 0)
      assert.equal(pinned.result.snapshot_id, old.snapshot_id)
      assert.equal(pinned.result.content, sample.oracle.cold.contents["SKILL.md"])
      assert.equal(pinned.result.freshness.policy, "pinned")
      assert.equal(pinned.result.freshness.stale, true)
      denyCurrent = false
      const recovered = await readCurrent("cache-permission-recovered")
      assert.equal(recovered.result.source, "notion")
      assert.ok(recovered.request_metrics.total_requests > 0)
      assert.equal(recovered.result.snapshot_id, expired.result.snapshot_id)
      assert.equal(recovered.result.content, expired.result.content)
      const recoveredPin = await readCurrent("cache-recovered-default-pin", { ref: old.ref })
      assert.equal(recoveredPin.request_metrics.total_requests, 0)
      assert.equal(recoveredPin.result.content, sample.oracle.cold.contents["SKILL.md"])
      const recoveredResource = await readCurrent("cache-recovered-fixed-resource", {
        ref: old.resource_ref,
        resources: true,
      })
      assert.equal(recoveredResource.request_metrics.total_requests, 0)
      assert.equal(recoveredResource.result.status, "ready")
      assert.equal(
        recoveredResource.result.files[0].content,
        sample.oracle.cold.contents[recoveredResource.result.files[0].path],
      )
      const recoveredWarm = await readCurrent("cache-recovered-cli-warm", { cliProcess: true })
      assert.equal(recoveredWarm.request_metrics.total_requests, 0)
      assert.equal(
        recoveredWarm.result.freshness.validated_at,
        recovered.result.freshness.validated_at,
      )
      const directory = await readCurrent("cache-directory-established", {
        catalog: true,
        policy: { refresh: true },
      })
      denyAuthentication = true
      const revoked = await readCurrent("cache-auth-denied-directory-refresh", {
        catalog: true,
        policy: { refresh: true },
        error: "AUTH_REQUIRED",
      })
      assert.ok(revoked.calls.some((call) => call.status === 401))
      await readCurrent("cache-auth-denied-current-sdk", { error: "AUTH_REQUIRED" })
      await readCurrent("cache-auth-denied-current-cli", {
        cliProcess: true,
        error: "AUTH_REQUIRED",
      })
      await readCurrent("cache-auth-denied-directory", { catalog: true, error: "AUTH_REQUIRED" })
      const retainedDirectory = await readCurrent("cache-auth-offline-directory", {
        catalog: true,
        policy: { offline: true },
      })
      assert.equal(retainedDirectory.request_metrics.total_requests, 0)
      assert.equal(retainedDirectory.result.freshness.stale, true)
      assert.equal(retainedDirectory.result.fetched_at, directory.result.fetched_at)
      assert.deepEqual(retainedDirectory.result.records, directory.result.records)
      assert.equal(Object.hasOwn(retainedDirectory.result, "invalidated"), false)
      const retainedCurrent = await readCurrent("cache-auth-offline-current", {
        policy: { offline: true },
      })
      assert.equal(retainedCurrent.request_metrics.total_requests, 0)
      assert.equal(retainedCurrent.result.freshness.stale, true)
      assert.equal(
        retainedCurrent.result.freshness.validated_at,
        recovered.result.freshness.validated_at,
      )
      assert.equal(retainedCurrent.result.content, recovered.result.content)
      const authPin = await readCurrent("cache-auth-old-pin", {
        ref: old.ref,
        policy: { offline: true },
        cliProcess: true,
      })
      assert.equal(authPin.request_metrics.total_requests, 0)
      assert.equal(authPin.result.content, sample.oracle.cold.contents["SKILL.md"])
      assert.equal(authPin.result.freshness.policy, "pinned")
      assert.equal(authPin.result.freshness.stale, true)
      for (const [label, extra] of [
        ["cache-auth-denied-default-pin", { cliProcess: true }],
        ["cache-auth-denied-fixed-resource", { resources: true }],
      ]) {
        const blocked = await readCurrent(label, {
          ref: extra.resources ? old.resource_ref : old.ref,
          error: "AUTH_REQUIRED",
          ...extra,
        })
        assert.equal(blocked.request_metrics.total_requests, 0)
      }
      await clearObservations("cache-auth-denied-clear-all", true)
      const authStillDenied = await readCurrent("cache-auth-pin-after-clear", {
        ref: old.ref,
        error: "AUTH_REQUIRED",
      })
      assert.equal(authStillDenied.request_metrics.total_requests, 0)
      const authOfflineAfterClear = await readCurrent("cache-auth-offline-pin-after-clear", {
        ref: old.ref,
        policy: { offline: true },
      })
      assert.equal(authOfflineAfterClear.request_metrics.total_requests, 0)
      assert.equal(authOfflineAfterClear.result.content, sample.oracle.cold.contents["SKILL.md"])
      assert.equal(authOfflineAfterClear.result.freshness.stale, true)
      denyAuthentication = false
      const authRecovered = await readCurrent("cache-auth-recovered")
      assert.equal(authRecovered.result.source, "notion")
      assert.equal(authRecovered.result.content, recovered.result.content)
      assert.ok(authRecovered.request_metrics.total_requests > 0)
      const authRecoveredPin = await readCurrent("cache-auth-recovered-default-pin", {
        ref: old.ref,
      })
      assert.equal(authRecoveredPin.request_metrics.total_requests, 0)
      assert.equal(authRecoveredPin.result.content, sample.oracle.cold.contents["SKILL.md"])
      assert.notEqual(authRecoveredPin.result.freshness.stale, true)
      const catalogRecovered = await readCurrent("cache-auth-recovered-directory", {
        catalog: true,
      })
      assert.equal(catalogRecovered.request_metrics.total_requests, 0)
      assert.equal(catalogRecovered.result.freshness.stale, false)
      await viewDynamics()
      evidence.status = "passed"
      return evidence
    } catch (error) {
      evidence.status = "failed"
      evidence.error = String(error)
      evidence.unexpected_notion_requests = unexpected
      throw error
    } finally {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      await writeFile(
        join(root, "scalar-inventory-evidence.json"),
        JSON.stringify(evidence, null, 2) + "\n",
        { mode: 0o600, flag: "wx" },
      )
    }
  })

  const resourceInput = { version: 1, refs: fixture.resourceBatch.refs }
  let resourcesReady
  await test("one resource batch preserves UTF-8, BOM, CRLF, empty and binary source bytes", async () => {
    const expected = fixture.resourceBatch
    const reports = []
    const result = await sdk.readResources(resourceInput, {
      ...options,
      offline: true,
      onRequestMetrics: (value) => reports.push(value),
    })
    assert.equal(result.status, "ready", JSON.stringify(result))
    const owner = fixture.snapshots.find((snapshot) => snapshot.record.name === expected.name)
    assert.deepEqual(result.selection, {
      scope: owner.scope,
      owner: owner.record.id,
      snapshot_id: owner.snapshot_id,
      version_id: owner.version_id,
    })
    assert.deepEqual(result.budget, { maxFiles: 16, maxBytes: 1048576, timeBudgetMs: 30000 })
    assert.equal(
      result.manifest.files.length,
      owner.files.length,
      "The complete manifest still includes the main and unselected resource",
    )
    assert.deepEqual(result.materialization, {
      status: "selected_files_ready",
      paths: expected.files.map((file) => file.path),
    })
    assert.deepEqual(result.delivery, { status: "not_observed" })
    assert.deepEqual(result.totals, {
      files: expected.files.length,
      bytes: expected.files.reduce((sum, file) => sum + file.bytes, 0),
    })
    assert.deepEqual(
      result.files,
      expected.files.map((file) => ({ requested_ref: file.ref, ...file })),
    )
    for (const file of result.files) {
      const bytes = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8")
      assert.equal(bytes.length, file.bytes)
      assert.equal(hash(bytes), file.sha256)
    }
    assert.equal(result.files.find((file) => file.path.endsWith("empty.txt")).content, "")
    assert.deepEqual(
      reports.map((report) => ({
        requests: report.total_requests,
        in_flight: report.in_flight,
        trace: report.trace_enabled,
      })),
      [{ requests: 0, in_flight: 0, trace: true }],
    )
    assert.deepEqual(await sdk.decodeResourceReadResult(result, resourceInput), result)
    resourcesReady = result
    await writeFile(
      join(root, "resource-batch-ready.json"),
      JSON.stringify(result, null, 2) + "\n",
      {
        mode: 0o600,
      },
    )
    return {
      files: result.totals.files,
      bytes: result.totals.bytes,
      source_http: 0,
      source_cache: "warm",
      sdk_calls: 1,
      delivery: "not_observed",
    }
  })

  await test("warm resource batch, exact aggregate budgets and stable File aliases preserve the selection", async () => {
    assert.equal(resourcesReady?.status, "ready")
    const reports = []
    const repeated = await sdk.readResources(resourceInput, {
      ...options,
      offline: true,
      onRequestMetrics: (value) => reports.push(value),
    })
    assert.deepEqual(repeated, resourcesReady)
    assert.equal(reports.length, 1)
    assert.equal(reports[0].total_requests, 0)
    assert.equal(reports[0].in_flight, 0)
    const exact = {
      ...resourceInput,
      budget: { maxFiles: resourcesReady.totals.files, maxBytes: resourcesReady.totals.bytes },
    }
    assert.equal((await sdk.readResources(exact, { ...options, offline: true })).status, "ready")
    for (const [budget, code] of [
      [{ maxFiles: resourcesReady.totals.files - 1 }, "RESOURCE_FILE_BUDGET"],
      [{ maxBytes: resourcesReady.totals.bytes - 1 }, "RESOURCE_BYTE_BUDGET"],
    ]) {
      const denied = await sdk.readResources(
        { ...resourceInput, budget },
        { ...options, offline: true },
      )
      assert.equal(denied.status, "failed")
      assert.equal(denied.error.code, code)
    }
    const alias = new URL(resourceInput.refs[0])
    alias.pathname = "/old-resource-name.md"
    const aliased = { version: 1, refs: [String(alias)] }
    const corrected = await sdk.readResources(aliased, { ...options, offline: true })
    assert.equal(corrected.status, "ready", JSON.stringify(corrected))
    assert.equal(corrected.files[0].requested_ref, String(alias))
    assert.equal(corrected.files[0].ref, resourceInput.refs[0])
    assert.equal(corrected.files[0].content, fixture.resourceBatch.files[0].content)
    assert.deepEqual(await sdk.decodeResourceReadResult(corrected, aliased), corrected)
    for (const [refs, code] of [
      [[resourceInput.refs[0], String(alias)], "RESOURCE_SELECTION_CONFLICT"],
      [[resourceInput.refs[0], resourceInput.refs[0]], "INVALID_ARGUMENT"],
      [[fixture.resourceBatch.owner_ref], "RESOURCE_MAIN_NOT_ALLOWED"],
      [[resourceInput.refs[0], fixture.resource.ref], "RESOURCE_SELECTION_CONFLICT"],
    ]) {
      const denied = await sdk.readResources({ version: 1, refs }, { ...options, offline: true })
      assert.equal(denied.status, "failed", JSON.stringify(denied))
      assert.equal(denied.error.code, code)
    }
    return {
      warm_http: reports[0].total_requests,
      aggregate_budget_checked: true,
      stable_file_alias_corrected: true,
    }
  })

  await test("resource decoder rejects incomplete, mismatched and fabricated batch evidence", async () => {
    assert.equal(resourcesReady?.status, "ready")
    for (const mutate of [
      (result) => {
        result.files.pop()
      },
      (result) => {
        result.files.reverse()
      },
      (result) => {
        result.files[0].content += "truncated"
      },
      (result) => {
        result.files[0].sha256 = "0".repeat(64)
      },
      (result) => {
        result.files[0].file_id = "foreign"
      },
      (result) => {
        result.selection.owner = "shared_skill:sdk-library:foreign"
      },
      (result) => {
        result.selection.scope = "0".repeat(64)
      },
      (result) => {
        result.manifest.files.pop()
      },
      (result) => {
        result.totals.bytes++
      },
      (result) => {
        result.materialization.paths.pop()
      },
      (result) => {
        result.delivery.status = "delivered"
      },
    ]) {
      const changed = structuredClone(resourcesReady)
      mutate(changed)
      await assert.rejects(
        sdk.decodeResourceReadResult(changed, resourceInput),
        (error) => error instanceof sdk.SkillsError && error.code === "RESOURCE_INVALID_PROOF",
      )
    }
    const controller = new AbortController()
    controller.abort()
    const reports = []
    const cancelled = await sdk.readResources(resourceInput, {
      env: {},
      signal: controller.signal,
      onRequestMetrics: (value) => reports.push(value),
    })
    assert.deepEqual(cancelled, { version: 1, status: "cancelled", reason: "interrupted" })
    assertNoTransport(reports, false)
  })

  await test("Required failure and unknown versions stay typed and nonready", async () => {
    const result = await sdk.consume(input([fixture.broken]), options)
    const legacy = await invokeCli(["ctl", "prepare", fixture.broken, "--offline"])
    assert.equal(result.status, "failed")
    assert.equal(legacy.code, 1)
    assert.deepEqual(result.error, legacy.value.error)
    const reports = []
    const unsupported = await sdk.consume(
      { ...input(fixture.roots), requestedFiles: [fixture.resource.ref] },
      { env: {}, onRequestMetrics: (value) => reports.push(value) },
    )
    assert.equal(unsupported.status, "failed")
    assert.equal(unsupported.error.code, "CONSUME_UNSUPPORTED")
    const unknown = await sdk.consume({ ...input(fixture.roots), version: 2 }, { env: {} })
    assert.equal(unknown.status, "failed")
    assert.equal(unknown.error.code, "INVALID_ARGUMENT")
    assertNoTransport(reports, false)
    await assert.rejects(
      sdk.decodeConsumeResult({ ...ready, version: 2 }),
      (error) => error instanceof sdk.SkillsError && error.code === "CONSUME_INVALID_PROOF",
    )
  })

  await test("public proof decoder rejects wrong scope, File, hash, partial text and selected library", async () => {
    assert.equal(ready?.status, "ready")
    const mutations = [
      (result) => {
        result.entries[0].manifest.scope = "0".repeat(64)
      },
      (result) => {
        result.entries[0].manifest.file_bindings[0].file_id = "wrong-main"
      },
      (result) => {
        result.entries[0].source_body.sha256 = "0".repeat(64)
      },
      (result) => {
        result.entries[0].source_body.has_more = true
      },
      (result) => {
        result.preparation.nodes.find((node) => node.state === "prepared").content += "truncated"
      },
    ]
    for (const mutate of mutations) {
      const changed = structuredClone(ready)
      mutate(changed)
      await assert.rejects(
        sdk.decodeConsumeResult(changed, input(fixture.roots)),
        (error) => error instanceof sdk.SkillsError && error.code === "CONSUME_INVALID_PROOF",
      )
    }
    await assert.rejects(
      sdk.decodeConsumeResult(ready, input([fixture.foreign])),
      (error) => error instanceof sdk.SkillsError && error.code === "CONSUME_INVALID_PROOF",
    )
  })

  await test("pre-abort and initialization failure prove zero transport without late delivery", async () => {
    const controller = new AbortController()
    controller.abort()
    const reports = []
    const result = await sdk.consume(input(fixture.roots), {
      env: {},
      signal: controller.signal,
      onRequestMetrics: (value) => reports.push(value),
    })
    assert.equal(result.status, "cancelled")
    await assert.rejects(
      sdk.readSkill(fixture.resource.ref, { env: {}, signal: controller.signal }),
      (error) => error instanceof sdk.SkillsError && error.code === "CANCELLED",
    )
    assertNoTransport(reports, false)
    const failedReports = []
    const failed = await sdk.consume(input(fixture.roots), {
      env: {},
      onRequestMetrics: (value) => failedReports.push(value),
    })
    assert.equal(failed.status, "failed")
    assert.equal(failed.error.code, "CONFIG_ERROR")
    assertNoTransport(failedReports, false)
  })

  await test("pre-abort and paused runtime initialization retain complete zero-attempt metrics", async () => {
    const requests = []
    const server = createServer((request, response) => {
      requests.push({ method: request.method, url: request.url })
      response.writeHead(401, { "content-type": "application/json" })
      response.end(JSON.stringify({ object: "error", code: "unauthorized", message: "controlled" }))
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const observations = []
    try {
      for (const phase of ["pre-abort", "configuration-read"])
        for (const operation of [
          "listCatalog",
          "listSkills",
          "consume",
          "readSkill",
          "readResources",
        ]) {
          const state = join(root, `initialization-${phase}-${operation}`)
          const configPath = join(state, "config", "config.json")
          await mkdir(join(state, "config"), { recursive: true })
          await writeFile(configPath, "{}\n")
          const controller = new AbortController()
          if (phase === "pre-abort") controller.abort()
          const probe = {
            controller,
            configPath: phase === "configuration-read" ? configPath : undefined,
            config_reads: 0,
            fetch_calls: 0,
          }
          const reports = []
          const operationOptions = {
            ...options,
            cwd: state,
            env: {
              ...env,
              NTN_SKILLS_HOME: join(state, "state"),
              NTN_SKILLS_CONFIG_HOME: join(state, "config"),
              NTN_SKILLS_CACHE_HOME: join(state, "cache"),
              NOTION_API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
            },
            signal: controller.signal,
            onRequestMetrics: (value) => reports.push(value),
          }
          let result
          let error
          activeInitializationProbe = probe
          try {
            result = await (operation === "listCatalog" || operation === "listSkills"
              ? sdk[operation](operationOptions)
              : sdk[operation](
                  operation === "consume"
                    ? input(fixture.roots)
                    : operation === "readSkill"
                      ? fixture.resource.ref
                      : resourceInput,
                  operationOptions,
                ))
          } catch (caught) {
            error = { code: caught?.code, typed: caught instanceof sdk.SkillsError }
          } finally {
            activeInitializationProbe = undefined
          }
          observations.push({
            phase,
            operation,
            config_reads: probe.config_reads,
            fetch_calls: probe.fetch_calls,
            signal_aborted: controller.signal.aborted,
            reports,
            result,
            error,
          })
        }
      const evidence = { observations, actual_http: requests }
      await writeFile(
        join(root, "initialization-cancellation.json"),
        JSON.stringify(evidence, null, 2) + "\n",
        { mode: 0o600 },
      )
      assert.deepEqual(requests, [])
      for (const observation of observations) {
        assert.equal(observation.config_reads, observation.phase === "configuration-read" ? 1 : 0)
        assert.equal(observation.fetch_calls, 0)
        assert.equal(observation.signal_aborted, true)
        if (observation.operation === "consume" || observation.operation === "readResources")
          assert.deepEqual(observation.result, {
            version: 1,
            status: "cancelled",
            reason: "interrupted",
          })
        else assert.deepEqual(observation.error, { code: "CANCELLED", typed: true })
        assertNoTransport(observation.reports, true)
      }
      return evidence
    } finally {
      activeInitializationProbe = undefined
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  })

  const bounded = (promise) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Controlled operation exceeded 5 seconds")),
        5000,
      )
      Promise.resolve(promise).then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  for (const operation of ["consume", "readResources"])
    for (const phase of ["headers", "body"])
      await test(`${operation} abort during ${phase} waits for owned HTTP cleanup`, async () => {
        const controller = new AbortController()
        let requested
        const requestSeen = new Promise((resolve) => {
          requested = resolve
        })
        let closed
        const connectionClosed = new Promise((resolve) => {
          closed = resolve
        })
        const server = createServer((_request, response) => {
          response.on("close", closed)
          if (phase === "body") {
            response.writeHead(200, { "content-type": "application/json" })
            response.write('{"object":"user","id":"partial')
          }
          requested()
        })
        server.listen(0, "127.0.0.1")
        await once(server, "listening")
        const state = join(root, `abort-${operation}-${phase}`)
        if (operation === "readResources") {
          assert.ok(isAbsolute(fixture.resourceBatch.retained_fixture))
          await cp(fixture.resourceBatch.retained_fixture, state, {
            recursive: true,
            errorOnExist: true,
            force: false,
          })
        } else await mkdir(state)
        const reports = []
        let receivedHeaders
        const headersSeen = new Promise((resolve) => {
          receivedHeaders = resolve
        })
        const headersChannel = channel("undici:request:headers")
        const onHeaders = () => receivedHeaders()
        if (phase === "body") headersChannel.subscribe(onHeaders)
        const transportProbe = { fetch_calls: 0 }
        activeInitializationProbe = transportProbe
        try {
          const pending = sdk[operation](
            operation === "consume"
              ? { ...input(fixture.roots), freshness: { policy: "default" } }
              : resourceInput,
            {
              ...options,
              cwd: state,
              env: { ...env, NOTION_API_BASE_URL: `http://127.0.0.1:${server.address().port}` },
              signal: controller.signal,
              onRequestMetrics: (value) => reports.push(value),
            },
          )
          await bounded(phase === "body" ? headersSeen : requestSeen)
          controller.abort()
          const result = await bounded(pending)
          assert.equal(result.status, "cancelled")
          await bounded(connectionClosed)
          assert.equal(reports.length, 1)
          assert.equal(reports[0].in_flight, 0)
          assert.equal(reports[0].total_requests, 1)
          assert.equal(reports[0].outcomes.cancelled, 1)
          assert.equal(transportProbe.fetch_calls, 1)
          const attempts = reports[0].trace.filter((event) => event.event === "attempt")
          assert.equal(attempts.length, 1)
          assert.equal(
            reports[0].unknown_response_bytes,
            attempts[0].response_bytes === null ? 1 : 0,
          )
          if (phase === "headers") assert.equal(reports[0].unknown_response_bytes, 1)
          return {
            scope_closed: true,
            response_closed: true,
            requests: reports[0].total_requests,
            fetch_calls: transportProbe.fetch_calls,
            request_metrics: reports[0],
            phase,
          }
        } finally {
          activeInitializationProbe = undefined
          controller.abort()
          if (phase === "body") headersChannel.unsubscribe(onHeaders)
          server.closeAllConnections()
          await new Promise((resolve) => server.close(resolve))
        }
      })

  await test("concurrent cwd/env isolation and credential rotation remain operation scoped", async () => {
    const headers = []
    const server = createServer((request, response) => {
      headers.push(hash(request.headers.authorization ?? ""))
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ object: "user", id: "controlled-sdk-user" }))
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    try {
      const localEnv = { ...env, NOTION_API_BASE_URL: `http://127.0.0.1:${server.address().port}` }
      const tokens = ["sdk-isolation-one", "sdk-isolation-two", "sdk-isolation-rotated"]
      const locations = [join(root, "isolation-one"), join(root, "isolation-two")]
      await Promise.all(locations.map((path) => mkdir(path)))
      const mutable = { ...localEnv, NOTION_API_TOKEN: tokens[0] }
      const request = { ...input([fixture.roots[0]]), freshness: { policy: "default" } }
      const first = sdk.consume(request, { env: mutable, cwd: locations[0] })
      mutable.NOTION_API_TOKEN = tokens[2]
      const second = sdk.consume(request, {
        env: { ...localEnv, NOTION_API_TOKEN: tokens[1] },
        cwd: locations[1],
      })
      const results = await bounded(Promise.all([first, second]))
      assert.equal(
        results.every((result) => result.status === "failed"),
        true,
      )
      assert.equal(
        (await sdk.consume(request, { env: mutable, cwd: locations[0] })).status,
        "failed",
      )
      assert.deepEqual(headers.sort(), tokens.map((token) => hash(`Bearer ${token}`)).sort())
      assert.equal(process.cwd(), originalCwd)
      assert.equal(process.env.NOTION_API_TOKEN === originalToken, true)
      return {
        operations: 3,
        distinct_credential_hashes: new Set(headers).size,
        global_environment_unchanged: true,
      }
    } finally {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  })

  const report = {
    version: 1,
    node: process.version,
    archive,
    archive_sha256: hash(await readFile(archive)),
    installed_package: manifest.version,
    sdk_path: sdkPath,
    fixture: fixturePath,
    selection: args[7] ?? "all",
    passed: cases.filter((item) => item.status === "passed").length,
    failed: cases.filter((item) => item.status === "failed").length,
    cases,
  }
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  })
  console.log(
    JSON.stringify({
      report: join(root, "report.json"),
      passed: report.passed,
      failed: report.failed,
    }),
  )
  process.exitCode = report.failed ? 1 : 0
} finally {
  activeSourceProbe = undefined
  globalThis.fetch = originalFetch
}
