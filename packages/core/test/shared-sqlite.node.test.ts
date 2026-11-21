import { expect, test } from "@effect/vitest"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { trashPath } from "../src/local-locks.ts"

const core = new URL("../src/", import.meta.url).pathname
const scope = "a".repeat(64)
const pendingKey = `operations/current-write-pending/${scope}/pending.json`
const pendingPayload = {
  completion: "ready",
  owner_page_id: null,
  version: 1,
  scope,
  library_id: "current-sqlite",
  record_id: "operation-current-" + "c".repeat(64),
  intent: {
    operation_id: "current-write",
    owner: { kind: "skill", id: "sqlite-current" },
    input_sha256: "d".repeat(64),
  },
  lifecycle: { phase: "active", record_page_id: "00000000-0000-4000-8000-000000000001" },
  not_dispatched: { key: "append:0", request_sha256: "e".repeat(64), replay: "never" },
}
const restrictedHash = "9".repeat(64)
const restrictionKey = `content-restrictions/local/${restrictedHash}.json`
const restriction = { version: 1, sha256: restrictedHash, reason: "local_resource" }

function processProgram(root: string, body: string) {
  return `import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {Effect,FileSystem} from ${JSON.stringify(import.meta.resolve("effect"))};
import {SqlClient} from ${JSON.stringify(import.meta.resolve("effect/sql"))};
import {sqliteState} from ${JSON.stringify(core + "sqlite-state.ts")};
Effect.runPromise(Effect.scoped(Effect.gen(function*(){const state=yield* sqliteState(${JSON.stringify(root)},yield* FileSystem.FileSystem);${body}})).pipe(Effect.provide(NodeServices.layer))).catch(error=>{console.error(String(error));process.exitCode=1})`
}

function start(program: string) {
  return spawn(process.execPath, ["--input-type=module", "-e", program], {
    stdio: ["ignore", "pipe", "pipe"],
  })
}

async function runProgram(program: string) {
  const worker = start(program)
  let stdout = "",
    stderr = ""
  worker.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk
  })
  worker.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk
  })
  const [exit] = await once(worker, "close")
  return { stdout, stderr, exit }
}

const child = (root: string, body: string) => runProgram(processProgram(root, body))

async function isolated(action: (root: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "ntn-shared-sqlite-"))
  try {
    await action(join(directory, "state"))
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
  }
}

