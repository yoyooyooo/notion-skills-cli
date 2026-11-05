import { describe, expect, test } from "bun:test"
import { Crypto, Deferred, Effect, Fiber, FileSystem, Path } from "effect"
import { HttpClient } from "effect/http"
import { recordScope } from "../src/cache.ts"
import { consume, decodeConsumeResult } from "../src/consumer.ts"
import { prepareGraph } from "../src/graph-prepare.ts"
import { aliasFor, property, type Snapshot } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { fileRef } from "../src/ref.ts"
import { sharedSkillId } from "../src/shared-content.ts"
import { registerRetainedSnapshot } from "../src/shared-history-materialization.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import {
  prepareSharedSnapshotHistory,
  retainSharedSnapshotHistory,
} from "../src/shared-snapshot-history.ts"
import { listSkill, readSkill } from "../src/snapshot.ts"
import { Store } from "../src/store.ts"
import { digest, encode, id, library, sharedSnapshotFixture } from "./shared-snapshot-fixture.ts"

type Definition = {
  readonly name?: string
  readonly library?: string
  readonly content?: string
  readonly requires?: readonly string[]
  readonly members?: readonly string[]
}
const scope = digest(
  JSON.stringify(["fixture-user", "", "https://api.notion.com", "controlled-credential"]),
)
async function fixture(definitions: Readonly<Record<string, Definition>>) {
  const f = sharedSnapshotFixture({ fileCount: 1 })
  const snapshots = new Map<string, Snapshot>()
  const opened = new Map<string, number>()
  const readBytes = new Map<string, number>()
  for (const [index, [key, definition]] of Object.entries(definitions).entries()) {
    const libraryId = definition.library ?? library.library_id
    const identity = sharedSkillId(libraryId, key)
    const name = definition.name ?? key
    const content = definition.content ?? `# ${key}\nComplete instructions.\n`
    const bytes = encode(content)
    const version = digest(content)
    const snapshot: Snapshot = {
      scope,
      snapshot_id: `s_${digest(JSON.stringify([scope, identity, version]))}`,
      version_id: version,
      created_at: 1000,
      record: {
        id: identity,
        kind: "skill",
        name,
        alias: aliasFor(name),
        description: key,
        default_context: false,
        enabled: true,
        entrypoint: "SKILL.md",
        ref: fileRef(identity, "SKILL.md"),
        locator: {
          type: "shared_skill",
          library_id: libraryId,
          skill_id: key,
          page_id: id(100 + index),
          database_id: library.skills.database_id,
          data_source_id: library.skills.data_source_id,
        },
      },
      entrypoint: "SKILL.md",
      files: [{ path: "SKILL.md", sha256: digest(bytes), bytes: bytes.byteLength }],
      file_bindings: [{ file_id: `main-${key}`, page_id: id(100 + index), path: "SKILL.md" }],
      required: [],
      members: [],
    }
    snapshots.set(key, snapshot)
    f.objects.set(`objects/${digest(bytes)}`, bytes)
  }
  const get = (key: string) => {
    const snapshot = snapshots.get(key)
    if (snapshot === undefined) throw new Error(`Missing test snapshot ${key}`)
    return snapshot
  }
  const ref = (key: string) => {
    const snapshot = get(key)
    return fileRef(snapshot.record.id, snapshot.entrypoint, snapshot.snapshot_id, `main-${key}`)
  }
  for (const [key, definition] of Object.entries(definitions)) {
    const relation = (child: string) => {
      const snapshot = snapshots.get(child)
      return snapshot === undefined
        ? {
            id: sharedSkillId(library.library_id, child),
            ref: fileRef(
              sharedSkillId(library.library_id, child),
              "SKILL.md",
              `s_${"a".repeat(64)}`,
            ),
            metadata: { kind: "skill", name: child, description: "missing", enabled: true },
          }
        : { id: snapshot.record.id, ref: ref(child), metadata: snapshot.record }
    }
    const snapshot = {
      ...get(key),
      required: (definition.requires ?? []).map(relation),
      members: (definition.members ?? []).map(relation),
    }
    snapshots.set(key, snapshot)
    f.json.set(`snapshots/${snapshot.snapshot_id}.json`, snapshot)
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
            readBytes: (key) => {
              readBytes.set(key, (readBytes.get(key) ?? 0) + 1)
              return store.readBytes(key)
            },
          }),
        )
      }),
    )
  const input = (targets: readonly string[]) => ({
    version: 1 as const,
    targets,
    purpose: "use" as const,
    freshness: { policy: "offline" as const },
  })
  return { ...f, get, ref, run, input, opened, readBytes }
}

