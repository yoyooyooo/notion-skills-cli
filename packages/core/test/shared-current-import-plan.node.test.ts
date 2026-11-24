import { expect, test } from "@effect/vitest"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { trashPath } from "../src/local-locks.ts"
import { currentLibrary } from "./shared-current-fixture.ts"

const core = new URL("../src/", import.meta.url).pathname

async function run(root: string, body: string) {
  const program = `import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {ConfigProvider,Effect,Layer} from ${JSON.stringify(import.meta.resolve("effect"))};
import {Store,StoreLive} from ${JSON.stringify(core + "store.ts")};
import {Notion} from ${JSON.stringify(core + "notion.ts")};
import {fail} from ${JSON.stringify(core + "model.ts")};
import {prepareCurrentSkillWrite} from ${JSON.stringify(core + "shared-current-write.ts")};
import {freezeCurrentImportValue,withCurrentImportPlan} from ${JSON.stringify(core + "shared-current-import-plan.ts")};
import {ImportPlanSchema} from ${JSON.stringify(core + "shared-current-import-plan-model.ts")};
const library=${JSON.stringify(currentLibrary)};
const notion={apiOrigin:'https://api.notion.com',credentialIdentity:Effect.succeed('fixed-import-principal'),request:()=>Effect.die('This persistence test must not perform a Notion request')};
Effect.runPromise(Effect.gen(function*(){
const store=yield* Store;
const prepared=yield* prepareCurrentSkillWrite({skill_id:'frozen',kind:'skill',name:'Frozen',description:'Frozen import',files:[{path:'SKILL.md',bytes:new TextEncoder().encode('# Frozen original\\n')}]});
const frozen=yield* freezeCurrentImportValue(prepared);
const definition={version:1,kind:'single',mapping:[],rewrites:[],items:[{skill_id:'frozen',original_input_sha256:prepared.input_sha256,body:frozen,body_input_sha256:prepared.input_sha256,create_only:true,members_discovery:{member_policy:'first_creation',confirmed:[],unresolved:[]}}]};
const request={operation_id:'frozen-op',request_sha256:prepared.input_sha256,mode:'apply'};
const keys=()=>store.listKeys('operations/import-plan');
const code=result=>result._tag==='Failure'?result.failure.code:null;
const forbidden=Effect.die('Original frozen input must not be recompiled');
${body}
}).pipe(Effect.provideService(Notion,notion),Effect.provide(StoreLive.pipe(Layer.provideMerge(NodeServices.layer))),Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())))).catch(error=>{console.error(String(error));process.exitCode=1});`
  const worker = spawn(process.execPath, ["--input-type=module", "-e", program], {
    env: {
      ...process.env,
      NTN_SKILLS_HOME: join(root, "state"),
      NTN_SKILLS_CONFIG_HOME: join(root, "config"),
      NTN_SKILLS_CACHE_HOME: join(root, "cache"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "", stderr = ""
  worker.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
  worker.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
  const [exit] = await once(worker, "close")
  return { exit, stdout, stderr }
}

test("real Store import plans survive restart at the same root and reject replacement table bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-import-plan-sqlite-"))
  try {
    const first = await run(root, `
const paused=yield* withCurrentImportPlan(library,request,Effect.succeed(definition),()=>Effect.fail(fail('TEST_PAUSE','Stop after durable plan publication'))).pipe(Effect.result);
const saved=yield* keys();
console.log(JSON.stringify({paused:code(paused),keys:saved,plan:saved.length===1?yield* store.readJson(saved[0],ImportPlanSchema):null}));`)
    expect(first.exit, first.stderr).toBe(0)
    const initial = JSON.parse(first.stdout)
    expect(initial.paused).toBe("TEST_PAUSE")
    expect(initial.keys).toHaveLength(1)
    expect(initial.plan.library).toEqual(currentLibrary)
    expect(initial.plan.steps).toEqual({})

    const restarted = await run(root, `
const original=(yield* keys())[0];
const duplicate=yield* withCurrentImportPlan(library,request,forbidden,()=>forbidden).pipe(Effect.result);
const rejected=[];
for(const changed of [
 {...library,files:{...library.files,database_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}},
 {...library,skills:{...library.skills,data_source_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}},
]){
 const result=yield* withCurrentImportPlan(changed,{...request,mode:'resume'},forbidden,()=>forbidden).pipe(Effect.result);
 rejected.push(code(result));
}
console.log(JSON.stringify({duplicate:code(duplicate),rejected,keys:yield* keys(),plan:yield* store.readJson(original,ImportPlanSchema)}));`)
    expect(restarted.exit, restarted.stderr).toBe(0)
    expect(JSON.parse(restarted.stdout)).toEqual({
      duplicate: "CURRENT_IMPORT_PLAN_PENDING",
      rejected: ["CURRENT_IMPORT_PLAN_INVALID", "CURRENT_IMPORT_PLAN_INVALID"],
      keys: initial.keys,
      plan: initial.plan,
    })

    const started = await run(root, `
const paused=yield* withCurrentImportPlan(library,{...request,mode:'resume'},forbidden,session=>Effect.gen(function*(){
 const item=session.definition.items[0];
 const phase=yield* session.start('body:frozen',{skill_id:'frozen',operation_id:request.operation_id,input_sha256:item.body_input_sha256,prepared:item.body});
 if(phase.mode!=='apply')return yield* Effect.die('A new frozen child must be admitted once');
 return yield* Effect.fail(fail('TEST_PAUSE','Stop after durable child intent'));
})).pipe(Effect.result);
const saved=yield* keys();console.log(JSON.stringify({paused:code(paused),keys:saved,plan:yield* store.readJson(saved[0],ImportPlanSchema)}));`)
    expect(started.exit, started.stderr).toBe(0)
    const child = JSON.parse(started.stdout)
    expect(child.paused).toBe("TEST_PAUSE")
    expect(child.keys).toEqual(initial.keys)
    expect(child.plan.steps["body:frozen"].phase).toBe("started")

    const completed = await run(root, `
const result=yield* withCurrentImportPlan(library,{...request,mode:'resume'},forbidden,session=>Effect.gen(function*(){
 const item=session.definition.items[0];
 const phase=yield* session.start('body:frozen',{skill_id:'frozen',operation_id:request.operation_id,input_sha256:item.body_input_sha256,prepared:item.body});
 if(phase.mode!=='resume')return yield* Effect.die('A persisted child cannot become a new apply');
 yield* session.complete('body:frozen',{state:'ready'});return {mode:phase.mode};
}));
console.log(JSON.stringify({result,keys:yield* keys()}));`)
    expect(completed.exit, completed.stderr).toBe(0)
    expect(JSON.parse(completed.stdout)).toEqual({ result: { mode: "resume" }, keys: [] })
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
  }
}, 30_000)
