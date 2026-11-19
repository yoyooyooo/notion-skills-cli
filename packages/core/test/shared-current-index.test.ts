import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import {
  decodeCurrentFileContent,
  parseCurrentFileContent,
  parseCurrentSkillState,
  requireCurrentSkillReady,
  type CurrentFileContent,
} from "../src/shared-current-file.ts"
import { queryCurrentFilesForSkills, queryCurrentSkillIndex } from "../src/shared-current-index.ts"
import type { SharedLibrary } from "../src/shared-library-model.ts"
import { currentLibrary } from "./shared-current-fixture.ts"

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const skillPage = id(1)
const fileSource = id(6)
const skills = {
  ...currentLibrary.skills.property_ids,
  Name: "title",
  Description: "description",
  Kind: "kind",
  Enabled: "enabled",
  "Default Context": "default",
  "Skill ID": "skill-id",
  "Main File ID": "main-id",
  Content: "content",
  "Current State": "state",
  Operation: "operation",
}
const files = {
  ...currentLibrary.files.property_ids,
  Name: "title",
  "File ID": "file-id",
  Skill: "owner",
  Path: "path",
  Content: "content",
}
const library: SharedLibrary = {
  ...currentLibrary,
  skills: { database_id: id(3), data_source_id: id(4), property_ids: skills },
  files: { database_id: id(5), data_source_id: fileSource, property_ids: files },
}
const native = { kind: "native", mode: "100644", frontmatter: "" } satisfies CurrentFileContent
const resource = {
  kind: "resource",
  object_id: `resource-${"a".repeat(64)}`,
  sha256: "b".repeat(64),
  bytes: 42,
  mode: "100755",
} satisfies CurrentFileContent
const source = {
  kind: "source",
  source_id: "agent-kit",
  revision: "c".repeat(64),
  source_path: "skills/demo/SKILL.md",
  sha256: "d".repeat(64),
  bytes: 400,
  mode: "100644",
} satisfies CurrentFileContent
const rich = (propertyId: string, value: string) => ({
  id: propertyId,
  type: "rich_text",
  has_more: false,
  rich_text: [{ type: "text", plain_text: value, text: { content: value } }],
})
const select = (propertyId: string, value: string) => ({
  id: propertyId,
  type: "select",
  select: { name: value },
})
const checkbox = (propertyId: string, value: boolean) => ({
  id: propertyId,
  type: "checkbox",
  checkbox: value,
})
function skill(state = "ready", operation = "", content: CurrentFileContent = native) {
  return {
    object: "page",
    id: skillPage,
    parent: {
      type: "data_source_id",
      data_source_id: library.skills.data_source_id,
      database_id: library.skills.database_id,
    },
    last_edited_time: "2026-11-18T00:00:00.000Z",
    properties: {
      Name: { id: "title", type: "title", title: [{ plain_text: "Current demo" }] },
      Description: rich(skills.Description, "Use current files."),
      Kind: select(skills.Kind, "skill"),
      Enabled: checkbox(skills.Enabled, true),
      "Default Context": checkbox(skills["Default Context"], false),
      "Skill ID": rich(skills["Skill ID"], "demo"),
      "Main File ID": rich(skills["Main File ID"], "main-demo"),
      Content: rich(skills.Content, JSON.stringify(content)),
      "Current State": select(skills["Current State"], state),
      Operation: rich(skills.Operation, operation),
      Members: {
        id: library.skills.property_ids.Members,
        type: "relation",
        relation: [],
        has_more: false,
      },
      Requires: {
        id: library.skills.property_ids.Requires,
        type: "relation",
        relation: [],
        has_more: false,
      },
      Origin: {
        id: library.skills.property_ids.Origin,
        type: "relation",
        relation: [],
        has_more: false,
      },
      Tags: { id: library.skills.property_ids.Tags, type: "multi_select", multi_select: [] },
    },
  }
}
function file(
  n = 1,
  options: { owner?: string; path?: string; fileId?: string; content?: CurrentFileContent } = {},
) {
  return {
    object: "page",
    id: id(1000 + n),
    parent: {
      type: "data_source_id",
      data_source_id: fileSource,
      database_id: library.files.database_id,
    },
    last_edited_time: "2026-11-18T00:00:00.000Z",
    properties: {
      Name: { id: "title", type: "title", title: [{ plain_text: `File ${n}` }] },
      "File ID": rich(files["File ID"], options.fileId ?? `file-${n}`),
      Skill: {
        id: files.Skill,
        type: "relation",
        has_more: false,
        relation: [{ id: options.owner ?? skillPage }],
      },
      Path: rich(files.Path, options.path ?? `references/${n}.md`),
      Content: rich(files.Content, JSON.stringify(options.content ?? native)),
      Origin: {
        id: library.files.property_ids.Origin,
        type: "rollup",
        rollup: { type: "array", array: [], function: "show_unique" },
      },
    },
  }
}
const list = (results: unknown[], cursor: string | null = null) => ({
  object: "list",
  results,
  has_more: cursor !== null,
  next_cursor: cursor,
})
function client(responses: unknown[], failureAt?: number) {
  const calls: Array<{ path: string; body: unknown; method: string | undefined }> = []
  const service: Notion["Service"] = {
    version: Effect.succeed("test"),
    credentialIdentity: Effect.succeed("test"),
    request: (path, body, options) =>
      Effect.suspend(() => {
        const at = calls.length
        calls.push({ path, body, method: options?.method })
        if (at === failureAt) return Effect.fail(fail("NOTION_FORBIDDEN", "Permission denied."))
        if (at >= responses.length)
          return Effect.fail(fail("UNEXPECTED_REQUEST", "Unexpected I/O."))
        return Effect.succeed(responses[at])
      }),
  }
  return {
    calls,
    run: <A, E>(effect: Effect.Effect<A, E, Notion>) =>
      Effect.runPromise(effect.pipe(Effect.provideService(Notion, service))),
    files: (owners: readonly string[] = [skillPage]) =>
      Effect.runPromise(
        queryCurrentFilesForSkills({
          dataSourceId: fileSource,
          skillPageIds: owners,
          propertyIds: files,
        }).pipe(Effect.provideService(Notion, service)),
      ),
  }
}

