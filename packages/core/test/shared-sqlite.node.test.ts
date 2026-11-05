import { expect, test } from "@effect/vitest"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { trashPath } from "../src/local-locks.ts"

const core = new URL("../src/", import.meta.url).pathname
const scope = "a".repeat(64)
const keys = {
  observations: `cache/shared-file-observations/${"b".repeat(64)}/00000000000000000001.json`,
  page: `cache/shared-page-identities/${scope}/00000000-0000-4000-8000-000000000001.json`,
  github: `cache/shared-github-blobs/${"c".repeat(40)}.json`,
  retainedManifest: `cache/shared-history-manifests/${scope}/s_${"c".repeat(64)}.json`,
  currentTree: `cache/shared-current-tree-validation/${scope}/s_${"d".repeat(64)}.json`,
  derivedGraph: `cache/shared-derived-graphs/${scope}/${"d".repeat(64)}/${"e".repeat(64)}.json`,
  observationPending: `operations/shared-observation-pending/${"d".repeat(64)}/${"e".repeat(64)}.json`,
  historyPending: `operations/shared-snapshot-history/${scope}/snapshot-${"f".repeat(64)}.json`,
  graphPending: `operations/shared-graph-history/${scope}/graph-${"f".repeat(64)}/plan.json`,
  graphComplete: `operations/shared-graph-history/${scope}/graph-${"f".repeat(64)}/complete.json`,
  bodyCurrentAcceptance: `operations/shared-body-current-acceptance/${scope}/accept-current-${"f".repeat(64)}/plan.json`,
  sourceReceipt: `operations/shared-sources/${scope}/source-receipt-${"b".repeat(64)}.json`,
  sourceSelection: `operations/shared-sources/${scope}/source-selection-${"c".repeat(64)}.json`,
  sourceDefinition: `operations/shared-sources/${scope}/source-op-${"a".repeat(64)}.json`,
  sourceRegistration: `operations/shared-source-registration/${scope}/source-plan-${"7".repeat(64)}.json`,
  nativeCreate: `operations/shared-native-create/${scope}/skill-create-${"8".repeat(64)}.json`,
  nativeOwnership: `operations/shared-native-create-owned/${scope}/skill-create-${"8".repeat(64)}.json`,
  relationSchema: `operations/shared-relation-schema/${scope}/relations-schema-${"8".repeat(64)}-schema.json`,
  relationDescriptor: `operations/shared-relation-schema/${scope}/relations-schema-${"8".repeat(64)}-descriptor.json`,
  nativeArchive: `operations/owned-page-archive/${scope}/skill-create-${"8".repeat(64)}/00000000-0000-4000-8000-000000000001/00000000000000000000.json`,
  legacyArchive: `operations/owned-page-archive/${scope}/p_owned-archive-test/00000000-0000-4000-8000-000000000001/00000000000000000000.json`,
  nativeRecovery: `operations/shared-native-recovery/${scope}/skill-create-${"8".repeat(64)}.json`,
  recoveryResponse: `operations/shared-native-recovery-responses/create-recovery-${"9".repeat(64)}/${"e".repeat(64)}.json`,
  nativeContinuation: `operations/shared-native-continuation/${scope}/skill-create-${"8".repeat(64)}.json`,
  continuationResponse: `operations/shared-native-recovery-responses/create-continuation-${"9".repeat(64)}/${"e".repeat(64)}.json`,
  profilePending: `operations/shared-profile-pending/${scope}/${"b".repeat(64)}/profile-${"c".repeat(64)}.json`,
}
const pendingPayload = {
  version: 1,
  scope,
  operation_id: "original-operation",
  plan: { body: "original bytes\r\n", downloaded_at: 1234 },
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

function publicArchiveProgram(root: string, initiallyArchived: boolean, loseResponse = false) {
  return `import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {ConfigProvider,Effect,Layer} from ${JSON.stringify(import.meta.resolve("effect"))};
import {Store,StoreLive} from ${JSON.stringify(core + "store.ts")};
import {Notion} from ${JSON.stringify(core + "notion.ts")};
import {authScope} from ${JSON.stringify(core + "catalog.ts")};
import {archiveOwnedPage} from ${JSON.stringify(core + "owned-page-archive.ts")};
import {fail} from ${JSON.stringify(core + "model.ts")};
process.env.NTN_SKILLS_HOME=${JSON.stringify(root)};
process.env.NTN_SKILLS_CONFIG_HOME=${JSON.stringify(root + "-config")};
process.env.NTN_SKILLS_CACHE_HOME=${JSON.stringify(root + "-cache")};
const page='00000000-0000-4000-8000-000000000001',operation='skill-create-'+'8'.repeat(64);
let archived=${initiallyArchived},patches=0;
const api=Layer.succeed(Notion,{version:Effect.succeed('2026-03-11'),credentialIdentity:Effect.succeed('controlled-sqlite-archive'),request:(path,body,options)=>Effect.gen(function*(){
  if(path==='v1/users/me')return {object:'user',id:'controlled-sqlite-user'};
  if(path!=='v1/pages/'+page)return yield* Effect.fail(fail('NOT_FOUND','Unexpected controlled path'));
  if(options?.method==='PATCH'){patches++;if(JSON.stringify(body)!=='{"in_trash":true}')throw new Error('Unexpected archive body');if(${loseResponse})return yield* Effect.fail(fail('WRITE_OUTCOME_UNKNOWN','Controlled lost response',{phase:'outcome_unknown'}));archived=true;}
  return {id:page,in_trash:archived};
})});
Effect.runPromise(Effect.gen(function*(){
  const store=yield* Store,scope=yield* authScope;
  yield* store.writeJson('operations/shared-native-create-owned/'+scope+'/'+operation+'.json',{version:1,scope,operation_id:operation,library_id:'library-owned',skill_id:'skill-owned',skill_page_id:page,coverage:'created_native_content_pages',created_page_ids:[page],created_pages:[{page_id:page,kind:'skill',database_id:page,data_source_id:page,file_id:'file-main'}]});
  const result=yield* archiveOwnedPage(page,operation).pipe(Effect.result);
  console.log(JSON.stringify({patches,result:result._tag==='Success'?result.success:{code:result.failure.code},events:(yield* store.listKeys('operations/owned-page-archive')).length}));
}).pipe(Effect.provide(Layer.mergeAll(api,StoreLive.pipe(Layer.provideMerge(NodeServices.layer)))),Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())))).catch(error=>{console.error(String(error));process.exitCode=1})`
}

test("public owned archive persists each immutable transition and reopens without another PATCH", async () => {
  await isolated(async (root) => {
    const first = await runProgram(publicArchiveProgram(root, false))
    expect(first.exit, first.stderr).toBe(0)
    expect(JSON.parse(first.stdout)).toMatchObject({
      patches: 1,
      result: { archived: true, verified: true, reused: false },
      events: 3,
    })
    const reopened = await runProgram(publicArchiveProgram(root, true))
    expect(reopened.exit, reopened.stderr).toBe(0)
    expect(JSON.parse(reopened.stdout)).toMatchObject({
      patches: 0,
      result: { archived: true, verified: true, reused: true },
      events: 3,
    })
  })
}, 30_000)

test("a lost archive response stays fenced across real SQLite restarts until readback confirms it", async () => {
  await isolated(async (root) => {
    for (const [index, confirmed] of [false, false, true].entries()) {
      const result = await runProgram(publicArchiveProgram(root, confirmed, true))
      expect(result.exit, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        patches: index === 0 ? 1 : 0,
        result: confirmed
          ? { archived: true, verified: true, reused: true }
          : { code: "ARCHIVE_OUTCOME_UNKNOWN" },
        events: confirmed ? 3 : 2,
      })
    }
  })
}, 30_000)

