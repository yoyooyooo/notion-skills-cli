import { describe, expect, test } from "bun:test"
import { Crypto, Deferred, Effect, Fiber, FileSystem, Path } from "effect"
import { HttpClient } from "effect/http"
import { publishSnapshotObservation, recordScope } from "../src/cache.ts"
import { prepareGraph } from "../src/graph-prepare.ts"
import {
  PrepareIncompleteSchema,
  PrepareReadySchema,
  type PrepareInput,
} from "../src/graph-prepare-model.ts"
import {
  aliasFor,
  decode,
  entrypointFor,
  fail,
  property,
  type ContentKind,
  type Snapshot,
} from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { fileRef } from "../src/ref.ts"
import { LIBRARY_MARKER } from "../src/shared-library-model.ts"
import { Store } from "../src/store.ts"
import {
  digest,
  encode,
  id,
  library,
  rich,
  sharedSnapshotFixture,
  skillPage,
} from "./shared-snapshot-fixture.ts"

type Definition = {
  readonly requires?: readonly string[]
  readonly members?: readonly string[]
  readonly kind?: ContentKind
  readonly enabled?: boolean
  readonly content?: string
}
const scope = digest(
  JSON.stringify(["fixture-user", "", "https://api.notion.com", "controlled-credential"]),
)
const identity = (name: string) => `shared_skill:library-snapshot:${name}`
async function fixture(definitions: Readonly<Record<string, Definition>>) {
  const f = sharedSnapshotFixture({ fileCount: 1 })
  const snapshots = new Map<string, Snapshot>()
  const opened = new Map<string, number>()
  const entries = Object.entries(definitions)
  for (const [index, [name, definition]] of entries.entries()) {
    const kind = definition.kind ?? "skill"
    const content = definition.content ?? `# ${name}\n`
    const bytes = encode(content)
    const version = digest(`${name}:${content}`)
    const entrypoint = entrypointFor(kind)
    const record = {
      id: identity(name),
      kind,
      name,
      alias: aliasFor(name),
      description: `Description ${name}`,
      default_context: false,
      enabled: definition.enabled ?? true,
      entrypoint,
      ref: fileRef(identity(name), entrypoint),
      locator: {
        type: "shared_skill" as const,
        library_id: library.library_id,
        skill_id: name,
        page_id: id(100 + index),
        database_id: library.skills.database_id,
        data_source_id: library.skills.data_source_id,
      },
    }
    const snapshot: Snapshot = {
      scope,
      snapshot_id: `s_${digest(JSON.stringify([scope, record.id, version]))}`,
      version_id: version,
      created_at: 1000,
      record,
      entrypoint,
      files: [{ path: entrypoint, sha256: digest(bytes), bytes: bytes.byteLength }],
      members: [],
      required: [],
    }
    snapshots.set(name, snapshot)
    f.objects.set(`objects/${digest(bytes)}`, bytes)
  }
  for (const [name, definition] of entries) {
    const snapshot = snapshots.get(name)!
    const directory = (names: readonly string[]) =>
      names.map((child) => {
        const selected = snapshots.get(child)
        return {
          id: identity(child),
          ref:
            selected === undefined
              ? fileRef(identity(child), "SKILL.md", `s_${"a".repeat(64)}`)
              : fileRef(selected.record.id, selected.entrypoint, selected.snapshot_id),
          metadata:
            selected === undefined
              ? { kind: "skill", name: child, description: "missing", enabled: true }
              : selected.record,
        }
      })
    const complete = {
      ...snapshot,
      required: directory(definition.requires ?? []),
      members: directory(definition.members ?? []),
    }
    snapshots.set(name, complete)
    f.json.set(`snapshots/${complete.snapshot_id}.json`, complete)
    await f.run(
      publishSnapshotObservation(complete, 1000, 1, { sharedBodyValidUntil: Date.now() + 300_000 }),
    )
  }
  await f.run(recordScope(scope))
  f.clearCalls()
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Notion | Store | Crypto.Crypto | HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
    >,
  ) =>
    f.run(
      Effect.gen(function* () {
        const store = yield* Store
        return yield* effect.pipe(
          Effect.provideService(Store, {
            ...store,
            readJson: (key, schema) => {
              if (key.startsWith("snapshots/")) opened.set(key, (opened.get(key) ?? 0) + 1)
              return store.readJson(key, schema)
            },
          }),
        )
      }),
    )
  const ref = (name: string) => {
    const snapshot = snapshots.get(name)!
    return fileRef(snapshot.record.id, snapshot.entrypoint, snapshot.snapshot_id)
  }
  const prepare = (roots: readonly string[], rest: Partial<Omit<PrepareInput, "roots">> = {}) =>
    run(prepareGraph({ roots, purpose: "use", freshness: { policy: "offline" }, ...rest }))
  const incomplete = async (
    roots: readonly string[],
    rest: Partial<Omit<PrepareInput, "roots">> = {},
  ) => {
    const result = await run(
      prepareGraph({ roots, purpose: "use", freshness: { policy: "offline" }, ...rest }).pipe(
        Effect.result,
      ),
    )
    if (result._tag === "Success") throw new Error("Expected incomplete preparation")
    return {
      error: result.failure,
      preparation: decode(PrepareIncompleteSchema, property(result.failure.details).preparation),
    }
  }
  return { ...f, snapshots, opened, run, ref, prepare, incomplete }
}