test("the current native slot fences rejected cold reads and pre-clear completions while accepting later recovery", async () => {
  const domain = "current-native-bodies"
  await isolated(async (root) => {
    const key = `cache/${domain}/${"7".repeat(64)}/latest.json`
    const identity = "shared_skill:slot-library:slot-skill"
    const payload = {
      version: 1,
      scope,
      library_id: "slot-library",
      skill_id: "slot-skill",
      skill_page_id: "00000000-0000-4000-8000-000000000001",
      files: Array.from({ length: 80 }, (_, index) => ({
        file_id: `file-${index}`,
        page_id: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
        path: index === 0 ? "SKILL.md" : `references/${index}.md`,
        descriptor: JSON.stringify({ kind: "native", mode: "100644", frontmatter: "" }),
        last_edited_time: "2026-11-18T00:00:00.000Z",
        body_sha256: "a".repeat(64),
        body_verified_at: 1000,
      })),
    }
    const write = (generation: number) =>
      `yield* state.write(${JSON.stringify(key)},{...${JSON.stringify(payload)},generation:${generation}})`
    const initialize = await child(
      root,
      `for(let i=0;i<3;i++)yield* state.reserve(${JSON.stringify(scope)},${JSON.stringify(identity)});yield* state.write(${JSON.stringify(key)},{...${JSON.stringify(payload)},generation:2,files:[]})`,
    )
    expect(initialize.exit, initialize.stderr).toBe(0)
    // The first completed request was denied before any body cache existed. An
    // earlier successful request may finish later, but cannot restore its bytes
    // as a current native observation. A new successful generation can recover.
    const delayed = await child(root, write(1))
    expect(delayed.exit, delayed.stderr).toBe(0)
    const denied = await child(
      root,
      `console.log(JSON.stringify(yield* state.read(${JSON.stringify(key)})))`,
    )
    expect(denied.exit, denied.stderr).toBe(0)
    expect(JSON.parse(denied.stdout)).toEqual({ ...payload, generation: 2, files: [] })
    const contenders = await Promise.all([3, 1].map((generation) => child(root, write(generation))))
    for (const result of contenders) expect(result.exit, result.stderr).toBe(0)
    const newest = await child(
      root,
      `console.log(JSON.stringify(yield* state.read(${JSON.stringify(key)})))`,
    )
    expect(newest.exit, newest.stderr).toBe(0)
    expect(JSON.parse(newest.stdout)).toEqual({ ...payload, generation: 3 })
    const conflict = await child(
      root,
      `yield* state.write(${JSON.stringify(key)},{...${JSON.stringify(payload)},generation:3,files:${JSON.stringify(payload.files.map((file, index) => (index === 0 ? { ...file, body_sha256: "b".repeat(64) } : file)))}})`,
    )
    expect(conflict.exit).not.toBe(0)
    expect(conflict.stderr).toContain("different content")
    const cleared = await child(
      root,
      `yield* state.reserve(${JSON.stringify(scope)},${JSON.stringify(identity)});yield* state.retire([${JSON.stringify(key)}]);console.log(JSON.stringify({active:yield* state.list(${JSON.stringify(`cache/${domain}`)})}))`,
    )
    expect(cleared.exit, cleared.stderr).toBe(0)
    expect(JSON.parse(cleared.stdout).active).toEqual([])
    const late = await child(root, write(4))
    expect(late.exit).not.toBe(0)
    expect(late.stderr).toContain("retired before publication")
    const batch = (count: number) =>
      child(
        root,
        `for(let i=0;i<${count};i++){const generation=yield* state.reserve(${JSON.stringify(scope)},${JSON.stringify(identity)});yield* state.write(${JSON.stringify(key)},{...${JSON.stringify(payload)},generation})}yield* state.run(Effect.gen(function*(){const sql=yield* SqlClient.SqlClient;console.log(JSON.stringify({rows:yield* sql\`SELECT count(*) AS count,sum(length(payload)) AS bytes FROM shared_local_records\`,pages:yield* sql\`PRAGMA page_count\`}))}))`,
      )
    const first = await batch(20),
      repeated = await batch(60)
    expect(first.exit, first.stderr).toBe(0)
    expect(repeated.exit, repeated.stderr).toBe(0)
    const initial = JSON.parse(first.stdout),
      final = JSON.parse(repeated.stdout)
    expect(initial.rows[0].count).toBe(1)
    expect(final).toEqual(initial)
  })
}, 30_000)

test("a newer native observation can follow a rebuilt page without changing logical owner or accepting late old-page publication", async () => {
  await isolated(async (root) => {
    const key = `cache/current-native-bodies/${"8".repeat(64)}/latest.json`
    const identity = "shared_skill:rebuilt-library:rebuilt-skill"
    const old = {
      version: 1,
      scope,
      library_id: "rebuilt-library",
      skill_id: "rebuilt-skill",
      skill_page_id: "00000000-0000-4000-8000-000000000001",
      files: [],
    }
    const rebuilt = { ...old, skill_page_id: "00000000-0000-4000-8000-000000000002" }
    const write = (value: typeof old, generation: number) =>
      `yield* state.write(${JSON.stringify(key)},{...${JSON.stringify(value)},generation:${generation}})`
    const seeded = await child(
      root,
      `for(let i=0;i<3;i++)yield* state.reserve(${JSON.stringify(scope)},${JSON.stringify(identity)});${write(old, 1)};${write(rebuilt, 3)}`,
    )
    expect(seeded.exit, seeded.stderr).toBe(0)
    const contenders = await Promise.all([
      child(root, write(old, 2)),
      child(root, write(rebuilt, 3)),
    ])
    for (const result of contenders) expect(result.exit, result.stderr).toBe(0)
    const sameGeneration = await child(root, write(old, 3))
    expect(sameGeneration.exit).not.toBe(0)
    expect(sameGeneration.stderr).toContain("different content")
    for (const field of ["scope", "library_id", "skill_id"] as const) {
      const foreign = await child(root, write({ ...rebuilt, [field]: "foreign-owner" }, 4))
      expect(foreign.exit).not.toBe(0)
      expect(foreign.stderr).toContain("cannot change its owner")
    }
    const current = await child(
      root,
      `console.log(JSON.stringify(yield* state.read(${JSON.stringify(key)})))`,
    )
    expect(current.exit, current.stderr).toBe(0)
    expect(JSON.parse(current.stdout)).toEqual({ ...rebuilt, generation: 3 })
  })
}, 30_000)

