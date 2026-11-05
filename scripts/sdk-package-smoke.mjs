import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { channel } from "node:diagnostics_channel"
import { spawn } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs"
import fsPromises, { cp, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire, syncBuiltinESMExports } from "node:module"
import { isAbsolute, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"

const args = process.argv.slice(2)
if (
  args.length !== 6 ||
  args[0] !== "--archive" ||
  args[2] !== "--fixture" ||
  args[4] !== "--outdir" ||
  ![args[1], args[3], args[5]].every(isAbsolute)
)
  throw new Error(
    "Usage: node scripts/sdk-package-smoke.mjs --archive /package.tgz --fixture /fixture.json --outdir /new/absolute/directory",
  )
const [archive, fixturePath, root] = [args[1], args[3], args[5]]
await mkdir(root, { mode: 0o700 })
const hash = (value) => createHash("sha256").update(value).digest("hex")
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
let objectReadSequence = 0
const objectReadEvents = []
const objectEvent = (probe, fields) => {
  const event = { version: 1, sequence: ++objectReadSequence, label: probe.label, ...fields }
  objectReadEvents.push(event)
  fs.appendFileSync(join(root, "entrypoint-object-reads.jsonl"), JSON.stringify(event) + "\n", {
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
const invokeCli = async (argv, cwd = fixture.cwd) => {
  const result = await command([process.execPath, cli, ...argv], {
    cwd,
    env: { ...env, PATH: process.env.PATH },
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

await test("installed SDK versions and generated declaration closure", async () => {
  assert.equal(sdk.SDK_VERSION, 1)
  assert.equal(sdk.CONSUMER_CONTRACT_VERSION, 1)
  assert.equal(sdk.RESOURCE_READ_CONTRACT_VERSION, 1)
  assert.equal(sdk.PACKAGE_VERSION, manifest.version)
  assert.equal(sdk.parseDuration("2m"), 120000)
  assert.throws(
    () => sdk.parseDuration("2ms"),
    (error) => error instanceof sdk.SkillsError && error.code === "INVALID_ARGUMENT",
  )
  await writeFile(
    join(root, "consumer.ts"),
    `import { consume, readSkill, readResources, decodeConsumeResult, decodeResourceReadResult, SDK_VERSION, RESOURCE_READ_CONTRACT_VERSION, parseDuration, type ConsumeInput, type ConsumeResult, type ReadSkillResult, type ResourceReadInput, type ResourceReadResult, type RequestMetricsSnapshot } from "ntn-skills/sdk";
const input = { version: 1, targets: ["page"], purpose: "use" } satisfies ConsumeInput;
const version: 1 = SDK_VERSION;
const received: Promise<ConsumeResult> = consume(input, { cwd: ".", env: {}, signal: new AbortController().signal, metrics: true, execution: { priority: "prefetch", queueBudgetMs: 100, timeBudgetMs: 200, rateShare: .1 }, onRequestMetrics: (snapshot: RequestMetricsSnapshot | null) => void snapshot });
const read: Promise<ReadSkillResult> = readSkill("file", { offline: true, metrics: true, maxAge: parseDuration("1s") });
const resources = { version: 1, refs: ["fixed-file"], budget: { maxFiles: 16, maxBytes: 1048576, timeBudgetMs: 30000 } } satisfies ResourceReadInput;
const resourceVersion: 1 = RESOURCE_READ_CONTRACT_VERSION;
const batch: Promise<ResourceReadResult> = readResources(resources, { cwd: ".", env: {}, offline: true, metrics: true, signal: new AbortController().signal });
void [received, read, batch, decodeConsumeResult({}, input), decodeResourceReadResult({}, resources), version, resourceVersion];
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
    const legacy = await invokeCli(["prepare", ...request.targets, "--offline", "--metrics"])
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
    assert.deepEqual(entry.materialization, { status: "entry_ready", paths: [snapshot.entrypoint] })
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
  await writeFile(join(root, "resource-batch-ready.json"), JSON.stringify(result, null, 2) + "\n", {
    mode: 0o600,
  })
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
  assert.deepEqual(reports, [null])
})

await test("Required failure and unknown versions stay typed and nonready", async () => {
  const result = await sdk.consume(input([fixture.broken]), options)
  const legacy = await invokeCli(["prepare", fixture.broken, "--offline"])
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
  assert.deepEqual(reports, [null])
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

await test("pre-abort and initialization failure report unknown metrics without late delivery", async () => {
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
  assert.deepEqual(reports, [null])
  const failedReports = []
  const failed = await sdk.consume(input(fixture.roots), {
    env: {},
    onRequestMetrics: (value) => failedReports.push(value),
  })
  assert.equal(failed.status, "failed")
  assert.equal(failed.error.code, "CONFIG_ERROR")
  assert.deepEqual(failedReports, [null])
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
        return {
          scope_closed: true,
          response_closed: true,
          requests: reports[0].total_requests,
          phase,
        }
      } finally {
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
    assert.equal((await sdk.consume(request, { env: mutable, cwd: locations[0] })).status, "failed")
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
  passed: cases.filter((item) => item.status === "passed").length,
  failed: cases.filter((item) => item.status === "failed").length,
  cases,
}
await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 })
console.log(
  JSON.stringify({
    report: join(root, "report.json"),
    passed: report.passed,
    failed: report.failed,
  }),
)
process.exitCode = report.failed ? 1 : 0
