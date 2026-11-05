import { expect, test } from "bun:test"
import { zipSync } from "fflate"
import { Effect } from "effect"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
} from "../src/shared-records.ts"
import {
  inspectRetainedSource,
  materializeRetainedSource,
  validateRetainedSource,
  type RetainedSource,
} from "../src/shared-retained-source.ts"
import { resolveSelectedSharedSource } from "../src/shared-selected-source.ts"
import {
  sharedSnapshotFixture,
  library,
  skillPage,
  id,
  digest,
  encode,
} from "./shared-snapshot-fixture.ts"
import { property, text } from "../src/model.ts"
import { Store } from "../src/store.ts"

async function fixture(
  suppliedFiles?: readonly { readonly path: string; readonly bytes: Uint8Array }[],
) {
  const f = sharedSnapshotFixture({ fileCount: 1 })
  const files = suppliedFiles ?? [
    { path: "SKILL.md", bytes: encode("# Imported\n\nRead [guide](guide.md).\n") },
    { path: "assets/data.bin", bytes: new Uint8Array([0, 255, 2, 128]) },
    { path: "guide.md", bytes: encode("Complete retained guide.\r\n") },
  ]
  const zip = zipSync(Object.fromEntries(files.map((file) => [file.path, file.bytes])), {
    level: 0,
  })
  const chunks: RetainedSource["archive"]["chunks"][number][] = []
  const chunkBytes = new Map<string, Uint8Array>()
  for (let offset = 0; offset < zip.length; offset += 32768) {
    const bytes = zip.slice(offset, offset + 32768)
    const hash = digest(bytes)
    chunks.push({ object_id: "chunk-" + hash, sha256: hash, bytes: bytes.length })
    chunkBytes.set(hash, bytes)
  }
  const source: RetainedSource = {
    version: 1,
    kind: "retained_bundle",
    library_id: library.library_id,
    skill_page_id: skillPage,
    entrypoint: "SKILL.md",
    files: files.map((file) => ({
      path: file.path,
      sha256: digest(file.bytes),
      bytes: file.bytes.length,
    })),
    archive: { format: "zip", sha256: digest(zip), bytes: zip.length, chunks },
  }
  const sourceId = `bundle-${digest(canonicalSharedJson(source))}`
  for (const chunk of new Map(chunks.map((value) => [value.object_id, value])).values())
    await f.run(
      appendSharedRecord(library, {
        mode: "create",
        recordId: chunk.object_id,
        operationId: `retain-${chunk.object_id}`,
        skillPageId: skillPage,
        entityId: chunk.object_id,
        kind: "object",
        payload: {
          version: 1,
          kind: "exact_bytes",
          encoding: "base64",
          sha256: chunk.sha256,
          bytes: chunk.bytes,
          data: Buffer.from(chunkBytes.get(chunk.sha256)!).toString("base64"),
        },
      }),
    )
  await f.run(
    appendSharedRecord(library, {
      mode: "create",
      recordId: sourceId,
      operationId: `retain-${sourceId}`,
      skillPageId: skillPage,
      entityId: sourceId,
      kind: "source",
      payload: source,
    }),
  )
  f.clearCalls()
  return { f, source, sourceId, files, chunk: chunks[0]!, chunks, zip }
}

function trackedMaterialization(
  f: ReturnType<typeof sharedSnapshotFixture>,
  input: Parameters<typeof materializeRetainedSource>[1],
) {
  const reads: string[] = []
  const writes: Array<{ key: string; bytes: number; sha256: string }> = []
  const effect = Effect.gen(function* () {
    const store = yield* Store
    return yield* materializeRetainedSource(library, input).pipe(
      Effect.provideService(Store, {
        ...store,
        readBytes: (key) =>
          Effect.suspend(() => {
            reads.push(key)
            return store.readBytes(key)
          }),
        writeBytes: (key, bytes) =>
          store.writeBytes(key, bytes).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                writes.push({ key, bytes: bytes.length, sha256: digest(bytes) })
              }),
            ),
          ),
      }),
    )
  })
  return { reads, writes, run: () => f.run(effect), error: () => f.run(Effect.flip(effect)) }
}

