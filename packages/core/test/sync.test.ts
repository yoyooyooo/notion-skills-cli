import { afterAll, expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { Effect, Layer } from "effect"
import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { decode, fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { snapshotPortable } from "../src/export.ts"
import { openSkill } from "../src/snapshot.ts"
import { makeSyncLocal, SyncLocal, type LocalBoundary } from "../src/sync-local.ts"
import {
  bindSync,
  planSync,
  applySync,
  syncStatus,
  unbindSync,
  reconcileSync,
  stableSyncJson,
} from "../src/sync.ts"

const page = "11111111-1111-4111-8111-111111111111"
const database = "44444444-4444-4444-8444-444444444444"
const guide = "22222222-2222-4222-8222-222222222222"
const encoder = new TextEncoder()
const downloads = new Map<string, Uint8Array>()
const downloadServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => {
    const bytes = downloads.get(new URL(request.url).pathname)
    return bytes
      ? new Response(new Blob([new Uint8Array(bytes).buffer]))
      : new Response("missing", { status: 404 })
  },
})
afterAll(() => downloadServer.stop(true))

interface Faults {
  lostResponse?: boolean
  bodyDenied?: boolean
  receiptStop?: boolean
  beforeRemoteWrite?: boolean
  baselineStop?: boolean
  denyMain?: boolean
  interruptBody?: boolean
  denyRemote?: boolean
  incompleteRemote?: boolean
  localBoundary?: (boundary: LocalBoundary) => Promise<void>
}
async function fixture(exact = false) {
  const scratch = await mkdtemp(join(tmpdir(), "ntn-sync-test-"))
  const root = join(scratch, "skill")
  const retained = join(scratch, "retained")
  await mkdir(root)
  await mkdir(retained)
  const faults: Faults = {}
  const json = new Map<string, unknown>()
  const objects = new Map<string, Uint8Array>()
  const copies = new Map<string, Uint8Array>()
  const generations = new Map<string, number>()
  const calls: Array<{ path: string; method: string }> = []
  let body = "# Sample\n\nRead [guide](references/guide.md).\n"
  let guideBody = "# Guide\n\nOriginal guide.\n"
  let name = "Sample Skill"
  let description = "Use for sync tests."
  let mutations = 0
  let retentionCount = 0
  let included = true
  let credential = "sync-credential"
  const uploads = new Map<string, Uint8Array>()
  let attachments: Array<{ name: string; type: "file"; file: { url: string } }> = []
  let uploadSequence = 0
  const extraReferences = new Map<string, { id: string; title: string; body: string }>()
  let extraIncluded: string[] = []
  const props = () => ({
    Name: { id: "title", type: "title", title: [{ plain_text: name }] },
    Description: { id: "description", type: "rich_text", rich_text: [{ plain_text: description }] },
    References: {
      id: "references",
      type: "rich_text",
      rich_text: [
        ...(included
          ? [
              {
                type: "mention",
                mention: { type: "page", page: { id: guide } },
                plain_text: "guide.md",
              },
            ]
          : []),
        ...extraIncluded.map((id) => ({
          type: "mention",
          mention: { type: "page", page: { id } },
          plain_text: extraReferences.get(id)!.title,
        })),
      ],
    },
    ...(exact ? { Files: { id: "files", type: "files", files: attachments } } : {}),
  })
  const row = () => ({
    id: page,
    parent: { database_id: database, data_source_id: "ds" },
    properties: props(),
  })
  const store = Layer.succeed(Store, {
    root: scratch,
    configRoot: join(scratch, "config"),
    cacheRoot: join(scratch, "cache"),
    readJson: (key, schema) =>
      Effect.try({
        try: () => (json.has(key) ? decode(schema, json.get(key)) : undefined),
        catch: () => fail("STATE_CORRUPT", "Malformed fixture state"),
      }),
    writeJson: (key, value) =>
      Effect.gen(function* () {
        if (
          faults.beforeRemoteWrite &&
          key.startsWith("sync/receipts/") &&
          Array.isArray(property(value).groups) &&
          (property(value).groups as unknown[]).some((group) => property(group).stage === "writing")
        ) {
          faults.beforeRemoteWrite = false
          return yield* Effect.fail(fail("STORAGE_ERROR", "Interrupted before remote mutation"))
        }
        if (
          faults.baselineStop &&
          key.startsWith("sync/bases/") &&
          property(value).generation === 2
        ) {
          faults.baselineStop = false
          return yield* Effect.fail(fail("STORAGE_ERROR", "Baseline publication interrupted"))
        }
        if (
          faults.receiptStop &&
          key.startsWith("sync/receipts/") &&
          property(value).status === "complete"
        ) {
          faults.receiptStop = false
          return yield* Effect.fail(fail("STORAGE_ERROR", "Receipt publication interrupted"))
        }
        json.set(key, structuredClone(value))
      }),
    readBytes: (key) =>
      objects.has(key)
        ? Effect.succeed(objects.get(key)!)
        : Effect.fail(fail("SNAPSHOT_MISSING", "Missing fixture object")),
    writeBytes: (key, bytes) =>
      Effect.sync(() => {
        objects.set(key, new Uint8Array(bytes))
      }),
    listKeys: (prefix) =>
      Effect.succeed(
        [...new Set([...json.keys(), ...objects.keys()])]
          .filter((key) => key.startsWith(prefix))
          .sort(),
      ),
    reserveCacheGeneration: (scope, pageId) =>
      Effect.sync(() => {
        const key = `${scope}:${pageId}`
        const generation = (generations.get(key) ?? 0) + 1
        generations.set(key, generation)
        return generation
      }),
    retireKeys: (keys) =>
      Effect.sync(() => {
        for (const key of keys) {
          json.delete(key)
          objects.delete(key)
        }
        return keys.map((key) => ({ key, retention_path: join(retained, key) }))
      }),
    output: (destination, bytes) =>
      Effect.gen(function* () {
        const old = copies.get(destination)
        if (
          old &&
          (old.length !== bytes.length || old.some((byte, index) => byte !== bytes[index]))
        )
          return yield* Effect.fail(fail("OUTPUT_CONFLICT", "Occupied review copy"))
        if (!old) {
          copies.set(destination, new Uint8Array(bytes))
          yield* Effect.promise(() => writeFile(destination, bytes))
        }
        return { output: destination, reused: Boolean(old) }
      }),
  })
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.sync(() => credential),
    request: (path, payload, options) =>
      Effect.gen(function* () {
        const method = options?.method ?? (payload === undefined ? "GET" : "POST")
        calls.push({ path, method })
        if (path === "v1/users/me") return { id: "sync-user", object: "user" }
        if (path === `v1/databases/${database}`)
          return {
            id: database,
            database_type: null,
            title: [],
            data_sources: [{ id: "ds", name: "Skills" }],
          }
        if (path === "v1/data_sources/ds") return { properties: props() }
        if (path === "v1/data_sources/ds/query")
          return { results: [row()], has_more: false, next_cursor: null }
        if (path === "v1/pages") {
          mutations++
          const title = property(property(property(payload).properties).title).title
          if (!Array.isArray(title))
            return yield* Effect.fail(fail("INVALID_RESPONSE", "Missing child title"))
          const child = {
            id: `33333333-3333-4333-8333-${String(extraReferences.size + 1).padStart(12, "0")}`,
            title: String(property(property(title[0]).text).content),
            body: "",
          }
          extraReferences.set(child.id, child)
          return {
            id: child.id,
            properties: { title: { type: "title", title: [{ plain_text: child.title }] } },
          }
        }
        if (path === `v1/pages/${page}`) {
          if (faults.denyRemote)
            return yield* Effect.fail(fail("ACCESS_DENIED", "Remote read denied"))
          if (method === "PATCH") {
            mutations++
            const updates = property(property(payload).properties)
            const title = property(updates.title).title
            const rich = property(updates.description).rich_text
            if (Array.isArray(title)) name = String(property(property(title[0]).text).content)
            if (Array.isArray(rich)) description = String(property(property(rich[0]).text).content)
            if (updates.references) {
              const rich = property(updates.references).rich_text
              if (Array.isArray(rich)) {
                const ids = rich.flatMap((item) => {
                  const row = property(item)
                  const mention = property(property(row.mention).page).id
                  const url = property(property(row.text).link).url
                  const compact = typeof url === "string" ? url.split("/").at(-1) : undefined
                  const id =
                    typeof mention === "string"
                      ? mention
                      : compact?.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5")
                  return id ? [id] : []
                })
                included = ids.includes(guide)
                extraIncluded = ids.filter((id) => extraReferences.has(id))
              }
            }
            if (updates.files) {
              const files = property(updates.files).files
              if (!Array.isArray(files))
                return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid upload inclusion"))
              attachments = files.map((value) => {
                const item = property(value)
                const upload = String(property(item.file_upload).id)
                const route = `/upload/${upload}`
                const bytes = uploads.get(upload)
                if (!bytes) throw fail("INVALID_RESPONSE", "Missing upload bytes")
                downloads.set(route, bytes)
                return {
                  name: String(item.name),
                  type: "file",
                  file: { url: new URL(route, downloadServer.url).href },
                }
              })
            }
          }
          return row()
        }
        if (path.includes(`/blocks/${page}/children`))
          return {
            results: [
              { id: guide, type: "child_page", child_page: { title: "guide.md" } },
              ...[...extraReferences.values()].map((child) => ({
                id: child.id,
                type: "child_page",
                child_page: { title: child.title },
              })),
            ],
            has_more: false,
            next_cursor: null,
          }
        if (path.includes(`/pages/${page}/properties/references`))
          return {
            results: props().References.rich_text.map((rich_text) => ({ rich_text })),
            has_more: false,
            next_cursor: null,
          }
        if (path === `v1/pages/${guide}`)
          return {
            id: guide,
            properties: { title: { type: "title", title: [{ plain_text: "guide.md" }] } },
          }
        const child = extraReferences.get(path.split("/")[2]!)
        if (child && !path.endsWith("/markdown"))
          return {
            id: child.id,
            properties: { title: { type: "title", title: [{ plain_text: child.title }] } },
          }
        if (path === "v1/file_uploads")
          return { id: `sync-upload-${scratch.split("/").at(-1)}-${++uploadSequence}` }
        if (path.startsWith("v1/file_uploads/") && path.endsWith("/send")) {
          const bytes = objects.get(options!.file!.slice(scratch.length + 1))
          if (!bytes) return yield* Effect.fail(fail("INVALID_RESPONSE", "Missing staged upload"))
          uploads.set(path.split("/")[2]!, bytes)
          return { status: "uploaded" }
        }
        if (path.endsWith("/markdown")) {
          const isGuide = path === `v1/pages/${guide}/markdown`
          if (method === "PATCH") {
            if (faults.interruptBody) {
              faults.interruptBody = false
              return yield* Effect.interrupt
            }
            if (faults.denyMain && !isGuide && !child)
              return yield* Effect.fail(
                fail("ACCESS_DENIED", "Main body denied after reference success"),
              )
            mutations++
            if (faults.bodyDenied) return yield* Effect.fail(fail("ACCESS_DENIED", "Body denied"))
            const next = String(property(property(payload).replace_content).new_str)
            if (isGuide) guideBody = next
            else if (child) child.body = next
            else body = next
            if (faults.lostResponse) {
              faults.lostResponse = false
              return yield* Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "Accepted write response lost"),
              )
            }
          }
          const tags = [{ id: guide, title: "guide.md" }, ...extraReferences.values()]
            .map(
              (child) =>
                `<page url="https://www.notion.so/${child.id.replaceAll("-", "")}">${child.title}</page>`,
            )
            .join("\n")
          return {
            object: "page_markdown",
            markdown: isGuide ? guideBody : child ? child.body : body + "\n" + tags,
            truncated: Boolean(faults.incompleteRemote),
            unknown_block_ids: [],
          }
        }
        return yield* Effect.fail(fail("UNEXPECTED", "Unexpected provider request", { path }))
      }),
  })
  const filesystem = makeSyncLocal({
    stateRoot: scratch,
    trash: async (location) => {
      await rename(location, join(retained, `retained-${++retentionCount}`))
    },
    beforeBoundary: async (boundary) => {
      await faults.localBoundary?.(boundary)
    },
  })
  const layer = Layer.mergeAll(
    store,
    api,
    Layer.succeed(SyncLocal, filesystem),
    NodeServices.layer,
    NodeHttpClient.layerFetch,
  )
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>)
  const initial = await run(openSkill(page).pipe(Effect.flatMap(snapshotPortable)))
  for (const file of initial.files) {
    const location = join(root, file.path)
    await mkdir(join(location, ".."), { recursive: true })
    await writeFile(location, file.bytes)
  }
  const editLocal = async (text: string, directory = root) => {
    await writeFile(join(directory, "references/guide.md"), text)
  }
  const bind = (directory = root, label = "test") =>
    run(bindSync(page, { path: directory, as: label }))
  const bases = () => [...json.entries()].filter(([key]) => key.startsWith("sync/bases/"))
  return {
    scratch,
    root,
    retained,
    run,
    bind,
    editLocal,
    json,
    objects,
    copies,
    calls,
    faults,
    bases,
    filesystem,
    remoteEdit: (text: string) => {
      guideBody = text
    },
    renameRemote: (text: string) => {
      name = text
    },
    changeCredential: () => {
      credential = "other-credential"
    },
    mutations: () => mutations,
    remoteGuide: () => guideBody,
  }
}
function code(result: { readonly _tag: string; readonly failure?: unknown }) {
  return property(result.failure).code
}

