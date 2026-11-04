import { describe, expect, test } from "bun:test"
import { Crypto, Deferred, Effect, Fiber, FileSystem, Path } from "effect"
import { HttpClient } from "effect/http"
import { recordScope } from "../src/cache.ts"
import { type ContentRecord, type Snapshot } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { fileRef } from "../src/ref.ts"
import {
  decodeResourceReadResult,
  readResources,
  type ResourceReadInput,
  type ResourceReadReady,
  type ResourceReadResult,
} from "../src/resource-read.ts"
import { registerRetainedSnapshot } from "../src/shared-history-materialization.ts"
import { sharedSkillId } from "../src/shared-content.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import {
  prepareSharedSnapshotHistory,
  retainSharedSnapshotHistory,
  SHARED_HISTORY_CHUNK_BYTES,
  type SharedSnapshotHistoryPlan,
} from "../src/shared-snapshot-history.ts"
import { Store } from "../src/store.ts"
import {
  digest,
  encode,
  id,
  library,
  sharedSnapshotFixture,
  skillPage,
} from "./shared-snapshot-fixture.ts"

const scope = digest(
  JSON.stringify(["fixture-user", "", "https://api.notion.com", "controlled-credential"]),
)
const binary = new Uint8Array([0, 255, 1, 2, 128, 13, 10])
async function fixture(retained = false, large = false) {
  const f = sharedSnapshotFixture({ fileCount: 1 })
  const original = await f.open()
  const largeBytes = new Uint8Array(SHARED_HISTORY_CHUNK_BYTES * 81)
  for (let chunk = 0; chunk < 81; chunk++)
    largeBytes.fill(
      chunk,
      chunk * SHARED_HISTORY_CHUNK_BYTES,
      (chunk + 1) * SHARED_HISTORY_CHUNK_BYTES,
    )
  const resources = [
    { path: "references/a.txt", bytes: encode("完整 resource\n") },
    { path: "references/bom.txt", bytes: encode("\uFEFF第一行\r\nSecond line\r\n") },
    { path: "empty.txt", bytes: new Uint8Array() },
    { path: "assets/raw.bin", bytes: large ? largeBytes : binary },
    { path: "references/shared.txt", bytes: encode("完整 resource\n") },
    { path: "unselected.txt", bytes: encode("Unselected unique object\n") },
  ]
  const files = [
    ...original.files,
    ...resources.map((file) => ({
      path: file.path,
      bytes: file.bytes.length,
      sha256: digest(file.bytes),
    })),
  ]
  const version = digest(canonicalSharedJson(files))
  let snapshot: Snapshot = {
    ...original,
    scope,
    version_id: version,
    snapshot_id: "s_" + digest(JSON.stringify([scope, original.record.id, version])),
    files,
    file_bindings: [
      { file_id: "file-main", page_id: skillPage, path: original.entrypoint },
      ...resources.map((file, index) => ({
        file_id: "resource-" + index,
        page_id: id(300 + index),
        path: file.path,
      })),
    ],
  }
  for (const file of resources) f.objects.set("objects/" + digest(file.bytes), file.bytes)
  let plan: SharedSnapshotHistoryPlan | undefined
  if (retained) {
    plan = await f.run(prepareSharedSnapshotHistory(library, snapshot))
    await f.run(retainSharedSnapshotHistory(library, { plan, mode: "create" }))
    const saved = await f.run(registerRetainedSnapshot(scope, library, plan.pin_id, plan.manifest))
    snapshot = saved.snapshot
    f.objects.clear()
  } else {
    f.json.set("snapshots/" + snapshot.snapshot_id + ".json", snapshot)
    await f.run(recordScope(scope))
  }
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
  const ref = (path: string) =>
    fileRef(
      snapshot.record.id,
      path,
      snapshot.snapshot_id,
      snapshot.file_bindings?.find((binding) => binding.path === path)?.file_id,
    )
  const selected = ["references/bom.txt", "references/a.txt", "empty.txt", "assets/raw.bin"]
  const input = (paths = selected, budget?: ResourceReadInput["budget"]): ResourceReadInput => ({
    version: 1,
    refs: paths.map(ref),
    ...(budget === undefined ? {} : { budget }),
  })
  return { ...f, run, snapshot, resources, ref, input, plan, jsonReads, objectReads }
}