async function isolated(action: (root: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "ntn-shared-sqlite-"))
  try {
    await action(join(directory, "state"))
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
  }
}

function currentTreeProgram(root: string, publish: boolean) {
  const files = [
    { path: "SKILL.md", text: "# Receipt\n[Guide](references/guide.md)\n" },
    { path: "references/guide.md", text: "Guide\n" },
  ]
  return `import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {ConfigProvider,Effect,Layer,Schema} from ${JSON.stringify(import.meta.resolve("effect"))};
import {Store,StoreLive,sha256} from ${JSON.stringify(core + "store.ts")};
import {Notion} from ${JSON.stringify(core + "notion.ts")};
import {SnapshotSchema} from ${JSON.stringify(core + "model.ts")};
import {cachedRemoteObservation,clearCache,publishSnapshotObservation,validateCachedSharedCurrentTree} from ${JSON.stringify(core + "cache.ts")};
process.env.NTN_SKILLS_HOME=${JSON.stringify(root)};
process.env.NTN_SKILLS_CONFIG_HOME=${JSON.stringify(root + "-config")};
process.env.NTN_SKILLS_CACHE_HOME=${JSON.stringify(root + "-cache")};
const api=Layer.succeed(Notion,{version:Effect.succeed('controlled'),credentialIdentity:Effect.succeed('receipt-test'),request:()=>Effect.die(new Error('Unexpected network'))});
Effect.runPromise(Effect.gen(function*(){
  const store=yield* Store,scope=${JSON.stringify(scope)},record={id:'shared_skill:receipt-library:receipt-skill',kind:'skill',locator:{type:'shared_skill',page_id:'00000000-0000-4000-8000-000000000001',database_id:'00000000-0000-4000-8000-000000000002',data_source_id:'00000000-0000-4000-8000-000000000003',library_id:'receipt-library',skill_id:'receipt-skill'},name:'Receipt Skill',alias:'receipt-skill',description:'Controlled complete tree',default_context:false,enabled:true,entrypoint:'SKILL.md',ref:'skill://shared_skill%3Areceipt-library%3Areceipt-skill/SKILL.md'};
  const version=yield* sha256('current-tree-receipt-sqlite'),id='s_'+(yield* sha256(JSON.stringify([scope,record.id,version]))),key='cache/shared-current-tree-validation/'+scope+'/'+id+'.json';
  let reads=[];
  const tracked={...store,readBytes:key=>Effect.suspend(()=>{reads.push(key);return store.readBytes(key);})};
  if(${publish}) {
    const files=[];for(const file of ${JSON.stringify(files)}){const bytes=new TextEncoder().encode(file.text),hash=yield* sha256(bytes);yield* store.writeBytes('objects/'+hash,bytes);files.push({path:file.path,sha256:hash,bytes:bytes.length});}
    const snapshot={snapshot_id:id,scope,record,entrypoint:'SKILL.md',version_id:version,created_at:123,files};
    yield* store.writeJson('snapshots/'+id+'.json',snapshot);
    const generation=yield* store.reserveCacheGeneration(scope,record.id);
    yield* publishSnapshotObservation(snapshot,123,generation,{sharedBodyValidUntil:Date.now()+3_600_000}).pipe(Effect.provideService(Store,tracked));
    console.log(JSON.stringify({receipt:yield* store.readJson(key,Schema.Unknown),reads:reads.length}));
    return;
  }
  const receipt=yield* store.readJson(key,Schema.Unknown),snapshot=yield* store.readJson('snapshots/'+id+'.json',SnapshotSchema),latest=yield* store.listKeys('cache/latest/'+scope+'/'+record.id),before=yield* Effect.forEach(latest,key=>store.readJson(key,Schema.Unknown));
  const read=()=>cachedRemoteObservation(record.id,scope,{access:'manifest'}).pipe(Effect.provideService(Store,tracked));
  yield* read();const warmReads=reads.length;reads=[];
  yield* store.writeJson(key,{...receipt,materialization_version:'old-reference-checker'});
  yield* read();const mismatchReads=reads.length;reads=[];
  const repaired=yield* store.readJson(key,Schema.Unknown);
  yield* store.retireKeys([key]);const retired=(yield* store.readJson(key,Schema.Unknown))??null;
  yield* read();const retiredReads=reads.length;reads=[];
  const after=yield* Effect.forEach(latest,key=>store.readJson(key,Schema.Unknown)),rebuilt=yield* store.readJson(key,Schema.Unknown);
  const cleared=yield* clearCache(undefined,{all:true});
  yield* validateCachedSharedCurrentTree(snapshot);
  const fenced=yield* publishSnapshotObservation(snapshot,123,before[0].generation,{sharedBodyValidUntil:before[0].shared_body_valid_until}).pipe(Effect.result);
  console.log(JSON.stringify({warmReads,mismatchReads,retiredReads,retired,repaired,rebuilt,before,after,clearIncluded:cleared.entries.includes(key),fenced:fenced._tag==='Failure'?fenced.failure.code:null,currentAfterClear:(yield* read())??null}));
}).pipe(Effect.provide(Layer.mergeAll(api,StoreLive.pipe(Layer.provideMerge(NodeServices.layer)))),Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())))).catch(error=>{console.error(String(error));process.exitCode=1})`
}

