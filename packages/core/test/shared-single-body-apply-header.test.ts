import { expect, test } from "bun:test"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import { updateSkill } from "../src/command-operations.ts"
import { observeAcceptedSingleBodyApply } from "../src/shared-single-body-apply-acceptance.ts"
import {
  authoringRead,
  failure,
  library,
  pendingSingleBody,
  selected,
  skillPage,
} from "./shared-single-body-apply-acceptance-fixture.ts"
import { rich } from "./shared-snapshot-fixture.ts"

test("a body-only historical event can prove its canonical full input with the exact original authored hash", async () => {
  const { f, plan, child, accept } = await pendingSingleBody("event", 1, "canonical")
  expect(property(child.candidate.content).frontmatter).toBeUndefined()
  expect(child.candidate.content.mode).toBeUndefined()
  expect(child.authored_input_sha256).toMatch(/^[a-f0-9]{64}$/u)
  await f.run(accept())
  f.clearCalls()
  const current = await authoringRead(f)
  expect(current.record.name).toBe("Managed Name")
  expect(current.record.description).toBe("Managed description")
  expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
  expect(await f.run(observeAcceptedSingleBodyApply(library, plan))).toBeDefined()
  expect(
    property(await f.run(updateSkill(skillPage, { ...selected, enabled: true, dryRun: true })))
      .action,
  ).toBe("planned")
})

for (const field of ["name", "description"] as const)
  test(`canonical hash proof cannot replace the original ${field} with fresh different metadata`, async () => {
    const { f, plan, accept } = await pendingSingleBody("event", 1, "canonical")
    await f.run(accept())
    const props = property(f.main.properties)
    if (field === "name")
      props.title = { id: "title", type: "title", title: [{ plain_text: "Changed name" }] }
    else props.description = rich("description", "Changed description")
    f.clearCalls()
    expect(
      failure(await f.run(observeAcceptedSingleBodyApply(library, plan).pipe(Effect.result))).code,
    ).toBe("SHARED_CURRENT_ACCEPTANCE_STALE")
    expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
  })

test("matching native metadata cannot replace the exact bytes of an absent noncanonical original header", async () => {
  const { f, plan, accept } = await pendingSingleBody("event", 1, "noncanonical")
  await f.run(accept())
  f.clearCalls()
  expect(
    failure(await f.run(observeAcceptedSingleBodyApply(library, plan).pipe(Effect.result))).code,
  ).toBe("SHARED_CURRENT_ACCEPTANCE_STALE")
  expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
})
