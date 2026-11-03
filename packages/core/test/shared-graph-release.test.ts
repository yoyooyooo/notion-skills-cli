import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Crypto, Effect, FileSystem, Path } from "effect"
import { HttpClient } from "effect/http"
import { garbageCollectCache, publishSnapshotObservation, recordScope } from "../src/cache.ts"
import { exportSkill, snapshotPortable } from "../src/export.ts"
import { prepareGraph } from "../src/graph-prepare.ts"
import { trashPath } from "../src/local-locks.ts"
import {
  aliasFor,
  entrypointFor,
  fail,
  property,
  text,
  type ContentKind,
  type Snapshot,
} from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { fileRef } from "../src/ref.ts"
import {
  prepareGraphRelease,
  saveGraphRelease,
  inspectGraphRelease,
  restoreGraphRelease,
} from "../src/shared-graph-release.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { listSkill, loadSnapshot, readSkill } from "../src/snapshot.ts"
import { Store } from "../src/store.ts"
import {
  digest,
  encode,
  id,
  library,
  rich,
  sharedSnapshotFixture,
} from "./shared-snapshot-fixture.ts"

type Services =
  | Notion
  | Store
  | Crypto.Crypto
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
const directories: string[] = []
afterAll(async () => {
  if (process.platform === "darwin")
    for (const directory of directories) await Effect.runPromise(trashPath(directory))
})
const scope = digest(
  JSON.stringify(["fixture-user", "", "https://api.notion.com", "controlled-credential"]),
)
const logical = (name: string) => `shared_skill:${library.library_id}:${name}`
type Definition = {
  kind?: ContentKind
  required?: readonly string[]
  members?: readonly string[]
  resources?: readonly { path: string; bytes: Uint8Array }[]
}

