import assert from "node:assert/strict"
import { spawn, execFile, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { Effect } from "effect"
import { runLocalRuntimeOperation } from "../../cli/src/operation-runtime.ts"
import { Store } from "../src/store.ts"
import { sourceMemberCacheKey } from "../src/shared-source-materialization-state.ts"
import type {
  SourceMemberCandidate,
  SourceMaterializationRequest,
  SourceMaterializationReceipt,
} from "../src/shared-source-materialization-model.ts"

const repo = fileURLToPath(new URL("../../../", import.meta.url))
const helper = await import(
  new URL("../../../scripts/sdk-source-fixture.mjs", import.meta.url).href
)
const execute = promisify(execFile)
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value))
  return value as Record<string, unknown>
}
const field = (row: unknown, id: string) => {
  const matches = Object.values(object(object(row).properties))
    .map(object)
    .filter((value) => value.id === id)
  assert.equal(matches.length, 1)
  return matches[0]!
}
const rich = (row: unknown, id: string) => {
  const values = field(row, id).rich_text
  assert.ok(Array.isArray(values))
  return values
    .map((value) => {
      const part = object(value)
      return part.plain_text ?? object(part.text).content
    })
    .join("")
}
const save = async (path: string, value: unknown) => writeFile(path, json(value), { mode: 0o600 })
async function bounded<A>(promise: Promise<A>, label: string, milliseconds = 60_000): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out: " + label)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

let evidence: string, generation: string, cli: string, runtime: string, gitExecutable: string
let inventorySha: string,
  sample: unknown,
  git: Awaited<ReturnType<typeof helper.startSdkGitFixture>>
let sdk: typeof import("../../cli/src/sdk.ts")
const results: unknown[] = []

/** Exactly the fixed entry's complete installation inventory, including dependencies. */
async function inventory(root: string) {
  const files: unknown[] = []
  const walk = async (name: string): Promise<void> => {
    const path = join(root, name),
      info = await lstat(path)
    if (info.isSymbolicLink()) {
      const target = relative(root, await realpath(path))
      assert.ok(target && target !== ".." && !target.startsWith("../") && !isAbsolute(target))
      files.push({ path: name, link: await readlink(path) })
    } else if (info.isDirectory()) {
      for (const child of (await readdir(path)).sort())
        await walk(name ? name + "/" + child : child)
    } else {
      assert.ok(info.isFile())
      files.push({
        path: name,
        sha256: hash(await readFile(path)),
        executable: Boolean(info.mode & 0o111),
      })
    }
  }
  await walk("")
  return { sha256: hash(JSON.stringify(files)), files }
}

