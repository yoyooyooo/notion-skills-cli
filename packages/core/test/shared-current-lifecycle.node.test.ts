import { expect, test } from "vitest"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { trashPath } from "../src/local-locks.ts"

const core = new URL("../src/", import.meta.url)
const samples = [
  {
    path: "SKILL.md",
    mode: "100644",
    text: "---\r\nname: Current complete tree\r\ndescription: Exact current content\r\nlicense: MIT\r\n---\r\n# Root\r\n\r\nRead references/policy.md. The review_rule is CEDAR_3.\r\n\r\n[Policy](references/policy.md) and [Guide](references/guide.md#进程加载对账).\r\n",
  },
  {
    path: "references/policy.md",
    mode: "100644",
    text: "# Policy\n\nKeep [the exact target](https://example.test/policy?q=1#part) and `review_rule`.\n",
  },
  {
    path: "references/guide.md",
    mode: "100644",
    text: "# 进程加载对账\n\nKeep prose + signs and `a + b`. Read [Next](next.md).\n\n| Selector | Handler |\n| --- | --- |\n| `:focus` | `.track_focus()` + `on_focus()` / `on_blur()` |\n",
  },
  { path: "references/next.md", mode: "100644", text: "# Next\n\n[Root](../SKILL.md)\n" },
  {
    path: "scripts/tool.mjs",
    mode: "100755",
    text: "#!/usr/bin/env node\n// Preserve the complete original; never execute this fixture.\nprocess.stdout.write('current\\n');\n",
  },
]

