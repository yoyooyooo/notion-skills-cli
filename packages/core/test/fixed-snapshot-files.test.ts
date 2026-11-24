import { describe, expect, test } from "bun:test"
import { Crypto, Effect, FileSystem, Path } from "effect"
import { HttpClient } from "effect/http"
import { cachedRemoteObservation } from "../src/cache.ts"
import { consume } from "../src/consumer.ts"
import { decode, property, SnapshotSchema } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { fileRef, parseTarget } from "../src/ref.ts"
import { prepareCurrentSharedResource } from "../src/shared-current-resource.ts"
import { listSkill, readSkill, targetSnapshot } from "../src/snapshot.ts"
import { Store } from "../src/store.ts"
import { selectionSnapshotIdentityInput } from "../src/snapshot-identity.ts"
import {
  currentBytes as encode,
  currentDigest as digest,
  currentId as id,
  currentLibrary as library,
  currentRich,
  currentSnapshotFixture,
} from "./shared-current-fixture.ts"

async function fixture(fileCount = 3, selectedBody?: string) {
  const f = currentSnapshotFixture({ fileCount: fileCount - 1 })
  Object.assign(f.main.parent, { database_id: library.skills.database_id })
  for (const [n, file] of f.files.entries())
    file.properties.Path = currentRich("path", `references/${n + 1}.md`)
  if (fileCount > 1)
    await f.resource(
      0,
      "references/1.md",
      encode(selectedBody ?? "\uFEFFSelected resource\r\n完整字节\r\n"),
    )
  if (fileCount > 2) f.bodies.set(f.files[1]!.id, "Large unselected resource.\n".repeat(1_000))
  const snapshot = await f.open()
  const objectReads = new Map<string, number>()
  const jsonReads = new Map<string, number>()
  const outputs = new Map<string, Uint8Array>()
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
            output: (path, bytes) =>
              Effect.sync(() => {
                outputs.set(path, bytes)
                return { output: path, reused: false }
              }),
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
    fileRef(snapshot.record.id, path, snapshot.snapshot_id)
  f.clearCalls()
  return { ...f, run, snapshot, file, ref, objectReads, jsonReads, outputs }
}

