import { createHash } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { expect, test, vi } from "vitest"
import { ConfigProvider, Effect } from "effect"
import {
  consume,
  decodeConsumeResult,
  decodeResourceReadResult,
  readSkill,
  listSkill,
  readResources,
  SkillsError,
} from "../../cli/src/sdk.ts"
import { nodeRuntime } from "../../cli/src/runtime.ts"
import { clearCache, locallySelectedScope } from "../src/cache.ts"
import { property } from "../src/model.ts"
import { LIBRARY_MARKER } from "../src/shared-library-model.ts"
import { currentSourceConsumerFixture } from "./shared-current-source-consumer-fixture.ts"
import {
  currentSnapshotFixture,
  currentId,
  currentRich,
  currentLibrary as library,
  currentSkillPage as skillPage,
} from "./shared-current-fixture.ts"

const { startSdkSourceFixture } = await import(
  new URL("../../../scripts/sdk-source-fixture.mjs", import.meta.url).href
)
type Source = Awaited<ReturnType<typeof startSdkSourceFixture>>
const raw = new TextEncoder().encode("#!/bin/sh\nprintf 'immutable bytes only\\n'\n")
const hash = createHash("sha256").update(raw).digest("hex")
const recordsPath = `/v1/data_sources/${library.records.data_source_id}/query`

test("public consume binds each complete SDK env to its actual Git executable", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "sdk-public-git-env-"))
  const sdk = join(root, "sdk.mjs")
  // Build only this test-owned SDK; shared dist and installed packages stay untouched.
  const build = spawnSync(
    "bun",
    [
      "build",
      new URL("../../cli/src/sdk.ts", import.meta.url).pathname,
      "--target=node",
      "--format=esm",
      "--outfile",
      sdk,
    ],
    { encoding: "utf8" },
  )
  expect(build.status, build.stderr).toBe(0)
  const f = await currentSourceConsumerFixture()
  await f.select(
    [
      {
        path: "SKILL.md",
        bytes: new TextEncoder().encode("# Controlled Source\n"),
        mode: "100644",
      },
    ],
    "git",
  )
  f.bind("SKILL.md")
  const main = {
    ...structuredClone(f.main),
    parent: { ...f.main.parent, database_id: library.skills.database_id },
  }
  const service = await startSdkSourceFixture(
    {
      notion: {
        library,
        main,
        skills: [main],
        files: structuredClone(f.files),
        records: [],
        sources: structuredClone([...f.sources.values()]),
        bodies: Object.fromEntries(f.bodies),
        database: {
          object: "database",
          id: library.skills.database_id,
          database_type: null,
          title: [{ plain_text: "SDK child environment fixture" }],
          description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(library) }],
          data_sources: [{ id: library.skills.data_source_id, name: "Skills" }],
        },
      },
    },
    join(root, "requests.jsonl"),
  )
  try {
    const ledger = join(root, "git-children.jsonl")
    for (const name of ["parent", "one", "two"]) {
      const bin = join(root, name, "bin")
      await mkdir(bin, { recursive: true })
      // Even a regression runs the parent's denying shim, never a real Git fetch.
      await writeFile(
        join(bin, "git"),
        `#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify({executable:${JSON.stringify(name)},value:process.env.NTN_SDK_TEST_VALUE??null,terminal:process.env.GIT_TERMINAL_PROMPT,trace:process.env.GIT_TRACE2_EVENT,gitDirCleared:process.env.GIT_DIR===undefined,operation:args.includes('fetch')?'fetch':args.includes('--version')?'version':'local'})+'\\n');
if(${JSON.stringify(name)}==='parent')process.exit(129);
if(args.includes('--version'))console.log('git version controlled-sdk-env');
process.exit(args.includes('fetch')?17:0);\n`,
        { mode: 0o700 },
      )
    }
    const cases = ["one", "two"].map((name) => ({
      name,
      options: {
        cwd: root,
        database: library.skills.database_id,
        env: {
          PATH: join(root, name, "bin"),
          HOME: root,
          NTN_SDK_TEST_VALUE: name,
          GIT_DIR: "/controlled/cleared",
          GIT_TRACE2_EVENT: "/controlled/not-opened",
          NOTION_API_TOKEN: "controlled-sdk-env-token",
          NOTION_API_BASE_URL: service.origin,
          NTN_SKILLS_HOME: join(root, name, "state"),
          NTN_SKILLS_CONFIG_HOME: join(root, name, "config"),
          NTN_SKILLS_CACHE_HOME: join(root, name, "cache"),
          NTN_SKILLS_SCHEDULER_ROOT: join(root, name, "scheduler"),
          NTN_SKILLS_FIXED_GIT_TRANSPORT: "git",
          NTN_SKILLS_NOTION_INTERVAL_MS: "100",
        },
      },
    }))
    await writeFile(
      join(root, "input.json"),
      JSON.stringify({ sdk, cases, ledger, target: skillPage }),
    )
    const runner = join(root, "run.mjs")
    await writeFile(
      runner,
      `import {readFile,writeFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';
const input=JSON.parse(await readFile(process.argv[2],'utf8'));const sdk=await import(pathToFileURL(input.sdk));
const rows=await Promise.all(input.cases.map(async c=>({name:c.name,result:await sdk.consume({version:1,purpose:'use',targets:[input.target]}, {...c.options,signal:AbortSignal.timeout(10000)})})));
const explicitCalls=(await readFile(input.ledger,'utf8')).trim().split('\\n').length;
const inherited=await sdk.consume({version:1,purpose:'use',targets:[input.target]}, {database:input.cases[0].options.database,cwd:input.cases[0].options.cwd,signal:AbortSignal.timeout(10000)});
await writeFile(process.argv[3],JSON.stringify({rows,explicitCalls,inherited}));\n`,
    )
    const child = spawn(
      process.execPath,
      [runner, join(root, "input.json"), join(root, "result.json")],
      {
        cwd: root,
        env: {
          ...cases[0]!.options.env,
          PATH: join(root, "parent", "bin"),
          TMPDIR: root,
          NTN_SDK_TEST_VALUE: "inherited",
          NTN_SKILLS_HOME: join(root, "parent", "state"),
          NTN_SKILLS_CONFIG_HOME: join(root, "parent", "config"),
          NTN_SKILLS_CACHE_HOME: join(root, "parent", "cache"),
          NTN_SKILLS_SCHEDULER_ROOT: join(root, "parent", "scheduler"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    const stdout: Buffer[] = [],
      stderr: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", resolve)
    })
    expect(code, Buffer.concat(stderr).toString()).toBe(0)
    const { rows, explicitCalls, inherited } = JSON.parse(
      await readFile(join(root, "result.json"), "utf8"),
    )
    for (const row of rows)
      expect(row.result).toMatchObject({
        status: "failed",
        error: {
          code: "UPSTREAM_GIT_FAILED",
          details: { operation: "fetch", exit_code: 17 },
        },
      })
    expect(inherited).toMatchObject({
      status: "failed",
      error: { code: "UPSTREAM_GIT_RUNTIME_UNSUPPORTED" },
    })
    const calls = (await readFile(ledger, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(calls.slice(0, explicitCalls).some((call) => call.executable === "parent")).toBe(false)
    expect(calls.slice(explicitCalls)).toHaveLength(2)
    expect(
      calls
        .slice(explicitCalls)
        .every((call) => call.executable === "parent" && call.value === "inherited"),
    ).toBe(true)
    for (const name of ["one", "two"]) {
      const own = calls.filter((call) => call.executable === name)
      expect(own.some((call) => call.operation === "fetch")).toBe(true)
      expect(
        own.every(
          (call) =>
            call.value === name &&
            call.terminal === "0" &&
            call.trace === "0" &&
            call.gitDirCleared,
        ),
      ).toBe(true)
    }
    expect(service.unexpected).toEqual([])
    expect(
      service.requests.every(
        (request: { method: string; path: string }) =>
          request.method === "GET" || request.path.endsWith("/query"),
      ),
    ).toBe(true)
  } finally {
    await service.close()
    console.info(JSON.stringify({ publicSdkGitEnvironmentEvidence: root }))
  }
})

async function sample(currentSource?: Record<string, unknown>) {
  const f = currentSnapshotFixture({ fileCount: 1 })
  await f.resource(0, "scripts/read-only.sh", raw, "100755")
  const main = {
    ...structuredClone(f.main),
    parent: { ...f.main.parent, database_id: library.skills.database_id },
  }
  return {
    notion: {
      library,
      database: {
        object: "database",
        id: library.skills.database_id,
        database_type: null,
        title: [{ plain_text: "Immutable read fixture" }],
        description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(library) }],
        data_sources: [{ id: library.skills.data_source_id, name: "Skills" }],
      },
      main,
      skills: [structuredClone(main)],
      files: structuredClone(f.files),
      records: structuredClone([...f.records.values()]),
      sources: currentSource === undefined ? [] : [currentSource],
      bodies: Object.fromEntries(f.bodies),
    },
  }
}

