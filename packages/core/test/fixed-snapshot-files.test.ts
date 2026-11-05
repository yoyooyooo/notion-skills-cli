import { describe, expect, test } from "bun:test"
import { Crypto, Effect, FileSystem, Path } from "effect"
import { HttpClient } from "effect/http"
import { consume } from "../src/consumer.ts"
import { decode, property, SnapshotSchema } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { fileRef, parseTarget } from "../src/ref.ts"
import {
  materializeRetainedSnapshot,
  registerRetainedSnapshot,
} from "../src/shared-history-materialization.ts"
import {
  prepareSharedSnapshotHistory,
  retainSharedSnapshotHistory,
} from "../src/shared-snapshot-history.ts"
import { listSkill, readSkill, targetSnapshot } from "../src/snapshot.ts"
import { Store } from "../src/store.ts"
import {
  digest,
  encode,
  id,
  library,
  sharedSnapshotFixture,
  skillPage,
} from "./shared-snapshot-fixture.ts"

async function fixture(retain = false, fileCount = 3) {
  const f = sharedSnapshotFixture({ fileCount })
  if (fileCount > 1) f.bodies.set(id(11), "\uFEFFSelected resource\r\n完整字节\r\n")
  if (fileCount > 2) f.bodies.set(id(12), "Large unselected resource.\n".repeat(1_000))
  const snapshot = await f.target(parseTarget(skillPage), { database: library.skills.database_id })
  const plan = retain ? await f.run(prepareSharedSnapshotHistory(library, snapshot)) : undefined
  if (plan !== undefined)
    await f.run(retainSharedSnapshotHistory(library, { plan, mode: "create" }))
  const retained =
    plan === undefined
      ? undefined
      : await f.run(registerRetainedSnapshot(snapshot.scope, library, plan.pin_id, plan.manifest))
  const objectReads = new Map<string, number>()
  const jsonReads = new Map<string, number>()
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
              jsonReads.set(key, (jsonReads.get(key) ?? 0) + 1)
              return store.readJson(key, schema)
            },
            readBytes: (key) => {
              objectReads.set(key, (objectReads.get(key) ?? 0) + 1)
              return store.readBytes(key)
            },
          }),
        )
      }),
    )
  const file = (path: string) => {
    const value = snapshot.files.find((entry) => entry.path === path)
    if (value === undefined) throw new Error("Missing fixture file: " + path)
    return value
  }
  const ref = (path = snapshot.entrypoint) =>
    fileRef(
      snapshot.record.id,
      path,
      snapshot.snapshot_id,
      snapshot.file_bindings?.find((binding) => binding.path === path)?.file_id,
    )
  f.clearCalls()
  return { ...f, run, snapshot, retained, plan, file, ref, objectReads, jsonReads }
}

