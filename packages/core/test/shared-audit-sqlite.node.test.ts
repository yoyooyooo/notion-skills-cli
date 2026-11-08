import { expect, test } from "@effect/vitest"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"

const core = new URL("../src/", import.meta.url).pathname
const fixtures = new URL("./", import.meta.url).pathname
async function child(source: string) {
  const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "",
    stderr = ""
  process.stdout.setEncoding("utf8").on("data", (value: string) => {
    stdout += value
  })
  process.stderr.setEncoding("utf8").on("data", (value: string) => {
    stderr += value
  })
  const [exit] = await once(process, "close")
  return { exit, stdout, stderr }
}
const prefix = `import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {Effect,FileSystem,Schema,Layer} from ${JSON.stringify(import.meta.resolve("effect"))};`

test("real SQLite admits exact audit/source/inventory domains, updates only run state and keeps original evidence immutable across processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-audit-sqlite-"))
  const mutable = [
    `audit/runs/audit-00000000-0000-4000-8000-000000000001.json`,
    `audit/latest/${"a".repeat(64)}.json`,
    `operations/shared-source-runs/source-run-00000000-0000-4000-8000-000000000002.json`,
  ]
  const immutable = [
    `inventory/observations/inventory-${"b".repeat(64)}.json`,
    `plans/shared-inventory-imports/inventory-import-${"c".repeat(64)}.json`,
    `operations/shared-inventory-imports/inventory-import-${"c".repeat(64)}.json`,
    `operations/shared-sources/${"d".repeat(64)}/source-ack-${"e".repeat(64)}.json`,
  ]
  const program = (body: string) => `${prefix}
import {sqliteState} from ${JSON.stringify(core + "sqlite-state.ts")};
Effect.runPromise(Effect.scoped(Effect.gen(function*(){const state=yield* sqliteState(${JSON.stringify(root)},yield* FileSystem.FileSystem);${body}})).pipe(Effect.provide(NodeServices.layer))).catch(e=>{console.error(String(e));process.exitCode=1});`
  const first = await child(
    program(`const mutable=${JSON.stringify(mutable)},immutable=${JSON.stringify(immutable)};
for(const key of mutable){yield* state.write(key,{step:1});yield* state.write(key,{step:2});if((yield* state.read(key)).step!==2)throw Error('Run checkpoint did not advance');}
for(const key of immutable){yield* state.write(key,{step:1});const result=yield* state.write(key,{step:2}).pipe(Effect.flip);if(result.code!=='STATE_CONFLICT')throw Error('Original evidence was replaced');}
const bad=yield* state.write('audit/runs/../../other.json',{}).pipe(Effect.flip);if(bad.code!=='INVALID_ARGUMENT')throw Error('Unsafe address accepted');
console.log(JSON.stringify({mutable:mutable.length,immutable:immutable.length,keys:yield* state.list('audit/runs/')}));`),
  )
  expect(first.exit, first.stderr).toBe(0)
  expect(JSON.parse(first.stdout)).toMatchObject({ mutable: 3, immutable: 4, keys: [mutable[0]] })
  const reopened = await child(
    program(`const mutable=${JSON.stringify(mutable)},immutable=${JSON.stringify(immutable)};
for(const key of mutable)if((yield* state.read(key)).step!==2)throw Error('Checkpoint lost on reopen');
for(const key of immutable)if((yield* state.read(key)).step!==1)throw Error('Original evidence changed');
yield* state.retire([mutable[2]]);const retired=yield* state.write(mutable[2],{step:3}).pipe(Effect.flip);if(retired.code!=='STATE_CONFLICT')throw Error('Retired writer run resurrected');
console.log(JSON.stringify({reopened:true,originals:immutable.length}));`),
  )
  expect(reopened.exit, reopened.stderr).toBe(0)
  expect(JSON.parse(reopened.stdout)).toEqual({ reopened: true, originals: 4 })
}, 30_000)

test("audit actually resumes through a real Store in fresh Node processes and reports offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-audit-reopen-"))
  const run = (mode: "start" | "resume" | "report", runId?: string) =>
    child(`${prefix}
import {readFile,writeFile} from 'node:fs/promises';
import {Store,StoreLive} from ${JSON.stringify(core + "store.ts")};
import {runSharedAudit,resumeSharedAudit,reportSharedAudit} from ${JSON.stringify(core + "shared-audit.ts")};
import {auditFixture} from ${JSON.stringify(fixtures + "shared-audit-fixture.ts")};
import {library} from ${JSON.stringify(fixtures + "shared-snapshot-fixture.ts")};
const root=${JSON.stringify(root)};process.env.NTN_SKILLS_HOME=root+'/state';process.env.NTN_SKILLS_CONFIG_HOME=root+'/config';process.env.NTN_SKILLS_CACHE_HOME=root+'/cache';
const fixture=await auditFixture(3);let saved;try{saved=JSON.parse(await readFile(root+'/notion-fixture.json','utf8'))}catch{}
if(saved){Object.assign(fixture.main,saved.main);fixture.files.splice(0,fixture.files.length,...saved.files);fixture.records.clear();for(const [key,value]of saved.records)fixture.records.set(key,value);}else await writeFile(root+'/notion-fixture.json',JSON.stringify({main:fixture.main,files:fixture.files,records:[...fixture.records]}),{flag:'wx'});
const mode=${JSON.stringify(mode)},runId=${JSON.stringify(runId ?? null)};
const program=mode==='start'?runSharedAudit({entry:library.skills.database_id,selector:{kind:'library'},depth:'content',budget:{requests:2}}):mode==='resume'?resumeSharedAudit(runId,{budget:{requests:2}}):reportSharedAudit(runId);
await Effect.runPromise(Effect.scoped(Effect.gen(function*(){const store=yield* Store;const report=yield* Effect.promise(()=>fixture.run(program.pipe(Effect.provideService(Store,store))));console.log(JSON.stringify({run_id:report.run_id,execution:report.execution,coverage:report.coverage,confirmed:report.request_totals.confirmed_requests,requests:fixture.ledger.length,writes:fixture.writeCount()}));})).pipe(Effect.provide(StoreLive),Effect.provide(NodeServices.layer)));`)
  let result = await run("start")
  expect(result.exit, result.stderr).toBe(0)
  let report = JSON.parse(result.stdout)
  expect(report.execution).toBe("paused")
  let previous = report.confirmed
  for (let i = 0; i < 30 && report.execution === "paused"; i++) {
    result = await run("resume", report.run_id)
    expect(result.exit, result.stderr).toBe(0)
    report = JSON.parse(result.stdout)
    expect(report.confirmed).toBeGreaterThanOrEqual(previous)
    expect(report.requests).toBeLessThanOrEqual(2)
    expect(report.writes).toBe(0)
    previous = report.confirmed
  }
  expect(report.execution).toBe("completed")
  expect(report.coverage).toBe("full")
  const offline = await run("report", report.run_id)
  expect(offline.exit, offline.stderr).toBe(0)
  expect(JSON.parse(offline.stdout)).toMatchObject({
    execution: "completed",
    coverage: "full",
    requests: 0,
    writes: 0,
  })
}, 60_000)