describe("once consume contract", () => {
  test("fixed historical names list the manifest without reading body objects or current metadata", async () => {
    const f = await fixture({ a: { name: "Historical Name" } })
    const snapshot = f.get("a")
    f.objects.clear()
    for (const name of [snapshot.record.name, snapshot.record.alias]) {
      const listed = await f.run(
        listSkill(fileRef(name, "", snapshot.snapshot_id), { offline: true }),
      )
      expect(listed.record).toEqual(snapshot.record)
      expect(listed.scope).toBe(snapshot.scope)
      expect(listed.snapshot_id).toBe(snapshot.snapshot_id)
      expect(listed.files).toEqual(
        snapshot.files.map(({ path, bytes }) => ({ path, bytes, ref: f.ref("a") })),
      )
    }
    const wrong = await f.run(
      listSkill(fileRef("current-replacement", "", snapshot.snapshot_id), { offline: true }).pipe(
        Effect.result,
      ),
    )
    expect(wrong._tag === "Failure" && wrong.failure.code).toBe("SNAPSHOT_CONFLICT")
    expect(f.readBytes.size).toBe(0)
    expect(f.calls).toHaveLength(0)
  })

  test("a matching frozen main File ID takes precedence over an obsolete path hint", async () => {
    const f = await fixture({ a: {}, b: {} })
    const snapshot = f.get("a")
    const ref = fileRef(snapshot.record.id, "old-main.md", snapshot.snapshot_id, "main-a")
    const input = f.input([ref])
    const result = await f.run(consume(input))
    expect(result.status).toBe("ready")
    if (result.status !== "ready") throw new Error(JSON.stringify(result))
    const node = result.preparation.nodes[0]
    if (node?.state !== "prepared") throw new Error("Expected prepared entry")
    expect(node.path).toBe(snapshot.entrypoint)
    expect(result.entries[0]?.source_body.ref).toBe(f.ref("a"))
    expect(await f.run(decodeConsumeResult(result, input))).toEqual(result)
    for (const [target, code] of [
      [
        fileRef(snapshot.record.id, "old-main.md", snapshot.snapshot_id, "main-b"),
        "SHARED_FILE_BINDING_UNAVAILABLE",
      ],
      [
        fileRef(f.get("b").record.id, "old-main.md", snapshot.snapshot_id, "main-a"),
        "SNAPSHOT_CONFLICT",
      ],
      [
        fileRef(snapshot.record.id, "old-main.md", `s_${"f".repeat(64)}`, "main-a"),
        "SNAPSHOT_MISSING",
      ],
    ] as const) {
      const rejected = await f.run(consume(f.input([target])))
      expect(rejected.status).toBe("failed")
      if (rejected.status !== "failed") throw new Error("Expected identity rejection")
      expect(rejected.error.code).toBe(code)
    }
    expect(f.calls).toHaveLength(0)
  })

  test("encoded stable shared identities remain valid through fixed consume and its decoder", async () => {
    const f = await fixture({ "guide:v1": { library: "org:team" } })
    const input = f.input([f.ref("guide:v1")])
    const result = await f.run(consume(input))
    expect(result.status).toBe("ready")
    if (result.status !== "ready") throw new Error(JSON.stringify(result))
    expect(result.entries[0]?.manifest.record.id).toBe(sharedSkillId("org:team", "guide:v1"))
    expect(await f.run(decodeConsumeResult(result, input))).toEqual(result)
    expect(f.calls).toHaveLength(0)
  })

  test("returns the same prepared graph and verified entry proofs without another snapshot or object read", async () => {
    const definitions = {
      a: { requires: ["b"], content: "\uFEFF# Exact\r\nKeep all bytes.\r\n" },
      b: {},
    }
    const old = await fixture(definitions)
    const preparation = await old.run(
      prepareGraph({ roots: [old.ref("a")], purpose: "use", freshness: { policy: "offline" } }),
    )
    const f = await fixture(definitions)
    const result = await f.run(consume(f.input([f.ref("a")])))
    if (result.status !== "ready") throw new Error(JSON.stringify(result))
    expect(result.preparation).toEqual(preparation)
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]?.source_body.range).toEqual({ start: 1, end: 3, total_lines: 3 })
    expect(result.entries[0]?.source_body.has_more).toBe(false)
    expect(result.entries[0]?.manifest.file_bindings).toEqual(f.get("a").file_bindings)
    expect(result.entries[0]?.projection.compiler).toBe("source-identity/v1")
    expect(result.delivery.status).toBe("not_observed")
    expect(result.activation.status).toBe("not_evaluated")
    expect([...f.opened.entries()]).toEqual([...old.opened.entries()])
    expect([...f.readBytes.entries()]).toEqual([...old.readBytes.entries()])
    expect(f.calls).toHaveLength(0)
    expect(await f.run(decodeConsumeResult(result))).toEqual(result)
  })

  test("inspect keeps dependencies and members known without selecting their bytes or activating cached content", async () => {
    const f = await fixture({ a: { requires: ["b"], members: ["c"] }, b: {}, c: {} })
    const result = await f.run(consume({ ...f.input([f.ref("a")]), purpose: "inspect" }))
    if (result.status !== "ready") throw new Error(JSON.stringify(result))
    expect(result.entries).toHaveLength(1)
    expect(result.preparation.required_closure).toEqual([])
    expect(f.opened.size).toBe(1)
    expect(result.entries[0]?.materialization.status).toBe("all_files_ready")
    expect(result.export.status).toBe("not_requested")
    expect(result.delivery.status).toBe("not_observed")
    expect(result.activation.status).toBe("not_evaluated")
  })

  test("identical names and source bytes in different libraries remain separate bindings", async () => {
    const f = await fixture({
      a: { name: "Same name", library: "one", content: "same" },
      b: { name: "Same name", library: "two", content: "same" },
    })
    const result = await f.run(consume(f.input([f.ref("a"), f.ref("b")])))
    if (result.status !== "ready") throw new Error(JSON.stringify(result))
    expect(result.preparation.session_bindings.map((binding) => binding.record.id)).toEqual([
      "shared_skill:one:a",
      "shared_skill:two:b",
    ])
    expect(new Set(result.entries.map((entry) => entry.manifest.snapshot_id)).size).toBe(2)
    const wrongRequest = await f.run(
      decodeConsumeResult(result, { version: 1, targets: [f.ref("a")], purpose: "use" }).pipe(
        Effect.result,
      ),
    )
    expect(wrongRequest._tag).toBe("Failure")
    const one = await f.run(consume(f.input([f.ref("a")])))
    if (one.status !== "ready") throw new Error(JSON.stringify(one))
    const switched = {
      ...one,
      preparation: {
        ...one.preparation,
        roots: one.preparation.roots.map((root) => ({ ...root, target: f.ref("b") })),
      },
    }
    expect(
      (
        await f.run(
          decodeConsumeResult(switched, { version: 1, targets: [f.ref("b")], purpose: "use" }).pipe(
            Effect.result,
          ),
        )
      )._tag,
    ).toBe("Failure")
  })

  test("the old fixed read agrees with the source proof for the selected snapshot bytes", async () => {
    const f = await fixture({ a: { content: "\uFEFF# Exact\r\n雪\r\n" } })
    const result = await f.run(consume(f.input([f.ref("a")])))
    if (result.status !== "ready") throw new Error(JSON.stringify(result))
    const entry = result.entries[0]
    const node = result.preparation.nodes[0]
    if (entry === undefined || node?.state !== "prepared")
      throw new Error("Expected prepared entry")
    const read = await f.run(readSkill(node.ref, { offline: true }))
    if (!("content" in read)) throw new Error("Expected complete text")
    expect(read.content).toBe(node.content)
    expect(read.record).toEqual(entry.manifest.record)
    expect(read.snapshot_id).toBe(entry.manifest.snapshot_id)
    expect(read.version_id).toBe(entry.manifest.version_id)
    expect(read.scope).toBe(entry.manifest.scope)
    expect(read.range).toEqual(entry.source_body.range)
    expect(read.has_more).toBe(entry.source_body.has_more)
  })

  test("a real retained pin with only its entry bytes local reports a complete manifest and entry readiness", async () => {
    const f = sharedSnapshotFixture()
    const snapshot = await f.open()
    const plan = await f.run(prepareSharedSnapshotHistory(library, snapshot))
    await f.run(retainSharedSnapshotHistory(library, { plan, mode: "create" }))
    const retained = await f.run(
      registerRetainedSnapshot(scope, library, plan.pin_id, plan.manifest),
    )
    const main = snapshot.files.find((file) => file.path === snapshot.entrypoint)
    const bytes = main === undefined ? undefined : f.objects.get(`objects/${main.sha256}`)
    if (main === undefined || bytes === undefined) throw new Error("Expected retained main bytes")
    f.objects.clear()
    f.objects.set(`objects/${main.sha256}`, bytes)
    f.clearCalls()
    const result = await f.run(
      consume({
        version: 1,
        targets: [
          fileRef(
            retained.snapshot.record.id,
            snapshot.entrypoint,
            retained.snapshot.snapshot_id,
            "file-main",
          ),
        ],
        purpose: "use",
        freshness: { policy: "offline" },
      }),
    )
    if (result.status !== "ready") throw new Error(JSON.stringify(result))
    const entry = result.entries[0]
    expect(entry?.manifest.complete).toBe(true)
    expect(entry?.manifest.files).toHaveLength(3)
    expect(entry?.materialization).toEqual({ status: "entry_ready", paths: [snapshot.entrypoint] })
    expect(result.export.status).toBe("not_requested")
    expect(result.delivery.status).toBe("not_observed")
    expect(f.calls).toHaveLength(0)
  })

  test("a wrong physical main File binding fails consumption while legacy prepare keeps its shape", async () => {
    const f = await fixture({ a: {} })
    const snapshot = f.get("a")
    f.json.set(`snapshots/${snapshot.snapshot_id}.json`, {
      ...snapshot,
      file_bindings: [{ file_id: "main-a", page_id: id(999), path: "SKILL.md" }],
    })
    const old = await f.run(
      prepareGraph({ roots: [f.ref("a")], purpose: "use", freshness: { policy: "offline" } }),
    )
    expect(old.status).toBe("ready")
    const result = await f.run(consume(f.input([f.ref("a")])))
    expect(result.status).toBe("failed")
    if (result.status === "failed") expect(result.error.code).toBe("CONSUME_INVALID_PROOF")
  })

  test("the shared decoder rejects wrong ranges, hashes, manifest refs, graph locks and unknown schema", async () => {
    const f = await fixture({ a: {} })
    const result = await f.run(consume(f.input([f.ref("a")])))
    if (result.status !== "ready") throw new Error(JSON.stringify(result))
    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => {
        value.version = 2
      },
      (value) => {
        property(value.preparation).status = "partial"
      },
      (value) => {
        property(property(value.preparation).graph_lock).sha256 = "f".repeat(64)
      },
      (value) => {
        const entries = value.entries
        if (Array.isArray(entries)) property(property(entries[0]).source_body).has_more = true
      },
      (value) => {
        const entries = value.entries
        if (Array.isArray(entries))
          property(property(property(entries[0]).source_body).range).end = 1
      },
      (value) => {
        const entries = value.entries
        if (Array.isArray(entries))
          property(property(entries[0]).source_body).sha256 = "f".repeat(64)
      },
      (value) => {
        const nodes = property(value.preparation).nodes
        if (Array.isArray(nodes)) property(nodes[0]).content = "truncated"
      },
      (value) => {
        const entries = value.entries
        if (Array.isArray(entries)) property(property(entries[0]).manifest).entrypoint = "OTHER.md"
      },
      (value) => {
        value.delivery = { status: "delivered" }
      },
    ]
    for (const mutate of mutations) {
      const altered = property(structuredClone(result))
      mutate(altered)
      const decoded = await f.run(decodeConsumeResult(altered).pipe(Effect.result))
      expect(decoded._tag).toBe("Failure")
    }
  })

  test("removing a Required edge and recomputing the lock cannot drop the source directory dependency", async () => {
    const f = await fixture({ a: { requires: ["b"] }, b: {} })
    const result = await f.run(consume(f.input([f.ref("a")])))
    if (result.status !== "ready") throw new Error(JSON.stringify(result))
    const root = result.preparation.nodes.find((node) => node.id === f.get("a").record.id)
    if (root?.state !== "prepared") throw new Error("Expected prepared root")
    const { sha256: previousHash, ...originalVector } = result.preparation.graph_lock
    const vector = { ...originalVector, required: [], bindings: [root.binding] }
    const shortened = {
      ...result,
      entries: result.entries.filter((entry) => entry.id === root.id),
      preparation: {
        ...result.preparation,
        nodes: [root],
        required: [],
        required_closure: [root.id],
        session_bindings: [root.binding],
        usage: { ...result.preparation.usage, prepared_nodes: 1, instruction_bytes: root.bytes },
        graph_lock: { ...vector, sha256: digest(canonicalSharedJson(vector)) },
      },
    }
    expect(root.required).toHaveLength(1)
    expect(shortened.preparation.graph_lock.sha256).not.toBe(previousHash)
    expect((await f.run(decodeConsumeResult(shortened).pipe(Effect.result)))._tag).toBe("Failure")
  })

  test("partial, corrupt bytes and conflicting versions preserve core errors without a ready graph", async () => {
    const partial = await fixture({ a: { requires: ["missing"] } })
    const result = await partial.run(consume(partial.input([partial.ref("a")])))
    expect(result.status).toBe("failed")
    if (result.status === "failed") {
      expect(result.error.code).toBe("SNAPSHOT_MISSING")
      expect(property(property(result.error.details).preparation).status).toBe("partial")
      expect("graph_lock" in property(property(result.error.details).preparation)).toBe(false)
    }
    const f = await fixture({ a: {} })
    const first = await f.run(consume(f.input([f.ref("a")])))
    if (first.status !== "ready") throw new Error(JSON.stringify(first))
    const conflict = await f.run(
      consume({
        ...f.input([fileRef(f.get("a").record.id, "SKILL.md", `s_${"f".repeat(64)}`)]),
        sessionBindings: first.preparation.session_bindings,
      }),
    )
    if (conflict.status !== "failed") throw new Error("Expected version conflict")
    expect(conflict.error.code).toBe("PREPARE_VERSION_CONFLICT")
    const main = f.get("a").files[0]
    if (main === undefined) throw new Error("Expected main")
    f.objects.set(`objects/${main.sha256}`, encode("corrupt"))
    const consumed = await f.run(consume(f.input([f.ref("a")])))
    const prepared = await f.run(
      prepareGraph({ roots: [f.ref("a")], purpose: "use", freshness: { policy: "offline" } }).pipe(
        Effect.result,
      ),
    )
    if (consumed.status !== "failed" || prepared._tag !== "Failure")
      throw new Error("Expected checksum failure")
    expect(consumed.error).toEqual({
      code: prepared.failure.code,
      message: prepared.failure.message,
      details: prepared.failure.details,
    })
  })

  test("unsupported file plans and projection compilers fail before reading, and unknown input schema fails closed", async () => {
    const f = await fixture({ a: {} })
    for (const extra of [
      { requestedFiles: [f.ref("a")] },
      { projection: { compiler: "new-projection/v2" } },
    ]) {
      const result = await f.run(consume({ ...f.input([f.ref("a")]), ...extra }))
      if (result.status !== "failed") throw new Error("Expected unsupported capability")
      expect(result.error.code).toBe("CONSUME_UNSUPPORTED")
    }
    const unknown = await f.run(consume({ ...f.input([f.ref("a")]), version: 2 }))
    expect(unknown.status).toBe("failed")
    expect(f.opened.size).toBe(0)
    expect(f.calls).toHaveLength(0)
  })

  test("cancellation waits for request cleanup and cannot produce ready or delivery evidence", async () => {
    const f = await fixture({ a: {} })
    const stop = new AbortController()
    let released = 0
    let outcome: unknown
    await f.run(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const api = yield* Notion
        const running = yield* Effect.forkChild(
          consume(
            { version: 1, targets: [id(100)], purpose: "use", freshness: { policy: "refresh" } },
            { signal: stop.signal },
          ).pipe(
            Effect.provideService(Notion, {
              ...api,
              request: (path, body, options) =>
                path === "v1/users/me"
                  ? api.request(path, body, options)
                  : Effect.gen(function* () {
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
            Effect.tap((result) =>
              Effect.sync(() => {
                outcome = result
              }),
            ),
          ),
          { startImmediately: true },
        )
        yield* Deferred.await(entered)
        stop.abort()
        yield* Fiber.join(running)
      }),
    )
    expect(released).toBe(1)
    expect(property(outcome).status).toBe("cancelled")
    expect("preparation" in property(outcome)).toBe(false)
    expect("delivery" in property(outcome)).toBe(false)
  })

  test("a pre-aborted request does no work, and external fiber interruption is not swallowed", async () => {
    const f = await fixture({ a: {} })
    const stop = new AbortController()
    stop.abort()
    expect((await f.run(consume(f.input([f.ref("a")]), { signal: stop.signal }))).status).toBe(
      "cancelled",
    )
    expect(f.opened.size).toBe(0)
    let completed = false
    let released = false
    await f.run(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const api = yield* Notion
        const running = yield* Effect.forkChild(
          consume({
            version: 1,
            targets: [id(100)],
            purpose: "use",
            freshness: { policy: "refresh" },
          }).pipe(
            Effect.provideService(Notion, {
              ...api,
              request: (path, body, options) =>
                path === "v1/users/me"
                  ? api.request(path, body, options)
                  : Effect.gen(function* () {
                      yield* Deferred.succeed(entered, undefined)
                      return yield* Effect.never
                    }).pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          released = true
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
    expect(released).toBe(true)
    expect(completed).toBe(false)
  })
})