function currentPublicationProgram(root: string) {
  return `import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {ConfigProvider,Effect,FileSystem,Layer,Schema} from ${JSON.stringify(import.meta.resolve("effect"))};
import {HttpClient} from ${JSON.stringify(import.meta.resolve("effect/http"))};
import {Store,StoreLive} from ${JSON.stringify(core + "store.ts")};
import {Notion} from ${JSON.stringify(core + "notion.ts")};
import {SnapshotSchema,decode} from ${JSON.stringify(core + "model.ts")};
import {openSharedSnapshot} from ${JSON.stringify(core + "shared-snapshot.ts")};
import {clearCache} from ${JSON.stringify(core + "cache.ts")};
import {currentSnapshotFixture,currentLibrary,currentScope,currentSkillPage} from ${JSON.stringify(new URL("./shared-current-fixture.ts", import.meta.url).pathname)};
process.env.NTN_SKILLS_HOME=${JSON.stringify(root)};
process.env.NTN_SKILLS_CONFIG_HOME=${JSON.stringify(root + "-config")};
process.env.NTN_SKILLS_CACHE_HOME=${JSON.stringify(root + "-cache")};
const fixture=currentSnapshotFixture({fileCount:1});
fixture.bodies.set(currentSkillPage,'# Current main\\n[Child](https://app.notion.com/p/'+fixture.files[0].id.replaceAll('-','')+')\\n');
const seed=decode(SnapshotSchema,await fixture.open());
fixture.main.properties.Name.title[0].plain_text='Concurrent display';
fixture.main.properties.Description.rich_text[0].plain_text='New current directory label.';
fixture.main.properties.Description.rich_text[0].text.content='New current directory label.';
const renamed=decode(SnapshotSchema,await fixture.open());
const api=await fixture.run(Notion),http=await fixture.run(HttpClient.HttpClient);
const services=Layer.mergeAll(NodeServices.layer,Layer.succeed(Notion,api),Layer.succeed(HttpClient.HttpClient,http),StoreLive.pipe(Layer.provideMerge(NodeServices.layer)));
Effect.runPromise(Effect.gen(function*(){
 const store=yield* Store,fs=yield* FileSystem.FileSystem,key='snapshots/'+seed.snapshot_id+'.json';
 for(const file of seed.files)yield* store.writeBytes('objects/'+file.sha256,fixture.objects.get('objects/'+file.sha256));
 const alternate={...renamed,record:{...renamed.record,default_context:true},shared_acquisition:{...renamed.shared_acquisition,library:{...currentLibrary,files:{...currentLibrary.files,property_ids:{...currentLibrary.files.property_ids,'Reading status':'extra-display-property'}}}}};
 const contenders=yield* Effect.all([seed,alternate].map(value=>store.writeJson(key,value).pipe(Effect.result)),{concurrency:2});
 const first=yield* store.readJson(key,SnapshotSchema),physical=decode(SnapshotSchema,JSON.parse(yield* fs.readFileString(store.root+'/'+key)));
 const changed=[
  {...seed,files:seed.files.map((file,index)=>index===0?{...file,mode:'100755'}:file)},
  {...seed,file_bindings:seed.file_bindings.map((file,index)=>index===0?{...file,file_id:'different-current-file'}:file)},
  {...seed,record:{...seed.record,locator:{...seed.record.locator,page_id:'00000000-0000-4000-8000-000000000099'}}},
  {...seed,native_references:{...seed.native_references,entries:seed.native_references.entries.map((entry,index)=>index===0?{...entry,ref:entry.ref+'/different'}:entry)}},
 ];
 const conflicts=yield* Effect.forEach(changed,value=>store.writeJson(key,value).pipe(Effect.result));
 const open=()=>openSharedSnapshot({library:currentLibrary,target:currentSkillPage,scope:currentScope,startedAt:Date.now()});
 fixture.clearCalls();yield* open();const coldBodies=fixture.bodyCalls().length;
 fixture.clearCalls();yield* open();const warmBodies=fixture.bodyCalls().length;
 const nativeKeys=yield* store.listKeys('cache/current-native-bodies'),observation=yield* store.readJson(nativeKeys[0],Schema.Unknown);
 const final=yield* store.readJson(key,SnapshotSchema);
 const objectMode=(yield* fs.stat(store.root+'/objects/'+seed.files[0].sha256)).mode&0o777;
 const pending=(yield* fs.readDirectory(store.root+'/snapshots')).filter(name=>name.endsWith('.pending'));
 yield* clearCache(undefined,{all:true});
 const stale=yield* store.writeJson(nativeKeys[0],observation).pipe(Effect.result);
 console.log(JSON.stringify({
  contenders:contenders.map(result=>result._tag==='Success'?'ok':result.failure.code),
  sameContent:seed.snapshot_id===renamed.snapshot_id,nativeMetadataChanged:seed.native_references.index_sha256!==renamed.native_references.index_sha256,
  immutable:JSON.stringify(first)===JSON.stringify(final),physical:JSON.stringify(first)===JSON.stringify(physical),
  storedName:first.record.name,conflicts:conflicts.map(result=>result._tag==='Failure'?result.failure.code:'accepted'),
  coldBodies,warmBodies,nativeKeys,generation:observation.generation,objectMode,pending,
  afterClear:(yield* store.readJson(nativeKeys[0],Schema.Unknown))??null,
  stale:stale._tag==='Failure'?stale.failure.code:'accepted'
 }));
}).pipe(Effect.provide(services),Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())))).catch(error=>{console.error(String(error));process.exitCode=1})`
}

