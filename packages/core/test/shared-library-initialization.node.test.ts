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
const key = `operations/library-init-pending/${scope}/pending.json`
const initial = {
  version: 1,
  scope,
  operation_id: "library-node-resume",
  parent_page_id: "11111111-1111-4111-8111-111111111111",
  tables: {},
  in_flight: { action: "create:Skills", request_sha256: "b".repeat(64) },
}
const skills = {
  database_id: "22222222-2222-4222-8222-222222222222",
  data_source_id: "33333333-3333-4333-8333-333333333333",
  property_ids: { Name: "title", Content: "content" },
}

async function run(root: string, body: string) {
  const program = `import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {ConfigProvider,Effect,FileSystem,Layer,Schema} from ${JSON.stringify(import.meta.resolve("effect"))};
import {SqlClient} from ${JSON.stringify(import.meta.resolve("effect/sql"))};
import {Store,StoreLive} from ${JSON.stringify(core + "store.ts")};
import {sqliteState} from ${JSON.stringify(core + "sqlite-state.ts")};
import {LibraryInitializationPendingSchema} from ${JSON.stringify(core + "shared-library-model.ts")};
import {clearCache} from ${JSON.stringify(core + "cache.ts")};
process.env.NTN_SKILLS_HOME=${JSON.stringify(join(root, "state"))};
process.env.NTN_SKILLS_CONFIG_HOME=${JSON.stringify(join(root, "config"))};
process.env.NTN_SKILLS_CACHE_HOME=${JSON.stringify(join(root, "cache"))};
Effect.runPromise(Effect.gen(function*(){
const store=yield* Store,key=${JSON.stringify(key)},initial=${JSON.stringify(initial)},skills=${JSON.stringify(skills)};
const rows=()=>Effect.scoped(Effect.gen(function*(){
 const state=yield* sqliteState(store.root,yield* FileSystem.FileSystem);
 return yield* state.run(Effect.gen(function*(){const sql=yield* SqlClient.SqlClient;return yield* sql\`SELECT key,retired FROM shared_local_records WHERE key=\${key}\`;}));
}));
${body}
}).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(NodeServices.layer))),Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())))).catch(error=>{console.error(String(error));process.exitCode=1});`
  const child = spawn(process.execPath, ["--input-type=module", "-e", program], {
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
  const [exit] = await once(child, "close")
  return { exit, stdout, stderr }
}

test("initialization retains one finite intent across processes, preserves known bindings, and clears on completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-library-init-sqlite-"))
  try {
    const first = await run(
      root,
      `
yield* store.writeJson(key,initial);
yield* store.writeJson(key,{...initial,tables:{Skills:skills},in_flight:null});
console.log(JSON.stringify({pending:yield* store.readJson(key,LibraryInitializationPendingSchema),rows:yield* rows()}));`,
    )
    expect(first.exit, first.stderr).toBe(0)
    const saved = JSON.parse(first.stdout)
    expect(saved.pending).toEqual({ ...initial, tables: { Skills: skills }, in_flight: null })
    expect(saved.rows).toEqual([{ key, retired: 0 }])
    const second = await run(
      root,
      `
const restored=yield* store.readJson(key,LibraryInitializationPendingSchema);
yield* clearCache(undefined,{all:true});
const afterClear=yield* store.readJson(key,LibraryInitializationPendingSchema);
const rejected=[];
for(const changed of [
 {...restored,operation_id:'library-other'},
 {...restored,parent_page_id:'44444444-4444-4444-8444-444444444444'},
 {...restored,tables:{}},
 {...restored,tables:{Skills:{...skills,data_source_id:'replacement'}}},
 {...restored,tables:{Skills:{...skills,property_ids:{Name:'replacement',Content:'content'}}}},
]){
 const result=yield* store.writeJson(key,changed).pipe(Effect.result);
 rejected.push(result._tag==='Failure'?result.failure.code:null);
}
yield* store.writeJson(key,{...restored,tables:{Skills:{...skills,property_ids:{...skills.property_ids,Members:'members'}}}});
const expanded=yield* store.readJson(key,LibraryInitializationPendingSchema);
const retired=yield* store.retireKeys([key]);
console.log(JSON.stringify({restored,afterClear,rejected,expanded,retired,rows:yield* rows(),pending:(yield* store.readJson(key,LibraryInitializationPendingSchema))??null}));`,
    )
    expect(second.exit, second.stderr).toBe(0)
    const result = JSON.parse(second.stdout)
    expect(result.restored).toEqual(saved.pending)
    expect(result.afterClear).toEqual(saved.pending)
    expect(result.rejected).toEqual(Array(5).fill("STATE_CONFLICT"))
    expect(result.expanded.tables.Skills.property_ids.Members).toBe("members")
    expect(result.retired).toEqual([
      { key, retention_path: "sqlite_library_initialization_cleared" },
    ])
    expect(result.rows).toEqual([])
    expect(result.pending).toBeNull()
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
  }
}, 30_000)
