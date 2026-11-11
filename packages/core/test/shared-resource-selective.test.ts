import { expect, test } from "bun:test"
import { openFixedSnapshotFiles } from "../src/fixed-snapshot-files.ts"
import {
  executeSharedResourceAuthoring,
  prepareSharedResourceAuthoring,
} from "../src/shared-resource-authoring.ts"
import { targetSnapshot } from "../src/snapshot.ts"
import { resourceAuthoringFixture } from "./shared-resource-authoring-fixture.ts"
import { digest, library, skillPage } from "./shared-snapshot-fixture.ts"

test("cold current main admits the full raw manifest without fetching resources; later selection and old pins acquire only original bytes", async () => {
  const f = await resourceAuthoringFixture()
  await f.open(false)
  const first = new Uint8Array([255, 0, 1, 128])
  const second = Uint8Array.from({ length: 100_003 }, (_, index) => index % 251)
  const changed = new Uint8Array([0, 9, 255])
  const add = async (path: string, bytes: Uint8Array, mode: "100644" | "100755") => {
    const plan = await f.run(
      prepareSharedResourceAuthoring({
        library,
        snapshot: await f.open(),
        action: "add",
        path,
        bytes,
        mode,
      }),
    )
    await f.run(executeSharedResourceAuthoring(library, { plan, mode: "create" }))
    return plan
  }
  const a = await add("assets/a.bin", first, "100644")
  const b = await add("scripts/b.sh", second, "100755")
  const reader = f.cold()
  expect(reader.state.objects.size).toBe(0)
  f.clearCalls()
  const main = await reader.run(
    targetSnapshot({ selector: skillPage }, { refresh: true }, "generated", "entrypoint"),
  )
  expect(main.files.find((file) => file.path === a.path)?.sha256).toBe(a.content.sha256)
  expect(main.files.find((file) => file.path === b.path)).toMatchObject({
    sha256: b.content.sha256,
    mode: "100755",
  })
  expect(main.materialization).toMatchObject({
    manifest_complete: true,
    local_files_ready: false,
    materialized_paths: [main.entrypoint],
    loaded: false,
  })
  expect(reader.state.objects.has(`objects/${a.content.sha256}`)).toBe(false)
  expect(reader.state.objects.has(`objects/${b.content.sha256}`)).toBe(false)
  expect(
    f.calls.some(
      (call) =>
        JSON.stringify(call.body ?? {}).includes(a.content.object_id) ||
        JSON.stringify(call.body ?? {}).includes(b.content.object_id),
    ),
  ).toBe(false)
  expect(f.writes()).toHaveLength(0)
  f.clearCalls()
  const selected = await reader.run(
    targetSnapshot({ selector: skillPage, path: a.path }, {}, "generated", "target"),
  )
  expect(selected.snapshot_id).toBe(main.snapshot_id)
  expect(reader.state.objects.get(`objects/${a.content.sha256}`)).toEqual(first)
  expect(reader.state.objects.has(`objects/${b.content.sha256}`)).toBe(false)
  expect(
    f.calls.some((call) => JSON.stringify(call.body ?? {}).includes(b.content.object_id)),
  ).toBe(false)
  expect(f.writes()).toHaveLength(0)
  await expect(
    reader.run(openFixedSnapshotFiles(main, () => [b.path], { offline: true })),
  ).rejects.toMatchObject({ code: "SNAPSHOT_MISSING" })
  const replace = await f.run(
    prepareSharedResourceAuthoring({
      library,
      snapshot: await f.open(),
      action: "replace",
      path: b.path,
      bytes: changed,
      mode: "100644",
    }),
  )
  await f.run(executeSharedResourceAuthoring(library, { plan: replace, mode: "create" }))
  f.clearCalls()
  const old = await reader.run(openFixedSnapshotFiles(main, () => [b.path]))
  expect(old.files).toEqual([{ path: b.path, bytes: second }])
  expect(old.snapshot.files.find((file) => file.path === b.path)?.mode).toBe("100755")
  expect(f.writes()).toHaveLength(0)
  expect(f.calls.some((call) => call.path.includes("/markdown"))).toBe(false)
  const current = await reader.run(
    targetSnapshot({ selector: skillPage }, { refresh: true }, "generated", "manifest"),
  )
  expect(current.snapshot_id).not.toBe(main.snapshot_id)
  expect(current.files.find((file) => file.path === b.path)?.sha256).toBe(digest(changed))
  expect(reader.state.objects.has(`objects/${digest(changed)}`)).toBe(false)
  const complete = await reader.run(targetSnapshot({ selector: skillPage }, {}, "generated", "all"))
  expect(complete.snapshot_id).toBe(current.snapshot_id)
  expect(reader.state.objects.get(`objects/${digest(changed)}`)).toEqual(changed)
  reader.state.objects.set(`objects/${digest(changed)}`, new Uint8Array(changed.length))
  f.clearCalls()
  await expect(reader.run(openFixedSnapshotFiles(complete, () => [b.path]))).rejects.toMatchObject({
    code: "STATE_CORRUPT",
  })
  expect(f.calls).toHaveLength(0)
})