function ready(result: ResourceReadResult): ResourceReadReady {
  if (result.status !== "ready") throw new Error(JSON.stringify(result))
  return result
}

describe("fixed resource batch", () => {
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

  test("stable File identity corrects an old path hint and duplicate aliases fail before any bytes", async () => {
    const f = await fixture()
    const target = fileRef(
      f.snapshot.record.id,
      "former/path.txt",
      f.snapshot.snapshot_id,
      "resource-0",
    )
    const result = ready(await f.run(readResources({ version: 1, refs: [target] })))
    expect(result.files[0]).toMatchObject({
      requested_ref: target,
      ref: f.ref("references/a.txt"),
      path: "references/a.txt",
    })
    f.objectReads.clear()
    expect(
      await f.run(readResources({ version: 1, refs: [target, f.ref("references/a.txt")] })),
    ).toMatchObject({ status: "failed", error: { code: "RESOURCE_SELECTION_CONFLICT" } })
    expect(f.objectReads.size).toBe(0)
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
          refs: [a, fileRef("shared_skill:another:owner", "empty.txt", f.snapshot.snapshot_id)],
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

  test("cold retained selection admits its owner once, queries one object set, deduplicates shared chunks and leaves unselected bytes missing", async () => {
    const f = await fixture(true)
    const input = f.input(["references/a.txt", "references/shared.txt", "assets/raw.bin"])
    const result = ready(await f.run(readResources(input)))
    expect(result.files.map((file) => file.path)).toEqual([
      "references/a.txt",
      "references/shared.txt",
      "assets/raw.bin",
    ])
    expect(f.calls.filter((call) => call.path === "v1/pages/" + skillPage)).toHaveLength(1)
    const queries = f.calls.filter((call) =>
      call.path.includes(library.records.data_source_id + "/query"),
    )
    expect(queries).toHaveLength(1)
    const query = JSON.stringify(queries)
    expect(query.match(new RegExp("chunk-" + digest(f.resources[0]!.bytes), "g"))).toHaveLength(1)
    expect(query).not.toContain("chunk-" + digest(f.resources.at(-1)!.bytes))
    expect(f.calls.filter((call) => call.path.includes("/markdown"))).toHaveLength(0)
    expect(f.objectReads.get("objects/" + f.snapshot.files[0]!.sha256)).toBeUndefined()
    expect(f.objects.has("objects/" + digest(f.resources.at(-1)!.bytes))).toBe(false)
    expect(
      [...f.jsonReads.entries()]
        .filter(([key]) => key.startsWith("cache/shared-history-manifests/"))
        .map(([, count]) => count),
    ).toEqual([1])
    f.clearCalls()
    const warm = ready(await f.run(readResources(input, { offline: true })))
    expect(warm).toEqual(result)
    expect(f.calls).toHaveLength(0)
  })

  test("more than 80 distinct retained chunks are batched and source bytes remain bounded", async () => {
    const f = await fixture(true, true)
    const result = ready(
      await f.run(readResources(f.input(["assets/raw.bin"], { maxBytes: 3_000_000 }))),
    )
    expect(result.files[0]?.bytes).toBe(SHARED_HISTORY_CHUNK_BYTES * 81)
    expect(
      f.calls.filter((call) => call.path.includes(library.records.data_source_id + "/query")),
    ).toHaveLength(2)
  })

  test("a corrupt selected object produces no partial ready and never substitutes current bodies", async () => {
    const f = await fixture()
    f.objects.set("objects/" + digest(binary), new Uint8Array(binary.length))
    const result = await f.run(readResources(f.input()))
    expect(result).toMatchObject({ status: "failed", error: { code: "STATE_CORRUPT" } })
    expect("files" in result).toBe(false)
    expect(f.calls).toHaveLength(0)
    const cold = await fixture(true)
    cold.records.clear()
    const missing = await cold.run(readResources(cold.input()))
    expect(missing.status).toBe("failed")
    expect("files" in missing).toBe(false)
    expect(cold.calls.filter((call) => call.path.includes("/markdown"))).toHaveLength(0)
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

  test("remote locator domains require canonical database identities and subscription router kind", async () => {
    const f = await fixture()
    const original = ready(await f.run(readResources(f.input(["references/a.txt"]))))
    const { file_bindings: _bindings, ...withoutBindings } = original.manifest
    const { file_id: _fileId, ...file } = original.files[0]!
    const wire = (record: ContentRecord) => {
      const snapshot_id =
        "s_" +
        digest(JSON.stringify([original.selection.scope, record.id, original.selection.version_id]))
      const ref = fileRef(record.id, file.path, snapshot_id)
      const manifest = {
        ...withoutBindings,
        record,
        snapshot_id,
        entrypoint: record.entrypoint,
        files: original.manifest.files.map((entry) =>
          entry.path === original.manifest.entrypoint
            ? { ...entry, path: record.entrypoint }
            : entry,
        ),
      }
      return {
        input: { version: 1 as const, refs: [ref] },
        result: {
          ...original,
          manifest,
          manifest_sha256: digest(canonicalSharedJson(manifest)),
          selection: { ...original.selection, owner: record.id, snapshot_id },
          files: [{ ...file, requested_ref: ref, ref }],
        },
      }
    }
    const page: ContentRecord = {
      ...original.manifest.record,
      id: "notion_page:" + id(501),
      ref: fileRef("notion_page:" + id(501), "SKILL.md"),
      locator: {
        type: "notion_page",
        page_id: id(501),
        database_id: id(502),
        data_source_id: id(503),
      },
    }
    const subscription: ContentRecord = {
      ...page,
      id: "notion_subscription:" + id(504),
      kind: "router",
      entrypoint: "ROUTER.md",
      ref: fileRef("notion_subscription:" + id(504), "ROUTER.md"),
      locator: {
        type: "notion_subscription",
        subscription_id: id(504),
        database_id: id(502),
        data_source_id: id(503),
        target_database_id: id(505),
      },
    }
    for (const record of [page, subscription]) {
      const valid = wire(record)
      expect(await f.run(decodeResourceReadResult(valid.result, valid.input))).toEqual(valid.result)
      for (const field of [
        "database_id",
        "data_source_id",
        ...(record.locator.type === "notion_subscription" ? ["target_database_id"] : []),
      ]) {
        for (const identifier of ["x", id(502).toUpperCase()]) {
          const malformed = wire({ ...record, locator: { ...record.locator, [field]: identifier } })
          await expect(
            f.run(decodeResourceReadResult(malformed.result, malformed.input)),
          ).rejects.toMatchObject({ code: "RESOURCE_INVALID_PROOF" })
        }
      }
    }
    const wrongKind = wire({
      ...subscription,
      kind: "skill",
      entrypoint: "SKILL.md",
      ref: fileRef(subscription.id, "SKILL.md"),
    })
    await expect(
      f.run(decodeResourceReadResult(wrongKind.result, wrongKind.input)),
    ).rejects.toMatchObject({ code: "RESOURCE_INVALID_PROOF" })
  })

  test("encoded stable shared identities remain valid for batch reads and the pure decoder", async () => {
    const f = await fixture()
    if (f.snapshot.record.locator.type !== "shared_skill")
      throw new Error("Expected shared fixture")
    const identity = sharedSkillId("org:team", "guide:v1")
    expect(identity).toBe("shared_skill:org%3Ateam:guide%3Av1")
    const snapshot: Snapshot = {
      ...f.snapshot,
      snapshot_id:
        "s_" + digest(JSON.stringify([f.snapshot.scope, identity, f.snapshot.version_id])),
      record: {
        ...f.snapshot.record,
        id: identity,
        ref: fileRef(identity, f.snapshot.entrypoint),
        locator: { ...f.snapshot.record.locator, library_id: "org:team", skill_id: "guide:v1" },
      },
    }
    f.json.set("snapshots/" + snapshot.snapshot_id + ".json", snapshot)
    const input: ResourceReadInput = {
      version: 1,
      refs: [fileRef(identity, "references/a.txt", snapshot.snapshot_id, "resource-0")],
    }
    const result = ready(await f.run(readResources(input)))
    expect(result.selection.owner).toBe(identity)
    expect(await f.run(decodeResourceReadResult(result, input))).toEqual(result)
    expect(f.calls).toHaveLength(0)
  })

  test("a partial cache restores only missing selected objects from the same retained manifest", async () => {
    const f = await fixture(true)
    f.json.set("snapshots/" + f.snapshot.snapshot_id + ".json", f.snapshot)
    f.objects.set("objects/" + digest(f.resources[0]!.bytes), f.resources[0]!.bytes)
    const main = f.snapshot.files.find((file) => file.path === f.snapshot.entrypoint)!
    f.objects.set("objects/" + main.sha256, encode("unselected corrupt main"))
    const result = ready(
      await f.run(readResources(f.input(["references/a.txt", "assets/raw.bin"]))),
    )
    expect(result.files.map((file) => file.path)).toEqual(["references/a.txt", "assets/raw.bin"])
    expect(f.objectReads.get("objects/" + digest(f.resources[0]!.bytes))).toBe(1)
    expect(f.objectReads.get("objects/" + main.sha256)).toBeUndefined()
    expect(f.objectReads.get("objects/" + digest(f.resources.at(-1)!.bytes))).toBeUndefined()
    expect(f.calls.filter((call) => call.path === "v1/pages/" + skillPage)).toHaveLength(1)
    const queries = f.calls.filter((call) =>
      call.path.includes(library.records.data_source_id + "/query"),
    )
    expect(queries).toHaveLength(1)
    expect(JSON.stringify(queries)).toContain("chunk-" + digest(binary))
    expect(JSON.stringify(queries)).not.toContain("chunk-" + digest(f.resources[0]!.bytes))
    expect(JSON.stringify(queries)).not.toContain("chunk-" + main.sha256)
    expect(f.calls.filter((call) => call.path.includes("/markdown"))).toHaveLength(0)

    const corrupt = await fixture(true)
    corrupt.json.set("snapshots/" + corrupt.snapshot.snapshot_id + ".json", corrupt.snapshot)
    const corruptedBytes = new Uint8Array(corrupt.resources[0]!.bytes.length)
    const corruptedKey = "objects/" + digest(corrupt.resources[0]!.bytes)
    corrupt.objects.set(corruptedKey, corruptedBytes)
    expect(
      await corrupt.run(readResources(corrupt.input(["assets/raw.bin", "references/a.txt"]))),
    ).toMatchObject({ status: "failed", error: { code: "STATE_CORRUPT" } })
    expect(corrupt.objects.get(corruptedKey)).toEqual(corruptedBytes)
    expect(corrupt.calls).toHaveLength(0)

    const conflict = await fixture(true)
    conflict.json.set("snapshots/" + conflict.snapshot.snapshot_id + ".json", {
      ...conflict.snapshot,
      files: conflict.snapshot.files.map((file) =>
        file.path === "unselected.txt" ? { ...file, sha256: "a".repeat(64) } : file,
      ),
    })
    expect(await conflict.run(readResources(conflict.input(["assets/raw.bin"])))).toMatchObject({
      status: "failed",
      error: { code: "STATE_CORRUPT" },
    })
    expect(
      conflict.calls.filter((call) =>
        call.path.includes(library.records.data_source_id + "/query"),
      ),
    ).toHaveLength(0)
    expect(conflict.calls.filter((call) => call.path === "v1/pages/" + skillPage)).toHaveLength(1)
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
    }
  })
})