test("real Store publishes, repairs and retires current-tree proofs without renewing observations", async () => {
  await isolated(async (root) => {
    const published = await runProgram(currentTreeProgram(root, true))
    expect(published.exit, published.stderr).toBe(0)
    const initial = JSON.parse(published.stdout)
    expect(initial.reads).toBe(2)
    expect(initial.receipt).toMatchObject({ version: 1, scope })
    const reopened = await runProgram(currentTreeProgram(root, false))
    expect(reopened.exit, reopened.stderr).toBe(0)
    const result = JSON.parse(reopened.stdout)
    expect(result).toMatchObject({
      warmReads: 0,
      mismatchReads: 2,
      retiredReads: 2,
      retired: null,
      repaired: initial.receipt,
      rebuilt: initial.receipt,
      clearIncluded: true,
      fenced: "CACHE_INVALIDATED",
      currentAfterClear: null,
    })
    expect(result.after).toEqual(result.before)
  })
}, 30_000)

test("shared cache and typed dispatch addresses persist across real Node restarts", async () => {
  await isolated(async (root) => {
    const entries = Object.values(keys).map((key, index) => ({
      key,
      payload: { version: 1, sequence: index, frozen: "original" },
    }))
    const writer = await child(
      root,
      `const before=[];for(const entry of ${JSON.stringify(entries)}) before.push((yield* state.read(entry.key))??null);const empty=yield* state.list('operations');for(const entry of ${JSON.stringify(entries)}) yield* state.write(entry.key,entry.payload);yield* state.write('database-init/legacy/0.json',{legacy:true});console.log(JSON.stringify({before,empty}))`,
    )
    expect(writer.exit, writer.stderr).toBe(0)
    expect(JSON.parse(writer.stdout)).toEqual({ before: entries.map(() => null), empty: [] })
    const reader = await child(
      root,
      `const values=[];for(const entry of ${JSON.stringify(entries)}) values.push(yield* state.read(entry.key));console.log(JSON.stringify({values,cache:yield* state.list('cache'),dispatch:yield* state.list('operations'),legacy:yield* state.read('database-init/legacy/0.json')}));`,
    )
    expect(reader.exit, reader.stderr).toBe(0)
    expect(JSON.parse(reader.stdout)).toEqual({
      values: entries.map((entry) => entry.payload),
      cache: [
        keys.observations,
        keys.page,
        keys.github,
        keys.retainedManifest,
        keys.currentTree,
        keys.derivedGraph,
      ].sort(),
      dispatch: [
        keys.observationPending,
        keys.historyPending,
        keys.graphPending,
        keys.graphComplete,
        keys.bodyCurrentAcceptance,
        keys.profilePending,
        keys.sourceDefinition,
        keys.sourceReceipt,
        keys.sourceSelection,
        keys.sourceRegistration,
        keys.nativeCreate,
        keys.nativeOwnership,
        keys.relationSchema,
        keys.relationDescriptor,
        keys.nativeArchive,
        keys.legacyArchive,
        keys.nativeRecovery,
        keys.recoveryResponse,
        keys.nativeContinuation,
        keys.continuationResponse,
      ].sort(),
      legacy: { legacy: true },
    })
    const schema = await child(
      root,
      `yield* state.run(Effect.gen(function*(){const sql=yield* SqlClient.SqlClient;console.log(JSON.stringify(yield* sql\`SELECT category,retired,count(*) AS count FROM shared_local_records GROUP BY category,retired ORDER BY category\`))}))`,
    )
    expect(schema.exit, schema.stderr).toBe(0)
    expect(JSON.parse(schema.stdout)).toEqual([
      { category: "cache", retired: 0, count: 6 },
      { category: "dispatch", retired: 0, count: Object.keys(keys).length - 6 },
    ])
  })
}, 30_000)