describe("fixed snapshot selected files", () => {
  test("targetSnapshot keeps its public metadata shape without selected byte payloads", async () => {
    const f = await fixture()
    const selected = f.file("references/1.md")
    const expected = decode(SnapshotSchema, f.json.get(`snapshots/${f.snapshot.snapshot_id}.json`))
    const result = await f.run(
      targetSnapshot(parseTarget(f.ref(selected.path)), { offline: true }, "target"),
    )
    expect(result).toEqual({
      ...expected,
      source: "local_snapshot",
      freshness: { policy: "pinned" },
      materialization: {
        manifest_complete: true,
        local_files_ready: false,
        materialized_paths: [selected.path],
        loaded: false,
      },
    })
    expect(f.objectReads.get(`objects/${selected.sha256}`)).toBe(1)
  })

  test("fixed scalar main text and output each read only their one selected object", async () => {
    for (const output of [undefined, "/memory/main.md"]) {
      const f = await fixture()
      const main = f.file(f.snapshot.entrypoint)
      const expected = f.objects.get(`objects/${main.sha256}`)
      if (expected === undefined) throw new Error("Expected main fixture bytes")
      f.objects.delete(`objects/${f.file("references/1.md").sha256}`)
      const result = await f.run(readSkill(f.ref(), { offline: true, output }))
      expect(result.path).toBe(main.path)
      if ("content" in result) expect([...encode(result.content)]).toEqual([...expected])
      else {
        expect(f.outputs.get(result.output)).toEqual(expected)
        expect(result.sha256).toBe(main.sha256)
        expect(result.entrypoint_sha256).toBe(main.sha256)
      }
      expect([...f.objectReads]).toEqual([[`objects/${main.sha256}`, 1]])
      expect(f.calls).toHaveLength(0)
    }
  })

  test("each fixed scalar call rereads the object and rejects damage after an earlier success", async () => {
    const f = await fixture()
    const selected = f.file("references/1.md"),
      key = `objects/${selected.sha256}`
    for (const output of ["/memory/first", "/memory/second"])
      await f.run(readSkill(f.ref(selected.path), { offline: true, output }))
    expect([...f.objectReads]).toEqual([[key, 2]])
    expect(f.outputs.get("/memory/second")).toEqual(f.outputs.get("/memory/first"))
    f.objects.set(key, encode("corrupt after the successful reads"))
    const error = await f.run(
      Effect.flip(readSkill(f.ref(selected.path), { offline: true, output: "/memory/rejected" })),
    )
    expect(error.code).toBe("STATE_CORRUPT")
    expect([...f.objectReads]).toEqual([[key, 3]])
    expect(f.outputs.has("/memory/rejected")).toBe(false)
    expect(f.calls).toHaveLength(0)
  })

  test("a fixed relative read reuses only its selected file", async () => {
    const relative = await fixture()
    const file = relative.file("references/1.md")
    const result = await relative.run(
      readSkill(file.path, { from: relative.ref(), offline: true, output: "/memory/relative" }),
    )
    expect(result.path).toBe(file.path)
    expect(relative.outputs.get("/memory/relative")).toEqual(
      relative.objects.get(`objects/${file.sha256}`),
    )
    expect([...relative.objectReads]).toEqual([[`objects/${file.sha256}`, 1]])
    expect(relative.calls).toHaveLength(0)
  })

  test("a missing local selection requires explicit current reselection even when a current receipt exists", async () => {
    for (const offline of [false, true]) {
      const f = await fixture()
      const receipts = [...f.json].filter(([key]) => key.startsWith("cache/latest/"))
      expect(receipts).toHaveLength(1)
      expect(property(receipts[0]?.[1]).snapshot_id).toBe(f.snapshot.snapshot_id)
      f.json.delete(`snapshots/${f.snapshot.snapshot_id}.json`)
      const error = await f.run(
        Effect.flip(readSkill(f.ref("references/1.md"), { offline, output: "/memory/rejected" })),
      )
      expect(error.code).toBe("SNAPSHOT_MISSING")
      expect(error.details).toMatchObject({
        phase: "fixed_manifest",
        reason: "manifest_missing",
        snapshot_id: f.snapshot.snapshot_id,
        next: "reselect_current",
      })
      expect(f.outputs.size).toBe(0)
      expect(f.objectReads.size).toBe(0)
      expect(f.calls).toHaveLength(0)
      expect([...f.json].filter(([key]) => key.startsWith("cache/latest/"))).toEqual(receipts)
      if (!offline) {
        const reselected = await f.run(
          targetSnapshot(
            parseTarget(fileRef(f.snapshot.record.id, f.snapshot.entrypoint)),
            { refresh: true, library: library.library_id },
            "entrypoint",
          ),
        )
        expect(reselected.source).toBe("notion")
        expect(reselected.snapshot_id).toBe(f.snapshot.snapshot_id)
        expect(f.calls.length).toBeGreaterThan(0)
        expect(f.recordCalls()).toHaveLength(0)
        expect(f.semanticWrites()).toHaveLength(0)
      }
    }
  })

  test("an expired current cache with old broken references refreshes before the selective reference gate", async () => {
    const f = await fixture()
    const bytes = encode("[Old unresolved resource](./missing.md)\n")
    const hash = digest(bytes)
    const files = [
      ...f.snapshot.files,
      { path: "mounted/README.md", bytes: bytes.byteLength, sha256: hash },
    ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    const version = digest(JSON.stringify(["old-reference-check", f.snapshot.version_id, files]))
    const snapshotId = `s_${digest(selectionSnapshotIdentityInput({ ...f.snapshot, version_id: version }))}`
    const historical = decode(SnapshotSchema, {
      ...f.snapshot,
      files,
      file_bindings: [
        ...f.snapshot.file_bindings!,
        { path: "mounted/README.md", file_id: "old-reference", page_id: id(300) },
      ],
      version_id: version,
      snapshot_id: snapshotId,
    })
    f.objects.set(`objects/${hash}`, bytes)
    f.json.set(`snapshots/${snapshotId}.json`, historical)
    for (const [key, value] of f.json)
      if (key.startsWith("cache/latest/")) {
        const observation = property(value)
        observation.snapshot_id = snapshotId
        observation.current_snapshot = historical
        observation.validated_at = Date.now() - 600_000
      }
    const expired = await f.run(
      cachedRemoteObservation(f.snapshot.record.id, f.snapshot.scope, { access: "metadata" }),
    )
    expect(expired?.snapshot.snapshot_id).toBe(snapshotId)
    f.clearCalls()
    const result = await f.run(
      targetSnapshot(
        parseTarget(fileRef(f.snapshot.record.id, f.snapshot.entrypoint)),
        { library: library.library_id, maxAge: 1_000 },
        "entrypoint",
      ),
    )
    expect(result.source).toBe("notion")
    expect(result.snapshot_id).toBe(f.snapshot.snapshot_id)
    expect(f.calls.length).toBeGreaterThan(0)
    expect(f.objectReads.has(`objects/${hash}`)).toBe(false)
    expect(f.json.get(`snapshots/${snapshotId}.json`)).toEqual(historical)
  })

  for (const fileCount of [3, 101])
    test(`N=${fileCount}: complete local manifest prepares only the entry despite missing or corrupt unselected objects`, async () => {
      const f = await fixture(fileCount)
      const main = f.file(f.snapshot.entrypoint)
      expect(f.snapshot.files).toHaveLength(fileCount)
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
      for (const [path, code] of [
        ["references/1.md", "SNAPSHOT_MISSING"],
        ["references/2.md", "STATE_CORRUPT"],
      ] as const) {
        f.objectReads.clear()
        const error = await f.run(Effect.flip(readSkill(f.ref(path), { offline: true })))
        expect(error.code).toBe(code)
        expect([...f.objectReads.keys()]).toEqual(["objects/" + f.file(path).sha256])
        expect(f.calls).toHaveLength(0)
      }
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
    expect(f.objectReads.get("objects/" + selected.sha256)).toBe(1)
    expect(f.calls).toHaveLength(0)
    expect(result).not.toHaveProperty("sha256")
    expect(result).not.toHaveProperty("entrypoint_sha256")
  })

  test("fixed output proves the selected bytes and independent owner without acquiring the main", async () => {
    const f = await fixture()
    const selected = f.file("references/1.md")
    const main = f.file(f.snapshot.entrypoint)
    const expected = f.objects.get("objects/" + selected.sha256)
    f.objects.delete("objects/" + main.sha256)
    f.objects.delete("objects/" + f.file("references/2.md").sha256)
    const result = await f.run(
      readSkill(f.ref(selected.path), { offline: true, output: "/memory/selected.bin" }),
    )
    expect(result).toMatchObject({
      path: selected.path,
      bytes: selected.bytes,
      sha256: selected.sha256,
      entrypoint_sha256: main.sha256,
      output: "/memory/selected.bin",
      reused: false,
    })
    expect(result).not.toHaveProperty("content")
    expect(f.outputs.get("/memory/selected.bin")).toEqual(expected)
    expect([...f.objectReads.keys()]).toEqual(["objects/" + selected.sha256])
    expect(f.objectReads.get("objects/" + selected.sha256)).toBe(1)
    expect(f.calls).toHaveLength(0)
  })

  for (const [name, body] of [
    ["empty", ""],
    ["binary", "\u0000\u0001\u0002"],
  ]) {
    test(`fixed output preserves ${name} scalar files`, async () => {
      const f = await fixture(2, body)
      const selected = f.file("references/1.md")
      const main = f.file(f.snapshot.entrypoint)
      f.objects.delete("objects/" + main.sha256)
      const result = await f.run(
        readSkill(f.ref(selected.path), { offline: true, output: "/memory/resource.bin" }),
      )
      expect(result).toMatchObject({
        bytes: selected.bytes,
        sha256: selected.sha256,
        entrypoint_sha256: main.sha256,
      })
      const output = f.outputs.get("/memory/resource.bin")
      if (output === undefined) throw new Error("Expected scalar output")
      expect(output.byteLength).toBe(selected.bytes)
      expect(digest(output)).toBe(selected.sha256)
      expect([...f.objectReads.keys()]).toEqual(["objects/" + selected.sha256])
      expect(f.objectReads.get("objects/" + selected.sha256)).toBe(1)
      expect(f.calls).toHaveLength(0)
    })
  }

  test("fixed output preserves scalar objects larger than the resource batch ceiling", async () => {
    const f = await fixture()
    const original = f.file("references/1.md")
    const bytes = new Uint8Array(17 * 1024 * 1024).fill(65)
    const selected = { ...original, bytes: bytes.byteLength, sha256: digest(bytes) }
    const prepared = await f.run(prepareCurrentSharedResource(bytes, selected.mode ?? "100644"))
    const version = digest(JSON.stringify(["large-scalar-object", selected]))
    const snapshotId = `s_${digest(JSON.stringify([f.snapshot.scope, f.snapshot.record.id, version]))}`
    const snapshot = decode(SnapshotSchema, {
      ...f.snapshot,
      files: f.snapshot.files.map((file) => (file.path === selected.path ? selected : file)),
      shared_acquisition: {
        ...f.snapshot.shared_acquisition!,
        files: f.snapshot.shared_acquisition!.files.map((route) =>
          route.path === selected.path
            ? { kind: "resource", path: selected.path, object_id: prepared.content.object_id }
            : route,
        ),
      },
      version_id: version,
      snapshot_id: snapshotId,
    })
    f.json.set(`snapshots/${snapshotId}.json`, snapshot)
    f.objects.set(`objects/${selected.sha256}`, bytes)
    const main = f.file(f.snapshot.entrypoint)
    f.objects.delete(`objects/${main.sha256}`)
    const ref = fileRef(snapshot.record.id, selected.path, snapshotId)
    const result = await f.run(readSkill(ref, { offline: true, output: "/memory/large.bin" }))
    expect(result).toMatchObject({
      bytes: selected.bytes,
      sha256: selected.sha256,
      entrypoint_sha256: main.sha256,
    })
    const output = f.outputs.get("/memory/large.bin")
    if (output === undefined) throw new Error("Expected large scalar output")
    expect(output.byteLength).toBe(selected.bytes)
    expect(digest(output)).toBe(selected.sha256)
    expect([...f.objectReads.keys()]).toEqual([`objects/${selected.sha256}`])
    expect(f.objectReads.get(`objects/${selected.sha256}`)).toBe(1)
    expect(f.calls).toHaveLength(0)
  })

  test("a missing selected native object requires current reselection without remote history recovery", async () => {
    const f = await fixture()
    const main = f.file(f.snapshot.entrypoint)
    f.objects.delete("objects/" + main.sha256)
    f.objects.delete("objects/" + f.file("references/1.md").sha256)
    f.objects.set("objects/" + f.file("references/2.md").sha256, encode("corrupt unselected"))
    const error = await f.run(
      Effect.flip(
        targetSnapshot(
          parseTarget(f.ref()),
          { library: library.library_id },
          "entrypoint",
        ),
      ),
    )
    expect(error.code).toBe("SNAPSHOT_MISSING")
    expect(error.details).toMatchObject({
      phase: "fixed_object",
      reason: "objects_missing",
      snapshot_id: f.snapshot.snapshot_id,
      scope: f.snapshot.scope,
      target: f.snapshot.record.id,
      next: "reselect_current",
      paths: [f.snapshot.entrypoint],
    })
    expect([...f.objectReads.keys()]).toEqual(["objects/" + main.sha256])
    expect(f.calls).toHaveLength(0)
  })

  test("owner, database, exact path and entrypoint admission precede selected bytes", async () => {
    const f = await fixture()
    const target = parseTarget(f.ref())
    const invalid = [
      {
        target: parseTarget(
          fileRef("skill://owner?library=another", "SKILL.md", f.snapshot.snapshot_id),
        ),
        code: "SNAPSHOT_CONFLICT",
      },
      { target, database: id(999), code: "LIBRARY_SCOPE_MISMATCH" },
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
            "target",
          ),
        ),
      )
      expect(error.code).toBe(selection.code)
    }
    const resource = await f.run(
      Effect.flip(
        targetSnapshot(parseTarget(f.ref("references/1.md")), { offline: true }, "entrypoint"),
      ),
    )
    expect(resource.code).toBe("PREPARE_ROOT_NOT_MAIN")
    expect(f.objectReads.size).toBe(0)
    expect(f.calls).toHaveLength(0)
  })

  test("an obsolete fixed path cannot select another manifest path or read its bytes", async () => {
    const f = await fixture()
    const selected = f.file("references/1.md")
    const binding = f.snapshot.file_bindings?.find((file) => file.path === selected.path)
    if (binding === undefined) throw new Error("Expected selected File binding")
    const ref = fileRef(f.snapshot.record.id, "old/location.md", f.snapshot.snapshot_id)
    const result = await f.run(Effect.flip(readSkill(ref, { offline: true })))
    expect(result.code).toBe("FILE_NOT_FOUND")
    expect(f.objectReads.size).toBe(0)
    expect(() => parseTarget(ref + "&file_id=" + binding.file_id)).toThrow()
    expect(f.calls).toHaveLength(0)
  })

  test("missing or corrupt fixed main bytes never fall back to the current body", async () => {
    const missing = await fixture()
    missing.objects.delete("objects/" + missing.file(missing.snapshot.entrypoint).sha256)
    missing.bodies.set(missing.main.id, "The changed current body is not the selected body.")
    for (const offline of [false, true]) {
      const error = await missing.run(
        Effect.flip(targetSnapshot(parseTarget(missing.ref()), { offline }, "entrypoint")),
      )
      expect(error.code).toBe("SNAPSHOT_MISSING")
    }
    expect(missing.calls).toHaveLength(0)
    const corrupt = await fixture()
    corrupt.objects.set(
      "objects/" + corrupt.file(corrupt.snapshot.entrypoint).sha256,
      encode("wrong fixed main"),
    )
    const error = await corrupt.run(
      Effect.flip(targetSnapshot(parseTarget(corrupt.ref()), {}, "entrypoint")),
    )
    expect(error.code).toBe("STATE_CORRUPT")
    expect(error.details).toMatchObject({
      phase: "fixed_object",
      snapshot_id: corrupt.snapshot.snapshot_id,
      scope: corrupt.snapshot.scope,
      target: corrupt.snapshot.record.id,
      path: corrupt.snapshot.entrypoint,
      expected_sha256: corrupt.file(corrupt.snapshot.entrypoint).sha256,
    })
    expect(corrupt.calls).toHaveLength(0)
  })

  test("an invalid complete directory fails before acquiring selected bytes", async () => {
    const f = await fixture()
    const changed = decode(SnapshotSchema, {
      ...f.snapshot,
      files: f.snapshot.files.map((file) =>
        file.path === "references/2.md" ? { ...file, path: "references/1.md" } : file,
      ),
    })
    f.json.set(`snapshots/${f.snapshot.snapshot_id}.json`, changed)
    f.objects.delete("objects/" + f.file(f.snapshot.entrypoint).sha256)
    const error = await f.run(
      Effect.flip(targetSnapshot(parseTarget(f.ref()), { offline: true }, "entrypoint")),
    )
    expect(error.code).toBe("STATE_CORRUPT")
    expect(f.objectReads.size).toBe(0)
    expect(f.calls).toHaveLength(0)
    expect(f.json.get(`snapshots/${f.snapshot.snapshot_id}.json`)).toEqual(changed)
  })

  test("full reads still reject a corrupt unselected object that an entrypoint read can skip", async () => {
    const f = await fixture()
    f.objects.set("objects/" + f.file("references/2.md").sha256, encode("wrong resource"))
    const entry = await f.run(targetSnapshot(parseTarget(f.ref()), { offline: true }, "entrypoint"))
    expect(entry.materialization?.local_files_ready).toBe(false)
    const error = await f.run(Effect.flip(targetSnapshot(parseTarget(f.ref()), { offline: true })))
    expect(error.code).toBe("STATE_CORRUPT")
    expect(f.calls).toHaveLength(0)
  })

  test("a current receipt permits selected reads without scanning unselected damaged objects or renewing freshness", async () => {
    const f = await fixture()
    f.main.properties["Default Context"].checkbox = !f.snapshot.record.default_context
    const current = await f.open()
    expect(current.snapshot_id).not.toBe(f.snapshot.snapshot_id)
    expect(current.version_id).toBe(f.snapshot.version_id)
    f.clearCalls()
    const before = structuredClone([...f.json].filter(([key]) => key.startsWith("cache/latest/")))
    f.objects.delete("objects/" + f.file("references/1.md").sha256)
    f.objects.set(
      "objects/" + f.file("references/2.md").sha256,
      encode("wrong unselected resource"),
    )
    const target = parseTarget(fileRef(f.snapshot.record.id, f.snapshot.entrypoint))
    const entry = await f.run(targetSnapshot(target, {}, "entrypoint"))
    expect(entry.source).toBe("local_cache")
    expect(entry.snapshot_id).toBe(current.snapshot_id)
    expect(entry.record.default_context).toBe(!f.snapshot.record.default_context)
    expect(entry.materialization?.materialized_paths).toEqual([f.snapshot.entrypoint])
    expect(entry.materialization?.local_files_ready).toBe(false)
    expect([...f.objectReads.keys()]).toEqual(["objects/" + f.file(f.snapshot.entrypoint).sha256])
    f.objectReads.clear()
    const listed = await f.run(targetSnapshot(target, {}, "manifest"))
    expect(listed.materialization?.materialized_paths).toEqual([])
    expect(f.objectReads.size).toBe(0)
    expect([...f.json].filter(([key]) => key.startsWith("cache/latest/"))).toEqual(before)
    expect(f.calls).toHaveLength(0)
  })

  test("a current missing selected object may refresh while a corrupt selected object fails locally", async () => {
    const missing = await fixture()
    const current = parseTarget(fileRef(missing.snapshot.record.id, missing.snapshot.entrypoint))
    missing.objects.delete("objects/" + missing.file(missing.snapshot.entrypoint).sha256)
    const restored = await missing.run(targetSnapshot(current, {}, "entrypoint"))
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
    const error = await corrupt.run(Effect.flip(targetSnapshot(current, {}, "entrypoint")))
    expect(error.code).toBe("STATE_CORRUPT")
    expect(corrupt.calls).toHaveLength(0)
  })
})