beforeAll(async () => {
  const supplied = process.env.NTN_SKILLS_MANAGER_TEST_OUT
  if (supplied) {
    assert.ok(isAbsolute(supplied))
    await mkdir(supplied, { mode: 0o700 })
    evidence = await realpath(supplied)
  } else evidence = await realpath(await mkdtemp(join(tmpdir(), "ntn-manager-dispatch-")))
  const gitProbe = await execute("/bin/sh", ["-c", "command -v git"], {
    env: { PATH: process.env.PATH },
  })
  const tools = await helper.stageSdkManagerTools(join(evidence, "tools"), {
    node: process.execPath,
    git: gitProbe.stdout.trim(),
  })
  runtime = tools.node.path
  gitExecutable = tools.git.path
  // The normal Node lane follows test:unit's current build. A private paired run
  // supplies its already installed frozen prefix instead of repacking the source.
  if (process.env.NTN_SKILLS_MANAGER_TEST_GENERATION) {
    generation = await realpath(process.env.NTN_SKILLS_MANAGER_TEST_GENERATION)
  } else {
    const archives = join(evidence, "archives")
    await mkdir(archives)
    const packed = await execute("npm", ["pack", "--json", "--pack-destination", archives], {
      cwd: join(repo, "packages/cli"),
      maxBuffer: 4_194_304,
    })
    const archive = join(archives, JSON.parse(packed.stdout)[0].filename)
    generation = join(evidence, "installed")
    await mkdir(generation)
    await save(join(generation, "package.json"), {
      private: true,
      dependencies: { "ntn-skills": "file:" + archive },
    })
    // Same consumer installation contract as scripts/package-smoke.ts: no source
    // link, copied author Store, dependency rewriting or hand-written lockfile.
    const installed = await execute(
      "npm",
      ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      {
        cwd: generation,
        env: { ...process.env, npm_config_cache: join(evidence, "npm-cache") },
        maxBuffer: 4_194_304,
      },
    )
    await save(join(evidence, "installation.json"), {
      archive,
      archive_sha256: hash(await readFile(archive)),
      packed: packed.stdout,
      ...installed,
    })
  }
  cli = join(generation, "node_modules/ntn-skills/dist/ntn-skills.js")
  sdk = await import(pathToFileURL(join(generation, "node_modules/ntn-skills/dist/sdk.js")).href)
  const selected = await inventory(generation)
  inventorySha = selected.sha256
  await save(join(evidence, "generation.json"), {
    root: generation,
    cli,
    cli_sha256: hash(await readFile(cli)),
    runtime,
    runtime_sha256: hash(await readFile(runtime)),
    git: gitExecutable,
    git_sha256: hash(await readFile(gitExecutable)),
    tool_selection: tools,
    inventory: selected,
  })
  const generated = join(evidence, "fixture")
  const fixtureRun = await execute(
    runtime,
    [join(repo, "scripts/sdk-fixture.ts"), "--outdir", generated, "--materialization"],
    { cwd: repo, maxBuffer: 4_194_304 },
  )
  await save(join(evidence, "fixture-generation.json"), fixtureRun)
  sample = JSON.parse(await readFile(join(generated, "fixture.json"), "utf8"))
  git = await helper.startSdkGitFixture(
    object(object(sample).source_materialization).repository,
    join(evidence, "git-http.jsonl"),
  )
}, 300_000)

afterAll(async () => {
  if (git) await git.close()
  if (evidence) {
    const unchanged = generation ? (await inventory(generation)).sha256 === inventorySha : null
    await save(join(evidence, "results.json"), {
      cases: results,
      actual_pi_cancellation: "not_run",
      generation_unchanged: unchanged,
    })
    console.info(JSON.stringify({ sourceManagerDispatchEvidence: evidence }))
    if (inventorySha) expect(unchanged).toBe(true)
  }
})

type ProcessResult = {
  pid: number
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  input: SourceMaterializationRequest
  started_monotonic_ns: string
  closed_monotonic_ns: string
}
type PendingRow = {
  key: string
  category: string
  retired: number
  payload: Record<string, unknown>
}
function databaseSnapshot(path: string) {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    expect(database.prepare("PRAGMA application_id").get()?.application_id).toBe(0x4e544e43)
    const rows = database
      .prepare(
        "SELECT key, category, payload, retired FROM shared_local_records WHERE key LIKE 'operations/%' ORDER BY key",
      )
      .all()
    return {
      identities: database.prepare("SELECT id,scope FROM identities ORDER BY id").all(),
      rows: rows.map((row) => ({
        key: String(row.key),
        category: String(row.category),
        retired: Number(row.retired),
        payload: object(JSON.parse(String(row.payload))),
      })),
    }
  } finally {
    database.close()
  }
}
const operations = (snapshot: ReturnType<typeof databaseSnapshot>) =>
  snapshot.rows.filter((row) => row.key.startsWith("operations/current-write-pending/"))
const intent = (row: PendingRow) => object(row.payload.intent)
const operationOwner = (row: PendingRow) => object(intent(row).owner)