test("a frozen key is idempotent across processes and rejects different content without overwriting", async () => {
  await isolated(async (root) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await child(
        root,
        `yield* state.write(${JSON.stringify(keys.observationPending)},${JSON.stringify(pendingPayload)})`,
      )
      expect(result.exit, result.stderr).toBe(0)
    }
    const conflicting = await child(
      root,
      `yield* state.write(${JSON.stringify(keys.observationPending)},${JSON.stringify({ ...pendingPayload, operation_id: "replacement-operation" })})`,
    )
    expect(conflicting.exit).not.toBe(0)
    expect(conflicting.stderr).toContain("cannot be overwritten")
    const retained = await child(
      root,
      `console.log(JSON.stringify(yield* state.read(${JSON.stringify(keys.observationPending)})));yield* state.run(Effect.gen(function*(){const sql=yield* SqlClient.SqlClient;console.log(JSON.stringify(yield* sql\`SELECT count(*) AS count FROM shared_local_records\`))}))`,
    )
    expect(retained.exit, retained.stderr).toBe(0)
    const output = retained.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(output).toEqual([pendingPayload, [{ count: 1 }]])
  })
}, 30_000)

test("competing real processes cannot replace one dispatch key with two different plans", async () => {
  await isolated(async (root) => {
    expect((await child(root, "console.log('initialized')")).exit).toBe(0)
    const contenders = await Promise.all(
      ["first", "second"].map((candidate) =>
        child(
          root,
          `yield* state.write(${JSON.stringify(keys.historyPending)},${JSON.stringify({ ...pendingPayload, candidate })});console.log(${JSON.stringify(candidate)})`,
        ),
      ),
    )
    expect(contenders.filter((result) => result.exit === 0)).toHaveLength(1)
    expect(contenders.filter((result) => result.exit !== 0)).toHaveLength(1)
    const winner = contenders.find((result) => result.exit === 0)?.stdout.trim()
    const saved = await child(
      root,
      `console.log(JSON.stringify(yield* state.read(${JSON.stringify(keys.historyPending)})))`,
    )
    expect(saved.exit, saved.stderr).toBe(0)
    expect(JSON.parse(saved.stdout)).toEqual({ ...pendingPayload, candidate: winner })
  })
}, 30_000)