async function child(source: string) {
  const worker = spawn(process.execPath, ["--input-type=module", "-e", source], {
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
  const [exit, signal] = await once(worker, "close")
  return { exit, signal, stdout, stderr }
}

test.each([
  ["shared-current-operation.ts", "CurrentWritePendingSchema"],
  ["shared-current-write.ts", "writeCurrentSkill"],
  ["shared-current-resource.ts", "prepareCurrentSharedResource"],
  ["shared-current-source.ts", "resolveCurrentSharedSources"],
  ["shared-snapshot.ts", "openSharedSnapshot"],
  ["consumer.ts", "consume"],
])("fresh native Node initializes current %s without an ESM cycle", async (file, entry) => {
  const result = await child(
    `const module = await import(${JSON.stringify(new URL(file!, core).href)});
if (typeof module[${JSON.stringify(entry)}] === 'undefined') throw Error('Missing current entry');
console.log('loaded');`,
  )
  expect(result, JSON.stringify(result)).toMatchObject({
    exit: 0,
    signal: null,
    stdout: "loaded\n",
    stderr: "",
  })
})

function program(root: string, phase: "write" | "resume" | "consume") {
  const from = (file: string) => JSON.stringify(new URL(file, core).href)
  return `
import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {ConfigProvider,Effect,Layer,Schema} from ${JSON.stringify(import.meta.resolve("effect"))};
import {Store,StoreLive} from ${from("store.ts")};
import {authScope} from ${from("catalog.ts")};
import {clearCache} from ${from("cache.ts")};
import {prepareCurrentSkillWrite,writeCurrentSkill} from ${from("shared-current-write.ts")};
import {openSharedSnapshot} from ${from("shared-snapshot.ts")};
import {snapshotPortable,exportPortable} from ${from("export.ts")};
import {currentWriteFixture,library} from ${JSON.stringify(new URL("./shared-current-write-fixture.ts", import.meta.url).href)};
const root=${JSON.stringify(root)},phase=${JSON.stringify(phase)},samples=${JSON.stringify(samples)};
const base=root+(phase==='consume'?'/consumer':'/writer');
process.env.NTN_SKILLS_HOME=base+'/state';
process.env.NTN_SKILLS_CONFIG_HOME=base+'/config';
process.env.NTN_SKILLS_CACHE_HOME=base+'/cache';
const f=currentWriteFixture(root);
const files=samples.map(({text,...file})=>({...file,bytes:new TextEncoder().encode(text)}));
const input={skill_id:'current-complete',kind:'skill',name:'Current complete tree',description:'Exact current content',files};
if(phase!=='write'){
  const saved=JSON.parse(await readFile(root+'/remote.json','utf8'));
  for(const [key,value] of saved.pages)f.pages.set(key,value);
  for(const [key,value] of saved.blocks)f.blocks.set(key,value);
}
await Effect.runPromise(Effect.gen(function*(){
 const store=yield* Store;
 return yield* Effect.promise(async()=>{
 const run=effect=>f.run(effect.pipe(Effect.provideService(Store,store)));
 const pending=()=>run(store.listKeys('operations/current-write-pending'));
 const plan=await run(prepareCurrentSkillWrite(input));
 if(phase==='write'){
  const seed=await run(prepareCurrentSkillWrite({...input,files:[...files,{path:'obsolete.txt',bytes:new TextEncoder().encode('Remove this current File.\\n')}]}));
  await run(writeCurrentSkill(library,{plan:seed,operation_id:'seed-current'}));
  f.clearCalls();f.failNext({kind:'retire-file',outcome:'accepted'});
  const failed=await run(writeCurrentSkill(library,{plan,operation_id:'replace-current'}).pipe(Effect.result));
  assert.equal(failed._tag,'Failure');assert.equal(failed.failure.code,'WRITE_OUTCOME_UNKNOWN');
  assert.equal((await pending()).length,1);
  const page=String(f.table('skills')[0].id);
  const blocked=await run(openSharedSnapshot({library,target:page,scope:await run(authScope),startedAt:Date.now()}).pipe(Effect.result));
  assert.equal(blocked._tag,'Failure');assert.equal(blocked.failure.code,'CURRENT_OPERATION_PENDING');
  await writeFile(root+'/remote.json',JSON.stringify({pages:[...f.pages],blocks:[...f.blocks]}));
  console.log(JSON.stringify({phase,unknown:true,pending:1,blocked:blocked.failure.code}));
 }else if(phase==='resume'){
  const key=(await pending())[0];assert.ok(key);
  const before=await run(store.readJson(key,Schema.Unknown));
  const changed=await run(prepareCurrentSkillWrite({...input,files:files.map((file,index)=>index===0?{...file,bytes:new TextEncoder().encode(samples[0].text.replace('references/policy.md)','https://example.invalid/replaced)'))}:file)}));
  const refused=await run(writeCurrentSkill(library,{plan:changed,operation_id:'replace-current',mode:'resume'}).pipe(Effect.result));
  assert.equal(refused._tag,'Failure');assert.equal(refused.failure.code,'CURRENT_OPERATION_PENDING');
  assert.equal(f.mutations().length,0);assert.deepEqual(await run(store.readJson(key,Schema.Unknown)),before);
  await run(clearCache(undefined,{all:true}));
  assert.deepEqual(await run(store.readJson(key,Schema.Unknown)),before);
  f.clearCalls();
  const resumed=await run(writeCurrentSkill(library,{plan,operation_id:'replace-current',mode:'resume'}));
  assert.equal(resumed.state,'ready');assert.equal((await pending()).length,0);
  assert.equal(f.calls.filter(call=>call.method==='POST'&&call.path==='v1/pages').length,0);
  const fileIds=new Set(f.table('files',false).map(page=>String(page.id)));
  assert.equal(f.calls.filter(call=>call.method==='PATCH'&&fileIds.has(call.path.split('/')[2])).length,0);
  f.clearCalls();
  assert.equal((await run(writeCurrentSkill(library,{plan,operation_id:'current-noop'}))).status,'unchanged');
  assert.equal(f.mutations().length,0);
  await writeFile(root+'/remote.json',JSON.stringify({pages:[...f.pages],blocks:[...f.blocks]}));
  console.log(JSON.stringify({phase,changed_links_refused:true,pending:0,repeated_file_archives:0,noop_writes:0}));
 }else{
  assert.equal((await pending()).length,0);
  const page=String(f.table('skills')[0].id);
  const snapshot=await run(openSharedSnapshot({library,target:page,scope:await run(authScope),startedAt:Date.now(),forceFull:true}));
  const portable=await run(snapshotPortable(snapshot));
  assert.deepEqual(portable.files.map(file=>file.path).sort(),files.map(file=>file.path).sort());
  for(const original of files){
   const file=portable.files.find(file=>file.path===original.path);assert.ok(file);
   assert.deepEqual(new Uint8Array(file.bytes),original.bytes);assert.equal(file.mode,original.mode);
  }
  await run(exportPortable(portable,{output:root+'/exported',format:'directory'}));
  for(const original of files)assert.deepEqual(new Uint8Array(await readFile(root+'/exported/'+original.path)),original.bytes);
  assert.equal((await stat(root+'/exported/scripts/tool.mjs')).mode&0o777,0o700);
  assert.equal(f.mutations().length,0);
  assert.equal((await run(store.listKeys('operations'))).length,0);
  console.log(JSON.stringify({phase,files:portable.files.length,exact_bytes:true,executable_mode:true,consumer_writes:0}));
 }
 });
}).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(NodeServices.layer))),Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv()))));
`
}

test("current intent survives real SQLite restart and a cold consumer gets every exact authored file", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-current-node-lifecycle-"))
  try {
    for (const phase of ["write", "resume", "consume"] as const) {
      const result = await child(program(root, phase))
      // Runtime warnings are diagnostics; exit and the child assertions decide success.
      expect(result.exit, result.stderr + result.stdout).toBe(0)
      expect(result.signal).toBeNull()
      expect(JSON.parse(result.stdout).phase).toBe(phase)
    }
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
  }
}, 60_000)