async function fixture(name: string, memberPatch = false) {
  const out = join(evidence, name)
  await mkdir(out, { mode: 0o700 })
  const facts = helper.materializationServiceFacts(sample, git.url, "source-only")
  if (memberPatch) {
    const source = facts.sample.notion.sources.find(
      (row: { id: string }) => row.id === facts.source_page_id,
    )
    assert.ok(source)
    const root = facts.members[0]
    field(source, facts.sample.notion.library.sources.property_ids.Options).rich_text = [
      {
        type: "text",
        text: {
          content: JSON.stringify({
            version: 1,
            adapter: {},
            settings: {
              member_patches: {
                [root.member_key]: {
                  version: 1,
                  files: [
                    {
                      path: "SKILL.md",
                      replacements: [
                        {
                          from: "description: " + root.description,
                          to: "description: " + JSON.stringify(root.description),
                        },
                      ],
                    },
                  ],
                },
              },
            },
          }),
        },
      },
    ]
    const unrelated = structuredClone(source)
    unrelated.id = "00000000-0000-4000-8000-0000000fff70"
    const text = (id: string, content: string) => {
      field(unrelated, id).rich_text = [{ type: "text", text: { content } }]
    }
    text(facts.sample.notion.library.sources.property_ids["Source ID"], "unrelated-unsupported")
    text(
      facts.sample.notion.library.sources.property_ids.Options,
      JSON.stringify({
        version: 1,
        adapter: {},
        settings: { storage: "retained" },
      }),
    )
    facts.sample.notion.sources.push(unrelated)
  }
  const service = await helper.startSdkSourceFixture(facts.sample, join(out, "source-http.jsonl"), {
    allowCurrentWrites: true,
    forbidProjectionWrites: true,
  })
  const roots = {
    home: join(out, "state"),
    config_home: join(out, "config"),
    cache_home: join(out, "cache"),
  }
  const scheduler = join(out, "scheduler")
  for (const path of [...Object.values(roots), scheduler]) await mkdir(path, { mode: 0o700 })
  const env = {
    PATH: process.env.PATH,
    NOTION_API_TOKEN: "dispatch-fixture-manager",
    NOTION_API_BASE_URL: service.origin,
    NTN_SKILLS_HOME: roots.home,
    NTN_SKILLS_CONFIG_HOME: roots.config_home,
    NTN_SKILLS_CACHE_HOME: roots.cache_home,
    NTN_SKILLS_SCHEDULER_ROOT: scheduler,
    NTN_SKILLS_NOTION_INTERVAL_MS: "100",
  }
  const library = facts.sample.notion.library
  await sdk.selectLibrary({ library: library.library_id, cwd: out, env })
  const lookup = (query: string) =>
    sdk.discoverSourceMembers(
      { library: library.library_id, source_id: facts.source_id, query },
      { cwd: out, env },
    )
  const found = await lookup(facts.members[0].name)
  expect(found.coverage).toBe("complete")
  expect(found.candidates).toHaveLength(1)
  const candidate = found.candidates[0]!
  const requestFor = (
    candidate: SourceMemberCandidate,
    label: string,
  ): SourceMaterializationRequest => ({
    version: 1,
    library: library.library_id,
    request_id: "dispatch-" + name + label,
    purpose: "use",
    target: {
      source_id: candidate.source_id,
      member_key: candidate.member_key,
      expected_skill_id: candidate.expected_skill_id,
      registration_digest: candidate.registration_digest,
      ...(candidate.expected_source_commit
        ? { expected_source_commit: candidate.expected_source_commit }
        : {}),
      ...(candidate.expected_source_revision
        ? { expected_source_revision: candidate.expected_source_revision }
        : {}),
    },
  })
  const request = requestFor(candidate, "")
  const credentials = join(out, "credentials.json"),
    config = join(out, "manager.json")
  await save(credentials, { NOTION_API_TOKEN: env.NOTION_API_TOKEN })
  await save(config, {
    version: 2,
    host: { name: "mini", hostname: hostname() },
    library: library.library_id,
    sources: [facts.source_id],
    projection: "none",
    store: roots,
    request_scheduler_root: scheduler,
    notion_api_origin: service.origin,
    generation: {
      root: generation,
      inventory_sha256: inventorySha,
      cli_entry: "node_modules/ntn-skills/dist/ntn-skills.js",
      runtime,
      runtime_sha256: hash(await readFile(runtime)),
    },
    git: { executable: gitExecutable, sha256: hash(await readFile(gitExecutable)), http_proxy: "" },
    credentials: { path: credentials, notion_token_sha256: hash(env.NOTION_API_TOKEN) },
    artifacts: {},
    budgets: {
      changed: { max_requests: 2000, max_bytes: 67_108_864, timeout_ms: 180_000 },
      full: { max_requests: 2000, max_bytes: 67_108_864, timeout_ms: 180_000 },
    },
  })
  await save(join(out, "initial-notion.json"), service.notion)
  const owned = new Set<ChildProcess>(),
    processes: ProcessResult[] = []
  let originalMutation: Record<string, unknown> | undefined
  const launch = (label: string, input = request) => {
    const started = process.hrtime.bigint().toString()
    const child = spawn(runtime, [cli, "ctl", "library", "source", "manager", "--config", config], {
      cwd: out,
      env: {
        PATH: `${dirname(runtime)}:${dirname(gitExecutable)}:/usr/bin:/bin`,
        LANG: "en_US.UTF-8",
        NTN_SKILLS_HOME: roots.home,
        NTN_SKILLS_CONFIG_HOME: roots.config_home,
        NTN_SKILLS_CACHE_HOME: roots.cache_home,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    assert.ok(child.pid)
    const pid = child.pid
    owned.add(child)
    let stdout = "",
      stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
    })
    const done = once(child, "close").then(async ([code, signal]) => {
      owned.delete(child)
      const result: ProcessResult = {
        pid,
        code,
        signal,
        stdout,
        stderr,
        input,
        started_monotonic_ns: started,
        closed_monotonic_ns: process.hrtime.bigint().toString(),
      }
      processes.push(result)
      await save(join(out, "process-" + label + ".json"), result)
      return result
    })
    child.stdin.end(
      JSON.stringify({
        version: 1,
        request_id: input.request_id,
        execution_id: inventorySha,
        library: library.library_id,
        command: { version: 1, action: "materialize", input },
      }),
    )
    return { child, pid, done }
  }
  const run = async (label: string, input = request): Promise<SourceMaterializationReceipt> => {
    const result = await bounded(launch(label, input).done, "manager " + label, 120_000)
    expect(result.code, result.stderr || result.stdout).toBe(0)
    const envelope = JSON.parse(result.stdout.trim())
    expect(envelope).toMatchObject({
      ok: true,
      request_id: input.request_id,
      execution_id: inventorySha,
      library: library.library_id,
    })
    return envelope.result
  }
  const canonicalDatabase = await realpath(join(roots.home, "state.sqlite"))
  const originalDatabase = await stat(canonicalDatabase)
  const snapshot = async (label: string) => {
    const database = join(roots.home, "state.sqlite"),
      info = await stat(database),
      value = databaseSnapshot(database)
    expect(await realpath(database)).toBe(canonicalDatabase)
    expect([info.dev, info.ino]).toEqual([originalDatabase.dev, originalDatabase.ino])
    const directory = join(out, label)
    await mkdir(directory)
    for (const suffix of ["", "-wal", "-shm"])
      await copyFile(database + suffix, join(directory, "state.sqlite") + suffix).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        },
      )
    expect(databaseSnapshot(join(directory, "state.sqlite"))).toEqual(value)
    await save(join(directory, "snapshot.json"), {
      database,
      dev: info.dev,
      ino: info.ino,
      ...value,
    })
    return value
  }
  const cut = async (running: ReturnType<typeof launch>, held: { reached: Promise<unknown> }) => {
    const arrived = await bounded(
      Promise.race([
        held.reached,
        running.done.then((result) => {
          throw new Error("Manager exited before original mutation: " + JSON.stringify(result))
        }),
      ]),
      "held original mutation",
    )
    expect(arrived).toMatchObject({ request_bytes_complete: true, response_bytes_complete: false })
    expect(running.child.kill("SIGKILL")).toBe(true)
    expect(await bounded(running.done, "original manager exit")).toMatchObject({
      pid: running.pid,
      code: null,
      signal: "SIGKILL",
    })
    await vi.waitFor(() =>
      expect(
        service.requests.find(
          (row: { sequence: number }) => row.sequence === object(arrived).sequence,
        ).closed_monotonic_ns,
      ).not.toBeNull(),
    )
    originalMutation = object(arrived)
    expect(originalMutation.request_sha256).toMatch(/^[0-9a-f]{64}$/)
    await save(join(out, "held-request.json"), arrived)
    return originalMutation
  }
  const noWrites = async (label: string, input = request) => {
    const offset = service.requests.length
    const receipt = await run(label, input)
    const observed = service.requests.slice(offset)
    expect(observed.filter((row: { semantic_write?: boolean }) => row.semantic_write)).toEqual([])
    await save(join(out, label + "-requests.json"), observed)
    return receipt
  }
  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= (async () => {
      for (const child of owned) child.kill("SIGKILL")
      await Promise.all([...owned].map((child) => once(child, "close")))
      await service.close()
      await save(join(out, "final-notion.json"), service.notion)
      await save(join(out, "processes.json"), processes)
      const ledger = (await readFile(service.ledgerPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      const bySequence = (a: { sequence: number }, b: { sequence: number }) =>
        a.sequence - b.sequence
      expect(ledger.sort(bySequence)).toEqual(
        service.requests.map((row: unknown) => structuredClone(row)).sort(bySequence),
      )
      if (originalMutation) {
        const original = originalMutation
        expect(
          service.requests.filter(
            (row: Record<string, unknown>) =>
              row.method === original.method &&
              row.path === original.path &&
              row.request_sha256 === original.request_sha256,
          ),
          "The original mutation's method, physical locator and exact request bytes occur once",
        ).toHaveLength(1)
      }
      expect(new Set(processes.map((entry) => entry.pid)).size).toBe(processes.length)
      expect(service.unexpected).toEqual([])
      expect(
        service.requests.filter((row: { projection_write?: boolean }) => row.projection_write),
      ).toEqual([])
    })())
  return {
    out,
    facts,
    service,
    library,
    roots,
    env,
    candidate,
    lookup,
    requestFor,
    request,
    launch,
    run,
    snapshot,
    cut,
    noWrites,
    close,
  }
}

