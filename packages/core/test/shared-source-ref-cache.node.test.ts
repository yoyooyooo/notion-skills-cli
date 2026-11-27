import { expect, test, vi } from "vitest"
import { Effect, Schema } from "effect"
import { execFileSync, spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { trashPath } from "../src/local-locks.ts"
import {
  SourceRefObservationCacheSchema,
  SourceRefObservationSchema,
} from "../src/shared-source-ref-cache.ts"

const url = "https://github.com/source-ref-cache-fixture/skills"
const otherUrl = "https://github.com/source-ref-cache-fixture/other"

function git(directory: string, args: readonly string[]) {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Source Ref Cache Fixture",
      GIT_AUTHOR_EMAIL: "ref-cache@example.test",
      GIT_COMMITTER_NAME: "Source Ref Cache Fixture",
      GIT_COMMITTER_EMAIL: "ref-cache@example.test",
    },
  }).trim()
}

async function commit(directory: string, body: string) {
  await writeFile(join(directory, "SKILL.md"), body)
  git(directory, ["add", "SKILL.md"])
  git(directory, ["commit", "--no-gpg-sign", "-m", "ref fixture"])
  return git(directory, ["rev-parse", "HEAD"])
}

async function fixture<A>(
  run: (input: {
    readonly root: string
    readonly repository: string
    readonly first: string
  }) => Promise<A>,
) {
  const root = await mkdtemp(join(tmpdir(), "source-ref-cache-"))
  try {
    const repository = join(root, "upstream")
    await mkdir(repository)
    git(repository, ["init", "-b", "main"])
    const first = await commit(repository, "# First version\n")
    return await run({ root, repository, first })
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
  }
}

type Request = {
  readonly url?: string
  readonly ref?: string
  readonly scope?: string
  readonly maxAge?: number
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly budget?: { readonly identity: string; readonly exhausted?: true }
  readonly action?: "observe" | "expire"
  readonly holdPublication?: string
}

function program(input: { readonly root: string; readonly repository: string }, request: Request) {
  const module = (name: string) => new URL(`../src/${name}.ts`, import.meta.url).href
  return `
import {ConfigProvider,Effect} from ${JSON.stringify(import.meta.resolve("effect"))};
import {access,writeFile} from 'node:fs/promises';
import {ChildProcess,ChildProcessSpawner} from ${JSON.stringify(import.meta.resolve("effect/process"))};
import {Store} from ${JSON.stringify(module("store"))};
import {makeRequestBudget,RequestBudget} from ${JSON.stringify(module("request-budget"))};
import {observeCurrentSourceRef} from ${JSON.stringify(module("shared-current-source-check"))};
import {SOURCE_REF_CACHE_PREFIX,SourceRefObservationCacheSchema} from ${JSON.stringify(module("shared-source-ref-cache"))};
import {nodeRuntime} from ${JSON.stringify(new URL("../../cli/src/runtime.ts", import.meta.url).href)};
const input=${JSON.stringify(input)}, request=${JSON.stringify(request)};
const environment={
  PATH:process.env.PATH, SystemRoot:process.env.SystemRoot,
  HOME:input.root, USERPROFILE:input.root,
  NTN_SKILLS_HOME:input.root+'/state', NTN_SKILLS_CONFIG_HOME:input.root+'/config',
  NTN_SKILLS_CACHE_HOME:input.root+'/cache',
  GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null',
  ...request.env,
};
const run=Effect.gen(function*(){
  const store=yield* Store, real=yield* ChildProcessSpawner.ChildProcessSpawner;
  const commands=[];
  const spawner=ChildProcessSpawner.make(command=>{
    if(command._tag!=='StandardCommand') return real.spawn(command);
    commands.push([...command.args]);
    return real.spawn(ChildProcess.make(command.command,command.args.map(arg=>
      [${JSON.stringify(url)},${JSON.stringify(url + ".git")},${JSON.stringify(otherUrl)},${JSON.stringify(otherUrl + ".git")}].includes(arg)?input.repository:arg),command.options));
  });
  if(request.action==='expire'){
    for(const key of yield* store.listKeys(SOURCE_REF_CACHE_PREFIX+'/')){
      const old=yield* store.readJson(key,SourceRefObservationCacheSchema);
      if(old?.result.kind!=='observed') continue;
      const generation=yield* store.reserveCacheGeneration(old.scope,'source-ref:'+old.identity);
      yield* store.writeJson(key,{...old,generation,result:{kind:'observed',observation:{...old.result.observation,observed_at:1}}});
    }
  }
  const controlledStore=request.holdPublication===undefined?store:{...store,writeJson:(key,value,options)=>Effect.gen(function*(){
    if(key.startsWith(SOURCE_REF_CACHE_PREFIX+'/')){
      yield* Effect.promise(()=>writeFile(request.holdPublication+'.ready',JSON.stringify(value)));
      yield* Effect.promise(async()=>{
        const deadline=Date.now()+30000;
        while(true){
          try{await access(request.holdPublication+'.release');return;}catch{}
          if(Date.now()>=deadline) throw new Error('Publication gate did not release');
          await new Promise(resolve=>setTimeout(resolve,20));
        }
      });
    }
    return yield* store.writeJson(key,value,options);
  })};
  let task=observeCurrentSourceRef({url:request.url??${JSON.stringify(url)},ref:request.ref??'main',scope:request.scope??'fixture',maxAge:request.maxAge}).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner,spawner),Effect.provideService(Store,controlledStore));
  if(request.budget){
    const budget=yield* makeRequestBudget(request.budget.identity,{requests:10,bytes:100000,duration_ms:30000});
    if(request.budget.exhausted) yield* Effect.forEach(Array.from({length:10}),()=>budget.admit(0));
    task=task.pipe(Effect.provideService(RequestBudget,budget));
  }
  const result=yield* task.pipe(Effect.result);
  const records=[];
  for(const key of yield* store.listKeys(SOURCE_REF_CACHE_PREFIX+'/')) records.push({key,value:yield* store.readJson(key,SourceRefObservationCacheSchema)});
  return {pid:process.pid,result:result._tag==='Success'?{kind:'success',value:result.success}:{kind:'failure',code:result.failure.code},git_attempts:commands.filter(args=>args.includes('ls-remote')).length,records};
});
const runtime=nodeRuntime(request.cwd??input.root,environment);
Effect.runPromise(Effect.scoped(run.pipe(Effect.provide(runtime.store),Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment)))))).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(String(error));process.exitCode=1});
`
}

