import { expect, test, vi } from "vitest"
import { Effect, Schema } from "effect"
import { spawn } from "node:child_process"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CurrentEvidenceSchema, type CurrentFact } from "../src/current-evidence-model.ts"
import { trashPath } from "../src/local-locks.ts"

const scope = "a".repeat(64)
const rootFact: CurrentFact = { identity: "page:root", fingerprint: "1".repeat(64) }
const requiredFact: CurrentFact = { identity: "page:required", fingerprint: "2".repeat(64) }
const membersFact: CurrentFact = { identity: "files:library:required", fingerprint: "3".repeat(64) }
const relationsFact: CurrentFact = {
  identity: "relations:library:root",
  fingerprint: "4".repeat(64),
}
const changed = (fact: CurrentFact): CurrentFact => ({ ...fact, fingerprint: "b".repeat(64) })
const replySchema = Schema.Struct({ pid: Schema.Number, value: Schema.Unknown })

function program(directory: string, body: string) {
  const module = (name: string) => new URL(`../src/${name}.ts`, import.meta.url).href
  const environment = {
    NTN_SKILLS_HOME: join(directory, "state"),
    NTN_SKILLS_CONFIG_HOME: join(directory, "config"),
    NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
  }
  return `
import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {ConfigProvider,Crypto,Effect,Layer,Schema} from ${JSON.stringify(import.meta.resolve("effect"))};
import {writeFile} from "node:fs/promises";
import {Store,StoreLive,sha256} from ${JSON.stringify(module("store"))};
import {CURRENT_EVIDENCE_GENERATION} from ${JSON.stringify(module("current-evidence-model"))};
import {assertCurrentEvidenceSet} from ${JSON.stringify(module("current-evidence"))};
const scope=${JSON.stringify(scope)};
const task=Effect.gen(function*(){
  const store=yield* Store, facts=store.currentEvidence;
  if(facts===undefined) throw new Error("The real Store must expose current evidence");
  const observe=(expected)=>Effect.gen(function*(){
    const generation=yield* store.reserveCacheGeneration(scope,CURRENT_EVIDENCE_GENERATION);
    yield* facts.observe({scope,generation,observed_at:generation*1000,facts:expected});
    return generation;
  });
  const resultCode=(effect)=>effect.pipe(Effect.result,Effect.map(result=>
    result._tag==="Success"?"ok":result.failure.code));
  ${body}
});
Effect.runPromise(Effect.scoped(task.pipe(
  Effect.provide(StoreLive.pipe(Layer.provideMerge(NodeServices.layer))),
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(${JSON.stringify(environment)})))
))).then(value=>console.log(JSON.stringify({pid:process.pid,value})))
.catch(error=>{console.error(String(error));process.exitCode=1});
`
}

function start(directory: string, body: string) {
  const worker = spawn(process.execPath, ["--input-type=module", "-e", program(directory, body)], {
    stdio: ["pipe", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  worker.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk
  })
  worker.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk
  })
  const done = new Promise<number | null>((resolve, reject) => {
    worker.once("error", reject)
    worker.once("close", resolve)
  })
  const result = done.then((exit) => {
    expect(exit, stderr).toBe(0)
    return Schema.decodeUnknownSync(replySchema)(JSON.parse(stdout))
  })
  // A held process can fail before its ready signal. Preserve that failure for
  // the caller without reporting an unhandled rejection while it waits.
  void result.catch(() => undefined)
  return { worker, result }
}

const child = (directory: string, body: string) => start(directory, body).result

async function isolated(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "ntn-current-evidence-"))
  try {
    await run(directory)
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
  }
}

