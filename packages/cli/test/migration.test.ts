import { beforeAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  unlink,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stableSyncJson } from "../../core/src/sync.ts"

const node = Bun.which("node")!
const repository = new URL("../../../", import.meta.url).pathname
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
let entrypoint: string
let operatorEntrypoint: string
let preload: string
async function run(
  argv: string[],
  environment: Record<string, string> = {},
  executable = entrypoint,
) {
  const child = Bun.spawn([node, "--import", preload, executable, ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...environment },
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exit }
}
beforeAll(async () => {
  const directory = await mkdtemp(join(tmpdir(), "ntn-migration-build-"))
  const output = join(directory, "artifact")
  const build = Bun.spawn(["bun", "scripts/build-migration.ts", output], {
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ])
  if (exit !== 0) throw new Error(`Independent migration build: ${stdout}\n${stderr}`)
  await symlink(join(repository, "packages/cli/node_modules"), join(output, "node_modules"), "dir")
  entrypoint = join(output, "ntn-skills-migrate.js")
  operatorEntrypoint = join(output, "ntn-skills-operator.js")
  preload = join(directory, "crash.mjs")
  // Fault injection occurs at real Node filesystem renames, without a product test hook.
  await writeFile(
    preload,
    `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const rename=fs.rename;fs.rename=function(from,to,callback){if(process.env.MIGRATION_CRASH==='config'&&to===process.env.MIGRATION_CONFIG){process.kill(process.pid,'SIGKILL');return}rename.call(fs,from,to,(error)=>{if(!error&&process.env.MIGRATION_CRASH==='config-renamed'&&to===process.env.MIGRATION_CONFIG){process.kill(process.pid,'SIGKILL');return}if(!error&&to===process.env.MIGRATION_JOURNAL&&process.env.MIGRATION_CRASH&&process.env.MIGRATION_CRASH!=='config'){const marker=JSON.parse(fs.readFileSync(to,'utf8'));if(marker.stage===process.env.MIGRATION_CRASH){process.kill(process.pid,'SIGKILL');return}}callback(error)})};syncBuiltinESMExports();`,
  )
})
test("independent historical operator help and parser recovery work without state or provider access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ntn-operator-offline-"))
  const blocked = join(directory, "blocked")
  await writeFile(blocked, "not a directory")
  const environment = {
    HOME: blocked,
    NTN_SKILLS_HOME: blocked,
    NTN_SKILLS_CONFIG_HOME: blocked,
    NTN_SKILLS_CACHE_HOME: blocked,
    NTN_SKILLS_NTN_BIN: join(directory, "missing-ntn"),
    NOTION_API_TOKEN: "",
    NOTION_WORKSPACE_ID: "",
  }
  for (const [args, expected] of [
    [
      ["upstream", "--help"],
      ["content-adopt-plan", "prepare-apply", "restore-deleted"],
    ],
    [
      ["operation", "--help"],
      ["body-completion-reconcile", "supersede-plan", "accept-edit"],
    ],
  ] satisfies Array<[string[], string[]]>) {
    const result = await run(args, environment, operatorEntrypoint)
    expect(result.exit, result.stdout + result.stderr).toBe(0)
    expect(result.stderr).toBe("")
    for (const command of expected) expect(result.stdout).toContain(command)
  }
  const invalid = await run(["upstream", "unknown-command"], environment, operatorEntrypoint)
  expect(invalid.exit).toBe(2)
  expect(invalid.stderr).toBe("")
  expect(JSON.parse(invalid.stdout)).toMatchObject({
    ok: false,
    error: { code: "INVALID_ARGUMENT" },
    next: { argv: ["ntn-skills-operator", "upstream", "--help"] },
  })
  expect(await readFile(blocked, "utf8")).toBe("not a directory")
})