function queriedObjectIds(f: ReturnType<typeof sharedSnapshotFixture>) {
  return f.calls.flatMap((call) => {
    expect(
      call.path.startsWith("v1/data_sources/" + library.records.data_source_id + "/query?"),
    ).toBe(true)
    expect(call.method).toBe("POST")
    const filters = property(property(call.body).filter).and
    if (!Array.isArray(filters)) throw new Error("Expected scoped object query filters")
    expect(filters).toContainEqual({ property: "skill", relation: { contains: skillPage } })
    expect(filters).toContainEqual({ property: "kind", select: { equals: "object" } })
    const values = property(filters.find((item) => Array.isArray(property(item).or))).or
    if (!Array.isArray(values)) throw new Error("Expected an exact object ID set")
    return values.map((value) => {
      expect(property(value).property).toBe("entity")
      const id = property(property(value).rich_text).equals
      if (typeof id !== "string") throw new Error("Expected one exact object identity")
      return id
    })
  })
}

function largeBinary() {
  const bytes = new Uint8Array(2 * 1024 * 1024)
  let seed = 0x12345678
  for (let index = 0; index < bytes.length; index++) {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    bytes[index] = seed & 255
  }
  return bytes
}

test("complete retained source survives an empty consumer without an upstream or legacy store", async () => {
  const { f, sourceId, files } = await fixture()
  const value = await f.run(resolveSelectedSharedSource(library, skillPage, sourceId))
  expect(value.files).toEqual(files)
  expect(value.source_id).toBe(sourceId)
  expect(value.local_paths).toEqual([])
  expect([...f.objects.keys()].sort()).toEqual(
    files.map((file) => "objects/" + digest(file.bytes)).sort(),
  )
  expect(f.calls).toHaveLength(2)
  expect(f.writeCount()).toBe(0)
  f.clearCalls()
  expect((await f.run(resolveSelectedSharedSource(library, skillPage, sourceId))).files).toEqual(
    files,
  )
  expect(f.calls).toHaveLength(1)
  expect(f.requestMetrics().body_requests.current_body).toBe(0)
  expect(f.requestMetrics().body_requests.retained_body).toBe(0)
})

test("metadata inspection downloads no source bytes", async () => {
  const { f, sourceId, source } = await fixture()
  expect(await f.run(inspectRetainedSource(library, { skillPageId: skillPage, sourceId }))).toEqual(
    source,
  )
  expect(f.objects.size).toBe(0)
  expect(f.calls).toHaveLength(1)
})

test("missing immutable chunks fail without current body substitution or a partial cache", async () => {
  const { f, sourceId, chunk } = await fixture()
  for (const [page, row] of f.records)
    if (text(property(property(row.properties).record).rich_text) === chunk.object_id)
      f.records.delete(page)
  const error = await f.run(Effect.flip(resolveSelectedSharedSource(library, skillPage, sourceId)))
  expect(error.code).toBe("SHARED_HISTORY_MISSING")
  expect(f.objects.size).toBe(0)
  expect(f.readBodyCount()).toBe(0)
})

test("scope, file identity, chunk bounds and source hashes are validated before acquisition", async () => {
  const { f, sourceId, source } = await fixture()
  for (const changed of [
    { ...source, skill_page_id: id(999) },
    { ...source, files: [source.files[0]!, source.files[0]!] },
    { ...source, entrypoint: "missing.md" },
    { ...source, archive: { ...source.archive, chunks: [] } },
  ])
    await expect(f.run(validateRetainedSource(library, changed, skillPage))).rejects.toThrow()
  await expect(
    f.run(
      materializeRetainedSource(library, {
        skillPageId: skillPage,
        sourceId: `bundle-${"a".repeat(64)}`,
        source,
      }),
    ),
  ).rejects.toThrow("immutable selection")
  expect(f.calls).toHaveLength(0)
})

test("corrupt cached resource content is not silently repaired", async () => {
  const { f, sourceId, source } = await fixture()
  f.objects.set(`objects/${source.files[0]!.sha256}`, encode("wrong"))
  const error = await f.run(Effect.flip(resolveSelectedSharedSource(library, skillPage, sourceId)))
  expect(error.code).toBe("RETAINED_SOURCE_INVALID")
  expect(f.calls).toHaveLength(1)
})

test("bounded object-set queries reject empty, repeated and excessive selections before transport", async () => {
  const { f } = await fixture()
  for (const entityIds of [
    [],
    ["same", "same"],
    Array.from({ length: 81 }, (_, n) => `chunk-${n}`),
  ])
    await expect(
      f.run(querySharedRecords(library, { skillPageId: skillPage, kind: "object", entityIds })),
    ).rejects.toThrow()
  expect(f.calls).toHaveLength(0)
})