test("S1/P2 equal bind initializes once and repetition has no mutation", async () => {
  const f = await fixture()
  const bound = await f.bind()
  expect(bound.baseline_initialized).toBe(true)
  const before = stableSyncJson(f.bases())
  const plan = await f.run(planSync(bound.binding.id))
  expect(plan.bindings[0]!.direction).toBe("unchanged")
  await f.run(applySync(plan.plan_id))
  expect(f.mutations()).toBe(0)
  expect(stableSyncJson(f.bases())).toBe(before)
  expect((await f.bind()).reused).toBe(true)
})

test("S2/P2 differing bind has explicit uninitialized state; dry-run stores no binding/base", async () => {
  const f = await fixture()
  await f.editLocal("Different local guide.\n")
  const preview = await f.run(bindSync(page, { path: f.root, as: "preview", dryRun: true }))
  expect(preview.baseline_initialized).toBe(false)
  expect(f.bases()).toEqual([])
  expect(f.json.has("config.json")).toBe(false)
  const bound = await f.bind()
  expect(bound.status).toBe("needs_initialization")
  const conflict = await f.run(planSync(bound.binding.id).pipe(Effect.result))
  expect(code(conflict)).toBe("SYNC_INITIALIZATION_REQUIRED")
  const plan = await f.run(planSync(bound.binding.id, { from: "notion" }))
  await f.run(applySync(plan.plan_id))
  expect(await readFile(join(f.root, "references/guide.md"), "utf8")).toContain("Original guide")
  expect(property(f.bases()[0]![1]).generation).toBe(1)
})

