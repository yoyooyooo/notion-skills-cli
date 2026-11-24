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
const schemaFixture = new URL("./library-schema-fixture.ts", import.meta.url).pathname
// Credential authentication precedes pending lookup; only this independent read is allowed.
const authentication = { path: "v1/users/me", method: "GET" }
const replacement = {
  ...currentLibrary,
  records: {
    ...currentLibrary.records,
    database_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    data_source_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  },
}

async function run(root: string, body: string) {
  const program = `import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {ConfigProvider,Effect,Layer,Schema} from ${JSON.stringify(import.meta.resolve("effect"))};
import {createHash} from 'node:crypto';
import {Store,StoreLive} from ${JSON.stringify(core + "store.ts")};
import {Notion} from ${JSON.stringify(core + "notion.ts")};
import {authScope} from ${JSON.stringify(core + "catalog.ts")};
import {fail} from ${JSON.stringify(core + "model.ts")};
import {withLocalLocks} from ${JSON.stringify(core + "local-locks.ts")};
import {prepareSharedProfileChange,saveSharedProfile,sharedProfilePendingPrefix} from ${JSON.stringify(core + "shared-profile.ts")};
import {canonicalSharedJson} from ${JSON.stringify(core + "shared-records.ts")};
import {librarySchemaResponse} from ${JSON.stringify(schemaFixture)};
const library=${JSON.stringify(currentLibrary)};
const replacement=${JSON.stringify(replacement)};
const profile={profile_id:'daily',name:'Frozen Profile',enabled:true};
const input={profile,expectedFingerprint:null};
const calls=[], rows=new Map();
let physical=library;
const list=results=>({object:'list',results,has_more:false,next_cursor:null});
const notion={apiOrigin:'https://api.notion.com',version:Effect.succeed('profile-binding-fixture'),credentialIdentity:Effect.succeed('fixed-profile-principal'),request:(path,body,options)=>Effect.suspend(()=>{
 const method=options?.method??(body===undefined?'GET':'POST');calls.push({path,method});
 if(path==='v1/users/me')return Effect.succeed({object:'user',id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'});
 const structural=librarySchemaResponse(path,physical);
 if(structural!==undefined)return Effect.succeed(structural);
 const query=/^v1\\/data_sources\\/([^/]+)\\/query$/.exec(path.split('?')[0]);
 if(query)return Effect.succeed(list(rows.get(query[1])??[]));
 if(path==='v1/pages'&&method==='POST')return Effect.fail(fail('WRITE_OUTCOME_UNKNOWN','The original CREATE response was lost'));
 return Effect.fail(fail('UNEXPECTED','Unexpected Profile boundary request',{path,method}));
})};
Effect.runPromise(Effect.gen(function*(){
 const store=yield* Store;
 const plan=yield* prepareSharedProfileChange(library,input);
 const keys=()=>store.listKeys('operations/shared-profile-pending/');
 const pending=()=>Effect.gen(function*(){const k=yield* keys();return k.length===1?yield* store.readJson(k[0],Schema.Unknown):null;});
 const showCurrent=owner=>{
  const envelope=canonicalSharedJson({version:1,operation_id:plan.operation_id,payload:plan.payload});
  const fields=owner.records.property_ids;
  const rich=value=>({type:'rich_text',rich_text:[{type:'text',text:{content:value}}],has_more:false});
  const values={Name:{type:'title',title:[{type:'text',text:{content:profile.name}}]},'Record ID':rich(plan.record_id),Kind:{type:'select',select:{name:'profile'}},'Entity ID':rich(profile.profile_id),Hash:rich(createHash('sha256').update(envelope).digest('hex')),Payload:rich(envelope),Skill:{type:'relation',relation:[],has_more:false},Origin:{type:'relation',relation:[],has_more:false}};
  rows.set(owner.records.data_source_id,[{object:'page',id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',parent:{type:'data_source_id',database_id:owner.records.database_id,data_source_id:owner.records.data_source_id},properties:Object.fromEntries(Object.entries(values).map(([name,value])=>[fields[name],{...value,id:fields[name]}]))}]);
 };
 const outcome=result=>result._tag==='Failure'?{code:result.failure.code,message:result.failure.message}:{status:result.success?.status??null};
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
  let stdout = "",
    stderr = ""
  worker.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk
  })
  worker.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk
  })
  const [exit] = await once(worker, "close")
  expect(exit, stderr).toBe(0)
  return JSON.parse(stdout)
}

test("real Store Profile recovery cannot consume an unknown CREATE through replacement Library bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-profile-binding-"))
  try {
    const first = await run(
      root,
      `
const result=yield* saveSharedProfile(library,input).pipe(Effect.result);
console.log(JSON.stringify({result:outcome(result),keys:yield* keys(),pending:yield* pending(),calls}));`,
    )
    expect(first.result.code, JSON.stringify(first)).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(first.keys).toHaveLength(1)
    expect(
      first.calls.filter(
        (row: { method: string; path: string }) => row.method === "POST" && row.path === "v1/pages",
      ),
    ).toHaveLength(1)

    const restarted = await run(
      root,
      `
const original=yield* pending();
const rewrite=yield* store.writeJson((yield* keys())[0],{...original,library:replacement}).pipe(Effect.result);
const rejected=[];
for(const changed of [replacement,{...library,files:{...library.files,database_id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'}},{...library,sources:{...library.sources,property_ids:{...library.sources.property_ids,Name:'replacement-title'}}}]){
 physical=changed;showCurrent(changed);
 rejected.push(outcome(yield* saveSharedProfile(changed,{...input,mode:'reconcile'}).pipe(Effect.result)));
}
console.log(JSON.stringify({rewrite:outcome(rewrite),rejected,keys:yield* keys(),pending:yield* pending(),calls}));`,
    )
    expect(
      restarted.rejected.map((row: { code?: string }) => row.code),
      JSON.stringify(restarted),
    ).toEqual(["LIBRARY_BINDING_CHANGED", "LIBRARY_BINDING_CHANGED", "LIBRARY_BINDING_CHANGED"])
    expect(restarted.rewrite.code).toBe("STATE_CONFLICT")
    expect(restarted.keys).toEqual(first.keys)
    expect(restarted.pending).toEqual(first.pending)
    expect(restarted.calls).toEqual([authentication, authentication, authentication])
    expect(first.pending.library).toEqual(currentLibrary)

    const drifted = await run(
      root,
      `
physical=replacement;showCurrent(library);
const result=yield* saveSharedProfile(library,{...input,mode:'reconcile'}).pipe(Effect.result);
console.log(JSON.stringify({result:outcome(result),keys:yield* keys(),pending:yield* pending(),calls}));`,
    )
    expect(drifted.result.code).toBe("LIBRARY_BINDING_CHANGED")
    expect(drifted.keys).toEqual(first.keys)
    expect(drifted.pending).toEqual(first.pending)
    expect(drifted.calls.every((row: { method: string }) => row.method === "GET")).toBe(true)

    const completed = await run(
      root,
      `
showCurrent(library);
const result=yield* saveSharedProfile(library,{...input,mode:'reconcile'}).pipe(Effect.result);
console.log(JSON.stringify({result:outcome(result),keys:yield* keys(),calls}));`,
    )
    expect(completed.result).toEqual({ status: "current_matches" })
    expect(completed.keys).toEqual([])
    expect(
      completed.calls.some(
        (row: { method: string; path: string }) =>
          (row.path === "v1/pages" && row.method === "POST") || row.method === "PATCH",
      ),
    ).toBe(false)
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
  }
}, 60_000)

test("a Profile pending without its frozen Library fails closed and retains the original intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-profile-unbound-"))
  try {
    const observed = await run(
      root,
      `
const scope=yield* authScope,key=(yield* sharedProfilePendingPrefix(scope,library.library_id,profile.profile_id))+'pending.json';
const legacy={version:2,scope,library_id:library.library_id,profile_id:profile.profile_id,target_page_id:null,plan};
yield* store.writeJson(key,legacy);showCurrent(library);calls.length=0;
const result=yield* saveSharedProfile(library,{...input,mode:'reconcile'}).pipe(Effect.result);
console.log(JSON.stringify({result:outcome(result),keys:yield* keys(),pending:yield* pending(),legacy,calls}));`,
    )
    expect(observed.result.code).toBe("STATE_MIGRATION_REQUIRED")
    expect(observed.result.message).toContain("frozen Library")
    expect(observed.keys).toHaveLength(1)
    expect(observed.pending).toEqual(observed.legacy)
    expect(observed.calls).toEqual([authentication])
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
  }
}, 30_000)

test("a Profile owner keeps the same local fence when the root receives a replacement Records table", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-profile-fence-"))
  try {
    const observed = await run(
      root,
      `
yield* authScope;calls.length=0;physical=replacement;
const result=yield* withLocalLocks(store.root,['profile:'+library.library_id+':'+profile.profile_id],saveSharedProfile(replacement,input)).pipe(Effect.result);
console.log(JSON.stringify({result:outcome(result),keys:yield* keys(),calls}));`,
    )
    expect(observed.result.code).toBe("SYNC_LOCKED")
    expect(observed.keys).toEqual([])
    expect(observed.calls).toEqual([authentication])
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
  }
}, 30_000)
