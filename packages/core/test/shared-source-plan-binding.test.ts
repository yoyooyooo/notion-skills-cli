import { expect, test } from "bun:test"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import type { SharedLibrary } from "../src/shared-library-model.ts"
import {
  makeSourcePlanBinding,
  registerSourcePlanBinding,
  resolveSourcePlanBinding,
} from "../src/shared-source-plan-binding.ts"
import type { SharedSourcePlan } from "../src/shared-source-plan.ts"
import { sourceRegistryFixture } from "./shared-source-registration-fixture.ts"

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const skill = id(1)
const library: SharedLibrary = {
  version: 1,
  library_id: "library-source",
  operation_id: "library-source",
  parent_page_id: id(4),
  skills: { database_id: id(5), data_source_id: id(6), property_ids: {} },
  files: { database_id: id(7), data_source_id: id(8), property_ids: {} },
  records: {
    database_id: id(3),
    data_source_id: id(2),
    property_ids: {
      Name: "title",
      "Record ID": "record",
      Kind: "kind",
      "Entity ID": "entity",
      Hash: "hash",
      Payload: "payload",
      Skill: "skill",
    },
  },
}
const plan: SharedSourcePlan = { version: 1, kind: "composition", base: null, mounts: [] }

test("registers and resolves a fixed composition as one exact immutable metadata fact", async () => {
  const f = sourceRegistryFixture(library)
  const saved = await f.run(
    registerSourcePlanBinding(library, { skillPageId: skill, mode: "create", plan }),
  )
  expect(saved.binding.source_plan_id).toMatch(/^source-plan-[a-f0-9]{64}$/)
  expect(saved.record).toMatchObject({
    record_id: saved.binding.source_plan_id,
    entity_id: saved.binding.source_plan_id,
    operation_id: `register-${saved.binding.source_plan_id}`,
    payload: plan,
  })
  expect(f.calls).toHaveLength(2)
  expect(f.local.records.size).toBe(1)
  expect(property(f.calls[1]?.body)).not.toHaveProperty("markdown")
  expect(
    await f.run(
      resolveSourcePlanBinding(library, {
        skillPageId: skill,
        sourcePlanId: saved.binding.source_plan_id,
      }),
    ),
  ).toEqual(saved.binding)
  expect(
    (await f.run(registerSourcePlanBinding(library, { skillPageId: skill, mode: "create", plan })))
      .binding,
  ).toEqual(saved.binding)
  expect(f.calls.filter((call) => call.path === "v1/pages")).toHaveLength(1)
})

test.each(["retained", "absent"] as const)(
  "ordinary retry after unknown %s creation only reconciles the frozen dispatch",
  async (unknownCreate) => {
    const f = sourceRegistryFixture(library, { unknownCreate })
    const first = await f.run(
      Effect.flip(registerSourcePlanBinding(library, { skillPageId: skill, mode: "create", plan })),
    )
    expect(first.code).toBe("WRITE_OUTCOME_UNKNOWN")
    const repeated = await f.run(
      registerSourcePlanBinding(library, { skillPageId: skill, mode: "create", plan }).pipe(
        Effect.result,
      ),
    )
    expect(repeated._tag).toBe(unknownCreate === "retained" ? "Success" : "Failure")
    if (repeated._tag === "Failure") expect(repeated.failure.code).toBe("SHARED_RECORD_UNRESOLVED")
    expect(f.calls.filter((call) => call.path === "v1/pages")).toHaveLength(1)
    expect(f.local.records.size).toBe(1)
  },
)

test("reconcile without an observed fact never creates a dispatch or POST", async () => {
  const f = sourceRegistryFixture(library)
  expect(
    (
      await f.run(
        Effect.flip(
          registerSourcePlanBinding(library, { skillPageId: skill, mode: "reconcile", plan }),
        ),
      )
    ).code,
  ).toBe("SHARED_RECORD_UNRESOLVED")
  expect(f.local.records.size).toBe(0)
  expect(f.calls).toHaveLength(1)
})

test("a denied pre-create query does not consume the local dispatch", async () => {
  const f = sourceRegistryFixture(library, { failQuery: true })
  expect(
    (
      await f.run(
        Effect.flip(
          registerSourcePlanBinding(library, { skillPageId: skill, mode: "create", plan }),
        ),
      )
    ).code,
  ).toBe("ACCESS_DENIED")
  expect(f.local.records.size).toBe(0)
  expect(f.calls.filter((call) => call.path === "v1/pages")).toHaveLength(0)
})

test("concurrent first registrations in one Store cannot dispatch twice after an unknown create", async () => {
  const f = sourceRegistryFixture(library, { unknownCreate: "absent" })
  await f.run(
    Effect.forEach(
      [0, 1],
      () =>
        registerSourcePlanBinding(library, { skillPageId: skill, mode: "create", plan }).pipe(
          Effect.result,
        ),
      { concurrency: 2 },
    ),
  )
  expect(f.calls.filter((call) => call.path === "v1/pages")).toHaveLength(1)
  expect(f.local.records.size).toBe(1)
})

test("missing selected plans fail without a source alias or current-version fallback", async () => {
  const f = sourceRegistryFixture(library)
  const binding = await f.run(makeSourcePlanBinding(plan))
  expect(
    (
      await f.run(
        Effect.flip(
          resolveSourcePlanBinding(library, {
            skillPageId: skill,
            sourcePlanId: binding.source_plan_id,
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_SOURCE_MISSING")
  const before = f.calls.length
  await expect(
    f.run(resolveSourcePlanBinding(library, { skillPageId: skill, sourcePlanId: "latest" })),
  ).rejects.toThrow()
  expect(f.calls).toHaveLength(before)
})

test("a conflicting or corrupted local receipt cannot authorize a fresh create", async () => {
  const f = sourceRegistryFixture(library, { unknownCreate: "absent" })
  await f.run(
    registerSourcePlanBinding(library, { skillPageId: skill, mode: "create", plan }).pipe(
      Effect.result,
    ),
  )
  const [entry] = [...f.local.records]
  if (!entry) throw new Error("Expected a frozen dispatch")
  f.local.records.set(entry[0], { ...property(entry[1]), skill_page_id: id(99) })
  expect(
    (
      await f.run(
        Effect.flip(
          registerSourcePlanBinding(library, { skillPageId: skill, mode: "create", plan }),
        ),
      )
    ).code,
  ).toBe("SOURCE_REGISTRATION_CONFLICT")
  expect(f.calls.filter((call) => call.path === "v1/pages")).toHaveLength(1)
})
