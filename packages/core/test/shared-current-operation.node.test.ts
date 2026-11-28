import { currentLibrary } from "./shared-current-fixture.ts"
import { expect, test } from "@effect/vitest"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { trashPath } from "../src/local-locks.ts"

const core = new URL("../src/", import.meta.url).pathname
const key = "operations/current-write-pending/" + "a".repeat(64) + "/pending.json"
const pending = {
  completion: "ready",
  owner_page_id: null,
  version: 2,
  library: currentLibrary,
  scope: "b".repeat(64),
  library_id: currentLibrary.library_id,
  record_id: "operation-current-" + "c".repeat(64),
  intent: {
    operation_id: "current-test-one",
    owner: { kind: "skill", id: "example" },
    input_sha256: "d".repeat(64),
  },
  lifecycle: { phase: "creating" },
}

async function run(root: string, body: string) {
  const program = `import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {ConfigProvider,Effect,FileSystem,Layer,Schema} from ${JSON.stringify(import.meta.resolve("effect"))};
import {SqlClient} from ${JSON.stringify(import.meta.resolve("effect/sql"))};
import {Store,StoreLive} from ${JSON.stringify(core + "store.ts")};
import {sqliteState} from ${JSON.stringify(core + "sqlite-state.ts")};
import {CurrentWritePendingSchema} from ${JSON.stringify(core + "shared-current-operation.ts")};
import {clearCache} from ${JSON.stringify(core + "cache.ts")};
process.env.NTN_SKILLS_HOME=${JSON.stringify(join(root, "state"))};
process.env.NTN_SKILLS_CONFIG_HOME=${JSON.stringify(join(root, "config"))};
process.env.NTN_SKILLS_CACHE_HOME=${JSON.stringify(join(root, "cache"))};
Effect.runPromise(Effect.gen(function*(){
const store=yield* Store,key=${JSON.stringify(key)},pending=${JSON.stringify(pending)};
const rows=()=>Effect.scoped(Effect.gen(function*(){
const state=yield* sqliteState(store.root,yield* FileSystem.FileSystem);
return yield* state.run(Effect.gen(function*(){const sql=yield* SqlClient.SqlClient;return yield* sql\`SELECT key,retired FROM shared_local_records WHERE key=\${key}\`;}));
}));
${body}
}).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(NodeServices.layer))),Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())))).catch(error=>{console.error(String(error));process.exitCode=1});`
  const worker = spawn(process.execPath, ["--input-type=module", "-e", program], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "",
    stderr = ""
  worker.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk
  })
  worker.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk
  })
  const [exit] = await once(worker, "close")
  return { exit, stdout, stderr }
}

test("real Store keeps one pending current input across restart and deletes it on completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-current-operation-sqlite-"))
  try {
    const first = await run(
      root,
      `
yield* store.writeJson(key,pending);
const active={...pending,lifecycle:{phase:'active',record_page_id:'00000000-0000-4000-8000-000000000001'},not_dispatched:{key:'append:0',request_sha256:'e'.repeat(64),replay:'never'}};
yield* store.writeJson(key,active);
const changed=yield* store.writeJson(key,{...active,intent:{...active.intent,input_sha256:'f'.repeat(64)}}).pipe(Effect.result);
const invalid=[];
for(const address of [key.replace('a'.repeat(64),'../outside'),key.replace('a'.repeat(64),'A'.repeat(64)),key.replace('pending.json','other.json')]){
 const read=yield* store.readJson(address,Schema.Unknown).pipe(Effect.result);
 const write=yield* store.writeJson(address,active).pipe(Effect.result);
 invalid.push({read:read._tag==='Failure'?read.failure.code:null,write:write._tag==='Failure'?write.failure.code:null});
}
console.log(JSON.stringify({current:yield* store.readJson(key,CurrentWritePendingSchema),changed:changed._tag==='Failure'?changed.failure.code:null,invalid,rows:yield* rows()}));`,
    )
    expect(first.exit, first.stderr).toBe(0)
    const initial = JSON.parse(first.stdout)
    expect(initial).toMatchObject({
      current: {
        ...pending,
        lifecycle: { phase: "active", record_page_id: "00000000-0000-4000-8000-000000000001" },
        not_dispatched: { key: "append:0" },
      },
      changed: "STATE_CONFLICT",
      invalid: Array.from({ length: 3 }, () => ({
        read: "INVALID_ARGUMENT",
        write: "INVALID_ARGUMENT",
      })),
      rows: [{ key, retired: 0 }],
    })
    const reopened = await run(
      root,
      `
const restored=yield* store.readJson(key,CurrentWritePendingSchema);
yield* clearCache(undefined,{all:true});
const preservedAfterCacheClear=JSON.stringify(yield* store.readJson(key,CurrentWritePendingSchema))===JSON.stringify(restored);
yield* store.writeJson(key,{...restored,lifecycle:{phase:'retiring',record_page_id:restored.lifecycle.record_page_id},not_dispatched:undefined});
const current=yield* store.readJson(key,CurrentWritePendingSchema),before=yield* rows();
const retired=yield* store.retireKeys([key]),after=yield* rows();
const cleared=(yield* store.readJson(key,Schema.Unknown))??null;
const next={...pending,intent:{...pending.intent,operation_id:'current-test-two',input_sha256:'f'.repeat(64)}};
yield* store.writeJson(key,next);
const reused=yield* store.readJson(key,CurrentWritePendingSchema);
yield* store.retireKeys([key]);
console.log(JSON.stringify({restored,preservedAfterCacheClear,current,before,retired,after,cleared,reused,final:yield* rows()}));`,
    )
    expect(reopened.exit, reopened.stderr).toBe(0)
    const result = JSON.parse(reopened.stdout)
    expect(result.restored).toEqual(initial.current)
    expect(result.preservedAfterCacheClear).toBe(true)
    expect(result.current.lifecycle.phase).toBe("retiring")
    expect(result.current.not_dispatched).toBeUndefined()
    expect(result.before).toEqual([{ key, retired: 0 }])
    expect(result.retired).toEqual([{ key, retention_path: "sqlite_current_write_cleared" }])
    expect(result.after).toEqual([])
    expect(result.cleared).toBeNull()
    expect(result.reused.intent.operation_id).toBe("current-test-two")
    expect(result.final).toEqual([])
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
  }
}, 30_000)