test("S3 local reference edit uses bound page writer and verifies baseline", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("# Guide\n\nLocal update.\n")
  const plan = await f.run(planSync(bound.binding.id))
  expect(plan.bindings[0]!.direction).toBe("push")
  expect(property(f.bases()[0]![1]).generation).toBe(1)
  const applied = await f.run(applySync(plan.plan_id))
  expect(applied.verified).toBe(true)
  expect(f.remoteGuide()).toContain("Local update")
  expect(property(f.bases()[0]![1]).generation).toBe(2)
  expect(f.calls.some((call) => call.path === "v1/pages" && call.method === "POST")).toBe(false)
})

test("S4 remote-only reference edit pulls the whole skill preserving unrelated local bytes", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await writeFile(join(f.root, "personal.txt"), "unrelated sentinel")
  f.remoteEdit("# Guide\n\nRemote reference change.\n")
  const plan = await f.run(planSync(bound.binding.id))
  expect(plan.bindings[0]!.direction).toBe("pull")
  await f.run(applySync(plan.plan_id))
  expect(await readFile(join(f.root, "references/guide.md"), "utf8")).toContain(
    "Remote reference change",
  )
  expect(await readFile(join(f.root, "personal.txt"), "utf8")).toBe("unrelated sentinel")
  expect(await readFile(join(f.root, "SKILL.md"), "utf8")).toContain("Sample")
  expect(f.mutations()).toBe(0)
})

test("S5 independently equal changed content advances baseline without writing", async () => {
  const f = await fixture()
  const bound = await f.bind()
  const text = "# Guide\n\nConverged independent edit.\n"
  await f.editLocal(text)
  f.remoteEdit(text)
  const plan = await f.run(planSync(bound.binding.id))
  expect(plan.bindings[0]!.direction).toBe("advance_baseline")
  await f.run(applySync(plan.plan_id))
  expect(f.mutations()).toBe(0)
  expect(property(f.bases()[0]![1]).generation).toBe(2)
})

test("S6 whole-Skill conflict retains nonexecutable plan and unchanged baseline", async () => {
  const f = await fixture()
  const bound = await f.bind()
  const base = stableSyncJson(f.bases())
  await f.editLocal("Local conflicting content.\n")
  f.remoteEdit("Remote conflicting content.\n")
  const result = await f.run(planSync(bound.binding.id).pipe(Effect.result))
  expect(code(result)).toBe("SYNC_CONFLICT")
  const rejected = [...f.json.values()].find(
    (value) => property(value).format === "ntn-skills-sync-plan",
  )!
  expect(property(rejected).applicable).toBe(false)
  expect(code(await f.run(applySync(String(property(rejected).plan_id)).pipe(Effect.result)))).toBe(
    "SYNC_CONFLICT",
  )
  expect(stableSyncJson(f.bases())).toBe(base)
  expect(f.mutations()).toBe(0)
})

for (const changed of ["local", "remote"] as const)
  test(`S7 ${changed} edit invalidates saved plan before any effect`, async () => {
    const f = await fixture()
    const bound = await f.bind()
    await f.editLocal("Planned local content.\n")
    const plan = await f.run(planSync(bound.binding.id))
    if (changed === "local") await f.editLocal("Independent local edit.\n")
    else f.remoteEdit("Independent remote edit.\n")
    const base = stableSyncJson(f.bases())
    expect(code(await f.run(applySync(plan.plan_id).pipe(Effect.result)))).toBe("SYNC_PLAN_STALE")
    expect(f.mutations()).toBe(0)
    expect(stableSyncJson(f.bases())).toBe(base)
  })

test("S8 registration follows canonical page identity after remote rename", async () => {
  const f = await fixture()
  const bound = await f.bind()
  f.renameRemote("Renamed Skill")
  const plan = await f.run(planSync(bound.binding.id))
  expect(plan.bindings[0]!.binding.page_id).toBe(page)
  expect(plan.bindings[0]!.direction).toBe("pull")
  expect(plan.bindings[0]!.intended.name).toBe("Renamed Skill")
})

test("S11 missing established root and corrupt baseline are explicit errors", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await rename(f.root, join(f.retained, "missing-root"))
  const result = await f.run(planSync(bound.binding.id).pipe(Effect.result))
  expect(result._tag).toBe("Failure")
  f.json.delete(`sync/bases/${bound.binding.id}.json`)
  expect(code(await f.run(planSync(bound.binding.id).pipe(Effect.result)))).toBe("STATE_CORRUPT")
  expect(f.mutations()).toBe(0)
})