async function idle(source: Source) {
  await vi.waitFor(() => {
    for (const row of source.requests) expect(row.closed_monotonic_ns).not.toBeNull()
  })
}

async function setup(
  use: (input: {
    source: Source
    root: string
    options: Awaited<ReturnType<typeof bootstrap>>["options"]
    input: Awaited<ReturnType<typeof bootstrap>>["input"]
    snapshotId: string
    other: (name: string) => ReturnType<typeof bootstrap>
  }) => Promise<void>,
  fixtureOptions: {
    emptyFirstRecordsPage?: boolean
    currentSource?: Record<string, unknown>
  } = {},
) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "sdk-immutable-read-"))
  const source = await startSdkSourceFixture(
    await sample(fixtureOptions.currentSource),
    join(root, "requests.jsonl"),
    { emptyFirstRecordsPage: fixtureOptions.emptyFirstRecordsPage },
  )
  const other = (name: string) => bootstrap(source, root, name)
  try {
    const first = await other("first")
    await idle(source)
    source.setPhase("read")
    await use({ source, root, ...first, other })
    expect(source.unexpected).toEqual([])
  } finally {
    await source.close()
    console.info(JSON.stringify({ immutableSdkEvidence: root }))
  }
}

async function bootstrap(source: Source, root: string, name: string) {
  const directory = join(root, name)
  const env = {
    NOTION_API_TOKEN: "immutable-controlled-token",
    NOTION_WORKSPACE_ID: "",
    NOTION_API_BASE_URL: source.origin,
    NTN_SKILLS_HOME: join(directory, "state"),
    NTN_SKILLS_CONFIG_HOME: join(directory, "config"),
    NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
    NTN_SKILLS_SCHEDULER_ROOT: join(root, "scheduler"),
    NTN_SKILLS_NOTION_INTERVAL_MS: "100",
    NTN_SKILLS_REQUEST_TRACE_LIMIT: "10000",
  }
  const options = { env, database: library.skills.database_id, metrics: true }
  const main = await readSkill(skillPage, options)
  const directoryRef = new URL(main.ref)
  directoryRef.pathname = "/"
  directoryRef.searchParams.delete("file_id")
  const listing = await listSkill(directoryRef.toString(), options)
  const selected = listing.files.find((file) => file.path === "scripts/read-only.sh")
  expect(selected?.sha256).toBe(hash)
  if (selected === undefined) throw new Error("The public inventory lost its exact resource")
  await expect(readFile(join(env.NTN_SKILLS_HOME, "objects", hash))).rejects.toMatchObject({
    code: "ENOENT",
  })
  return {
    options,
    snapshotId: main.snapshot_id,
    input: {
      version: 1 as const,
      refs: [selected.ref],
      budget: { maxFiles: 1, maxBytes: 1024, timeBudgetMs: 30000 },
    },
  }
}

const bodyCalls = (source: Source) =>
  source.requests.filter(
    (row: { phase: string; path: string }) => row.phase === "read" && row.path === recordsPath,
  )
async function joinedEligibility(source: Source, timeBudgetMs: number, sourceQueries = 2) {
  await vi.waitFor(
    () =>
      expect(
        source.requests.filter(
          (row: { phase: string; path: string; terminal: string }) =>
            row.phase === "read" &&
            row.path === `/v1/data_sources/${library.sources.data_source_id}/query` &&
            row.terminal === "finished",
        ),
      ).toHaveLength(sourceQueries),
    // Current eligibility uses the public SDK's budget, not vi.waitFor's 1 s default.
    { timeout: timeBudgetMs },
  )
  // Contributions (then selected Sources, when present) complete HTTP eligibility.
  // Files alone leaves that check pending.
  // The server observes its completion, while joining is local work.
  await new Promise((resolve) => setTimeout(resolve, 50))
}
function ready(result: Awaited<ReturnType<typeof readResources>>) {
  expect(result.status, JSON.stringify(result)).toBe("ready")
  if (result.status !== "ready") throw new Error(JSON.stringify(result))
  expect(result.files).toHaveLength(1)
  expect(result.files[0]?.sha256).toBe(hash)
  expect(result.files[0]?.content).toBe(new TextDecoder().decode(raw))
  expect(result.effects?.remote_writes).toBe("none")
}