describe("current content descriptors", () => {
  test("native, resource and Source have one strict current authority and exact applicable metadata", () => {
    for (const content of [native, resource, source])
      expect(parseCurrentFileContent(JSON.stringify(content))).toEqual(content)
    const frontmatter = "\uFEFF---\r\nname: exact\r\n---\r\n\r\n"
    expect(decodeCurrentFileContent({ ...native, frontmatter })).toEqual({ ...native, frontmatter })
    expect(decodeCurrentFileContent({ ...native, frontmatter: "---\n---\n" }).kind).toBe("native")
  })

  test("old facts and inapplicable hashes cannot become a fallback authority", () => {
    for (const content of [
      { ...native, sha256: "a".repeat(64) },
      { ...native, frontmatter: undefined },
      { ...native, frontmatter: "not a header" },
      { ...resource, mode: null },
      { ...resource, source_id: "source" },
      { ...resource, bytes: Number.MAX_SAFE_INTEGER + 1 },
      { ...source, sha256: undefined },
      { ...source, source_path: "../escape" },
      { ...source, source_path: "./file.md" },
      { ...source, revision: "" },
      { kind: "following", projection: { normalization_version: 1, sha256: "a".repeat(64) } },
    ])
      expect(() => decodeCurrentFileContent(content)).toThrow()
    expect(() => parseCurrentFileContent("")).toThrow("migration")
  })

  test("management may inspect a pending state, while ordinary consumption stops at its exact current operation", () => {
    expect(parseCurrentSkillState("ready", "")).toEqual({ state: "ready" })
    for (const name of ["applying", "attention"] as const) {
      const state = parseCurrentSkillState(name, "operation-current")
      expect(state).toEqual({ state: name, operation_id: "operation-current" })
      expect(() => requireCurrentSkillReady(state, skillPage)).toThrow("unfinished current work")
    }
    for (const [state, operation] of [
      ["ready", "old-operation"],
      ["applying", ""],
      ["done", ""],
    ])
      expect(() => parseCurrentSkillState(state!, operation!)).toThrow()
  })
})