test("S12 page-only spacing is semantically stable and code fences remain significant", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("# Guide\n\n\nOriginal guide.\n\n")
  const samePlan = await f.run(planSync(bound.binding.id))
  expect(samePlan.bindings[0]!.direction).toBe("unchanged")
  await f.editLocal("# Guide\n\n```text\n  significant code\n```\n")
  expect((await f.run(planSync(bound.binding.id))).bindings[0]!.direction).toBe("push")
})

test("S14 ordinary missing leaf requires explicit Notion initialization", async () => {
  const f = await fixture()
  const leaf = join(f.scratch, "absent")
  const bound = await f.bind(leaf, "absent")
  expect(bound.baseline_initialized).toBe(false)
  const plan = await f.run(planSync(bound.binding.id, { from: "notion" }))
  await f.run(applySync(plan.plan_id))
  expect(await readFile(join(leaf, "SKILL.md"), "utf8")).toContain("Sample")
  expect(f.mutations()).toBe(0)
  const dangling = join(f.scratch, "dangling")
  await symlink("missing-destination", dangling)
  expect(
    (await f.run(bindSync(page, { path: dangling, as: "dangling" }).pipe(Effect.result)))._tag,
  ).toBe("Failure")
  expect(f.bases()).toHaveLength(1)
})

test("S15/R7 one grouped push fans out with independent bases and partial receipts", async () => {
  const f = await fixture()
  const a = await f.bind()
  const bRoot = join(f.scratch, "copy-b")
  const cRoot = join(f.scratch, "copy-c")
  await f.run(
    f.filesystem.commit(
      await f.run(f.filesystem.inspect(bRoot, { allowMissing: true })),
      (await f.run(f.filesystem.inspect(f.root))).content!,
      [],
      "fixture-b",
    ),
  )
  await f.run(
    f.filesystem.commit(
      await f.run(f.filesystem.inspect(cRoot, { allowMissing: true })),
      (await f.run(f.filesystem.inspect(f.root))).content!,
      [],
      "fixture-c",
    ),
  )
  const b = await f.bind(bRoot, "copy-b")
  const c = await f.bind(cRoot, "copy-c")
  await f.editLocal("# Guide\n\nAccepted candidate.\n")
  const plan = await f.run(planSync(undefined, { all: true }))
  expect(plan.bindings.filter((edge) => edge.direction === "push")).toHaveLength(1)
  const failedEdge = plan.bindings.filter((edge) => edge.direction === "pull").at(-1)!
  f.faults.localBoundary = async (boundary) => {
    if (boundary.path.startsWith(failedEdge.local.resolved_path))
      throw fail("LOCAL_IO_ERROR", "Injected fan-out failure")
  }
  expect((await f.run(applySync(plan.plan_id).pipe(Effect.result)))._tag).toBe("Failure")
  expect(f.remoteGuide()).toContain("Accepted candidate")
  const remotePatches = f.calls.filter(
    (call) => call.path === `v1/pages/${guide}/markdown` && call.method === "PATCH",
  )
  expect(remotePatches).toHaveLength(1)
  const baselines = new Map(f.bases().map(([key, value]) => [key, property(value)]))
  for (const edge of plan.bindings) {
    expect(baselines.get(`sync/bases/${edge.binding.id}.json`)!.generation).toBe(
      edge.binding.id === failedEdge.binding.id ? 1 : 2,
    )
  }
  expect([a.binding.id, b.binding.id, c.binding.id]).toContain(failedEdge.binding.id)
  const before = f.mutations()
  expect(code(await f.run(reconcileSync(failedEdge.binding.id).pipe(Effect.result)))).toBe(
    "SYNC_DIVERGED",
  )
  expect(f.mutations()).toBe(before)
})

test("S9 distinct local candidates conflict before batch writes", async () => {
  const f = await fixture()
  const a = await f.bind()
  const copy = join(f.scratch, "copy")
  const content = (await f.run(f.filesystem.inspect(f.root))).content!
  await f.run(
    f.filesystem.commit(
      await f.run(f.filesystem.inspect(copy, { allowMissing: true })),
      content,
      [],
      "fixture-copy",
    ),
  )
  await f.bind(copy, "copy")
  await f.editLocal("Candidate A.\n")
  await f.editLocal("Candidate B.\n", copy)
  expect(code(await f.run(planSync(undefined, { all: true }).pipe(Effect.result)))).toBe(
    "SYNC_CONFLICT",
  )
  expect(f.mutations()).toBe(0)
  expect(a.binding.page_id).toBe(page)
})

test("P3 invalid selection fails before provider calls", async () => {
  const f = await fixture()
  const before = f.calls.length
  for (const [binding, options] of [
    [undefined, {}],
    ["test", { all: true }],
    [undefined, { all: true, from: "local" as const }],
  ] as const) {
    expect(code(await f.run(planSync(binding, options).pipe(Effect.result)))).toBe(
      "INVALID_ARGUMENT",
    )
  }
  expect(f.calls.length).toBe(before)
})

test("P4/P9 deterministic copied plans apply; tampering and occupied output cannot overwrite", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("Reviewed candidate.\n")
  const output = join(f.scratch, "review.json")
  const plan = await f.run(planSync(bound.binding.id, { output }))
  expect((await f.run(planSync(bound.binding.id, { output }))).plan_id).toBe(plan.plan_id)
  const second = join(f.scratch, "occupied.json")
  f.copies.set(second, encoder.encode("occupied"))
  expect(
    code(await f.run(planSync(bound.binding.id, { output: second }).pipe(Effect.result))),
  ).toBe("OUTPUT_CONFLICT")
  const parsed = JSON.parse(await readFile(output, "utf8"))
  parsed.bindings[0].binding.logical_path = "/changed"
  await writeFile(join(f.scratch, "tampered.json"), JSON.stringify(parsed))
  expect(code(await f.run(applySync(join(f.scratch, "tampered.json")).pipe(Effect.result)))).toBe(
    "STATE_CORRUPT",
  )
  await f.run(applySync(output))
  expect(f.remoteGuide()).toContain("Reviewed candidate")
})