test("a committed pending receipt survives abrupt process death and is readable without its creator", async () => {
  await isolated(async (root) => {
    const worker = start(
      processProgram(
        root,
        `yield* state.write(${JSON.stringify(keys.observationPending)},${JSON.stringify(pendingPayload)});console.log('dispatch-durable');yield* Effect.never`,
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
      expect(ready).toContain("dispatch-durable")
    } finally {
      worker.kill("SIGKILL")
      await closed
    }
    const reopened = await child(
      root,
      `console.log(JSON.stringify({pending:yield* state.read(${JSON.stringify(keys.observationPending)}),keys:yield* state.list('operations/shared-observation-pending')}))`,
    )
    expect(reopened.exit, reopened.stderr).toBe(0)
    expect(JSON.parse(reopened.stdout)).toEqual({
      pending: pendingPayload,
      keys: [keys.observationPending],
    })
  })
}, 30_000)

test("dispatch retirement hides active work but retains its exact payload and never silently reactivates it", async () => {
  await isolated(async (root) => {
    const dispatched = [
      keys.observationPending,
      keys.historyPending,
      keys.profilePending,
      keys.sourceRegistration,
      keys.nativeCreate,
      keys.nativeRecovery,
      keys.recoveryResponse,
      keys.nativeContinuation,
      keys.continuationResponse,
    ]
    const retired = await child(
      root,
      `for(const key of ${JSON.stringify(dispatched)}) yield* state.write(key,${JSON.stringify(pendingPayload)});yield* state.retire(${JSON.stringify(dispatched)});yield* state.retire(${JSON.stringify(dispatched)});console.log(JSON.stringify({active:yield* state.list('operations'),read:yield* state.read(${JSON.stringify(keys.observationPending)})}));yield* state.run(Effect.gen(function*(){const sql=yield* SqlClient.SqlClient;console.log(JSON.stringify(yield* sql\`SELECT key,payload,retired FROM shared_local_records ORDER BY key\`))}))`,
    )
    expect(retired.exit, retired.stderr).toBe(0)
    const [active, rows] = retired.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(active).toEqual({ active: [] })
    expect(rows).toEqual(
      dispatched
        .sort()
        .map((key) => ({ key, payload: JSON.stringify(pendingPayload), retired: 1 })),
    )
    const reopened = await child(
      root,
      `yield* state.write(${JSON.stringify(keys.observationPending)},${JSON.stringify(pendingPayload)})`,
    )
    expect(reopened.exit).not.toBe(0)
    expect(reopened.stderr).toContain("retired shared dispatch receipt")
    const conflict = await child(
      root,
      `yield* state.write(${JSON.stringify(keys.observationPending)},{version:2})`,
    )
    expect(conflict.exit).not.toBe(0)
    expect(conflict.stderr).toContain("cannot be overwritten")
  })
}, 30_000)

test("completed recovery retires both journals across restarts and retains the captured response", async () => {
  await isolated(async (root) => {
    const journals = [keys.nativeCreate, keys.nativeRecovery]
    const response = { version: 1, kind: "original_mutation_response", response: { id: "page" } }
    const written = await child(
      root,
      `for(const key of ${JSON.stringify(journals)}) yield* state.write(key,${JSON.stringify(pendingPayload)});yield* state.write(${JSON.stringify(keys.recoveryResponse)},${JSON.stringify(response)})`,
    )
    expect(written.exit, written.stderr).toBe(0)
    const retired = await child(
      root,
      `yield* state.retire(${JSON.stringify(journals)});yield* state.retire(${JSON.stringify(journals)})`,
    )
    expect(retired.exit, retired.stderr).toBe(0)
    const reopened = await child(
      root,
      `const reads=[];for(const key of ${JSON.stringify(journals)}) reads.push((yield* state.read(key))??null);const replay=yield* state.write(${JSON.stringify(keys.nativeRecovery)},${JSON.stringify(pendingPayload)}).pipe(Effect.result);const replaced=yield* state.write(${JSON.stringify(keys.recoveryResponse)},{replacement:true}).pipe(Effect.result);console.log(JSON.stringify({reads,active:yield* state.list('operations'),response:yield* state.read(${JSON.stringify(keys.recoveryResponse)}),replay:replay._tag,replaced:replaced._tag}));yield* state.run(Effect.gen(function*(){const sql=yield* SqlClient.SqlClient;console.log(JSON.stringify(yield* sql\`SELECT key,payload,retired FROM shared_local_records ORDER BY key\`))}))`,
    )
    expect(reopened.exit, reopened.stderr).toBe(0)
    const [active, rows] = reopened.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(active).toEqual({
      reads: [null, null],
      active: [keys.recoveryResponse],
      response,
      replay: "Failure",
      replaced: "Failure",
    })
    expect(rows).toEqual(
      [
        ...journals.map((key) => ({ key, payload: JSON.stringify(pendingPayload), retired: 1 })),
        { key: keys.recoveryResponse, payload: JSON.stringify(response), retired: 0 },
      ].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)),
    )
  })
}, 30_000)

