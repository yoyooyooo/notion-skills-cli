import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fail, property, text, type SkillsError } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { executeSharedCreate, prepareSharedCreate } from "../src/shared-create.ts"
import type { SharedCreatePlan } from "../src/shared-create-model.ts"
import { createLibrary, sharedCreateFixture } from "./shared-create-fixture.ts"
import { fixture, library, ids } from "./shared-source-projection-fixture.ts"
import { encode, id, rich } from "./shared-snapshot-fixture.ts"

const native = {
  kind: "skill" as const,
  name: "Drift check",
  description: "Controlled complete original create",
  main: "SKILL.md",
  files: [
    {
      path: "SKILL.md",
      bytes: encode(
        "---\nname: Drift check\ndescription: Controlled complete original create\n---\n\n# Original\n",
      ),
      mode: "100644" as const,
    },
  ],
}
function interruptOriginal(f: ReturnType<typeof fixture>, plan: SharedCreatePlan) {
  let failed = false
  return f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* executeSharedCreate(library, { plan, mode: "create" }).pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) =>
            Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
              if (
                !failed &&
                f.nativeCreates().length === 1 &&
                body === undefined &&
                /^v1\/pages\/[a-f0-9-]{36}$/u.test(path)
              ) {
                failed = true
                return Effect.fail(
                  fail(
                    "READ_INTERRUPTED",
                    "Controlled original allocation ACK readback interruption",
                  ),
                )
              }
              return api.request(path, body, options)
            }),
        }),
        Effect.result,
      )
    }),
  )
}

describe("fresh original create boundaries", () => {
  test("complete relation intent freezes logical Skill identity in addition to its page UUID", async () => {
    const f = sharedCreateFixture(),
      page = id(930)
    f.seedSkill(page, "original-related-skill", "Original target", "skill", true)
    const plan = await f.run(
      prepareSharedCreate(createLibrary, {
        portable: native,
        completeResources: true,
        members: [page],
      }),
    )
    expect(plan.relation_bindings).toEqual([{ page_id: page, skill_id: "original-related-skill" }])
    f.seedSkill(page, "replacement-related-skill", "Original target", "skill", true)
    await expect(
      f.run(executeSharedCreate(createLibrary, { plan, mode: "create" })),
    ).rejects.toMatchObject({ code: "SHARED_CREATE_RELATION_SCOPE" })
    expect(f.writes()).toHaveLength(0)
  })

  test.each(["definition", "disabled", "name", "body", "metadata"] as const)(
    "a known partial create rechecks %s drift before its first remaining write",
    async (kind) => {
      const f = fixture(),
        plan = await f.prepare(true)
      expect((await interruptOriginal(f, plan))._tag).toBe("Failure")
      const before = f.writes().length,
        page = [...f.skills].find(
          ([, row]) =>
            text(property(property(row.properties).skill_id).rich_text) === plan.skill_id,
        )?.[0]!
      expect(page).toBeDefined()
      if (kind === "definition")
        f.source.properties[ids.Description!] = rich(
          ids.Description!,
          "Changed source configuration",
        )
      if (kind === "disabled")
        f.source.properties[ids.Enabled!] = { id: ids.Enabled!, type: "checkbox", checkbox: false }
      if (kind === "name") f.seedSkill(id(931), "competing-skill", plan.name, "skill", true)
      if (kind === "body") f.base.bodies.set(page, "# Concurrent human edit\n")
      if (kind === "metadata")
        property(f.skills.get(page)!.properties).title = {
          id: "title",
          type: "title",
          title: [{ plain_text: "Concurrent rename" }],
        }
      await expect(f.run(executeSharedCreate(library, { plan, mode: "create" }))).rejects.toThrow()
      expect(f.writes()).toHaveLength(before)
      expect(f.nativeCreates()).toHaveLength(1)
      if (kind === "body") expect(f.base.bodies.get(page)).toBe("# Concurrent human edit\n")
    },
  )

  test("withdrawn Source read access blocks a resumed original before it appends facts", async () => {
    const f = fixture(),
      plan = await f.prepare(true)
    await interruptOriginal(f, plan)
    const before = f.writes().length
    const result = await f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* executeSharedCreate(library, { plan, mode: "create" }).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) =>
              path === `v1/pages/${f.source.id}`
                ? Effect.fail(
                    fail("NOTION_PERMISSION_DENIED", "Controlled Source permission withdrawal"),
                  )
                : api.request(path, body, options),
          }),
          Effect.result,
        )
      }),
    )
    expect(result._tag).toBe("Failure")
    expect(f.writes()).toHaveLength(before)
  })

  test("a human edit immediately after allocation is preserved before the next creation stage", async () => {
    const f = fixture(),
      plan = await f.prepare(true)
    let editedPage = ""
    f.onCreate((row, kind) => {
      if (kind !== "skill") return
      editedPage = String(row.id)
      f.base.bodies.set(editedPage, "# Human edit after allocation\n")
    })
    await expect(
      f.run(executeSharedCreate(library, { plan, mode: "create" })),
    ).rejects.toMatchObject({ code: "SHARED_CREATE_BODY_MISMATCH" })
    expect(f.nativeCreates()).toHaveLength(1)
    expect(f.writes()).toHaveLength(1)
    expect(f.base.bodies.get(editedPage)).toBe("# Human edit after allocation\n")
  })
})