test("P10 unbind dry-run retains config; actual unbind invalidates old plans without content removal", async () => {
  const f = await fixture()
  const bound = await f.bind()
  const plan = await f.run(planSync(bound.binding.id))
  const bases = stableSyncJson(f.bases())
  await f.run(unbindSync(bound.binding.id, { dryRun: true }))
  expect((await f.run(syncStatus(bound.binding.id))).bindings).toHaveLength(1)
  await f.run(unbindSync(bound.binding.id))
  expect(code(await f.run(applySync(plan.plan_id).pipe(Effect.result)))).toBe("SYNC_PLAN_STALE")
  expect(stableSyncJson(f.bases())).toBe(bases)
  expect(await readFile(join(f.root, "SKILL.md"), "utf8")).toContain("Sample")
})

test("C17 offline status consumes observation without provider calls or baseline publication", async () => {
  const f = await fixture()
  const bound = await f.bind()
  f.remoteEdit("Unobserved remote edit.\n")
  const count = f.calls.length
  const base = stableSyncJson(f.bases())
  const status = await f.run(syncStatus(bound.binding.id))
  expect(status.bindings[0]!.provisional).toBe(true)
  expect(status.bindings[0]!.authoritative).toBe(false)
  expect(f.calls.length).toBe(count)
  await f.run(syncStatus(bound.binding.id, { refresh: true }))
  expect(stableSyncJson(f.bases())).toBe(base)
})

test("R2/P8 lost response fences page and reconciliation never replays remote mutation", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("# Guide\n\nLost response candidate.\n")
  const plan = await f.run(planSync(bound.binding.id))
  f.faults.lostResponse = true
  expect((await f.run(applySync(plan.plan_id).pipe(Effect.result)))._tag).toBe("Failure")
  expect(property(f.bases()[0]![1]).generation).toBe(1)
  const nextPlan = await f.run(planSync(bound.binding.id))
  expect(code(await f.run(applySync(nextPlan.plan_id).pipe(Effect.result)))).toBe("SYNC_PENDING")
  const mutations = f.mutations()
  const reconciled = await f.run(reconcileSync(bound.binding.id))
  expect(reconciled.outcome).toBe("complete")
  expect(reconciled.baseline_advanced).toBe(true)
  expect(f.mutations()).toBe(mutations)
  expect(property(f.bases()[0]![1]).generation).toBe(2)
})

test("R4 baseline publication interruption is recovered using fresh readback only", async () => {
  const f = await fixture()
  const bound = await f.bind()
  f.remoteEdit("# Guide\n\nPulled before publication failure.\n")
  const plan = await f.run(planSync(bound.binding.id))
  f.faults.baselineStop = true
  expect(code(await f.run(applySync(plan.plan_id).pipe(Effect.result)))).toBe("STORAGE_ERROR")
  expect(property(f.bases()[0]![1]).generation).toBe(1)
  const mutations = f.mutations()
  expect((await f.run(reconcileSync(bound.binding.id))).baseline_advanced).toBe(true)
  expect(property(f.bases()[0]![1]).generation).toBe(2)
  expect(f.mutations()).toBe(mutations)
})

test("R4 receipt publication interruption does not advance baseline twice", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("Confirmed before final receipt.\n")
  const plan = await f.run(planSync(bound.binding.id))
  f.faults.receiptStop = true
  expect((await f.run(applySync(plan.plan_id).pipe(Effect.result)))._tag).toBe("Failure")
  expect(property(f.bases()[0]![1]).generation).toBe(2)
  await f.run(reconcileSync(bound.binding.id))
  expect(property(f.bases()[0]![1]).generation).toBe(2)
})

test("R5 local boundary failure retains baseline and recoverable operation", async () => {
  const f = await fixture()
  const bound = await f.bind()
  f.remoteEdit("Remote update with failing disk.\n")
  const plan = await f.run(planSync(bound.binding.id))
  f.faults.localBoundary = async () => {
    throw fail("LOCAL_IO_ERROR", "Injected disk failure")
  }
  expect((await f.run(applySync(plan.plan_id).pipe(Effect.result)))._tag).toBe("Failure")
  expect(property(f.bases()[0]![1]).generation).toBe(1)
  const receipt = [...f.json.values()].find(
    (value) => property(value).format === "ntn-skills-sync-receipt",
  )!
  expect(property(receipt).status).toBe("pending")
})

test("R6 malformed receipt fences planning/apply explicitly instead of inventing a baseline", async () => {
  const f = await fixture()
  const bound = await f.bind()
  const plan = await f.run(planSync(bound.binding.id))
  f.json.set("sync/receipts/o_00000000-0000-4000-8000-000000000000.json", { broken: true })
  expect(code(await f.run(applySync(plan.plan_id).pipe(Effect.result)))).toBe("STATE_CORRUPT")
  expect(f.mutations()).toBe(0)
})

test("L4 byte-identical symlink retarget invalidates reviewed target", async () => {
  const f = await fixture()
  const link = join(f.scratch, "logical")
  await symlink("skill", link)
  const bound = await f.bind(link, "linked")
  const copy = join(f.scratch, "same-bytes")
  const content = (await f.run(f.filesystem.inspect(f.root))).content!
  await f.run(
    f.filesystem.commit(
      await f.run(f.filesystem.inspect(copy, { allowMissing: true })),
      content,
      [],
      "fixture-copy",
    ),
  )
  const plan = await f.run(planSync(bound.binding.id))
  await rename(link, join(f.retained, "old-link"))
  await symlink("same-bytes", link)
  expect(code(await f.run(applySync(plan.plan_id).pipe(Effect.result)))).toBe("SYNC_PLAN_STALE")
  expect(f.mutations()).toBe(0)
})

test("batch preflight examines later participants before first remote write", async () => {
  const f = await fixture()
  const a = await f.bind()
  const other = join(f.scratch, "other")
  const content = (await f.run(f.filesystem.inspect(f.root))).content!
  await f.run(
    f.filesystem.commit(
      await f.run(f.filesystem.inspect(other, { allowMissing: true })),
      content,
      [],
      "fixture-other",
    ),
  )
  await f.bind(other, "other")
  await f.editLocal("Batch candidate.\n")
  const plan = await f.run(planSync(undefined, { all: true }))
  await f.editLocal("Later stale participant.\n", other)
  expect(code(await f.run(applySync(plan.plan_id).pipe(Effect.result)))).toBe("SYNC_PLAN_STALE")
  expect(f.mutations()).toBe(0)
  expect(a.binding.page_id).toBe(page)
})

