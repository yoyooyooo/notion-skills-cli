import { describe, expect, test } from "bun:test"
import { Crypto, Effect, FileSystem, Path } from "effect"
import { HttpClient } from "effect/http"
import { fail, property, SkillsError, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { adoptSharedNative } from "../src/shared-native-adoption.ts"
import { readSkill } from "../src/snapshot.ts"
import { updateSkill } from "../src/command-operations.ts"
import { sharedSnapshotFixture, library, skillPage, rich } from "./shared-snapshot-fixture.ts"

function errorOf<A>(
  result:
    | { readonly _tag: "Success"; readonly success: A }
    | { readonly _tag: "Failure"; readonly failure: unknown },
) {
  if (result._tag !== "Failure" || !(result.failure instanceof SkillsError))
    throw new Error("Expected SkillsError")
  return result.failure
}

function fixture(fileCount = 1) {
  const base = sharedSnapshotFixture({ fileCount })
  const fields = property(base.main.properties)
  fields.skill_id = rich("skill_id", "")
  fields.main_file_id = rich("main_file_id", "")
  property(fields.enabled).checkbox = false
  let unknownPatch = false,
    unknownOutcome = false
  let afterOriginalPlan: (() => void) | undefined
  const run = <A, E>(
    action: Effect.Effect<
      A,
      E,
      Notion | Store | Crypto.Crypto | HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
    >,
  ) =>
    base.run(
      Effect.gen(function* () {
        const original = yield* Notion
        return yield* action.pipe(
          Effect.provideService(Notion, {
            ...original,
            request: (path, body, options) => {
              if (path === `v1/pages/${skillPage}` && options?.method === "PATCH")
                return Effect.suspend(() => {
                  base.calls.push({ path, method: "PATCH", body })
                  for (const [key, value] of Object.entries(property(property(body).properties)))
                    fields[key] = { ...property(fields[key]), ...property(value) }
                  base.main.last_edited_time = new Date().toISOString()
                  if (unknownPatch) {
                    unknownPatch = false
                    return Effect.fail(
                      fail("WRITE_OUTCOME_UNKNOWN", "Original identity PATCH response lost"),
                    )
                  }
                  return Effect.succeed(structuredClone(base.main))
                })
              const recordId = text(property(property(property(body).properties).record).rich_text)
              const result = original.request(path, body, options)
              if (path === "v1/pages" && recordId.startsWith("skill-adopt-"))
                return result.pipe(Effect.tap(() => Effect.sync(() => afterOriginalPlan?.())))
              if (
                path === "v1/pages" &&
                recordId.startsWith("outcome-skill-adopt-") &&
                unknownOutcome
              )
                return result.pipe(
                  Effect.flatMap(() => {
                    unknownOutcome = false
                    return Effect.fail(
                      fail("WRITE_OUTCOME_UNKNOWN", "Original completion response lost"),
                    )
                  }),
                )
              return result
            },
          }),
        )
      }),
    )
  const writes = () =>
    base.calls.filter((call) => call.path === "v1/pages" || call.method === "PATCH")
  return {
    ...base,
    fields,
    run,
    writes,
    losePatch: () => {
      unknownPatch = true
    },
    loseOutcome: () => {
      unknownOutcome = true
    },
    afterPlan: (action: () => void) => {
      afterOriginalPlan = action
    },
  }
}

describe("native draft adoption through its original page", () => {
  test("dry-run freezes complete native bytes and deterministic page identities without writes", async () => {
    const f = fixture(),
      before = structuredClone(f.main),
      body = f.bodies.get(skillPage)
    const result = await f.run(
      adoptSharedNative(skillPage, { database: library.skills.database_id, dryRun: true }),
    )
    if (!("plan" in result)) throw new Error("Expected adoption plan")
    expect(result.plan.skill_page_id).toBe(skillPage)
    expect(result.plan.skill_id).toMatch(/^skill-[a-f0-9]{64}$/u)
    expect(result.plan.file_id).toMatch(/^file-[a-f0-9]{64}$/u)
    expect(body).toBe(result.plan.observation.body.markdown)
    expect(result.plan.observation.event.parents).toEqual([])
    expect(f.main).toEqual(before)
    expect(f.writes()).toHaveLength(0)
    expect([...f.json.keys()].some((key) => key.startsWith("operations/"))).toBe(false)
  })

  test("adoption keeps the original page, complete body and disabled metadata with one identity PATCH", async () => {
    const f = fixture(),
      before = structuredClone(f.fields),
      body = f.bodies.get(skillPage)
    const result = await f.run(
      adoptSharedNative(skillPage, { database: library.skills.database_id }),
    )
    expect(result.status).toBe("adopted")
    expect(property(result).verified).toBe(true)
    expect(property(result).skill_page_id).toBe(skillPage)
    expect(f.bodies.get(skillPage)).toBe(body)
    expect(property(f.fields.enabled).checkbox).toBe(false)
    for (const [key, value] of Object.entries(before))
      if (key !== "skill_id" && key !== "main_file_id") expect(f.fields[key]).toEqual(value)
    const patches = f.writes().filter((call) => call.method === "PATCH")
    expect(patches).toHaveLength(1)
    expect(Object.keys(property(property(patches[0]?.body).properties)).sort()).toEqual([
      "main_file_id",
      "skill_id",
    ])
    expect(
      f
        .writes()
        .filter((call) => call.path === "v1/pages")
        .every(
          (call) =>
            property(property(call.body).parent).data_source_id === library.records.data_source_id,
        ),
    ).toBe(true)
    expect(f.records.size).toBe(5)
    expect(f.files).toHaveLength(0)
    expect([...f.json.keys()].some((key) => key.startsWith("operations/"))).toBe(false)
    const author = await f.run(
      readSkill(skillPage, { database: library.skills.database_id, authoring: true }),
    )
    expect(property(author).content).toContain("# Native main")
    expect(
      errorOf(
        await f.run(
          readSkill(skillPage, { database: library.skills.database_id }).pipe(Effect.result),
        ),
      ).code,
    ).toBe("CONTENT_DISABLED")
    f.clearCalls()
    const repeated = await f.run(
      adoptSharedNative(skillPage, { database: library.skills.database_id }),
    )
    expect(repeated.status).toBe("reconciled")
    expect(property(repeated).verification).toBe("original_adoption_outcome")
    expect(property(repeated).enabled).toBeUndefined()
    expect(f.writes()).toHaveLength(0)
    expect(f.readBodyCount()).toBe(0)
  })

  test.each(["Main File ID", "Source", "Projection", "References", "Files", "Records"])(
    "existing %s prevents initialization before body or writes",
    async (name) => {
      const f = fixture(name === "Files" ? 2 : 1)
      if (name === "Records") f.seedFact({ original: true }, "object", "old-body", "old-body")
      else if (name !== "Files") {
        const id = library.skills.property_ids[name]!
        f.fields[id] = rich(id, "existing-managed-value")
      }
      const error = errorOf(await f.run(adoptSharedNative(skillPage).pipe(Effect.result)))
      expect(["SHARED_ADOPTION_BOUND", "SHARED_ADOPTION_HISTORY"]).toContain(error.code)
      expect(f.readBodyCount()).toBe(0)
      expect(f.writes()).toHaveLength(0)
      expect(text(property(f.fields.skill_id).rich_text)).toBe("")
    },
  )

  test.each(["name", "description", "kind"])(
    "incomplete %s rejects before Files or body reads",
    async (field) => {
      const f = fixture()
      if (field === "name") property(f.fields.title).title = []
      else if (field === "description") f.fields.description = rich("description", "")
      else property(f.fields.kind).select = null
      errorOf(await f.run(adoptSharedNative(skillPage).pipe(Effect.result)))
      expect(f.readBodyCount()).toBe(0)
      expect(
        f.calls.some((call) =>
          call.path.includes(`data_sources/${library.files.data_source_id}/query`),
        ),
      ).toBe(false)
      expect(f.writes()).toHaveLength(0)
    },
  )

  test("an invisible original plan is a replay barrier without assigning identity or retrying POST", async () => {
    const f = fixture()
    f.unknownRecord("operation", false)
    expect(errorOf(await f.run(adoptSharedNative(skillPage).pipe(Effect.result))).code).toBe(
      "WRITE_OUTCOME_UNKNOWN",
    )
    expect(f.writes()).toHaveLength(1)
    f.clearCalls()
    const error = errorOf(await f.run(adoptSharedNative(skillPage).pipe(Effect.result)))
    expect(error.code).toBe("SHARED_RECORD_UNRESOLVED")
    expect(f.writes()).toHaveLength(0)
    expect(text(property(f.fields.skill_id).rich_text)).toBe("")
    expect(property(error.details).next).toEqual({
      argv: [
        "ntn-skills",
        "adopt",
        skillPage,
        "--database",
        library.skills.database_id,
        "--reconcile",
      ],
    })
  })

  test("matching identities after a lost PATCH cannot prove completion or permit enable", async () => {
    const f = fixture()
    f.losePatch()
    expect(errorOf(await f.run(adoptSharedNative(skillPage).pipe(Effect.result))).code).toBe(
      "WRITE_OUTCOME_UNKNOWN",
    )
    expect(text(property(f.fields.skill_id).rich_text)).toMatch(/^skill-/u)
    f.clearCalls()
    expect(errorOf(await f.run(adoptSharedNative(skillPage).pipe(Effect.result))).code).toBe(
      "SHARED_RECORD_UNRESOLVED",
    )
    expect(
      errorOf(await f.run(readSkill(skillPage, { authoring: true }).pipe(Effect.result))).code,
    ).toBe("SHARED_ADOPTION_PENDING")
    expect(
      errorOf(await f.run(updateSkill(skillPage, { enabled: true }).pipe(Effect.result))).code,
    ).toBe("SHARED_ADOPTION_PENDING")
    expect(f.writes()).toHaveLength(0)
    expect(f.readBodyCount()).toBe(0)
    expect(property(f.fields.enabled).checkbox).toBe(false)
  })

  test("a visible original completion reconciles without replay or a current-body substitute", async () => {
    const f = fixture()
    f.loseOutcome()
    expect(errorOf(await f.run(adoptSharedNative(skillPage).pipe(Effect.result))).code).toBe(
      "WRITE_OUTCOME_UNKNOWN",
    )
    f.bodies.set(skillPage, "# A later human draft edit\n")
    f.clearCalls()
    const result = await f.run(adoptSharedNative(skillPage, { reconcile: true }))
    expect(result.status).toBe("reconciled")
    expect(f.writes()).toHaveLength(0)
    expect(f.readBodyCount()).toBe(0)
    expect(f.bodies.get(skillPage)).toBe("# A later human draft edit\n")
    expect([...f.json.keys()].some((key) => key.startsWith("operations/"))).toBe(false)
  })

  test("a concurrent human body edit is preserved and prevents the identity PATCH", async () => {
    const f = fixture()
    f.afterPlan(() => f.bodies.set(skillPage, "# Later draft content\n"))
    expect(errorOf(await f.run(adoptSharedNative(skillPage).pipe(Effect.result))).code).toBe(
      "WRITE_CONFLICT",
    )
    expect(f.calls.some((call) => call.method === "PATCH")).toBe(false)
    expect(f.bodies.get(skillPage)).toBe("# Later draft content\n")
    expect(text(property(f.fields.skill_id).rich_text)).toBe("")
  })
})