test("an empty retained selection validates complete metadata and identity without object access", async () => {
  const { f, sourceId, source } = await fixture()
  f.objects.set("objects/" + source.files[0]!.sha256, encode("corrupt unselected main"))
  const empty = trackedMaterialization(f, { skillPageId: skillPage, sourceId, source, paths: [] })
  expect(await empty.run()).toEqual([])
  expect(empty.reads).toEqual([])
  expect(empty.writes).toEqual([])
  expect(f.calls).toEqual([])
  for (const input of [
    { skillPageId: id(999), sourceId, source, paths: [] },
    { skillPageId: skillPage, sourceId: "bundle-" + "a".repeat(64), source, paths: [] },
    { skillPageId: skillPage, sourceId, source: { ...source, entrypoint: "absent.md" }, paths: [] },
  ]) {
    const invalid = trackedMaterialization(f, input)
    await invalid.error()
    expect(invalid.reads).toEqual([])
    expect(invalid.writes).toEqual([])
  }
  expect(f.calls).toEqual([])
})

test("retained selections reject missing, repeated and noncanonical paths before object access", async () => {
  const { f, sourceId, source } = await fixture()
  for (const paths of [["absent.md"], ["SKILL.md", "SKILL.md"], ["../guide.md"]]) {
    const selected = trackedMaterialization(f, { skillPageId: skillPage, sourceId, source, paths })
    expect((await selected.error()).code).toBe("FILE_NOT_FOUND")
    expect(selected.reads).toEqual([])
    expect(selected.writes).toEqual([])
  }
  expect(f.calls).toEqual([])
})

test("cached selected bytes ignore missing and corrupt unselected objects without fetching the ZIP", async () => {
  const { f, sourceId, source, files } = await fixture()
  const main = files[0]!,
    corrupt = files[1]!,
    missing = files[2]!
  f.objects.set("objects/" + digest(main.bytes), main.bytes)
  const damaged = encode("corrupt unselected resource")
  f.objects.set("objects/" + digest(corrupt.bytes), damaged)
  const selected = trackedMaterialization(f, {
    skillPageId: skillPage,
    sourceId,
    source,
    paths: [main.path],
  })
  expect(await selected.run()).toEqual([main])
  expect(selected.reads).toEqual(["objects/" + digest(main.bytes)])
  expect(selected.writes).toEqual([])
  expect(f.calls).toEqual([])
  expect(f.objects.get("objects/" + digest(corrupt.bytes))).toEqual(damaged)
  expect(f.objects.has("objects/" + digest(missing.bytes))).toBe(false)
})

test("selected aliases read one cached object and contradictory complete size metadata fails first", async () => {
  const bytes = encode("One immutable body\r\n")
  const { f, source, sourceId, files } = await fixture([
    { path: "SKILL.md", bytes: encode("# Main\n") },
    { path: "aliases/a.txt", bytes },
    { path: "aliases/b.txt", bytes },
  ])
  f.objects.set("objects/" + digest(bytes), bytes)
  const selected = trackedMaterialization(f, {
    skillPageId: skillPage,
    sourceId,
    source,
    paths: ["aliases/b.txt", "aliases/a.txt"],
  })
  expect(await selected.run()).toEqual(files.slice(1))
  expect(selected.reads).toEqual(["objects/" + digest(bytes)])
  expect(selected.writes).toEqual([])
  expect(f.calls).toEqual([])
  const changed = {
    ...source,
    files: source.files.map((file) =>
      file.path === "aliases/b.txt" ? { ...file, bytes: file.bytes + 1 } : file,
    ),
  }
  const invalid = trackedMaterialization(f, {
    skillPageId: skillPage,
    sourceId: "bundle-" + digest(canonicalSharedJson(changed)),
    source: changed,
    paths: [],
  })
  expect((await invalid.error()).code).toBe("RETAINED_SOURCE_INVALID")
  expect(invalid.reads).toEqual([])
  expect(f.calls).toEqual([])
})

test("selected cache corruption fails without fetching or repairing from the retained ZIP", async () => {
  const { f, sourceId, source } = await fixture()
  const main = source.files[0]!,
    damaged = encode("corrupt selected main")
  f.objects.set("objects/" + main.sha256, damaged)
  const selected = trackedMaterialization(f, {
    skillPageId: skillPage,
    sourceId,
    source,
    paths: [main.path],
  })
  expect((await selected.error()).code).toBe("RETAINED_SOURCE_INVALID")
  expect(selected.reads).toEqual(["objects/" + main.sha256])
  expect(selected.writes).toEqual([])
  expect(f.calls).toEqual([])
  expect(f.objects.get("objects/" + main.sha256)).toEqual(damaged)
})