test("fixed manager separates patched members, old candidate caches and unrelated Source write policies", async () => {
  const f = await fixture("member-write-capability", true)
  const controls = { cwd: f.out, env: f.env }
  try {
    expect.soft(f.candidate).toMatchObject({
      readiness: "blocked",
      reason: "CURRENT_SOURCE_WRITE_UNSUPPORTED",
    })
    const catalog = await sdk.listCatalog({
      library: f.library.library_id,
      ...controls,
      refresh: true,
    })
    const legacy = { ...f.candidate, readiness: "materializable" as const }
    delete legacy.reason
    const stale = {
      ...legacy,
      member_key: "skills/old-unobserved",
      expected_skill_id: "old-unobserved",
      alias: "old-unobserved",
      name: "old-unobserved",
    }
    const key = sourceMemberCacheKey(catalog.scope, f.library.library_id)
    const legacyKey = `cache/source-members/${catalog.scope}/${f.library.library_id}.json`
    const legacyPayload = {
      version: 1,
      library_id: f.library.library_id,
      scope: catalog.scope,
      candidates: [legacy, stale],
    }
    await runLocalRuntimeOperation(
      () =>
        Effect.gen(function* () {
          const store = yield* Store
          // The initial SDK lookup established the exact candidate identity.
          // Construct the controlled upgrade starting state: only its v1 slot.
          yield* store.retireKeys([key])
          yield* store.writeJson(legacyKey, legacyPayload)
        }),
      controls,
    )
    const beforeLocal = f.service.requests.length
    const old = await sdk.readCandidateSnapshot({ library: f.library.library_id, ...controls })
    expect.soft(old).toMatchObject({ kind: "snapshot", source_members: [] })
    expect(f.service.requests).toHaveLength(beforeLocal)
    const fresh = await f.lookup(f.facts.members[0].name)
    expect
      .soft(fresh.candidates)
      .toMatchObject([{ readiness: "blocked", reason: "CURRENT_SOURCE_WRITE_UNSUPPORTED" }])
    const beforeSnapshot = f.service.requests.length
    const local = await sdk.readCandidateSnapshot({ library: f.library.library_id, ...controls })
    expect.soft(local).toMatchObject({
      kind: "snapshot",
      records: catalog.records,
      source_members: fresh.candidates,
    })
    expect.soft(local.kind === "snapshot" ? local.source_members : []).toHaveLength(1)
    expect(
      await sdk.readCandidateSnapshot({
        library: f.library.library_id,
        ...controls,
        env: {
          ...f.env,
          NOTION_API_TOKEN: "foreign-member-policy-scope",
        },
      }),
    ).toMatchObject({ kind: "miss", reason: "scope_unavailable" })
    expect(f.service.requests).toHaveLength(beforeSnapshot)
    const database = new DatabaseSync(join(f.roots.home, "state.sqlite"), { readOnly: true })
    let cached: unknown
    try {
      const row = database
        .prepare("SELECT payload FROM shared_local_records WHERE key = ?")
        .get(key)
      assert.ok(row)
      cached = JSON.parse(String(row.payload))
      expect.soft(cached).toMatchObject({ version: 2, candidates: fresh.candidates })
      const retained = database
        .prepare("SELECT payload FROM shared_local_records WHERE key = ?")
        .get(legacyKey)
      expect(JSON.parse(String(retained?.payload))).toEqual(legacyPayload)
    } finally {
      database.close()
    }
    await save(join(f.out, "cache-transition.json"), { old, fresh, local, cached })
    const original = structuredClone(f.service.notion)
    expect(await f.noWrites("patched-forged-request")).toMatchObject({
      status: "blocked",
      reason: "CURRENT_SOURCE_WRITE_UNSUPPORTED",
      records: [],
      effects: { remote_writes: "none", projection: "none" },
    })
    expect(f.service.notion).toEqual(original)
    for (const [index, label] of [
      [1, "old-member"],
      [2, "new-sibling"],
    ] as const) {
      const selected = await f.lookup(f.facts.members[index].name)
      expect(selected).toMatchObject({ coverage: "complete", failures: [] })
      expect(selected.candidates).toHaveLength(1)
      expect(selected.candidates[0]).toMatchObject({ readiness: "materializable" })
      const start = f.service.requests.length
      const receipt = await f.run(label, f.requestFor(selected.candidates[0]!, "-" + label))
      expect(receipt).toMatchObject({
        status: "ready",
        effects: { remote_writes: "management", projection: "none" },
      })
      expect(receipt.records.map((record) => record.name)).toEqual([f.facts.members[index].name])
      const rows = f.service.requests.slice(start)
      expect(rows.some((row: { semantic_write?: boolean }) => row.semantic_write)).toBe(true)
      expect(rows.filter((row: { projection_write?: boolean }) => row.projection_write)).toEqual([])
      const source = f.service.notion.sources.find(
        (row: { id: string }) => row.id === f.facts.source_page_id,
      )
      const contributions = JSON.parse(rich(source, f.library.sources.property_ids.Contributions))
      expect(contributions.map((row: { member_key: string }) => row.member_key).sort()).toEqual(
        f.facts.members
          .slice(1, index + 1)
          .map((row: { member_key: string }) => row.member_key)
          .sort(),
      )
      const read = await sdk.consume(
        { version: 1, purpose: "use", targets: [receipt.records[0]!.id] },
        { ...controls, library: f.library.library_id },
      )
      expect(read.status).toBe("ready")
      if (read.status !== "ready") throw new Error("The unpatched member was not consumable")
      const main = f.facts.members[index].files.find(
        (file: { path: string }) => file.path === "SKILL.md",
      )
      const node = read.preparation.nodes.find((node) => node.id === receipt.records[0]!.id)
      expect(node?.state).toBe("prepared")
      expect(node?.state === "prepared" ? node.content : undefined).toBe(main.content)
      await save(join(f.out, label + "-receipt.json"), { receipt, consume: read, requests: rows })
    }
    const unrelated = f.service.notion.sources.find(
      (row: { id: string }) => row.id === "00000000-0000-4000-8000-0000000fff70",
    )
    expect(unrelated).toEqual(
      original.sources.find((row: { id: string }) => row.id === unrelated.id),
    )
    await f.snapshot("after")
    await f.close()
    results.push({ name: "member-write-capability", status: "completed", evidence: f.out })
  } finally {
    await f.close()
  }
}, 180_000)

