import { expect, test } from "bun:test"
import { Crypto, Effect, Layer } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { fail, property, text, type SkillsError } from "../src/model.ts"
import { sourceDefinitionPropertiesFor } from "../src/shared-source-definitions.ts"
import { sourceDefinitionLayout, type SourceDefinitionInput } from "../src/shared-sources-model.ts"
import {
  prepareSourceRemoval,
  prepareSourceConsolidation,
  executeLibraryManagement,
} from "../src/shared-library-management.ts"
import { registrationStore } from "./shared-source-registration-fixture.ts"
import { library as base, id } from "./shared-snapshot-fixture.ts"

const sourceLayout = sourceDefinitionLayout(base.skills.data_source_id, base.records.data_source_id)
const library = {
  ...base,
  skills: {
    ...base.skills,
    property_ids: {
      ...base.skills.property_ids,
      Origin: "origin",
      "Source Member": "member",
      Members: "members",
      Requires: "requires",
    },
  },
  records: { ...base.records, property_ids: { ...base.records.property_ids, Origin: "origin" } },
  sources: {
    database_id: id(80),
    data_source_id: id(81),
    property_ids: Object.fromEntries(Object.keys(sourceLayout).map((name) => [name, name])),
  },
}
const definition = (source: string, root: string, ref = "main"): SourceDefinitionInput => ({
  version: 1,
  source_id: source,
  name: "Old member title",
  description: "Retained source config",
  enabled: true,
  policy: "manual",
  adapter: { type: "git", url: "https://github.com/example/community.git", ref },
  selection: { roots: [root], include: [], exclude: [], mapping: {} },
  options: {},
})
type Table = "skills" | "files" | "records" | "sources"
const rich = (s: string) => ({ rich_text: [{ type: "text", text: { content: s } }] })
const rel = (...pages: string[]) => ({ relation: pages.map((id) => ({ id })), has_more: false })
function nativeField(key: string, raw: unknown) {
  const p = property(raw),
    type = Object.keys(p).find((key) => key !== "has_more")!
  return { id: key, type, ...p }
}
function fixture() {
  const local = registrationStore(),
    rows = new Map<string, Record<string, unknown>>()
  const calls: { method: string; path: string; body: unknown }[] = []
  let loss: "before" | "after" | undefined
  const add = (table: Table, page: string, supplied: Record<string, unknown> = {}) => {
    const properties: Record<string, unknown> = {}
    for (const [name, key] of Object.entries(library[table].property_ids)) {
      const value =
        supplied[name] ??
        (name === "Name"
          ? { title: [{ text: { content: page } }] }
          : ["Skill", "Origin", "Members", "Requires", "Skills", "Records"].includes(name)
            ? rel()
            : ["Enabled", "Default Context"].includes(name)
              ? { checkbox: name === "Enabled" }
              : name === "Tags"
                ? { multi_select: [] }
                : name === "Last Checked"
                  ? { date: null }
                  : ["Kind", "Status", "Provider", "Policy"].includes(name)
                    ? { select: { name: name === "Kind" ? "skill" : "ready" } }
                    : rich(""))
      properties[key] = nativeField(key, value)
    }
    const row = {
      object: "page",
      id: page,
      parent: { type: "data_source_id", data_source_id: library[table].data_source_id },
      in_trash: false,
      properties,
    }
    rows.set(page, row)
    return row
  }
  const source = (page: string, input: SourceDefinitionInput) => {
    const props = sourceDefinitionPropertiesFor(library, input)
    return add("sources", page, props)
  }
  source(id(100), definition("one", "skills/one"))
  source(id(101), definition("two", "skills/two"))
  source(id(102), definition("different-ref", "skills/three", "other"))
  add("skills", id(1), {
    "Skill ID": rich("skill-one"),
    "Main File ID": rich("file-main-one"),
    Origin: rel(id(100)),
    "Source Member": rich("skills/one"),
    Source: rich("pin-one"),
  })
  add("skills", id(2), {
    "Skill ID": rich("skill-two"),
    "Main File ID": rich("file-main-two"),
    Origin: rel(id(101)),
    "Source Member": rich("skills/two"),
    Source: rich("pin-two"),
  })
  add("skills", id(3), {
    "Skill ID": rich("outside"),
    "Main File ID": rich("outside-main"),
    Members: rel(id(1), id(2)),
  })
  add("files", id(200), {
    "File ID": rich("owned"),
    Skill: rel(id(1)),
    Path: rich("references/a.md"),
  })
  add("files", id(201), {
    "File ID": rich("other"),
    Skill: rel(id(2)),
    Path: rich("references/b.md"),
  })
  add("records", id(300), {
    "Record ID": rich("one-record"),
    Skill: rel(id(1)),
    Origin: rel(id(100)),
  })
  add("records", id(301), {
    "Record ID": rich("shared-record"),
    Skill: rel(id(1), id(2)),
    Origin: rel(id(100), id(101)),
  })
  const matches = (row: Record<string, unknown>, input: unknown): boolean => {
    if (input === undefined) return true
    const f = property(input)
    if (Array.isArray(f.or)) return f.or.some((part) => matches(row, part))
    if (Array.isArray(f.and)) return f.and.every((part) => matches(row, part))
    const field = property(property(row.properties)[String(f.property)])
    if (f.relation)
      return (
        Array.isArray(field.relation) &&
        field.relation.some((value) => property(value).id === property(f.relation).contains)
      )
    if (f.rich_text) return text(field.rich_text) === property(f.rich_text).equals
    throw new Error("Unexpected fixture filter")
  }
  const api: Notion["Service"] = {
    credentialIdentity: Effect.succeed("management-owner"),
    version: Effect.succeed("controlled"),
    request: (path, body, options) =>
      Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
        const method = options?.method ?? (body === undefined ? "GET" : "POST")
        calls.push({ path, body, method })
        const url = new URL(path, "https://api.notion.test")
        if (url.pathname === "/v1/users/me") return Effect.succeed({ object: "user", id: id(999) })
        const query = /^\/v1\/data_sources\/([^/]+)\/query$/u.exec(url.pathname)
        if (query) {
          const all = [...rows.values()].filter(
            (row) =>
              property(row.parent).data_source_id === query[1] &&
              !row.in_trash &&
              matches(row, property(body).filter),
          )
          const offset = Number(property(body).start_cursor ?? 0),
            page = all.slice(offset, offset + 2)
          return Effect.succeed({
            object: "list",
            results: structuredClone(page),
            has_more: offset + 2 < all.length,
            next_cursor: offset + 2 < all.length ? String(offset + 2) : null,
          })
        }
        const selected = rows.get(url.pathname.replace(/^\/v1\/pages\//u, ""))
        if (selected && method === "GET") return Effect.succeed(structuredClone(selected))
        if (selected && method === "PATCH") {
          const lost = loss
          loss = undefined
          if (lost !== "before") {
            if (property(body).in_trash === true) selected.in_trash = true
            for (const [key, raw] of Object.entries(property(property(body).properties)))
              property(selected.properties)[key] = nativeField(key, raw)
          }
          return lost
            ? Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Lost original response"))
            : Effect.succeed(structuredClone(selected))
        }
        return Effect.fail(fail("UNEXPECTED_REQUEST", path))
      }),
  }
  const store: Store["Service"] = {
    ...local.store,
    reserveCacheGeneration: (() => {
      const generations = new Map<string, number>()
      return (scope: string, identity: string) =>
        Effect.sync(() => {
          const key = scope + ":" + identity,
            next = (generations.get(key) ?? 0) + 1
          generations.set(key, next)
          return next
        })
    })(),
    listKeys: (prefix) =>
      Effect.succeed([...local.records.keys()].filter((key) => key.startsWith(prefix))),
  }
  const layer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(Notion, api),
    Layer.succeed(Store, store),
  )
  const run = <A, E>(effect: Effect.Effect<A, E, Notion | Store | Crypto.Crypto>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))
  return {
    add,
    source,
    rows,
    calls,
    local,
    run,
    writes: () => calls.filter((call) => call.method === "PATCH"),
    lose: (mode: "before" | "after") => {
      loss = mode
    },
  }
}
test("whole-source removal selects exact owners, preserves shared rows and is repeatable without growth", async () => {
  const f = fixture(),
    plan = await f.run(prepareSourceRemoval(library, "one"))
  expect(plan.summary.counts).toEqual({ skills: 1, files: 1, records: 2, sources: 1 })
  expect(f.writes()).toHaveLength(0)
  expect((await f.run(executeLibraryManagement(library, plan, true))).status).toBe("planned")
  const result = await f.run(executeLibraryManagement(library, plan))
  expect(result).toMatchObject({ status: "applied", verified: true })
  for (const page of [id(1), id(200), id(300), id(100)])
    expect(f.rows.get(page)?.in_trash).toBe(true)
  for (const page of [id(2), id(201), id(301), id(101)])
    expect(f.rows.get(page)?.in_trash).toBe(false)
  expect(
    property(property(f.rows.get(id(301))?.properties)[base.records.property_ids.Skill!]).relation,
  ).toEqual([{ id: id(2) }])
  const writes = f.writes().length
  expect((await f.run(executeLibraryManagement(library, plan))).status).toBe("unchanged")
  expect(f.writes()).toHaveLength(writes)
  const invalidations = [...f.local.records.values()]
    .map(property)
    .filter((value) => value.invalidated === true)
  expect(invalidations.some((value) => String(value.record_identity).endsWith(":skill-one"))).toBe(
    true,
  )
  expect(invalidations.some((value) => String(value.record_identity).endsWith(":skill-two"))).toBe(
    false,
  )
})
test("outside prerequisites and newly bound members stop deletion before any write", async () => {
  const f = fixture()
  property(f.rows.get(id(3))?.properties).requires = nativeField("requires", rel(id(1)))
  await expect(f.run(prepareSourceRemoval(library, "one"))).rejects.toMatchObject({
    code: "SOURCE_REMOVE_REQUIRED",
  })
  expect(f.writes()).toHaveLength(0)
  property(f.rows.get(id(3))?.properties).requires = nativeField("requires", rel())
  const plan = await f.run(prepareSourceRemoval(library, "one"))
  f.add("skills", id(4), {
    "Skill ID": rich("new"),
    "Main File ID": rich("new-main"),
    Origin: rel(id(100)),
  })
  await expect(f.run(executeLibraryManagement(library, plan))).rejects.toMatchObject({
    code: "LIBRARY_MANAGEMENT_CHANGED",
  })
  expect(f.writes()).toHaveLength(0)
})
test.each(["before", "after"] as const)(
  "a lost %s mutation is not blindly dispatched twice",
  async (mode) => {
    const f = fixture(),
      plan = await f.run(prepareSourceRemoval(library, "one"))
    f.lose(mode)
    await expect(f.run(executeLibraryManagement(library, plan))).rejects.toMatchObject({
      code: "SOURCE_WRITE_UNKNOWN",
    })
    const first = f.writes()[0]!
    if (mode === "before")
      await expect(f.run(executeLibraryManagement(library, plan))).rejects.toMatchObject({
        code: "SOURCE_WRITE_UNKNOWN",
      })
    else expect((await f.run(executeLibraryManagement(library, plan))).verified).toBe(true)
    expect(f.writes().filter((call) => call.path === first.path)).toHaveLength(1)
  },
)
test("consolidation unions roots and retargets Origin only, preserving pins and different configurations", async () => {
  const f = fixture(),
    plan = await f.run(prepareSourceConsolidation(library, "one", "nowledge"))
  expect(plan.summary.source_count_before).toBe(2)
  expect(plan.summary.roots).toEqual(["skills/one", "skills/two"])
  const pins = [id(1), id(2)].map((page) =>
    property(property(f.rows.get(page)?.properties)[base.skills.property_ids.Source!]),
  )
  expect((await f.run(executeLibraryManagement(library, plan))).verified).toBe(true)
  expect(f.rows.get(id(101))?.in_trash).toBe(true)
  expect(f.rows.get(id(102))?.in_trash).toBe(false)
  for (const [index, page] of [id(1), id(2)].entries()) {
    expect(
      property(property(f.rows.get(page)?.properties)[library.skills.property_ids.Origin]).relation,
    ).toEqual([{ id: id(100) }])
    expect(
      property(property(f.rows.get(page)?.properties)[base.skills.property_ids.Source!]),
    ).toEqual(pins[index]!)
  }
  expect(text(property(property(f.rows.get(id(100))?.properties).Name).title)).toBe("nowledge")
  const repeated = await f.run(prepareSourceConsolidation(library, "one", "nowledge"))
  expect(repeated.actions).toHaveLength(0)
})

test("the same repository with a different transformation remains a separate Source", async () => {
  const f = fixture(),
    plain = definition("patched", "skills/custom")
  f.source(id(103), { ...plain, options: { target_mode: "auto" } })
  const plan = await f.run(prepareSourceConsolidation(library, "one", "community"))
  expect(plan.source_pages).toEqual([id(100), id(101)])
  expect(plan.actions.some((action) => action.page_id === id(103))).toBe(false)
})

test("post-completion orphan relations are reported without expanding an old removal", async () => {
  const f = fixture(),
    plan = await f.run(prepareSourceRemoval(library, "one"))
  await f.run(executeLibraryManagement(library, plan))
  const count = f.writes().length
  f.add("files", id(250), { "File ID": rich("later"), Skill: rel(id(1)), Path: rich("later.md") })
  await expect(f.run(executeLibraryManagement(library, plan))).rejects.toMatchObject({
    code: "LIBRARY_MANAGEMENT_CHANGED",
  })
  expect(f.writes()).toHaveLength(count)
  expect(f.rows.get(id(250))?.in_trash).toBe(false)
})