describe("graph prepare", () => {
  test("prepared UTF-8 content retains the exact BOM and line-ending bytes of its pin", async () => {
    const content = "\uFEFF# Exact instruction\r\nKeep these bytes.\r\n"
    const f = await fixture({ a: { content } })
    const result = await f.prepare([f.ref("a")])
    const node = result.nodes[0]
    if (node?.state !== "prepared") throw new Error("Expected prepared main")
    expect(node.content).toBe(content)
    expect(digest(encode(node.content))).toBe(node.body_sha256)
    expect(encode(node.content).byteLength).toBe(node.bytes)
  })

  test("multi-root diamond prepares each immutable identity once and returns deterministic locks", async () => {
    const f = await fixture({
      a: { requires: ["b", "c"] },
      b: { requires: ["d"] },
      c: { requires: ["d"] },
      d: {},
    })
    const result = await f.prepare([f.ref("c"), f.ref("a"), f.ref("a")])
    decode(PrepareReadySchema, result)
    expect(result.status).toBe("ready")
    expect(result.required_closure).toEqual(["a", "b", "c", "d"].map(identity))
    expect(result.nodes.every((node) => node.state === "prepared")).toBe(true)
    expect(result.nodes.find((node) => node.id === identity("c"))?.roles).toEqual([
      "root",
      "required",
    ])
    expect([...f.opened.values()]).toEqual([1, 1, 1, 1])
    expect(f.calls).toHaveLength(0)
    expect(result.usage.context_bytes).toBe(
      encode(JSON.stringify({ ok: true, ...result })).byteLength,
    )
    const reordered = await f.prepare([f.ref("a"), f.ref("c")])
    expect(reordered.graph_lock).toEqual(result.graph_lock)
  })

  test("inspect reads root only and keeps required/member/reference metadata known", async () => {
    const f = await fixture({
      a: { requires: ["b"], members: ["c"] },
      b: { requires: ["d"] },
      c: {},
      d: {},
    })
    const result = await f.prepare([f.ref("a")], { purpose: "inspect" })
    expect(result.purpose).toBe("inspect")
    expect(result.graph_lock.purpose).toBe("inspect")
    expect(result.required_closure).toEqual([])
    expect(result.nodes.map((node) => [node.id, node.state])).toEqual([
      [identity("a"), "prepared"],
      [identity("b"), "known"],
      [identity("c"), "known"],
    ])
    expect(f.opened.size).toBe(1)
    expect(result.session_bindings.map((binding) => binding.record.id)).toEqual([identity("a")])
  })

  test("cycles return a concrete closed path and no successful graph lock", async () => {
    const f = await fixture({
      a: { requires: ["b"] },
      b: { requires: ["c"] },
      c: { requires: ["a"] },
    })
    const { error, preparation } = await f.incomplete([f.ref("a")])
    expect(error.code).toBe("PREPARE_REQUIRED_CYCLE")
    expect(property(error.details).path).toEqual(["a", "b", "c", "a"].map(identity))
    expect(preparation.roots[0]?.readiness).toBe("not_ready")
    expect("graph_lock" in preparation).toBe(false)
    expect(f.opened.size).toBe(3)
  })

  test("a missing required pin is an explicit partial failure and never falls back to current", async () => {
    const f = await fixture({ a: { requires: ["missing"] } })
    const { error, preparation } = await f.incomplete([f.ref("a")])
    expect(error.code).toBe("SNAPSHOT_MISSING")
    expect(preparation.status).toBe("partial")
    expect(preparation.nodes.find((node) => node.id === identity("missing"))?.state).toBe("failed")
    expect(preparation.roots[0]?.readiness).toBe("not_ready")
    expect(f.calls).toHaveLength(0)
  })

  test("disabled and Prompt dependencies block use while an explicit Prompt root may be inspected", async () => {
    const disabled = await fixture({ a: { requires: ["b"] }, b: { enabled: false } })
    expect((await disabled.incomplete([disabled.ref("a")])).error.code).toBe("CONTENT_DISABLED")
    const prompt = await fixture({ a: { requires: ["b"] }, b: { kind: "prompt" } })
    expect((await prompt.incomplete([prompt.ref("a")])).error.code).toBe("PREPARE_REQUIRED_KIND")
    expect((await prompt.prepare([prompt.ref("b")], { purpose: "inspect" })).status).toBe("ready")
  })

  test("session bindings preserve prior pins during refresh and reject hash or scope forgery", async () => {
    const f = await fixture({ a: { requires: ["b"] }, b: {} })
    const first = await f.prepare([f.ref("a")])
    const again = await f.prepare([identity("a")], {
      freshness: { policy: "refresh" },
      sessionBindings: first.session_bindings,
    })
    expect(again.session_bindings).toEqual(first.session_bindings)
    expect(f.calls.map((call) => call.path)).toEqual(["v1/users/me"])
    const forged = first.session_bindings.map((binding) => ({
      ...binding,
      body_sha256: "f".repeat(64),
    }))
    expect((await f.incomplete([identity("a")], { sessionBindings: forged })).error.code).toBe(
      "PREPARE_BINDING_CONFLICT",
    )
    const scoped = await f.run(
      prepareGraph({
        roots: [f.ref("a")],
        purpose: "use",
        freshness: { policy: "offline" },
        sessionBindings: first.session_bindings.map((binding) => ({
          ...binding,
          scope: "f".repeat(64),
        })),
      }).pipe(Effect.result),
    )
    expect(scoped._tag === "Failure" && scoped.failure.code).toBe("PREPARE_SCOPE_CONFLICT")
  })

  test("explicit differing pins conflict before a second version can be prepared", async () => {
    const f = await fixture({ a: {} })
    const first = await f.prepare([f.ref("a")])
    const conflict = fileRef(identity("a"), "SKILL.md", `s_${"f".repeat(64)}`)
    expect(
      (await f.incomplete([conflict], { sessionBindings: first.session_bindings })).error.code,
    ).toBe("PREPARE_VERSION_CONFLICT")
    expect((await f.incomplete([f.ref("a"), conflict])).error.code).toBe("PREPARE_VERSION_CONFLICT")
  })

  test("a reused pin cannot authorize a different explicit owner", async () => {
    const f = await fixture({ a: {} })
    const wrong = fileRef(identity("z"), "SKILL.md", f.snapshots.get("a")!.snapshot_id)
    expect((await f.incomplete([f.ref("a"), wrong])).error.code).toBe("SNAPSHOT_CONFLICT")
    expect(f.calls).toHaveLength(0)
  })

  test("a pinned historical alias reuses its verified identity without accepting another owner's alias", async () => {
    const f = await fixture({ z: {} })
    const snapshot = f.snapshots.get("z")!
    const result = await f.prepare([f.ref("z"), fileRef("z", "SKILL.md", snapshot.snapshot_id)])
    expect(result.usage.prepared_nodes).toBe(1)
    expect([...f.opened.values()]).toEqual([1])
  })

  test("malformed dependency refs stay structured failures and never escape as defects", async () => {
    const f = await fixture({ a: { requires: ["b"] }, b: {} })
    const original = f.snapshots.get("a")!
    f.json.set(`snapshots/${original.snapshot_id}.json`, {
      ...original,
      required: [{ id: identity("b"), ref: "skill://broken?unsupported=x", metadata: {} }],
    })
    const result = await f.incomplete([f.ref("a")])
    expect(result.error.code).toBe("INVALID_REF")
    expect(result.preparation.roots[0]?.readiness).toBe("not_ready")
  })

  test("node, edge depth, instruction and full context budgets fail without truncating readiness", async () => {
    const f = await fixture({
      a: { requires: ["b", "c"] },
      b: { requires: ["d"] },
      c: { requires: ["d"] },
      d: {},
    })
    for (const [budget, code] of [
      [{ maxNodes: 2 }, "PREPARE_NODE_BUDGET"],
      [{ maxDepth: 1 }, "PREPARE_DEPTH_BUDGET"],
      [{ maxInstructionBytes: 1 }, "PREPARE_INSTRUCTION_BUDGET"],
      [{ maxContextBytes: 100 }, "PREPARE_CONTEXT_BUDGET"],
    ] as const) {
      const result = await f.incomplete([f.ref("a")], { budget })
      expect(result.error.code).toBe(code)
      expect(result.preparation.roots.every((root) => root.readiness === "not_ready")).toBe(true)
    }
    const complete = await f.prepare([f.ref("a")])
    const boundary = await f.prepare([f.ref("a")], {
      budget: { maxContextBytes: complete.usage.context_bytes },
    })
    expect(
      (await f.prepare([f.ref("a")], { budget: { maxContextBytes: boundary.usage.context_bytes } }))
        .status,
    ).toBe("ready")
    expect(
      (
        await f.incomplete([f.ref("a")], {
          budget: { maxContextBytes: boundary.usage.context_bytes - 1 },
        })
      ).error.code,
    ).toBe("PREPARE_CONTEXT_BUDGET")
  })

  test("a reused diamond node still checks the longer path's descendant depth", async () => {
    const f = await fixture({
      a: { requires: ["b", "c"] },
      b: { requires: ["e"] },
      c: { requires: ["d"] },
      d: { requires: ["b"] },
      e: {},
    })
    const result = await f.incomplete([f.ref("a")], { budget: { maxDepth: 3 } })
    expect(result.error.code).toBe("PREPARE_DEPTH_BUDGET")
    expect(property(result.error.details).depth).toBe(4)
    expect(f.opened.get(`snapshots/${f.snapshots.get("b")!.snapshot_id}.json`)).toBe(1)
  })

  test("admission deferral retains retry details for the caller and does not retry", async () => {
    const f = await fixture({ a: {} })
    let rejected = 0
    const result = await f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* prepareGraph({
          roots: [id(100)],
          purpose: "use",
          freshness: { policy: "refresh" },
        }).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) => {
              if (path !== "v1/users/me") {
                rejected++
                return Effect.fail(
                  fail("RATE_LIMITED", "Deferred fixture", {
                    deferred: true,
                    retry_after_ms: 1200,
                  }),
                )
              }
              return api.request(path, body, options)
            },
          }),
          Effect.result,
        )
      }),
    )
    if (result._tag === "Success") throw new Error("Expected deferral")
    expect(result.failure.code).toBe("RATE_LIMITED")
    expect(property(result.failure.details).retry_after_ms).toBe(1200)
    expect(
      decode(PrepareIncompleteSchema, property(result.failure.details).preparation).status,
    ).toBe("deferred")
    expect(rejected).toBe(1)
  })

  test("cancelling preparation interrupts the shared request owner without retry or readiness", async () => {
    const f = await fixture({ a: {} })
    let calls = 0
    let released = 0
    let completed = false
    await f.run(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const api = yield* Notion
        const running = yield* Effect.forkChild(
          prepareGraph({ roots: [id(100)], purpose: "use", freshness: { policy: "refresh" } }).pipe(
            Effect.provideService(Notion, {
              ...api,
              request: (path, body, options) =>
                path === "v1/users/me"
                  ? api.request(path, body, options)
                  : Effect.gen(function* () {
                      calls++
                      yield* Deferred.succeed(entered, undefined)
                      return yield* Effect.never
                    }).pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          released++
                        }),
                      ),
                    ),
            }),
            Effect.tap(() =>
              Effect.sync(() => {
                completed = true
              }),
            ),
          ),
          { startImmediately: true },
        )
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(running)
      }),
    )
    expect(calls).toBe(1)
    expect(released).toBe(1)
    expect(completed).toBe(false)
  })
})