type Fixture = Awaited<ReturnType<typeof fixture>>
async function scenario(name: string, body: (f: Fixture) => Promise<void>) {
  const f = await fixture(name)
  try {
    await f.snapshot("before")
    await body(f)
    await f.close()
    results.push({ name, status: "passed", evidence: f.out })
  } catch (error) {
    results.push({ name, status: "failed", evidence: f.out, error: String(error) })
    throw error
  } finally {
    await f.close()
  }
}
async function assertOriginal(
  f: Fixture,
  before: ReturnType<typeof databaseSnapshot>,
  label: string,
) {
  const after = await f.snapshot(label)
  expect(operations(after).map((row) => [row.key, intent(row)])).toEqual(
    operations(before).map((row) => [row.key, intent(row)]),
  )
  const frozen = (snapshot: ReturnType<typeof databaseSnapshot>) =>
    snapshot.rows.filter((row) => row.key.startsWith("operations/current-source-materialization/"))
  expect(frozen(before)).toHaveLength(1)
  expect(frozen(after)).toEqual(frozen(before))
  return after
}
async function recordControl(f: Fixture, retire: boolean) {
  const created = f.service.holdNext({
    method: "POST",
    path: "/v1/pages",
    afterHeaders: true,
    matchBody: { path: ["properties", f.library.records.property_ids["Record ID"]], exists: true },
  })
  const running = f.launch("original")
  await bounded(
    Promise.race([
      created.reached,
      running.done.then((result) => {
        throw new Error("Manager exited before Source control Record: " + JSON.stringify(result))
      }),
    ]),
    "first Source control Record",
  )
  const parent = f.service.notion.records.find((row: unknown) => {
    if (object(field(row, f.library.records.property_ids.Kind).select).name !== "operation")
      return false
    const envelope = object(JSON.parse(rich(row, f.library.records.property_ids.Payload)))
    const owner = object(object(object(envelope.payload).intent).owner)
    return owner.kind === "source" && owner.id === f.facts.source_id
  })
  assert.ok(parent)
  const held = f.service.holdNext({
    method: "PATCH",
    path: "/v1/pages/" + parent.id,
    applyAfterDisconnect: true,
    ...(retire ? { matchBody: { path: ["in_trash"], value: true } } : {}),
  })
  created.release()
  await created.closed
  return { running, held, parent }
}

