import { expect, test } from "bun:test"
import { Effect } from "effect"
import { authScope } from "../src/catalog.ts"
import { property } from "../src/model.ts"
import {
  applySharedCreateRestoration,
  reconcileSharedCreateRestoration,
} from "../src/shared-create-restoration.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import { sharedCreateOutcomeId } from "../src/shared-create-outcome.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import { failedLinkedOriginal } from "./shared-create-link-restoration-fixture.ts"

test.each([14, 15] as const)(
  "v3 repairs the complete original cyclic owner with policy %s and preserves the failure",
  async (policy) => {
    const x = await failedLinkedOriginal(policy),
      { f } = x
    const dry = await f.run(applySharedCreateRestoration({ ...x.apply, dryRun: true }))
    expect(dry).toMatchObject({
      status: "planned",
      write_plan: { maximum_native_page_creates: 5, existing_body_patches: 3 },
    })
    expect(f.writes()).toHaveLength(0)
    const result = await f.run(applySharedCreateRestoration(x.apply))
    expect(result).toMatchObject({
      verified: true,
      operation_id: x.plan.operation_id,
      skill_page_id: x.page,
    })
    expect(f.nativeCreates()).toHaveLength(5)
    expect(
      f
        .writes()
        .filter((request) => request.method === "PATCH" && request.path.endsWith("/markdown")),
    ).toHaveLength(3)
    expect(f.enablePatches().filter((request) => !request.path.endsWith("/markdown"))).toHaveLength(
      1,
    )
    const original = await f.run(
      querySharedRecords(f.library, {
        skillPageId: x.page,
        kind: "operation",
        recordId: sharedCreateOutcomeId(x.plan.operation_id),
      }),
    )
    if (x.originalFailure === undefined) throw new Error("Expected the original known failure.")
    expect(canonicalSharedJson(original[0])).toBe(x.originalFailure)
    f.clear()
    expect(await f.run(applySharedCreateRestoration(x.apply))).toMatchObject({
      verified: true,
      reused: true,
    })
    expect(f.writes()).toHaveLength(0)
    f.base.json.clear()
    f.base.objects.clear()
    f.credential("independent-linked-reader")
    expect(await f.run(reconcileSharedCreateRestoration(x.selected))).toMatchObject({
      verified: true,
    })
    const snapshot = await f.run(
      Effect.gen(function* () {
        return yield* openSharedConsumer({
          library: f.library,
          target: x.page,
          scope: yield* authScope,
          startedAt: Date.now(),
          forceFull: true,
          readOnly: true,
        })
      }),
    )
    expect(snapshot.files.map((file) => file.path).sort()).toEqual(
      [...x.plan.files, ...(x.plan.resources ?? [])].map((file) => file.path).sort(),
    )
    expect(f.writes()).toHaveLength(0)
  },
)

test("UTF-8 same-owner fragment recovery keeps the original wire and survives cold consumption", async () => {
  const x = await failedLinkedOriginal(14, true)
  const originalPlan = canonicalSharedJson(x.plan)
  const result = await x.f.run(applySharedCreateRestoration(x.apply))
  expect(result).toMatchObject({
    verified: true,
    operation_id: x.plan.operation_id,
    skill_page_id: x.page,
  })
  const patches = x.f
    .writes()
    .filter((request) => request.method === "PATCH" && request.path.endsWith("/markdown"))
  expect(patches).toHaveLength(3)
  expect(
    patches.some((request) => {
      const updates = property(property(request.body).update_content).content_updates
      return (
        Array.isArray(updates) &&
        updates.some((update) => {
          const wire = property(update).new_str
          return typeof wire === "string" && wire.includes("#进程加载对账")
        })
      )
    }),
  ).toBe(true)
  expect(canonicalSharedJson(x.plan)).toBe(originalPlan)
  const failed = await x.f.run(
    querySharedRecords(x.f.library, {
      skillPageId: x.page,
      kind: "operation",
      recordId: sharedCreateOutcomeId(x.plan.operation_id),
    }),
  )
  expect(failed).toHaveLength(0)
  x.f.base.json.clear()
  x.f.base.objects.clear()
  x.f.credential("cold-unicode-fragment-reader")
  x.f.clear()
  expect(await x.f.run(reconcileSharedCreateRestoration(x.selected))).toMatchObject({
    verified: true,
  })
  const snapshot = await x.f.run(
    Effect.gen(function* () {
      return yield* openSharedConsumer({
        library: x.f.library,
        target: x.page,
        scope: yield* authScope,
        startedAt: Date.now(),
        forceFull: true,
        readOnly: true,
      })
    }),
  )
  expect(snapshot.files.map((file) => file.path).sort()).toEqual(
    [...x.plan.files, ...(x.plan.resources ?? [])].map((file) => file.path).sort(),
  )
  const main = snapshot.files.find((file) => file.path === "SKILL.md")!
  const markdown = new TextDecoder().decode(x.f.base.objects.get(`objects/${main.sha256}`))
  expect(markdown).toContain(`references/first.md#${encodeURIComponent("进程加载对账")}`)
  for (const resource of x.resources) {
    const file = snapshot.files.find((candidate) => candidate.path === resource.path)!
    expect(file.mode).toBe(resource.mode)
    expect(x.f.base.objects.get(`objects/${file.sha256}`)).toEqual(resource.bytes)
  }
  expect(x.f.writes()).toHaveLength(0)
})
