import { expect, test } from "vitest"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const core = new URL("../src/", import.meta.url).pathname
const fixture = new URL("./shared-create-fixture.ts", import.meta.url).pathname

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
import {prepareSharedCreate,executeSharedCreate} from ${JSON.stringify(core + "shared-create.ts")};
import {reviewSharedCreateRestoration,applySharedCreateRestoration} from ${JSON.stringify(core + "shared-create-restoration.ts")};
import {observeSharedCreateLinkFile} from ${JSON.stringify(core + "shared-create-link-repair.ts")};
import {normalizeObservedBody} from ${JSON.stringify(core + "shared-file-state.ts")};
import {mapMarkdownLinks} from ${JSON.stringify(core + "typed-links.ts")};
import {sharedCreateFixture} from ${JSON.stringify(fixture)};
const root=${JSON.stringify(root)},reopen=${reopen};
process.env.NTN_SKILLS_HOME=root+'/state';
process.env.NTN_SKILLS_CONFIG_HOME=root+'/config';
process.env.NTN_SKILLS_CACHE_HOME=root+'/cache';
await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const store=yield* Store;
  yield* Effect.promise(async()=>{
    const f=sharedCreateFixture({readback:wire=>normalizeObservedBody(mapMarkdownLinks(wire.replace('<h1>Root</h1>','# Root').replace('<h1>Guide</h1>','# Guide'),href=>href==='next.md'?'https://'+href:href))});
    // The remote fixture checks that an original plan exists before allocating.
    // Mirror only successful SQLite writes for that check; all reads stay real.
    const durable={...store,writeJson:(key,value)=>store.writeJson(key,value).pipe(Effect.tap(()=>Effect.sync(()=>f.base.json.set(key,structuredClone(value)))))};
    const run=effect=>f.run(effect.pipe(Effect.provideService(Store,durable)));
    let plan,review,page;
    if(reopen){
      const saved=JSON.parse(await readFile(root+'/remote-fixture.json','utf8'));
      ({plan,review,page}=saved);
      for(const [name,map]of [['skills',f.skills],['files',f.files],['records',f.base.records],['bodies',f.base.bodies]]){
        map.clear();for(const [key,value]of saved[name])map.set(key,value);
      }
    }else{
      const encode=value=>new TextEncoder().encode(value);
      plan=await run(prepareSharedCreate(f.library,{portable:{kind:'skill',name:'Real SQLite linked original',description:'Exact original link repair preflight',main:'SKILL.md',files:[{path:'SKILL.md',bytes:encode('# Root\\n\\nRead [Guide](references/guide.md).\\n')},{path:'references/guide.md',bytes:encode('# Guide\\n\\nRead [Next](next.md).\\n')},{path:'references/next.md',bytes:encode('# Next\\n\\nRead [Root](../SKILL.md).\\n')}]},completeResources:true,markdownImport:true}));
      const failed=await run(Effect.flip(executeSharedCreate(f.library,{plan,mode:'create'})));
      assert.equal(failed.code,'SHARED_CREATE_BODY_MISMATCH',JSON.stringify(failed));
      page=failed.details.skill_page_id;
      review=await run(reviewSharedCreateRestoration({entry:f.library.skills.database_id,plan,target:page,repairLocalLinks:true}));
      assert.equal(review.version,3);
      await writeFile(root+'/remote-fixture.json',JSON.stringify({plan,review,page,skills:[...f.skills],files:[...f.files],records:[...f.base.records],bodies:[...f.base.bodies]}),{flag:'wx'});
    }
    f.clear();
    const scope=await run(authScope),file=plan.files.find(file=>file.path===plan.entrypoint);
    const key='operations/shared-create-link-repairs/'+scope+'/'+plan.operation_id+'/'+file.file_id+'.json';
    const before=await run(store.readJson(key,Schema.Unknown));
    assert.equal(before===undefined,!reopen);
    const dry=await run(applySharedCreateRestoration({entry:f.library.skills.database_id,plan,review,reviewId:review.review_id,dryRun:true}));
    assert.equal(dry.status,'planned');
    assert.equal(dry.write_plan.maximum_native_page_creates,1);
    assert.equal(dry.write_plan.existing_body_patches,3);
    assert.equal(await run(store.readJson(key,Schema.Unknown))===undefined,!reopen);
    const observed=await run(observeSharedCreateLinkFile(f.library,plan,review,file,page,review.bindings));
    assert.equal(observed.phase,'before');
    const saved=await run(store.readJson(key,Schema.Unknown));
    assert.equal(saved.before_markdown,observed.markdown);
    assert.equal(saved.original_operation_id,plan.operation_id);
    if(reopen)assert.deepEqual(saved,before);
    await run(store.writeJson(key,saved));
    const changed=await run(Effect.flip(store.writeJson(key,{...saved,before_markdown:'replacement'})));
    assert.equal(changed.code,'STATE_CONFLICT');
    const invalid=[key.replace('/'+scope+'/','/foreign/'),key.replace('/'+plan.operation_id+'/','/skill-create-invalid/'),key.replace('/'+file.file_id+'.json','/invalid.json'),key.replace('/'+file.file_id+'.json','/../'+file.file_id+'.json')];
    for(const address of invalid){
      assert.equal((await run(Effect.flip(store.readJson(address,Schema.Unknown)))).code,'INVALID_ARGUMENT');
      assert.equal((await run(Effect.flip(store.writeJson(address,saved)))).code,'INVALID_ARGUMENT');
    }
    await run(clearCache(undefined,{all:true}));
    assert.deepEqual(await run(store.readJson(key,Schema.Unknown)),saved);
    assert.deepEqual(await run(store.listKeys('operations/shared-create-link-repairs')),[key]);
    assert.equal(f.writes().length,0);
    console.log(JSON.stringify({reopen,planned:true,immutable:true,preserved_after_cache_clear:true,invalid_addresses:invalid.length,remote_writes:f.writes().length,review_id:review.review_id,key}));
  });
})).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(NodeServices.layer))),Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv()))));
`
}

test("v3 preflight and immutable preimages use the real SQLite Store across Node restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-create-links-sqlite-"))
  let original: { review_id: string; key: string } | undefined
  for (const reopen of [false, true]) {
    const result = await child(program(root, reopen))
    expect(result.exit, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report).toMatchObject({
      reopen,
      planned: true,
      immutable: true,
      preserved_after_cache_clear: true,
      invalid_addresses: 4,
      remote_writes: 0,
    })
    if (original === undefined) original = report
    else {
      expect(report.review_id).toBe(original.review_id)
      expect(report.key).toBe(original.key)
    }
  }
}, 60_000)
