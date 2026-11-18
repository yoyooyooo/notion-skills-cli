import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { openFixedSnapshotFiles } from "../src/fixed-snapshot-files.ts"
import { decode, property, SnapshotSchema, type Snapshot } from "../src/model.ts"
import { parseTarget } from "../src/ref.ts"
import { validateSnapshotAcquisition } from "../src/shared-acquisition-model.ts"
import { materializeSharedFixedAcquisition } from "../src/shared-fixed-acquisition.ts"
import { planSelectedSharedSource } from "../src/shared-selected-source.ts"
import { library, sharedSnapshotFixture, skillPage } from "./shared-snapshot-fixture.ts"

async function fixture() {
  const f = sharedSnapshotFixture({ fileCount: 2 })
  const selected = await f.target(parseTarget(skillPage), { database: library.skills.database_id })
  const path = "references/1.md"
  const snapshot: Snapshot = {
    ...selected,
    shared_acquisition: {
      version: 4,
      library,
      source: null,
      files: [{ kind: "resource", path, object_id: `resource-${"a".repeat(64)}` }],
    },
  }
  f.clearCalls()
  return { ...f, snapshot, path }
}

describe("current acquisition contract", () => {
  test("one contract accepts source and resource routes for full text and raw files", async () => {
    const f = await fixture()
    const acquisition = f.snapshot.shared_acquisition!
    for (const source of [
      { kind: "tree" as const, source_id: "source-current", revision: "fixed-revision" },
      {
        kind: "git_member" as const,
        source_id: "source-current",
        revision: "fixed-revision",
        member_root: "skills/demo",
      },
    ]) {
      const current = decode(SnapshotSchema, {
        ...f.snapshot,
        shared_acquisition: {
          ...acquisition,
          source,
          files: [{ kind: "source", path: f.path, source_path: f.path }],
        },
      })
      expect([...validateSnapshotAcquisition(current)]).toEqual([f.path])
    }
    expect([...validateSnapshotAcquisition(f.snapshot)]).toEqual([f.path])
    expect(f.calls).toHaveLength(0)
  })

  test("previous acquisition generations are rejected and cached selections require reselection", async () => {
    const f = await fixture()
    for (const version of [1, 2, 3]) {
      const old = {
        ...f.snapshot,
        shared_acquisition: { ...f.snapshot.shared_acquisition, version },
      }
      expect(() => decode(SnapshotSchema, old)).toThrow()
      f.json.set(`snapshots/${f.snapshot.snapshot_id}.json`, old)
      const error = await f.run(
        Effect.flip(openFixedSnapshotFiles(f.snapshot.snapshot_id, () => [f.path])),
      )
      expect(error.code).toBe("SNAPSHOT_MISSING")
      expect(error.details).toMatchObject({
        reason: "incompatible_acquisition",
        next: "reselect_current",
      })
    }
    expect(f.calls).toHaveLength(0)
  })

  test("routes must belong to the exact owner and complete directory", async () => {
    const f = await fixture()
    const acquisition = f.snapshot.shared_acquisition!
    const route = acquisition.files[0]!
    for (const changed of [
      { ...acquisition, files: [route, route] },
      { ...acquisition, files: [{ ...route, path: "absent.md" }] },
      { ...acquisition, library: { ...library, library_id: "another-library" } },
      { ...acquisition, source: { kind: "tree" as const, source_id: "", revision: "fixed" } },
    ])
      expect(() =>
        validateSnapshotAcquisition({ ...f.snapshot, shared_acquisition: changed }),
      ).toThrow()
    expect(f.calls).toHaveLength(0)
  })

  test("a historical snapshot source is rejected without any history lookup", async () => {
    const f = await fixture()
    const sourceId = `snapshot-${"b".repeat(64)}`
    expect(() =>
      validateSnapshotAcquisition({
        ...f.snapshot,
        shared_acquisition: {
          ...f.snapshot.shared_acquisition!,
          source: { kind: "tree", source_id: sourceId, revision: sourceId },
        },
      }),
    ).toThrow("Historical snapshots")
    const error = await f.run(Effect.flip(planSelectedSharedSource(library, skillPage, sourceId)))
    expect(error.code).toBe("CURRENT_SOURCE_REQUIRED")
    expect(error.details).toMatchObject({ next: "migrate_current_content" })
    expect(f.calls).toHaveLength(0)
  })

  test("offline acquisition never probes the owner or a remote object", async () => {
    const f = await fixture()
    const error = await f.run(
      Effect.flip(materializeSharedFixedAcquisition(f.snapshot, [f.path], { offline: true })),
    )
    expect(error.code).toBe("SNAPSHOT_MISSING")
    expect(f.calls).toHaveLength(0)
  })

  test("disabled current owners cannot acquire bytes through a previous selection", async () => {
    const f = await fixture()
    property(property(f.main.properties).enabled).checkbox = false
    const error = await f.run(Effect.flip(materializeSharedFixedAcquisition(f.snapshot, [f.path])))
    expect(error.code).toBe("SKILL_DISABLED")
    expect(f.calls.filter((call) => call.path === `v1/pages/${skillPage}`)).toHaveLength(1)
    expect(f.calls.some((call) => call.path.includes(library.records.data_source_id))).toBe(false)
    expect(f.writeCount()).toBe(0)
  })
})