test("real Store current v5 publication tolerates concurrent display observations and preserves content, authority and cache fences", async () => {
  await isolated(async (root) => {
    const result = await runProgram(currentPublicationProgram(root))
    expect(result.exit, result.stderr).toBe(0)
    const value = JSON.parse(result.stdout)
    expect(value).toMatchObject({
      contenders: ["ok", "ok"],
      immutable: true,
      physical: true,
      sameContent: true,
      nativeMetadataChanged: true,
      conflicts: ["STATE_CORRUPT", "STATE_CORRUPT", "STATE_CORRUPT", "STATE_CORRUPT"],
      coldBodies: 2,
      warmBodies: 0,
      objectMode: 0o600,
      pending: [],
      afterClear: null,
      stale: "CACHE_INVALIDATED",
    })
    expect(["Current demo", "Concurrent display"]).toContain(value.storedName)
    expect(value.nativeKeys).toHaveLength(1)
    expect(value.nativeKeys[0]).toMatch(
      /^cache\/current-native-bodies\/[a-f0-9]{64}\/latest\.json$/u,
    )
    expect(value.generation).toBe(2)
  })
}, 30_000)

function partialSharedProgram(root: string, action: "directory" | "selected" | "all") {
  return `import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {ConfigProvider,Effect,FileSystem,Layer} from ${JSON.stringify(import.meta.resolve("effect"))};
import {SqlClient} from ${JSON.stringify(import.meta.resolve("effect/sql"))};
import {HttpClient,HttpClientResponse} from ${JSON.stringify(import.meta.resolve("effect/http"))};
import {Store,StoreLive} from ${JSON.stringify(core + "store.ts")};
import {Notion} from ${JSON.stringify(core + "notion.ts")};
import {targetSnapshot} from ${JSON.stringify(core + "snapshot.ts")};
import {sqliteState} from ${JSON.stringify(core + "sqlite-state.ts")};
import {currentSnapshotFixture,currentDigest as digest,currentLibrary as library,currentSkillPage as skillPage} from ${JSON.stringify(new URL("./shared-current-fixture.ts", import.meta.url).pathname)};
process.env.NTN_SKILLS_HOME=${JSON.stringify(root)};process.env.NTN_SKILLS_CONFIG_HOME=${JSON.stringify(root + "-config")};process.env.NTN_SKILLS_CACHE_HOME=${JSON.stringify(root + "-cache")};
const raw=Uint8Array.from({length:262147},(_,i)=>(i*73)%251),hash=digest(raw),requests=[];
const location='https://secure.notion-static.com/current/large.bin';
const client=HttpClient.make((request,url)=>Effect.sync(()=>{requests.push(url.toString());return HttpClientResponse.fromWeb(request,new Response(raw.slice(),{headers:{'content-length':String(raw.length)}}))}));
const fixture=currentSnapshotFixture({fileCount:3,httpClient:client});
await fixture.resource(2,'assets/large.bin',raw,'100755',{name:'large.bin',type:'file',file:{url:location,expiry_time:'2099-01-01T00:00:00.000Z'}});
const remote=await fixture.run(Notion);
const services=Layer.mergeAll(NodeServices.layer,Layer.succeed(Notion,remote),Layer.succeed(HttpClient.HttpClient,client),StoreLive.pipe(Layer.provideMerge(NodeServices.layer)));
Effect.runPromise(Effect.gen(function*(){
 const store=yield* Store;
 const access=${JSON.stringify(action === "directory" ? "manifest" : action === "selected" ? "target" : "all")};
 const snapshot=yield* targetSnapshot({selector:skillPage,...(access==='target'?{path:'assets/large.bin'}:{})},{database:library.skills.database_id,refresh:access==='manifest'},access);
 const object=yield* store.readBytes('objects/'+hash).pipe(Effect.result);
 const stats=yield* Effect.scoped(Effect.gen(function*(){const state=yield* sqliteState(store.root,yield* FileSystem.FileSystem);return yield* state.run(Effect.gen(function*(){const sql=yield* SqlClient.SqlClient;return {native_bodies:yield* sql\`SELECT count(*) AS count FROM shared_local_records WHERE key LIKE 'cache/current-native-bodies/%'\`,snapshots:yield* sql\`SELECT count(*) AS count FROM snapshots\`}}))}));
 console.log(JSON.stringify({snapshot_id:snapshot.snapshot_id,files:snapshot.files,materialization:snapshot.materialization,requests,raw_present:object._tag==='Success',raw_exact:object._tag==='Success'&&digest(object.success)===hash,writes:fixture.semanticWrites().length,stats}));
}).pipe(Effect.provide(services),Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())))).catch(error=>{console.error(String(error));process.exitCode=1})`
}

