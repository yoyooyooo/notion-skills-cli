import { expect, test } from "bun:test"
import { Effect } from "effect"
import { sharedRecordFromPage } from "../src/shared-content.ts"
import { Notion } from "../src/notion.ts"
import { fail, property } from "../src/model.ts"
import { fileRef, parseRef } from "../src/ref.ts"
import { compileSharedNativeReferences } from "../src/shared-native-references.ts"
import { materializeSharedNativeFile } from "../src/shared-native-file-content.ts"
import { fileRecord } from "../src/skill-file-index.ts"
import {
  digest,
  id,
  library,
  rich,
  sharedSnapshotFixture,
  skillPage,
} from "./shared-snapshot-fixture.ts"

const url = (page: string) => "https://www.notion.so/" + page.replaceAll("-", "")
function fixture() {
  const base = sharedSnapshotFixture()
  const source = {
    alias: library.library_id,
    title: "",
    role: "content" as const,
    database_id: library.skills.database_id,
    data_source_ids: [library.skills.data_source_id],
    shared_library: library,
  }
  const record = sharedRecordFromPage(base.main, source, library.skills.data_source_id)
  const other = {
    ...structuredClone(base.main),
    id: id(21),
    properties: { ...property(base.main.properties), skill_id: rich("skill_id", "stable-other") },
  }
  const ownFile = fileRecord(
    base.files[0],
    skillPage,
    library.files.data_source_id,
    library.files.property_ids,
  )
  const file = {
    ...structuredClone(base.files[0]),
    id: id(22),
    properties: {
      ...base.files[0]!.properties,
      file_id: rich("file_id", "stable-resource"),
      skill: { id: "skill", type: "relation", relation: [{ id: id(21) }], has_more: false },
    },
  }
  const skills: unknown[] = [base.main, other]
  const files: unknown[] = [...base.files, file]
  const blocks: Record<string, unknown>[] = []
  const calls: string[] = []
  const compile = (
    markdown: string,
    relations: unknown = { members: [], required: [] },
    supplied = true,
  ) =>
    base.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* compileSharedNativeReferences({
          library,
          record,
          bindings: [ownFile],
          files: [
            { path: "SKILL.md", markdown, body_sha256: digest(markdown), page_id: skillPage },
          ],
          relations,
          ...(supplied
            ? {
                inventory: {
                  skills: {
                    data_source_id: library.skills.data_source_id,
                    complete: true as const,
                    pages: skills,
                  },
                  files: {
                    data_source_id: library.files.data_source_id,
                    complete: true as const,
                    pages: files,
                  },
                },
              }
            : {}),
        }).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body) =>
              Effect.suspend(() => {
                calls.push(path)
                if (path === "v1/blocks/" + skillPage + "/children?page_size=100")
                  return Effect.succeed({
                    object: "list",
                    results: blocks,
                    has_more: false,
                    next_cursor: null,
                  })
                const selected = path.startsWith(
                  "v1/data_sources/" + library.skills.data_source_id + "/query?",
                )
                  ? skills
                  : path.startsWith("v1/data_sources/" + library.files.data_source_id + "/query?")
                    ? files
                    : undefined
                if (selected !== undefined) {
                  const cursor = property(body).start_cursor
                  const from = cursor === undefined ? 0 : Number(cursor)
                  const end = Math.min(from + 1, selected.length)
                  return Effect.succeed({
                    object: "list",
                    results: selected.slice(from, end),
                    has_more: end < selected.length,
                    next_cursor: end < selected.length ? String(end) : null,
                  })
                }
                return Effect.fail(
                  fail(
                    "UNEXPECTED_REQUEST",
                    "A native reference attempted a target body or foreign request.",
                    { path },
                  ),
                )
              }),
          }),
        )
      }),
    )
  return { base, record, other, ownFile, file, files, skills, blocks, calls, compile }
}

