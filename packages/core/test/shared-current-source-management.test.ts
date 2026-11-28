import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { trashPath } from "../src/local-locks.ts"
import { property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { queryCurrentSourceTargets } from "../src/shared-current-source-management.ts"
import { currentWriteFixture, id, library } from "./shared-current-write-fixture.ts"

const parent = mkdtempSync(join(tmpdir(), "ntn-source-management-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})
const sourcePage = id(9000)
const skillQuery = `v1/data_sources/${library.skills.data_source_id}/query`
const fileQuery = `v1/data_sources/${library.files.data_source_id}/query`
const rich = (content: string) => ({ rich_text: [{ type: "text", text: { content } }] })
const native = { kind: "native", mode: "100644", frontmatter: "" }

function seed(
  fixture: ReturnType<typeof currentWriteFixture>,
  skillId: string,
  origins: readonly string[],
  supporting = 1,
) {
  return fixture.run(
    Effect.gen(function* () {
      const api = yield* Notion,
        fields = library.skills.property_ids
      const created = property(
        yield* api.request(
          "v1/pages",
          {
            parent: { type: "data_source_id", data_source_id: library.skills.data_source_id },
            properties: {
              [fields.Name!]: { title: [{ type: "text", text: { content: skillId } }] },
              [fields.Description!]: rich("Current metadata inventory"),
              [fields.Kind!]: { select: { name: "skill" } },
              [fields.Enabled!]: { checkbox: true },
              [fields["Default Context"]!]: { checkbox: false },
              [fields["Skill ID"]!]: rich(skillId),
              [fields["Main File ID"]!]: rich(`main-${skillId}`),
              [fields.Content!]: rich(JSON.stringify(native)),
              [fields["Current State"]!]: { select: { name: "ready" } },
              [fields.Operation!]: rich(""),
              [fields.Origin!]: { relation: origins.map((id) => ({ id })) },
            },
          },
          { method: "POST" },
        ),
      )
      if (typeof created.id !== "string") throw new Error("The fixture did not create a Skill page")
      const files = library.files.property_ids
      for (let index = 0; index < supporting; index++)
        yield* api.request(
          "v1/pages",
          {
            parent: { type: "data_source_id", data_source_id: library.files.data_source_id },
            properties: {
              [files.Name!]: { title: [{ type: "text", text: { content: `file-${index}.md` } }] },
              [files["File ID"]!]: rich(`${skillId}-file-${index}`),
              [files.Path!]: rich(`references/file-${index}.md`),
              [files.Content!]: rich(JSON.stringify(native)),
              [files.Skill!]: { relation: [{ id: created.id }] },
            },
          },
          { method: "POST" },
        )
      return created.id
    }),
  )
}

test("a first Source with two new target identities returns an empty inventory without an empty Files query", async () => {
  const f = currentWriteFixture(parent)
  const result = await f.run(
    queryCurrentSourceTargets(library, { skillIds: ["new-alpha", "new-beta"] }),
  )
  expect(result.size).toBe(0)
  expect(f.calls.map((call) => call.path)).toEqual([skillQuery])
  expect(f.mutations()).toEqual([])
})

test("a reverse query cannot admit an unrelated returned Skill merely because an Origin filter was sent", async () => {
  const f = currentWriteFixture(parent)
  const page = await seed(f, "unrelated", [])
  f.clearCalls()
  f.rewrite((path, response) =>
    path === skillQuery ? { ...response, results: [f.pages.get(page)] } : response,
  )
  await expect(
    f.run(
      queryCurrentSourceTargets(library, {
        skillIds: [],
        sourcePageId: sourcePage,
      }),
    ),
  ).rejects.toMatchObject({
    code: "CURRENT_SOURCE_MANAGEMENT_INVALID",
    message: expect.stringContaining("unrelated"),
  })
  expect(f.calls.map((call) => call.path)).toEqual([skillQuery])
  expect(f.mutations()).toEqual([])
})

test("declared targets and actual inline Origin members share one complete batched Files scope", async () => {
  const f = currentWriteFixture(parent)
  const declared = await seed(f, "declared", [])
  const linked = await seed(f, "linked", [
    sourcePage,
    ...Array.from({ length: 30 }, (_, index) => id(10000 + index)),
  ])
  await seed(f, "unrelated", [])
  f.clearCalls()
  const result = await f.run(
    queryCurrentSourceTargets(library, { skillIds: ["declared"], sourcePageId: sourcePage }),
  )
  expect([...result.keys()].sort()).toEqual(["declared", "linked"])
  expect(result.get("declared")!.files[0]!.skill_page_id).toBe(declared)
  expect(result.get("linked")!.files[0]!.skill_page_id).toBe(linked)
  expect(f.calls.filter((call) => call.path.startsWith(fileQuery))).toHaveLength(1)
  expect(f.calls.filter((call) => call.path.includes("/properties/"))).toHaveLength(0)
  expect(f.calls).toHaveLength(2)
  const filter = property(
    property(f.calls.find((call) => call.path.startsWith(fileQuery))!.body).filter,
  )
  expect(filter.or).toEqual(
    [declared, linked].map((page) => ({
      property: library.files.property_ids.Skill,
      relation: { contains: page },
    })),
  )
  expect(f.mutations()).toEqual([])
})

test("Origin membership beyond both inline and the first property page is admitted before complete Files pagination", async () => {
  const f = currentWriteFixture(parent)
  const declared = await seed(f, "declared", [], 101)
  const linked = await seed(
    f,
    "linked",
    [...Array.from({ length: 100 }, (_, index) => id(10000 + index)), sourcePage],
    101,
  )
  await seed(f, "unrelated", [id(9900)])
  f.clearCalls()
  const result = await f.run(
    queryCurrentSourceTargets(library, { skillIds: ["declared"], sourcePageId: sourcePage }),
  )
  expect(result.get("declared")!.files).toHaveLength(101)
  expect(result.get("linked")!.files).toHaveLength(101)
  expect(
    [...result.values()]
      .flatMap((skill) => skill.files)
      .every((file) => [declared, linked].includes(file.skill_page_id)),
  ).toBe(true)
  const propertyCalls = f.calls.filter((call) => call.path.includes("/properties/"))
  expect(propertyCalls.map((call) => call.path)).toEqual([
    `v1/pages/${linked}/properties/${library.skills.property_ids.Origin}?page_size=100`,
    `v1/pages/${linked}/properties/${library.skills.property_ids.Origin}?page_size=100&start_cursor=100`,
  ])
  const fileCalls = f.calls.filter((call) => call.path.startsWith(fileQuery))
  expect(fileCalls.map((call) => property(call.body).start_cursor ?? null)).toEqual([
    null,
    "100",
    "200",
  ])
  for (const call of fileCalls)
    expect(property(property(call.body).filter).or).toEqual(
      [declared, linked].map((page) => ({
        property: library.files.property_ids.Skill,
        relation: { contains: page },
      })),
    )
  expect(
    f.calls.some((call) => call.path.includes("/markdown") || call.path.includes("/blocks/")),
  ).toBe(false)
  expect(f.mutations()).toEqual([])
})

test("an incomplete Origin property traversal fails before reading or accepting a target file scope", async () => {
  const f = currentWriteFixture(parent)
  const page = await seed(f, "linked", [
    ...Array.from({ length: 100 }, (_, index) => id(10000 + index)),
    sourcePage,
  ])
  f.clearCalls()
  f.rewrite((path, response) =>
    path.startsWith(`v1/pages/${page}/properties/`)
      ? { ...response, has_more: true, next_cursor: null }
      : response,
  )
  await expect(
    f.run(queryCurrentSourceTargets(library, { skillIds: [], sourcePageId: sourcePage })),
  ).rejects.toMatchObject({
    code: "CURRENT_SOURCE_MANAGEMENT_INVALID",
    message: expect.stringContaining("pagination"),
  })
  expect(f.calls.filter((call) => call.path.startsWith(fileQuery))).toHaveLength(0)
  expect(f.mutations()).toEqual([])
})
