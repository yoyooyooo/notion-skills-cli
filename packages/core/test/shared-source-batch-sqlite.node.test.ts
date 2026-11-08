import { expect, test } from "@effect/vitest"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { trashPath } from "../src/local-locks.ts"

const core = new URL("../src/", import.meta.url).pathname
const fixtures = new URL("./", import.meta.url).pathname
const prefix = `import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {Effect,FileSystem,Schema} from ${JSON.stringify(import.meta.resolve("effect"))};`

async function child(source: string) {
  const worker = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "",
    stderr = ""
  worker.stdout.setEncoding("utf8").on("data", (value: string) => {
    stdout += value
  })
  worker.stderr.setEncoding("utf8").on("data", (value: string) => {
    stderr += value
  })
  const [exit] = await once(worker, "close")
  return { exit, stdout, stderr }
}

async function isolated(action: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ntn-source-batch-sqlite-"))
  try {
    await action(root)
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
  }
}

function stateProgram(root: string, body: string) {
  return `${prefix}
import {sqliteState} from ${JSON.stringify(core + "sqlite-state.ts")};
Effect.runPromise(Effect.scoped(Effect.gen(function*(){const state=yield* sqliteState(${JSON.stringify(root)},yield* FileSystem.FileSystem);${body}})).pipe(Effect.provide(NodeServices.layer))).catch(error=>{console.error(String(error));process.exitCode=1});`
}

function batchProgram(root: string, mode: "dry" | "apply" | "reconcile") {
  return `${prefix}
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Store,StoreLive} from ${JSON.stringify(core + "store.ts")};
import {prepareSourceRefreshBatch,runSourceRefreshBatch} from ${JSON.stringify(core + "shared-source-batch.ts")};
import {sourceRefreshFixture,library} from ${JSON.stringify(fixtures + "shared-source-refresh-fixture.ts")};
import {id} from ${JSON.stringify(fixtures + "shared-snapshot-fixture.ts")};
const root=${JSON.stringify(root)},mode=${JSON.stringify(mode)};
process.env.NTN_SKILLS_HOME=root+'/state';process.env.NTN_SKILLS_CONFIG_HOME=root+'/config';process.env.NTN_SKILLS_CACHE_HOME=root+'/cache';
const fixture=await sourceRefreshFixture();
let saved;try{saved=JSON.parse(await readFile(root+'/remote-fixture.json','utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
if(saved){Object.assign(fixture.main,saved.main);Object.assign(fixture.source,saved.source);fixture.files.splice(0,fixture.files.length,...saved.files);fixture.relatedPages.splice(0,fixture.relatedPages.length,...saved.relatedPages);fixture.records.clear();for(const [key,value]of saved.records)fixture.records.set(key,value);fixture.bodies.clear();for(const [key,value]of saved.bodies)fixture.bodies.set(key,value);}
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const store=yield* Store,checkpoints=[];
  const tracked={...store,writeJson:(key,value)=>store.writeJson(key,value).pipe(Effect.tap(()=>key.startsWith('operations/shared-source-batches/')?Effect.gen(function*(){const actual=yield* store.readJson(key,Schema.Unknown);assert.deepEqual(actual,value);checkpoints.push({key,complete:actual.execution_complete,in_progress:actual.in_progress,items:actual.items.length});}):Effect.succeed(undefined)))};
  const run=program=>fixture.run(program.pipe(Effect.provideService(Store,tracked)));
  const batch=mode==='dry'?yield* Effect.promise(()=>run(prepareSourceRefreshBatch(library,id(82),fixture.acquire))):JSON.parse(yield* Effect.promise(()=>readFile(root+'/batch.json','utf8')));
  if(mode==='dry')yield* Effect.promise(()=>writeFile(root+'/batch.json',JSON.stringify(batch),{flag:'wx'}));
  fixture.clearCalls();
  const result=yield* Effect.promise(()=>run(runSourceRefreshBatch(library,batch,{mode:mode==='reconcile'?'reconcile':'apply',dryRun:mode==='dry'})));
  const checkpoint=yield* store.readJson(result.result_key,Schema.Unknown);
  const memberKeys=(yield* store.listKeys('operations/shared-sources')).sort(),memberEvidence=[];
  for(const key of memberKeys)memberEvidence.push({key,sha256:digest(yield* store.readJson(key,Schema.Unknown))});
  yield* Effect.promise(()=>writeFile(root+'/remote-fixture.json',JSON.stringify({main:fixture.main,source:fixture.source,files:fixture.files,relatedPages:fixture.relatedPages,records:[...fixture.records],bodies:[...fixture.bodies]})));
  console.log(JSON.stringify({result,checkpoint,checkpoints,memberEvidence,semanticWrites:fixture.calls.filter(call=>call.method==='PATCH'||(call.path==='v1/pages'&&call.method==='POST')).length,providerAcquisitions:fixture.acquisitions()}));
})).pipe(Effect.provide(StoreLive),Effect.provide(NodeServices.layer)));`
}