test("unchanged observations in another real Store preserve the accepted semantic epoch", async () => {
  await isolated(async (directory) => {
    const expected = [rootFact, requiredFact]
    const first = await child(
      directory,
      `
      const generation=yield* observe(${JSON.stringify(expected)});
      return {generation,evidence:yield* facts.capture(scope,${JSON.stringify(expected)})};
    `,
    )
    const initial = Schema.decodeUnknownSync(
      Schema.Struct({
        generation: Schema.Number,
        evidence: CurrentEvidenceSchema,
      }),
    )(first.value)
    const second = await child(
      directory,
      `
      const generation=yield* observe(${JSON.stringify(expected)});
      return {generation,evidence:yield* facts.capture(scope,${JSON.stringify(expected)}),
        matches:yield* facts.matches(${JSON.stringify(initial.evidence)})};
    `,
    )
    const next = Schema.decodeUnknownSync(
      Schema.Struct({
        generation: Schema.Number,
        evidence: CurrentEvidenceSchema,
        matches: Schema.Boolean,
      }),
    )(second.value)
    expect(second.pid).not.toBe(first.pid)
    expect(next.generation).toBeGreaterThan(initial.generation)
    expect(next.evidence).toEqual(initial.evidence)
    expect(next.matches).toBe(true)
  })
})

test("known changes and ABA remain invalidating after independent process restart", async () => {
  await isolated(async (directory) => {
    const first = await child(
      directory,
      `
      yield* observe(${JSON.stringify([rootFact])});
      return yield* facts.capture(scope,${JSON.stringify([rootFact])});
    `,
    )
    const original = Schema.decodeUnknownSync(CurrentEvidenceSchema)(first.value)
    const different = await child(
      directory,
      `
      yield* observe(${JSON.stringify([changed(rootFact)])});
      return yield* facts.matches(${JSON.stringify(original)});
    `,
    )
    expect(different.value).toBe(false)
    const returned = await child(
      directory,
      `
      yield* observe(${JSON.stringify([rootFact])});
      return {matches:yield* facts.matches(${JSON.stringify(original)}),
        evidence:yield* facts.capture(scope,${JSON.stringify([rootFact])})};
    `,
    )
    const current = Schema.decodeUnknownSync(
      Schema.Struct({
        matches: Schema.Boolean,
        evidence: CurrentEvidenceSchema,
      }),
    )(returned.value)
    expect(current.matches).toBe(false)
    expect(current.evidence.facts.map((fact) => fact.fingerprint)).toEqual(
      original.facts.map((fact) => fact.fingerprint),
    )
    expect(current.evidence.facts.map((fact) => fact.epoch)).not.toEqual(
      original.facts.map((fact) => fact.epoch),
    )
  })
})

test("a late older process cannot replace newer accepted current facts", async () => {
  await isolated(async (directory) => {
    const ready = join(directory, "older.ready")
    const older = start(
      directory,
      `
      const generation=yield* store.reserveCacheGeneration(scope,CURRENT_EVIDENCE_GENERATION);
      yield* Effect.promise(()=>writeFile(${JSON.stringify(ready)},JSON.stringify({generation,pid:process.pid})));
      yield* Effect.promise(()=>new Promise(resolve=>process.stdin.once("data",resolve)));
      yield* facts.observe({scope,generation,observed_at:9000,facts:${JSON.stringify([rootFact])}});
      return {oldCapture:yield* resultCode(facts.capture(scope,${JSON.stringify([rootFact])})),
        evidence:yield* facts.capture(scope,${JSON.stringify([changed(rootFact)])})};
    `,
    )
    try {
      const reserved = await vi.waitFor(
        async () =>
          Schema.decodeUnknownSync(
            Schema.Struct({ generation: Schema.Number, pid: Schema.Number }),
          )(JSON.parse(await readFile(ready, "utf8"))),
        { timeout: 10_000 },
      )
      const newer = await child(
        directory,
        `
        const generation=yield* observe(${JSON.stringify([changed(rootFact)])});
        return {generation,evidence:yield* facts.capture(scope,${JSON.stringify([changed(rootFact)])})};
      `,
      )
      const accepted = Schema.decodeUnknownSync(
        Schema.Struct({
          generation: Schema.Number,
          evidence: CurrentEvidenceSchema,
        }),
      )(newer.value)
      expect(newer.pid).not.toBe(reserved.pid)
      expect(accepted.generation).toBeGreaterThan(reserved.generation)
      older.worker.stdin.end("finish")
      const late = await older.result
      const result = Schema.decodeUnknownSync(
        Schema.Struct({
          oldCapture: Schema.String,
          evidence: CurrentEvidenceSchema,
        }),
      )(late.value)
      expect(result.oldCapture).toBe("CACHE_INVALIDATED")
      expect(result.evidence).toEqual(accepted.evidence)
    } finally {
      if (!older.worker.stdin.destroyed) older.worker.stdin.end("finish")
      await older.result
    }
  })
})