test("R1/R2 interruption preserves persistent receipt and no baseline movement", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("Interrupted candidate.\n")
  const plan = await f.run(planSync(bound.binding.id))
  f.faults.interruptBody = true
  try {
    await f.run(applySync(plan.plan_id))
  } catch {}
  expect(property(f.bases()[0]![1]).generation).toBe(1)
  const receipt = [...f.json.values()].find(
    (value) => property(value).format === "ntn-skills-sync-receipt",
  )!
  expect(property(receipt).status).toBe("pending")
  const mutations = f.mutations()
  expect(code(await f.run(reconcileSync(bound.binding.id).pipe(Effect.result)))).toBe(
    "SYNC_DIVERGED",
  )
  expect(f.mutations()).toBe(mutations)
  // Classified divergence closes only the receipt fence, preserving the old base.
  expect((await f.run(planSync(bound.binding.id))).bindings[0]!.direction).toBe("push")
})

test("R3 reference succeeds then main fails; common baseline stays old and receipt fences page", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("Accepted reference before main failure.\n")
  const main = await readFile(join(f.root, "SKILL.md"), "utf8")
  await writeFile(join(f.root, "SKILL.md"), main + "\nChanged main body.\n")
  const plan = await f.run(planSync(bound.binding.id))
  f.faults.denyMain = true
  expect(code(await f.run(applySync(plan.plan_id).pipe(Effect.result)))).toBe("WRITE_PARTIAL")
  expect(f.remoteGuide()).toContain("Accepted reference")
  expect(property(f.bases()[0]![1]).generation).toBe(1)
  const candidate = await f.run(planSync(bound.binding.id, { from: "local" }))
  expect(code(await f.run(applySync(candidate.plan_id).pipe(Effect.result)))).toBe("SYNC_PENDING")
  const mutations = f.mutations()
  expect(code(await f.run(reconcileSync(bound.binding.id).pipe(Effect.result)))).toBe(
    "SYNC_DIVERGED",
  )
  expect(f.mutations()).toBe(mutations)
})

test("S10 duplicate real directory is committed once with independent logical links", async () => {
  const f = await fixture()
  const a = await f.bind()
  const link = join(f.scratch, "distribution")
  await symlink("skill", link)
  const b = await f.bind(link, "distribution")
  expect(a.binding.id).not.toBe(b.binding.id)
  f.remoteEdit("# Guide\n\nOne real target.\n")
  let referenceWrites = 0
  f.faults.localBoundary = async (boundary) => {
    if (boundary.kind === "replace" && boundary.path.endsWith("references/guide.md"))
      referenceWrites++
  }
  const plan = await f.run(planSync(undefined, { all: true }))
  await f.run(applySync(plan.plan_id))
  expect(referenceWrites).toBeGreaterThan(0)
  expect(f.bases().map(([, value]) => property(value).generation)).toEqual([2, 2])
  expect(await readFile(join(link, "references/guide.md"), "utf8")).toContain("One real target")
})

test("S13 removing a reference retains local bytes and child page remains readable", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await rename(join(f.root, "references/guide.md"), join(f.retained, "user-removed-guide"))
  const plan = await f.run(planSync(bound.binding.id))
  expect(plan.bindings[0]!.direction).toBe("push")
  await f.run(applySync(plan.plan_id))
  const remote = await f.run(openSkill(page))
  expect(remote.references?.some((reference) => reference.id === guide)).toBe(false)
  expect(f.remoteGuide()).toContain("Original guide")
  expect(await readFile(join(f.retained, "user-removed-guide"), "utf8")).toContain("Original guide")
})

test("S11 incomplete/denied remote reads never publish shortened common base", async () => {
  for (const denied of [false, true]) {
    const f = await fixture()
    const bound = await f.bind()
    const base = stableSyncJson(f.bases())
    if (denied) f.faults.denyRemote = true
    else f.faults.incompleteRemote = true
    expect((await f.run(planSync(bound.binding.id).pipe(Effect.result)))._tag).toBe("Failure")
    expect(stableSyncJson(f.bases())).toBe(base)
    expect(f.mutations()).toBe(0)
  }
})

test("scope drift cannot authorize a saved plan", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("Scope-bound candidate.\n")
  const plan = await f.run(planSync(bound.binding.id))
  f.changeCredential()
  expect(code(await f.run(applySync(plan.plan_id).pipe(Effect.result)))).toBe("SYNC_PLAN_STALE")
  expect(f.mutations()).toBe(0)
})

test("inactive retained binding can reconcile pending writes after unbind", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("Unbound accepted content.\n")
  const plan = await f.run(planSync(bound.binding.id))
  f.faults.lostResponse = true
  await f.run(applySync(plan.plan_id).pipe(Effect.result))
  await f.run(unbindSync(bound.binding.id))
  const mutations = f.mutations()
  expect((await f.run(reconcileSync(bound.binding.id))).outcome).toBe("complete")
  expect(f.mutations()).toBe(mutations)
})

test("L6 actual commit boundary link drift retains original common baseline", async () => {
  const f = await fixture()
  const link = join(f.scratch, "logical-commit")
  await symlink("skill", link)
  const bound = await f.bind(link, "logical-commit")
  const replacement = join(f.scratch, "replacement")
  const original = (await f.run(f.filesystem.inspect(f.root))).content!
  await f.run(
    f.filesystem.commit(
      await f.run(f.filesystem.inspect(replacement, { allowMissing: true })),
      original,
      [],
      "fixture-replacement",
    ),
  )
  f.remoteEdit("Fresh remote pull.\n")
  const plan = await f.run(planSync(bound.binding.id))
  let retargeted = false
  f.faults.localBoundary = async () => {
    if (retargeted) return
    retargeted = true
    await rename(link, join(f.retained, "pre-commit-link"))
    await symlink("replacement", link)
  }
  expect((await f.run(applySync(plan.plan_id).pipe(Effect.result)))._tag).toBe("Failure")
  expect(property(f.bases()[0]![1]).generation).toBe(1)
  expect(await readFile(join(replacement, "references/guide.md"), "utf8")).toContain(
    "Original guide",
  )
  expect(await readFile(join(f.root, "references/guide.md"), "utf8")).toContain("Original guide")
})

test("R6 schema-valid empty receipt participants cannot erase a pending fence", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("Pending candidate.\n")
  const plan = await f.run(planSync(bound.binding.id))
  f.faults.lostResponse = true
  await f.run(applySync(plan.plan_id).pipe(Effect.result))
  const entry = [...f.json.entries()].find(
    ([, value]) => property(value).format === "ntn-skills-sync-receipt",
  )!
  f.json.set(entry[0], { ...property(entry[1]), bindings: [] })
  const candidate = await f.run(planSync(bound.binding.id))
  const mutations = f.mutations()
  expect(code(await f.run(applySync(candidate.plan_id).pipe(Effect.result)))).toBe("STATE_CORRUPT")
  expect(f.mutations()).toBe(mutations)
})