test("public SDK rebuilt selections give scalar and batch lazy resources new fixed refs while old refs retain their owner", async () => {
  await setup(async ({ source, input, options, other }) => {
    const batchStore = await other("rebuilt-batch")
    await idle(source)
    const rebuilt = currentId(900)
    source.notion.main = { ...structuredClone(source.notion.main), id: rebuilt }
    source.notion.skills = [structuredClone(source.notion.main)]
    source.notion.bodies[rebuilt] = source.notion.bodies[skillPage]
    for (const file of source.notion.files) file.properties.Skill.relation = [{ id: rebuilt }]
    source.notion.files[0].id = currentId(901)
    for (const record of source.notion.records) record.properties.Skill.relation = [{ id: rebuilt }]
    source.setPhase("rebuilt")
    for (const [mode, context] of [
      ["scalar", { input, options }],
      ["batch", batchStore],
    ] as const) {
      const previous = await listSkill(context.input.refs[0]!, context.options)
      const current = await readSkill(rebuilt, { ...context.options, refresh: true })
      expect(current.record.id).toBe(previous.record.id)
      expect(current.version_id).not.toBe(previous.version_id)
      expect(current.snapshot_id).not.toBe(previous.snapshot_id)
      const directory = new URL(current.ref)
      directory.pathname = "/"
      directory.searchParams.delete("file_id")
      const listing = await listSkill(directory.toString(), context.options)
      expect(listing.record.locator).toEqual(current.record.locator)
      const selected = listing.files.find((file) => file.path === "scripts/read-only.sh")!
      expect(selected.ref).not.toBe(context.input.refs[0])
      await expect(
        readFile(join(context.options.env.NTN_SKILLS_HOME, "objects", hash)),
      ).rejects.toMatchObject({ code: "ENOENT" })
      if (mode === "scalar") {
        const result = await readSkill(selected.ref, context.options)
        expect(result.record.locator).toEqual(current.record.locator)
        expect("content" in result && result.content).toBe(new TextDecoder().decode(raw))
      } else {
        const result = await readResources(
          { ...context.input, refs: [selected.ref] },
          context.options,
        )
        ready(result)
        if (result.status !== "ready") throw new Error(JSON.stringify(result))
        expect(result.manifest.record.locator).toEqual(current.record.locator)
      }
      await idle(source)
      const calls = source.requests.length
      const old = await readSkill(context.input.refs[0]!, { ...context.options, offline: true })
      expect(old.record.locator).toEqual(previous.record.locator)
      expect(old.record.locator).not.toEqual(current.record.locator)
      expect(source.requests).toHaveLength(calls)
    }
    expect(
      source.requests.filter(
        (request: { phase: string; path: string }) =>
          request.phase === "rebuilt" && request.path === `/v1/pages/${skillPage}`,
      ),
    ).toEqual([])
    expect(
      source.requests.filter(
        (request: { method: string; path: string }) =>
          request.method !== "GET" && !request.path.endsWith("/query"),
      ),
    ).toEqual([])
  })
})

test("public SDK preserves fixed-object failure details without replacing the pin or blocking independent resources", async () => {
  await setup(async ({ source, input, options }) => {
    const directory = new URL(input.refs[0]!)
    directory.pathname = "/"
    directory.searchParams.delete("file_id")
    const listing = await listSkill(directory.toString(), options)
    const main = listing.files.find((file) => file.path === listing.entrypoint)
    if (main === undefined) throw new Error("The public inventory lost its main")
    const selected = await readSkill(main.ref, options)
    const offline = await readResources(input, { ...options, offline: true })
    expect(offline).toMatchObject({
      status: "failed",
      error: {
        code: "SNAPSHOT_MISSING",
        details: {
          phase: "fixed_acquisition",
          reason: "offline",
          snapshot_id: selected.snapshot_id,
          target: selected.record.id,
          paths: ["scripts/read-only.sh"],
          next: "retry_online",
        },
      },
    })
    expect(await decodeResourceReadResult(offline, input)).toEqual(offline)
    const object = join(options.env.NTN_SKILLS_HOME, "objects", main.sha256)
    await rename(object, `${object}.retained-by-test`)
    source.notion.bodies[skillPage] =
      "The newer current body must not replace this fixed selection."
    const details = {
      phase: "fixed_object",
      reason: "objects_missing",
      snapshot_id: selected.snapshot_id,
      target: selected.record.id,
      paths: [listing.entrypoint],
      next: "reselect_current",
      effects: { version: 1, remote_writes: "none", author_content: "unchanged" },
    }
    await expect(readSkill(main.ref, options)).rejects.toBeInstanceOf(SkillsError)
    await expect(readSkill(main.ref, options)).rejects.toMatchObject({
      code: "SNAPSHOT_MISSING",
      details,
    })
    const prepared = await consume({ version: 1, targets: [main.ref], purpose: "inspect" }, options)
    expect(prepared).toMatchObject({
      status: "failed",
      error: { code: "SNAPSHOT_MISSING", details },
    })
    expect(await decodeConsumeResult(prepared)).toEqual(prepared)
    ready(await readResources(input, options))
    await idle(source)
    expect(
      source.requests.filter(
        (request: { phase: string; path: string }) =>
          request.phase === "read" && request.path.endsWith("/markdown"),
      ),
    ).toEqual([])
    expect(
      source.requests.filter(
        (request: { method: string; path: string }) =>
          request.method !== "GET" && !request.path.endsWith("/query"),
      ),
    ).toEqual([])
  })
})