test("a missing selected file incurs the complete retained ZIP cost but writes only selected bytes", async () => {
  const large = largeBinary()
  const { f, sourceId, source, files, chunks, zip } = await fixture([
    { path: "SKILL.md", bytes: encode("# Complete retained main\n") },
    { path: "assets/unselected.bin", bytes: large },
    { path: "guide.md", bytes: encode("Selected guide\r\n") },
  ])
  const selectedFile = files[2]!,
    damaged = encode("corrupt unselected large object")
  f.objects.set("objects/" + digest(large), damaged)
  const selected = trackedMaterialization(f, {
    skillPageId: skillPage,
    sourceId,
    source,
    paths: [selectedFile.path],
  })
  expect(await selected.run()).toEqual([selectedFile])
  expect(selected.reads).toEqual(["objects/" + digest(selectedFile.bytes)])
  expect(selected.writes).toEqual([
    {
      key: "objects/" + digest(selectedFile.bytes),
      bytes: selectedFile.bytes.length,
      sha256: digest(selectedFile.bytes),
    },
  ])
  expect(f.objects.get("objects/" + digest(large))).toEqual(damaged)
  expect(f.objects.has("objects/" + digest(files[0]!.bytes))).toBe(false)
  expect(f.calls).toHaveLength(1)
  const requested = queriedObjectIds(f)
  const expected = [...new Set(chunks.map((chunk) => chunk.object_id))]
  expect(requested).toEqual(expected)
  expect(requested.length).toBeGreaterThan(1)
  expect(requested.length).toBeLessThanOrEqual(80)
  expect(zip.length).toBeGreaterThan(large.length)
  expect(source.archive.bytes).toBe(zip.length)
  expect(source.archive.sha256).toBe(digest(zip))
  const metrics = f.requestMetrics()
  expect(metrics.total_requests).toBe(1)
  expect(metrics.body_requests.retained_body).toBe(1)
  expect(f.readBodyCount()).toBe(0)
  expect(f.writeCount()).toBe(0)
  console.log(
    "retained-acquisition " +
      JSON.stringify({
        case: "selected-missing-retained-bundle",
        source: "controlled Notion API fixture",
        whole_archive_cost: true,
        requested_paths: [selectedFile.path],
        selected_bytes: selectedFile.bytes.length,
        unselected_large_bytes: large.length,
        archive: { bytes: zip.length, sha256: digest(zip) },
        requested_object_ids: requested,
        unique_requested_chunk_bytes: [
          ...new Map(chunks.map((chunk) => [chunk.object_id, chunk])).values(),
        ].reduce((total, chunk) => total + chunk.bytes, 0),
        object_cache_reads: selected.reads,
        object_cache_writes: selected.writes,
        unselected_corrupt_preserved: true,
        unselected_missing_preserved: true,
        request_metrics: metrics,
      }),
  )
  f.clearCalls()
  const repeated = trackedMaterialization(f, {
    skillPageId: skillPage,
    sourceId,
    source,
    paths: [selectedFile.path],
  })
  expect(await repeated.run()).toEqual([selectedFile])
  expect(repeated.reads).toEqual(["objects/" + digest(selectedFile.bytes)])
  expect(repeated.writes).toEqual([])
  expect(f.calls).toEqual([])
})

test("a bad unselected ZIP member prevents publishing even the valid selected member", async () => {
  const { f, source, files } = await fixture()
  const changed = {
    ...source,
    files: source.files.map((file) =>
      file.path === "guide.md" ? { ...file, sha256: digest("a different frozen body") } : file,
    ),
  }
  const selected = trackedMaterialization(f, {
    skillPageId: skillPage,
    sourceId: "bundle-" + digest(canonicalSharedJson(changed)),
    source: changed,
    paths: [files[0]!.path],
  })
  expect((await selected.error()).code).toBe("RETAINED_SOURCE_INVALID")
  expect(selected.reads).toEqual(["objects/" + digest(files[0]!.bytes)])
  expect(selected.writes).toEqual([])
  expect(f.objects.size).toBe(0)
  expect(queriedObjectIds(f)).toEqual(source.archive.chunks.map((chunk) => chunk.object_id))
  expect(f.readBodyCount()).toBe(0)
  expect(f.writeCount()).toBe(0)
})
