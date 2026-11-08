import { describe, expect, test } from "bun:test"
import { markLocalContentRestriction } from "../src/content-restrictions.ts"
import { property, text } from "../src/model.ts"
import {
  executeSharedResourceAuthoring,
  prepareSharedResourceAuthoring,
  reconcileSharedResourceAuthoring,
} from "../src/shared-resource-authoring.ts"
import { prepareSharedResourceLifecycle } from "../src/shared-resource-lifecycle.ts"
import { inspectSharedResourceState } from "../src/shared-resource-state.ts"
import {
  inspectSharedSnapshotHistory,
  materializeSharedSnapshotFiles,
  restoreSharedSnapshotHistory,
} from "../src/shared-snapshot-history.ts"
import { resourceAuthoringFixture } from "./shared-resource-authoring-fixture.ts"
import { digest, encode, library, skillPage } from "./shared-snapshot-fixture.ts"

const a = new Uint8Array([137, 80, 78, 71, 0, 255, 1])
const b = new Uint8Array([0, 255, 2, 0])
const c = new Uint8Array([255, 3, 0, 1])
const custom = encode("#!/bin/sh\r\nexit 93\r\n\0")
const sourceFiles = (bytes: Uint8Array, mode: "100644" | "100755" = "100644") => [
  { path: "SKILL.md", bytes: encode("# Fixed source\n") },
  { path: "assets/raw.bin", bytes, mode },
]
async function ready() {
  const f = await resourceAuthoringFixture()
  await f.open(false)
  return f
}
async function lifecycle(
  f: Awaited<ReturnType<typeof ready>>,
  action: "delete" | "move" | "restore" | "undelete",
  path: string,
  destinationPath?: string,
) {
  const prepared = await f.run(
    prepareSharedResourceLifecycle({
      library,
      snapshot: await f.open(),
      action,
      path,
      ...(destinationPath === undefined ? {} : { destinationPath }),
    }),
  )
  if (prepared.status !== "planned") throw new Error("Expected one exact lifecycle plan")
  return prepared.plan
}