test("public SDK binds complete pins to the selected credential across rejection, clear and restore", async () => {
  await setup(async ({ source, input, options }) => {
    ready(await readResources(input, options))
    const directory = new URL(input.refs[0]!)
    directory.pathname = "/"
    directory.searchParams.delete("file_id")
    const listing = await listSkill(directory.toString(), options)
    const main = listing.files.find((file) => file.path === listing.entrypoint)!
    const original = await readSkill(main.ref, { ...options, offline: true })
    if (!("content" in original)) throw new Error("Expected the native main body")
    const other = {
      ...options,
      env: { ...options.env, NOTION_API_TOKEN: "other-controlled-credential" },
    }
    const fixedRefused = async (selected: typeof options, code: string) => {
      const before = source.requests.length
      for (const offline of [false, true]) {
        const selectedOptions = { ...selected, offline }
        for (const ref of [main.ref, input.refs[0]!])
          await expect(readSkill(ref, selectedOptions)).rejects.toMatchObject({ code })
        await expect(listSkill(directory.toString(), selectedOptions)).rejects.toMatchObject({
          code,
        })
        const batch = await readResources(input, selectedOptions)
        expect(batch).toMatchObject({ status: "failed", error: { code } })
        expect("files" in batch).toBe(false)
        expect(await decodeResourceReadResult(batch, input)).toEqual(batch)
      }
      expect(source.requests).toHaveLength(before)
    }
    const prepare = (selected: typeof options, purpose: "inspect" | "use", offline = true) =>
      consume(
        {
          version: 1,
          targets: [main.ref],
          purpose,
          freshness: { policy: offline ? "offline" : "default" },
        },
        selected,
      )

    // The complete native body and resource already exist in this real Store.
    // Each SDK invocation opens its own scoped runtime for the selected env.
    await fixedRefused(other, "CACHE_SCOPE_UNAVAILABLE")
    await fixedRefused(
      { ...options, env: { ...options.env, NOTION_API_BASE_URL: "http://127.0.0.1:1" } },
      "CACHE_SCOPE_UNAVAILABLE",
    )
    source.setPhase("credential-b-denied", { denyAuthentication: true })
    await expect(readSkill(skillPage, { ...other, refresh: true })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    })
    expect(source.requests.some((row: { status: number }) => row.status === 401)).toBe(true)
    for (const retired of [false, true]) {
      if (retired) {
        const cleared = await Effect.runPromise(
          clearCache(undefined, { all: true }).pipe(
            Effect.provide(nodeRuntime(process.cwd()).live),
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(other.env))),
            Effect.scoped,
          ),
        )
        expect(cleared.entries.some((key) => key.startsWith("cache/identities/"))).toBe(false)
        expect(cleared.retired.some((entry) => entry.key.startsWith("cache/identities/"))).toBe(
          false,
        )
      }
      await fixedRefused(other, "CACHE_SCOPE_UNAVAILABLE")
      for (const purpose of ["inspect", "use"] as const) {
        const before = source.requests.length
        const offline = await prepare(other, purpose)
        expect(offline).toMatchObject({
          status: "failed",
          error: { code: "CACHE_SCOPE_UNAVAILABLE" },
        })
        expect("preparation" in offline).toBe(false)
        expect(source.requests).toHaveLength(before)
        expect(await prepare(other, purpose, false)).toMatchObject({
          status: "failed",
          error: { code: "AUTH_REQUIRED" },
        })
      }
      // B's actual rejection never becomes a denial of A. Clear preserves the
      // credential association, not disposable current/body freshness.
      const before = source.requests.length
      expect(await readSkill(main.ref, { ...options, offline: true })).toMatchObject({
        content: original.content,
        snapshot_id: original.snapshot_id,
        version_id: original.version_id,
        scope: original.scope,
      })
      ready(await readResources(input, { ...options, offline: true }))
      for (const purpose of ["inspect", "use"] as const)
        expect(await prepare(options, purpose)).toMatchObject({ status: "ready" })
      expect(source.requests).toHaveLength(before)
    }

    // A different successfully authenticated credential still cannot read A's
    // selection, even when this controlled service reports the same principal.
    source.setPhase("credential-b-granted", { denyAuthentication: false })
    const second = await readSkill(skillPage, { ...other, refresh: true })
    expect(second.scope).not.toBe(original.scope)
    await fixedRefused(other, "SNAPSHOT_SCOPE_MISMATCH")
    const beforeOtherPrepare = source.requests.length
    for (const purpose of ["inspect", "use"] as const) {
      const prepared = await prepare(other, purpose)
      expect(prepared).toMatchObject({
        status: "failed",
        error: { code: "SNAPSHOT_SCOPE_MISMATCH" },
      })
      expect("preparation" in prepared).toBe(false)
    }
    expect(source.requests).toHaveLength(beforeOtherPrepare)

    // A real rejection of A remains authoritative until fresh A validation.
    source.setPhase("credential-a-denied", { denyAuthentication: true })
    await expect(readSkill(skillPage, { ...options, refresh: true })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    })
    await fixedRefused(options, "AUTH_REQUIRED")
    source.setPhase("credential-a-restored", { denyAuthentication: false })
    await readSkill(skillPage, { ...options, refresh: true })
    const before = source.requests.length
    expect(await readSkill(main.ref, { ...options, offline: true })).toMatchObject({
      content: original.content,
      snapshot_id: original.snapshot_id,
      version_id: original.version_id,
      scope: original.scope,
    })
    ready(await readResources(input, { ...options, offline: true }))
    expect(source.requests).toHaveLength(before)
    expect(source.requests.some((row: { semantic_write: boolean }) => row.semantic_write)).toBe(
      false,
    )
  })
})

test("public SDK fixed scope checks preserve the actual SQLite identity-read failure", async () => {
  await setup(async ({ source, input, options }) => {
    ready(await readResources(input, options))
    const directory = new URL(input.refs[0]!)
    directory.pathname = "/"
    directory.searchParams.delete("file_id")
    const database = new DatabaseSync(join(options.env.NTN_SKILLS_HOME, "state.sqlite"))
    try {
      // Only this test Store is changed. Its fixed manifests and objects remain
      // readable; the real SQLite identity query must expose its original cause.
      database.exec("ALTER TABLE identities RENAME TO t05_unavailable_identities")
      const before = source.requests.length
      const original = await Effect.runPromise(
        locallySelectedScope().pipe(
          Effect.provide(nodeRuntime(process.cwd()).live),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(options.env))),
          Effect.scoped,
          Effect.result,
        ),
      )
      expect(original._tag).toBe("Failure")
      if (original._tag !== "Failure") throw new Error("Expected the actual SQLite query error")
      if (!(original.failure instanceof SkillsError)) throw original.failure
      expect(original.failure).toMatchObject({
        code: "STATE_CONFIG_ERROR",
        details: { phase: "sqlite_state" },
      })
      await expect(listSkill(directory.toString(), options)).rejects.toEqual(original.failure)
      await expect(readSkill(input.refs[0]!, options)).rejects.toMatchObject({
        code: original.failure.code,
        message: original.failure.message,
        details: original.failure.details,
      })
      expect(source.requests).toHaveLength(before)
    } finally {
      database.exec("ALTER TABLE t05_unavailable_identities RENAME TO identities")
      database.close()
    }
    const before = source.requests.length
    ready(await readResources(input, { ...options, offline: true }))
    expect(source.requests).toHaveLength(before)
  })
})

