import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { trashPath } from "../src/local-locks.ts"
import { property } from "../src/model.ts"
import { loadCurrentDailySkills } from "../src/shared-current-daily.ts"
import { sourceRich } from "../src/shared-source-definitions.ts"
import { currentWriteFixture, id, library } from "./shared-current-write-fixture.ts"

const parent = mkdtempSync(join(tmpdir(), "ntn-current-daily-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})
const dailyId = "daily-policy",
  deleteId = "delete-policy"
const skillQuery = `v1/data_sources/${library.skills.data_source_id}/query`
const sourceQuery = `v1/data_sources/${library.sources.data_source_id}/query`
const rich = (id: string, content: string) => ({
  id,
  type: "rich_text",
  rich_text: sourceRich(content),
})
const select = (id: string, name: string) => ({ id, type: "select", select: { name } })
const check = (id: string, checkbox: boolean) => ({ id, type: "checkbox", checkbox })
const title = (id: string, content: string) => ({ id, type: "title", title: sourceRich(content) })

function fixture() {
  const f = currentWriteFixture(parent)
  const schema = (path: string, response: Record<string, unknown>) => {
    if (
      [library.skills, library.sources].some(
        (table) => path === `v1/data_sources/${table.data_source_id}`,
      )
    )
      return {
        ...response,
        properties: {
          ...property(response.properties),
          日用: { id: dailyId, name: "日用", type: "checkbox", checkbox: {} },
          期望删除: { id: deleteId, name: "期望删除", type: "checkbox", checkbox: {} },
        },
      }
    return response
  }
  f.rewrite(schema)
  return { ...f, schema }
}
type Fixture = ReturnType<typeof fixture>

function skill(
  f: Fixture,
  n: number,
  options: {
    daily?: boolean
    defaultContext?: boolean
    enabled?: boolean
    desiredDelete?: boolean
    skillId?: string
  } = {},
) {
  const fields = library.skills.property_ids,
    page = id(1000 + n),
    skillId = options.skillId ?? `skill-${n}`
  f.pages.set(page, {
    object: "page",
    id: page,
    parent: { type: "data_source_id", data_source_id: library.skills.data_source_id },
    properties: {
      [fields.Name!]: title(fields.Name!, `Skill ${n}`),
      [fields.Description!]: rich(fields.Description!, "Daily projection target"),
      [fields["Skill ID"]!]: rich(fields["Skill ID"]!, skillId),
      [fields.Kind!]: select(fields.Kind!, "skill"),
      [fields.Enabled!]: check(fields.Enabled!, options.enabled ?? true),
      [fields["Default Context"]!]: check(
        fields["Default Context"]!,
        options.defaultContext ?? false,
      ),
      [dailyId]: check(dailyId, options.daily ?? false),
      [deleteId]: check(deleteId, options.desiredDelete ?? false),
    },
  })
  return { page, skillId }
}

function source(
  f: Fixture,
  n: number,
  skills: readonly string[],
  options: { daily?: boolean; enabled?: boolean; state?: "ready" | "applying" } = {},
) {
  const fields = library.sources.property_ids,
    page = id(2000 + n),
    sourceId = `source-daily-${n}`
  const hash = "a".repeat(64)
  const values: Record<string, unknown> = {
    Name: title(fields.Name!, `Source ${n}`),
    Description: rich(fields.Description!, "Selected current source"),
    "Source ID": rich(fields["Source ID"]!, sourceId),
    Provider: select(fields.Provider!, "git"),
    Status: select(fields.Status!, options.state ?? "ready"),
    Policy: select(fields.Policy!, "manual"),
    Enabled: check(fields.Enabled!, options.enabled ?? true),
    Location: rich(fields.Location!, "https://github.com/example/daily"),
    Ref: rich(fields.Ref!, "main"),
    Selection: rich(
      fields.Selection!,
      JSON.stringify({ roots: ["skills"], include: [], exclude: [], mapping: {} }),
    ),
    Options: rich(fields.Options!, "{}"),
    Contributions: rich(
      fields.Contributions!,
      JSON.stringify(
        skills.map((skill_id, index) => ({
          member_key: `skills/member-${index}`,
          skill_id,
          mount_path: "",
          mapping: {},
          exclude: [],
        })),
      ),
    ),
    Content: rich(
      fields.Content!,
      JSON.stringify({
        version: 1,
        resource: {
          kind: "resource",
          object_id: `resource-${hash}`,
          sha256: hash,
          bytes: 123,
          mode: "100644",
        },
      }),
    ),
    "Last Revision": rich(fields["Last Revision"]!, hash),
    Operation: rich(fields.Operation!, options.state === "applying" ? "source-pending" : ""),
  }
  f.pages.set(page, {
    object: "page",
    id: page,
    parent: { type: "data_source_id", data_source_id: library.sources.data_source_id },
    properties: {
      ...Object.fromEntries(Object.entries(values).map(([name, value]) => [fields[name]!, value])),
      [dailyId]: check(dailyId, options.daily ?? true),
      [deleteId]: check(deleteId, false),
    },
  })
  return { page, sourceId }
}

test("daily selection unions current Source members, Skill checkbox and Default Context without Origin or bodies", async () => {
  const f = fixture()
  const inherited = skill(f, 1),
    direct = skill(f, 2, { daily: true }),
    context = skill(f, 3, { defaultContext: true })
  const all = skill(f, 4, {
    daily: true,
    defaultContext: true,
    enabled: false,
    desiredDelete: true,
  })
  skill(f, 5)
  const upstream = source(f, 1, [inherited.skillId, all.skillId])
  source(f, 2, ["missing-non-daily-member"], { daily: false })
  const result = await f.run(loadCurrentDailySkills(library))
  expect(result.complete).toBe(true)
  expect(result.skills.map((item) => item.skill_id)).toEqual([
    inherited.skillId,
    direct.skillId,
    context.skillId,
    all.skillId,
  ])
  expect(result.skills[0]!.reasons).toEqual([
    { kind: "source_daily", source_id: upstream.sourceId },
  ])
  expect(result.skills[3]).toMatchObject({
    enabled: false,
    desired_delete: true,
    reasons: [
      { kind: "skill_daily" },
      { kind: "default_context" },
      { kind: "source_daily", source_id: upstream.sourceId },
    ],
  })
  expect(result.sources).toEqual([
    {
      source_id: upstream.sourceId,
      page_id: upstream.page,
      name: "Source 1",
      enabled: true,
      desired_delete: false,
    },
  ])
  expect(f.calls.every((call) => call.path.includes("/data_sources/"))).toBe(true)
  expect(f.mutations()).toEqual([])
  expect(f.downloads).toEqual([])
})

test("pagination spans 101 Sources, 185 assigned identities and 105 directly selected Skills", async () => {
  const f = fixture()
  const ids = Array.from({ length: 185 }, (_, n) => skill(f, n + 1, { daily: n < 105 }).skillId)
  for (let n = 0; n < 101; n++) source(f, n, n === 0 ? ids.slice(0, 85) : [ids[84 + n]!])
  const result = await f.run(loadCurrentDailySkills(library))
  expect(result.sources).toHaveLength(101)
  expect(result.skills).toHaveLength(185)
  expect(f.calls.filter((call) => call.path.startsWith(sourceQuery))).toHaveLength(2)
  expect(
    f.calls
      .filter((call) => call.path.startsWith(skillQuery))
      .some((call) => property(call.body).start_cursor !== undefined),
  ).toBe(true)
  expect(f.mutations()).toEqual([])
})

test("registered policy IDs survive display renaming and disabled Source choices remain visible", async () => {
  const f = fixture(),
    member = skill(f, 1),
    upstream = source(f, 1, [member.skillId], { enabled: false })
  f.rewrite((path, response) => {
    const value = f.schema(path, response)
    if (value.object !== "data_source") return value
    const fields = { ...property(value.properties) }
    delete fields["日用"]
    fields["Renamed daily"] = { id: dailyId, name: "Renamed daily", type: "checkbox", checkbox: {} }
    return { ...value, properties: fields }
  })
  const registered = {
    ...library,
    skills: { ...library.skills, property_ids: { ...library.skills.property_ids, 日用: dailyId } },
    sources: {
      ...library.sources,
      property_ids: { ...library.sources.property_ids, 日用: dailyId },
    },
  }
  const result = await f.run(loadCurrentDailySkills(registered))
  expect(result.skills).toHaveLength(1)
  expect(result.sources[0]).toMatchObject({ source_id: upstream.sourceId, enabled: false })
  expect(f.mutations()).toEqual([])
})

test("missing or ambiguous daily checkbox schema does not become an empty selection", async () => {
  for (const mode of ["missing", "ambiguous", "wrong-type"] as const) {
    const f = fixture()
    f.rewrite((path, response) => {
      const value = f.schema(path, response)
      if (value.object !== "data_source") return value
      const fields = { ...property(value.properties) }
      if (mode === "missing") delete fields["日用"]
      if (mode === "ambiguous")
        fields.duplicate = { id: "another-daily", name: "日用", type: "checkbox", checkbox: {} }
      if (mode === "wrong-type")
        fields["日用"] = { id: dailyId, name: "日用", type: "rich_text", rich_text: {} }
      return { ...value, properties: fields }
    })
    await expect(f.run(loadCurrentDailySkills(library))).rejects.toMatchObject({
      code: "CURRENT_DAILY_SELECTION_INVALID",
    })
    expect(f.calls.some((call) => call.path.includes("/query"))).toBe(false)
    expect(f.mutations()).toEqual([])
  }
})

test("partial enumeration, missing assigned targets and unfinished Source intents fail explicitly", async () => {
  for (const mode of ["partial", "missing", "applying"] as const) {
    const f = fixture()
    source(f, 1, ["skill-1"], { state: mode === "applying" ? "applying" : "ready" })
    if (mode !== "missing") skill(f, 1)
    if (mode === "partial")
      f.rewrite((path, response) =>
        path.startsWith(sourceQuery)
          ? { ...response, has_more: true, next_cursor: null }
          : f.schema(path, response),
      )
    await expect(f.run(loadCurrentDailySkills(library))).rejects.toMatchObject({
      code: "CURRENT_DAILY_SELECTION_INVALID",
    })
    expect(f.mutations()).toEqual([])
  }
})

test("duplicate stable daily Skill identity is rejected rather than silently deduplicated", async () => {
  const f = fixture()
  skill(f, 1, { daily: true, skillId: "duplicate" })
  skill(f, 2, { daily: true, skillId: "duplicate" })
  await expect(f.run(loadCurrentDailySkills(library))).rejects.toMatchObject({
    code: "CURRENT_DAILY_SELECTION_INVALID",
    message: expect.stringContaining("duplicated"),
  })
  expect(f.mutations()).toEqual([])
})
