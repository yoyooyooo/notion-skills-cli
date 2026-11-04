import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { channel } from "node:diagnostics_channel"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { isAbsolute, join } from "node:path"
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
const cases = []
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
const invokeCli = async (argv) => {
  const result = await command([process.execPath, cli, ...argv], {
    cwd: fixture.cwd,
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
  assert.equal(sdk.PACKAGE_VERSION, manifest.version)
  assert.equal(sdk.parseDuration("2m"), 120000)
  assert.throws(
    () => sdk.parseDuration("2ms"),
    (error) => error instanceof sdk.SkillsError && error.code === "INVALID_ARGUMENT",
  )
  await writeFile(
    join(root, "consumer.ts"),
    `import { consume, readSkill, decodeConsumeResult, SDK_VERSION, parseDuration, type ConsumeInput, type ConsumeResult, type ReadSkillResult, type RequestMetricsSnapshot } from "ntn-skills/sdk";
const input = { version: 1, targets: ["page"], purpose: "use" } satisfies ConsumeInput;
const version: 1 = SDK_VERSION;
const received: Promise<ConsumeResult> = consume(input, { cwd: ".", env: {}, signal: new AbortController().signal, metrics: true, execution: { priority: "prefetch", queueBudgetMs: 100, timeBudgetMs: 200, rateShare: .1 }, onRequestMetrics: (snapshot: RequestMetricsSnapshot | null) => void snapshot });
const read: Promise<ReadSkillResult> = readSkill("file", { offline: true, metrics: true, maxAge: parseDuration("1s") });
void [received, read, decodeConsumeResult({}, input), version];
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
for (const phase of ["headers", "body"])
  await test(`consume abort during ${phase} waits for owned HTTP cleanup`, async () => {
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
    const state = join(root, `abort-${phase}`)
    await mkdir(state)
    const reports = []
    let receivedHeaders
    const headersSeen = new Promise((resolve) => {
      receivedHeaders = resolve
    })
    const headersChannel = channel("undici:request:headers")
    const onHeaders = () => receivedHeaders()
    if (phase === "body") headersChannel.subscribe(onHeaders)
    try {
      const pending = sdk.consume(
        { ...input(fixture.roots), freshness: { policy: "default" } },
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