test("real Store freezes Source ownership and context plus the child parent binding across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-source-intent-sqlite-"))
  try {
    const first = await run(
      root,
      `
const childKey=key.replace('a'.repeat(64),'e'.repeat(64));
const source={...pending,intent:{operation_id:'source-op',owner:{kind:'source',id:'provider'},input_sha256:'d'.repeat(64),source_input:{kind:'declaration',configuration_sha256:'1'.repeat(64),resolved_commit:'2'.repeat(40),affected_skill_ids:['example'],retirements:[]}}};
const sourceBinding={source_id:'provider',source_page_id:'00000000-0000-4000-8000-000000000003',operation_id:'source-op',input_sha256:'d'.repeat(64),authorization_sha256:'3'.repeat(64)};
const child={...pending,intent:{...pending.intent,source:sourceBinding}};
yield* store.writeJson(key,source);yield* store.writeJson(childKey,child);
const rejected=[];
for(const value of [
 {...source,intent:{...source.intent,owner:{kind:'source',id:'other-provider'}}},
 {...source,intent:{...source.intent,source_input:{...source.intent.source_input,resolved_commit:'4'.repeat(40)}}},
 {...source,intent:{...source.intent,source_input:{...source.intent.source_input,affected_skill_ids:['other-target']}}},
 {...source,scope:'5'.repeat(64)},
 {...source,library:{...source.library,files:{...source.library.files,database_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}}},
]){const result=yield* store.writeJson(key,value).pipe(Effect.result);rejected.push(result._tag==='Failure'?result.failure.code:null);}
const changedBinding=yield* store.writeJson(childKey,{...child,intent:{...child.intent,source:{...sourceBinding,operation_id:'another-parent'}}}).pipe(Effect.result);
const reordered={...source,intent:{source_input:{kind:'declaration',affected_skill_ids:['example'],retirements:[],resolved_commit:'2'.repeat(40),configuration_sha256:'1'.repeat(64)},input_sha256:'d'.repeat(64),owner:{id:'provider',kind:'source'},operation_id:'source-op'},lifecycle:{phase:'active',record_page_id:'00000000-0000-4000-8000-000000000004'}};
yield* store.writeJson(key,reordered);
console.log(JSON.stringify({rejected,changedBinding:changedBinding._tag==='Failure'?changedBinding.failure.code:null,source:yield* store.readJson(key,CurrentWritePendingSchema),child:yield* store.readJson(childKey,CurrentWritePendingSchema)}));`,
    )
    expect(first.exit, first.stderr).toBe(0)
    const initial = JSON.parse(first.stdout)
    expect(initial.rejected).toEqual(Array.from({ length: 5 }, () => "STATE_CONFLICT"))
    expect(initial.changedBinding).toBe("STATE_CONFLICT")
    expect(initial.source).toMatchObject({
      intent: {
        owner: { kind: "source", id: "provider" },
        input_sha256: "d".repeat(64),
        source_input: { resolved_commit: "2".repeat(40), affected_skill_ids: ["example"] },
      },
      lifecycle: { phase: "active" },
    })
    const reopened = await run(
      root,
      `
const childKey=key.replace('a'.repeat(64),'e'.repeat(64));
yield* clearCache(undefined,{all:true});
const source=yield* store.readJson(key,CurrentWritePendingSchema),child=yield* store.readJson(childKey,CurrentWritePendingSchema);
yield* store.retireKeys([key,childKey]);
console.log(JSON.stringify({source,child,remaining:yield* store.listKeys('operations/current-write-pending')}));`,
    )
    expect(reopened.exit, reopened.stderr).toBe(0)
    const restored = JSON.parse(reopened.stdout)
    expect(restored.source).toEqual(initial.source)
    expect(restored.child).toEqual(initial.child)
    expect(restored.remaining).toEqual([])
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
  }
}, 30_000)

