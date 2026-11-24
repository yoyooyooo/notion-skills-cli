import { describe, expect, test } from "bun:test"
import { Crypto, Deferred, Effect, Fiber, FileSystem, Path } from "effect"
import { HttpClient } from "effect/http"
import { invalidateScopeCache, invalidateSnapshotCache, recordScope } from "../src/cache.ts"
import { property, type ContentRecord, type Snapshot } from "../src/model.ts"
import { noConsumptionWrites, type ConsumptionEffects } from "../src/consumption-effects.ts"
import { Notion } from "../src/notion.ts"
import { fileRef } from "../src/ref.ts"
import {
  decodeResourceReadResult,
  readResources,
  type ResourceReadInput,
  type ResourceReadReady,
  type ResourceReadResult,
} from "../src/resource-read.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { Store } from "../src/store.ts"
import {
  currentDigest as digest,
  currentBytes as encode,
  currentId as id,
  currentSnapshotFixture,
  currentScope as scope,
  currentSkillPage as skillPage,
} from "./shared-current-fixture.ts"

const binary = new Uint8Array([0, 255, 1, 2, 128, 13, 10])
async function fixture(
  modes: Readonly<Record<string, NonNullable<Snapshot["files"][number]["mode"]>>> = {},
) {
  const f = currentSnapshotFixture({ fileCount: 6 })
  const resources = [
    { path: "references/a.txt", bytes: encode("完整 resource\n") },
    { path: "references/bom.txt", bytes: encode("\uFEFF第一行\r\nSecond line\r\n") },
    { path: "empty.txt", bytes: new Uint8Array() },
    { path: "assets/raw.bin", bytes: binary },
    { path: "references/shared.txt", bytes: encode("完整 resource\n") },
    { path: "unselected.txt", bytes: encode("Unselected unique object\n") },
  ]
  for (const [n, file] of resources.entries())
    await f.resource(n, file.path, file.bytes, modes[file.path] ?? "100644")
  const snapshot = await f.open()
  for (const file of resources) f.objects.set("objects/" + digest(file.bytes), file.bytes)
  await f.run(recordScope(scope))
  f.clearCalls()
  const jsonReads = new Map<string, number>()
  const objectReads = new Map<string, number>()
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
  const ref = (path: string) => fileRef(snapshot.record.id, path, snapshot.snapshot_id)
  const selected = ["references/bom.txt", "references/a.txt", "empty.txt", "assets/raw.bin"]
  const input = (paths = selected, budget?: ResourceReadInput["budget"]): ResourceReadInput => ({
    version: 1,
    refs: paths.map(ref),
    ...(budget === undefined ? {} : { budget }),
  })
  return { ...f, run, snapshot, resources, ref, input, jsonReads, objectReads }
}

function ready(result: ResourceReadResult): ResourceReadReady {
  if (result.status !== "ready") throw new Error(JSON.stringify(result))
  return result
}

