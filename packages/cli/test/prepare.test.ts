import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { decode, type Snapshot } from "../../core/src/model.ts"
import { PrepareIncompleteSchema, PrepareReadySchema } from "../../core/src/graph-prepare-model.ts"
import { ConsumeReadySchema } from "../../core/src/consumer-model.ts"
import { fileRef } from "../../core/src/ref.ts"
import { trashPath } from "../../core/src/local-locks.ts"
import { createHttpProbe } from "./http-probe.ts"

const main = new URL("../dist/ntn-skills.js", import.meta.url).pathname
const core = new URL("../../core/src/", import.meta.url).pathname
const http = createHttpProbe()
const temporary: string[] = []
const evidence = process.env.NTN_SKILLS_PREPARE_EVIDENCE_DIR
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const token = "prepare-controlled-offline-token"
const scope = hash(JSON.stringify(["prepare-fixture", "", http.origin, hash(token)]))
const node = (() => {
  const executable = Bun.which("node")
  if (executable === null)
    throw new Error("Node.js is required for the real CLI preparation consumer")
  const resolved = Bun.spawnSync([executable, "--print", "process.execPath"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (resolved.exitCode !== 0) throw new Error(resolved.stderr.toString())
  return resolved.stdout.toString().trim()
})()
beforeAll(async () => {
  const process = Bun.spawn(["bun", "run", "build"], {
    cwd: new URL("../../../", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exit !== 0) throw new Error(`Fresh CLI build failed: ${out}\n${err}`)
  if (evidence !== undefined) await mkdir(evidence, { recursive: true })
}, 120_000)
afterAll(async () => {
  http.close()
  if (evidence === undefined && process.platform === "darwin")
    for (const root of temporary) await Effect.runPromise(trashPath(root))
})

async function fixture(options: { main?: string } = {}) {
  const root = await mkdtemp(join(evidence ?? tmpdir(), "ntn-prepare-consumer-"))
  temporary.push(root)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NOTION_API_TOKEN: token,
    NOTION_WORKSPACE_ID: "",
    NOTION_API_BASE_URL: http.origin,
    HOME: join(root, "home"),
    NTN_SKILLS_HOME: join(root, "state"),
    NTN_SKILLS_CONFIG_HOME: join(root, "config"),
    NTN_SKILLS_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "xdg-state"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
  }
  // Exercise this freshly built Node artifact even when the caller uses a daily source shim.
  delete env.NTN_SKILLS_DEV_ROOT
  const instruction = (name: string) =>
    name === "a" && options.main !== undefined
      ? options.main
      : `# ${name}\nExact prepared instruction ${name}.\n`
  const snapshots: Snapshot[] = ["a", "b", "optional", "broken"].map((name, index) => {
    const id = `shared_skill:prepare-library:${name}`
    const body = instruction(name)
    const version = hash(body)
    return {
      scope,
      snapshot_id: `s_${hash(JSON.stringify([scope, id, version]))}`,
      version_id: version,
      created_at: 1000,
      record: {
        id,
        kind: "skill",
        name,
        alias: name,
        description: `Description ${name}`,
        enabled: true,
        default_context: false,
        entrypoint: "SKILL.md",
        ref: fileRef(id, "SKILL.md"),
        locator: {
          type: "shared_skill",
          library_id: "prepare-library",
          skill_id: name,
          page_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          database_id: "00000000-0000-4000-8000-000000000010",
          data_source_id: "00000000-0000-4000-8000-000000000011",
        },
      },
      entrypoint: "SKILL.md",
      files: [{ path: "SKILL.md", bytes: Buffer.byteLength(body), sha256: hash(body) }],
      required: [],
      members: [],
    }
  })
  const relation = (snapshot: Snapshot) => ({
    id: snapshot.record.id,
    ref: fileRef(snapshot.record.id, "SKILL.md", snapshot.snapshot_id),
    metadata: snapshot.record,
  })
  snapshots[0] = {
    ...snapshots[0]!,
    required: [relation(snapshots[1]!)],
    members: [relation(snapshots[2]!)],
  }
  snapshots[3] = {
    ...snapshots[3]!,
    required: [
      {
        id: "shared_skill:prepare-library:missing",
        ref: fileRef("shared_skill:prepare-library:missing", "SKILL.md", `s_${"f".repeat(64)}`),
        metadata: { name: "missing", kind: "skill", description: "Missing controlled dependency" },
      },
    ],
  }
  const script = `
import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {Effect,Layer} from ${JSON.stringify(import.meta.resolve("effect"))};
import {Store,StoreLive} from ${JSON.stringify(core + "store.ts")};
const snapshots=${JSON.stringify(snapshots)};
const bodies=${JSON.stringify(Object.fromEntries(snapshots.map((snapshot) => [snapshot.record.name, instruction(snapshot.record.name)])))};
await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const store=yield* Store;
  yield* store.writeJson(${JSON.stringify(`cache/identities/${hash(JSON.stringify([hash(token), "", http.origin]))}.json`)},{scope:${JSON.stringify(scope)}});
  for(const snapshot of snapshots){
    const body=bodies[snapshot.record.name];
    yield* store.writeBytes('objects/'+snapshot.files[0].sha256,new TextEncoder().encode(body));
    yield* store.writeJson('snapshots/'+snapshot.snapshot_id+'.json',snapshot);
  }
})).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(NodeServices.layer)))));
console.log(JSON.stringify({seeded:snapshots.length,scope:${JSON.stringify(scope)}}));
`
  const seed = Bun.spawn([node, "--input-type=module", "-e", script], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(seed.stdout).text(),
    new Response(seed.stderr).text(),
    seed.exited,
  ])
  await writeFile(
    join(root, "seed.json"),
    JSON.stringify({ stdout, stderr, exit, snapshots }, null, 2),
  )
  if (exit !== 0) throw new Error(`Real Node SQLite seeding failed: ${stdout}\n${stderr}`)
  let calls = 0
  const invoke = async (args: string[]) => {
    const before = http.calls()
    const child = Bun.spawn([node, main, ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const result = { stdout, stderr, exit, http_calls: http.calls() - before }
    await writeFile(
      join(root, `invocation-${++calls}.json`),
      JSON.stringify({ argv: args, ...result }, null, 2),
    )
    expect(result.http_calls).toBe(0)
    return result
  }
  return { root, snapshots, invoke, ref: (index: number) => relation(snapshots[index]!).ref }
}

test("SC25 use returns one complete root/Requires closure without loading optional bodies", async () => {
  const f = await fixture()
  const used = await f.invoke(["use", f.ref(0), "--offline", "--read-only", "--json"])
  expect(used.exit).toBe(0)
  const ready = decode(ConsumeReadySchema, JSON.parse(used.stdout))
  expect(ready.effects).toEqual({
    version: 1,
    remote_writes: "none",
    author_content: "unchanged",
    retention: [],
  })
  expect(ready.preparation.effects).toEqual(ready.effects)
  expect(ready.preparation.required_closure).toEqual(
    f.snapshots.slice(0, 2).map((snapshot) => snapshot.record.id),
  )
  expect(
    ready.preparation.nodes.filter((node) => node.state === "prepared").map((node) => node.content),
  ).toEqual(["# a\nExact prepared instruction a.\n", "# b\nExact prepared instruction b.\n"])
  expect(ready.preparation.nodes.find((node) => node.id === f.snapshots[2]!.record.id)?.state).toBe(
    "known",
  )
  expect(ready.delivery.status).toBe("not_observed")
  expect(ready.activation.status).toBe("not_evaluated")
  const compact = await f.invoke(["use", f.ref(0), "--offline"])
  expect(compact.exit).toBe(0)
  expect(compact.stdout).toStartWith("Effects: no remote writes.\n")
  expect(compact.stdout.match(/Exact prepared instruction a\./g)).toHaveLength(1)
  expect(compact.stdout.match(/Exact prepared instruction b\./g)).toHaveLength(1)
  expect(compact.stdout).not.toContain("Exact prepared instruction optional")
  expect(compact.stdout).not.toContain("manifest_sha256")
  const missing = await f.invoke(["use", f.ref(3), "--offline", "--json"])
  expect(missing.exit).toBe(1)
  expect(JSON.parse(missing.stdout).ok).toBe(false)
  expect(JSON.parse(missing.stdout).error.details.effects).toEqual(ready.effects)
  for (const args of [
    ["use", f.ref(0), "--refresh", "--json"],
    ["use", f.ref(0), "--lines", "1-2", "--json"],
    ["use", f.ref(0), "--metrics"],
  ]) {
    const invalid = await f.invoke(args)
    expect(invalid.exit).toBe(2)
    expect(JSON.parse(invalid.stdout).error.code).toBe("INVALID_ARGUMENT")
  }
})

test("SC25 read --json preserves inspect-only behavior and rejects --raw conflicts", async () => {
  const f = await fixture()
  const inspected = await f.invoke(["read", f.ref(3), "--offline", "--read-only", "--json"])
  expect(inspected.exit).toBe(0)
  expect(JSON.parse(inspected.stdout).effects.remote_writes).toBe("none")
  expect(JSON.parse(inspected.stdout).content).toBe(
    "# broken\nExact prepared instruction broken.\n",
  )
  const invalid = await f.invoke(["read", f.ref(0), "--json", "--raw"])
  expect(invalid.exit).toBe(2)
  expect(JSON.parse(invalid.stdout).error.code).toBe("INVALID_ARGUMENT")
})

test("SC25 list exposes bounded metadata pagination and explicit JSON in the offline schema", async () => {
  const f = await fixture()
  const schema = await f.invoke(["schema", "list"])
  expect(schema.exit).toBe(0)
  const names = JSON.parse(schema.stdout).schema.parameters.map(
    (parameter: { name: string }) => parameter.name,
  )
  for (const name of ["query", "limit", "cursor", "json"]) expect(names).toContain(name)
})

test("prepare help/schema are offline and expose actual parser defaults and bounds", async () => {
  const f = await fixture()
  const help = await f.invoke(["ctl", "prepare", "--help"])
  expect(help.exit).toBe(0)
  expect(help.stdout).toContain("--session-bindings")
  expect(help.stdout).toContain("--max-context-bytes")
  expect(help.stdout).toContain("--read-only")
  const schema = await f.invoke(["schema", "ctl", "prepare"])
  expect(schema.exit).toBe(0)
  const parameters: Array<{ name: string; min_occurrences: number; default?: unknown }> =
    JSON.parse(schema.stdout).schema.parameters
  expect(parameters.find((parameter) => parameter.name === "root")?.min_occurrences).toBe(1)
  expect(parameters.find((parameter) => parameter.name === "purpose")?.default).toBe("use")
  for (const args of [
    ["ctl", "prepare"],
    ["ctl", "prepare", f.ref(0), "--purpose", "unknown"],
    ["ctl", "prepare", f.ref(0), "--max-nodes", "0"],
    ["ctl", "prepare", f.ref(0), "--refresh", "--offline"],
  ]) {
    const invalid = await f.invoke(args)
    expect(invalid.exit).toBe(2)
    expect(JSON.parse(invalid.stdout).ok).toBe(false)
  }
})

test("Node packaged CLI consumes exact SQLite pins, full use closure, inspect boundary and stable session bindings", async () => {
  const f = await fixture()
  const used = await f.invoke(["ctl", "prepare", f.ref(0), "--offline", "--read-only"])
  expect(used.exit).toBe(0)
  const ready = decode(PrepareReadySchema, JSON.parse(used.stdout))
  expect(ready.status).toBe("ready")
  expect(ready.effects?.remote_writes).toBe("none")
  expect(ready.required_closure).toEqual(
    f.snapshots.slice(0, 2).map((snapshot) => snapshot.record.id),
  )
  expect(
    ready.nodes.filter((node) => node.state === "prepared").map((node) => node.content),
  ).toEqual(["# a\nExact prepared instruction a.\n", "# b\nExact prepared instruction b.\n"])
  expect(ready.nodes.find((node) => node.id === f.snapshots[2]!.record.id)?.state).toBe("known")
  expect(ready.usage.context_bytes).toBe(Buffer.byteLength(used.stdout.trimEnd()))
  const historical = await f.invoke(["prepare", f.ref(0), "--offline"])
  expect(historical.exit).toBe(0)
  expect(decode(PrepareReadySchema, JSON.parse(historical.stdout)).graph_lock).toEqual(
    ready.graph_lock,
  )
  const inspected = await f.invoke([
    "ctl",
    "prepare",
    f.ref(0),
    "--purpose",
    "inspect",
    "--offline",
  ])
  const inspection = decode(PrepareReadySchema, JSON.parse(inspected.stdout))
  expect(inspection.usage.prepared_nodes).toBe(1)
  expect(inspection.required_closure).toEqual([])
  expect(inspection.graph_lock.purpose).toBe("inspect")
  const bindings = join(f.root, "session-bindings.json")
  await writeFile(bindings, JSON.stringify(ready.session_bindings))
  const extended = await f.invoke([
    "ctl",
    "prepare",
    f.snapshots[0]!.record.id,
    "--session-bindings",
    bindings,
    "--offline",
  ])
  expect(extended.exit).toBe(0)
  expect(decode(PrepareReadySchema, JSON.parse(extended.stdout)).session_bindings).toEqual(
    ready.session_bindings,
  )
})

test("Node CLI reports a missing required pin or context exhaustion as nonready without a graph lock", async () => {
  const f = await fixture()
  const inspect = await f.invoke(["ctl", "prepare", f.ref(3), "--purpose", "inspect", "--offline"])
  expect(inspect.exit).toBe(0)
  for (const args of [
    ["ctl", "prepare", f.ref(3), "--offline"],
    ["ctl", "prepare", f.ref(0), "--offline", "--max-context-bytes", "100"],
  ]) {
    const result = await f.invoke(args)
    expect(result.exit).toBe(1)
    expect(result.stdout.trim().split("\n")).toHaveLength(1)
    const output = JSON.parse(result.stdout)
    expect(output.ok).toBe(false)
    const preparation = decode(PrepareIncompleteSchema, output.error.details.preparation)
    expect(preparation.roots.every((root) => root.readiness === "not_ready")).toBe(true)
    expect("graph_lock" in preparation).toBe(false)
    expect("session_bindings" in preparation).toBe(false)
  }
})

test("public prepare, read and snapshot export preserve the same BOM and CRLF bytes", async () => {
  const body = "\uFEFF# a\r\nPreserve UTF-8 BOM, CRLF and 雪 exactly.\r\n"
  const f = await fixture({ main: body })
  const prepared = await f.invoke(["ctl", "prepare", f.ref(0), "--purpose", "inspect", "--offline"])
  expect(prepared.exit).toBe(0)
  const ready = decode(PrepareReadySchema, JSON.parse(prepared.stdout))
  const node = ready.nodes.find((node) => node.state === "prepared")
  expect(node?.state).toBe("prepared")
  if (node?.state !== "prepared") throw new Error("Expected the full prepared root")
  const read = await f.invoke(["read", node.ref, "--offline"])
  expect(read.exit).toBe(0)
  const exported = await f.invoke([
    "export",
    node.binding.snapshot_id,
    "--projection",
    "snapshot",
    "--format",
    "directory",
    "--output",
    join(f.root, "snapshot-export"),
  ])
  expect(exported.exit).toBe(0)
  const output = JSON.parse(exported.stdout)
  const bytes = await readFile(join(output.output, output.main_path))
  expect(node.content).toBe(body)
  expect(JSON.parse(read.stdout).content).toBe(body)
  expect(bytes.equals(Buffer.from(body))).toBe(true)
  expect(node.body_sha256).toBe(hash(body))
  expect(node.bytes).toBe(bytes.byteLength)
})