test("real Store preserves projection intent without changing its owner across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-projection-intent-sqlite-"))
  try {
    const written = await run(
      root,
      `
const projection={...pending,owner_page_id:'00000000-0000-4000-8000-000000000001',intent:{...pending.intent,projection:true,policy:{include:['**/*.md'],exclude:[]}},lifecycle:{phase:'active',record_page_id:'00000000-0000-4000-8000-000000000002'}};
yield* store.writeJson(key,projection);
const content={...projection,intent:pending.intent};
const replaced=yield* store.writeJson(key,content).pipe(Effect.result);
console.log(JSON.stringify({projection:yield* store.readJson(key,CurrentWritePendingSchema),replaced:replaced._tag==='Failure'?replaced.failure.code:null}));`,
    )
    expect(written.exit, written.stderr).toBe(0)
    const initial = JSON.parse(written.stdout)
    expect(initial.projection).toMatchObject({
      owner_page_id: "00000000-0000-4000-8000-000000000001",
      intent: {
        ...pending.intent,
        projection: true,
        policy: { include: ["**/*.md"], exclude: [] },
      },
      lifecycle: { phase: "active" },
    })
    expect(initial.replaced).toBe("STATE_CONFLICT")
    const reopened = await run(
      root,
      `
const restored=yield* store.readJson(key,CurrentWritePendingSchema);
yield* store.writeJson(key,{...restored,lifecycle:{phase:'retiring',record_page_id:restored.lifecycle.record_page_id}});
yield* store.retireKeys([key]);
console.log(JSON.stringify({restored,remaining:yield* store.listKeys('operations/current-write-pending')}));`,
    )
    expect(reopened.exit, reopened.stderr).toBe(0)
    expect(JSON.parse(reopened.stdout)).toEqual({ restored: initial.projection, remaining: [] })
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
  }
}, 30_000)

test("real Store freezes the restore page and policy while binding its unchanged owner across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-restore-intent-sqlite-"))
  try {
    const first = await run(
      root,
      `
const restore={...pending,intent:{...pending.intent,restore:{page_id:'00000000-0000-4000-8000-000000000001',policy:{include:['references/**/*.md'],exclude:['**/fixtures/**']}}},lifecycle:{phase:'active',record_page_id:'00000000-0000-4000-8000-000000000002'}};
yield* store.writeJson(key,restore);
const rejected=[];
for(const change of [{page_id:'00000000-0000-4000-8000-000000000003'},{policy:{include:['**/*.md'],exclude:[]}}]){
 const result=yield* store.writeJson(key,{...restore,intent:{...restore.intent,restore:{...restore.intent.restore,...change}}}).pipe(Effect.result);
 rejected.push(result._tag==='Failure'?result.failure.code:null);
}
console.log(JSON.stringify({restore:yield* store.readJson(key,CurrentWritePendingSchema),rejected}));`,
    )
    expect(first.exit, first.stderr).toBe(0)
    const initial = JSON.parse(first.stdout)
    expect(initial.restore.intent.restore).toEqual({
      page_id: "00000000-0000-4000-8000-000000000001",
      policy: { include: ["references/**/*.md"], exclude: ["**/fixtures/**"] },
    })
    expect(initial.rejected).toEqual(["STATE_CONFLICT", "STATE_CONFLICT"])
    const reopened = await run(
      root,
      `
const restored=yield* store.readJson(key,CurrentWritePendingSchema);
const bound={...restored,owner_page_id:restored.intent.restore.page_id,lifecycle:{phase:'retiring',record_page_id:restored.lifecycle.record_page_id}};
yield* store.writeJson(key,bound);
const current=yield* store.readJson(key,CurrentWritePendingSchema);
yield* store.retireKeys([key]);
console.log(JSON.stringify({restored,current,remaining:yield* store.listKeys('operations/current-write-pending')}));`,
    )
    expect(reopened.exit, reopened.stderr).toBe(0)
    const result = JSON.parse(reopened.stdout)
    expect(result.restored).toEqual(initial.restore)
    expect(result.current).toMatchObject({
      owner_page_id: initial.restore.intent.restore.page_id,
      intent: initial.restore.intent,
      lifecycle: { phase: "retiring" },
    })
    expect(result.remaining).toEqual([])
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
  }
}, 30_000)

