import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  options: { root: { type: "string" }, sdk: { type: "string" }, label: { type: "string" } },
})
assert.ok(values.root && values.sdk && values.label)
assert.match(values.label, /^[a-z0-9][a-z0-9-]*$/u)
const root = resolve(values.root),
  sdkPath = resolve(values.sdk),
  label = values.label
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
const json = async (path) => JSON.parse(await readFile(path, "utf8"))
const save = async (path, value) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 })
}
assert.equal((await json(join(root, "verification-run.json"))).root, root)
const baseline = await json(join(root, "evidence/nxt-baseline.json"))
const original = (await json(join(root, "evidence/nxt-commands/baseline-cold-main.json"))).output
const expected = baseline.files.find((file) => file.path === "scripts/example.sh")
assert.ok(expected && typeof original.ref === "string")
const evidence = join(root, "evidence/nxt-sdk-resource", label + ".json")
const artifactSha = digest(await readFile(sdkPath))
await save(evidence + ".started", {
  sdk: sdkPath,
  sha256: artifactSha,
  label,
  source_pin: original.ref,
  resource: expected,
  started: new Date().toISOString(),
})
try {
  const sdk = await import(pathToFileURL(sdkPath).href)
  const environment = (name) => {
    const directory = join(root, "scratch/clients", name)
    const env = {
      ...process.env,
      NTN_SKILLS_CONFIG_HOME: join(directory, "config"),
      NTN_SKILLS_HOME: join(directory, "state"),
      NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
      NTN_SKILLS_DATA_HOME: join(directory, "data"),
      NTN_SKILLS_REQUEST_TRACE_LIMIT: "10000",
    }
    delete env.NTN_SKILLS_DEV_ROOT
    return env
  }
  const env = environment(`sdk-${label}-pair`)
  await mkdir(dirname(env.NTN_SKILLS_HOME), { mode: 0o700 })
  let bootstrapMetrics = null,
    bootstrap,
    listing
  try {
    bootstrap = await sdk.readSkill(original.record.locator.page_id, {
      env,
      database: original.record.locator.database_id,
      readOnly: true,
      metrics: true,
      onRequestMetrics: (value) => {
        bootstrapMetrics = value
      },
    })
    assert.equal(bootstrap.snapshot_id, original.snapshot_id)
    const directoryRef = new URL(original.ref)
    directoryRef.pathname = "/"
    directoryRef.searchParams.delete("file_id")
    listing = await sdk.listSkill(directoryRef.toString(), {
      env,
      database: original.record.locator.database_id,
      metrics: true,
    })
  } catch (error) {
    await save(evidence, {
      label,
      stage: "bootstrap",
      error: {
        code: error?.code ?? null,
        message: error instanceof Error ? error.message : "unknown",
      },
      bootstrap,
      bootstrapMetrics,
    })
    throw error
  }
  await save(evidence + ".bootstrap", {
    snapshot_id: bootstrap.snapshot_id,
    metrics: bootstrapMetrics,
    listing,
  })
  const resource = listing.files.find((file) => file.path === expected.path)
  assert.equal(resource?.sha256, expected.sha256)
  assert.equal(resource?.bytes, expected.bytes)
  assert.ok(typeof resource?.ref === "string")
  const input = {
    version: 1,
    refs: [resource.ref],
    budget: { maxFiles: 1, maxBytes: 1024, timeBudgetMs: 120000 },
  }
  const frozenPath = join(root, "evidence/nxt-sdk-resource-input.json")
  let frozen
  try {
    frozen = await json(frozenPath)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
    frozen = {
      input,
      resource: expected,
      source_pin: original.ref,
      read_only: true,
      client_initial_state: "empty_owned_root_then_identical_public_main_read_no_store_copy",
      ordering: "two_simultaneous_public_sdk_readResources_after_main_bootstrap",
    }
    await save(frozenPath, frozen)
  }
  assert.deepEqual(input, frozen.input)
  assert.deepEqual(expected, frozen.resource)
  let selectedObjectPresent = false
  try {
    await readFile(join(env.NTN_SKILLS_HOME, "objects", expected.sha256))
    selectedObjectPresent = true
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  assert.equal(
    selectedObjectPresent,
    false,
    "The frozen resource must still be lazy after identical main bootstrap",
  )
  const calls = await Promise.all(
    [0, 1].map(async (index) => {
      let metrics = null
      const started = performance.now()
      try {
        const result = await sdk.readResources(frozen.input, {
          env,
          database: original.record.locator.database_id,
          readOnly: true,
          metrics: true,
          onRequestMetrics: (value) => {
            metrics = value
          },
        })
        return { index, result, metrics, elapsed_ms: performance.now() - started }
      } catch (error) {
        return {
          index,
          error: {
            code: error?.code ?? null,
            message: error instanceof Error ? error.message : "unknown SDK failure",
          },
          metrics,
          elapsed_ms: performance.now() - started,
        }
      }
    }),
  )
  const report = {
    version: 1,
    label,
    sdk: sdkPath,
    sdk_sha256: digest(await readFile(sdkPath)),
    input: frozen,
    bootstrap: {
      snapshot_id: bootstrap.snapshot_id,
      metrics: bootstrapMetrics,
      selected_object_present: selectedObjectPresent,
    },
    calls,
    totals: {
      requests: calls.some((call) => call.metrics === null)
        ? null
        : calls.reduce((sum, call) => sum + call.metrics.total_requests, 0),
      response_bytes: calls.some(
        (call) => call.metrics === null || call.metrics.unknown_response_bytes !== 0,
      )
        ? null
        : calls.reduce((sum, call) => sum + call.metrics.response_bytes, 0),
    },
    finished: new Date().toISOString(),
  }
  await save(evidence, report)
  console.log(
    JSON.stringify({
      evidence,
      totals: report.totals,
      outcomes: calls.map((call) => call.result?.status ?? call.error?.code),
    }),
  )
  assert.equal(
    report.sdk_sha256,
    artifactSha,
    "The SDK artifact must remain unchanged during the frozen comparison",
  )
  for (const call of calls) {
    assert.equal(call.result?.status, "ready")
    assert.equal(call.result.files.length, 1)
    assert.equal(call.result.files[0].sha256, expected.sha256)
    assert.equal(call.result.files[0].bytes, expected.bytes)
    assert.equal(
      digest(
        Buffer.from(
          call.result.files[0].content,
          call.result.files[0].encoding === "base64" ? "base64" : "utf8",
        ),
      ),
      expected.sha256,
    )
    assert.equal(call.result.effects?.remote_writes, "none")
    assert.equal(call.metrics?.unknown_response_bytes, 0)
    assert.equal(call.metrics?.in_flight, 0)
  }
} catch (error) {
  await save(evidence + ".failed", {
    label,
    code: error?.code ?? null,
    message: error instanceof Error ? error.message : "unknown SDK failure",
    finished: new Date().toISOString(),
  })
  throw error
}