for (const code of ["ACCESS_DENIED", "AUTH_REQUIRED"] as const)
  test(`public SDK retains observed ${code} across offline reads and cache retirement`, async () => {
    await setup(async ({ source, input, options }) => {
      ready(await readResources(input, options))
      const directory = new URL(input.refs[0]!)
      directory.pathname = "/"
      directory.searchParams.delete("file_id")
      const listing = await listSkill(directory.toString(), options)
      const main = listing.files.find((file) => file.path === listing.entrypoint)
      if (main === undefined) throw new Error("Expected the actual fixed main reference")
      await idle(source)
      source.setPhase(
        "denied",
        code === "ACCESS_DENIED" ? { denyCurrent: true } : { denyAuthentication: true },
      )
      await expect(readSkill(skillPage, { ...options, refresh: true })).rejects.toMatchObject({
        code,
      })
      await idle(source)
      const observed = source.requests.length
      // Plain current and fixed refs share the same known-denial guard. An
      // offline read cannot downgrade that observation to a stale success.
      await expect(readSkill(skillPage, { ...options, offline: true })).rejects.toMatchObject({
        code,
      })
      expect(source.requests).toHaveLength(observed)
      for (const retired of [false, true]) {
        if (retired)
          await Effect.runPromise(
            clearCache(undefined, { all: true }).pipe(
              Effect.provide(nodeRuntime(process.cwd()).live),
              Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(options.env))),
              Effect.scoped,
            ),
          )
        for (const offline of [true, false]) {
          const before = source.requests.length
          const deniedOptions = { ...options, offline }
          for (const ref of [main.ref, input.refs[0]!])
            await expect(readSkill(ref, deniedOptions)).rejects.toMatchObject({ code })
          const batch = await readResources(input, deniedOptions)
          expect(batch).toMatchObject({ status: "failed", error: { code } })
          expect("files" in batch).toBe(false)
          expect(await decodeResourceReadResult(batch, input)).toEqual(batch)
          for (const purpose of ["inspect", "use"] as const) {
            const prepared = await consume(
              {
                version: 1,
                targets: [main.ref],
                purpose,
                freshness: { policy: offline ? "offline" : "default" },
              },
              options,
            )
            // All-clear retains the credential binding and the exact denial;
            // offline preparation cannot hide it behind a missing scope.
            expect(prepared).toMatchObject({ status: "failed", error: { code } })
            expect("preparation" in prepared).toBe(false)
            expect(await decodeConsumeResult(prepared)).toEqual(prepared)
          }
          if (offline) expect(source.requests).toHaveLength(before)
        }
      }
      expect(
        source.requests.filter(
          (request: { status: number }) =>
            request.status === (code === "ACCESS_DENIED" ? 403 : 401),
        ).length,
      ).toBeGreaterThan(0)
    })
  })

test("public SDK reports the retired cache generation when clear races a current body read", async () => {
  await setup(async ({ source, input, options }) => {
    const listing = await listSkill(input.refs[0]!, options)
    const hold = source.holdNext({ method: "GET", path: `/v1/pages/${skillPage}/markdown` })
    const pending = consume(
      {
        version: 1,
        targets: [skillPage],
        purpose: "inspect",
        freshness: { policy: "refresh" },
      },
      options,
    )
    await Promise.race([
      hold.reached,
      pending.then((result) => {
        throw new Error(
          `Current preparation ended before its body barrier: ${JSON.stringify(result)}`,
        )
      }),
    ])
    try {
      const retired = await Effect.runPromise(
        clearCache(undefined, { all: true }).pipe(
          Effect.provide(nodeRuntime(process.cwd()).live),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(options.env))),
          Effect.scoped,
        ),
      )
      expect(retired.entries.some((key) => key.endsWith(`/${listing.record.id}/.fence`))).toBe(true)
    } finally {
      hold.release()
    }
    const result = await pending
    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "CACHE_INVALIDATED",
        details: {
          phase: "cache_publication",
          record_identity: listing.record.id,
          scope: expect.stringMatching(/^[a-f0-9]{64}$/u),
          cache_key: expect.stringContaining("cache/current-native-bodies/"),
          effects: { version: 1, remote_writes: "none", author_content: "unchanged" },
        },
      },
    })
    if (result.status !== "failed") throw new Error("Retired work was returned as ready")
    expect(await decodeConsumeResult(result)).toEqual(result)
    const details = property(result.error.details)
    if (typeof details.generation !== "number" || typeof details.retired_through !== "number")
      throw new Error("The SDK lost the causal cache fence")
    expect(details.retired_through).toBeGreaterThanOrEqual(details.generation)
    const current = await readSkill(skillPage, { ...options, refresh: true })
    expect(current.source).toBe("notion")
    await idle(source)
    expect(
      source.requests.filter(
        (request: { method: string; path: string }) =>
          request.method !== "GET" && !request.path.endsWith("/query"),
      ),
    ).toEqual([])
  })
})

