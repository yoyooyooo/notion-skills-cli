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
  version: 1,
  scope: "b".repeat(64),
  library_id: "current-test-library",
  record_id: "operation-current-" + "c".repeat(64),
  intent: { operation_id: "current-test-one", skill_id: "example", input_sha256: "d".repeat(64) },
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