test(
  "fixed manager never replays a late business PATCH or unlocks it from matching GET values",
  () =>
    scenario("business-patch", async (f) => {
      const held = f.service.holdNext({
        method: "PATCH",
        path: "/v1/pages/" + f.facts.source_page_id,
        applyAfterDisconnect: true,
        matchBody: { path: ["properties", f.library.sources.property_ids.Content], exists: true },
      })
      const original = await f.cut(f.launch("original"), held)
      const pending = await f.snapshot("disconnected")
      expect(operations(pending)).toHaveLength(1)
      expect(operations(pending)[0]!.payload.not_dispatched).toBeUndefined()
      expect(operations(pending)[0]!.payload.settled_action).toBeUndefined()
      expect(await f.noWrites("resume-before-late")).toMatchObject({
        status: "pending",
        reason: "CURRENT_OPERATION_UNRESOLVED",
      })
      await assertOriginal(f, pending, "before-late-retained")
      held.release()
      expect(await held.closed).toMatchObject({
        sequence: original.sequence,
        terminal: "aborted",
        semantic_write: true,
        response_bytes_complete: false,
      })
      const source = f.service.notion.sources.find(
        (row: { id: string }) => row.id === f.facts.source_page_id,
      )
      expect(object(field(source, f.library.sources.property_ids.Status).select).name).toBe(
        "applying",
      )
      expect(rich(source, f.library.sources.property_ids.Operation)).toBe(
        intent(operations(pending)[0]!).operation_id,
      )
      const desiredContent = object(
        object(object(original.body).properties)[f.library.sources.property_ids.Content],
      )
      expect(field(source, f.library.sources.property_ids.Content).rich_text).toEqual(
        desiredContent.rich_text,
      )
      // The late Source Content now differs from the frozen starting plan. The
      // writer refuses that preflight conflict; GET equality never settles the
      // original unknown dispatch or permits replay.
      expect(await f.noWrites("resume-after-late")).toMatchObject({
        status: "blocked",
        reason: "CURRENT_SOURCE_WRITE_CONFLICT",
        effects: { remote_writes: "unknown" },
      })
      await assertOriginal(f, pending, "after-late-retained")
    }),
  180_000,
)