test("real Store publishes a complete raw directory before bytes and a fresh Node process acquires only its selected fixed object", async () => {
  await isolated(async (root) => {
    const directory = await runProgram(partialSharedProgram(root, "directory"))
    expect(directory.exit, directory.stderr).toBe(0)
    const first = JSON.parse(directory.stdout)
    expect(first.files).toHaveLength(4)
    expect(first.raw_present).toBe(false)
    expect(first.requests).toEqual([])
    expect(first.materialization).toMatchObject({
      manifest_complete: true,
      local_files_ready: false,
      loaded: false,
    })
    expect(first.stats).toEqual({ native_bodies: [{ count: 1 }], snapshots: [{ count: 1 }] })
    expect(first.writes).toBe(0)
    const selected = await runProgram(partialSharedProgram(root, "selected"))
    expect(selected.exit, selected.stderr).toBe(0)
    const second = JSON.parse(selected.stdout)
    expect(second.snapshot_id).toBe(first.snapshot_id)
    expect(second.raw_exact).toBe(true)
    expect(second.requests).toEqual(["https://secure.notion-static.com/current/large.bin"])
    expect(
      second.files.find((file: { path: string }) => file.path === "assets/large.bin").mode,
    ).toBe("100755")
    expect(second.writes).toBe(0)
    const reopened = await runProgram(partialSharedProgram(root, "all"))
    expect(reopened.exit, reopened.stderr).toBe(0)
    const full = JSON.parse(reopened.stdout)
    expect(full.snapshot_id).toBe(first.snapshot_id)
    expect(full.files).toEqual(first.files)
    expect(full.raw_exact).toBe(true)
    expect(full.requests).toEqual([])
    expect(full.stats).toEqual(first.stats)
    expect(full.writes).toBe(0)
    expect(full.materialization).toMatchObject({
      manifest_complete: true,
      local_files_ready: true,
      loaded: false,
    })
  })
}, 30_000)

test("competing real processes cannot give one current pending slot to different intents", async () => {
  await isolated(async (root) => {
    expect((await child(root, "console.log('initialized')")).exit).toBe(0)
    const contenders = await Promise.all(
      ["first", "second"].map((candidate) =>
        child(
          root,
          `yield* state.write(${JSON.stringify(pendingKey)},${JSON.stringify({ ...pendingPayload, intent: { ...pendingPayload.intent, operation_id: candidate } })});console.log(${JSON.stringify(candidate)})`,
        ),
      ),
    )
    expect(contenders.filter((result) => result.exit === 0)).toHaveLength(1)
    expect(contenders.filter((result) => result.exit !== 0)).toHaveLength(1)
    const winner = contenders.find((result) => result.exit === 0)?.stdout.trim()
    const saved = await child(
      root,
      `console.log(JSON.stringify(yield* state.read(${JSON.stringify(pendingKey)})))`,
    )
    expect(saved.exit, saved.stderr).toBe(0)
    expect(JSON.parse(saved.stdout)).toEqual({
      ...pendingPayload,
      intent: { ...pendingPayload.intent, operation_id: winner },
    })
  })
}, 30_000)