const ReplySchema = Schema.Struct({
  pid: Schema.Number,
  git_attempts: Schema.Number,
  result: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("success"), value: SourceRefObservationSchema }),
    Schema.Struct({ kind: Schema.Literal("failure"), code: Schema.String }),
  ]),
  records: Schema.Array(
    Schema.Struct({ key: Schema.String, value: SourceRefObservationCacheSchema }),
  ),
})
type Reply = typeof ReplySchema.Type

async function child(
  input: { readonly root: string; readonly repository: string },
  request: Request = {},
) {
  const source = program(input, request)
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
  const exit = await new Promise<number | null>((resolve, reject) => {
    worker.once("error", reject)
    worker.once("close", resolve)
  })
  expect(exit, stderr).toBe(0)
  return Schema.decodeUnknownSync(ReplySchema)(JSON.parse(stdout))
}

function success(reply: Reply) {
  if (reply.result.kind !== "success")
    throw new Error(`Expected successful ref observation: ${reply.result.code}`)
  return reply.result.value
}

test("two real OS processes reuse the original Git observation across budgets and terminal run markers", async () => {
  await fixture(async (input) => {
    const markers = (name: string) =>
      Object.fromEntries(
        ["TERM_SESSION_ID", "ITERM_SESSION_ID", "SHLVL", "_", "OLDPWD"].map((key) => [key, name]),
      )
    const first = await child(input, {
      budget: { identity: "first-invocation" },
      env: markers("first-window"),
    })
    const second = await child(input, {
      budget: { identity: "second-invocation" },
      env: markers("second-window"),
    })
    expect(first.pid).not.toBe(second.pid)
    expect(first.git_attempts).toBe(1)
    expect(second.git_attempts).toBe(0)
    expect(success(second)).toEqual(success(first))
    expect(success(second).resolved_commit).toBe(input.first)
    expect(second.records).toEqual(first.records)
    const exhausted = await child(input, { budget: { identity: "exhausted", exhausted: true } })
    expect(exhausted.result).toEqual({ kind: "failure", code: "REQUEST_BUDGET_EXHAUSTED" })
    expect(exhausted.git_attempts).toBe(0)
  })
})

test("persistent ref keys separate scope, origin, selector, cwd and SDK Git routing environment", async () => {
  await fixture(async (input) => {
    await mkdir(join(input.root, "another-cwd"))
    const requests: Request[] = [
      {},
      { scope: "another-access" },
      { url: otherUrl },
      { ref: "refs/heads/main" },
      { cwd: join(input.root, "another-cwd") },
      {
        env: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "credential.helper",
          GIT_CONFIG_VALUE_0: "routing-a",
        },
      },
      {
        env: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "credential.helper",
          GIT_CONFIG_VALUE_0: "routing-b",
        },
      },
      { env: { GH_TOKEN: "fixture-secret-never-persist-a" } },
      { env: { GH_TOKEN: "fixture-secret-never-persist-b" } },
      { env: { COMPANY_GIT_CREDENTIAL_CONTEXT: "account-a" } },
      { env: { COMPANY_GIT_CREDENTIAL_CONTEXT: "account-b" } },
    ]
    for (const request of requests) expect((await child(input, request)).git_attempts).toBe(1)
    const warm = await child(input, requests.at(-1))
    expect(warm.git_attempts).toBe(0)
    expect(warm.records).toHaveLength(requests.length)
    expect(JSON.stringify(warm.records)).not.toContain("fixture-secret-never-persist")
    expect(JSON.stringify(warm.records)).not.toContain("routing-a")
  })
})