test("R2 recovery fences byte-identical per-file symlink retarget", async () => {
  const f = await fixture()
  const actual = join(f.scratch, "linked-guide.md")
  await rename(join(f.root, "references/guide.md"), actual)
  await symlink(actual, join(f.root, "references/guide.md"))
  const bound = await f.bind()
  await writeFile(actual, "Accepted linked candidate.\n")
  const plan = await f.run(planSync(bound.binding.id))
  f.faults.lostResponse = true
  await f.run(applySync(plan.plan_id).pipe(Effect.result))
  const alternate = join(f.scratch, "alternate-guide.md")
  await writeFile(alternate, await readFile(actual))
  await rename(join(f.root, "references/guide.md"), join(f.retained, "original-guide-link"))
  await symlink(alternate, join(f.root, "references/guide.md"))
  const mutations = f.mutations()
  expect(code(await f.run(reconcileSync(bound.binding.id).pipe(Effect.result)))).toBe(
    "SYNC_PLAN_STALE",
  )
  expect(property(f.bases()[0]![1]).generation).toBe(1)
  expect(f.mutations()).toBe(mutations)
})

test("S3 exact Files storage preserves binary additions modifications and removals", async () => {
  const f = await fixture(true)
  const bound = await f.bind()
  await mkdir(join(f.root, "assets"))
  const bytes = new Uint8Array([0, 255, 11, 0, 97])
  await writeFile(join(f.root, "assets/fixture.bin"), bytes)
  await writeFile(join(f.root, "references/guide.md"), "# Guide\n\nExact reference addition.\n")
  const mainBytes = encoder.encode(
    (await readFile(join(f.root, "SKILL.md"), "utf8")) + "\nByte exact main addition.\n",
  )
  await writeFile(join(f.root, "SKILL.md"), mainBytes)
  const added = await f.run(planSync(bound.binding.id))
  expect(added.bindings[0]!.mode).toBe("exact")
  await f.run(applySync(added.plan_id))
  let portable = await f.run(openSkill(page).pipe(Effect.flatMap(snapshotPortable)))
  expect(portable.files.find((file) => file.path === "assets/fixture.bin")!.bytes).toEqual(bytes)
  expect(portable.files.find((file) => file.path === "SKILL.md")!.bytes).toEqual(mainBytes)
  expect(portable.files.map((file) => file.path).sort()).toEqual([
    "SKILL.md",
    "assets/fixture.bin",
    "references/guide.md",
  ])
  const changed = new Uint8Array([1, 254, 10, 1, 98])
  await writeFile(join(f.root, "assets/fixture.bin"), changed)
  await f.run(applySync((await f.run(planSync(bound.binding.id))).plan_id))
  portable = await f.run(openSkill(page).pipe(Effect.flatMap(snapshotPortable)))
  expect(portable.files.find((file) => file.path === "assets/fixture.bin")!.bytes).toEqual(changed)
  await rename(join(f.root, "assets/fixture.bin"), join(f.retained, "removed-binary"))
  await f.run(applySync((await f.run(planSync(bound.binding.id))).plan_id))
  portable = await f.run(openSkill(page).pipe(Effect.flatMap(snapshotPortable)))
  expect(portable.files.some((file) => file.path === "assets/fixture.bin")).toBe(false)
  expect(await readFile(join(f.retained, "removed-binary"))).toEqual(Buffer.from(changed))
})

test("R1 failure before first content mutation retains common base and safely classifies no effects", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("Prepared but never written candidate.\n")
  const plan = await f.run(planSync(bound.binding.id))
  f.faults.beforeRemoteWrite = true
  const base = stableSyncJson(f.bases())
  expect(code(await f.run(applySync(plan.plan_id).pipe(Effect.result)))).toBe("STORAGE_ERROR")
  expect(f.mutations()).toBe(0)
  expect(stableSyncJson(f.bases())).toBe(base)
  expect(code(await f.run(reconcileSync(bound.binding.id).pipe(Effect.result)))).toBe(
    "SYNC_DIVERGED",
  )
  await f.run(applySync((await f.run(planSync(bound.binding.id))).plan_id))
  expect(f.remoteGuide()).toContain("Prepared but never written candidate")
})

test("S10 incompatible page mapping on one real target is rejected before effects", async () => {
  const f = await fixture()
  const bound = await f.bind()
  const config = property(f.json.get("config.json"))
  f.json.set("config.json", {
    ...config,
    sync_bindings: [{ ...bound.binding, page_id: "33333333-3333-4333-8333-333333333333" }],
  })
  const result = await f.run(bindSync(page, { path: f.root, as: "other-page" }).pipe(Effect.result))
  expect(code(result)).toBe("SYNC_TARGET_CONFLICT")
  expect(f.mutations()).toBe(0)
})

test("P10 label collision cannot redirect a registered binding", async () => {
  const f = await fixture()
  const bound = await f.bind()
  const other = join(f.scratch, "label-target")
  expect(
    code(await f.run(bindSync(page, { path: other, as: bound.binding.label }).pipe(Effect.result))),
  ).toBe("SYNC_BINDING_CONFLICT")
  expect(property(f.json.get("config.json")).sync_bindings as unknown[]).toHaveLength(1)
  expect(f.mutations()).toBe(0)
})

test("S3 reference addition allocates once and subsequent sync performs no writer calls", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await mkdir(join(f.root, "references/nested"))
  await writeFile(join(f.root, "references/nested/policy.md"), "# Policy\n\nAdded child policy.\n")
  await f.run(applySync((await f.run(planSync(bound.binding.id))).plan_id))
  const remote = await f.run(openSkill(page))
  expect(
    remote.references?.some((reference) => reference.path === "references/nested/policy.md"),
  ).toBe(true)
  expect(f.calls.filter((call) => call.path === "v1/pages" && call.method === "POST")).toHaveLength(
    1,
  )
  const mutations = f.mutations()
  await f.run(applySync((await f.run(planSync(bound.binding.id))).plan_id))
  expect(f.mutations()).toBe(mutations)
})