test("one current pending request survives abrupt process death and is readable without its creator", async () => {
  await isolated(async (root) => {
    const worker = start(
      processProgram(
        root,
        `yield* state.write(${JSON.stringify(pendingKey)},${JSON.stringify(pendingPayload)});console.log('current-pending-durable');yield* Effect.never`,
      ),
    )
    const closed = once(worker, "close")
    let stderr = ""
    worker.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
    })
    try {
      const ready = await Promise.race([
        once(worker.stdout, "data").then(([chunk]) => String(chunk)),
        closed.then(() => {
          throw new Error(`Dispatch process exited before its receipt committed: ${stderr}`)
        }),
      ])
      expect(ready).toContain("current-pending-durable")
    } finally {
      worker.kill("SIGKILL")
      await closed
    }
    const reopened = await child(
      root,
      `console.log(JSON.stringify({pending:yield* state.read(${JSON.stringify(pendingKey)}),keys:yield* state.list('operations/current-write-pending')}))`,
    )
    expect(reopened.exit, reopened.stderr).toBe(0)
    expect(JSON.parse(reopened.stdout)).toEqual({
      pending: pendingPayload,
      keys: [pendingKey],
    })
  })
}, 30_000)

test("a current Profile intent keeps its pending input until completion, then clears its slot for reuse", async () => {
  await isolated(async (root) => {
    const key = `operations/shared-profile-pending/${scope}/${"b".repeat(64)}/pending.json`
    const first = { version: 2, rules: { name: "First pending rules" } }
    const next = { version: 2, rules: { name: "Next current intent" } }
    const started = await child(
      root,
      `
      yield* state.write(${JSON.stringify(key)},${JSON.stringify(first)});
      const conflict = yield* state.write(${JSON.stringify(key)},${JSON.stringify(next)}).pipe(Effect.result);
      console.log(JSON.stringify({conflict:conflict._tag,current:yield* state.read(${JSON.stringify(key)})}));
    `,
    )
    expect(started.exit, started.stderr).toBe(0)
    expect(JSON.parse(started.stdout)).toEqual({ conflict: "Failure", current: first })
    const finished = await child(
      root,
      `
      yield* state.retire([${JSON.stringify(key)}]);
      yield* state.retire([${JSON.stringify(key)}]);
      yield* state.run(Effect.gen(function*(){const sql=yield* SqlClient.SqlClient;
        console.log(JSON.stringify(yield* sql\`SELECT key,payload,retired FROM shared_local_records\`));
      }));
    `,
    )
    expect(finished.exit, finished.stderr).toBe(0)
    expect(JSON.parse(finished.stdout)).toEqual([])
    const restarted = await child(
      root,
      `
      yield* state.write(${JSON.stringify(key)},${JSON.stringify(next)});
      console.log(JSON.stringify({current:yield* state.read(${JSON.stringify(key)}),active:yield* state.list('operations/shared-profile-pending')}));
    `,
    )
    expect(restarted.exit, restarted.stderr).toBe(0)
    expect(JSON.parse(restarted.stdout)).toEqual({ current: next, active: [key] })
  })
}, 30_000)