test("native mentions, page links and observed Link to page produce exact scoped identities without target bodies", async () => {
  const f = fixture()
  f.blocks.push(
    {
      id: id(30),
      type: "link_to_page",
      parent: { type: "page_id", page_id: skillPage },
      has_children: false,
      link_to_page: { type: "page_id", page_id: id(22) },
    },
    {
      id: id(31),
      type: "child_page",
      parent: { type: "page_id", page_id: skillPage },
      has_children: true,
      child_page: { title: "ordinary child" },
    },
  )
  const markdown = [
    '<mention url="' + url(id(21)) + '">Same display name</mention>',
    "[own](" + url(f.ownFile.page_id) + ")",
    '<page url="' + url(id(22)) + '">Resource</page>',
    '<page url="' + url(id(31)) + '">ordinary child</page>',
    "[unmanaged](" + url(id(99)) + ")",
  ].join("\n")
  const result = await f.compile(markdown)
  expect(result.index?.entries).toHaveLength(3)
  expect(result.index?.unresolved).toEqual([
    {
      from: "SKILL.md",
      href: url(id(99)),
      page_id: id(99),
      availability: "unmanaged_or_unavailable",
    },
  ])
  const resource = result.index!.entries.find((entry) => entry.page_id === id(22))!
  expect(resource).toMatchObject({
    kind: "file",
    file_id: "stable-resource",
    skill_id: "stable-other",
    skill_page_id: id(21),
    path: "references/1.md",
    availability: "metadata_only",
  })
  expect(parseRef(resource.ref)).toMatchObject({
    selector: "shared_skill:library-snapshot:stable-other",
    file_id: "stable-resource",
  })
  expect(f.calls).toEqual(["v1/blocks/" + skillPage + "/children?page_size=100"])
  const rendered = materializeSharedNativeFile(
    markdown,
    "SKILL.md",
    [f.ownFile],
    result.links,
    result.linkedPages.get("SKILL.md"),
  )
  expect(rendered).toContain("[Resource](" + resource.ref + ")")
  expect(rendered).toContain("[own](references/1.md)")
  expect(rendered).toContain("[unmanaged](" + url(id(99)) + ")")
  expect(rendered).not.toContain("ordinary child")
  expect(result.index).not.toHaveProperty("required")
})

test("an unmanaged actual Link to page remains authored content instead of becoming a removed child page", async () => {
  const f = fixture()
  f.blocks.push({
    id: id(30),
    type: "link_to_page",
    parent: { type: "page_id", page_id: skillPage },
    has_children: false,
    link_to_page: { type: "page_id", page_id: id(99) },
  })
  const markdown = '<page url="' + url(id(99)) + '">Unmanaged</page>'
  const result = await f.compile(markdown)
  expect(result.index?.entries).toEqual([])
  expect(result.index?.unresolved).toHaveLength(1)
  expect(
    materializeSharedNativeFile(
      markdown,
      "SKILL.md",
      [],
      result.links,
      result.linkedPages.get("SKILL.md"),
    ),
  ).toBe(markdown)
})

test("fenced and native code, script strings, escaped tags, names and templates do not register dependencies", async () => {
  const f = fixture()
  const href = url(id(21)),
    tick = String.fromCharCode(96)
  const markdown = [
    tick.repeat(3) + "js",
    'const dependency = "' + href + '"',
    tick.repeat(3),
    tick + "[example](" + href + ")" + tick,
    "> " + tick.repeat(3) + "js",
    '> const nested = "' + href + '"',
    "> " + tick.repeat(3),
    "<code>[example](" + href + ")</code>",
    '<script>const dependency = "' + href + '"</script>',
    '\\<mention url="' + href + '">literal</mention>',
    "[unknown](https://example.test/docs/" + id(21) + ")",
    "stable-other and ../<name>/SKILL.md",
  ].join("\n")
  const result = await f.compile(markdown, undefined, false)
  expect(result.index).toBeUndefined()
  expect(f.calls).toHaveLength(0)
  expect(materializeSharedNativeFile(markdown, "SKILL.md", [], result.links)).toBe(markdown)
})

test("ordinary native links use complete paginated same-library inventories and do not request any target page", async () => {
  const f = fixture()
  const result = await f.compile("[resource](" + url(id(22)) + ")", undefined, false)
  expect(result.index?.entries[0]?.file_id).toBe("stable-resource")
  expect(f.calls).toHaveLength(f.skills.length + f.files.length)
  expect(f.calls.every((path) => path.startsWith("v1/data_sources/"))).toBe(true)
  expect(f.calls.some((path) => path.includes("/blocks/") || path.includes("/pages/"))).toBe(false)
})

test("duplicate logical Skill IDs and File IDs fail instead of selecting a same-named row", async () => {
  const skill = fixture()
  skill.skills.push({ ...structuredClone(skill.other), id: id(42) })
  await expect(skill.compile("[skill](" + url(id(21)) + ")")).rejects.toMatchObject({
    code: "SHARED_SKILL_ID_CONFLICT",
  })
  const file = fixture()
  file.files.push({ ...structuredClone(file.file), id: id(43) })
  await expect(file.compile("[file](" + url(id(22)) + ")")).rejects.toMatchObject({
    code: "SHARED_FILE_ID_CONFLICT",
  })
})