async function fixture(
  options: { absentConfig?: boolean; fallback?: boolean; reviewOnly?: boolean } = {},
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ntn-migration-roots-")))
  const state = join(directory, "A/state"),
    config = join(directory, "A/config"),
    cache = join(directory, "A/cache"),
    backup = join(directory, "backup")
  await Promise.all(
    [state, config, cache, join(directory, "B/config")].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  )
  const binding = {
    id: "b_original",
    label: "sample",
    scope: "scope-A",
    page_id: "page",
    database_id: "db",
    data_source_id: "ds",
    logical_path: "/fixture",
    active: true,
    revision: 1,
  }
  const base = {
    format: "ntn-skills-sync-base",
    version: 1,
    binding_id: binding.id,
    generation: 7,
    initialized: false,
  }
  const content = { name: "Sample", description: "", main: "", files: [], content_id: "original" }
  const snapshot = {
    snapshot_id: "s_original",
    scope: binding.scope,
    skill: {
      id: "page",
      name: "Sample",
      alias: "sample",
      description: "",
      database_id: "db",
      data_source_id: "ds",
      ref: "page",
    },
    skill_name: "Sample",
    version_id: "v_original",
    created_at: 1,
    files: [],
  }
  const body = {
    format: "ntn-skills-sync-plan",
    version: 1,
    applicable: true,
    bindings: [
      {
        binding,
        base,
        local: {
          logical_path: "/fixture",
          resolved_path: "/fixture",
          exists: true,
          proof: {},
          file_hashes: [],
        },
        remote: snapshot,
        remote_content: content,
        mode: "exact",
        direction: "push",
        intended: content,
        actions: [],
      },
    ],
    conflicts: [],
  }
  const plan = { ...body, plan_id: `p_${hash(stableSyncJson(body))}` }
  const receipt = {
    format: "ntn-skills-sync-receipt",
    version: 1,
    operation_id: "op_original",
    plan_id: plan.plan_id,
    created_at: 1,
    status: "pending",
    groups: [{ page_id: "page", stage: "writing" }],
    bindings: [
      {
        binding_id: binding.id,
        page_id: "page",
        resolved_path: "/fixture",
        stage: "writing",
        generation_before: 7,
        retained: [],
      },
    ],
    unknown_receipt_field: "preserve",
  }
  const publication = {
    format: 1,
    operation_id: "pub_original",
    operation: "replace",
    scope: binding.scope,
    state: "unknown",
    portable: { name: "Sample", description: "", main: "", files: [] },
    guards: { original: true },
    intents: [
      { path: "/pages/page", method: "PATCH", status: "unknown", body: { original: true } },
    ],
    stages: [],
    unknown_publication_field: 42,
  }
  const original = {
    token: "private-A",
    sources: [],
    future_setting: { exact: [false, 0, "original"] },
    ...(options.reviewOnly ? {} : { sync_bindings: [binding] }),
  }
  const originalRaw = JSON.stringify(original, null, 2) + "\n"
  if (!options.absentConfig)
    await writeFile(join(options.fallback ? state : config, "config.json"), originalRaw, {
      mode: 0o640,
    })
  for (const [key, value] of Object.entries(
    options.reviewOnly
      ? {}
      : {
          [`sync/bases/${binding.id}.json`]: base,
          [`sync/plans/${plan.plan_id}.json`]: plan,
          "sync/receipts/op_original.json": receipt,
          "publications/pub_original.json": publication,
        },
  )) {
    await mkdir(join(state, key, ".."), { recursive: true })
    await writeFile(join(state, key), JSON.stringify(value))
  }
  const bConfig = join(directory, "B/config")
  await writeFile(join(bConfig, "config.json"), '{ "token": "private-B", "untouched": true }\n', {
    mode: 0o640,
  })
  await chmod(join(bConfig, "config.json"), 0o640)
  const journal = join(state, "sqlite-migration.json")
  const args = (
    overrides: Partial<{ state: string; config: string; cache: string; backup: string }> = {},
  ) => [
    overrides.state ?? state,
    "--config-directory",
    overrides.config ?? config,
    "--cache-directory",
    overrides.cache ?? cache,
    "--backup-directory",
    overrides.backup ?? backup,
    "--old-writers-stopped",
  ]
  const crash = (stage: string) =>
    run(args(), {
      MIGRATION_CRASH: stage,
      MIGRATION_CONFIG: join(config, "config.json"),
      MIGRATION_JOURNAL: journal,
    })
  return {
    directory,
    state,
    config,
    cache,
    backup,
    journal,
    args,
    crash,
    original,
    originalRaw,
    bConfig,
    plan,
    receipt,
    publication,
  }
}
async function observeDatabase(root: string) {
  const script = `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(join(root, "state.sqlite"))});const rows=Object.fromEntries(['bindings','bases','plans','sync_receipts','publications','publication_intents','migration_imports','historical_review_artifacts'].map(t=>[t,db.prepare('SELECT * FROM '+t).all()]));db.close();console.log(JSON.stringify(rows));`
  const child = Bun.spawn([node, "--input-type=module", "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exit, stderr).toBe(0)
  return JSON.parse(stdout)
}
interface RecoveryTarget {
  bConfig: string
  journal: string
  args: (
    overrides: Partial<{ state: string; config: string; cache: string; backup: string }>,
  ) => string[]
}
async function rejected(
  f: RecoveryTarget,
  overrides: Partial<{ state: string; config: string; cache: string; backup: string }> = {},
) {
  const before = await readFile(join(f.bConfig, "config.json"))
  const mode = (await stat(join(f.bConfig, "config.json"))).mode
  const journal = await readFile(f.journal)
  const result = await run(f.args(overrides))
  expect(result.exit, result.stdout + result.stderr).not.toBe(0)
  expect(await readFile(join(f.bConfig, "config.json"))).toEqual(before)
  expect((await stat(join(f.bConfig, "config.json"))).mode).toBe(mode)
  expect(await readFile(f.journal)).toEqual(journal)
}

test("real imported crash refuses another environment before writes, then accepts canonical aliases without reimport", async () => {
  const f = await fixture()
  expect((await f.crash("config")).exit).not.toBe(0)
  expect(JSON.parse(await readFile(f.journal, "utf8")).stage).toBe("imported")
  const before = await observeDatabase(f.state)
  expect(before.plans).toEqual([])
  expect(before.sync_receipts).toEqual([])
  const audited = Object.fromEntries(
    before.historical_review_artifacts.map((row: { key: string; payload: string }) => [
      row.key,
      JSON.parse(row.payload),
    ]),
  )
  expect(audited[`sync/plans/${f.plan.plan_id}.json`]).toEqual(f.plan)
  expect(audited["sync/receipts/op_original.json"]).toEqual(f.receipt)
  const review = JSON.parse(await readFile(join(f.state, "migration-review.json"), "utf8"))
  expect(review).toMatchObject({
    executable: false,
    plans: [
      {
        original_plan_id: f.plan.plan_id,
        original_sha256: hash(JSON.stringify(f.plan)),
        original_key: `sync/plans/${f.plan.plan_id}.json`,
        binding_ids: ["b_original"],
        approval: "required",
      },
    ],
  })
  expect(before.publications).toHaveLength(1)
  expect(JSON.parse(before.publications[0].payload)).toEqual({
    ...f.publication,
    portable: { ...f.publication.portable, kind: "skill" },
  })
  expect(
    JSON.parse(await readFile(join(f.state, "legacy-publication-migration-audit.json"), "utf8"))
      .publications[0].original_wire,
  ).toEqual(f.publication)
  await rejected(f, { config: f.bConfig })
  await symlink(join(f.directory, "A"), join(f.directory, "alias"), "dir")
  const alias = join(f.directory, "alias")
  const result = await run(
    f.args({
      state: join(alias, "state"),
      config: join(alias, "config", "..", "config"),
      cache: join(alias, "cache"),
    }),
  )
  expect(result.exit, result.stdout + result.stderr).toBe(0)
  const { sync_bindings: _retired, ...expected } = f.original
  expect(JSON.parse(await readFile(join(f.config, "config.json"), "utf8"))).toEqual(expected)
  expect(JSON.parse(await readFile(f.journal, "utf8")).stage).toBe("switched")
  expect(await observeDatabase(f.state)).toEqual(before)
  expect((await run(f.args())).exit).toBe(0)
  await rejected(f, { config: f.bConfig })
}, 60_000)

test("source edits, replaced directories, mismatched backup and scope roots reject imported recovery", async () => {
  const f = await fixture()
  expect((await f.crash("config")).exit).not.toBe(0)
  const source = join(f.state, "sync/receipts/op_original.json")
  const bytes = await readFile(source)
  await writeFile(source, JSON.stringify({ ...f.receipt, status: "diverged" }))
  await rejected(f)
  await writeFile(source, bytes)
  await rename(f.config, f.config + "-original")
  await mkdir(f.config)
  await writeFile(join(f.config, "config.json"), f.originalRaw)
  await rejected(f)
  await rename(f.config, f.config + "-replacement")
  await rename(f.config + "-original", f.config)
  const otherBackup = join(f.directory, "other-backup")
  await mkdir(otherBackup)
  await rejected(f, { backup: otherBackup })
  const otherCache = join(f.directory, "other-cache")
  await mkdir(otherCache)
  await rejected(f, { cache: otherCache })
  const backupConfig = join(f.backup, "config/config.json")
  const originalBackup = await readFile(backupConfig)
  await writeFile(backupConfig, JSON.stringify({ token: "different" }))
  await rejected(f)
  await writeFile(backupConfig, originalBackup)
  expect((await run(f.args())).exit).toBe(0)
}, 60_000)

test("interrupted importing resumes unchanged with original hashes, fields and pending operations exactly once", async () => {
  const f = await fixture()
  expect((await f.crash("importing")).exit).not.toBe(0)
  const marker = JSON.parse(await readFile(f.journal, "utf8"))
  expect(marker.stage).toBe("importing")
  const result = await run(f.args())
  expect(result.exit, result.stdout + result.stderr).toBe(0)
  const database = await observeDatabase(f.state)
  expect(database.bindings).toHaveLength(1)
  expect(database.bases).toHaveLength(1)
  expect(database.plans).toEqual([])
  expect(database.sync_receipts).toEqual([])
  expect(database.publications).toHaveLength(1)
  expect(JSON.parse(database.publications[0].payload)).toEqual({
    ...f.publication,
    portable: { ...f.publication.portable, kind: "skill" },
  })
  expect(database.publication_intents).toHaveLength(1)
  expect(database.historical_review_artifacts).toHaveLength(2)
  expect(database.migration_imports).toHaveLength(1)
  expect(database.migration_imports[0].source_hash).toBe(marker.source_hash)
  const audited = Object.fromEntries(
    database.historical_review_artifacts.map((row: { key: string; payload: string }) => [
      row.key,
      JSON.parse(row.payload),
    ]),
  )
  expect(audited[`sync/plans/${f.plan.plan_id}.json`]).toEqual(f.plan)
  expect(audited["sync/receipts/op_original.json"]).toEqual(f.receipt)
  expect(
    JSON.parse(await readFile(join(f.state, "legacy-publication-migration-audit.json"), "utf8"))
      .publications[0].original_wire,
  ).toEqual(f.publication)
  expect((await run(f.args())).exit).toBe(0)
  expect(await observeDatabase(f.state)).toEqual(database)
}, 60_000)

test("unbound old journals refuse automatic recovery without touching another environment", async () => {
  const f = await fixture()
  await writeFile(
    f.journal,
    JSON.stringify({ stage: "imported", backup: f.backup, source_hash: "old" }),
  )
  await rejected(f, { config: f.bConfig })
})

test("missing original config and state-root fallback both survive imported recovery", async () => {
  for (const options of [{ absentConfig: true }, { fallback: true }]) {
    const f = await fixture(options)
    expect((await f.crash("config")).exit).not.toBe(0)
    const result = await run(f.args())
    expect(result.exit, result.stdout + result.stderr).toBe(0)
    const config = JSON.parse(await readFile(join(f.config, "config.json"), "utf8"))
    expect(config).toEqual(
      options.absentConfig
        ? {}
        : {
            token: f.original.token,
            sources: f.original.sources,
            future_setting: f.original.future_setting,
          },
    )
    expect((await run(f.args())).exit).toBe(0)
  }
}, 60_000)

test("configuration rename before switched journal accepts only the exact frozen output", async () => {
  const f = await fixture()
  expect((await f.crash("config-renamed")).exit).not.toBe(0)
  expect(JSON.parse(await readFile(f.journal, "utf8")).stage).toBe("imported")
  const destination = join(f.config, "config.json")
  const switched = await readFile(destination)
  await writeFile(destination, JSON.stringify({ token: "external-change" }))
  await rejected(f)
  await writeFile(destination, switched)
  const result = await run(f.args())
  expect(result.exit, result.stdout + result.stderr).toBe(0)
  expect(JSON.parse(await readFile(f.journal, "utf8")).stage).toBe("switched")
}, 60_000)

test("explicit SQLite record input preserves original IDs, plan bytes, guards and baselines", async () => {
  const f = await fixture()
  expect((await run(f.args())).exit).toBe(0)
  // This explicitly historical input predates the current view-observation migration.
  const seed = `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(join(f.state, "state.sqlite"))});const snapshot=${JSON.stringify({ snapshot_id: "s_sql_original", scope: "scope-A", skill: { id: "page", name: "Sample", alias: "sample", description: "", database_id: "db", data_source_id: "ds", ref: "page" }, skill_name: "Sample", version_id: "v_original", created_at: 1, files: [] })};db.prepare('INSERT INTO snapshots(id,scope,record_identity,locator,version_id,manifest) VALUES(?,?,?,?,?,?)').run(snapshot.snapshot_id,snapshot.scope,'page',null,snapshot.version_id,JSON.stringify(snapshot));db.prepare('INSERT INTO plans(id,payload) VALUES(?,?)').run(${JSON.stringify(f.plan.plan_id)},${JSON.stringify(JSON.stringify(f.plan))});db.exec('DROP TABLE view_observations; DELETE FROM effect_sql_migrations WHERE migration_id=8;');db.close();`
  const seeded = Bun.spawn([node, "--input-type=module", "-e", seed], {
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(await seeded.exited).toBe(0)
  const before = await observeDatabase(f.state)
  const config = await readFile(join(f.config, "config.json"))
  const backup = join(f.directory, "sql-record-backup")
  const upgraded = await run([...f.args({ backup }), "--input-format", "sqlite-v1"])
  expect(upgraded.exit, upgraded.stdout + upgraded.stderr).toBe(0)
  const report = JSON.parse(upgraded.stdout)
  expect(report).toMatchObject({
    ok: true,
    migrated: true,
    converted_snapshots: 1,
    config_changed: false,
    baselines_changed: false,
    historical_plans: [{ original_plan_id: f.plan.plan_id, executable: false }],
  })
  const after = await observeDatabase(f.state)
  expect(after.plans).toEqual([])
  expect(after.bases).toEqual(before.bases)
  expect(after.bindings).toEqual(before.bindings)
  expect(await readFile(join(f.config, "config.json"))).toEqual(config)
  expect(
    after.historical_review_artifacts.some(
      (row: { key: string; payload: string }) =>
        row.key === `sync/plans/${f.plan.plan_id}.json` && row.payload === JSON.stringify(f.plan),
    ),
  ).toBe(true)
  const inspect = Bun.spawn(
    [
      node,
      "--input-type=module",
      "-e",
      `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(join(f.state, "state.sqlite"))});console.log(db.prepare('SELECT manifest FROM snapshots WHERE id=?').get('s_sql_original').manifest);db.close()`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const snapshot = JSON.parse(await new Response(inspect.stdout).text())
  expect(await inspect.exited).toBe(0)
  expect(snapshot).toMatchObject({
    snapshot_id: "s_sql_original",
    historical_snapshot_id: "s_sql_original",
    entrypoint: "SKILL.md",
    record: {
      id: "notion_page:page",
      locator: { page_id: "page", database_id: "db", data_source_id: "ds" },
    },
  })
}, 60000)

test("unproven historical import remains public review evidence and cannot replay", async () => {
  const f = await fixture({ reviewOnly: true })
  const id = "p_unresolved"
  await mkdir(join(f.state, "publications"), { recursive: true })
  await writeFile(
    join(f.state, "publications", `${id}.json`),
    JSON.stringify({ ...f.publication, operation_id: id, operation: "import" }),
  )
  const migrated = await run(f.args())
  expect(migrated.exit, migrated.stdout + migrated.stderr).toBe(0)
  const code = `import {Effect,Layer} from 'effect';import * as NodeServices from '@effect/platform-node/NodeServices';import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';import {Store,StoreLive} from ${JSON.stringify(join(repository, "packages/core/src/store.ts"))};import {NotionLive} from ${JSON.stringify(join(repository, "packages/core/src/notion.ts"))};import {SyncLocalLive} from ${JSON.stringify(join(repository, "packages/core/src/sync-local.ts"))};import {UpstreamState} from ${JSON.stringify(join(repository, "packages/core/src/upstream-state.ts"))};import {UpstreamPublisherLive} from ${JSON.stringify(join(repository, "packages/core/src/upstream-publication.ts"))};import {showOperation,listOperations,resumeOperation,reconcileOperation} from ${JSON.stringify(join(repository, "packages/core/src/command-operations.ts"))};const platform=Layer.merge(NodeServices.layer,NodeHttpClient.layerFetch);const storage=StoreLive.pipe(Layer.provideMerge(platform));const notion=NotionLive.pipe(Layer.provideMerge(storage));const local=SyncLocalLive.pipe(Layer.provideMerge(notion));const runtime=UpstreamPublisherLive.pipe(Layer.provideMerge(Layer.effect(UpstreamState,Effect.map(Store,s=>s.upstream)).pipe(Layer.provideMerge(local))));const program=Effect.gen(function*(){const show=yield*showOperation('${id}');const listed=yield*listOperations;const resumed=yield*Effect.result(resumeOperation('${id}'));const reconciled=yield*reconcileOperation('${id}');console.log(JSON.stringify({show,listed,resumed:resumed._tag==='Failure'?resumed.failure.code:null,reconciled}))});await Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(runtime)));`
  const consumer = join(
    repository,
    "packages/core",
    `.migration-consumer-${crypto.randomUUID()}.mjs`,
  )
  await writeFile(consumer, code)
  const child = Bun.spawn([node, "--experimental-strip-types", consumer], {
    cwd: repository,
    env: {
      ...process.env,
      NTN_SKILLS_HOME: f.state,
      NTN_SKILLS_CONFIG_HOME: f.config,
      NTN_SKILLS_CACHE_HOME: f.cache,
      NTN_SKILLS_NTN_BIN: join(f.directory, "missing-offline-provider"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  await unlink(consumer)
  expect(exit, stdout + stderr).toBe(0)
  const observed = JSON.parse(stdout)
  expect(observed.show).toMatchObject({
    operation_id: id,
    domain: "review",
    state: "unknown",
    result: { reason: "UNRESOLVED_NO_REPLAY" },
    verified: false,
    resume_supported: false,
  })
  expect(observed.listed.operations).toContainEqual(observed.show)
  expect(observed.resumed).toBe("UNRESOLVED_NO_REPLAY")
  expect(observed.reconciled).toEqual(observed.show)
}, 60000)
