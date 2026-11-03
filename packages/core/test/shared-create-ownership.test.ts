import { expect, test } from "bun:test"
import { Effect } from "effect"
import { authScope } from "../src/catalog.ts"
import { property } from "../src/model.ts"
import type { PortableSkill } from "../src/portable.ts"
import { executeSharedCreate, prepareSharedCreate } from "../src/shared-create.ts"
import {
  loadSharedCreateOwnership,
  saveSharedCreateOwnership,
  sharedCreateOwnershipKey,
} from "../src/shared-create-ownership.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { createLibrary, sharedCreateFixture } from "./shared-create-fixture.ts"
import { encode, id } from "./shared-snapshot-fixture.ts"

const portable: PortableSkill = {
  kind: "skill",
  name: "Owned create receipt",
  description: "Original acknowledgement evidence",
  main: "SKILL.md",
  files: [
    { path: "SKILL.md", bytes: encode("# Owned\n\n[Reference](references/a.md)\n") },
    { path: "references/a.md", bytes: encode("# Reference\n") },
  ],
}

test("successful native creation keeps exact scoped ownership after retiring its dispatch", async () => {
  const fixture = sharedCreateFixture()
  const plan = await fixture.run(prepareSharedCreate(createLibrary, { portable }))
  const result = await fixture.run(executeSharedCreate(createLibrary, { plan, mode: "create" }))
  const scope = await fixture.run(authScope)
  const receipt = await fixture.run(loadSharedCreateOwnership(scope, plan.operation_id))
  expect(receipt).toMatchObject({
    scope,
    operation_id: plan.operation_id,
    library_id: createLibrary.library_id,
    skill_id: plan.skill_id,
    skill_page_id: result.skill_page_id,
    coverage: "created_native_content_pages",
  })
  expect(receipt?.created_page_ids.slice().sort()).toEqual(
    result.expected_files.map((file) => file.page_id).sort(),
  )
  expect(receipt?.created_pages.map((page) => page.kind).sort()).toEqual(["file", "skill"])
  expect(receipt?.created_page_ids.some((page) => fixture.base.records.has(page))).toBe(false)
  expect(fixture.pending()).toHaveLength(0)
  expect(
    await fixture.run(loadSharedCreateOwnership("a".repeat(64), plan.operation_id)),
  ).toBeUndefined()
  const retained = canonicalSharedJson(receipt)
  const mismatch = await fixture.run(
    saveSharedCreateOwnership(
      scope,
      plan,
      result.expected_files.map((file, index) => ({
        file_id: file.file_id,
        path: file.path,
        page_id: id(800_000 + index),
        event_id: plan.files.find((item) => item.file_id === file.file_id)!.event.event_id,
      })),
    ).pipe(Effect.result),
  )
  expect(mismatch._tag === "Failure" && mismatch.failure.code).toBe("STATE_CONFLICT")
  expect(
    canonicalSharedJson(await fixture.run(loadSharedCreateOwnership(scope, plan.operation_id))),
  ).toBe(retained)
})

test("an unknown write has no ownership until the exact applied original outcome reconciles", async () => {
  for (const stage of ["skill", "outcome"] as const) {
    const fixture = sharedCreateFixture()
    const plan = await fixture.run(prepareSharedCreate(createLibrary, { portable }))
    const scope = await fixture.run(authScope)
    fixture.unknown(stage, true)
    const first = await fixture.run(
      executeSharedCreate(createLibrary, { plan, mode: "create" }).pipe(Effect.result),
    )
    expect(first._tag === "Failure" && first.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(await fixture.run(loadSharedCreateOwnership(scope, plan.operation_id))).toBeUndefined()
    const creates = fixture.nativeCreates().length
    const second = await fixture.run(
      executeSharedCreate(createLibrary, { plan, mode: "create" }).pipe(Effect.result),
    )
    expect(fixture.nativeCreates()).toHaveLength(creates)
    const owned = await fixture.run(loadSharedCreateOwnership(scope, plan.operation_id))
    if (stage === "outcome") {
      expect(second._tag).toBe("Success")
      expect(owned?.created_page_ids).toHaveLength(2)
    } else {
      expect(second._tag).toBe("Failure")
      expect(owned).toBeUndefined()
    }
  }
})

test("historical unmarked dispatches and remote outcomes never manufacture local ownership", async () => {
  const fixture = sharedCreateFixture()
  const plan = await fixture.run(prepareSharedCreate(createLibrary, { portable }))
  const scope = await fixture.run(authScope)
  fixture.unknown("outcome", true)
  await fixture.run(
    executeSharedCreate(createLibrary, { plan, mode: "create" }).pipe(Effect.result),
  )
  const key = fixture.pending()[0]!
  const { ownership_receipt_version: _marker, ...historical } = property(fixture.base.json.get(key))
  fixture.base.json.set(key, historical)
  const result = await fixture.run(executeSharedCreate(createLibrary, { plan, mode: "create" }))
  expect(result.reused).toBe(true)
  expect(await fixture.run(loadSharedCreateOwnership(scope, plan.operation_id))).toBeUndefined()
  await fixture.run(executeSharedCreate(createLibrary, { plan, mode: "reconcile" }))
  expect(await fixture.run(loadSharedCreateOwnership(scope, plan.operation_id))).toBeUndefined()
})

test("an ownership receipt cannot substitute a foreign scope or extra target page", async () => {
  const fixture = sharedCreateFixture()
  const plan = await fixture.run(prepareSharedCreate(createLibrary, { portable }))
  await fixture.run(executeSharedCreate(createLibrary, { plan, mode: "create" }))
  const scope = await fixture.run(authScope)
  const key = await fixture.run(sharedCreateOwnershipKey(scope, plan.operation_id))
  const original = await fixture.run(loadSharedCreateOwnership(scope, plan.operation_id))
  if (original === undefined) throw new Error("Missing completed ownership fixture")
  fixture.base.json.set(key, {
    ...original,
    created_page_ids: [...original.created_page_ids, id(999_999)],
  })
  const changed = await fixture.run(
    loadSharedCreateOwnership(scope, plan.operation_id).pipe(Effect.result),
  )
  expect(changed._tag === "Failure" && changed.failure.code).toBe("OWNERSHIP_RECEIPT_INVALID")
  fixture.base.json.set(key, { ...original, scope: "b".repeat(64) })
  const foreign = await fixture.run(
    loadSharedCreateOwnership(scope, plan.operation_id).pipe(Effect.result),
  )
  expect(foreign._tag === "Failure" && foreign.failure.code).toBe("OWNERSHIP_RECEIPT_INVALID")
})
