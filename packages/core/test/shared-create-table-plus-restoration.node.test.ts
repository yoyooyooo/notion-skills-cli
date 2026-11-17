import { expect, test } from "vitest"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readSkill, listSkill, readResources } from "../../cli/src/sdk.ts"
import { assertImportedMarkdownContent } from "../src/shared-import-markdown.ts"
import { parseYaml } from "../src/yaml.ts"
import { tablePlusPortable } from "./shared-create-table-plus-restoration-fixture.ts"

const core = new URL("../src/", import.meta.url).pathname
const fixture = new URL("./shared-create-table-plus-restoration-fixture.ts", import.meta.url)
  .pathname
const { startSdkSourceFixture } = await import(
  new URL("../../../scripts/sdk-source-fixture.mjs", import.meta.url).href
)

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
  const [exit] = await once(worker, "close")
  return { exit, stdout, stderr }
}

function program(root: string, reopen: boolean) {
  return `
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {ConfigProvider,Effect,Layer,Schema} from ${JSON.stringify(import.meta.resolve("effect"))};
import {Store,StoreLive} from ${JSON.stringify(core + "store.ts")};
import {clearCache} from ${JSON.stringify(core + "cache.ts")};
import {authScope} from ${JSON.stringify(core + "catalog.ts")};
import {fail,property} from ${JSON.stringify(core + "model.ts")};
import {LIBRARY_MARKER} from ${JSON.stringify(core + "shared-library-model.ts")};
import {prepareSharedCreate,executeSharedCreate} from ${JSON.stringify(core + "shared-create.ts")};
import {reviewSharedCreateRestoration,applySharedCreateRestoration} from ${JSON.stringify(core + "shared-create-restoration.ts")};
import {querySharedRecords,canonicalSharedJson} from ${JSON.stringify(core + "shared-records.ts")};
import {sharedCreateOutcomeId} from ${JSON.stringify(core + "shared-create-outcome.ts")};
import {updateSkill} from ${JSON.stringify(core + "command-operations.ts")};
import {tablePlusCreateFixture,tablePlusPortable,tablePlusPath} from ${JSON.stringify(fixture)};
const root=${JSON.stringify(root)},reopen=${reopen};
process.env.NTN_SKILLS_HOME=root+'/writer/state';
process.env.NTN_SKILLS_CONFIG_HOME=root+'/writer/config';
process.env.NTN_SKILLS_CACHE_HOME=root+'/writer/cache';
await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const store=yield* Store;
  yield* Effect.promise(async()=>{
    const f=tablePlusCreateFixture();
    // Only mirror successful real SQLite writes for the controlled server's
    // original-plan precondition. Every product read uses the actual Store.
    const durable={...store,writeJson:(key,value)=>store.writeJson(key,value).pipe(Effect.tap(()=>Effect.sync(()=>f.base.json.set(key,structuredClone(value)))))};
    const run=effect=>f.run(effect.pipe(Effect.provideService(Store,durable)));
    let plan,review,page,originalFailure;
    if(reopen){
      const saved=JSON.parse(await readFile(root+'/remote-fixture.json','utf8'));
      ({plan,review,page,originalFailure}=saved);
      for(const [name,map]of [['skills',f.skills],['files',f.files],['records',f.base.records],['bodies',f.base.bodies]]){
        map.clear();for(const [key,value]of saved[name])map.set(key,value);
      }
      for(const key of await run(store.listKeys('operations/shared-native-create/')))
        f.base.json.set(key,await run(store.readJson(key,Schema.Unknown)));
    }else{
      plan=await run(prepareSharedCreate(f.library,{portable:tablePlusPortable(),enabled:false,completeResources:true,markdownImport:true}));
      const failed=await run(Effect.flip(executeSharedCreate(f.library,{plan,mode:'create'})));
      assert.equal(failed.code,'SHARED_CREATE_BODY_MISMATCH',JSON.stringify(failed));
      page=failed.details.skill_page_id;
      const rows=await run(querySharedRecords(f.library,{skillPageId:page,kind:'operation',recordId:sharedCreateOutcomeId(plan.operation_id)}));
      originalFailure=canonicalSharedJson(rows[0]);
      review=await run(reviewSharedCreateRestoration({entry:f.library.skills.database_id,plan,target:page,repairTablePlus:tablePlusPath}));
      assert.equal(review.version,4);
    }
    const apply={entry:f.library.skills.database_id,plan,review,reviewId:review.review_id};
    const scope=await run(authScope),file=plan.files.find(file=>file.path===tablePlusPath);
    const key='operations/shared-create-link-repairs/'+scope+'/'+plan.operation_id+'/'+file.file_id+'.json';
    f.clear();
    if(!reopen){
      assert.equal((await run(applySharedCreateRestoration({...apply,dryRun:true}))).status,'planned');
      assert.equal(await run(store.readJson(key,Schema.Unknown)),undefined);
      assert.equal(f.writes().length,0);
      let interrupted=false;
      const interruptedStore={...durable,writeJson:(address,value)=>durable.writeJson(address,value).pipe(Effect.flatMap(()=>{
        if(!interrupted&&address.includes('/source-ack-')&&property(property(value).response).id===review.bindings.at(-1).page_id&&typeof property(property(value).response).markdown==='string'){
          interrupted=true;return Effect.fail(fail('STATE_CONFLICT','Controlled interruption after durable repair ACK'));
        }
        return Effect.void;
      }))};
      const error=await f.run(Effect.flip(applySharedCreateRestoration(apply).pipe(Effect.provideService(Store,interruptedStore))));
      assert.equal(interrupted,true);assert.equal(error.code,'SOURCE_WRITE_UNKNOWN');
      assert.equal(f.calls.filter(call=>call.method==='PATCH').length,1);
      assert.equal(f.nativeCreates().length,0);
      const before=await run(store.readJson(key,Schema.Unknown));
      assert.equal(before.before_markdown,review.table_plus.before_markdown);
      await run(store.writeJson(key,before));
      assert.equal((await run(Effect.flip(store.writeJson(key,{...before,before_markdown:'replacement'})))).code,'STATE_CONFLICT');
      await run(clearCache(undefined,{all:true}));
      assert.deepEqual(await run(store.readJson(key,Schema.Unknown)),before);
      await writeFile(root+'/remote-fixture.json',JSON.stringify({plan,review,page,originalFailure,skills:[...f.skills],files:[...f.files],records:[...f.base.records],bodies:[...f.base.bodies]}),{flag:'wx'});
      console.log(JSON.stringify({reopen,repair_ack_durable:true,suffix_creates:0,body_patches:1,preimage_immutable:true,key}));
    }else{
      const before=await run(store.readJson(key,Schema.Unknown));
      assert.equal(before.before_markdown,review.table_plus.before_markdown);
      const recovered=await run(applySharedCreateRestoration(apply));
      assert.equal(recovered.verified,true);
      assert.equal(f.calls.filter(call=>call.method==='PATCH').length,0);
      assert.equal(f.nativeCreates().length,2);
      const rows=await run(querySharedRecords(f.library,{skillPageId:page,kind:'operation',recordId:sharedCreateOutcomeId(plan.operation_id)}));
      assert.equal(canonicalSharedJson(rows[0]),originalFailure);
      const enabled=await run(updateSkill(page,{database:f.library.skills.database_id,enabled:true}));
      assert.equal(enabled.verified,true);
      assert.equal(property(property(f.skills.get(page)).properties).enabled.checkbox,true);
      const notion={
        library:f.library,
        database:{object:'database',id:f.library.skills.database_id,database_type:null,title:[{plain_text:'Cold table recovery'}],description:[{plain_text:LIBRARY_MARKER+JSON.stringify(f.library)}],data_sources:[{id:f.library.skills.data_source_id,name:'Skills'}]},
        main:f.skills.get(page),skills:[...f.skills.values()],files:[...f.files.values()],records:[...f.base.records.values()],bodies:Object.fromEntries(f.base.bodies),
      };
      await writeFile(root+'/consumer-fixture.json',JSON.stringify({notion}),{flag:'wx'});
      console.log(JSON.stringify({reopen,verified:true,original_failure_preserved:true,suffix_creates:2,body_patches:0,enabled_separately:true,page,library:f.library}));
    }
  });
})).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(NodeServices.layer))),Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv()))));
`
}