function nativeFixture() {
  const f = sharedSnapshotFixture({ fileCount: 1 })
  const names = ["a", "b", "c", "d", "optional"]
  const pageIds = [skillPage, id(900), id(901), id(902), id(903)]
  const dependencies = [[1, 2], [3], [3], [], []]
  const descriptor = {
    ...library,
    skills: {
      ...library.skills,
      property_ids: { ...library.skills.property_ids, Members: "members", Requires: "requires" },
    },
  }
  const pages = names.map((name, index) => {
    const page = structuredClone(f.main)
    page.id = pageIds[index]!
    const fields = property(page.properties)
    fields.title = {
      id: "title",
      type: "title",
      title: [{ plain_text: name, type: "text", text: { content: name } }],
    }
    fields.skill_id = rich("skill_id", name)
    fields.main_file_id = rich("main_file_id", `main-${name}`)
    fields.requires = {
      id: "requires",
      type: "relation",
      relation: dependencies[index]!.map((child) => ({ id: pageIds[child]! })),
      has_more: false,
    }
    fields.members = {
      id: "members",
      type: "relation",
      relation: index === 0 ? [{ id: pageIds[4] }] : [],
      has_more: false,
    }
    f.bodies.set(pageIds[index]!, `# ${name} instruction\n`)
    return page
  })
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Notion | Store | Crypto.Crypto | HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
    >,
  ) =>
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* effect.pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) => {
              const endpoint = path.split("?", 1)[0]
              if (endpoint === `v1/databases/${library.skills.database_id}`)
                return api.request(path, body, options).pipe(
                  Effect.map((raw) => ({
                    ...property(raw),
                    description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(descriptor) }],
                  })),
                )
              const page = pages.find((page) => endpoint === `v1/pages/${page.id}`)
              if (
                page !== undefined ||
                endpoint === `v1/data_sources/${library.skills.data_source_id}/query`
              ) {
                f.calls.push({
                  path,
                  body,
                  method: options?.method ?? (body === undefined ? "GET" : "POST"),
                })
                return Effect.succeed(
                  page === undefined
                    ? {
                        object: "list",
                        results: structuredClone(pages),
                        has_more: false,
                        next_cursor: null,
                      }
                    : structuredClone(page),
                )
              }
              return api.request(path, body, options)
            },
          }),
        )
      }),
    )
  return { ...f, run, pages, pageIds }
}