test("retired namespaces, traversal and malformed current keys cannot become generic SQLite records", async () => {
  await isolated(async (root) => {
    const invalid = [
      `cache/shared-anything/${scope}.json`,
      `operations/current-anything/${scope}.json`,
      `operations/current-write-pending/${scope}/../other.json`,
      `operations/current-write-pending/${scope}/other.json`,
      `operations/current-write-pending/${"A".repeat(64)}/pending.json`,
      `cache/current-native-bodies/${scope}/../latest.json`,
      `cache/current-native-bodies/foreign/latest.json`,
      `cache/shared-derived-graphs/${scope}/${"d".repeat(64)}/latest.json`,
      `cache/shared-page-identities/${scope}/page.json`,
      `cache/shared-github-blobs/${"c".repeat(40)}`,
      `content-restrictions/other/${scope}.json`,
      `content-restrictions/local/${scope}.json/extra`,
      // Previously valid historical addresses must not reopen retired protocols.
      `cache/shared-file-observations/${scope}/00000000000000000001.json`,
      `cache/shared-history-manifests/${scope}/s_${"c".repeat(64)}.json`,
      `operations/shared-observation-pending/${scope}/${"e".repeat(64)}.json`,
      `operations/shared-snapshot-history/${scope}/snapshot-${"f".repeat(64)}.json`,
      `operations/shared-native-create/${scope}/skill-create-${"8".repeat(64)}.json`,
      `operations/owned-page-archive/${scope}/skill-create-${"8".repeat(64)}/00000000-0000-4000-8000-000000000001/00000000000000000000.json`,
    ]
    const result = await child(
      root,
      `const results=[];for(const key of ${JSON.stringify(invalid)}){const written=yield* state.write(key,{invalid:true}).pipe(Effect.result);const read=yield* state.read(key).pipe(Effect.result);results.push({write:written._tag,read:read._tag});}console.log(JSON.stringify({results,cache:yield* state.list('cache'),dispatch:yield* state.list('operations')}))`,
    )
    expect(result.exit, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      results: invalid.map(() => ({ write: "Failure", read: "Failure" })),
      cache: [],
      dispatch: [],
    })
  })
}, 30_000)

test("local-content restrictions survive restarts and cache retirement, and cannot be cleared or changed", async () => {
  await isolated(async (root) => {
    const written = await child(
      root,
      `yield* state.write(${JSON.stringify(restrictionKey)},${JSON.stringify(restriction)});yield* state.write(${JSON.stringify(`cache/shared-github-blobs/${"c".repeat(40)}.json`)},{version:1});yield* state.retire(yield* state.list('cache'));console.log('retained')`,
    )
    expect(written.exit, written.stderr).toBe(0)
    const reopened = await child(
      root,
      `yield* state.write(${JSON.stringify(restrictionKey)},${JSON.stringify({ reason: "local_resource", sha256: restrictedHash, version: 1 })});const removed=yield* state.retire([${JSON.stringify(restrictionKey)}]).pipe(Effect.result);const changed=yield* state.write(${JSON.stringify(restrictionKey)},{...${JSON.stringify(restriction)},reason:'public'}).pipe(Effect.result);console.log(JSON.stringify({record:yield* state.read(${JSON.stringify(restrictionKey)}),keys:yield* state.list('content-restrictions'),cache:yield* state.list('cache'),removed:removed._tag,changed:changed._tag}));`,
    )
    expect(reopened.exit, reopened.stderr).toBe(0)
    expect(JSON.parse(reopened.stdout)).toEqual({
      record: restriction,
      keys: [restrictionKey],
      cache: [],
      removed: "Failure",
      changed: "Failure",
    })
  })
}, 30_000)

test("local-content restriction schema and persisted corruption fail closed without replacing the restriction", async () => {
  await isolated(async (root) => {
    const invalid = [
      null,
      {},
      { ...restriction, sha256: "8".repeat(64) },
      { ...restriction, absolute_root: "/private" },
    ]
    const rejected = await child(
      root,
      `const outcomes=[];for(const value of ${JSON.stringify(invalid)}) outcomes.push((yield* state.write(${JSON.stringify(restrictionKey)},value).pipe(Effect.result))._tag);console.log(JSON.stringify({outcomes,keys:yield* state.list('content-restrictions')}));`,
    )
    expect(rejected.exit, rejected.stderr).toBe(0)
    expect(JSON.parse(rejected.stdout)).toEqual({
      outcomes: invalid.map(() => "Failure"),
      keys: [],
    })
    const corrupt = await child(
      root,
      `yield* state.run(Effect.gen(function*(){const sql=yield* SqlClient.SqlClient;yield* sql\`INSERT INTO local_content_restrictions(sha256,payload) VALUES(\${${JSON.stringify(restrictedHash)}},\${${JSON.stringify(JSON.stringify({ ...restriction, reason: "public" }))}})\`;}));const read=yield* state.read(${JSON.stringify(restrictionKey)}).pipe(Effect.result);const write=yield* state.write(${JSON.stringify(restrictionKey)},${JSON.stringify(restriction)}).pipe(Effect.result);console.log(JSON.stringify({read:read._tag,write:write._tag}));`,
    )
    expect(corrupt.exit, corrupt.stderr).toBe(0)
    expect(JSON.parse(corrupt.stdout)).toEqual({ read: "Failure", write: "Failure" })
  })
}, 30_000)