test("capturing a candidate requires its actual expected fingerprints and complete known facts", async () => {
  await isolated(async (directory) => {
    const reply = await child(
      directory,
      `
      yield* observe(${JSON.stringify([changed(rootFact)])});
      return {
        mismatch:yield* resultCode(facts.capture(scope,${JSON.stringify([rootFact])})),
        missing:yield* resultCode(facts.capture(scope,${JSON.stringify([changed(rootFact), requiredFact])})),
        current:yield* resultCode(facts.capture(scope,${JSON.stringify([changed(rootFact)])}))
      };
    `,
    )
    expect(reply.value).toEqual({
      mismatch: "CACHE_INVALIDATED",
      missing: "CACHE_INVALIDATED",
      current: "ok",
    })
  })
})

test("guarded current publication rejects a newly known change and preserves the prior observation", async () => {
  await isolated(async (directory) => {
    const key = `cache/latest/${scope}/root/observed.json`
    const first = await child(
      directory,
      `
      yield* observe(${JSON.stringify([rootFact])});
      const evidence=yield* facts.capture(scope,${JSON.stringify([rootFact])},["root"]);
      const generation=yield* store.reserveCacheGeneration(scope,"root");
      const observation={scope,record_identity:"root",generation,started_at:1000,validated_at:1000,
        invalidated:false,current_evidence:evidence};
      yield* store.writeJson(${JSON.stringify(key)},observation,{expectedCurrentEvidence:evidence});
      return {evidence,observation};
    `,
    )
    const initial = Schema.decodeUnknownSync(
      Schema.Struct({
        evidence: CurrentEvidenceSchema,
        observation: Schema.Unknown,
      }),
    )(first.value)
    await child(
      directory,
      `
      yield* observe(${JSON.stringify([changed(rootFact)])});
      return "changed";
    `,
    )
    const publication = await child(
      directory,
      `
      const generation=yield* store.reserveCacheGeneration(scope,"root");
      const observation={scope,record_identity:"root",generation,started_at:2000,validated_at:2000,
        invalidated:false,current_evidence:${JSON.stringify(initial.evidence)}};
      const code=yield* resultCode(store.writeJson(${JSON.stringify(key)},observation,
        {expectedCurrentEvidence:${JSON.stringify(initial.evidence)}}));
      return {code,stored:yield* store.readJson(${JSON.stringify(key)},Schema.Unknown)};
    `,
    )
    expect(publication.value).toEqual({
      code: "CACHE_INVALIDATED",
      stored: initial.observation,
    })
  })
})