describe("fixed resource batch", () => {
  for (const code of ["ACCESS_DENIED", "AUTH_REQUIRED"] as const)
    test(`known ${code} rejects online and offline complete resource bytes before object reads`, async () => {
      const f = await fixture()
      await f.run(
        code === "ACCESS_DENIED"
          ? invalidateSnapshotCache(f.snapshot.record.id, scope, {
              retainForOffline: true,
              accessDenied: code,
            })
          : invalidateScopeCache(scope),
      )
      f.objectReads.clear()
      for (const offline of [true, false]) {
        const result = await f.run(readResources(f.input(), { offline }))
        expect(result).toMatchObject({ status: "failed", error: { code } })
        expect("files" in result).toBe(false)
        expect(await f.run(decodeResourceReadResult(result, f.input()))).toEqual(result)
      }
      expect(f.objectReads.size).toBe(0)
      expect(f.calls).toHaveLength(0)
    })

  test("strict resource batches retain exact selected bytes and observed effects", async () => {
    const f = await fixture(),
      observed: ConsumptionEffects[] = []
    const result = ready(
      await f.run(
        readResources(f.input(), {
          onEffects: (effects) => observed.push(effects),
        }),
      ),
    )
    expect(property(result).effects).toEqual(noConsumptionWrites())
    expect(observed).toEqual([noConsumptionWrites()])
    expect(result.files.map((file) => file.sha256)).toEqual(
      [f.resources[1]!, f.resources[0]!, f.resources[2]!, f.resources[3]!].map((file) =>
        digest(file.bytes),
      ),
    )
    expect(await f.run(decodeResourceReadResult(result, f.input()))).toEqual(result)
    const { effects: _effects, ...legacy } = result
    expect(await f.run(decodeResourceReadResult(legacy, f.input()))).toEqual(legacy)
    expect(f.calls.some((call) => call.path === "v1/pages" || call.method === "PATCH")).toBe(false)
  })

  test("strict batch guards descendant semantic writes before the actual transport", async () => {
    {
      const f = await fixture(),
        observed: ConsumptionEffects[] = []
      let writes = 0
      const result = await f.run(
        Effect.gen(function* () {
          const api = yield* Notion,
            store = yield* Store
          return yield* readResources(f.input(["references/a.txt"]), {
            onEffects: (effects) => observed.push(effects),
          }).pipe(
            Effect.provideService(Notion, {
              ...api,
              request: (path, body, options) => {
                if (path === "v1/pages")
                  return Effect.sync(() => {
                    writes++
                    return { id: "controlled-write" }
                  })
                return api.request(path, body, options)
              },
            }),
            Effect.provideService(Store, {
              ...store,
              readBytes: (key) =>
                Effect.gen(function* () {
                  const descendant = yield* Notion
                  yield* descendant.request(
                    "v1/pages",
                    { parent: { page_id: skillPage } },
                    { method: "POST" },
                  )
                  return yield* store.readBytes(key)
                }),
            }),
          )
        }),
      )
      expect(writes).toBe(0)
      expect(result).toMatchObject({
        status: "failed",
        effects: noConsumptionWrites(),
        error: { code: "NOTION_READ_ONLY", details: { effects: noConsumptionWrites() } },
      })
      expect("files" in result).toBe(false)
      expect(observed).toEqual([result.effects])
    }
  })

  test("one manifest read preserves selected order and exact text/binary bytes without reading the main or unselected files", async () => {
    const f = await fixture()
    const main = f.snapshot.files.find((file) => file.path === f.snapshot.entrypoint)!
    f.objects.set("objects/" + main.sha256, encode("deliberately corrupt unselected main"))
    f.objects.delete("objects/" + digest(f.resources.at(-1)!.bytes))
    const result = ready(await f.run(readResources(f.input())))
    expect(result.files.map((file) => file.path)).toEqual([
      "references/bom.txt",
      "references/a.txt",
      "empty.txt",
      "assets/raw.bin",
    ])
    expect(result.files[0]?.content).toBe("\uFEFF第一行\r\nSecond line\r\n")
    expect(result.files[2]).toMatchObject({
      encoding: "utf8",
      content: "",
      bytes: 0,
      sha256: digest(new Uint8Array()),
    })
    expect(result.files[3]).toMatchObject({
      encoding: "base64",
      content: Buffer.from(binary).toString("base64"),
      bytes: 7,
      sha256: digest(binary),
    })
    expect(result.manifest.files).toEqual(f.snapshot.files)
    expect(result.materialization).toEqual({
      status: "selected_files_ready",
      paths: result.files.map((file) => file.path),
    })
    expect(result.delivery).toEqual({ status: "not_observed" })
    expect(f.jsonReads.get("snapshots/" + f.snapshot.snapshot_id + ".json")).toBe(1)
    expect(f.objectReads.get("objects/" + main.sha256)).toBeUndefined()
    expect(f.objectReads.get("objects/" + digest(f.resources.at(-1)!.bytes))).toBeUndefined()
    expect([...f.objectReads.values()]).toEqual([1, 1, 1, 1])
    expect(f.calls).toHaveLength(0)
    const warm = ready(await f.run(readResources(f.input(), { offline: true })))
    expect(warm).toEqual(result)
    expect(f.calls).toHaveLength(0)
  })

  test("current file modes bind exact CRLF and binary bytes", async () => {
    const f = await fixture({
      "references/bom.txt": "100755",
      "assets/raw.bin": "100644",
    })
    const input = f.input(["references/bom.txt", "assets/raw.bin", "empty.txt"])
    const result = ready(await f.run(readResources(input)))
    expect(result.files[0]).toMatchObject({
      mode: "100755",
      encoding: "utf8",
      content: "\uFEFF第一行\r\nSecond line\r\n",
      sha256: digest(f.resources[1]!.bytes),
    })
    expect(result.files[1]).toMatchObject({
      mode: "100644",
      encoding: "base64",
      content: Buffer.from(binary).toString("base64"),
      sha256: digest(binary),
    })
    expect(result.files[2]?.mode).toBe("100644")
    expect(
      await f.run(decodeResourceReadResult(JSON.parse(JSON.stringify(result)), input)),
    ).toEqual(result)

    const { mode: _knownMode, ...withoutMode } = result.files[0]!
    const mutations = [
      { index: 0, file: { ...result.files[0]!, mode: "100644" } },
      { index: 0, file: withoutMode },
      { index: 2, file: { ...result.files[2]!, mode: "100755" } },
    ]
    for (const mutation of mutations) {
      const proof = await f.run(
        decodeResourceReadResult(
          {
            ...result,
            files: result.files.map((file, index) =>
              index === mutation.index ? mutation.file : file,
            ),
          },
          input,
        ).pipe(Effect.result),
      )
      expect(proof._tag).toBe("Failure")
      if (proof._tag === "Failure") expect(proof.failure.code).toBe("RESOURCE_INVALID_PROOF")
    }
    f.clearCalls()
    expect(ready(await f.run(readResources(input, { offline: true })))).toEqual(result)
    expect(f.calls).toHaveLength(0)
  })

  test("a stale fixed path fails before bytes and exact paths use the selected manifest", async () => {
    const f = await fixture()
    const target = fileRef(f.snapshot.record.id, "former/path.txt", f.snapshot.snapshot_id)
    f.objectReads.clear()
    expect(await f.run(readResources({ version: 1, refs: [target] }))).toMatchObject({
      status: "failed",
      error: { code: "FILE_NOT_FOUND" },
    })
    expect(f.objectReads.size).toBe(0)
    const exact = f.ref("references/a.txt")
    const result = ready(await f.run(readResources({ version: 1, refs: [exact] })))
    expect(result.files[0]).toMatchObject({
      requested_ref: exact,
      ref: exact,
      path: "references/a.txt",
    })
  })

  test("main, file/byte limits, mixed pins/owners and invalid budgets never read selected objects", async () => {
    const f = await fixture()
    const a = f.ref("references/a.txt")
    const cases: Array<[unknown, string]> = [
      [{ version: 1, refs: [] }, "INVALID_ARGUMENT"],
      [{ version: 1, refs: [a, a] }, "INVALID_ARGUMENT"],
      [{ version: 2, refs: [a] }, "INVALID_ARGUMENT"],
      [{ version: 1, refs: [a], surprise: true }, "INVALID_ARGUMENT"],
      [{ version: 1, refs: [a], budget: { maxFiles: 65 } }, "INVALID_ARGUMENT"],
      [{ version: 1, refs: [a], budget: { maxBytes: 16_777_217 } }, "INVALID_ARGUMENT"],
      [{ version: 1, refs: [a], budget: { timeBudgetMs: 120_001 } }, "INVALID_ARGUMENT"],
      [{ version: 1, refs: [a], budget: { maxBytes: 0 } }, "INVALID_ARGUMENT"],
      [
        { version: 1, refs: [a, f.ref("empty.txt")], budget: { maxFiles: 1 } },
        "RESOURCE_FILE_BUDGET",
      ],
      [
        f.input(["references/a.txt"], { maxBytes: f.resources[0]!.bytes.length - 1 }),
        "RESOURCE_BYTE_BUDGET",
      ],
      [f.input(["references/a.txt", f.snapshot.entrypoint]), "RESOURCE_MAIN_NOT_ALLOWED"],
      [
        {
          version: 1,
          refs: [a, fileRef(f.snapshot.record.id, "empty.txt", "s_" + "a".repeat(64))],
        },
        "RESOURCE_SELECTION_CONFLICT",
      ],
      [
        {
          version: 1,
          refs: [a, fileRef("skill://owner?library=00000000-0000-4000-8000-000000000112", "empty.txt", f.snapshot.snapshot_id)],
        },
        "RESOURCE_SELECTION_CONFLICT",
      ],
    ]
    for (const [input, code] of cases)
      expect(await f.run(readResources(input))).toMatchObject({ status: "failed", error: { code } })
    expect(f.objectReads.size).toBe(0)
    expect(f.calls).toHaveLength(0)
    const boundary = ready(
      await f.run(
        readResources(
          f.input(["references/a.txt"], {
            maxFiles: 1,
            maxBytes: f.resources[0]!.bytes.length,
          }),
        ),
      ),
    )
    expect(boundary.totals).toEqual({ files: 1, bytes: f.resources[0]!.bytes.length })
  })

  test("a corrupt selected object produces no partial ready and never substitutes current bodies", async () => {
    const f = await fixture()
    f.objects.set("objects/" + digest(binary), new Uint8Array(binary.length))
    const result = await f.run(readResources(f.input()))
    expect(result).toMatchObject({ status: "failed", error: { code: "STATE_CORRUPT" } })
    expect("files" in result).toBe(false)
    expect(f.calls).toHaveLength(0)
  })

  test("a local locator cannot impersonate a remote resource owner in a proof or cached manifest", async () => {
    const f = await fixture()
    const ref = fileRef(f.snapshot.record.id, "references/a.txt", f.snapshot.snapshot_id)
    const input: ResourceReadInput = { version: 1, refs: [ref] }
    const original = ready(await f.run(readResources(input)))
    const record: ContentRecord = {
      ...original.manifest.record,
      locator: { type: "local", id: "x", entry: "SKILL.md" },
    }
    const { file_bindings: _bindings, ...withoutBindings } = original.manifest
    const manifest = { ...withoutBindings, record }
    const { file_id: _fileId, ...file } = original.files[0]!
    const forged = {
      ...original,
      manifest,
      manifest_sha256: digest(canonicalSharedJson(manifest)),
      files: [{ ...file, ref }],
    }
    f.objectReads.clear()
    const proof = await f.run(decodeResourceReadResult(forged, input).pipe(Effect.result))
    const { file_bindings: _cachedBindings, ...cached } = f.snapshot
    f.json.set("snapshots/" + f.snapshot.snapshot_id + ".json", { ...cached, record })
    const read = await f.run(readResources(input))
    expect({ proof: proof._tag, read: read.status, objectReads: f.objectReads.size }).toEqual({
      proof: "Failure",
      read: "failed",
      objectReads: 0,
    })
    if (proof._tag === "Failure") expect(proof.failure.code).toBe("RESOURCE_INVALID_PROOF")
    expect(read).toMatchObject({ error: { code: "STATE_CORRUPT" } })
  })

  test("remote current locators require canonical physical identities and reject retired protocols", async () => {
    const f = await fixture()
    const original = ready(await f.run(readResources(f.input(["references/a.txt"]))))
    expect(await f.run(decodeResourceReadResult(original, f.input(["references/a.txt"])))).toEqual(
      original,
    )
    const record = original.manifest.record
    if (record.locator.type !== "shared_skill") throw new Error("Expected a current shared owner")
    const rehash = (manifest: unknown) => ({
      ...original,
      manifest,
      manifest_sha256: digest(canonicalSharedJson(manifest)),
    })
    for (const field of ["page_id", "database_id", "data_source_id"] as const) {
      for (const identifier of ["x", "ABCDEF01-0000-4000-8000-000000000003"]) {
        const manifest = {
          ...original.manifest,
          record: { ...record, locator: { ...record.locator, [field]: identifier } },
        }
        await expect(f.run(decodeResourceReadResult(rehash(manifest)))).rejects.toMatchObject({
          code: "RESOURCE_INVALID_PROOF",
        })
      }
    }
    for (const locator of [
      { type: "notion_page", page_id: id(501), database_id: id(502), data_source_id: id(503) },
      {
        type: "notion_subscription",
        subscription_id: id(504),
        database_id: id(502),
        data_source_id: id(503),
        target_database_id: id(505),
      },
    ]) {
      const manifest = { ...original.manifest, record: { ...record, locator } }
      await expect(f.run(decodeResourceReadResult(rehash(manifest)))).rejects.toMatchObject({
        code: "RESOURCE_INVALID_PROOF",
      })
    }
  })

  test("the pure decoder rejects tampered content, selection, order, completeness and budgets", async () => {
    const f = await fixture()
    const original = ready(await f.run(readResources(f.input())))
    const withFile = (index: number, patch: Partial<ResourceReadReady["files"][number]>) => ({
      ...original,
      files: original.files.map((file, offset) =>
        offset === index ? { ...file, ...patch } : file,
      ),
    })
    const variants = [
      withFile(0, { content: original.files[0]!.content + "x" }),
      withFile(0, { sha256: "a".repeat(64) }),
      withFile(0, { bytes: original.files[0]!.bytes + 1 }),
      withFile(0, { file_id: "another" }),
      withFile(0, { ref: original.files[1]!.ref }),
      {
        ...original,
        files: [...original.files].reverse(),
        materialization: {
          ...original.materialization,
          paths: [...original.materialization.paths].reverse(),
        },
      },
      { ...original, files: original.files.slice(0, -1) },
      { ...original, selection: { ...original.selection, owner: "another" } },
      { ...original, manifest: { ...original.manifest, complete: false } },
      { ...original, budget: { ...original.budget, maxBytes: original.budget.maxBytes + 1 } },
      { ...original, totals: { ...original.totals, bytes: original.totals.bytes + 1 } },
      withFile(3, { content: original.files[3]!.content.slice(1) }),
      { ...original, delivery: { status: "observed" } },
    ]
    f.objectReads.clear()
    f.jsonReads.clear()
    for (const changed of variants) {
      await expect(f.run(decodeResourceReadResult(changed, f.input()))).rejects.toMatchObject({
        code: "RESOURCE_INVALID_PROOF",
      })
    }
    expect(await f.run(decodeResourceReadResult(original, f.input()))).toEqual(original)
    expect(f.objectReads.size).toBe(0)
    expect(f.jsonReads.size).toBe(0)
  })

  test("pre-abort has no I/O and abort/deadline wait for selected-read cleanup without ready", async () => {
    const f = await fixture()
    const controller = new AbortController()
    controller.abort()
    expect(await f.run(readResources(f.input(), { signal: controller.signal }))).toEqual({
      version: 1,
      status: "cancelled",
      reason: "interrupted",
      effects: noConsumptionWrites(),
    })
    expect(f.jsonReads.size).toBe(0)
    expect(f.objectReads.size).toBe(0)
    for (const mode of ["abort", "deadline"] as const) {
      let cleaned = 0
      const abort = new AbortController()
      const result = await f.run(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const store = yield* Store
          const input = f.input(undefined, { timeBudgetMs: mode === "deadline" ? 100 : 30_000 })
          const read = readResources(input, { signal: abort.signal }).pipe(
            Effect.provideService(Store, {
              ...store,
              readBytes: () =>
                Effect.acquireUseRelease(
                  Deferred.succeed(started, undefined),
                  () => Effect.never,
                  () =>
                    Effect.sync(() => {
                      cleaned += 1
                    }),
                ),
            }),
          )
          const fiber = yield* Effect.forkChild(read)
          yield* Deferred.await(started)
          if (mode === "abort") abort.abort()
          return yield* Fiber.join(fiber)
        }),
      )
      expect(cleaned).toBe(1)
      expect(result).toMatchObject(
        mode === "abort"
          ? { status: "cancelled" }
          : { status: "failed", error: { code: "RESOURCE_TIME_BUDGET" } },
      )
      expect("files" in result).toBe(false)
      expect(property(result).effects).toEqual(noConsumptionWrites())
    }
  })
})