test("v4 survives a real SQLite ACK interruption, then a fresh ordinary SDK consumes the full recovered tree", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "ntn-create-table-sqlite-"))
  const first = await child(program(root, false))
  expect(first.exit, first.stderr).toBe(0)
  expect(JSON.parse(first.stdout)).toMatchObject({
    repair_ack_durable: true,
    suffix_creates: 0,
    body_patches: 1,
    preimage_immutable: true,
  })
  const resumed = await child(program(root, true))
  expect(resumed.exit, resumed.stderr).toBe(0)
  const report = JSON.parse(resumed.stdout)
  expect(report).toMatchObject({
    verified: true,
    original_failure_preserved: true,
    suffix_creates: 2,
    body_patches: 0,
    enabled_separately: true,
  })
  const remote = JSON.parse(await readFile(join(root, "consumer-fixture.json"), "utf8"))
  const source = await startSdkSourceFixture(remote, join(root, "sdk-http.jsonl"))
  const env = {
    NOTION_API_TOKEN: "controlled-cold-table-consumer",
    NOTION_WORKSPACE_ID: "",
    NOTION_API_BASE_URL: source.origin,
    NTN_SKILLS_HOME: join(root, "consumer/state"),
    NTN_SKILLS_CONFIG_HOME: join(root, "consumer/config"),
    NTN_SKILLS_CACHE_HOME: join(root, "consumer/cache"),
    NTN_SKILLS_SCHEDULER_ROOT: join(root, "scheduler"),
    NTN_SKILLS_NOTION_INTERVAL_MS: "100",
    NTN_SKILLS_REQUEST_TRACE_LIMIT: "10000",
  }
  const options = {
    env,
    database: report.library.skills.database_id,
    readOnly: true,
    metrics: true,
  }
  try {
    const main = await readSkill(report.page, { ...options, refresh: true })
    if (!("content" in main)) throw new Error("Cold ordinary SDK read must return complete content")
    const originalMain = tablePlusPortable().files.find((file) => file.path === "SKILL.md")!
    const split = (value: string) => /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(value)!
    const expected = split(new TextDecoder().decode(originalMain.bytes))
    const observed = split(main.content)
    expect(parseYaml(observed[1]!)).toEqual(parseYaml(expected[1]!))
    expect(() => assertImportedMarkdownContent(expected[2]!, observed[2]!)).not.toThrow()
    const directory = new URL(main.ref)
    directory.pathname = "/"
    directory.searchParams.delete("file_id")
    const listing = await listSkill(directory.toString(), options)
    expect(listing.files.map((file) => file.path).sort()).toEqual(
      tablePlusPortable()
        .files.map((file) => file.path)
        .sort(),
    )
    const refs = listing.files.filter((file) => file.path !== "SKILL.md").map((file) => file.ref)
    const resources = await readResources(
      { version: 1, refs, budget: { maxFiles: 4, maxBytes: 20000, timeBudgetMs: 30000 } },
      options,
    )
    expect(resources.status).toBe("ready")
    if (resources.status !== "ready") throw new Error(JSON.stringify(resources))
    expect(resources.effects?.remote_writes).toBe("none")
    expect(resources.selection.snapshot_id).toBe(main.snapshot_id)
    expect(resources.selection.version_id).toBe(main.version_id)
    for (const original of tablePlusPortable().files.filter((file) => file.path !== "SKILL.md")) {
      const file = resources.files.find((file) => file.path === original.path)!
      expect(file.mode).toBe(original.mode)
      if (original.path.endsWith(".md"))
        expect(() =>
          assertImportedMarkdownContent(new TextDecoder().decode(original.bytes), file.content),
        ).not.toThrow()
      else {
        expect(file.content).toBe(new TextDecoder().decode(original.bytes))
        expect(file.sha256).toBe(createHash("sha256").update(original.bytes).digest("hex"))
      }
    }
    expect(source.unexpected).toEqual([])
    expect(
      source.requests.filter(
        (row: { method: string; path: string }) =>
          row.method === "PATCH" ||
          row.method === "DELETE" ||
          (row.method === "POST" && !row.path.endsWith("/query")),
      ),
    ).toHaveLength(0)
  } finally {
    await source.close()
    console.info(JSON.stringify({ tableRecoveryEvidence: root }))
  }
}, 60_000)