test.each([
  { name: "Requires metadata", selected: requiredFact },
  { name: "complete Files membership with unchanged old members", selected: membersFact },
])(
  "the final dependency read set rejects changed $name while root evidence still matches",
  async ({ selected }) => {
    await isolated(async (directory) => {
      const root = [rootFact, relationsFact]
      const required = [requiredFact, membersFact]
      const first = await child(
        directory,
        `
      yield* observe(${JSON.stringify([...root, ...required])});
      const root=yield* facts.capture(scope,${JSON.stringify(root)});
      const required=yield* facts.capture(scope,${JSON.stringify(required)});
      return {root,required,complete:yield* resultCode(assertCurrentEvidenceSet([root,required])),
        missing:yield* resultCode(assertCurrentEvidenceSet([root,undefined]))};
    `,
      )
      const prepared = Schema.decodeUnknownSync(
        Schema.Struct({
          root: CurrentEvidenceSchema,
          required: CurrentEvidenceSchema,
          complete: Schema.String,
          missing: Schema.String,
        }),
      )(first.value)
      expect(prepared.complete).toBe("ok")
      expect(prepared.missing).toBe("CACHE_INVALIDATED")
      await child(
        directory,
        `
      yield* observe(${JSON.stringify([changed(selected)])});
      return "changed";
    `,
      )
      const final = await child(
        directory,
        `
      return {rootMatches:yield* facts.matches(${JSON.stringify(prepared.root)}),
        admission:yield* resultCode(assertCurrentEvidenceSet(${JSON.stringify([prepared.root, prepared.required])}))};
    `,
      )
      expect(final.value).toEqual({ rootMatches: true, admission: "CACHE_INVALIDATED" })
    })
  },
)

const rootRecord = "skill://root?library=00000000-0000-4000-8000-000000000001"
const requiredRecord = "skill://required?library=00000000-0000-4000-8000-000000000001"

test.each([
  { name: "scope denial", identity: "access:scope", action: "deny" },
  { name: "dependency physical-page denial", identity: "required", action: "deny" },
  { name: "dependency logical-record denial", identity: requiredRecord, action: "deny" },
  { name: "dependency retirement", identity: requiredRecord, action: "retire" },
])("unchanged facts cannot bypass $name in another process", async ({ identity, action }) => {
  await isolated(async (directory) => {
    const key = `cache/latest/${scope}/${encodeURIComponent(rootRecord)}/observed.json`
    const first = await child(
      directory,
      `
      yield* observe(${JSON.stringify([rootFact, requiredFact])});
      const root=yield* facts.capture(scope,${JSON.stringify([rootFact])},${JSON.stringify([rootRecord])});
      const required=yield* facts.capture(scope,${JSON.stringify([requiredFact])},${JSON.stringify([requiredRecord])});
      const full=yield* facts.capture(scope,${JSON.stringify([rootFact, requiredFact])},${JSON.stringify([rootRecord, requiredRecord])});
      const generation=yield* store.reserveCacheGeneration(scope,${JSON.stringify(rootRecord)});
      const observation={scope,record_identity:${JSON.stringify(rootRecord)},generation,
        started_at:1000,validated_at:1000,invalidated:false,current_evidence:full};
      yield* store.writeJson(${JSON.stringify(key)},observation,{expectedCurrentEvidence:full});
      return {root,required,full,observation};
    `,
    )
    const prepared = Schema.decodeUnknownSync(
      Schema.Struct({
        root: CurrentEvidenceSchema,
        required: CurrentEvidenceSchema,
        full: CurrentEvidenceSchema,
        observation: Schema.Unknown,
      }),
    )(first.value)
    const target = `cache/latest/${scope}/${encodeURIComponent(identity)}`
    await child(
      directory,
      `
      const generation=yield* store.reserveCacheGeneration(scope,${JSON.stringify(identity)});
      ${
        action === "retire"
          ? `yield* store.retireKeys([${JSON.stringify(target + "/.fence")}]);`
          : `yield* store.writeJson(${JSON.stringify(target + "/denied.json")},
            {scope,record_identity:${JSON.stringify(identity)},generation,started_at:2000,
            validated_at:2000,invalidated:true,access_denied:"ACCESS_DENIED"});`
      }
      return "recorded";
    `,
    )
    const final = await child(
      directory,
      `
      const matches=yield* facts.matches(${JSON.stringify(prepared.full)});
      const admission=yield* resultCode(assertCurrentEvidenceSet(${JSON.stringify([prepared.root, prepared.required])}));
      const generation=yield* store.reserveCacheGeneration(scope,${JSON.stringify(rootRecord)});
      const observation={scope,record_identity:${JSON.stringify(rootRecord)},generation,
        started_at:3000,validated_at:3000,invalidated:false,current_evidence:${JSON.stringify(prepared.full)}};
      const publication=yield* resultCode(store.writeJson(${JSON.stringify(key)},observation,
        {expectedCurrentEvidence:${JSON.stringify(prepared.full)}}));
      return {matches,admission,publication,stored:yield* store.readJson(${JSON.stringify(key)},Schema.Unknown)};
    `,
    )
    expect(final.value).toEqual({
      matches: false,
      admission: "CACHE_INVALIDATED",
      publication: "CACHE_INVALIDATED",
      stored: prepared.observation,
    })
  })
})