test("S9 independent copy retains its older baseline after another edge converges", async () => {
  const f = await fixture()
  const a = await f.bind()
  const bRoot = join(f.scratch, "older-copy")
  const original = (await f.run(f.filesystem.inspect(f.root))).content!
  await f.run(
    f.filesystem.commit(
      await f.run(f.filesystem.inspect(bRoot, { allowMissing: true })),
      original,
      [],
      "fixture-older",
    ),
  )
  const b = await f.bind(bRoot, "older")
  await f.editLocal("# Guide\n\nNew accepted version.\n")
  await f.run(applySync((await f.run(planSync(a.binding.id))).plan_id))
  const bBase = property(f.json.get(`sync/bases/${b.binding.id}.json`))
  expect(bBase.generation).toBe(1)
  const pull = await f.run(planSync(b.binding.id))
  expect(pull.bindings[0]!.direction).toBe("pull")
  await f.run(applySync(pull.plan_id))
  expect(await readFile(join(bRoot, "references/guide.md"), "utf8")).toContain(
    "New accepted version",
  )
  expect(property(f.json.get(`sync/bases/${b.binding.id}.json`)).generation).toBe(2)
})

test("S15 one remote update converges two unchanged independent copies", async () => {
  const f = await fixture()
  await f.bind()
  const original = (await f.run(f.filesystem.inspect(f.root))).content!
  const roots = [join(f.scratch, "copy-one"), join(f.scratch, "copy-two")]
  for (const [index, root] of roots.entries()) {
    await f.run(
      f.filesystem.commit(
        await f.run(f.filesystem.inspect(root, { allowMissing: true })),
        original,
        [],
        `fixture-copy-${index}`,
      ),
    )
    await f.bind(root, `copy-${index}`)
  }
  await f.editLocal("# Guide\n\nOne accepted fan-out.\n")
  const plan = await f.run(planSync(undefined, { all: true }))
  expect(plan.bindings.filter((edge) => edge.direction === "push")).toHaveLength(1)
  const result = await f.run(applySync(plan.plan_id))
  expect(result.receipt.status).toBe("complete")
  expect(result.bindings.every((entry) => entry.generation_after === 2)).toBe(true)
  expect(
    f.calls.filter((call) => call.path === `v1/pages/${guide}/markdown` && call.method === "PATCH"),
  ).toHaveLength(1)
  for (const root of roots)
    expect(await readFile(join(root, "references/guide.md"), "utf8")).toContain(
      "One accepted fan-out",
    )
})

test("S13 Notion reference exclusion removes local inclusion through retention", async () => {
  const f = await fixture()
  const bound = await f.bind()
  // The provider is an independent editor: drive its existing property API, not sync.
  await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      yield* api.request(
        `v1/pages/${page}`,
        { properties: { references: { rich_text: [] } } },
        { method: "PATCH" },
      )
    }),
  )
  const plan = await f.run(planSync(bound.binding.id))
  expect(
    plan.bindings[0]!.actions.some(
      (action) => action.path === "references/guide.md" && action.action === "remove",
    ),
  ).toBe(true)
  const result = await f.run(applySync(plan.plan_id))
  expect(
    result.bindings[0]!.retained.some((entry) => entry.path.endsWith("references/guide.md")),
  ).toBe(true)
  expect(f.remoteGuide()).toContain("Original guide")
  expect(
    (
      await f.run(
        f.filesystem.inspect(f.root, { trackedPaths: ["SKILL.md", "references/guide.md"] }),
      )
    ).content!.files.some((file) => file.path === "references/guide.md"),
  ).toBe(false)
})

test("S2 explicit local initialization selects only registered remote identity", async () => {
  const f = await fixture()
  await f.editLocal("# Guide\n\nLocal initialization.\n")
  const bound = await f.bind()
  expect(bound.baseline_initialized).toBe(false)
  await f.run(applySync((await f.run(planSync(bound.binding.id, { from: "local" }))).plan_id))
  expect(f.remoteGuide()).toContain("Local initialization")
  expect(property(f.bases()[0]![1]).generation).toBe(1)
  expect(f.calls.some((call) => call.path === "v1/pages" && call.method === "POST")).toBe(false)
})

test("L1/L3 checked pull preserves multi-hop roots and final-file links", async () => {
  const f = await fixture()
  const parent = join(f.scratch, "linked-parent")
  await symlink(f.scratch, parent)
  const first = join(f.scratch, "first-hop")
  const second = join(f.scratch, "second-hop")
  await symlink("second-hop", first)
  await symlink("skill", second)
  const actual = join(f.scratch, "external-reference.md")
  await rename(join(f.root, "references/guide.md"), actual)
  await symlink(actual, join(f.root, "references/guide.md"))
  const bound = await f.bind(join(parent, "first-hop"), "links")
  f.remoteEdit("# Guide\n\nUpdated through all links.\n")
  await f.run(applySync((await f.run(planSync(bound.binding.id))).plan_id))
  expect(await readFile(actual, "utf8")).toContain("Updated through all links")
  const inspection = await f.run(f.filesystem.inspect(join(parent, "first-hop")))
  for (const [logical, target] of [
    [parent, f.scratch],
    [first, "second-hop"],
    [second, "skill"],
  ] as const) {
    expect(await readlink(logical)).toBe(target)
    const resolvedParent = await realpath(join(logical, ".."))
    const finalName = logical.split("/").at(-1)!
    expect(
      inspection.proof.root.nodes.some(
        (node) =>
          node.kind === "link" &&
          node.path === join(resolvedParent, finalName) &&
          node.link === target,
      ),
    ).toBe(true)
  }
  expect(await readlink(join(f.root, "references/guide.md"))).toBe(actual)
  expect(
    inspection.proof.files
      .find((file) => file.path === "references/guide.md")!
      .proof.nodes.some((node) => node.kind === "link" && node.link === actual),
  ).toBe(true)
})

test("P10 duplicate edge with differing explicit label preserves original registration", async () => {
  const f = await fixture()
  const bound = await f.bind()
  const configurationBefore = stableSyncJson(f.json.get("config.json"))
  const baselinesBefore = stableSyncJson(f.bases())
  const mutationsBefore = f.mutations()
  const result = await f.run(
    bindSync(page, { path: f.root, as: " different-label " }).pipe(Effect.result),
  )
  expect(code(result)).toBe("SYNC_BINDING_CONFLICT")
  if (result._tag === "Failure") {
    expect(property(result.failure.details).supplied_label).toBe("different-label")
    expect(property(result.failure.details).registered_label).toBe(bound.binding.label)
  }
  expect(stableSyncJson(f.json.get("config.json"))).toBe(configurationBefore)
  expect(stableSyncJson(f.bases())).toBe(baselinesBefore)
  expect(f.mutations()).toBe(mutationsBefore)
  expect((await f.bind()).reused).toBe(true)
})