describe("raw resources in the shared mixed lifecycle", () => {
  test("C1 → N1 → restore C2 → selected C3 keeps raw baseline and effective bytes distinct", async () => {
    const f = await ready()
    const c1 = await f.source(sourceFiles(a, "100755"))
    const replace = await f.run(
      prepareSharedResourceAuthoring({
        library,
        snapshot: await f.open(),
        action: "replace",
        path: "assets/raw.bin",
        bytes: custom,
        mode: "100755",
      }),
    )
    expect(replace.baseline).toMatchObject({
      kind: "resource_followed",
      source_id: c1,
      source_revision: c1,
      content: { sha256: digest(a), mode: "100755" },
    })
    await f.run(executeSharedResourceAuthoring(library, { plan: replace, mode: "create" }))
    const c2 = await f.source(sourceFiles(b))
    expect((await f.cold().open()).files.find((file) => file.path === replace.path)?.sha256).toBe(
      digest(custom),
    )
    const restore = await lifecycle(f, "restore", replace.path)
    expect(restore.before?.sha256).toBe(digest(custom))
    expect(restore.event).toMatchObject({
      kind: "resource_followed",
      source_id: c2,
      source_revision: c2,
      source_path: replace.path,
      content: { sha256: digest(b), mode: "100644" },
    })
    await f.run(executeSharedResourceAuthoring(library, { plan: restore, mode: "create" }))
    const c3 = await f.source(sourceFiles(c, "100755"))
    const reader = f.cold()
    const current = await reader.open()
    expect(current.files.find((file) => file.path === replace.path)).toMatchObject({
      sha256: digest(c),
      bytes: c.length,
      mode: "100755",
    })
    f.clearCalls()
    const state = await reader.run(
      inspectSharedResourceState(library, { target: skillPage, observe: true }),
    )
    const raw = state.files.find((file) => file.file_id === replace.file_id)
    expect(raw).toMatchObject({
      representation: { content: { sha256: digest(b) } },
      display: {
        recorded: { source_revision: c2, fingerprint: { kind: "resource", sha256: digest(b) } },
        selected_comparison: "different_revision",
        observation: { kind: "resource_verified" },
      },
    })
    expect(c3).not.toBe(c2)
    expect(f.writes()).toHaveLength(0)
    expect(f.calls.some((call) => call.path.includes(`${restore.page_id}/markdown`))).toBe(false)
    const older = await reader.run(
      restoreSharedSnapshotHistory(library, { skillPageId: skillPage, pinId: restore.prior_pin }),
    )
    expect(older.files.find((file) => file.path === replace.path)).toEqual({
      path: replace.path,
      bytes: custom,
      mode: "100755",
    })
    const unchanged = await reader.run(
      prepareSharedResourceLifecycle({
        library,
        snapshot: current,
        action: "restore",
        path: replace.path,
      }),
    )
    expect(unchanged.status).toBe("unchanged")
    expect(f.writes()).toHaveLength(0)
  })

  test("source-only move follows the original path; tombstone survives later source updates", async () => {
    const f = await ready()
    await f.source(sourceFiles(a))
    const move = await lifecycle(f, "move", "assets/raw.bin", "renamed/data.bin")
    expect(move.page_id).toBeNull()
    await f.run(executeSharedResourceAuthoring(library, { plan: move, mode: "create" }))
    await f.source(sourceFiles(b, "100755"))
    const moved = await f.cold().open()
    expect(moved.files.some((file) => file.path === "assets/raw.bin")).toBe(false)
    expect(moved.files.find((file) => file.path === "renamed/data.bin")).toMatchObject({
      sha256: digest(b),
      mode: "100755",
    })
    const remove = await lifecycle(f, "delete", "renamed/data.bin")
    expect(remove.before?.sha256).toBe(digest(b))
    await f.run(executeSharedResourceAuthoring(library, { plan: remove, mode: "create" }))
    await f.source(sourceFiles(c))
    const deleted = await f.cold().open()
    expect(
      deleted.files.some(
        (file) => file.path === "assets/raw.bin" || file.path === "renamed/data.bin",
      ),
    ).toBe(false)
    const restore = await lifecycle(f, "restore", "renamed/data.bin")
    expect(restore.source_path).toBe("assets/raw.bin")
    expect(restore.file_id).toBe(move.file_id)
    expect(restore.content.sha256).toBe(digest(c))
    await f.run(executeSharedResourceAuthoring(library, { plan: restore, mode: "create" }))
    const restored = await f.cold().open()
    expect(restored.files.find((file) => file.path === "renamed/data.bin")?.sha256).toBe(digest(c))
    expect(restored.files.some((file) => file.path === "assets/raw.bin")).toBe(false)
    const old = await f
      .cold()
      .run(restoreSharedSnapshotHistory(library, { skillPageId: skillPage, pinId: move.prior_pin }))
    expect(old.files.find((file) => file.path === "assets/raw.bin")?.bytes).toEqual(a)
    expect(old.files.some((file) => file.path === "renamed/data.bin")).toBe(false)
  })

  test("a custom resource without upstream can be deleted and explicitly undeleted with the same identity", async () => {
    const f = await ready()
    const add = await f.run(
      prepareSharedResourceAuthoring({
        library,
        snapshot: await f.open(),
        action: "add",
        path: "check.sh",
        bytes: custom,
        mode: "100755",
      }),
    )
    await f.run(executeSharedResourceAuthoring(library, { plan: add, mode: "create" }))
    const move = await lifecycle(f, "move", "check.sh", "scripts/check.sh")
    await f.run(executeSharedResourceAuthoring(library, { plan: move, mode: "create" }))
    const movedPage = f.files.find(
      (row) => text(property(property(row.properties).file_id).rich_text) === add.file_id,
    )!
    expect(text(property(property(movedPage.properties).path).rich_text)).toBe("scripts/check.sh")
    const remove = await lifecycle(f, "delete", "scripts/check.sh")
    await f.run(executeSharedResourceAuthoring(library, { plan: remove, mode: "create" }))
    expect((await f.cold().open()).files.some((file) => file.path === remove.path)).toBe(false)
    const undelete = await lifecycle(f, "undelete", remove.path)
    expect(undelete.file_id).toBe(add.file_id)
    expect(undelete.content).toEqual(add.content)
    await f.run(executeSharedResourceAuthoring(library, { plan: undelete, mode: "create" }))
    const cold = f.cold()
    expect((await cold.open()).files.find((file) => file.path === remove.path)).toMatchObject({
      sha256: digest(custom),
      mode: "100755",
    })
    f.clearCalls()
    expect((await cold.run(reconcileSharedResourceAuthoring(library, move))).status).toBe("applied")
    expect(f.writes()).toHaveLength(0)
    expect(f.calls.some((call) => call.path.includes(`${move.page_id}/markdown`))).toBe(false)
  })

  for (const accepted of [false, true])
    test(`an unknown Path update accepted=${accepted} never repeats the move or appends an assumed result`, async () => {
      const f = await ready()
      const add = await f.run(
        prepareSharedResourceAuthoring({
          library,
          snapshot: await f.open(),
          action: "add",
          path: "raw.bin",
          bytes: a,
          mode: "100644",
        }),
      )
      await f.run(executeSharedResourceAuthoring(library, { plan: add, mode: "create" }))
      const move = await lifecycle(f, "move", "raw.bin", "new.bin")
      f.unknown("move", accepted)
      await expect(
        f.run(executeSharedResourceAuthoring(library, { plan: move, mode: "create" })),
      ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
      expect(f.children.get(move.page_id!)).toHaveLength(1)
      f.clearCalls()
      await expect(
        f.run(executeSharedResourceAuthoring(library, { plan: move, mode: "create" })),
      ).rejects.toMatchObject({ code: "SHARED_RESOURCE_AUTHORING_UNRESOLVED" })
      expect(f.writes()).toHaveLength(0)
      await expect(f.cold().open()).rejects.toMatchObject({
        code: "SHARED_RESOURCE_AUTHORING_UNRESOLVED",
      })
      expect(f.writes()).toHaveLength(0)
    })

  test("occupied paths, missing exact source paths, live references and local scope fail before any write", async () => {
    const f = await ready()
    await f.source(sourceFiles(a))
    const replace = await f.run(
      prepareSharedResourceAuthoring({
        library,
        snapshot: await f.open(),
        action: "replace",
        path: "assets/raw.bin",
        bytes: custom,
        mode: "100755",
      }),
    )
    await f.run(executeSharedResourceAuthoring(library, { plan: replace, mode: "create" }))
    const occupied = await f.run(
      prepareSharedResourceAuthoring({
        library,
        snapshot: await f.open(),
        action: "add",
        path: "occupied.bin",
        bytes: b,
        mode: "100644",
      }),
    )
    await f.run(executeSharedResourceAuthoring(library, { plan: occupied, mode: "create" }))
    f.clearCalls()
    await expect(lifecycle(f, "move", replace.path, "occupied.bin")).rejects.toMatchObject({
      code: "SHARED_RESOURCE_PATH_CONFLICT",
    })
    expect(f.writes()).toHaveLength(0)
    await f.source([{ path: "SKILL.md", bytes: encode("# Missing exact original path") }])
    f.clearCalls()
    await expect(lifecycle(f, "restore", replace.path)).rejects.toMatchObject({
      code: "SHARED_SOURCE_FILE_MISSING",
    })
    expect(f.writes()).toHaveLength(0)
    f.base.bodies.set(skillPage, "# Main\n\n[Required resource](assets/raw.bin)\n")
    await f.open(false)
    f.clearCalls()
    await expect(lifecycle(f, "delete", replace.path)).rejects.toMatchObject({
      code: "SHARED_REFERENCE_BROKEN",
    })
    expect(f.writes()).toHaveLength(0)
    const snapshot = await f.open()
    const plan = await f.run(
      prepareSharedResourceAuthoring({
        library,
        snapshot,
        action: "add",
        path: "new.bin",
        bytes: c,
        mode: "100644",
      }),
    )
    await f.run(markLocalContentRestriction(snapshot.files[0]!.sha256))
    f.clearCalls()
    await expect(
      f.run(executeSharedResourceAuthoring(library, { plan, mode: "create" })),
    ).rejects.toMatchObject({ code: "SHARED_RESOURCE_LOCAL_SCOPE" })
    expect(f.writes()).toHaveLength(0)
  })

  test("old complete mixed pin supports manifest-only, path-only and full remote restoration; missing chunks do not become current bytes", async () => {
    const f = await ready()
    await f.source(sourceFiles(a, "100755"))
    const replace = await f.run(
      prepareSharedResourceAuthoring({
        library,
        snapshot: await f.open(),
        action: "replace",
        path: "assets/raw.bin",
        bytes: b,
        mode: "100644",
      }),
    )
    await f.run(executeSharedResourceAuthoring(library, { plan: replace, mode: "create" }))
    const next = await f.run(
      prepareSharedResourceAuthoring({
        library,
        snapshot: await f.open(),
        action: "replace",
        path: replace.path,
        bytes: c,
        mode: "100755",
      }),
    )
    await f.run(executeSharedResourceAuthoring(library, { plan: next, mode: "create" }))
    const cold = f.cold()
    const inspected = await cold.run(
      inspectSharedSnapshotHistory(library, { skillPageId: skillPage, pinId: next.prior_pin }),
    )
    expect(cold.state.objects.size).toBe(0)
    const partial = await cold.run(
      materializeSharedSnapshotFiles(library, {
        skillPageId: skillPage,
        pinId: next.prior_pin,
        manifest: inspected.manifest,
        paths: [replace.path],
      }),
    )
    expect(partial).toEqual([{ path: replace.path, bytes: b, mode: "100644" }])
    const all = await cold.run(
      restoreSharedSnapshotHistory(library, { skillPageId: skillPage, pinId: next.prior_pin }),
    )
    expect(
      all.files.map((file) => ({
        path: file.path,
        sha256: digest(file.bytes),
        bytes: file.bytes.length,
        ...(file.mode === undefined ? {} : { mode: file.mode }),
      })),
    ).toEqual(inspected.manifest.files.map(({ chunks: _chunks, ...file }) => file))
    const chunk = inspected.manifest.files.find((file) => file.path === replace.path)!.chunks[0]!
      .object_id
    for (const [id, row] of f.base.records)
      if (text(property(property(row.properties).record).rich_text) === chunk)
        f.base.records.delete(id)
    await expect(
      cold.run(
        restoreSharedSnapshotHistory(library, { skillPageId: skillPage, pinId: next.prior_pin }),
      ),
    ).rejects.toMatchObject({ code: "SHARED_HISTORY_MISSING" })
    const empty = f.cold()
    await expect(
      empty.run(
        materializeSharedSnapshotFiles(library, {
          skillPageId: skillPage,
          pinId: next.prior_pin,
          manifest: inspected.manifest,
          paths: [replace.path],
        }),
      ),
    ).rejects.toMatchObject({ code: "SHARED_HISTORY_MISSING" })
  })
})