for (const scenario of [
  {
    name: "graph preparation rejects a root change after the Required node reaches its derived directory",
    kind: "current",
    result: "CACHE_INVALIDATED",
    ready: false,
    derivedReads: 2,
  },
  {
    name: "pinned graph preparation rejects a known denial received during its derived directory",
    kind: "pinned_denial",
    result: "ACCESS_DENIED",
    ready: false,
    derivedReads: 1,
  },
  {
    name: "pinned graph preparation keeps its accepted bytes after a metadata change during its derived directory",
    kind: "pinned_metadata",
    result: "ready",
    ready: true,
    derivedReads: 1,
  },
])
  test(scenario.name, async () => {
    await isolated(async (directory) => {
      const graphModule = new URL("../src/graph-prepare.ts", import.meta.url).href
      const fixtureModule = new URL("./graph-prepare-live-fixture.ts", import.meta.url).href
      const notionModule = new URL("../src/notion.ts", import.meta.url).href
      const currentModule = new URL("./shared-current-fixture.ts", import.meta.url).href
      const evidenceModule = new URL("../src/current-evidence.ts", import.meta.url).href
      const reply = await child(
        directory,
        `
      const {prepareGraph}=yield* Effect.promise(()=>import(${JSON.stringify(graphModule)}));
      const {nativeGraphFixture,graphLibrary}=yield* Effect.promise(()=>import(${JSON.stringify(fixtureModule)}));
      const {Notion}=yield* Effect.promise(()=>import(${JSON.stringify(notionModule)}));
      const {currentScope}=yield* Effect.promise(()=>import(${JSON.stringify(currentModule)}));
      const {withNotionChangeEvidence,currentPageFact}=yield* Effect.promise(()=>import(${JSON.stringify(evidenceModule)}));
      const f=nativeGraphFixture({width:1});
      const api=yield* Effect.promise(()=>f.run(Notion));
      const crypto=yield* Crypto.Crypto;
      const connectionKey=yield* sha256(JSON.stringify(["current-fixture","","https://api.notion.com"]));
      yield* store.writeJson("cache/identities/"+connectionKey+".json",{scope:currentScope});
      const wrapped={...api,request:(path,body,options)=>
        withNotionChangeEvidence("current-fixture","https://api.notion.com",path,
          api.request(path,body,options)).pipe(
            Effect.provideService(Store,store),Effect.provideService(Crypto.Crypto,crypto))};
      const input={roots:[f.pageIds[0]],purpose:"use"};
      const prepare=(selectedStore,selectedInput=input)=>f.run(prepareGraph(selectedInput,{library:graphLibrary.library_id}).pipe(
        Effect.provideService(Store,selectedStore),Effect.provideService(Notion,wrapped),Effect.result));
      const before=yield* Effect.promise(()=>prepare(store));
      if(before._tag!=="Success" || !before.success.roots[0]?.ref)
        throw new Error("The fixture must prepare an accepted root pin");
      f.clearCalls();
      const kind=${JSON.stringify(scenario.kind)};
      const selectedInput=kind==="current"?input:{roots:[before.success.roots[0].ref],purpose:"inspect"};
      const selectedId=kind==="current"?"skill://leaf-0?library="+graphLibrary.library_id:before.success.roots[0].id;
      const injectionPrefix="cache/shared-derived-graphs/"+currentScope+"/"+(yield* sha256(selectedId))+"/";
      let injected=false, derivedReads=0;
      const guardedStore={...store,readJson:(key,schema)=>Effect.gen(function*(){
        if(key.startsWith("cache/shared-derived-graphs/")) derivedReads++;
        if(!injected && key.startsWith(injectionPrefix)){
          injected=true;
          if(kind==="pinned_denial"){
            const identity=f.pageIds[0];
            const generation=yield* store.reserveCacheGeneration(currentScope,identity);
            yield* store.writeJson("cache/latest/"+currentScope+"/"+encodeURIComponent(identity)+"/denied.json",
              {scope:currentScope,record_identity:identity,generation,started_at:Date.now(),
                validated_at:Date.now(),invalidated:true,access_denied:"ACCESS_DENIED"});
          }else{
            const fact=yield* currentPageFact({...f.pages[0],last_edited_time:"2026-11-18T00:01:00.000Z"});
            if(fact===undefined) throw new Error("The known fixture page must have a fact");
            const generation=yield* store.reserveCacheGeneration(currentScope,CURRENT_EVIDENCE_GENERATION);
            yield* facts.observe({scope:currentScope,generation,observed_at:Date.now(),facts:[fact]});
          }
        }
        return yield* store.readJson(key,schema);
      })};
      const after=yield* Effect.promise(()=>prepare(guardedStore,selectedInput));
      return {
        baseline:before._tag==="Success"?before.success.status:before.failure.code,
        result:after._tag==="Success"?after.success.status:after.failure.code,
        ready:after._tag==="Success" && after.success.status==="ready",
        keptPin:after._tag==="Success" && after.success.roots[0]?.ref===before.success.roots[0].ref,
        injected,derivedReads,requests:f.calls.length,writes:f.writeCount()
      };
    `,
      )
      expect(reply.value).toEqual({
        baseline: "ready",
        result: scenario.result,
        ready: scenario.ready,
        keptPin: scenario.ready,
        injected: true,
        derivedReads: scenario.derivedReads,
        requests: 0,
        writes: 0,
      })
    })
  })