test("public SDK metadata selections survive independent processes and cache clear with exact original bindings", async () => {
  await setup(async ({ source, root, options }) => {
    let serial = 0
    const sdk = new URL("../../cli/src/sdk.ts", import.meta.url).pathname
    const workerSource = join(root, "selection-worker.ts"),
      worker = join(root, "selection-worker.mjs")
    await writeFile(
      workerSource,
      `import {readFile} from 'node:fs/promises';
import {consume} from ${JSON.stringify(sdk)};
import {Effect,ConfigProvider} from ${JSON.stringify(fileURLToPath(import.meta.resolve("effect")))};
import {clearCache} from ${JSON.stringify(new URL("../src/cache.ts", import.meta.url).pathname)};
import {nodeRuntime} from ${JSON.stringify(new URL("../../cli/src/runtime.ts", import.meta.url).pathname)};
const request=JSON.parse(await readFile(process.argv[2],'utf8'));
const result=request.clear
? await Effect.runPromise(clearCache(undefined,{all:true}).pipe(Effect.provide(nodeRuntime(process.cwd()).live),Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(request.options.env))),Effect.scoped))
: await consume(request.input,request.options);
console.log(JSON.stringify(result));`,
    )
    const build = spawnSync(
      "bun",
      ["build", workerSource, "--target=node", "--format=esm", "--outfile", worker],
      { encoding: "utf8" },
    )
    expect(build.status, build.stderr).toBe(0)
    const invoke = async (input: unknown, clear = false) => {
      const requestFile = join(root, `selection-${serial++}.json`)
      await writeFile(requestFile, JSON.stringify({ input, options, clear }))
      const child = spawn(process.execPath, [worker, requestFile], {
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stdout = "",
        stderr = ""
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk
      })
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk
      })
      const exit = await new Promise<number | null>((resolve) => child.once("close", resolve))
      await writeFile(requestFile + ".stdout", stdout)
      await writeFile(requestFile + ".stderr", stderr)
      expect(exit, stderr).toBe(0)
      return JSON.parse(stdout) as Awaited<ReturnType<typeof consume>>
    }
    const inspect = {
      version: 1,
      targets: [skillPage],
      purpose: "inspect",
      freshness: { policy: "refresh" },
    }
    const selections = []
    for (let stage = 0; stage < 4; stage++) {
      if (stage > 0) {
        if (stage === 1) source.notion.main.properties["Default Context"].checkbox = true
        if (stage === 2) source.notion.main.properties.Name.title[0].plain_text = "Second display"
        if (stage === 3)
          source.notion.main.properties.Description = currentRich(
            "description",
            "Third observed description.",
          )
        source.notion.main.last_edited_time = `2026-11-18T00:0${stage}:00.000Z`
        source.notion.skills = [structuredClone(source.notion.main)]
      }
      source.setPhase(`metadata-${stage}`)
      const selected = await invoke(inspect)
      expect(selected.status, JSON.stringify(selected)).toBe("ready")
      if (selected.status !== "ready") throw new Error("Expected complete metadata selection")
      selections.push(selected)
    }
    const bindings = selections.map((selection) => selection.preparation.session_bindings[0]!)
    expect(new Set(bindings.map((binding) => binding.snapshot_id)).size).toBe(4)
    expect(new Set(bindings.map((binding) => binding.version_id)).size).toBe(1)
    expect(new Set(bindings.map((binding) => binding.body_sha256)).size).toBe(1)
    const before = source.requests.length
    await invoke(undefined, true)
    for (const selected of selections) {
      const used = await invoke({
        version: 1,
        targets: [skillPage],
        purpose: "use",
        freshness: { policy: "offline" },
        sessionBindings: selected.preparation.session_bindings,
      })
      expect(used.status, JSON.stringify(used)).toBe("ready")
      if (used.status !== "ready") throw new Error("Expected the original exact selection")
      expect(used.preparation.session_bindings).toEqual(selected.preparation.session_bindings)
      expect(used.entries[0]?.manifest).toEqual(selected.entries[0]?.manifest)
      expect(
        used.preparation.nodes
          .filter((node) => node.state === "prepared")
          .map((node) => node.content),
      ).toEqual(
        selected.preparation.nodes
          .filter((node) => node.state === "prepared")
          .map((node) => node.content),
      )
    }
    expect(source.requests).toHaveLength(before)
    const binding = bindings[1]!
    const forged = await invoke({
      version: 1,
      targets: [skillPage],
      purpose: "use",
      freshness: { policy: "offline" },
      sessionBindings: [
        { ...binding, record: { ...binding.record, description: "Not the observed record" } },
      ],
    })
    expect(forged).toMatchObject({ status: "failed", error: { code: "PREPARE_BINDING_CONFLICT" } })
    source.notion.bodies[skillPage] += "\nAn actual author edit changes the content version.\n"
    source.notion.main.last_edited_time = "2026-11-18T00:05:00.000Z"
    source.notion.skills = [structuredClone(source.notion.main)]
    const changed = await invoke(inspect)
    expect(changed.status, JSON.stringify(changed)).toBe("ready")
    if (changed.status !== "ready") throw new Error("Expected changed content")
    expect(changed.preparation.session_bindings[0]?.version_id).not.toBe(binding.version_id)
    const retained = await invoke({
      version: 1,
      targets: [skillPage],
      purpose: "use",
      freshness: { policy: "offline" },
      sessionBindings: selections[1]!.preparation.session_bindings,
    })
    expect(retained.status, JSON.stringify(retained)).toBe("ready")
    if (retained.status !== "ready") throw new Error("Expected retained intermediate selection")
    expect(retained.preparation.session_bindings).toEqual(
      selections[1]!.preparation.session_bindings,
    )
    noConsumerWrites(source)
  })
})