test("public cache clear removes shared derived lookups and preserves unfinished dispatch domains", async () => {
  await isolated(async (root) => {
    const all = Object.values(keys)
    const program = `import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {ConfigProvider,Effect,Layer,Schema} from ${JSON.stringify(import.meta.resolve("effect"))};
import {Store,StoreLive} from ${JSON.stringify(core + "store.ts")};
import {clearCache} from ${JSON.stringify(core + "cache.ts")};
process.env.NTN_SKILLS_HOME=${JSON.stringify(root)};
process.env.NTN_SKILLS_CONFIG_HOME=${JSON.stringify(root + "-config")};
process.env.NTN_SKILLS_CACHE_HOME=${JSON.stringify(root + "-cache")};
Effect.runPromise(Effect.gen(function*(){const store=yield* Store;for(const key of ${JSON.stringify(all)}) yield* store.writeJson(key,${JSON.stringify(pendingPayload)});const result=yield* clearCache(undefined,{all:true});console.log(JSON.stringify({entries:result.entries,cache:yield* store.listKeys('cache'),dispatch:yield* store.listKeys('operations'),receipt:yield* store.readJson(${JSON.stringify(keys.observationPending)},Schema.Unknown)}))}).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(NodeServices.layer))),Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())))).catch(error=>{console.error(String(error));process.exitCode=1})`
    const cleared = await runProgram(program)
    expect(cleared.exit, cleared.stderr).toBe(0)
    const result = JSON.parse(cleared.stdout)
    expect(result.entries.sort()).toEqual(
      [
        keys.observations,
        keys.page,
        keys.github,
        keys.retainedManifest,
        keys.currentTree,
        keys.derivedGraph,
      ].sort(),
    )
    expect(result.cache).toEqual([])
    expect(result.dispatch).toEqual(
      [
        keys.observationPending,
        keys.historyPending,
        keys.graphPending,
        keys.graphComplete,
        keys.bodyCurrentAcceptance,
        keys.profilePending,
        keys.sourceDefinition,
        keys.sourceReceipt,
        keys.sourceSelection,
        keys.sourceRegistration,
        keys.nativeCreate,
        keys.nativeOwnership,
        keys.relationSchema,
        keys.relationDescriptor,
        keys.nativeArchive,
        keys.legacyArchive,
        keys.nativeRecovery,
        keys.recoveryResponse,
        keys.nativeContinuation,
        keys.continuationResponse,
      ].sort(),
    )
    expect(result.receipt).toEqual(pendingPayload)
    const rebuilt = await child(
      root,
      `yield* state.write(${JSON.stringify(keys.github)},${JSON.stringify(pendingPayload)});console.log(JSON.stringify(yield* state.read(${JSON.stringify(keys.github)})))`,
    )
    expect(rebuilt.exit, rebuilt.stderr).toBe(0)
    expect(JSON.parse(rebuilt.stdout)).toEqual(pendingPayload)
    const changed = await child(
      root,
      `yield* state.write(${JSON.stringify(keys.page)},{replacement:true})`,
    )
    expect(changed.exit).not.toBe(0)
    expect(changed.stderr).toContain("cannot be overwritten")
  })
}, 30_000)