describe("current Skill and Files metadata", () => {
  test("complete pagination reads only four registered Files properties, without bodies or Records", async () => {
    const c = client([
      list(
        Array.from({ length: 100 }, (_, n) => file(n + 1)),
        "next",
      ),
      list([file(101)]),
    ])
    expect((await c.files()).get(skillPage)).toHaveLength(101)
    expect(c.calls).toHaveLength(2)
    for (const call of c.calls) {
      const url = new URL(call.path, "https://api.notion.com/")
      expect(url.pathname).toBe(`/v1/data_sources/${fileSource}/query`)
      expect(url.searchParams.getAll("filter_properties")).toEqual([
        files["File ID"],
        files.Skill,
        files.Path,
        files.Content,
      ])
      expect(call.method).toBe("POST")
    }
    expect(c.calls[1]?.body).toMatchObject({ start_cursor: "next" })
  })

  test("stable property IDs survive display renames and ignore old Projection or Status values", async () => {
    const raw = file()
    const renamed = {
      ...raw,
      properties: {
        ...Object.fromEntries(
          Object.entries(raw.properties).map(([key, value]) => [`renamed ${key}`, value]),
        ),
        Content: rich("unregistered-content", JSON.stringify({ kind: "following" })),
        Projection: rich("old-projection", "invalid old marker"),
        Status: select("old-status", "tombstone"),
      },
    }
    const c = client([list([renamed])])
    expect((await c.files()).get(skillPage)?.[0]?.content).toEqual(native)
  })

  test("main and all supporting source/resource rows share one descriptor contract", async () => {
    const c = client([
      skill("ready", "", source),
      list([
        file(1, { content: { ...source, source_path: "skills/demo/references/1.md" } }),
        file(2, { path: "scripts/run.sh", content: resource }),
      ]),
    ])
    const index = await c.run(queryCurrentSkillIndex(library, skillPage))
    expect(index.main.content).toEqual(source)
    expect(index.files.map((value) => value.path)).toEqual(["references/1.md", "scripts/run.sh"])
    expect(index.files[1]?.content).toEqual(resource)
    expect(index).not.toHaveProperty("source_reference")
    expect(index).not.toHaveProperty("file_links")
    expect(c.calls).toHaveLength(2)
    expect(
      c.calls.some(
        (call) =>
          call.path.includes("markdown") || call.path.includes(library.records.data_source_id),
      ),
    ).toBe(false)
  })

  test("supplied current metadata needs no I/O and preserves pending state for management inspection", async () => {
    const c = client([])
    const index = await c.run(
      queryCurrentSkillIndex(library, skillPage, skill("attention", "current-write"), []),
    )
    expect(index.state).toEqual({ state: "attention", operation_id: "current-write" })
    expect(c.calls).toHaveLength(0)
  })

  test("old schemas and rows explicitly require migration, without projection or name fallback", async () => {
    const c = client([])
    const oldLibrary = {
      ...library,
      files: {
        ...library.files,
        property_ids: { "File ID": files["File ID"], Skill: files.Skill, Path: files.Path },
      },
    }
    const error = await c.run(Effect.flip(queryCurrentSkillIndex(oldLibrary, skillPage)))
    expect(error.code).toBe("CURRENT_SCHEMA_REQUIRED")
    expect(error.details).toMatchObject({ next: "migrate_current_content" })
    expect(c.calls).toHaveLength(0)
    const raw = file()
    const { Content: _content, ...oldProperties } = raw.properties
    const missing = client([
      list([{ ...raw, properties: { ...oldProperties, Projection: rich("projection", "{}") } }]),
    ])
    const missingError = await missing.run(
      Effect.flip(
        queryCurrentFilesForSkills({
          dataSourceId: fileSource,
          skillPageIds: [skillPage],
          propertyIds: files,
        }),
      ),
    )
    expect(missingError.code).toBe("CURRENT_SCHEMA_REQUIRED")
  })

  test("batching never exceeds 80 selected owners and refuses unselected ownership", async () => {
    const owners = Array.from({ length: 81 }, (_, n) => id(10_000 + n))
    const c = client([
      list([file(1, { owner: owners[0] })]),
      list([file(2, { owner: owners[80] })]),
    ])
    const result = await c.files(owners)
    expect(result.size).toBe(81)
    expect(c.calls).toHaveLength(2)
    expect(property(property(c.calls[0]?.body).filter).or).toHaveLength(80)
    expect(c.calls[1]?.body).toMatchObject({
      filter: { property: files.Skill, relation: { contains: owners[80] } },
    })
    await expect(client([list([file(3, { owner: id(999) })])]).files()).rejects.toThrow(
      "unselected",
    )
  })

  test("duplicates, portable spelling and file/directory collisions cannot form a current tree", async () => {
    for (const rows of [
      [file(), { ...file(2), id: file().id }],
      [file(), file(2, { fileId: "file-1" })],
      [file(1, { path: "a" }), file(2, { path: "a/b" })],
      [file(1, { path: "A.md" }), file(2, { path: "a.md" })],
      [file(1, { path: "../escape" })],
      [file(1, { path: ".git/config" })],
    ])
      await expect(client([list(rows)]).files()).rejects.toThrow()
    for (const row of [
      file(1, { path: "SKILL.md" }),
      file(1, { fileId: "main-demo" }),
      { ...file(), id: skillPage },
    ])
      await expect(
        client([list([row])]).run(queryCurrentSkillIndex(library, skillPage, skill())),
      ).rejects.toThrow()
  })

  test("double owners and truncated relation or query responses never establish completeness", async () => {
    const raw = file()
    const relation = raw.properties.Skill
    for (const altered of [
      { ...relation, relation: [...relation.relation, { id: id(99) }] },
      { ...relation, has_more: true },
    ])
      await expect(
        client([list([{ ...raw, properties: { ...raw.properties, Skill: altered } }])]).files(),
      ).rejects.toThrow("relation")
    await expect(
      client([{ ...list([raw]), request_status: { type: "incomplete" } }]).files(),
    ).rejects.toThrow()
    await expect(client([list([raw], "again"), list([file(2)], "again")]).files()).rejects.toThrow(
      "pagination",
    )
    await expect(client([{ ...list([]), has_more: true }]).files()).rejects.toThrow("pagination")
  })

  test("permission failure after a partial page remains a failure with no repair writes", async () => {
    const c = client([list([file()], "next")], 1)
    const error = await c.run(
      Effect.flip(
        queryCurrentFilesForSkills({
          dataSourceId: fileSource,
          skillPageIds: [skillPage],
          propertyIds: files,
        }),
      ),
    )
    expect(error.code).toBe("NOTION_FORBIDDEN")
    expect(c.calls).toHaveLength(2)
    expect(c.calls.every((call) => call.method === "POST" && call.path.includes("/query?"))).toBe(
      true,
    )
  })
})