describe("prepare through current shared snapshot transport", () => {
  test("a live multi-root diamond reads each required main once and leaves the Member body unread", async () => {
    const f = nativeFixture()
    const result = await f.run(
      prepareGraph(
        { roots: [skillPage, id(901)], purpose: "use" },
        { database: library.skills.database_id },
      ),
    )
    expect(result.status).toBe("ready")
    expect(result.usage.prepared_nodes).toBe(4)
    expect(f.calls.filter((call) => call.path === "v1/users/me")).toHaveLength(1)
    for (const page of f.pageIds.slice(0, 4))
      expect(
        f.calls.filter((call) => call.path.split("?", 1)[0] === `v1/pages/${page}/markdown`),
      ).toHaveLength(1)
    expect(
      f.calls.some((call) => call.path.split("?", 1)[0] === `v1/pages/${id(903)}/markdown`),
    ).toBe(false)
    expect(result.nodes.find((node) => node.id === identity("optional"))?.state).toBe("known")
  })
  test("live inspect loads only the root body even when Requires has a nontrivial closure", async () => {
    const f = nativeFixture()
    const result = await f.run(
      prepareGraph(
        { roots: [skillPage], purpose: "inspect" },
        { database: library.skills.database_id },
      ),
    )
    expect(result.usage.prepared_nodes).toBe(1)
    expect(f.readBodyCount()).toBe(1)
    expect(result.nodes.filter((node) => node.state === "known")).toHaveLength(3)
  })
  test("native reference cycles remain optional directories and do not select target bodies", async () => {
    const f = nativeFixture()
    f.bodies.set(
      skillPage,
      `# Root\n[Optional](https://www.notion.so/${id(903).replaceAll("-", "")})\n`,
    )
    f.bodies.set(
      id(903),
      `# Optional\n[Back](https://www.notion.so/${skillPage.replaceAll("-", "")})\n`,
    )
    const result = await f.run(
      prepareGraph(
        { roots: [skillPage], purpose: "inspect" },
        { database: library.skills.database_id },
      ),
    )
    const root = result.nodes.find((node) => node.state === "prepared")
    if (root?.state !== "prepared") throw new Error("Expected prepared root")
    expect(root.references).toHaveLength(1)
    expect(result.nodes.find((node) => node.id === identity("optional"))?.roles).toEqual([
      "member",
      "reference",
    ])
    expect(result.session_bindings.map((binding) => binding.record.id)).toEqual([identity("a")])
    expect(f.readBodyCount()).toBe(1)
  })
})