test("real Source batch checkpoints persist through dry-run, apply and cold read-only reconcile", async () => {
  await isolated(async (root) => {
    const reports = []
    for (const mode of ["dry", "apply", "reconcile"] as const) {
      const process = await child(batchProgram(root, mode))
      expect(process.exit, process.stderr).toBe(0)
      const report = JSON.parse(process.stdout)
      reports.push(report)
      expect(report.result.execution_complete).toBe(true)
      expect(report.result.status).toBe(
        mode === "dry" ? "planned" : mode === "apply" ? "applied" : "observed",
      )
      expect(report.result.atomic).toBe(false)
      expect(report.result.items).toHaveLength(1)
      expect(report.checkpoints.length).toBeGreaterThanOrEqual(4)
      expect(new Set(report.checkpoints.map((item: { key: string }) => item.key)).size).toBe(1)
      expect(report.checkpoints[0].complete).toBe(false)
      expect(
        report.checkpoints.some((item: { in_progress: unknown }) => item.in_progress !== null),
      ).toBe(true)
      expect(report.checkpoints.at(-1)).toMatchObject({
        complete: true,
        in_progress: null,
        items: 1,
      })
      expect(report.checkpoint).toMatchObject({
        plan_id: report.result.plan_id,
        run_id: report.result.run_id,
        execution_complete: true,
        in_progress: null,
        not_dispatched: [],
      })
      expect(report.checkpoint.items).toEqual(report.result.items)
      if (mode !== "apply") expect(report.semanticWrites).toBe(0)
      if (mode !== "dry") expect(report.providerAcquisitions).toBe(0)
    }
    expect(new Set(reports.map((report) => report.result.plan_id)).size).toBe(1)
    expect(new Set(reports.map((report) => report.result.result_key)).size).toBe(3)
    expect(reports[1].memberEvidence.length).toBeGreaterThan(0)
    expect(reports[2].memberEvidence).toEqual(reports[1].memberEvidence)
    const keys = reports.map((report) => report.result.result_key)
    const reopened = await child(
      stateProgram(
        join(root, "state"),
        `const rows=[];for(const key of ${JSON.stringify(keys)})rows.push(yield* state.read(key));console.log(JSON.stringify({keys:yield* state.list('operations/shared-source-batches'),rows}));`,
      ),
    )
    expect(reopened.exit, reopened.stderr).toBe(0)
    const persisted = JSON.parse(reopened.stdout)
    expect(persisted.keys.sort()).toEqual([...keys].sort())
    expect(persisted.rows).toEqual(reports.map((report) => report.checkpoint))
  })
}, 60_000)

test("only exact batch run addresses update; member evidence stays immutable and retired checkpoints cannot revive", async () => {
  await isolated(async (root) => {
    const scope = "a".repeat(64)
    const plan = `source-batch-${"b".repeat(64)}`
    const run = "00000000-0000-4000-8000-000000000001"
    const key = `operations/shared-source-batches/${scope}/${plan}/${run}.json`
    const immutable = [
      `operations/shared-sources/${scope}/source-op-${"c".repeat(64)}.json`,
      `operations/shared-sources/${scope}/source-ack-${"d".repeat(64)}.json`,
      `operations/shared-sources/${scope}/source-selection-${"e".repeat(64)}.json`,
    ]
    const invalid = [
      key.replace(scope, "a".repeat(63)),
      key.replace(scope, "A".repeat(64)),
      key.replace(plan, `source-batch-${"b".repeat(63)}`),
      key.replace(plan, `source-refresh-${"b".repeat(64)}`),
      key.replace(run, "00000000000040008000000000000001"),
      key.replace(run, "../../other"),
      key.replace(`${run}.json`, `source-op-${"f".repeat(64)}.json`),
      key.replace("shared-source-batches/", "shared-source-batches-other/"),
      key.replace(".json", ".json/extra"),
      key.replace(`/${run}.json`, `/extra/${run}.json`),
    ]
    const first = await child(
      stateProgram(
        root,
        `const key=${JSON.stringify(key)};yield* state.write(key,{step:1});yield* state.write(key,{step:2});
const errors=[];for(const invalid of ${JSON.stringify(invalid)}){const bad=yield* state.write(invalid,{}).pipe(Effect.flip);errors.push(bad.code);}
const protectedErrors=[];for(const address of ${JSON.stringify(immutable)}){yield* state.write(address,{step:1});const conflict=yield* state.write(address,{step:2}).pipe(Effect.flip);protectedErrors.push(conflict.code);}
console.log(JSON.stringify({checkpoint:yield* state.read(key),errors,protectedErrors}));`,
      ),
    )
    expect(first.exit, first.stderr).toBe(0)
    expect(JSON.parse(first.stdout)).toEqual({
      checkpoint: { step: 2 },
      errors: invalid.map(() => "INVALID_ARGUMENT"),
      protectedErrors: immutable.map(() => "STATE_CONFLICT"),
    })
    const retired = await child(
      stateProgram(
        root,
        `const key=${JSON.stringify(key)},before=yield* state.read(key);yield* state.retire([key]);
const errors=[];for(const value of [{step:2},{step:3}]){const result=yield* state.write(key,value).pipe(Effect.flip);errors.push(result.code);}
const originals=[];for(const address of ${JSON.stringify(immutable)})originals.push(yield* state.read(address));
console.log(JSON.stringify({before,after:(yield* state.read(key))??null,keys:yield* state.list('operations/shared-source-batches'),errors,originals}));`,
      ),
    )
    expect(retired.exit, retired.stderr).toBe(0)
    expect(JSON.parse(retired.stdout)).toEqual({
      before: { step: 2 },
      after: null,
      keys: [],
      errors: ["STATE_CONFLICT", "STATE_CONFLICT"],
      originals: immutable.map(() => ({ step: 1 })),
    })
    const inspected = await child(
      `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(join(root, "state.sqlite"))},{readOnly:true});try{console.log(JSON.stringify(db.prepare('SELECT category,payload,retired FROM shared_local_records WHERE key=?').get(${JSON.stringify(key)})));}finally{db.close();}`,
    )
    expect(inspected.exit, inspected.stderr).toBe(0)
    expect(JSON.parse(inspected.stdout)).toEqual({
      category: "dispatch",
      payload: '{"step":2}',
      retired: 1,
    })
  })
}, 30_000)