test("real SQLite acceptance dispatch preserves nested original before/candidate objects across restart and GC", async () => {
  await isolated(async (root) => {
    const files = ["before evidence", "candidate evidence", "unreferenced bytes"].map((value) => ({
      sha256: createHash("sha256").update(value).digest("hex"),
      bytes: [...new TextEncoder().encode(value)],
    }))
    const payload = {
      version: 1,
      scope,
      original: {
        before: { body_sha256: files[0]?.sha256 },
        candidate: { body_sha256: files[1]?.sha256 },
      },
      decision: {
        kind: "body_write_current_acceptance",
        original_write_outcome: "unknown",
        decision: "accepted_current",
      },
    }
    const program = (
      write: boolean,
    ) => `import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {ConfigProvider,Effect,Layer,Schema} from ${JSON.stringify(import.meta.resolve("effect"))};
import {Store,StoreLive} from ${JSON.stringify(core + "store.ts")};
import {garbageCollectCache} from ${JSON.stringify(core + "cache.ts")};
process.env.NTN_SKILLS_HOME=${JSON.stringify(root)};
process.env.NTN_SKILLS_CONFIG_HOME=${JSON.stringify(root + "-config")};
process.env.NTN_SKILLS_CACHE_HOME=${JSON.stringify(root + "-cache")};
Effect.runPromise(Effect.gen(function*(){const store=yield* Store;
${write ? `for(const file of ${JSON.stringify(files)})yield* store.writeBytes('objects/'+file.sha256,new Uint8Array(file.bytes));yield* store.writeJson(${JSON.stringify(keys.bodyCurrentAcceptance)},${JSON.stringify(payload)});` : ""}
console.log(JSON.stringify({dispatch:yield* store.readJson(${JSON.stringify(keys.bodyCurrentAcceptance)},Schema.Unknown),gc:yield* garbageCollectCache({dryRun:true})}));
}).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(NodeServices.layer))),Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())))).catch(error=>{console.error(String(error));process.exitCode=1})`
    // Every invocation opens its own SQLite connection with the same durable evidence.
    for (const write of [true, false]) {
      const result = await runProgram(program(write))
      expect(result.exit, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        dispatch: payload,
        gc: { unreachable_snapshots: [], unreachable_objects: [files[2]?.sha256] },
      })
    }
  })
}, 30_000)