test.each([0, 1200])(
  "two public SDK runtimes share only exact immutable bytes, and creator cancellation preserves the survivor (eligibility delay %i ms)",
  async (eligibilityDelayMs) => {
    await setup(
      async ({ source, input, options }) => {
        const hold = source.holdNext({ method: "POST", path: recordsPath })
        const creator = new AbortController()
        const first = readResources(input, { ...options, signal: creator.signal })
        await hold.reached
        const eligibility =
          eligibilityDelayMs === 0
            ? undefined
            : source.holdNext({
                method: "POST",
                path: `/v1/data_sources/${library.files.data_source_id}/query`,
              })
        const second = readResources(input, options)
        let release: ReturnType<typeof setTimeout> | undefined
        if (eligibility !== undefined) {
          await eligibility.reached
          release = setTimeout(() => eligibility.release(), eligibilityDelayMs)
        }
        try {
          await joinedEligibility(source, input.budget.timeBudgetMs)
        } finally {
          if (release !== undefined) clearTimeout(release)
          eligibility?.release()
        }
        if (eligibility !== undefined) {
          const completed = await eligibility.closed
          expect(
            Number(BigInt(completed.ended_monotonic_ns) - BigInt(completed.started_monotonic_ns)) /
              1e6,
          ).toBeGreaterThan(1000)
        }
        creator.abort()
        expect((await first).status).toBe("cancelled")
        const creatorClosed = process.hrtime.bigint()
        expect(bodyCalls(source)).toHaveLength(1)
        expect(bodyCalls(source)[0].closed_monotonic_ns).toBeNull()
        hold.release()
        ready(await second)
        await idle(source)
        expect(bodyCalls(source)).toHaveLength(2)
        expect(
          bodyCalls(source).map(
            (row: { body: { start_cursor?: string } }) => row.body.start_cursor ?? null,
          ),
        ).toEqual([null, "offset-0"])
        // The remaining page is acquired after the creator's public call has closed
        // its runtime. Merely finishing an already-started response misses this guard.
        expect(BigInt(bodyCalls(source)[1].started_monotonic_ns)).toBeGreaterThan(creatorClosed)
        expect(
          bodyCalls(source).every((row: { terminal: string }) => row.terminal === "finished"),
        ).toBe(true)
      },
      { emptyFirstRecordsPage: true },
    )
  },
)

test("last public waiter cancellation closes its transport and the same pin can retry", async () => {
  await setup(async ({ source, input, options }) => {
    const hold = source.holdNext({ method: "POST", path: recordsPath, afterHeaders: true })
    const controllers = [new AbortController(), new AbortController()]
    const first = readResources(input, { ...options, signal: controllers[0]!.signal })
    await hold.reached
    const second = readResources(input, { ...options, signal: controllers[1]!.signal })
    await joinedEligibility(source, input.budget.timeBudgetMs)
    controllers.forEach((controller) => controller.abort())
    expect((await Promise.all([first, second])).map((result) => result.status)).toEqual([
      "cancelled",
      "cancelled",
    ])
    const closed = await hold.closed
    expect(closed.terminal).toBe("aborted")
    ready(await readResources(input, options))
    await idle(source)
    expect(bodyCalls(source)).toHaveLength(2)
  })
})

test.each(["budget", "store"] as const)(
  "public consumers with another %s never join the pending producer",
  async (kind) => {
    await setup(async ({ source, input, options, other }) => {
      source.setPhase("setup-second")
      const separate =
        kind === "store"
          ? await other("second")
          : { input: { ...input, budget: { ...input.budget, maxBytes: 1025 } }, options }
      await idle(source)
      source.setPhase("read")
      const hold = source.holdNext({ method: "POST", path: recordsPath })
      const first = readResources(input, options)
      await hold.reached
      ready(await readResources(separate.input, separate.options))
      expect(bodyCalls(source)).toHaveLength(2)
      hold.release()
      ready(await first)
      await idle(source)
      expect(bodyCalls(source)).toHaveLength(2)
    })
  },
)

test("another credential cannot borrow the authorized pin's pending bytes", async () => {
  await setup(async ({ source, input, options }) => {
    const hold = source.holdNext({ method: "POST", path: recordsPath })
    const first = readResources(input, options)
    await hold.reached
    const denied = await readResources(input, {
      ...options,
      env: { ...options.env, NOTION_API_TOKEN: "other-controlled-credential" },
    })
    expect(denied.status).toBe("failed")
    expect(bodyCalls(source)).toHaveLength(1)
    hold.release()
    ready(await first)
    await idle(source)
    expect(bodyCalls(source)).toHaveLength(1)
  })
})

async function sourceRevisions() {
  const fixture = await currentSourceConsumerFixture()
  // This unrequested Source file changes the complete tree, without replacing
  // the independent Notion-owned resource whose pending bytes are shared.
  const files = [
    {
      path: "references/source.md",
      bytes: new TextEncoder().encode("# Source contribution\n"),
      mode: "100644" as const,
    },
  ]
  await fixture.select(files, "git", "a".repeat(40))
  const first = structuredClone(fixture.source)
  const applying = {
    ...structuredClone(first),
    properties: {
      ...property(first.properties),
      Status: {
        id: library.sources.property_ids.Status,
        type: "select",
        select: { name: "applying" },
      },
      Operation: currentRich(library.sources.property_ids.Operation!, "t14-controlled-operation"),
    },
  }
  await fixture.select(files, "git", "c".repeat(40))
  return { first, applying, second: structuredClone(fixture.source) }
}

async function sourceFact(
  source: Source,
  root: string,
  state: string,
  row: Record<string, unknown>,
) {
  const at = process.hrtime.bigint().toString()
  source.notion.sources = [structuredClone(row)]
  await writeFile(
    join(root, "source-timeline.jsonl"),
    JSON.stringify({
      boundary: "controlled service fact; no management command is claimed",
      state,
      at_monotonic_ns: at,
      row,
    }) + "\n",
    { flag: "a" },
  )
}

async function selectAfterSourceRevision(
  input: Awaited<ReturnType<typeof bootstrap>>["input"],
  options: Awaited<ReturnType<typeof bootstrap>>["options"],
  snapshotId: string,
) {
  const manifest = join(options.env.NTN_SKILLS_HOME, "snapshots", snapshotId + ".json")
  const retained = await readFile(manifest)
  const current = await readSkill(skillPage, { ...options, refresh: true })
  expect(current.snapshot_id).not.toBe(snapshotId)
  const directory = new URL(current.ref)
  directory.pathname = "/"
  directory.searchParams.delete("file_id")
  const listing = await listSkill(directory.toString(), options)
  expect(listing.files.map((file) => file.path).sort()).toEqual([
    "SKILL.md",
    "references/source.md",
    "scripts/read-only.sh",
  ])
  const resource = listing.files.find((file) => file.path === "scripts/read-only.sh")
  if (resource === undefined) throw new Error("New Source revision lost the independent resource")
  expect(await readFile(manifest)).toEqual(retained)
  return { ...input, refs: [resource.ref] }
}

function noConsumerWrites(source: Source) {
  expect(source.requests.filter((row: { semantic_write?: boolean }) => row.semantic_write)).toEqual(
    [],
  )
}

