import { expect, test } from "bun:test"
import { Effect } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { fail, property, text, SkillsError } from "../src/model.ts"
import { library as base, id } from "./shared-snapshot-fixture.ts"
import { registrationStore } from "./shared-source-registration-fixture.ts"
import { sourceDefinitionLayout, type SourceDefinitionInput } from "../src/shared-sources-model.ts"
import {
  bindSourceDefinition,
  decodeSourceDefinition,
  listSourceDefinitions,
  listSourceMembers,
  putSourceDefinition,
  readSourceDefinition,
  sourceDefinitionPropertiesFor,
  validateSourceDefinition,
} from "../src/shared-source-definitions.ts"
import { libraryFromDatabase, LIBRARY_MARKER } from "../src/shared-library.ts"

const layout = sourceDefinitionLayout(base.skills.data_source_id, base.records.data_source_id)
const sourceIds = Object.fromEntries(
  Object.keys(layout).map((name, index) => [name, name === "Name" ? "title" : `s${index}`]),
)
const library = {
  ...base,
  skills: {
    ...base.skills,
    property_ids: {
      ...base.skills.property_ids,
      Origin: "origin",
      "Source Member": "source_member",
    },
  },
  records: { ...base.records, property_ids: { ...base.records.property_ids, Origin: "origin" } },
  sources: { database_id: id(80), data_source_id: id(81), property_ids: sourceIds },
}
const input: SourceDefinitionInput = {
  version: 1,
  source_id: "source-definition-fixture",
  name: "Example",
  description: "Complete source",
  enabled: true,
  policy: "manual",
  adapter: { type: "git", url: "https://gitlab.com/group/project.git", ref: "main" },
  selection: { roots: ["skills"], include: [], exclude: [], mapping: {} },
  options: {},
}
const rich = (id: string, content: string) => ({
  id,
  type: "rich_text",
  rich_text: [{ type: "text", plain_text: content, text: { content } }],
})
function row(properties: Record<string, unknown>, page = id(82)) {
  const props: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(layout)) {
    const key = sourceIds[name]!,
      type = Object.keys(value)[0]!,
      v = property(properties[key])
    props[key] = {
      id: key,
      type,
      ...(Object.keys(v).length
        ? v
        : type === "rich_text"
          ? { rich_text: [] }
          : type === "title"
            ? { title: [] }
            : type === "relation"
              ? { relation: [], has_more: false }
              : type === "checkbox"
                ? { checkbox: false }
                : type === "select"
                  ? { select: null }
                  : { date: null }),
    }
  }
  return {
    object: "page",
    id: page,
    parent: {
      type: "data_source_id",
      data_source_id: library.sources.data_source_id,
      database_id: library.sources.database_id,
    },
    in_trash: false,
    properties: props,
  }
}
function fixture(initial: SourceDefinitionInput[] = [input], memberCount = 0) {
  const local = registrationStore(),
    rows = initial.map((x, i) => row(sourceDefinitionPropertiesFor(library, x), id(100 + i))),
    calls: Array<{ path: string; method: string; body: unknown }> = []
  const store: Store["Service"] = {
    ...local.store,
    listKeys: (prefix) =>
      Effect.sync(() => [...local.records.keys()].filter((key) => key.startsWith(prefix)).sort()),
  }
  let lose: "before" | "after" | undefined
  const skill = {
    object: "page",
    id: id(1),
    parent: { data_source_id: library.skills.data_source_id },
    in_trash: false,
    properties: {
      origin: { id: "origin", type: "relation", relation: [], has_more: false },
      source_member: rich("source_member", ""),
      source: rich("source", "fixed-pin-must-stay"),
    },
  }
  const api: Notion["Service"] = {
    credentialIdentity: Effect.succeed("controlled-credential"),
    version: Effect.succeed("test"),
    request: (path, body, opts) =>
      Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
        const method = opts?.method ?? (body ? "POST" : "GET")
        calls.push({ path, method, body })
        if (path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`)) {
          const all = Array.from({ length: memberCount }, (_, index) => ({
            object: "page",
            id: id(1000 + index),
            parent: { data_source_id: library.skills.data_source_id },
            in_trash: false,
            properties: {
              title: { id: "title", type: "title", title: [{ plain_text: `Member ${index}` }] },
              skill_id: rich("skill_id", `member-${index}`),
              kind: { id: "kind", type: "select", select: { name: "skill" } },
              enabled: { id: "enabled", type: "checkbox", checkbox: true },
              origin: {
                id: "origin",
                type: "relation",
                relation: [{ id: id(100) }],
                has_more: false,
              },
              source_member: rich("source_member", `skills/${index}`),
              source: rich("source", `bundle-${"a".repeat(64)}`),
            },
          }))
          const at = Number(property(body).start_cursor ?? 0),
            more = at + 100 < all.length
          return Effect.succeed({
            object: "list",
            results: all.slice(at, at + 100),
            has_more: more,
            next_cursor: more ? String(at + 100) : null,
          })
        }
        if (path.startsWith(`v1/data_sources/${library.sources.data_source_id}/query`)) {
          const requested = property(property(body).filter),
            match = property(requested.rich_text).equals
          const selected = rows.filter(
            (x) =>
              match === undefined ||
              text(property(x.properties[sourceIds["Source ID"]!]).rich_text) === match,
          )
          const at = Number(property(body).start_cursor ?? 0),
            parts = selected.slice(at, at + 100),
            more = at + 100 < selected.length
          return Effect.succeed({
            object: "list",
            results: structuredClone(parts),
            has_more: more,
            next_cursor: more ? String(at + 100) : null,
          })
        }
        const selected = rows.find((r) => path === `v1/pages/${r.id}`)
        if (method === "GET" && selected) return Effect.succeed(structuredClone(selected))
        if (path === `v1/pages/${skill.id}` && method === "GET")
          return Effect.succeed(structuredClone(skill))
        if (method === "POST" && path === "v1/pages") {
          if (lose === "before") {
            lose = undefined
            return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "controlled lost create"))
          }
          const created = row(property(property(body).properties), id(100 + rows.length))
          rows.push(created)
          if (lose === "after") {
            lose = undefined
            return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "controlled lost response"))
          }
          return Effect.succeed(structuredClone(created))
        }
        if (method === "PATCH" && (selected || path === `v1/pages/${skill.id}`)) {
          const target = selected ?? skill
          for (const [key, value] of Object.entries(property(property(body).properties)))
            property(target.properties)[key] = {
              ...property(property(target.properties)[key]),
              ...property(value),
            }
          if (lose === "after") {
            lose = undefined
            return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "controlled lost patch response"))
          }
          return Effect.succeed(structuredClone(target))
        }
        return Effect.fail(fail("UNEXPECTED_REQUEST", path))
      }),
  }
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(Notion, api),
        Effect.provideService(Store, store),
        Effect.provide(NodeServices.layer),
      ) as Effect.Effect<A, E, never>,
    )
  return {
    run,
    rows,
    calls,
    skill,
    local,
    api,
    lose: (mode: "before" | "after") => {
      lose = mode
    },
  }
}
test("Source definitions model GitLab as Git without provider-specific domain identity", () => {
  expect(validateSourceDefinition(input).adapter).toEqual(input.adapter)
  expect(sourceDefinitionPropertiesFor(library, input)[sourceIds.Provider!]).toEqual({
    select: { name: "git" },
  })
})
test("complete source definition roundtrip preserves selection and long transformation options", () => {
  const value = {
    ...input,
    options: {
      patch: {
        version: 1,
        files: [{ path: "SKILL.md", replacements: [{ from: "a".repeat(70000), to: "new" }] }],
      },
    },
  }
  expect(
    decodeSourceDefinition(library, row(sourceDefinitionPropertiesFor(library, value))),
  ).toEqual(value)
})
test("secrets, malformed selections, local paths and floating pinned refs are refused", () => {
  for (const value of [
    { ...input, options: { token: "secret" } },
    { ...input, adapter: { ...input.adapter, url: "file:///private/data" } },
    { ...input, policy: "pinned" },
    { ...input, selection: { ...input.selection, roots: ["../outside"] } },
    { ...input, adapter: { type: "git", url: "https://token@example.test/repo", ref: "main" } },
  ])
    expect(() => validateSourceDefinition(value)).toThrow()
})
test("four table descriptor preserves independent identities and registered relation fields", () => {
  const raw = {
    id: base.skills.database_id,
    description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(library) }],
  }
  expect(libraryFromDatabase(raw)?.sources?.database_id).toBe(id(80))
  expect(() =>
    libraryFromDatabase({
      ...raw,
      description: [
        {
          plain_text:
            LIBRARY_MARKER +
            JSON.stringify({
              ...library,
              sources: { ...library.sources, database_id: base.files.database_id },
            }),
        },
      ],
    }),
  ).toThrow("overlap")
})
test("source list paginates 101 definitions and projects no provider options or body data", async () => {
  const f = fixture(
    Array.from({ length: 101 }, (_, i) => ({ ...input, source_id: `definition-${i}` })),
  )
  expect(await f.run(listSourceDefinitions(library))).toHaveLength(101)
  expect(f.calls).toHaveLength(2)
  expect(f.calls.every((c) => !c.path.includes(`filter_properties=${sourceIds.Options}`))).toBe(
    true,
  )
})
test("duplicate native Source IDs never resolve by first row", async () => {
  const f = fixture([input, input])
  await expect(f.run(listSourceDefinitions(library))).rejects.toThrow("Repeated")
})
test("source show includes stable fingerprint and no Notion property names in the authority", async () => {
  const f = fixture()
  const value = await f.run(readSourceDefinition(library, input.source_id))
  expect(value.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  expect(value.adapter).toEqual(input.adapter)
  const renamed = Object.fromEntries(
    Object.entries(f.rows[0]!.properties).map(([k, v]) => ["renamed-" + k, v]),
  )
  f.rows[0]!.properties = renamed
  const same = await f.run(readSourceDefinition(library, id(100)))
  expect(same.fingerprint).toBe(value.fingerprint)
})
test("dry-run source creation does not allocate rows or dispatch receipts", async () => {
  const f = fixture([])
  expect(await f.run(putSourceDefinition(library, input, "absent", true))).toMatchObject({
    status: "planned",
    dry_run: true,
  })
  expect(f.rows).toHaveLength(0)
  expect(f.local.records.size).toBe(0)
})
test("put requires the exact expected fingerprint and leaves unrelated fields unchanged", async () => {
  const f = fixture()
  const before = await f.run(readSourceDefinition(library, id(100)))
  await expect(
    f.run(putSourceDefinition(library, { ...input, description: "new" }, "absent")),
  ).rejects.toThrow("expected")
  expect(
    await f.run(putSourceDefinition(library, { ...input, description: "new" }, before.fingerprint)),
  ).toMatchObject({ status: "applied", verified: true })
  expect(f.calls.filter((c) => c.method === "PATCH")).toHaveLength(1)
  expect(
    await f.run(putSourceDefinition(library, { ...input, description: "new" }, before.fingerprint)),
  ).toMatchObject({ status: "unchanged" })
})
test("unknown unobserved Source create is never automatically dispatched again", async () => {
  const f = fixture([])
  f.lose("before")
  await expect(f.run(putSourceDefinition(library, input, "absent"))).rejects.toThrow("verified")
  await expect(f.run(putSourceDefinition(library, input, "absent"))).rejects.toThrow("unresolved")
  expect(f.calls.filter((c) => c.path === "v1/pages")).toHaveLength(1)
})
test("visible create after unknown response is reused without rewriting original outcome", async () => {
  const f = fixture([])
  f.lose("after")
  await expect(f.run(putSourceDefinition(library, input, "absent"))).rejects.toThrow()
  expect(await f.run(putSourceDefinition(library, input, "absent"))).toMatchObject({
    status: "unchanged",
  })
  expect(f.calls.filter((c) => c.path === "v1/pages")).toHaveLength(1)
  expect(f.local.records.size).toBe(1)
})
test("binding changes only the origin/member relation and never the current content pin", async () => {
  const f = fixture()
  expect(
    await f.run(
      bindSourceDefinition(library, {
        source: input.source_id,
        target: id(1),
        member: "skills/demo",
        expected: "none",
      }),
    ),
  ).toMatchObject({ status: "applied" })
  expect(text(property(f.skill.properties.source).rich_text)).toBe("fixed-pin-must-stay")
  expect(
    Object.keys(
      property(property(f.calls.find((c) => c.method === "PATCH")!.body).properties),
    ).sort(),
  ).toEqual(["origin", "source_member"])
})
test("source scope rejects a page from another table", async () => {
  const f = fixture()
  f.rows[0]!.parent.data_source_id = base.skills.data_source_id
  await expect(f.run(readSourceDefinition(library, id(100)))).rejects.toThrow("another library")
})

test("a previously acknowledged update can be deliberately changed away and back without replaying unknown writes", async () => {
  const f = fixture()
  for (const description of ["version B", "version C", "version B"]) {
    const current = await f.run(readSourceDefinition(library, id(100)))
    expect(
      await f.run(putSourceDefinition(library, { ...input, description }, current.fingerprint)),
    ).toMatchObject({ status: "applied", verified: true })
  }
  expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(3)
  expect((await f.run(readSourceDefinition(library, id(100)))).description).toBe("version B")
})

test("changing create input cannot evade an unresolved request for the same Source ID", async () => {
  const f = fixture([])
  f.lose("before")
  await expect(f.run(putSourceDefinition(library, input, "absent"))).rejects.toThrow()
  await expect(
    f.run(putSourceDefinition(library, { ...input, description: "changed proposal" }, "absent")),
  ).rejects.toThrow("earlier unresolved")
  expect(f.calls.filter((call) => call.path === "v1/pages")).toHaveLength(1)
})

test("source member discovery reads all 101 forward relations without bodies or reverse-relation truncation", async () => {
  const f = fixture([input], 101)
  const result = await f.run(listSourceMembers(library, id(100)))
  expect(result.items).toHaveLength(101)
  expect(result.items[100]).toMatchObject({
    member: "skills/100",
    selected_version: `bundle-${"a".repeat(64)}`,
  })
  expect(
    f.calls.filter((call) =>
      call.path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`),
    ),
  ).toHaveLength(2)
  expect(f.calls.some((call) => call.path.includes("/markdown") || call.method === "PATCH")).toBe(
    false,
  )
})
