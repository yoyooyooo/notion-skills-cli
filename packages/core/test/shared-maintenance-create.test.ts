import { expect, test } from "bun:test"
import { Effect } from "effect"
import { createLibrary, sharedCreateFixture } from "./shared-create-fixture.ts"
import { prepareSharedCreate, executeSharedCreate } from "../src/shared-create.ts"
import {
  showSharedCreationOperation,
  reconcileSharedCreationOperation,
} from "../src/shared-maintenance-create.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { skillPage } from "./shared-snapshot-fixture.ts"

const input = {
  kind: "skill" as const,
  name: "Unified native operation",
  description: "Original creation observation fixture",
  main: "SKILL.md",
  files: [
    {
      path: "SKILL.md",
      bytes: new TextEncoder().encode("# Original source\n\nComplete source fixture.\n"),
    },
  ],
}

test("the original creation ID can be inspected and reconciled after local completion without another native write", async () => {
  const f = sharedCreateFixture()
  const plan = await f.run(prepareSharedCreate(createLibrary, { portable: input }))
  const result = await f.run(executeSharedCreate(createLibrary, { plan, mode: "create" }))
  const before = canonicalSharedJson({
    skills: [...f.skills],
    files: [...f.files],
    bodies: [...f.base.bodies],
    records: [...f.base.records],
  })
  f.clear()
  const shown = await f.run(showSharedCreationOperation({ operationId: plan.operation_id }))
  expect(shown).toMatchObject({
    family: "native_create",
    verified: false,
    operation_id: plan.operation_id,
    target: { page_id: result.skill_page_id },
    coverage: { terminal_outcome: "not_checked" },
  })
  expect(JSON.stringify(shown)).not.toContain("Complete source fixture")
  const observed = await f.run(reconcileSharedCreationOperation({ operationId: plan.operation_id }))
  expect(observed).toMatchObject({
    verified: true,
    operation_id: plan.operation_id,
    target: { page_id: result.skill_page_id },
    remote_writes: 0,
  })
  expect(f.writes()).toHaveLength(0)
  expect(
    canonicalSharedJson({
      skills: [...f.skills],
      files: [...f.files],
      bodies: [...f.base.bodies],
      records: [...f.base.records],
    }),
  ).toBe(before)
})

test("a lost first-page response stays an original unknown intent whether the page became visible or not", async () => {
  for (const visible of [false, true]) {
    const f = sharedCreateFixture(),
      plan = await f.run(prepareSharedCreate(createLibrary, { portable: input }))
    f.unknown("skill", visible)
    const failed = await f.run(
      executeSharedCreate(createLibrary, { plan, mode: "create" }).pipe(Effect.result),
    )
    expect(failed).toMatchObject({ _tag: "Failure", failure: { code: "WRITE_OUTCOME_UNKNOWN" } })
    f.clear()
    const shown = await f.run(showSharedCreationOperation({ operationId: plan.operation_id }))
    expect(shown).toMatchObject({
      verified: false,
      target: { page_id: null },
      coverage: { original_intent: "original_native_dispatch_journal" },
    })
    const result = await f.run(
      reconcileSharedCreationOperation({ operationId: plan.operation_id }).pipe(Effect.result),
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { code: visible ? "SHARED_RECORD_UNRESOLVED" : "SHARED_CREATE_UNRESOLVED" },
    })
    expect(f.writes()).toHaveLength(0)
    expect(f.pending()).toHaveLength(1)
    const wrong = await f.run(
      showSharedCreationOperation({
        operationId: plan.operation_id,
        target: skillPage,
        entry: createLibrary.skills.database_id,
      }).pipe(Effect.result),
    )
    expect(wrong).toMatchObject({ _tag: "Failure", failure: { code: "OPERATION_SCOPE_MISMATCH" } })
    expect(f.writes()).toHaveLength(0)
  }
})