test("T14 shared admitted bytes survive creator cancellation and 429 while a new acquisition observes Source applying", async () => {
  const revisions = await sourceRevisions()
  await setup(
    async ({ source, root, input, options, snapshotId }) => {
      const hold = source.holdNext({ method: "POST", path: recordsPath })
      const creator = new AbortController()
      const first = readResources(input, { ...options, signal: creator.signal })
      await hold.reached
      const second = readResources(input, options)
      await joinedEligibility(source, input.budget.timeBudgetMs, 4)
      await sourceFact(source, root, "applying", revisions.applying)
      creator.abort()
      expect((await first).status).toBe("cancelled")
      expect(bodyCalls(source)).toHaveLength(1)
      expect(bodyCalls(source)[0].closed_monotonic_ns).toBeNull()
      const denied = await readResources(input, options)
      expect(denied).toMatchObject({
        status: "failed",
        error: { code: "CURRENT_SOURCE_NOT_READY" },
      })
      expect("files" in denied).toBe(false)
      expect(bodyCalls(source)).toHaveLength(1)
      source.rejectNext({ method: "POST", path: recordsPath, retryAfterSeconds: 0.1 })
      hold.release()
      const survived = await second
      ready(survived)
      if (survived.status !== "ready") throw new Error("The admitted survivor did not finish")
      expect(survived.selection.snapshot_id).toBe(snapshotId)
      await idle(source)
      expect(bodyCalls(source).map((row: { status: number }) => row.status)).toEqual([
        200, 429, 200,
      ])
      expect(
        bodyCalls(source).map(
          (row: { body: { start_cursor?: string } }) => row.body.start_cursor ?? null,
        ),
      ).toEqual([null, "offset-0", "offset-0"])
      // A later management fact does not revoke an acquisition already admitted
      // to exact A bytes. A fresh selection now observes the complete B tree.
      await sourceFact(source, root, "ready-B", revisions.second)
      const next = await selectAfterSourceRevision(input, options, snapshotId)
      const calls = source.requests.length
      ready(await readResources(next, options))
      ready(await readResources(input, options))
      expect(source.requests).toHaveLength(calls)
      noConsumerWrites(source)
    },
    { currentSource: revisions.first, emptyFirstRecordsPage: true },
  )
})

test("T14 cancelling every admitted reader closes a partial page without publishing before Source revision retry", async () => {
  const revisions = await sourceRevisions()
  await setup(
    async ({ source, root, input, options, snapshotId }) => {
      const hold = source.holdNext({ method: "POST", path: recordsPath, afterHeaders: true })
      const controllers = [new AbortController(), new AbortController()]
      const first = readResources(input, { ...options, signal: controllers[0]!.signal })
      await hold.reached
      const second = readResources(input, { ...options, signal: controllers[1]!.signal })
      await joinedEligibility(source, input.budget.timeBudgetMs, 4)
      await sourceFact(source, root, "applying", revisions.applying)
      controllers.forEach((controller) => controller.abort())
      const cancelled = await Promise.all([first, second])
      expect(cancelled.map((result) => result.status)).toEqual(["cancelled", "cancelled"])
      expect(cancelled.every((result) => !("files" in result))).toBe(true)
      const closed = await hold.closed
      expect(closed.terminal).toBe("aborted")
      expect(closed.observed_response_bytes).toBeGreaterThan(0)
      expect(closed.response_bytes_complete).toBe(false)
      expect(closed.decoded_response_bytes).toBeNull()
      await expect(
        readFile(join(options.env.NTN_SKILLS_HOME, "objects", hash)),
      ).rejects.toMatchObject({ code: "ENOENT" })
      const denied = await readResources(input, options)
      expect(denied).toMatchObject({
        status: "failed",
        error: { code: "CURRENT_SOURCE_NOT_READY" },
      })
      expect(bodyCalls(source)).toHaveLength(1)
      await sourceFact(source, root, "ready-B", revisions.second)
      const next = await selectAfterSourceRevision(input, options, snapshotId)
      ready(await readResources(next, options))
      await idle(source)
      expect(bodyCalls(source)).toHaveLength(2)
      expect(bodyCalls(source)[1].terminal).toBe("finished")
      const calls = source.requests.length
      ready(await readResources(next, options))
      expect(source.requests).toHaveLength(calls)
      noConsumerWrites(source)
    },
    { currentSource: revisions.first },
  )
})

test("T14 shared 429 retry spends each caller's original budget and publishes no partial ready tree", async () => {
  const revisions = await sourceRevisions()
  await setup(
    async ({ source, root, input, options, snapshotId }) => {
      const bounded = { ...input, budget: { ...input.budget, timeBudgetMs: 5000 } }
      const hold = source.holdNext({ method: "POST", path: recordsPath })
      const started = process.hrtime.bigint()
      const first = readResources(bounded, options)
      await hold.reached
      const second = readResources(bounded, options)
      await joinedEligibility(source, bounded.budget.timeBudgetMs, 4)
      await sourceFact(source, root, "applying", revisions.applying)
      source.rejectNext({ method: "POST", path: recordsPath, retryAfterSeconds: 10 })
      hold.release()
      const failed = await Promise.all([first, second])
      expect(failed).toEqual(
        failed.map(() =>
          expect.objectContaining({
            status: "failed",
            error: expect.objectContaining({ code: "RESOURCE_TIME_BUDGET" }),
          }),
        ),
      )
      expect(failed.every((result) => !("files" in result))).toBe(true)
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
      expect(elapsedMs).toBeGreaterThanOrEqual(bounded.budget.timeBudgetMs - 100)
      expect(elapsedMs).toBeLessThan(9000)
      await idle(source)
      expect(bodyCalls(source).map((row: { status: number }) => row.status)).toEqual([200, 429])
      await expect(
        readFile(join(options.env.NTN_SKILLS_HOME, "objects", hash)),
      ).rejects.toMatchObject({ code: "ENOENT" })
      const denied = await readResources(input, options)
      expect(denied).toMatchObject({
        status: "failed",
        error: { code: "CURRENT_SOURCE_NOT_READY" },
      })
      expect(bodyCalls(source)).toHaveLength(2)
      await sourceFact(source, root, "ready-B", revisions.second)
      const next = await selectAfterSourceRevision(input, options, snapshotId)
      ready(await readResources(next, options))
      await idle(source)
      expect(bodyCalls(source).map((row: { status: number }) => row.status)).toEqual([
        200, 429, 200, 200,
      ])
      noConsumerWrites(source)
    },
    { currentSource: revisions.first, emptyFirstRecordsPage: true },
  )
})