describe("fixed snapshot selected files", () => {
  test("an expired current cache with old broken references refreshes before the selective reference gate", async () => {
    const f = await fixture()
    const bytes = encode("[Old unresolved resource](./missing.md)\n")
    const hash = digest(bytes)
    const files = [
      ...f.snapshot.files,
      { path: "mounted/README.md", bytes: bytes.byteLength, sha256: hash },
    ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    const version = digest(JSON.stringify(["old-reference-check", f.snapshot.version_id, files]))
    const snapshotId = `s_${digest(JSON.stringify([f.snapshot.scope, f.snapshot.record.id, version]))}`
    const historical = decode(SnapshotSchema, {
      ...f.snapshot,
      files,
      version_id: version,
      snapshot_id: snapshotId,
    })
    f.objects.set(`objects/${hash}`, bytes)
    f.json.set(`snapshots/${snapshotId}.json`, historical)
    for (const [key, value] of f.json)
      if (key.startsWith("cache/latest/")) {
        const observation = property(value)
        observation.snapshot_id = snapshotId
        observation.validated_at = Date.now() - 600_000
      }
    f.clearCalls()
    const result = await f.run(
      targetSnapshot(
        parseTarget(fileRef(f.snapshot.record.id, f.snapshot.entrypoint)),
        { database: library.skills.database_id, maxAge: 1_000 },
        "generated",
        "entrypoint",
      ),
    )
    expect(result.source).toBe("notion")
    expect(result.snapshot_id).toBe(f.snapshot.snapshot_id)
    expect(f.calls.length).toBeGreaterThan(0)
    expect(f.objectReads.has(`objects/${hash}`)).toBe(false)
    expect(f.json.get(`snapshots/${snapshotId}.json`)).toEqual(historical)
  })

  test("complete local manifest prepares only the entry despite missing or corrupt unselected objects", async () => {
    const f = await fixture()
    const main = f.file(f.snapshot.entrypoint)
    f.objects.delete("objects/" + f.file("references/1.md").sha256)
    f.objects.set("objects/" + f.file("references/2.md").sha256, encode("corrupt unselected"))
    const before = structuredClone(f.json.get("snapshots/" + f.snapshot.snapshot_id + ".json"))
    const result = await f.run(
      consume({
        version: 1,
        targets: [f.ref()],
        purpose: "inspect",
        freshness: { policy: "offline" },
      }),
    )
    expect(result.status).toBe("ready")
    if (result.status !== "ready") throw new Error(JSON.stringify(result))
    expect(result.entries[0]?.manifest.files).toEqual(f.snapshot.files)
    expect(result.entries[0]?.materialization).toEqual({
      status: "entry_ready",
      paths: [f.snapshot.entrypoint],
    })
    expect([...f.objectReads.keys()]).toEqual(["objects/" + main.sha256])
    expect(f.jsonReads.get("snapshots/" + f.snapshot.snapshot_id + ".json")).toBe(1)
    expect(f.json.get("snapshots/" + f.snapshot.snapshot_id + ".json")).toEqual(before)
    expect(f.calls).toHaveLength(0)
  })

  test("a pinned directory reads no objects while preserving the complete manifest", async () => {
    const f = await fixture()
    f.objects.clear()
    const listed = await f.run(listSkill(f.ref(""), { offline: true }))
    expect(listed.files.map((file) => file.path)).toEqual(f.snapshot.files.map((file) => file.path))
    expect(listed.materialization).toEqual({
      manifest_complete: true,
      local_files_ready: false,
      materialized_paths: [],
      loaded: false,
    })
    expect(f.objectReads.size).toBe(0)
    expect(f.calls).toHaveLength(0)
  })

  test("a fixed resource read ignores unrelated main or resource cache damage", async () => {
    const f = await fixture()
    const selected = f.file("references/1.md")
    const expected = f.objects.get("objects/" + selected.sha256)
    if (expected === undefined) throw new Error("Expected selected fixture bytes")
    f.objects.set("objects/" + f.file(f.snapshot.entrypoint).sha256, encode("corrupt main"))
    f.objects.delete("objects/" + f.file("references/2.md").sha256)
    const result = await f.run(readSkill(f.ref(selected.path), { offline: true }))
    if (!("content" in result)) throw new Error("Expected text result")
    expect([...new TextEncoder().encode(result.content)]).toEqual([...expected])
    expect(result.materialization?.materialized_paths).toEqual([selected.path])
    expect([...f.objectReads.keys()]).toEqual(["objects/" + selected.sha256])
    expect(f.calls).toHaveLength(0)
  })

  test("a complete local pin restores only a missing selected entry from the same retained manifest", async () => {
    const f = await fixture(true)
    const main = f.file(f.snapshot.entrypoint)
    f.objects.delete("objects/" + main.sha256)
    f.objects.delete("objects/" + f.file("references/1.md").sha256)
    f.objects.set("objects/" + f.file("references/2.md").sha256, encode("corrupt unselected"))
    const result = await f.run(
      targetSnapshot(
        parseTarget(f.ref()),
        { database: library.skills.database_id },
        "generated",
        "entrypoint",
      ),
    )
    expect(result.snapshot_id).toBe(f.snapshot.snapshot_id)
    expect(result.files).toEqual(f.snapshot.files)
    expect(result.materialization).toEqual({
      manifest_complete: true,
      local_files_ready: false,
      materialized_paths: [f.snapshot.entrypoint],
      loaded: false,
    })
    for (const file of f.snapshot.files)
      if (file.path !== f.snapshot.entrypoint)
        expect(f.objectReads.has("objects/" + file.sha256)).toBe(false)
    const objectRequests = f.calls.filter((call) =>
      JSON.stringify(call.body)?.includes('"equals":"object"'),
    )
    expect(objectRequests).toHaveLength(1)
    const selectedChunks =
      f.plan?.manifest.files.find((file) => file.path === f.snapshot.entrypoint)?.chunks ?? []
    for (const chunk of selectedChunks)
      expect(JSON.stringify(objectRequests[0]?.body)).toContain(chunk.object_id)
    for (const file of f.plan?.manifest.files ?? [])
      if (file.path !== f.snapshot.entrypoint)
        for (const chunk of file.chunks)
          expect(JSON.stringify(objectRequests[0]?.body)).not.toContain(chunk.object_id)
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
  })

  test("retained entrypoint restoration used by graph release does not inspect unselected objects", async () => {
    const f = await fixture(true)
    if (f.retained === undefined) throw new Error("Expected retained manifest")
    f.objects.set("objects/" + f.file("references/2.md").sha256, encode("corrupt unselected"))
    const result = await f.run(
      materializeRetainedSnapshot(f.retained, [f.snapshot.entrypoint], { offline: true }),
    )
    expect(result.materialization).toEqual({
      manifest_complete: true,
      local_files_ready: false,
      materialized_paths: [f.snapshot.entrypoint],
      loaded: false,
    })
    expect([...f.objectReads.keys()]).toEqual(["objects/" + f.file(f.snapshot.entrypoint).sha256])
    expect(f.calls).toHaveLength(0)
  })

  test("owner, database, stable File and entrypoint admission precede selected bytes", async () => {
    const f = await fixture()
    const target = parseTarget(f.ref())
    const invalid = [
      { target: { ...target, selector: "shared_skill:another:owner" }, code: "SNAPSHOT_CONFLICT" },
      { target, database: id(999), code: "SKILL_NOT_FOUND" },
      { target: { ...target, file_id: "unknown-file" }, code: "SHARED_FILE_BINDING_UNAVAILABLE" },
      {
        target: parseTarget(fileRef(f.snapshot.record.id, "absent.md", f.snapshot.snapshot_id)),
        code: "FILE_NOT_FOUND",
      },
    ]
    for (const selection of invalid) {
      const error = await f.run(
        Effect.flip(
          targetSnapshot(
            selection.target,
            { offline: true, database: selection.database },
            "generated",
            "target",
          ),
        ),
      )
      expect(error.code).toBe(selection.code)
    }
    const resource = await f.run(
      Effect.flip(
        targetSnapshot(
          parseTarget(f.ref("references/1.md")),
          { offline: true },
          "generated",
          "entrypoint",
        ),
      ),
    )
    expect(resource.code).toBe("PREPARE_ROOT_NOT_MAIN")
    expect(f.objectReads.size).toBe(0)
    expect(f.calls).toHaveLength(0)
  })

  test("a stable File keeps its frozen selected path despite an obsolete hint", async () => {
    const f = await fixture()
    const selected = f.file("references/1.md")
    const binding = f.snapshot.file_bindings?.find((file) => file.path === selected.path)
    if (binding === undefined) throw new Error("Expected selected File binding")
    const ref = fileRef(
      f.snapshot.record.id,
      "old/location.md",
      f.snapshot.snapshot_id,
      binding.file_id,
    )
    const result = await f.run(readSkill(ref, { offline: true }))
    expect(result.path).toBe(selected.path)
    expect(result.materialization?.materialized_paths).toEqual([selected.path])
    expect([...f.objectReads.keys()]).toEqual(["objects/" + selected.sha256])
    expect(f.calls).toHaveLength(0)
  })

  test("missing or corrupt fixed main bytes never fall back to the current body", async () => {
    const missing = await fixture()
    missing.objects.delete("objects/" + missing.file(missing.snapshot.entrypoint).sha256)
    for (const offline of [false, true]) {
      const error = await missing.run(
        Effect.flip(
          targetSnapshot(parseTarget(missing.ref()), { offline }, "generated", "entrypoint"),
        ),
      )
      expect(error.code).toBe("SNAPSHOT_MISSING")
    }
    expect(missing.calls).toHaveLength(0)
    const corrupt = await fixture(true)
    corrupt.objects.set(
      "objects/" + corrupt.file(corrupt.snapshot.entrypoint).sha256,
      encode("wrong fixed main"),
    )
    const error = await corrupt.run(
      Effect.flip(targetSnapshot(parseTarget(corrupt.ref()), {}, "generated", "entrypoint")),
    )
    expect(error.code).toBe("STATE_CORRUPT")
    expect(corrupt.calls).toHaveLength(0)
  })

  test("restoring a missing selection compares the entire frozen manifest before acquiring bytes", async () => {
    const f = await fixture(true)
    const changed = decode(SnapshotSchema, {
      ...f.snapshot,
      files: f.snapshot.files.map((file) =>
        file.path === "references/2.md" ? { ...file, sha256: "a".repeat(64) } : file,
      ),
    })
    f.json.set(`snapshots/${f.snapshot.snapshot_id}.json`, changed)
    f.objects.delete("objects/" + f.file(f.snapshot.entrypoint).sha256)
    const error = await f.run(
      Effect.flip(
        targetSnapshot(parseTarget(f.ref()), { offline: true }, "generated", "entrypoint"),
      ),
    )
    expect(error.code).toBe("STATE_CORRUPT")
    expect([...f.objectReads.keys()]).toEqual(["objects/" + f.file(f.snapshot.entrypoint).sha256])
    expect(f.calls).toHaveLength(0)
    expect(f.json.get(`snapshots/${f.snapshot.snapshot_id}.json`)).toEqual(changed)
  })

  test("full reads still reject a corrupt unselected object that an entrypoint read can skip", async () => {
    const f = await fixture()
    f.objects.set("objects/" + f.file("references/2.md").sha256, encode("wrong resource"))
    const entry = await f.run(
      targetSnapshot(parseTarget(f.ref()), { offline: true }, "generated", "entrypoint"),
    )
    expect(entry.materialization?.local_files_ready).toBe(false)
    const error = await f.run(Effect.flip(targetSnapshot(parseTarget(f.ref()), { offline: true })))
    expect(error.code).toBe("STATE_CORRUPT")
    expect(f.calls).toHaveLength(0)
  })

  test("a current receipt permits selected reads without scanning unselected damaged objects or renewing freshness", async () => {
    const f = await fixture()
    for (const [key, value] of f.json)
      if (key.startsWith("cache/latest/"))
        property(value).default_context = !f.snapshot.record.default_context
    const before = structuredClone([...f.json].filter(([key]) => key.startsWith("cache/latest/")))
    f.objects.delete("objects/" + f.file("references/1.md").sha256)
    f.objects.set(
      "objects/" + f.file("references/2.md").sha256,
      encode("wrong unselected resource"),
    )
    const target = parseTarget(fileRef(f.snapshot.record.id, f.snapshot.entrypoint))
    const entry = await f.run(targetSnapshot(target, {}, "generated", "entrypoint"))
    expect(entry.source).toBe("local_cache")
    expect(entry.record.default_context).toBe(!f.snapshot.record.default_context)
    expect(entry.materialization?.materialized_paths).toEqual([f.snapshot.entrypoint])
    expect(entry.materialization?.local_files_ready).toBe(false)
    expect([...f.objectReads.keys()]).toEqual(["objects/" + f.file(f.snapshot.entrypoint).sha256])
    f.objectReads.clear()
    const listed = await f.run(targetSnapshot(target, {}, "generated", "manifest"))
    expect(listed.materialization?.materialized_paths).toEqual([])
    expect(f.objectReads.size).toBe(0)
    expect([...f.json].filter(([key]) => key.startsWith("cache/latest/"))).toEqual(before)
    expect(f.calls).toHaveLength(0)
  })

  test("a current missing selected object may refresh while a corrupt selected object fails locally", async () => {
    const missing = await fixture()
    const current = parseTarget(fileRef(missing.snapshot.record.id, missing.snapshot.entrypoint))
    missing.objects.delete("objects/" + missing.file(missing.snapshot.entrypoint).sha256)
    const restored = await missing.run(targetSnapshot(current, {}, "generated", "entrypoint"))
    expect(restored.source).toBe("notion")
    expect(restored.snapshot_id).toBe(missing.snapshot.snapshot_id)
    expect(missing.calls.length).toBeGreaterThan(0)
    expect(missing.objects.has("objects/" + missing.file(missing.snapshot.entrypoint).sha256)).toBe(
      true,
    )
    const corrupt = await fixture()
    corrupt.objects.set(
      "objects/" + corrupt.file(corrupt.snapshot.entrypoint).sha256,
      encode("wrong current main"),
    )
    const error = await corrupt.run(
      Effect.flip(targetSnapshot(current, {}, "generated", "entrypoint")),
    )
    expect(error.code).toBe("STATE_CORRUPT")
    expect(corrupt.calls).toHaveLength(0)
  })
})