test("unregistered shared namespaces, traversal and malformed known keys cannot become generic SQLite records", async () => {
  await isolated(async (root) => {
    const invalid = [
      `cache/shared-anything/${scope}.json`,
      `operations/shared-anything/${scope}.json`,
      `operations/shared-observation-pending/${scope}/../other.json`,
      `operations/shared-snapshot-history/${scope}/latest.json`,
      `cache/shared-history-manifests/${scope}/latest.json`,
      `cache/shared-current-tree-validation/${scope}/latest.json`,
      `cache/shared-current-tree-validation/${scope}/../s_${"d".repeat(64)}.json`,
      `cache/shared-current-tree-validation/foreign/s_${"d".repeat(64)}.json`,
      `cache/shared-derived-graphs/${scope}/${"d".repeat(64)}/latest.json`,
      `operations/shared-graph-history/${scope}/graph-${"f".repeat(64)}/replacement.json`,
      `operations/shared-body-current-acceptance/${scope}/accept-current-${"f".repeat(64)}/complete.json`,
      `cache/shared-page-identities/${scope}/page.json`,
      `cache/shared-github-blobs/${"c".repeat(40)}`,
      `cache/shared-file-observations/${scope}/1.json`,
      `operations/shared-profile-pending/${scope}/profile-${"c".repeat(64)}.json`,
      `operations/shared-source-registration/${scope}/source-other.json`,
      `operations/shared-source-registration/${scope}/../source-${"7".repeat(64)}.json`,
      `operations/shared-native-create/${scope}/skill-create-invalid.json`,
      `operations/shared-native-create/${scope}/../skill-create-${"8".repeat(64)}.json`,
      `operations/shared-native-create-owned/${scope}/skill-create-invalid.json`,
      `operations/shared-relation-schema/${scope}/relations-schema-${"8".repeat(64)}-other.json`,
      `operations/owned-page-archive/${scope}/p_owned-archive-test/00000000-0000-4000-8000-000000000001/../00000000000000000000.json`,
      `operations/owned-page-archive/${scope}/p_owned-archive-test/00000000-0000-4000-8000-000000000001.json`,
      `operations/shared-native-recovery/${scope}/skill-create-invalid.json`,
      `operations/shared-native-recovery/${scope}/../skill-create-${"8".repeat(64)}.json`,
      `operations/shared-native-recovery-responses/create-recovery-invalid/${"e".repeat(64)}.json`,
      `operations/shared-native-recovery-responses/create-recovery-${"9".repeat(64)}/../${"e".repeat(64)}.json`,
      `operations/shared-native-recovery-responses/create-recovery-${"9".repeat(64)}/response.json`,
      `content-restrictions/other/${scope}.json`,
      `content-restrictions/local/${scope}.json/extra`,
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
      `yield* state.write(${JSON.stringify(restrictionKey)},${JSON.stringify(restriction)});yield* state.write(${JSON.stringify(keys.github)},{version:1});yield* state.retire(yield* state.list('cache'));console.log('retained')`,
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

test("local-content restriction schema and persisted corruption fail closed without replacing evidence", async () => {
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
