import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { resolveFileState } from "../src/shared-file-state.ts"
import {
  isResourceContent,
  loadSharedResourceContent,
  prepareSharedResourceContent,
  retainSharedResourceContent,
  SHARED_RESOURCE_MAX_BYTES,
  validatePreparedSharedResource,
  validateSharedResourceManifest,
} from "../src/shared-resource-content.ts"
import { SHARED_HISTORY_CHUNK_BYTES } from "../src/shared-snapshot-history.ts"
import { digest, library, sharedSnapshotFixture, skillPage } from "./shared-snapshot-fixture.ts"

describe("retained non-document resources", () => {
  test("remote reads preserve every byte, deduplicate chunks and never read management prose", async () => {
    const f = sharedSnapshotFixture()
    const bytes = new Uint8Array(SHARED_HISTORY_CHUNK_BYTES * 2 + 9)
    bytes.fill(255, 0, SHARED_HISTORY_CHUNK_BYTES * 2)
    bytes.set([137, 80, 78, 71, 0, 13, 10, 255, 0], bytes.length - 9)
    const prepared = await f.run(prepareSharedResourceContent(bytes, "100755"))
    expect(prepared.objects).toHaveLength(2)
    expect(prepared.manifest.chunks).toHaveLength(3)
    await f.run(
      retainSharedResourceContent(library, { skillPageId: skillPage, prepared, mode: "create" }),
    )
    f.objects.clear()
    f.clearCalls()
    const result = await f.run(
      loadSharedResourceContent(library, { skillPageId: skillPage, content: prepared.content }),
    )
    expect(result.bytes).toEqual(bytes)
    expect(result.verification).toBe("remote_verified")
    expect(result.content.mode).toBe("100755")
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
    expect(f.calls).toHaveLength(2)
    f.objects.set(`objects/${prepared.content.sha256}`, bytes)
    f.records.clear()
    await expect(
      f.run(
        loadSharedResourceContent(library, { skillPageId: skillPage, content: prepared.content }),
      ),
    ).rejects.toMatchObject({ code: "SHARED_RESOURCE_UNAVAILABLE" })
  })

  test("empty resources are exact and executable mode participates in immutable identity", async () => {
    const f = sharedSnapshotFixture()
    const empty = new Uint8Array()
    const regular = await f.run(prepareSharedResourceContent(empty, "100644"))
    const executable = await f.run(prepareSharedResourceContent(empty, "100755"))
    const unknown = await f.run(prepareSharedResourceContent(empty, null))
    expect(regular.content.sha256).toBe(digest(empty))
    expect(regular.content.object_id).not.toBe(executable.content.object_id)
    expect(regular.content.object_id).not.toBe(unknown.content.object_id)
    expect(regular.objects).toHaveLength(0)
    await f.run(
      retainSharedResourceContent(library, {
        skillPageId: skillPage,
        prepared: regular,
        mode: "create",
      }),
    )
    f.clearCalls()
    expect(
      (
        await f.run(
          loadSharedResourceContent(library, { skillPageId: skillPage, content: regular.content }),
        )
      ).bytes,
    ).toEqual(empty)
    expect(f.calls).toHaveLength(1)
  })

  test("tampered framing, byte checksums, mode and extra objects fail before retention", async () => {
    const f = sharedSnapshotFixture()
    const prepared = await f.run(
      prepareSharedResourceContent(new Uint8Array([0, 255, 13, 10]), "100644"),
    )
    const object = prepared.objects[0]!
    const invalid = [
      { ...prepared, objects: [{ ...object, payload: { ...object.payload, data: "AAAAAA==" } }] },
      { ...prepared, objects: [object, object] },
      { ...prepared, manifest: { ...prepared.manifest, bytes: 5 } },
      { ...prepared, content: { ...prepared.content, mode: "100755" } },
    ]
    for (const input of invalid) {
      const result = await f.run(validatePreparedSharedResource(input).pipe(Effect.result))
      expect(result._tag).toBe("Failure")
    }
    expect(f.calls).toHaveLength(0)
    await expect(
      f.run(prepareSharedResourceContent(new Uint8Array(SHARED_RESOURCE_MAX_BYTES + 1), "100644")),
    ).rejects.toMatchObject({ code: "SHARED_RESOURCE_TOO_LARGE" })
    await expect(
      f.run(
        validateSharedResourceManifest(
          { ...prepared.content, object_id: `resource-${"0".repeat(64)}` },
          prepared.manifest,
        ),
      ),
    ).rejects.toMatchObject({ code: "SHARED_RESOURCE_INVALID" })
  })

  test("unknown retention stays an original unresolved read-only reconciliation", async () => {
    const f = sharedSnapshotFixture()
    const prepared = await f.run(prepareSharedResourceContent(new Uint8Array([255, 0]), "100644"))
    f.unknownRecord("object", true)
    await expect(
      f.run(
        retainSharedResourceContent(library, { skillPageId: skillPage, prepared, mode: "create" }),
      ),
    ).rejects.toBeDefined()
    f.clearCalls()
    await expect(
      f.run(
        retainSharedResourceContent(library, {
          skillPageId: skillPage,
          prepared,
          mode: "reconcile",
        }),
      ),
    ).rejects.toMatchObject({ code: "SHARED_RECORD_UNRESOLVED" })
    expect(f.writeCount()).toBe(0)
  })

  test("ownership cannot collapse Markdown/resource or incompatible executable modes", async () => {
    const f = sharedSnapshotFixture()
    const resource = (
      await f.run(prepareSharedResourceContent(new TextEncoder().encode("exact\r\n"), "100755"))
    ).content
    expect(isResourceContent(resource)).toBe(true)
    const text = { object_id: "text", sha256: resource.sha256, bytes: resource.bytes }
    expect(isResourceContent(text)).toBe(false)
    const root = {
      event_id: "resource-a",
      file_id: "resource-file",
      parents: [],
      kind: "adopted" as const,
      content: resource,
    }
    expect(resolveFileState("resource-file", [root]).ownership).toEqual({
      kind: "custom",
      content: resource,
    })
    for (const content of [
      { ...resource, mode: "invalid" },
      { ...resource, mode: undefined },
      { ...text, mode: "invalid" },
    ])
      expect(() => resolveFileState("resource-file", [{ ...root, content }])).toThrow()
    for (const content of [text, { ...text, mode: "100755" }, { ...resource, mode: "100644" }])
      expect(() =>
        resolveFileState("resource-file", [root, { ...root, event_id: "resource-b", content }]),
      ).toThrow()
    const executableText = { ...text, mode: "100755" as const }
    expect(
      resolveFileState("resource-file", [{ ...root, content: executableText }]).ownership,
    ).toEqual({ kind: "custom", content: executableText })
    for (const content of [text, { ...text, mode: "100644" }])
      expect(() =>
        resolveFileState("resource-file", [
          { ...root, content },
          { ...root, event_id: "native-mode-b", content: executableText },
        ]),
      ).toThrow()
    expect(() =>
      resolveFileState("resource-file", [
        root,
        { ...root, event_id: "bad-native", parents: [root.event_id], content: text },
      ]),
    ).toThrow()
    expect(() =>
      resolveFileState("resource-file", [
        root,
        {
          event_id: "bad-follow",
          file_id: root.file_id,
          parents: [root.event_id],
          kind: "following_restored",
          source_revision: "source-v2",
          projection: { normalization_version: 1, sha256: resource.sha256 },
          retained: resource,
        },
      ]),
    ).toThrow()
  })
})
