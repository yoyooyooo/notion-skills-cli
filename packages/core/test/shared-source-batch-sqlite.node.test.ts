import { expect, test } from "@effect/vitest"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { trashPath } from "../src/local-locks.ts"

const core = new URL("../src/", import.meta.url).pathname
const prefix = `import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {Effect,FileSystem} from ${JSON.stringify(import.meta.resolve("effect"))};`

test("import batch plans survive a fresh SQLite process and retain immutable dispatch protection", async () => {
  await isolated(async (root) => {
    const key = `plans/shared-inventory-batches/import-batch-${"a".repeat(64)}.json`
    const written = await child(
      stateProgram(
        root,
        `
      const key=${JSON.stringify(key)},value={batch_id:'frozen',items:[{entity_id:'original'}]};
      yield* state.write(key,value);yield* state.write(key,value);
      const conflict=yield* state.write(key,{...value,items:[]}).pipe(Effect.flip);
      const invalid=yield* state.write(key.replace('import-batch-','source-batch-'),value).pipe(Effect.flip);
      console.log(JSON.stringify({value:yield* state.read(key),conflict:conflict.code,invalid:invalid.code}));
    `,
      ),
    )
    expect(written.exit, written.stderr).toBe(0)
    expect(JSON.parse(written.stdout)).toEqual({
      value: { batch_id: "frozen", items: [{ entity_id: "original" }] },
      conflict: "STATE_CONFLICT",
      invalid: "INVALID_ARGUMENT",
    })
    const reopened = await child(
      stateProgram(root, `console.log(JSON.stringify(yield* state.read(${JSON.stringify(key)})));`),
    )
    expect(reopened.exit, reopened.stderr).toBe(0)
    expect(JSON.parse(reopened.stdout)).toEqual(JSON.parse(written.stdout).value)
  })
}, 30_000)

test("native import readbacks persist immutably across processes", async () => {
  await isolated(async (root) => {
    const key = `operations/shared-native-readbacks/${"a".repeat(64)}/skill-create-${"b".repeat(64)}/${"c".repeat(64)}.json`
    const written = await child(
      stateProgram(
        root,
        `
      const key=${JSON.stringify(key)};
      yield* state.write(key,{markdown:'observed'});
      const conflict=yield* state.write(key,{markdown:'later edit'}).pipe(Effect.flip);
      console.log(JSON.stringify({code:conflict.code}));`,
      ),
    )
    expect(written.exit, written.stderr).toBe(0)
    expect(JSON.parse(written.stdout)).toEqual({ code: "STATE_CONFLICT" })
    const reopened = await child(
      stateProgram(root, `console.log(JSON.stringify(yield* state.read(${JSON.stringify(key)})));`),
    )
    expect(reopened.exit, reopened.stderr).toBe(0)
    expect(JSON.parse(reopened.stdout)).toEqual({ markdown: "observed" })
  })
}, 30_000)

async function child(source: string) {
  const worker = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "",
    stderr = ""
  worker.stdout.setEncoding("utf8").on("data", (value: string) => {
    stdout += value
  })
  worker.stderr.setEncoding("utf8").on("data", (value: string) => {
    stderr += value
  })
  const [exit] = await once(worker, "close")
  return { exit, stdout, stderr }
}

async function isolated(action: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ntn-source-batch-sqlite-"))
  try {
    await action(root)
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
  }
}

function stateProgram(root: string, body: string) {
  return `${prefix}
import {sqliteState} from ${JSON.stringify(core + "sqlite-state.ts")};
Effect.runPromise(Effect.scoped(Effect.gen(function*(){const state=yield* sqliteState(${JSON.stringify(root)},yield* FileSystem.FileSystem);${body}})).pipe(Effect.provide(NodeServices.layer))).catch(error=>{console.error(String(error));process.exitCode=1});`
}

test("only exact batch run addresses update; member evidence stays immutable and retired checkpoints cannot revive", async () => {
  await isolated(async (root) => {
    const scope = "a".repeat(64)
    const plan = `source-batch-${"b".repeat(64)}`
    const run = "00000000-0000-4000-8000-000000000001"
    const key = `operations/shared-source-batches/${scope}/${plan}/${run}.json`
    const immutable = [
      `operations/shared-sources/${scope}/source-op-${"c".repeat(64)}.json`,
      `operations/shared-sources/${scope}/source-ack-${"d".repeat(64)}.json`,
      `operations/shared-sources/${scope}/source-selection-${"e".repeat(64)}.json`,
    ]
    const invalid = [
      key.replace(scope, "a".repeat(63)),
      key.replace(scope, "A".repeat(64)),
      key.replace(plan, `source-batch-${"b".repeat(63)}`),
      key.replace(plan, `source-refresh-${"b".repeat(64)}`),
      key.replace(run, "00000000000040008000000000000001"),
      key.replace(run, "../../other"),
      key.replace(`${run}.json`, `source-op-${"f".repeat(64)}.json`),
      key.replace("shared-source-batches/", "shared-source-batches-other/"),
      key.replace(".json", ".json/extra"),
      key.replace(`/${run}.json`, `/extra/${run}.json`),
    ]
    const first = await child(
      stateProgram(
        root,
        `const key=${JSON.stringify(key)};yield* state.write(key,{step:1});yield* state.write(key,{step:2});
const errors=[];for(const invalid of ${JSON.stringify(invalid)}){const bad=yield* state.write(invalid,{}).pipe(Effect.flip);errors.push(bad.code);}
const protectedErrors=[];for(const address of ${JSON.stringify(immutable)}){yield* state.write(address,{step:1});const conflict=yield* state.write(address,{step:2}).pipe(Effect.flip);protectedErrors.push(conflict.code);}
console.log(JSON.stringify({checkpoint:yield* state.read(key),errors,protectedErrors}));`,
      ),
    )
    expect(first.exit, first.stderr).toBe(0)
    expect(JSON.parse(first.stdout)).toEqual({
      checkpoint: { step: 2 },
      errors: invalid.map(() => "INVALID_ARGUMENT"),
      protectedErrors: immutable.map(() => "STATE_CONFLICT"),
    })
    const retired = await child(
      stateProgram(
        root,
        `const key=${JSON.stringify(key)},before=yield* state.read(key);yield* state.retire([key]);
const errors=[];for(const value of [{step:2},{step:3}]){const result=yield* state.write(key,value).pipe(Effect.flip);errors.push(result.code);}
const originals=[];for(const address of ${JSON.stringify(immutable)})originals.push(yield* state.read(address));
console.log(JSON.stringify({before,after:(yield* state.read(key))??null,keys:yield* state.list('operations/shared-source-batches'),errors,originals}));`,
      ),
    )
    expect(retired.exit, retired.stderr).toBe(0)
    expect(JSON.parse(retired.stdout)).toEqual({
      before: { step: 2 },
      after: null,
      keys: [],
      errors: ["STATE_CONFLICT", "STATE_CONFLICT"],
      originals: immutable.map(() => ({ step: 1 })),
    })
    const inspected = await child(
      `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(join(root, "state.sqlite"))},{readOnly:true});try{console.log(JSON.stringify(db.prepare('SELECT category,payload,retired FROM shared_local_records WHERE key=?').get(${JSON.stringify(key)})));}finally{db.close();}`,
    )
    expect(inspected.exit, inspected.stderr).toBe(0)
    expect(JSON.parse(inspected.stdout)).toEqual({
      category: "dispatch",
      payload: '{"step":2}',
      retired: 1,
    })
  })
}, 30_000)
