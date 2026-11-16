import { expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import {
  executeSharedCreate,
  prepareSharedCreate,
  verifySharedCreateRecoveryScope,
} from "../src/shared-create.ts"
import { makeSharedCreatePlan, type SharedCreatePlan } from "../src/shared-create-model.ts"
import { createRelationsLibrary, sharedCreateFixture } from "./shared-create-fixture.ts"
import { encode, id } from "./shared-snapshot-fixture.ts"

const portable = {
  kind: "skill" as const,
  name: "Bounded original suffix",
  description: "Complete native creation among unrelated Skills",
  main: "SKILL.md",
  files: [
    {
      path: "SKILL.md",
      bytes: encode("# Main\n\n[Guide](references/one.md)\n"),
      mode: "100644" as const,
    },
    ...["one", "two", "three", "four"].map((name) => ({
      path: `references/${name}.md`,
      bytes: encode(`# ${name}\n\nKeep the complete original instructions.\n`),
      mode: "100644" as const,
    })),
  ],
}
type Fixture = ReturnType<typeof sharedCreateFixture>
type Observation = {
  readonly allocated: boolean
  readonly filtered: boolean
  readonly rows: number
  readonly response_bytes: number
}
function isInventory(path: string, f: Fixture) {
  const url = new URL(path, "https://api.notion.com/")
  return (
    url.pathname === `/v1/data_sources/${f.library.skills.data_source_id}/query` &&
    url.searchParams.has("filter_properties")
  )
}
function hasOriginal(f: Fixture, plan: SharedCreatePlan) {
  return [...f.skills.values()].some(
    (row) => text(property(property(row.properties).skill_id).rich_text) === plan.skill_id,
  )
}
function measured(f: Fixture, plan: SharedCreatePlan) {
  const observations: Observation[] = []
  const run = f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* executeSharedCreate(f.library, { plan, mode: "create" }).pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) =>
            Effect.suspend(() => {
              const allocated = hasOriginal(f, plan)
              return api.request(path, body, options).pipe(
                Effect.tap((raw) =>
                  Effect.sync(() => {
                    if (!isInventory(path, f)) return
                    const rows = property(raw).results
                    if (!Array.isArray(rows)) throw new Error("Expected complete inventory list")
                    observations.push({
                      allocated,
                      filtered: property(body).filter !== undefined,
                      rows: rows.length,
                      response_bytes: encode(JSON.stringify(raw)).length,
                    })
                  }),
                ),
              )
            }),
        }),
      )
    }),
  )
  return { run, observations }
}

test("allocated suffix traffic stays bounded by selected identities after full name admission", async () => {
  const f = sharedCreateFixture(),
    unrelated = 260
  for (let index = 0; index < unrelated; index++)
    f.seedSkill(id(1000 + index), `unrelated-${index}`, `Unrelated ${index}`)
  const plan = await f.run(prepareSharedCreate(f.library, { portable, completeResources: true }))
  f.clear()
  const observed = measured(f, plan),
    result = await observed.run
  const censusPages = Math.ceil((unrelated + 2) / 100)
  const before = observed.observations.filter((row) => !row.allocated)
  const after = observed.observations.filter((row) => row.allocated)
  const firstCensusBytes = before
    .slice(0, censusPages)
    .reduce((sum, row) => sum + row.response_bytes, 0)
  const summary = {
    controlled_notion: true,
    unrelated_skills: unrelated,
    native_creates: f.nativeCreates().length,
    initial_full_queries: before.filter((row) => !row.filtered).length,
    allocated_full_queries: after.filter((row) => !row.filtered).length,
    allocated_exact_queries: after.filter((row) => row.filtered).length,
    allocated_response_bytes: after.reduce((sum, row) => sum + row.response_bytes, 0),
    first_census_response_bytes: firstCensusBytes,
    observations: observed.observations,
  }
  const evidence = process.env.NTN_CREATE_SCOPE_EVIDENCE
  if (evidence) {
    mkdirSync(evidence, { recursive: true })
    writeFileSync(join(evidence, "scope-cost.json"), JSON.stringify(summary, null, 2) + "\n")
  }
  expect(result.verified).toBe(true)
  expect(f.nativeCreates()).toHaveLength(portable.files.length)
  // Initial admission and final complete census remain full and fully paginated.
  // Per-file stages inspect only the frozen allocation and relation identities.
  expect(summary.initial_full_queries).toBe(censusPages * 2)
  expect(summary.allocated_full_queries).toBe(censusPages)
  expect(summary.allocated_exact_queries).toBeGreaterThan(portable.files.length)
  expect(summary.allocated_response_bytes).toBeLessThan(firstCensusBytes * 1.25)
}, 20_000)