test("retiring the current-evidence attempt fences in-flight facts and old bases while allowing a new attempt", async () => {
  await isolated(async (directory) => {
    const first = await child(
      directory,
      `
      yield* observe(${JSON.stringify([rootFact])});
      const evidence=yield* facts.capture(scope,${JSON.stringify([rootFact])});
      const generation=yield* store.reserveCacheGeneration(scope,CURRENT_EVIDENCE_GENERATION);
      return {evidence,generation};
    `,
    )
    const prepared = Schema.decodeUnknownSync(
      Schema.Struct({ evidence: CurrentEvidenceSchema, generation: Schema.Number }),
    )(first.value)
    await child(
      directory,
      `
      yield* store.retireKeys(["cache/latest/"+scope+"/"+encodeURIComponent(CURRENT_EVIDENCE_GENERATION)+"/.fence"]);
      return "retired";
    `,
    )
    const after = await child(
      directory,
      `
      const late=yield* resultCode(facts.observe({scope,generation:${prepared.generation},
        observed_at:9000,facts:${JSON.stringify([rootFact])}}));
      const oldMatches=yield* facts.matches(${JSON.stringify(prepared.evidence)});
      const generation=yield* observe(${JSON.stringify([rootFact])});
      const evidence=yield* facts.capture(scope,${JSON.stringify([rootFact])});
      return {late,oldMatches,generation,newMatches:yield* facts.matches(evidence)};
    `,
    )
    const result = Schema.decodeUnknownSync(
      Schema.Struct({
        late: Schema.String,
        oldMatches: Schema.Boolean,
        generation: Schema.Number,
        newMatches: Schema.Boolean,
      }),
    )(after.value)
    expect(result.late).toBe("CACHE_INVALIDATED")
    expect(result.oldMatches).toBe(false)
    expect(result.generation).toBeGreaterThan(prepared.generation)
    expect(result.newMatches).toBe(true)
  })
})