async function fixture(definitions: Readonly<Record<string, Definition>>) {
  const f = sharedSnapshotFixture({ fileCount: 1 })
  const root = await mkdtemp(join(tmpdir(), "ntn-graph-release-"))
  directories.push(root)
  const snapshots = new Map<string, Snapshot>()
  const outputs = new Map<string, Uint8Array>()
  const pages = new Map<string, Record<string, unknown>>()
  let credentials = "controlled-credential"
  let loseGraph = false
  let emptyCatalog = false
  const denied = new Set<string>()
  for (const [index, [name, definition]] of Object.entries(definitions).entries()) {
    const kind = definition.kind ?? "skill"
    const main = entrypointFor(kind)
    const bytes = encode(
      `---\nname: ${name}\ndescription: Description ${name}\n---\n\n# ${name} version A\n`,
    )
    const record = {
      id: logical(name),
      kind,
      name,
      alias: aliasFor(name),
      description: `Description ${name}`,
      default_context: false,
      enabled: true,
      entrypoint: main,
      ref: fileRef(logical(name), main),
      locator: {
        type: "shared_skill" as const,
        library_id: library.library_id,
        skill_id: name,
        page_id: id(100 + index),
        database_id: library.skills.database_id,
        data_source_id: library.skills.data_source_id,
      },
    }
    const files = [{ path: main, bytes }, ...(definition.resources ?? [])]
      .map((file) => {
        f.objects.set(`objects/${digest(file.bytes)}`, file.bytes.slice())
        return { path: file.path, bytes: file.bytes.length, sha256: digest(file.bytes) }
      })
      .sort((a, b) => a.path.localeCompare(b.path))
    const version = digest(canonicalSharedJson({ record, files }))
    snapshots.set(name, {
      record,
      files,
      entrypoint: main,
      scope,
      version_id: version,
      snapshot_id: `s_${digest(JSON.stringify([scope, record.id, version]))}`,
      created_at: 1000,
      members: [],
      required: [],
    })
    pages.set(record.locator.page_id, {
      ...structuredClone(f.main),
      id: record.locator.page_id,
      properties: {
        ...structuredClone(property(f.main.properties)),
        title: { id: "title", type: "title", title: [{ plain_text: name }] },
        description: rich("description", record.description),
        kind: { id: "kind", type: "select", select: { name: kind } },
        skill_id: rich("skill_id", name),
        main_file_id: rich("main_file_id", `main-${name}`),
      },
    })
  }
  for (const [name, definition] of Object.entries(definitions)) {
    const snapshot = snapshots.get(name)
    if (snapshot === undefined) throw new Error("Missing fixture snapshot")
    const relation = (names: readonly string[]) =>
      names.map((name) => {
        const target = snapshots.get(name)
        if (target === undefined) throw new Error("Missing fixture relation")
        return {
          id: target.record.id,
          ref: fileRef(target.record.id, target.entrypoint),
          metadata: target.record,
        }
      })
    const complete = {
      ...snapshot,
      required: relation(definition.required ?? []),
      members: relation(definition.members ?? []),
    }
    snapshots.set(name, complete)
    f.json.set(`snapshots/${complete.snapshot_id}.json`, complete)
    await f.run(
      publishSnapshotObservation(complete, Date.now(), 1, {
        sharedBodyValidUntil: Date.now() + 300_000,
      }),
    )
  }
  await f.run(recordScope(scope))
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        const store = yield* Store
        const selected: Notion["Service"] = {
          ...api,
          credentialIdentity: Effect.succeed(credentials),
          request: (path, body, options) =>
            Effect.gen(function* () {
              const page = /^v1\/pages\/([a-f0-9-]+)$/u.exec(path)?.[1]
              if (page !== undefined && pages.has(page)) {
                f.calls.push({ path, method: options?.method ?? "GET", body })
                if (denied.has(page))
                  return yield* Effect.fail(
                    fail("NOTION_API_ERROR", "Controlled permission revoked", { http_status: 403 }),
                  )
                return structuredClone(pages.get(page))
              }
              if (
                emptyCatalog &&
                path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`)
              ) {
                f.calls.push({ path, method: "POST", body })
                return { object: "list", results: [], has_more: false, next_cursor: null }
              }
              const isGraph =
                path === "v1/pages" &&
                text(
                  property(property(body).properties).entity === undefined
                    ? []
                    : property(property(property(body).properties).entity).rich_text,
                ).startsWith("graph-")
              const response = yield* api.request(path, body, options)
              if (isGraph && loseGraph) {
                loseGraph = false
                return yield* Effect.fail(
                  fail("WRITE_OUTCOME_UNKNOWN", "Controlled graph acknowledgement loss"),
                )
              }
              return response
            }),
        }
        return yield* effect.pipe(
          Effect.provideService(Notion, selected),
          Effect.provideService(Store, {
            ...store,
            root,
            output: (path, bytes) =>
              Effect.sync(() => {
                outputs.set(path, bytes.slice())
                return { output: path, reused: false }
              }),
            retireKeys: (keys) =>
              Effect.sync(() =>
                keys.map((key) => {
                  f.json.delete(key)
                  return { key, retention_path: `retired/${key}` }
                }),
              ),
          }),
        )
      }),
    )
  const ref = (name: string) => {
    const snapshot = snapshots.get(name)
    if (snapshot === undefined) throw new Error("Missing fixture root")
    return fileRef(snapshot.record.id, snapshot.entrypoint, snapshot.snapshot_id)
  }
  const plan = async (names: readonly string[], includeMembers = false) => {
    const prepared = await run(
      prepareGraph(
        { roots: names.map(ref), purpose: "use" },
        { database: library.skills.database_id },
      ),
    )
    return await run(
      prepareGraphRelease(prepared, { entry: library.skills.database_id, includeMembers }),
    )
  }
  return {
    ...f,
    run,
    plan,
    ref,
    snapshots,
    pages,
    root,
    denied,
    outputs,
    loseNextGraph: () => {
      loseGraph = true
    },
    changeScope: () => {
      credentials = "other-controlled-credential"
    },
    emptyCatalog: () => {
      emptyCatalog = true
    },
  }
}
const options = { entry: library.skills.database_id }

describe("explicit retained graph releases", () => {
  test("an absent local pin without an exact retained manifest keeps the original network-free failure", async () => {
    const f = await fixture({ root: {} })
    f.clearCalls()
    const error = await f.run(
      Effect.flip(readSkill(fileRef(logical("root"), "SKILL.md", `s_${"9".repeat(64)}`))),
    )
    expect(error.code).toBe("SNAPSHOT_MISSING")
    expect(f.calls).toHaveLength(0)
  })

  test("selected closure retains Required nodes but only explicit all-Members includes optional bodies", async () => {
    const f = await fixture({
      root: { kind: "router", required: ["required"], members: ["optional"] },
      required: {},
      optional: {},
    })
    const selected = await f.plan(["root"])
    expect(selected.manifest.graph.bindings.map((binding) => binding.record.id)).toEqual([
      logical("required"),
      logical("root"),
    ])
    expect(selected.manifest.selection).toMatchObject({ mode: "selected", optional_node_ids: [] })
    expect(f.writeCount()).toBe(0)
    const complete = await f.plan(["root"], true)
    expect(complete.nodes).toHaveLength(3)
    expect(complete.manifest.selection).toMatchObject({
      mode: "all_members",
      optional_node_ids: [logical("optional")],
    })
    const prepared = await f.run(
      prepareGraph(
        { roots: [f.ref("root")], purpose: "use" },
        { database: library.skills.database_id },
      ),
    )
    const failure = await f.run(
      Effect.flip(
        prepareGraphRelease(prepared, {
          ...options,
          includeMembers: true,
          budget: { maxNodes: 2 },
        }),
      ),
    )
    expect(failure.code).toBe("GRAPH_RELEASE_BUDGET")
    expect(f.writeCount()).toBe(0)
  })

  test("cold independent state restores every selected A byte after current pages change to B", async () => {
    const binary = new Uint8Array(70_000).fill(137)
    const f = await fixture({
      root: { kind: "router", required: ["required"], members: ["optional"] },
      required: { resources: [{ path: "assets/large.bin", bytes: binary }] },
      optional: { resources: [{ path: "notes/one.txt", bytes: encode("exact A\r\n") }] },
    })
    const plan = await f.plan(["root", "optional"])
    const expected = new Map(
      plan.nodes.flatMap((node) =>
        node.snapshot.files.map((file) => [
          `${node.snapshot.record.id}:${file.path}`,
          f.objects.get(`objects/${file.sha256}`),
        ]),
      ),
    )
    expect(await f.run(saveGraphRelease(plan, options))).toMatchObject({
      verification: "objects_and_manifest",
    })
    for (const page of f.pages.values())
      property(page.properties).description = rich("description", "Current version B description")
    f.json.clear()
    f.objects.clear()
    f.clearCalls()
    const restored = await f.run(restoreGraphRelease(plan.graph_id, options))
    expect(restored.graph_lock).toEqual(plan.manifest.graph)
    expect(restored).toMatchObject({
      manifest_complete: true,
      local_files_ready: true,
      loaded: false,
      materialization: "complete",
    })
    expect(restored.nodes).toHaveLength(3)
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
    for (const node of restored.nodes) {
      const content = await f.run(readSkill(node.ref))
      if (!("content" in content)) throw new Error("Expected a text entrypoint")
      expect(content.content).toContain("version A")
      const snapshot = await f.run(loadSnapshot(node.snapshot_id))
      for (const file of snapshot.files)
        expect(f.objects.get(`objects/${file.sha256}`)).toEqual(
          expected.get(`${node.record.id}:${file.path}`),
        )
      const original = plan.nodes.find(
        (candidate) => candidate.snapshot.record.id === node.record.id,
      )
      if (original === undefined) throw new Error("Missing restored node")
      expect(snapshot).toBeDefined()
      const portable = await f.run(snapshotPortable(snapshot))
      expect(
        portable.files.every(
          (file) =>
            digest(file.bytes) ===
            original.snapshot.files.find((entry) => entry.path === file.path)?.sha256,
        ),
      ).toBe(true)
    }
  })

  test("manifest inspection does not fetch objects and absent history never falls back to current", async () => {
    const f = await fixture({
      root: { resources: [{ path: "big.bin", bytes: new Uint8Array(90_000).fill(5) }] },
    })
    const plan = await f.plan(["root"])
    await f.run(saveGraphRelease(plan, options))
    f.objects.clear()
    f.clearCalls()
    const inspected = await f.run(inspectGraphRelease(plan.graph_id, options))
    expect(inspected).toMatchObject({ manifest_complete: true, materialization: "not_requested" })
    expect(f.calls.some((call) => JSON.stringify(call.body)?.includes('"equals":"object"'))).toBe(
      false,
    )
    const object = [...f.records].find(
      ([, row]) => property(property(property(row.properties).kind).select).name === "object",
    )
    if (object === undefined) throw new Error("Expected retained object")
    f.records.delete(object[0])
    const error = await f.run(Effect.flip(restoreGraphRelease(plan.graph_id, options)))
    expect(error.code).toBe("SHARED_HISTORY_MISSING")
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
  })

  test("lost graph acknowledgement reconciles its exact original operation without another create", async () => {
    const f = await fixture({ root: { required: ["required"] }, required: {} })
    const plan = await f.plan(["root"])
    f.loseNextGraph()
    const error = await f.run(Effect.flip(saveGraphRelease(plan, options)))
    expect(error.code).toBe("WRITE_OUTCOME_UNKNOWN")
    expect([...f.json.keys()].some((key) => key.endsWith("/plan.json"))).toBe(true)
    f.clearCalls()
    expect(await f.run(saveGraphRelease(plan, options))).toMatchObject({
      graph_id: plan.graph_id,
      mode: "reconcile",
      verification: "manifest",
    })
    expect(f.writeCount()).toBe(0)
    expect([...f.json.keys()].some((key) => key.endsWith("/plan.json"))).toBe(false)
    expect([...f.json.keys()].some((key) => key.endsWith("/complete.json"))).toBe(true)
  })

  test("an unknown byte write leaves an incomplete graph fenced across retries", async () => {
    const f = await fixture({ root: {} })
    const plan = await f.plan(["root"])
    f.unknownRecord("object", true)
    await f.run(Effect.flip(saveGraphRelease(plan, options)))
    f.clearCalls()
    expect((await f.run(Effect.flip(saveGraphRelease(plan, options)))).code).toBe(
      "GRAPH_RELEASE_UNRESOLVED",
    )
    expect(f.writeCount()).toBe(0)
    expect([...f.json.keys()].some((key) => key.endsWith("/plan.json"))).toBe(true)
  })

  test("wrong-scope save and revoked current access cannot consume or overwrite history", async () => {
    const f = await fixture({ root: { required: ["required"] }, required: {} })
    const plan = await f.plan(["root"])
    await f.run(saveGraphRelease(plan, options))
    f.changeScope()
    f.clearCalls()
    expect((await f.run(Effect.flip(saveGraphRelease(plan, options)))).code).toBe(
      "GRAPH_RELEASE_SCOPE",
    )
    expect(f.writeCount()).toBe(0)
    const node = plan.nodes[0]
    if (node?.snapshot.record.locator.type !== "shared_skill")
      throw new Error("Expected shared node")
    f.denied.add(node.snapshot.record.locator.page_id)
    expect((await f.run(Effect.flip(restoreGraphRelease(plan.graph_id, options)))).code).toBe(
      "NOTION_API_ERROR",
    )
    expect(f.calls.some((call) => JSON.stringify(call.body)?.includes('"equals":"object"'))).toBe(
      false,
    )
    expect(f.readBodyCount()).toBe(0)
  })

  test("an independently authorized scope restores exact historical bytes with an explicit local vector", async () => {
    const f = await fixture({
      root: { required: ["required"] },
      required: { resources: [{ path: "data.txt", bytes: encode("historical bytes") }] },
    })
    const plan = await f.plan(["root"])
    await f.run(saveGraphRelease(plan, options))
    f.json.clear()
    f.objects.clear()
    f.changeScope()
    f.clearCalls()
    const restored = await f.run(restoreGraphRelease(plan.graph_id, options))
    expect(restored.origin_graph).toEqual(plan.manifest.graph)
    expect(restored.graph_lock.scope).not.toBe(plan.manifest.graph.scope)
    expect(restored.graph_lock.bindings.map((binding) => binding.version_id)).toEqual(
      plan.manifest.graph.bindings.map((binding) => binding.version_id),
    )
    expect(
      restored.graph_lock.bindings.every(
        (binding) =>
          !plan.manifest.graph.bindings.some((old) => old.snapshot_id === binding.snapshot_id),
      ),
    ).toBe(true)
    const root = restored.graph_lock.bindings.find(
      (binding) => binding.record.id === logical("root"),
    )
    if (root === undefined) throw new Error("Missing rebased root")
    const prepared = await f.run(
      prepareGraph(
        { roots: [root.ref], purpose: "use", sessionBindings: restored.graph_lock.bindings },
        { database: library.skills.database_id },
      ),
    )
    expect(prepared.graph_lock).toEqual(restored.graph_lock)
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
  })

  test("a rehashed vector cannot claim another snapshot identity or omit a required node", async () => {
    const f = await fixture({ root: { required: ["required"] }, required: {} })
    const plan = await f.plan(["root"])
    const { sha256: _hash, ...vector } = plan.manifest.graph
    const changed = {
      ...vector,
      bindings: vector.bindings.map((binding, index) =>
        index === 0 ? { ...binding, snapshot_id: `s_${"1".repeat(64)}` } : binding,
      ),
    }
    f.clearCalls()
    expect(
      (
        await f.run(
          Effect.flip(
            prepareGraphRelease(
              { ...changed, sha256: digest(canonicalSharedJson(changed)) },
              options,
            ),
          ),
        )
      ).code,
    ).toBe("GRAPH_RELEASE_INVALID")
    const incomplete = {
      ...vector,
      bindings: vector.bindings.filter((binding) => binding.record.id !== logical("required")),
    }
    expect(
      (
        await f.run(
          Effect.flip(
            prepareGraphRelease(
              { ...incomplete, sha256: digest(canonicalSharedJson(incomplete)) },
              options,
            ),
          ),
        )
      ).code,
    ).toBe("GRAPH_RELEASE_INCOMPLETE")
    expect(f.calls).toHaveLength(0)
  })

  test("an explicit graph pin protects absent current nodes and their resources from online GC", async () => {
    const f = await fixture({
      root: { resources: [{ path: "resource.bin", bytes: new Uint8Array([1, 2, 3]) }] },
    })
    const plan = await f.plan(["root"])
    await f.run(saveGraphRelease(plan, options))
    await mkdir(join(f.root, "objects"), { recursive: true })
    for (const [key, bytes] of f.objects) await writeFile(join(f.root, key), bytes)
    f.emptyCatalog()
    const gc = await f.run(
      garbageCollectCache({ online: true, database: library.skills.database_id, dryRun: true }),
    )
    expect(gc.unreachable_snapshots).toEqual([])
    expect(gc.unreachable_objects).toEqual([])
  })

  test("complete manifests prepare only entrypoints and fetch one later binary resource by exact chunks", async () => {
    const binary = Uint8Array.from(
      { length: 96_000 },
      (_, index) => (index + Math.floor(index / 32_768)) % 251,
    )
    const f = await fixture({
      root: {
        resources: [
          { path: "assets/large.bin", bytes: binary },
          { path: "assets/other.bin", bytes: new Uint8Array(80_000).fill(19) },
          { path: "notes/readme.md", bytes: encode("An exact final note.\r\n") },
        ],
      },
    })
    const plan = await f.plan(["root"])
    await f.run(saveGraphRelease(plan, options))
    f.json.clear()
    f.objects.clear()
    f.clearCalls()
    const restored = await f.run(
      restoreGraphRelease(plan.graph_id, { ...options, materialize: "manifest" }),
    )
    const node = restored.nodes[0]
    if (node === undefined) throw new Error("Missing restored root")
    expect(restored).toMatchObject({
      manifest_complete: true,
      local_files_ready: false,
      loaded: false,
      materialization: "manifest",
    })
    expect(f.calls.some((call) => JSON.stringify(call.body)?.includes('"equals":"object"'))).toBe(
      false,
    )
    expect([...f.json.keys()].some((key) => key.startsWith("snapshots/"))).toBe(false)
    expect((await f.run(Effect.flip(loadSnapshot(node.snapshot_id)))).code).toBe("SNAPSHOT_MISSING")
    const listed = await f.run(listSkill(fileRef(node.record.id, "", node.snapshot_id)))
    expect(listed.files).toHaveLength(4)
    expect(listed.materialization?.local_files_ready).toBe(false)
    f.clearCalls()
    const prepared = await f.run(
      prepareGraph(
        { roots: [node.ref], purpose: "use", sessionBindings: restored.graph_lock.bindings },
        { database: library.skills.database_id },
      ),
    )
    expect(prepared.graph_lock).toEqual(restored.graph_lock)
    const mainChunks = plan.nodes[0]?.history.manifest.files
      .find((file) => file.path === node.entrypoint)
      ?.chunks.map((chunk) => chunk.object_id)
    const objectCalls = () =>
      f.calls.filter((call) => JSON.stringify(call.body)?.includes('"equals":"object"'))
    expect(objectCalls()).toHaveLength(1)
    for (const id of mainChunks ?? []) expect(JSON.stringify(objectCalls()[0]?.body)).toContain(id)
    expect(f.objects.size).toBe(1)
    expect([...f.json.keys()].some((key) => key.startsWith("snapshots/"))).toBe(false)
    f.clearCalls()
    const read = await f.run(readSkill(node.ref))
    expect(read.materialization).toMatchObject({
      manifest_complete: true,
      local_files_ready: false,
      loaded: false,
      materialized_paths: [node.entrypoint],
    })
    expect(objectCalls()).toHaveLength(0)
    const resource = fileRef(node.record.id, "assets/large.bin", node.snapshot_id)
    await f.run(readSkill(resource, { output: "downloaded-large.bin" }))
    expect(f.outputs.get("downloaded-large.bin")).toEqual(binary)
    const expectedChunks = plan.nodes[0]?.history.manifest.files
      .find((file) => file.path === "assets/large.bin")
      ?.chunks.map((chunk) => chunk.object_id)
    expect(objectCalls()).toHaveLength(1)
    for (const id of expectedChunks ?? [])
      expect(JSON.stringify(objectCalls()[0]?.body)).toContain(id)
    for (const file of plan.nodes[0]?.history.manifest.files ?? [])
      if (file.path !== "assets/large.bin" && file.path !== node.entrypoint)
        for (const chunk of file.chunks)
          expect(JSON.stringify(objectCalls()[0]?.body)).not.toContain(chunk.object_id)
    f.clearCalls()
    await f.run(readSkill(resource, { output: "same-binary.bin", offline: true }))
    expect(f.outputs.get("same-binary.bin")).toEqual(binary)
    expect(f.calls).toHaveLength(0)
    const output = join(f.root, "complete-export")
    const exported = await f.run(
      exportSkill(node.ref, { output, projection: "snapshot", format: "directory" }),
    )
    expect(exported.materialization?.local_files_ready).toBe(true)
    expect(new Uint8Array(await readFile(join(output, "assets/large.bin")))).toEqual(binary)
    expect(await readFile(join(output, "notes/readme.md"), "utf8")).toBe("An exact final note.\r\n")
    expect((await f.run(loadSnapshot(node.snapshot_id))).files).toHaveLength(4)
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
  })

  test("missing bytes leave resumable verified chunks but never create a full export or snapshot", async () => {
    const binary = Uint8Array.from(
      { length: 90_000 },
      (_, index) => (Math.floor(index / 32_768) + index) % 251,
    )
    const f = await fixture({
      root: { resources: [{ path: "assets/payload.bin", bytes: binary }] },
    })
    const plan = await f.plan(["root"])
    await f.run(saveGraphRelease(plan, options))
    f.json.clear()
    f.objects.clear()
    const restored = await f.run(
      restoreGraphRelease(plan.graph_id, { ...options, materialize: "entrypoints" }),
    )
    const node = restored.nodes[0],
      history = plan.nodes[0]?.history
    if (node === undefined || history === undefined) throw new Error("Missing graph fixture")
    expect(restored.local_files_ready).toBe(false)
    const file = history.manifest.files.find((file) => file.path === "assets/payload.bin")
    const last = file?.chunks.at(-1)
    if (file === undefined || last === undefined) throw new Error("Expected multiple exact chunks")
    const row = [...f.records].find(
      ([, row]) => text(property(property(row.properties).record).rich_text) === last.object_id,
    )
    if (row === undefined) throw new Error("Missing retained fixture chunk")
    f.records.delete(row[0])
    f.clearCalls()
    const output = join(f.root, "must-not-exist")
    expect(
      (await f.run(Effect.flip(exportSkill(node.ref, { output, projection: "snapshot" })))).code,
    ).toBe("SHARED_HISTORY_MISSING")
    expect(f.json.has(`snapshots/${node.snapshot_id}.json`)).toBe(false)
    expect(f.objects.has(`objects/${file.sha256}`)).toBe(false)
    for (const chunk of file.chunks.slice(0, -1))
      expect(f.objects.has(`objects/${chunk.sha256}`)).toBe(true)
    expect(
      (
        await f.run(
          Effect.flip(
            readSkill(fileRef(node.record.id, file.path, node.snapshot_id), {
              output: "offline-failure",
              offline: true,
            }),
          ),
        )
      ).code,
    ).toBe("SNAPSHOT_NOT_MATERIALIZED")
    f.records.set(row[0], row[1])
    f.clearCalls()
    await f.run(
      readSkill(fileRef(node.record.id, file.path, node.snapshot_id), { output: "resumed.bin" }),
    )
    expect(f.outputs.get("resumed.bin")).toEqual(binary)
    const queried = f.calls.filter((call) =>
      JSON.stringify(call.body)?.includes('"equals":"object"'),
    )
    expect(queried).toHaveLength(1)
    expect(JSON.stringify(queried[0]?.body)).toContain(last.object_id)
    for (const chunk of file.chunks.slice(0, -1))
      expect(JSON.stringify(queried[0]?.body)).not.toContain(chunk.object_id)
    expect((await f.run(loadSnapshot(node.snapshot_id))).files).toHaveLength(2)
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
  })

  test("partial manifest reads enforce current permissions and reject corrupt verified cache objects", async () => {
    const f = await fixture({
      root: { resources: [{ path: "resource.txt", bytes: encode("immutable resource") }] },
    })
    const plan = await f.plan(["root"])
    await f.run(saveGraphRelease(plan, options))
    f.json.clear()
    f.objects.clear()
    const restored = await f.run(
      restoreGraphRelease(plan.graph_id, { ...options, materialize: "entrypoints" }),
    )
    const node = restored.nodes[0],
      original = plan.nodes[0]
    if (node === undefined || original?.snapshot.record.locator.type !== "shared_skill")
      throw new Error("Missing root")
    const main = original.snapshot.files.find((file) => file.path === original.snapshot.entrypoint)
    if (main === undefined) throw new Error("Missing entrypoint")
    f.objects.set(`objects/${main.sha256}`, encode("tampered"))
    expect((await f.run(Effect.flip(readSkill(node.ref)))).code).toBe("SHARED_HISTORY_INVALID")
    f.objects.delete(`objects/${main.sha256}`)
    f.denied.add(original.snapshot.record.locator.page_id)
    f.clearCalls()
    expect((await f.run(Effect.flip(readSkill(node.ref)))).code).toBe("NOTION_API_ERROR")
    expect(f.calls.some((call) => JSON.stringify(call.body)?.includes('"equals":"object"'))).toBe(
      false,
    )
    expect(f.readBodyCount()).toBe(0)
  })
})
