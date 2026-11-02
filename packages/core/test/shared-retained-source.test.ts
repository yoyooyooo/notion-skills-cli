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

async function fixture() {
  const f = sharedSnapshotFixture({ fileCount: 1 })
  const files = [
    { path: "SKILL.md", bytes: encode("# Imported\n\nRead [guide](guide.md).\n") },
    { path: "assets/data.bin", bytes: new Uint8Array([0, 255, 2, 128]) },
    { path: "guide.md", bytes: encode("Complete retained guide.\r\n") },
  ]
  const zip = zipSync(Object.fromEntries(files.map((file) => [file.path, file.bytes])))
  const chunk = { object_id: `chunk-${digest(zip)}`, sha256: digest(zip), bytes: zip.length }
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
    archive: { format: "zip", sha256: digest(zip), bytes: zip.length, chunks: [chunk] },
  }
  const sourceId = `bundle-${digest(canonicalSharedJson(source))}`
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
        data: Buffer.from(zip).toString("base64"),
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
  return { f, source, sourceId, files, chunk }
}

test("complete retained source survives an empty consumer without an upstream or legacy store", async () => {
  const { f, sourceId, files } = await fixture()
  const value = await f.run(resolveSelectedSharedSource(library, skillPage, sourceId))
  expect(value.files).toEqual(files)
  expect(value.source_id).toBe(sourceId)
  expect(value.local_paths).toEqual([])
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
