import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createPortable } from "../src/mutation.ts"
import { property, SkillsError } from "../src/model.ts"
import type { PortableSkill } from "../src/portable.ts"
import { createLibrary, sharedCreateFixture } from "./shared-create-fixture.ts"
import { encode, id } from "./shared-snapshot-fixture.ts"

const input: PortableSkill = {
  kind: "skill",
  name: "Public shared creation",
  description: "A native public creation without legacy ownership.",
  main: "SKILL.md",
  files: [
    {
      path: "SKILL.md",
      bytes: encode(
        "---\nname: Public shared creation\ndescription: A native public creation without legacy ownership.\n---\n\n# Created\n\n[Reference](references/a.md)\n",
      ),
    },
    { path: "references/a.md", bytes: encode("# Reference\r\n") },
  ],
}
function failure<A>(
  result:
    | { readonly _tag: "Success"; readonly success: A }
    | { readonly _tag: "Failure"; readonly failure: unknown },
): SkillsError {
  if (result._tag !== "Failure" || !(result.failure instanceof SkillsError))
    throw new Error("Expected a typed SkillsError")
  return result.failure
}

describe("standard shared create routing", () => {
  test("a later body edit remains preserved and is not reported as the original verified create", async () => {
    const f = sharedCreateFixture()
    let createdPage: string | undefined
    const later = "# Later authored edit\n\nPreserve this newer body."
    f.onCreate((page, kind) => {
      if (kind === "skill") createdPage = String(page.id)
    })
    f.afterOutcome(() => {
      if (createdPage === undefined) throw new Error("Original Skill receipt is missing")
      f.base.bodies.set(createdPage, later)
    })
    const error = failure(
      await f.run(
        createPortable(input, { database: createLibrary.skills.database_id }).pipe(Effect.result),
      ),
    )
    expect(error.code).toBe("WRITE_VERIFICATION_FAILED")
    expect(property(error.details).create_operation_id).toMatch(/^skill-create-/u)
    expect(f.base.bodies.get(createdPage ?? "")).toBe(later)
    expect(f.nativeCreates()).toHaveLength(2)
    expect(f.enablePatches()).toHaveLength(1)
    expect(f.calls.some((call) => call.method === "PATCH" && call.path.includes("/markdown"))).toBe(
      false,
    )
    expect(f.pending()).toHaveLength(0)
  })

  test("later native metadata cannot replace the frozen create properties in public verification", async () => {
    const f = sharedCreateFixture()
    let createdPage: string | undefined
    const field = createLibrary.skills.property_ids.Description!
    f.onCreate((page, kind) => {
      if (kind === "skill") createdPage = String(page.id)
    })
    f.afterOutcome(() => {
      const page = createdPage === undefined ? undefined : f.skills.get(createdPage)
      if (page === undefined) throw new Error("Original Skill receipt is missing")
      property(page.properties)[field] = {
        id: field,
        type: "rich_text",
        has_more: false,
        rich_text: [{ type: "text", text: { content: "Later native description" } }],
      }
    })
    const error = failure(
      await f.run(
        createPortable(input, { database: createLibrary.skills.database_id }).pipe(Effect.result),
      ),
    )
    expect(error.code).toBe("WRITE_VERIFICATION_FAILED")
    expect(property(error.details).create_operation_id).toMatch(/^skill-create-/u)
    const page = createdPage === undefined ? undefined : f.skills.get(createdPage)
    const spans = property(property(page?.properties)[field]).rich_text
    expect(spans).toEqual([{ type: "text", text: { content: "Later native description" } }])
    expect(f.nativeCreates()).toHaveLength(2)
    expect(f.enablePatches()).toHaveLength(1)
    expect(f.pending()).toHaveLength(0)
  })

  test.each(["explicit", "default"])(
    "creates a complete native Skill through the public entry (%s)",
    async (selection) => {
      const f = sharedCreateFixture()
      f.base.json.set("config.json", {
        ...(selection === "default" ? { default_database: createLibrary.skills.database_id } : {}),
        sources: [
          {
            alias: "unrelated-broken",
            database_id: id(5000),
            data_source_ids: [id(5001)],
            title: "Guizang",
            role: "content",
          },
        ],
      })
      const result = await f.run(
        createPortable(input, {
          ...(selection === "explicit" ? { database: createLibrary.skills.database_id } : {}),
          defaultContext: true,
        }),
      )
      expect(result.operation).toBe("create")
      expect(property(result).verified).toBe(true)
      expect(property(result).ref).toMatch(/^skill:\/\//u)
      const record = property(property(result).record)
      expect(property(record.locator).type).toBe("shared_skill")
      expect(record.name).toBe(input.name)
      expect(record.default_context).toBe(true)
      expect(property(result).files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "SKILL.md" }),
          expect.objectContaining({ path: "references/a.md" }),
        ]),
      )
      expect(f.nativeCreates()).toHaveLength(2)
      expect(f.enablePatches()).toHaveLength(1)
      expect(
        f.calls.some(
          (call) =>
            call.path.includes("/ai/skills/") ||
            call.path.includes("/file_uploads") ||
            call.path.includes(id(5000)) ||
            call.path.includes(id(5001)) ||
            call.path.includes("/search"),
        ),
      ).toBe(false)
      expect([...f.base.json.keys()].some((key) => key.startsWith("publications/"))).toBe(false)
    },
  )

  test("public dry-run freezes the native projection without allocating any page or receipt", async () => {
    const f = sharedCreateFixture()
    const result = await f.run(
      createPortable(input, { database: createLibrary.skills.database_id, dryRun: true }),
    )
    expect(property(result).dry_run).toBe(true)
    expect(property(result).status).toBe("planned")
    expect(f.writes()).toHaveLength(0)
    expect(f.pending()).toHaveLength(0)
    expect(f.currentBodies()).toHaveLength(0)
    expect([...f.base.json.keys()].some((key) => key.startsWith("publications/"))).toBe(false)
  })

  test("an unknown first native POST keeps its original plan and never falls back to legacy creation", async () => {
    const f = sharedCreateFixture()
    f.unknown("skill", false)
    const result = failure(
      await f.run(
        createPortable(input, { database: createLibrary.skills.database_id }).pipe(Effect.result),
      ),
    )
    expect(result.code).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(f.pending()).toHaveLength(1)
    expect(f.nativeCreates()).toHaveLength(1)
    f.clear()
    await f.run(
      createPortable(input, { database: createLibrary.skills.database_id }).pipe(Effect.result),
    )
    expect(f.nativeCreates()).toHaveLength(0)
    expect(f.enablePatches()).toHaveLength(0)
    expect([...f.base.json.keys()].some((key) => key.startsWith("publications/"))).toBe(false)
  })

  test("the legacy attachment storage option is rejected before shared writes", async () => {
    const f = sharedCreateFixture()
    expect(
      failure(
        await f.run(
          createPortable(input, {
            database: createLibrary.skills.database_id,
            storage: "markdown_files",
          }).pipe(Effect.result),
        ),
      ).code,
    ).toBe("INVALID_CONTENT_SOURCE")
    expect(f.writes()).toHaveLength(0)
    expect(f.pending()).toHaveLength(0)
  })
})