test("expired or explicitly forced observations read a new ref while a warm hint never adopts it", async () => {
  await fixture(async (input) => {
    const first = await child(input)
    const next = await commit(input.repository, "# New upstream version\n")
    const warm = await child(input)
    expect(warm.git_attempts).toBe(0)
    expect(success(warm)).toEqual(success(first))
    const refreshed = await child(input, { maxAge: 0 })
    expect(refreshed.git_attempts).toBe(1)
    expect(success(refreshed).resolved_commit).toBe(next)
    const afterRefresh = await child(input)
    expect(afterRefresh.git_attempts).toBe(0)
    expect(success(afterRefresh)).toEqual(success(refreshed))
    const newest = await commit(input.repository, "# Another upstream version\n")
    const expired = await child(input, { action: "expire" })
    expect(expired.git_attempts).toBe(1)
    expect(success(expired).resolved_commit).toBe(newest)
  })
})

test("a newer failed ref check does not retain a successful lease or hide a removed ref", async () => {
  await fixture(async (input) => {
    git(input.repository, ["branch", "ephemeral"])
    const before = await child(input, { ref: "ephemeral" })
    expect(success(before).resolved_commit).toBe(input.first)
    git(input.repository, ["branch", "-D", "ephemeral"])
    const failed = await child(input, { ref: "ephemeral", maxAge: 0 })
    expect(failed.result).toEqual({ kind: "failure", code: "CURRENT_SOURCE_REF_MISSING" })
    expect(failed.records[0]?.value.result.kind).toBe("unknown")
    const again = await child(input, { ref: "ephemeral" })
    expect(again.git_attempts).toBe(1)
    expect(again.result).toEqual(failed.result)
    git(input.repository, ["branch", "ephemeral"])
    expect(success(await child(input, { ref: "ephemeral" })).resolved_commit).toBe(input.first)
  })
})

test("a late real Git result cannot overwrite or return ahead of a newer accepted observation", async () => {
  await fixture(async (input) => {
    const gate = join(input.root, "old-publication")
    const older = child(input, { holdPublication: gate })
    try {
      await vi.waitFor(
        async () => {
          const ready = Schema.decodeUnknownSync(SourceRefObservationCacheSchema)(
            JSON.parse(await readFile(gate + ".ready", "utf8")),
          )
          expect(ready.result).toMatchObject({
            kind: "observed",
            observation: { resolved_commit: input.first },
          })
        },
        { timeout: 20000 },
      )
      const second = await commit(input.repository, "# Newer completed check\n")
      const newer = await child(input, { maxAge: 0 })
      expect(success(newer).resolved_commit).toBe(second)
      await writeFile(gate + ".release", "release")
      const settled = await older
      expect(success(settled)).toEqual(success(newer))
      expect(settled.records).toEqual(newer.records)
      expect((await child(input)).git_attempts).toBe(0)
    } finally {
      await writeFile(gate + ".release", "release")
      await older
    }
  })
})

test("a late successful process cannot return its old ref after a newer process recorded unknown", async () => {
  await fixture(async (input) => {
    git(input.repository, ["branch", "ephemeral"])
    const gate = join(input.root, "old-success")
    const older = child(input, { ref: "ephemeral", holdPublication: gate })
    try {
      await vi.waitFor(
        async () => {
          const ready = Schema.decodeUnknownSync(SourceRefObservationCacheSchema)(
            JSON.parse(await readFile(gate + ".ready", "utf8")),
          )
          expect(ready.result).toMatchObject({
            kind: "observed",
            observation: { resolved_commit: input.first },
          })
        },
        { timeout: 20000 },
      )
      git(input.repository, ["branch", "-D", "ephemeral"])
      const newer = await child(input, { ref: "ephemeral", maxAge: 0 })
      expect(newer.result).toEqual({ kind: "failure", code: "CURRENT_SOURCE_REF_MISSING" })
      await writeFile(gate + ".release", "release")
      const settled = await older
      expect(settled.result).toEqual({ kind: "failure", code: "CURRENT_SOURCE_CHECK_SUPERSEDED" })
      expect(settled.records).toEqual(newer.records)
    } finally {
      await writeFile(gate + ".release", "release")
      await older
    }
  })
})