test.each(["duplicate-second-page", "unrelated-row", "incomplete-page"] as const)(
  "allocated identity query refuses %s before the next native allocation",
  async (kind) => {
    const f = sharedCreateFixture()
    const plan = await f.run(prepareSharedCreate(f.library, { portable, completeResources: true }))
    let injected = false
    const result = await f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* executeSharedCreate(f.library, { plan, mode: "create" }).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) =>
              Effect.suspend(() => {
                if (
                  isInventory(path, f) &&
                  property(body).filter !== undefined &&
                  hasOriginal(f, plan)
                ) {
                  injected = true
                  const original = [...f.skills.values()].find(
                    (row) =>
                      text(property(property(row.properties).skill_id).rich_text) === plan.skill_id,
                  )
                  if (!original) throw new Error("Expected the acknowledged original page")
                  if (kind === "unrelated-row")
                    return Effect.succeed({
                      object: "list",
                      results: [f.base.main],
                      has_more: false,
                      next_cursor: null,
                    })
                  if (kind === "incomplete-page")
                    return Effect.succeed({
                      object: "list",
                      results: [original],
                      has_more: true,
                      next_cursor: null,
                    })
                  return Effect.succeed(
                    property(body).start_cursor === undefined
                      ? {
                          object: "list",
                          results: [original],
                          has_more: true,
                          next_cursor: "scope-next",
                        }
                      : {
                          object: "list",
                          results: [{ ...original, id: id(99998) }],
                          has_more: false,
                          next_cursor: null,
                        },
                  )
                }
                return api.request(path, body, options)
              }),
          }),
          Effect.result,
        )
      }),
    )
    expect(injected).toBe(true)
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure")
      expect(result.failure.code).toBe(
        {
          "duplicate-second-page": "SHARED_SKILL_ID_CONFLICT",
          "unrelated-row": "SHARED_CREATE_SCOPE",
          "incomplete-page": "SHARED_CREATE_INCOMPLETE",
        }[kind],
      )
    expect(f.nativeCreates()).toHaveLength(1)
  },
)

test.each(["member-identity", "required-disabled"] as const)(
  "frozen relation %s drift still stops an allocated suffix",
  async (kind) => {
    const f = sharedCreateFixture({ relations: true }),
      member = id(8881),
      required = id(8882)
    f.seedSkill(member, "frozen-member", "Frozen member")
    f.seedSkill(required, "frozen-required", "Frozen requirement")
    const plan = await f.run(
      prepareSharedCreate(createRelationsLibrary, {
        portable,
        completeResources: true,
        members: [member],
        requires: [required],
      }),
    )
    let edited = false
    f.onCreate((_row, category) => {
      if (category !== "file" || edited) return
      edited = true
      if (kind === "member-identity") f.seedSkill(member, "replacement-member", "Frozen member")
      else f.seedSkill(required, "frozen-required", "Frozen requirement", "skill", false)
    })
    const result = await f.run(
      executeSharedCreate(createRelationsLibrary, { plan, mode: "create" }).pipe(Effect.result),
    )
    expect(edited).toBe(true)
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure")
      expect(result.failure.code).toBe(
        kind === "member-identity"
          ? "SHARED_CREATE_RELATION_SCOPE"
          : "SHARED_ROUTER_MEMBER_UNAVAILABLE",
      )
    expect(f.nativeCreates()).toHaveLength(2)
  },
)

test("an older plan without frozen relation identities retains the complete census", async () => {
  const f = sharedCreateFixture(),
    member = id(8883)
  f.seedSkill(member, "older-member", "Older member")
  const plan = await f.run(makeSharedCreatePlan(f.library, { portable, members: [member] }))
  expect(plan.relation_bindings).toBeUndefined()
  const created = await f.run(executeSharedCreate(f.library, { plan, mode: "create" }))
  expect(created.verified).toBe(true)
  f.clear()
  await f.run(verifySharedCreateRecoveryScope(f.library, plan, created.skill_page_id, "allocated"))
  const reads = f.calls.filter((call) => isInventory(call.path, f))
  expect(reads).toHaveLength(1)
  expect(reads.every((call) => property(call.body).filter === undefined)).toBe(true)
})