test("real SQLite admits exactly one expected-old successor and preserves it across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-current-handoff-sqlite-"))
  try {
    const seeded = await run(
      root,
      `
yield* store.writeJson(key,pending);
const successor={...pending,intent:{...pending.intent,operation_id:'next',input_sha256:'e'.repeat(64)},predecessor:{intent:pending.intent,completion:'ready',owner_page_id:null,in_flight:null},lifecycle:{phase:'replacing',record_page_id:null}};
const ordinary=yield* store.writeJson(key,successor).pipe(Effect.result);
const changedOwner={...successor,intent:{...successor.intent,owner:{kind:'skill',id:'another'}}};
const foreign=yield* store.writeJson(key,changedOwner,{expectedCurrentWritePending:pending}).pipe(Effect.result);
const stale=yield* store.writeJson(key,successor,{expectedCurrentWritePending:{...pending,not_dispatched:{key:'different',request_sha256:'f'.repeat(64),replay:'never'}}}).pipe(Effect.result);
const outside=yield* store.writeJson('config.json',successor,{expectedCurrentWritePending:pending}).pipe(Effect.result);
console.log(JSON.stringify({codes:[ordinary,foreign,stale,outside].map(r=>r._tag==='Failure'?r.failure.code:null),actual:yield* store.readJson(key,CurrentWritePendingSchema)}));`,
    )
    expect(seeded.exit, seeded.stderr).toBe(0)
    expect(JSON.parse(seeded.stdout)).toEqual({
      codes: ["STATE_CONFLICT", "STATE_CONFLICT", "STATE_CONFLICT", "INVALID_ARGUMENT"],
      actual: pending,
    })
    const attempts = await Promise.all(
      ["left", "right"].map((name) =>
        run(
          root,
          `
const successor={...pending,intent:{...pending.intent,operation_id:${JSON.stringify(name)},input_sha256:'e'.repeat(64)},predecessor:{intent:pending.intent,completion:'ready',owner_page_id:null,in_flight:null},lifecycle:{phase:'replacing',record_page_id:null}};
const result=yield* store.writeJson(key,successor,{expectedCurrentWritePending:pending}).pipe(Effect.result);
console.log(JSON.stringify({name:${JSON.stringify(name)},code:result._tag==='Failure'?result.failure.code:'success'}));`,
        ),
      ),
    )
    for (const attempt of attempts) expect(attempt.exit, attempt.stderr).toBe(0)
    const outcomes = attempts.map((attempt) => JSON.parse(attempt.stdout))
    expect(outcomes.map((row) => row.code).sort()).toEqual(["STATE_CONFLICT", "success"])
    const winner = outcomes.find((row) => row.code === "success")!.name
    const reopened = await run(
      root,
      `
yield* clearCache(undefined,{all:true});
const actual=yield* store.readJson(key,CurrentWritePendingSchema);
const without={...actual};delete without.predecessor;
const erased=yield* store.writeJson(key,without).pipe(Effect.result);
yield* store.retireKeys([key]);
console.log(JSON.stringify({actual,erased:erased._tag==='Failure'?erased.failure.code:null,remaining:yield* store.listKeys('operations/current-write-pending')}));`,
    )
    expect(reopened.exit, reopened.stderr).toBe(0)
    const result = JSON.parse(reopened.stdout)
    expect(result.actual).toMatchObject({
      intent: { operation_id: winner },
      predecessor: { intent: pending.intent },
      lifecycle: { phase: "replacing" },
    })
    expect(result.erased).toBe("STATE_CONFLICT")
    expect(result.remaining).toEqual([])
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
  }
}, 30_000)
