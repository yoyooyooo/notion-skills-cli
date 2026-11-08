import { describe, expect, test } from "bun:test"
import { property, text } from "../src/model.ts"
import {
  executeSharedResourceAuthoring,
  loadSharedResourceAuthoringPlan,
  prepareSharedResourceAuthoring,
  reconcileSharedResourceAuthoring,
} from "../src/shared-resource-authoring.ts"
import { inspectSharedResourceState } from "../src/shared-resource-state.ts"
import { restoreSharedSnapshotHistory } from "../src/shared-snapshot-history.ts"
import { digest, encode, library, rich, skillPage } from "./shared-snapshot-fixture.ts"
import { resourceAuthoringFixture } from "./shared-resource-authoring-fixture.ts"

async function fresh() {
  const f = await resourceAuthoringFixture()
  await f.open(false)
  const snapshot = await f.open()
  f.clearCalls()
  return { f, snapshot }
}
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 0])

describe("raw resource authorship", () => {
  test("add and replace preserve exact bytes, stable File ID, mode and previous independent pin", async () => {
    const { f, snapshot } = await fresh()
    const first = await f.run(
      prepareSharedResourceAuthoring({
        library,
        snapshot,
        action: "add",
        path: "assets/icon.png",
        bytes: png,
        mode: "100644",
      }),
    )
    expect(f.writes()).toHaveLength(0)
    expect(first.content.sha256).toBe(digest(png))
    const added = await f.run(
      executeSharedResourceAuthoring(library, { plan: first, mode: "create" }),
    )
    expect(added.status).toBe("applied")
    const binding = f.files.find(
      (row) => text(property(property(row.properties).file_id).rich_text) === first.file_id,
    )!
    expect(binding).toBeDefined()
    expect(text(property(property(binding.properties).path).rich_text)).toBe("assets/icon.png")
    f.base.bodies.set(String(binding.id), "User notes that must never become resource content")
    binding.last_edited_time = new Date().toISOString()
    const reader = f.cold()
    const read = await reader.open()
    const resource = read.files.find((file) => file.path === "assets/icon.png")!
    expect(resource.sha256).toBe(digest(png))
    expect(reader.state.objects.get(`objects/${resource.sha256}`)).toEqual(png)
    expect(f.calls.some((call) => call.path.includes(`${binding.id}/markdown`))).toBe(false)
    const changed = encode("#!/bin/sh\r\nexit 81\r\n\0")
    const replacement = await f.run(
      prepareSharedResourceAuthoring({
        library,
        snapshot: await f.open(),
        action: "replace",
        path: "assets/icon.png",
        bytes: changed,
        mode: "100755",
      }),
    )
    expect(replacement.file_id).toBe(first.file_id)
    const replaced = await f.run(
      executeSharedResourceAuthoring(library, { plan: replacement, mode: "create" }),
    )
    expect(replaced.status).toBe("applied")
    expect(f.children.get(String(binding.id))).toHaveLength(2)
    expect(f.base.bodies.get(String(binding.id))).toBe(
      "User notes that must never become resource content",
    )
    const secondReader = f.cold()
    const current = await secondReader.open()
    const currentResource = current.files.find((file) => file.path === "assets/icon.png")!
    expect(currentResource.sha256).toBe(digest(changed))
    expect(currentResource.mode).toBe("100755")
    expect(secondReader.state.objects.get(`objects/${currentResource.sha256}`)).toEqual(changed)
    const restored = await secondReader.run(
      restoreSharedSnapshotHistory(library, {
        skillPageId: skillPage,
        pinId: replacement.prior_pin,
      }),
    )
    expect(restored.files.find((file) => file.path === "assets/icon.png")).toEqual({
      path: "assets/icon.png",
      bytes: png,
      mode: "100644",
    })
    f.clearCalls()
    const original = await secondReader.run(
      loadSharedResourceAuthoringPlan(library, {
        skillPageId: skillPage,
        operationId: replacement.operation_id,
      }),
    )
    expect(
      (await secondReader.run(reconcileSharedResourceAuthoring(library, original))).status,
    ).toBe("applied")
    expect(f.writes()).toHaveLength(0)
    f.clearCalls()
    const state = await secondReader.run(
      inspectSharedResourceState(library, { target: skillPage, observe: true }),
    )
    expect(
      state.files.find((file) => file.file_id === first.file_id)?.display.observation.kind,
    ).toBe("resource_verified")
    expect(f.writes()).toHaveLength(0)
    expect(f.calls.some((call) => call.path.includes(`${binding.id}/markdown`))).toBe(false)
  })

  for (const accepted of [false, true])
    test(`unknown page creation accepted=${accepted} retains one original and never creates again`, async () => {
      const { f, snapshot } = await fresh()
      const plan = await f.run(
        prepareSharedResourceAuthoring({
          library,
          snapshot,
          action: "add",
          path: "raw.bin",
          bytes: png,
          mode: "100644",
        }),
      )
      f.unknown("create", accepted)
      await expect(
        f.run(executeSharedResourceAuthoring(library, { plan, mode: "create" })),
      ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
      f.clearCalls()
      await expect(
        f.run(executeSharedResourceAuthoring(library, { plan, mode: "create" })),
      ).rejects.toMatchObject({ code: "SHARED_RESOURCE_AUTHORING_UNRESOLVED" })
      expect(f.writes()).toHaveLength(0)
      const reader = f.cold()
      await expect(reader.open()).rejects.toMatchObject({
        code: "SHARED_RESOURCE_AUTHORING_UNRESOLVED",
      })
      expect(f.writes()).toHaveLength(0)
    })

  test("unknown version append preserves the previous owner and never appends twice", async () => {
    const { f, snapshot } = await fresh()
    const add = await f.run(
      prepareSharedResourceAuthoring({
        library,
        snapshot,
        action: "add",
        path: "raw.bin",
        bytes: png,
        mode: "100644",
      }),
    )
    await f.run(executeSharedResourceAuthoring(library, { plan: add, mode: "create" }))
    const replace = await f.run(
      prepareSharedResourceAuthoring({
        library,
        snapshot: await f.open(),
        action: "replace",
        path: "raw.bin",
        bytes: encode("new\0bytes"),
        mode: "100644",
      }),
    )
    f.unknown("append", true)
    await expect(
      f.run(executeSharedResourceAuthoring(library, { plan: replace, mode: "create" })),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    f.clearCalls()
    await expect(f.run(reconcileSharedResourceAuthoring(library, replace))).rejects.toMatchObject({
      code: "SHARED_RESOURCE_AUTHORING_UNRESOLVED",
    })
    expect(f.writes()).toHaveLength(0)
    expect(f.children.get(replace.page_id!)).toHaveLength(2)
  })

  test("lost committed outcome reconciles its original result without new writes", async () => {
    const { f, snapshot } = await fresh()
    const plan = await f.run(
      prepareSharedResourceAuthoring({
        library,
        snapshot,
        action: "add",
        path: "config.json",
        bytes: encode('{"x":1}\r\n'),
        mode: "100644",
      }),
    )
    f.unknown("outcome", true)
    await expect(
      f.run(executeSharedResourceAuthoring(library, { plan, mode: "create" })),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    f.clearCalls()
    expect(
      (await f.run(executeSharedResourceAuthoring(library, { plan, mode: "create" }))).status,
    ).toBe("applied")
    expect(f.writes()).toHaveLength(0)
    expect((await f.cold().open()).files.find((file) => file.path === plan.path)?.sha256).toBe(
      plan.content.sha256,
    )
  })

  test("source-only binary replacement retains the original fixed bytes and creates one binding", async () => {
    const { f } = await fresh()
    f.fixed({
      source_id: "fixture-source",
      revision: "commit-C1",
      files: [
        { path: "SKILL.md", bytes: encode("# Source") },
        { path: "assets/source.bin", bytes: png, mode: "100755" },
      ],
    })
    const snapshot = await f.open()
    const plan = await f.run(
      prepareSharedResourceAuthoring({
        library,
        snapshot,
        action: "replace",
        path: "assets/source.bin",
        bytes: new Uint8Array([1, 0, 255]),
        mode: "100644",
      }),
    )
    expect(plan.page_id).toBeNull()
    expect(plan.before?.sha256).toBe(digest(png))
    expect(plan.before?.mode).toBe("100755")
    await f.run(executeSharedResourceAuthoring(library, { plan, mode: "create" }))
    const reader = f.cold()
    expect((await reader.open()).files.find((file) => file.path === plan.path)?.sha256).toBe(
      plan.content.sha256,
    )
    const restored = await reader.run(
      restoreSharedSnapshotHistory(library, { skillPageId: skillPage, pinId: plan.prior_pin }),
    )
    expect(restored.files.find((file) => file.path === plan.path)).toEqual({
      path: plan.path,
      bytes: png,
      mode: "100755",
    })
  })

  test("a changed binding after creation remains review-required without publishing ownership", async () => {
    const { f, snapshot } = await fresh()
    const plan = await f.run(
      prepareSharedResourceAuthoring({
        library,
        snapshot,
        action: "add",
        path: "raw.bin",
        bytes: png,
        mode: "100644",
      }),
    )
    f.onCreate((row) => {
      property(row.properties).path = rich("path", "moved-by-another-editor.bin")
    })
    await expect(
      f.run(executeSharedResourceAuthoring(library, { plan, mode: "create" })),
    ).rejects.toMatchObject({ code: "SHARED_RESOURCE_AUTHORING_REVIEW_REQUIRED" })
    f.clearCalls()
    await expect(f.run(reconcileSharedResourceAuthoring(library, plan))).rejects.toMatchObject({
      code: "SHARED_RESOURCE_AUTHORING_REVIEW_REQUIRED",
    })
    expect(f.writes()).toHaveLength(0)
  })
})
