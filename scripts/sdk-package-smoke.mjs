import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"
import { startSdkSourceFixture } from "./sdk-source-fixture.mjs"

const args = process.argv.slice(2)
if (
  ![6, 8].includes(args.length) ||
  args[0] !== "--archive" ||
  args[2] !== "--fixture" ||
  args[4] !== "--outdir" ||
  ![args[1], args[3], args[5]].every(isAbsolute) ||
  (args.length === 8 && (args[6] !== "--case" || !["current", "cancellation"].includes(args[7])))
)
  throw new Error(
    "Usage: node scripts/sdk-package-smoke.mjs --archive /package.tgz --fixture /fixture.json --outdir /new/absolute/directory [--case current|cancellation]",
  )
const [archive, fixturePath, selectedRoot] = [args[1], args[3], args[5]]
const selection = args[7] ?? "all"
await mkdir(selectedRoot, { mode: 0o700 })
const root = await realpath(selectedRoot)
const fixture = JSON.parse(await readFile(fixturePath, "utf8"))
assert.equal(fixture.version, 2)
assert.equal(fixture.kind, "current-notion-service")
const env = JSON.parse(await readFile(fixture.env, "utf8"))
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const originalCwd = process.cwd(),
  originalToken = process.env.NOTION_API_TOKEN
const cases = []
let sdkPath, managementPath, packageVersion, source
async function command(argv, options = {}) {
  const child = spawn(argv[0], argv.slice(1), {
    cwd: root,
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
  assert.equal(
    code,
    options.expectedExit ?? 0,
    `${argv.join(" ")} (${signal ?? "exit"}): ${stderr || stdout}`,
  )
  return stdout
}
function bounded(promise) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Current SDK smoke exceeded its 30s deadline")),
        30000,
      )
    }),
  ]).finally(() => clearTimeout(timer))
}
async function idle() {
  await bounded(
    (async () => {
      while (source.requests.some((row) => row.closed_monotonic_ns === null))
        await new Promise((resolve) => setTimeout(resolve, 10))
    })(),
  )
}
async function test(name, group, run) {
  if (selection !== "all" && selection !== group) return
  const started = performance.now()
  try {
    if (source) {
      await idle()
      source.setPhase(name)
    }
    const evidence = await run()
    if (source) await idle()
    cases.push({ name, group, status: "passed", elapsed_ms: performance.now() - started, evidence })
  } catch (error) {
    cases.push({
      name,
      group,
      status: "failed",
      elapsed_ms: performance.now() - started,
      error: String(error),
      stack: error.stack,
    })
  }
  console.log(`${cases.at(-1).status}: ${name}`)
}
const expected = (path) => {
  const file = fixture.expected.files.find((item) => item.path === path)
  assert.ok(file, `Unknown expected path ${path}`)
  return file
}
const directoryRef = (ref) => {
  const url = new URL(ref)
  url.pathname = "/"
  url.searchParams.delete("file_id")
  return url.href
}
const input = (target) => ({ version: 1, targets: [target], purpose: "use" })
const resourceInput = (refs, budget = {}) => ({
  version: 1,
  refs,
  budget: { maxFiles: refs.length, maxBytes: 4096, timeBudgetMs: 30000, ...budget },
})
const recordsPath = `/v1/data_sources/${fixture.notion.library.records.data_source_id}/query`
const recordsSince = (start) =>
  source.requests.slice(start).filter((row) => row.path === recordsPath)