test(
  "fixed manager settles only the original late control Record PATCH nonce",
  () =>
    scenario("record-patch", async (f) => {
      const { running, held, parent } = await recordControl(f, false)
      await f.cut(running, held)
      const pending = await f.snapshot("disconnected")
      const original = operations(pending).find((row) => operationOwner(row).kind === "source")!
      expect(original.payload.control_write).toMatchObject({
        kind: "record",
        page_id: parent.id,
        write_id: expect.any(String),
      })
      expect(await f.noWrites("resume-before-late")).toMatchObject({
        status: "pending",
        reason: "CURRENT_OPERATION_UNRESOLVED",
      })
      await assertOriginal(f, pending, "before-late-retained")
      held.release()
      expect(await held.closed).toMatchObject({ terminal: "aborted", semantic_write: true })
      const appliedRecord = f.service.notion.records.find(
        (row: { id: string }) => row.id === parent.id,
      )
      expect(JSON.parse(rich(appliedRecord, f.library.records.property_ids.Payload))).toMatchObject(
        {
          operation_id: intent(original).operation_id,
          write_id: object(original.payload.control_write).write_id,
        },
      )
      expect(await f.run("resume-after-original-nonce")).toMatchObject({
        status: "ready",
        operation_id: intent(original).operation_id,
      })
      expect((await f.snapshot("completed")).rows).toEqual([])
    }),
  180_000,
)