test("the same File ID in distinct owners resolves each real page to its exact owner-scoped ref", async () => {
  const f = fixture()
  f.file.properties.file_id = rich("file_id", f.ownFile.file_id)
  const result = await f.compile(`[own](${url(f.ownFile.page_id)})\n[other](${url(id(22))})`)
  expect(result.index?.entries).toHaveLength(2)
  const own = result.index!.entries.find((entry) => entry.page_id === f.ownFile.page_id)!
  const other = result.index!.entries.find((entry) => entry.page_id === id(22))!
  expect(own.file_id).toBe(other.file_id)
  expect(own.skill_page_id).toBe(skillPage)
  expect(other.skill_page_id).toBe(id(21))
  expect(parseRef(own.ref)).toMatchObject({ selector: f.record.id, file_id: f.ownFile.file_id })
  expect(parseRef(other.ref)).toMatchObject({
    selector: "shared_skill:library-snapshot:stable-other",
    file_id: f.ownFile.file_id,
  })
  expect(own.id).not.toBe(other.id)
  expect(f.calls).toEqual([])
  f.files.push({ ...structuredClone(f.file), id: id(43) })
  await expect(f.compile(`[other](${url(id(22))})`)).rejects.toMatchObject({
    code: "SHARED_FILE_ID_CONFLICT",
  })
})

test("a physical File page cannot change owner behind an existing current binding", async () => {
  const f = fixture()
  const original = property(f.files[0])
  f.files[0] = {
    ...original,
    properties: {
      ...property(original.properties),
      skill: { id: "skill", type: "relation", relation: [{ id: id(21) }], has_more: false },
    },
  }
  await expect(
    f.compile(`[own](${url(f.ownFile.page_id)})\n[external](${url(id(22))})`),
  ).rejects.toMatchObject({ code: "SHARED_FILE_ID_CONFLICT" })
  const duplicate = fixture()
  await expect(
    duplicate.base.run(
      compileSharedNativeReferences({
        library,
        record: duplicate.record,
        files: [
          {
            path: "SKILL.md",
            markdown: `[own](${url(duplicate.ownFile.page_id)})`,
            body_sha256: digest("raw"),
          },
        ],
        bindings: [duplicate.ownFile, { ...duplicate.ownFile, file_id: "second-binding" }],
        relations: [],
      }),
    ),
  ).rejects.toMatchObject({ code: "SHARED_FILE_ID_CONFLICT" })
})

test("ambiguous owners and a foreign complete inventory are rejected at the boundary", async () => {
  const f = fixture()
  f.file.properties.skill.relation.push({ id: skillPage })
  await expect(f.compile("[file](" + url(id(22)) + ")")).rejects.toMatchObject({
    code: "SHARED_REFERENCE_INVALID",
  })
  const error = await f.base.run(
    Effect.flip(
      compileSharedNativeReferences({
        library,
        record: f.record,
        bindings: [],
        files: [
          {
            path: "SKILL.md",
            markdown: "[skill](" + url(id(21)) + ")",
            body_sha256: digest("raw"),
          },
        ],
        relations: [],
        inventory: { skills: { data_source_id: id(999), complete: true, pages: f.skills } },
      }),
    ),
  )
  expect(error.code).toBe("SHARED_REFERENCE_SCOPE")
})

test("the derived index is bound to original native bytes, relation summary and parser version", async () => {
  const f = fixture()
  const markdown = '<mention url="' + url(id(21)) + '" />'
  const first = await f.compile(markdown)
  expect(first.index?.source_files).toEqual([
    { path: "SKILL.md", body_sha256: digest(markdown), input_sha256: digest(markdown) },
  ])
  expect(first.index?.parser_version).toBe(1)
  expect((await f.compile(markdown)).index).toEqual(first.index)
  expect((await f.compile(markdown + "\n")).index?.index_sha256).not.toBe(first.index?.index_sha256)
  expect(
    (await f.compile(markdown, { members: ["changed"], required: [] })).index?.index_sha256,
  ).not.toBe(first.index?.index_sha256)
})

test("disabled targets stay a metadata directory entry without activating or reading them", async () => {
  const f = fixture()
  property(f.other.properties).enabled = { id: "enabled", type: "checkbox", checkbox: false }
  const result = await f.compile("[skill](" + url(id(21)) + ")")
  expect(result.index?.entries[0]?.availability).toBe("disabled")
  expect(result.index?.entries[0]?.ref).toBe(
    fileRef("shared_skill:library-snapshot:stable-other", "SKILL.md"),
  )
  expect(f.calls).toHaveLength(0)
})