function noWrites(value) {
  assert.deepEqual(value.effects, {
    version: 1,
    remote_writes: "none",
    author_content: "unchanged",
  })
}
function exact(file, actual) {
  assert.equal(actual.sha256, file.sha256)
  assert.equal(actual.bytes, file.bytes)
  assert.equal(actual.encoding, file.encoding)
  assert.equal(actual.content, file.content)
}
await writeFile(
  join(root, "package.json"),
  JSON.stringify({
    private: true,
    type: "module",
    dependencies: { "ntn-skills": `file:${archive}` },
    devDependencies: { typescript: "5.9.3" },
  }) + "\n",
)
try {
  await command(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"])
  const require = createRequire(join(root, "package.json"))
  sdkPath = require.resolve("ntn-skills/sdk")
  assert.ok(sdkPath.startsWith(join(root, "node_modules", "ntn-skills")))
  const sdk = await import(pathToFileURL(sdkPath).href)
  managementPath = require.resolve("ntn-skills/management")
  assert.ok(managementPath.startsWith(join(root, "node_modules", "ntn-skills")))
  const management = await import(pathToFileURL(managementPath).href)
  const manifest = require("ntn-skills/package.json")
  packageVersion = manifest.version
  const cli = require.resolve("ntn-skills/dist/ntn-skills.js")
  assert.equal(sdk.SDK_VERSION, 3)
  assert.equal(sdk.SKILL_REF_VERSION, 2)
  assert.equal(sdk.CONSUMER_CONTRACT_VERSION, 1)
  assert.equal(sdk.RESOURCE_READ_CONTRACT_VERSION, 1)
  assert.equal(management.MANAGEMENT_VERSION, 1)
  assert.equal(management.PACKAGE_VERSION, packageVersion)
  assert.equal(Object.hasOwn(sdk, "checkSources"), false)
  assert.equal(Object.hasOwn(sdk, "syncSources"), false)
  assert.equal(typeof management.checkSources, "function")
  assert.equal(typeof management.syncSources, "function")
  await test("installed-pure-reference-module", "current", async () => {
    const purePath = require.resolve("ntn-skills/ref")
    assert.ok(purePath.startsWith(join(root, "node_modules", "ntn-skills")))
    assert.ok(purePath.endsWith("/dist/ref.cjs"))
    const commonjs = require("ntn-skills/ref")
    const esm = await import(
      pathToFileURL(join(root, "node_modules", "ntn-skills", "dist/ref.js")).href
    )
    for (const protocol of [commonjs, esm]) {
      assert.equal(protocol.SKILL_REF_VERSION, sdk.SKILL_REF_VERSION)
      const short = protocol.parseSkillRef("skill://architect/references/a%20b.md")
      assert.throws(() => protocol.bindSkillRef(short), { code: "LIBRARY_CONTEXT_REQUIRED" })
      assert.equal(
        protocol.formatSkillRef(protocol.bindSkillRef(short, "11111111-1111-4111-8111-111111111111")),
        "skill://architect/references/a%20b.md?library=11111111-1111-4111-8111-111111111111",
      )
      assert.notDeepEqual(
        protocol.bindSkillRef(short, "11111111-1111-4111-8111-111111111111").owner,
        protocol.bindSkillRef(short, "22222222-2222-4222-8222-222222222222").owner,
      )
      assert.throws(
        () => protocol.parseSkillRef("skill://shared_skill%3A11111111-1111-4111-8111-111111111111%3Aarchitect/SKILL.md"),
        { code: "INVALID_REF" },
      )
      assert.throws(
        () => protocol.parseSkillRef("skill://architect/SKILL.md?library=11111111-1111-4111-8111-111111111111&file_id=old"),
        { code: "INVALID_REF" },
      )
    }
    return { protocol: 2, esm: true, commonjs: true, context_required: true }
  })
  await test("installed-sdk-contract", "current", async () => {
    for (const name of [
      "selectLibrary",
      "resolveLibrary",
      "listCatalog",
      "listSkills",
      "listSkill",
      "readSkill",
      "consume",
      "readResources",
      "decodeConsumeResult",
      "decodeResourceReadResult",
      "compareNativeMarkdown",
    ])
      assert.equal(typeof sdk[name], "function")
    assert.equal(
      Object.keys(sdk).some((name) =>
        /Source(Storage|Onboarding|Recovery|Projection|File)|sourceManagement/u.test(name),
      ),
      false,
    )
    const expected = "# Invoice\n\nRead total_cents and `last_invoice_id`.\n"
    const observed = "# Invoice\n\nRead total\\_cents and `last_invoice_id`.\n"
    assert.equal(sdk.compareNativeMarkdown({ expected, observed }), "normalized")
    assert.equal(sdk.compareNativeMarkdown({ expected, observed: expected }), "exact")
    assert.equal(
      sdk.compareNativeMarkdown({
        expected,
        observed: observed.replace("total\\_cents", "total\\_dollars"),
      }),
      "different",
    )
    const wrapped = {
      expected: "1. Run `list --library\n   ROOT`.\n\n   Keep the paragraph.\n",
      observed:
        "1. Run <code>list --library ROOT</code>.\n   <p>\n   Keep the paragraph.\n   </p>\n",
    }
    assert.equal(sdk.compareNativeMarkdown(wrapped), "normalized")
    assert.equal(
      sdk.compareNativeMarkdown({
        ...wrapped,
        observed: wrapped.observed.replace("library ROOT", "library<br>ROOT"),
      }),
      "different",
    )
    await writeFile(
      join(root, "sdk-contract.ts"),
      `import { SDK_VERSION, selectLibrary, resolveLibrary, consume, readSkill, listSkill, readResources, type ConsumeOptions } from 'ntn-skills/sdk';\nimport { MANAGEMENT_VERSION, checkSources, syncSources, currentSourceSyncExitCode, type SourceSyncInput, type ManagementOptions } from 'ntn-skills/management';\nimport { SKILL_REF_VERSION, parseSkillRef, bindSkillRef, formatSkillRef, type SkillKey } from 'ntn-skills/ref';\nconst refVersion: 2 = SKILL_REF_VERSION;\nconst bound = bindSkillRef(parseSkillRef('skill://architect'), '11111111-1111-4111-8111-111111111111');\nconst owner: SkillKey = bound.owner;\nconst uri: string = formatSkillRef(bound);\nconst version: 3 = SDK_VERSION;\nconst managementVersion: 1 = MANAGEMENT_VERSION;\nconst options: ConsumeOptions = { env: {}, library: '${fixture.library_id}' };\nconst selected: Promise<string> = selectLibrary(options);\nvoid resolveLibrary(options).then(library => { const root: string = library.library_id; });\nconst managementOptions: ManagementOptions = { env: {} };\nconst synchronization: SourceSyncInput = { library: '${fixture.library_id}', source_ids: ['fixture'], manager_id: 'installed-fixture', execution_id: '${"a".repeat(64)}' };\nvoid checkSources({ library: synchronization.library, source_ids: synchronization.source_ids }, managementOptions);\nvoid syncSources(synchronization, managementOptions).then(currentSourceSyncExitCode);\nvoid consume({version:1,targets:['${fixture.root_page_id}'],purpose:'use'}, options);\nvoid readSkill('${fixture.root_page_id}', options);\nvoid listSkill('${fixture.root_page_id}', options);\nvoid readResources({version:1,refs:[]}, options);\n// @ts-expect-error removed SDK option\nconst removed: ConsumeOptions = { readOnly: true };\n// @ts-expect-error removed database selector\nconst removedDatabase: ConsumeOptions = { database: '${fixture.database}' };\n// @ts-expect-error management requires explicit owner and execution\nconst missingSyncIdentity: SourceSyncInput = { library: '${fixture.library_id}', source_ids: ['fixture'] };\n// @ts-expect-error management remains a separate capability\nimport { syncSources as consumerSync } from 'ntn-skills/sdk';\n// @ts-expect-error retired Source management API\nimport { planSourceRefresh } from 'ntn-skills/sdk';\n`,
    )
    await command([
      process.execPath,
      join(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--module",
      "NodeNext",
      "--target",
      "ES2023",
      "sdk-contract.ts",
    ])
    const rejected = await sdk.consume(input(fixture.root_page_id), { env: {}, readOnly: true })
    assert.equal(rejected.status, "failed")
    assert.equal(rejected.error.code, "INVALID_ARGUMENT")
    noWrites(rejected)
    const obsoleteSelector = await sdk.consume(input(fixture.root_page_id), {
      env: {},
      database: fixture.database,
    })
    assert.equal(obsoleteSelector.status, "failed")
    assert.equal(obsoleteSelector.error.code, "INVALID_ARGUMENT")
    noWrites(obsoleteSelector)
    return {
      sdk_version: sdk.SDK_VERSION,
      types: "installed declaration closure",
      obsolete_options: "rejected",
    }
  })
  source = await startSdkSourceFixture(fixture, join(root, "requests.jsonl"))
  const options = (name, extra = {}) => ({
    cwd: join(root, name),
    library: fixture.library_id,
    env: {
      ...env,
      NOTION_API_BASE_URL: source.origin,
      NTN_SKILLS_SCHEDULER_ROOT: join(root, "scheduler"),
    },
    metrics: true,
    ...extra,
  })
  const shared = options("current")
  await test("installed-library-selection-is-local-and-fresh", "current", async () => {
    const configRoot = join(root, "selection-config")
    await mkdir(configRoot)
    const configPath = join(configRoot, "config.json")
    const alternate = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    const selection = { cwd: root, env: { ...shared.env, NTN_SKILLS_CONFIG_HOME: configRoot } }
    const before = source.requests.length
    await writeFile(configPath, JSON.stringify({ default_library: fixture.library_id }))
    assert.equal(await sdk.selectLibrary(selection), fixture.library_id)
    await writeFile(configPath, JSON.stringify({ default_library: alternate }))
    assert.equal(await sdk.selectLibrary(selection), alternate)
    assert.equal(await sdk.selectLibrary({ ...selection, library: "https://www.notion.so/" + fixture.library_id.replaceAll("-", "") }), fixture.library_id)
    assert.equal(source.requests.length, before, "Local selection must not perform Notion I/O")
    return { ambient_changes_observed: true, explicit_root_canonicalized: true, notion_requests: 0 }
  })
  await test("installed-management-check-sync-and-cli-report", "current", async () => {
    const reports = []
    const selection = { library: fixture.library_id, source_ids: ["missing-installed-source"] }
    const start = source.requests.length
    const check = await management.checkSources(selection, {
      ...shared,
      onRequestMetrics: (value) => reports.push(value),
    })
    const sync = await management.syncSources(
      {
        ...selection,
        manager_id: "installed-fixture",
        execution_id: hash(await readFile(archive)),
      },
      {
        ...shared,
        onRequestMetrics: (value) => reports.push(value),
      },
    )
    for (const [action, result] of [
      ["check", check],
      ["sync", sync],
    ]) {
      assert.equal(result.version, 1)
      assert.equal(result.kind, "current_source_sync")
      assert.equal(result.action, action)
      assert.equal(result.status, "failed")
      assert.equal(result.results.length, 1)
      assert.equal(result.results[0].source_id, "missing-installed-source")
      assert.equal(result.results[0].error.code, "CURRENT_SOURCE_NOT_FOUND")
      assert.equal(management.currentSourceSyncExitCode(result), 1)
      assert.ok(result.budget.attempts > 0)
    }
    assert.equal(reports.length, 2)
    assert.ok(reports.every((value) => value !== null && value.in_flight === 0))
    const cliEnv = { ...process.env, ...shared.env }
    for (const action of ["check", "sync"]) {
      const output = JSON.parse(
        await command(
          [
            process.execPath,
            cli,
            "ctl",
            "library",
            "source",
            action,
            "--library",
            fixture.library_id,
            "--source",
            "missing-installed-source",
          ],
          { cwd: shared.cwd, env: cliEnv, expectedExit: 1 },
        ),
      )
      assert.equal(output.ok, false)
      assert.equal(output.kind, "current_source_sync")
      assert.equal(output.action, action)
      assert.equal(output.status, "failed")
      assert.equal(output.results[0].error.code, "CURRENT_SOURCE_NOT_FOUND")
    }
    const usage = JSON.parse(
      await command(
        [process.execPath, cli, "ctl", "library", "source", "check", "--library", fixture.library_id],
        { cwd: shared.cwd, env: cliEnv, expectedExit: 2 },
      ),
    )
    assert.equal(usage.error.code, "INVALID_ARGUMENT")
    const calls = source.requests.slice(start)
    assert.ok(
      calls.some(
        (row) =>
          row.path === `/v1/data_sources/${fixture.notion.library.sources.data_source_id}/query`,
      ),
    )
    assert.ok(
      calls.every(
        (row) => row.method === "GET" || (row.method === "POST" && row.path.endsWith("/query")),
      ),
    )
    return {
      management_version: management.MANAGEMENT_VERSION,
      source_selection: "explicit",
      missing_source: "reported",
      semantic_writes: 0,
      cli_result_exit: 1,
      cli_usage_exit: 2,
      installed_bundle_identity: "default accepted",
    }
  })
  let main, listing
  await test("current-catalog-complete-pagination", "current", async () => {
    const start = source.requests.length
    const catalog = await sdk.listCatalog(shared)
    assert.equal(catalog.records.length, fixture.expected.catalog_count)
    assert.equal(catalog.coverage.exhaustive, true)
    const calls = source.requests.slice(start)
    assert.equal(
      calls.filter(
        (row) =>
          row.path === `/v1/data_sources/${fixture.notion.library.skills.data_source_id}/query`,
      ).length,
      Math.ceil(fixture.expected.catalog_count / 100),
    )
    assert.equal(
      calls.some((row) => row.path.endsWith("/markdown") || row.path === recordsPath),
      false,
    )
    const first = await sdk.listSkills({ ...shared, limit: 100 })
    const pages = [first]
    if (first.has_more)
      pages.push(await sdk.listSkills({ ...shared, limit: 100, cursor: first.next_cursor }))
    assert.equal(pages.flatMap((page) => page.records).length, fixture.expected.catalog_count)
    assert.equal(pages.at(-1).has_more, false)
    return {
      records: catalog.records.length,
      notion_pages: Math.ceil(catalog.records.length / 100),
      sdk_pages: pages.length,
    }
  })
  await test("current-read-complete-files-and-warm-cache", "current", async () => {
    const start = source.requests.length
    main = await sdk.readSkill(fixture.root_page_id, shared)
    assert.equal(main.content, expected("SKILL.md").content)
    noWrites(main)
    listing = await sdk.listSkill(directoryRef(main.ref), shared)
    assert.equal(listing.files.length, fixture.expected.file_count)
    assert.deepEqual(
      listing.files.map((file) => file.path).sort(),
      fixture.expected.files.map((file) => file.path).sort(),
    )
    for (const file of listing.files) {
      assert.equal(file.sha256, expected(file.path).sha256)
      assert.equal(file.bytes, expected(file.path).bytes)
    }
    assert.equal(
      source.requests
        .slice(start)
        .filter(
          (row) =>
            row.path === `/v1/data_sources/${fixture.notion.library.files.data_source_id}/query`,
        ).length,
      4, // Initial enumeration and the final authority fence each traverse both pages.
    )
    assert.equal(recordsSince(start).length, 0)
    const beforeWarm = source.requests.length
    const warm = await sdk.readSkill(fixture.root_page_id, shared)
    assert.equal(warm.content, main.content)
    assert.equal(source.requests.length, beforeWarm)
    return { files: listing.files.length, remote_resource_reads: 0, warm_http: 0 }
  })
  await test("current-use-and-selected-resource-bytes", "current", async () => {
    const start = source.requests.length
    const consumed = await sdk.consume(input(fixture.root_page_id), shared)
    assert.equal(consumed.status, "ready", JSON.stringify(consumed))
    noWrites(consumed)
    assert.equal(consumed.entries[0].manifest.files.length, fixture.expected.file_count)
    assert.equal(consumed.preparation.nodes[0].content, expected("SKILL.md").content)
    assert.deepEqual(await sdk.decodeConsumeResult(consumed, input(fixture.root_page_id)), consumed)
    assert.equal(recordsSince(start).length, 0)
    const paths = [
      "references/guide.txt",
      "assets/raw.bin",
      "scripts/run.sh",
      "references/empty.txt",
    ]
    const selected = resourceInput(
      paths.map((path) => listing.files.find((file) => file.path === path).ref),
    )
    const result = await sdk.readResources(selected, shared)
    assert.equal(result.status, "ready", JSON.stringify(result))
    noWrites(result)
    result.files.forEach((file, n) => exact(expected(paths[n]), file))
    assert.deepEqual(await sdk.decodeResourceReadResult(result, selected), result)
    assert.equal(recordsSince(start).length, paths.length)
    const child = await sdk.readSkill(
      listing.files.find((file) => file.path === "references/0.md").ref,
      shared,
    )
    assert.equal(child.content, expected("references/0.md").content)
    return {
      selected_files: paths,
      resource_queries: recordsSince(start).length,
      native_child: "complete",
    }
  })
  await test("current-limits-and-attention-fail-closed", "current", async () => {
    const before = source.requests.length
    const target = listing.files.find((file) => file.path === "references/99.txt").ref
    const limited = await sdk.readResources(resourceInput([target], { maxBytes: 1 }), shared)
    assert.equal(limited.status, "failed")
    assert.equal(limited.error.code, "RESOURCE_BYTE_BUDGET")
    assert.equal(recordsSince(before).length, 0)
    const previous = structuredClone(source.notion.main.properties)
    source.notion.main.properties["Current State"].select.name = "attention"
    source.notion.main.properties.Operation.rich_text[0].plain_text = "current-smoke-operation"
    source.notion.main.properties.Operation.rich_text[0].text.content = "current-smoke-operation"
    try {
      await assert.rejects(sdk.readSkill(fixture.root_page_id, { ...shared, refresh: true }), {
        code: "CURRENT_OPERATION_PENDING",
      })
    } finally {
      source.notion.main.properties = previous
    }
    assert.equal(recordsSince(before).length, 0)
    return { byte_budget: "rejected before resource fetch", attention: "explicit refusal" }
  })
  await test("changed-current-file-requires-reselection", "current", async () => {
    const target = listing.files.find((file) => file.path === "references/99.txt").ref
    const row = source.notion.files.find(
      (file) => file.properties.Path.rich_text[0].plain_text === "references/99.txt",
    )
    const replacement = source.notion.files.find(
      (file) => file.properties.Path.rich_text[0].plain_text === "references/98.txt",
    )
    const previous = structuredClone(row.properties.Content)
    row.properties.Content = structuredClone(replacement.properties.Content)
    const before = source.requests.length
    try {
      const result = await sdk.readResources(resourceInput([target]), shared)
      assert.equal(result.status, "failed")
      assert.equal(result.error.code, "SHARED_ACQUISITION_CHANGED")
      noWrites(result)
      assert.equal(recordsSince(before).length, 0)
    } finally {
      row.properties.Content = previous
    }
    return { history_lookup: false, result: "SHARED_ACQUISITION_CHANGED" }
  })
  await test("installed-cli-files-read-and-complete-export", "current", async () => {
    const cliEnv = { ...process.env, ...shared.env }
    const cliRun = async (argv) =>
      JSON.parse(await command([process.execPath, cli, ...argv], { cwd: shared.cwd, env: cliEnv }))
    const files = await cliRun(["files", directoryRef(main.ref)])
    assert.equal(files.ok, true)
    assert.equal(files.files.length, fixture.expected.file_count)
    const read = await cliRun([
      "read",
      listing.files.find((file) => file.path === "references/guide.txt").ref,
    ])
    assert.equal(read.content, expected("references/guide.txt").content)
    const output = join(root, "export")
    const exported = await cliRun([
      "export",
      directoryRef(main.ref),
      "--output",
      output,
      "--format",
      "directory",
    ])
    assert.equal(exported.ok, true)
    for (const file of fixture.expected.files) {
      const bytes = await readFile(join(output, file.path))
      assert.equal(bytes.length, file.bytes, file.path)
      assert.equal(hash(bytes), file.sha256, file.path)
      if (file.mode === "100755")
        assert.notEqual((await stat(join(output, file.path))).mode & 0o111, 0)
    }
    return { files: fixture.expected.file_count, exact_bytes: true, executable_mode: true }
  })
  for (const operation of ["consume", "readResources"])
    for (const stage of ["headers", "body"])
      await test(`${operation}-cancellation-${stage}`, "cancellation", async () => {
        const reports = []
        const selectedOptions = options(`${operation}-${stage}`, {
          onRequestMetrics: (value) => reports.push(value),
        })
        let request = input(fixture.root_page_id)
        if (operation === "readResources") {
          const observed = await sdk.readSkill(fixture.root_page_id, selectedOptions)
          const files = await sdk.listSkill(directoryRef(observed.ref), selectedOptions)
          request = resourceInput([
            files.files.find((file) => file.path === "references/guide.txt").ref,
          ])
          reports.length = 0
          await idle()
        }
        const hold = source.holdNext({
          method: operation === "consume" ? "GET" : "POST",
          path: operation === "consume" ? "/v1/users/me" : recordsPath,
          afterHeaders: stage === "body",
        })
        const controller = new AbortController()
        const running = sdk[operation](request, { ...selectedOptions, signal: controller.signal })
        await bounded(
          Promise.race([
            hold.reached,
            running.then((result) => {
              throw new Error(
                `Operation ended before the controlled request: ${JSON.stringify(result)}`,
              )
            }),
          ]),
        )
        controller.abort()
        const result = await bounded(running)
        assert.equal(result.status, "cancelled")
        noWrites(result)
        const closed = await bounded(hold.closed)
        assert.equal(closed.terminal, "aborted")
        assert.equal(reports.length, 1)
        assert.equal(reports[0].in_flight, 0)
        const retry = await sdk[operation](request, selectedOptions)
        assert.equal(retry.status, "ready", JSON.stringify(retry))
        noWrites(retry)
        return { transport_closed: true, in_flight_after_cancel: 0, retry: "ready" }
      })
  await idle()
  assert.deepEqual(source.unexpected, [])
  assert.equal(
    source.requests.every(
      (row) => row.method === "GET" || (row.method === "POST" && row.path.endsWith("/query")),
    ),
    true,
  )
  assert.equal(process.cwd(), originalCwd)
  assert.equal(process.env.NOTION_API_TOKEN, originalToken)
} catch (error) {
  cases.push({
    name: "package-boundary",
    status: "failed",
    error: String(error),
    stack: error.stack,
  })
} finally {
  if (source) await source.close()
  const report = {
    version: 2,
    contract: "current-only",
    node: process.version,
    archive,
    archive_sha256: hash(await readFile(archive)),
    installed_package: packageVersion,
    sdk_path: sdkPath,
    management_path: managementPath,
    fixture: fixturePath,
    selection,
    passed: cases.filter((value) => value.status === "passed").length,
    failed: cases.filter((value) => value.status === "failed").length,
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
}