test(
  "fixed manager settles late Record retirement only at its original physical locator",
  () =>
    scenario("record-retire", async (f) => {
      const { running, held, parent } = await recordControl(f, true)
      await f.cut(running, held)
      const pending = await f.snapshot("disconnected")
      const original = operations(pending).find((row) => operationOwner(row).kind === "source")!
      expect(original.payload.control_write).toMatchObject({
        kind: "retire",
        page_id: parent.id,
        hash: expect.any(String),
      })
      expect(await f.noWrites("resume-before-late")).toMatchObject({
        status: "pending",
        reason: "CURRENT_OPERATION_UNRESOLVED",
      })
      held.release()
      expect(await held.closed).toMatchObject({ terminal: "aborted", semantic_write: true })
      const retiredRecord = f.service.notion.records.find(
        (row: { id: string }) => row.id === parent.id,
      )
      expect(retiredRecord.in_trash).toBe(true)
      expect(rich(retiredRecord, f.library.records.property_ids.Hash)).toBe(
        object(original.payload.control_write).hash,
      )
      expect(rich(retiredRecord, f.library.records.property_ids["Record ID"])).toBe(
        object(original.payload.control_write).record_id,
      )
      expect(await f.noWrites("resume-after-original-retirement")).toMatchObject({
        status: "ready",
        operation_id: intent(original).operation_id,
      })
      expect((await f.snapshot("completed")).rows).toEqual([])
    }),
  180_000,
)

test(
  "an unsettled real child blocks a different manager request before any parent successor mutation",
  () =>
    scenario("child-successor", async (f) => {
      const held = f.service.holdNext({
        method: "POST",
        path: "/v1/pages",
        applyAfterDisconnect: true,
        matchBody: {
          path: ["properties", f.library.skills.property_ids["Skill ID"]],
          exists: true,
        },
      })
      await f.cut(f.launch("original"), held)
      const pending = await f.snapshot("disconnected")
      const parent = operations(pending).find((row) => operationOwner(row).kind === "source")!
      const child = operations(pending).find((row) => operationOwner(row).kind === "skill")!
      expect(child).toBeDefined()
      expect(intent(child).source).toMatchObject({
        operation_id: intent(parent).operation_id,
        input_sha256: intent(parent).input_sha256,
      })
      const successor = { ...f.request, request_id: f.request.request_id + "-successor" }
      expect(await f.noWrites("successor-before-late", successor)).toMatchObject({
        status: "pending",
        reason: "CURRENT_OPERATION_PENDING",
        effects: { remote_writes: "none" },
      })
      await assertOriginal(f, pending, "successor-rejected")
      held.release()
      expect(await held.closed).toMatchObject({ terminal: "aborted", semantic_write: true })
      expect(await f.noWrites("successor-after-late", successor)).toMatchObject({
        status: "pending",
        reason: "CURRENT_OPERATION_PENDING",
        effects: { remote_writes: "none" },
      })
      await assertOriginal(f, pending, "late-child-still-owned")
      expect(await f.run("resume-original-child")).toMatchObject({
        status: "ready",
        operation_id: intent(parent).operation_id,
      })
      expect((await f.snapshot("completed")).rows).toEqual([])
    }),
  180_000,
)
