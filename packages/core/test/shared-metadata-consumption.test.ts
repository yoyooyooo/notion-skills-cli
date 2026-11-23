import { describe, expect, test } from "bun:test"
import { Effect, type Crypto, type FileSystem, type Path } from "effect"
import type { HttpClient } from "effect/http"
import { catalog } from "../src/catalog.ts"
import { fail, property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { fileRef } from "../src/ref.ts"
import { LIBRARY_MARKER } from "../src/shared-library-model.ts"
import { readSkill } from "../src/snapshot.ts"
import { Store } from "../src/store.ts"
import {
  currentBytes as encode,
  currentId as id,
  currentLibrary as library,
  currentRich as rich,
  currentSnapshotFixture,
  currentSkillPage as skillPage,
} from "./shared-current-fixture.ts"

const owner = "skill://demo?library=library-current"
const rootRef = fileRef(owner, "SKILL.md")
const options = { database: library.skills.database_id }
const fields = ["title", "description", "kind", "skill-id", "enabled", "default"]
const claimFields = [
  ...fields,
  "main-id",
  "content",
  "state",
  "operation",
  "origin",
  "members",
  "requires",
]
const skillQuery = "/v1/data_sources/" + library.skills.data_source_id + "/query"
const pageUrl = (page: string) => "https://www.notion.so/" + page.replaceAll("-", "")
type Services =
  | Store
  | Notion
  | Crypto.Crypto
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
type MetadataPage = {
  object: string
  results: readonly unknown[]
  has_more: boolean
  next_cursor: string | null
  request_status?: { type: "complete" | "incomplete"; incomplete_reason?: string }
}
type Query = {
  filtered: boolean
  cursor: string | undefined
  fields: readonly string[]
  body: unknown
  response: MetadataPage
  responseBytes: number
}

/** Skills identity filters run before pagination; only declared related-page
 * metadata is added. Bodies, Files and current-owner reads keep the core boundary. */
function fixture(count = 2, relations = false) {
  const base = currentSnapshotFixture({ fileCount: 0 })
  const registered = relations
    ? {
        ...library,
        skills: {
          ...library.skills,
          property_ids: {
            ...library.skills.property_ids,
            Members: "members",
            Requires: "requires",
          },
        },
      }
    : library
  const rows: Record<string, unknown>[] = [base.main]
  for (let index = 1; index < count; index++)
    rows.push({
      ...structuredClone(base.main),
      id: id(1000 + index),
      properties: {
        ...structuredClone(property(base.main.properties)),
        Name: { id: "title", type: "title", title: [{ plain_text: "Other " + index }] },
        Description: rich("description", "Metadata for other " + index),
        "Skill ID": rich("skill-id", "other-" + index),
      },
    })
  const externalPage = String(rows.at(-1)!.id)
  if (relations) {
    const properties = property(base.main.properties)
    properties.members = {
      id: "members",
      type: "relation",
      relation: [{ id: String(rows[1]!.id) }],
      has_more: false,
    }
    properties.requires = {
      id: "requires",
      type: "relation",
      relation: [{ id: externalPage }],
      has_more: false,
    }
  }
  base.bodies.set(
    skillPage,
    "[Self](" +
      pageUrl(skillPage) +
      ")\n" +
      (count === 1 ? "" : "[External](" + pageUrl(externalPage) + ")\n"),
  )
  const requests: Array<{ path: string; method: string; body: unknown }> = []
  const queries: Query[] = []
  const controls: {
    credential: string
    denySelectedGet?: boolean
    beforeSelectedGet?: () => void
    reply?: (input: {
      filtered: boolean
      cursor: string | undefined
      projected: readonly unknown[]
      response: MetadataPage
    }) => MetadataPage
  } = { credential: "scalar-metadata-credential" }
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
    base.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* effect.pipe(
          Effect.provideService(Notion, {
            ...api,
            credentialIdentity: Effect.sync(() => controls.credential),
            connectionIdentity: Effect.sync(() => ({
              principal: "current-principal",
              credential: controls.credential,
              connection: "current-fixture",
              workspace: null,
              api_origin: "https://api.notion.com",
            })),
            request: (path, body, requestOptions) =>
              Effect.suspend(() => {
                const url = new URL(path, "https://fixture.invalid/")
                const method = requestOptions?.method ?? (body === undefined ? "GET" : "POST")
                requests.push({ path, method, body: structuredClone(body) })
                if (relations && url.pathname === "/v1/databases/" + library.skills.database_id)
                  return api.request(path, body, requestOptions).pipe(
                    Effect.map((value) => ({
                      ...property(value),
                      description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(registered) }],
                    })),
                  )
                if (url.pathname === skillQuery) {
                  const filter = property(body).filter
                  const parts = Array.isArray(property(filter).or)
                    ? (property(filter).or as unknown[])
                    : [filter]
                  const identities =
                    filter === undefined
                      ? undefined
                      : new Set(
                          parts.map((raw) => {
                            const part = property(raw),
                              value = property(part.rich_text).equals
                            if (
                              part.property !== registered.skills.property_ids["Skill ID"] ||
                              typeof value !== "string"
                            )
                              throw fail(
                                "UNEXPECTED_REQUEST",
                                "The fixture requires exact registered Skill ID filters.",
                              )
                            return value
                          }),
                        )
                  const selectedFields = url.searchParams.getAll("filter_properties")
                  const selected = new Set(selectedFields)
                  const projected = rows
                    .filter(
                      (row) =>
                        identities === undefined ||
                        identities.has(
                          text(property(property(row.properties)["Skill ID"]).rich_text),
                        ),
                    )
                    .map((row) => ({
                      ...structuredClone(row),
                      properties: Object.fromEntries(
                        Object.entries(property(row.properties)).filter(([, value]) =>
                          selected.has(String(property(value).id)),
                        ),
                      ),
                    }))
                  const input = property(body)
                  const cursor =
                    typeof input.start_cursor === "string" ? input.start_cursor : undefined
                  if (cursor !== undefined && !/^offset-[0-9]+$/u.test(cursor))
                    return Effect.die(new Error("Unexpected controlled metadata cursor"))
                  const offset = cursor === undefined ? 0 : Number(cursor.slice("offset-".length))
                  const end = Math.min(offset + 100, projected.length)
                  const ordinary: MetadataPage = {
                    object: "list",
                    results: projected.slice(offset, end),
                    has_more: end < projected.length,
                    next_cursor: end < projected.length ? "offset-" + end : null,
                  }
                  const response =
                    controls.reply?.({
                      filtered: filter !== undefined,
                      cursor,
                      projected,
                      response: ordinary,
                    }) ?? ordinary
                  queries.push({
                    filtered: filter !== undefined,
                    cursor,
                    fields: selectedFields,
                    body: structuredClone(body),
                    response: structuredClone(response),
                    responseBytes: encode(JSON.stringify(response)).byteLength,
                  })
                  return Effect.succeed(structuredClone(response))
                }
                if (url.pathname === "/v1/pages/" + skillPage && method === "GET") {
                  if (controls.denySelectedGet)
                    return Effect.fail(
                      fail("ACCESS_DENIED", "Selected current page is no longer authorized."),
                    )
                  const update = controls.beforeSelectedGet
                  controls.beforeSelectedGet = undefined
                  update?.()
                } else if (method === "GET" && /^\/v1\/pages\/[^/]+$/u.test(url.pathname)) {
                  const row = rows.find((row) => url.pathname === "/v1/pages/" + row.id)
                  return row === undefined
                    ? Effect.fail(
                        fail("NOT_FOUND", "The declared relation target is unavailable.", { path }),
                      )
                    : Effect.succeed(structuredClone(row))
                }
                return api.request(path, body, requestOptions)
              }),
          }),
        )
      }),
    )
  return { base, rows, externalPage, requests, queries, controls, run }
}

function rootGets(f: ReturnType<typeof fixture>) {
  return f.requests.filter(
    (request) =>
      request.method === "GET" &&
      new URL(request.path, "https://fixture.invalid/").pathname === "/v1/pages/" + skillPage,
  )
}

function bodies(f: ReturnType<typeof fixture>) {
  return f.requests
    .filter((request) =>
      /\/markdown$/u.test(new URL(request.path, "https://fixture.invalid/").pathname),
    )
    .map((request) => new URL(request.path, "https://fixture.invalid/").pathname)
}

function privateKeys(value: unknown, at = ""): string[] {
  if (Array.isArray(value))
    return value.flatMap((item, index) => privateKeys(item, at + "/" + index))
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => [
    ...(["sharedSkills", "skillsMetadata", "inventory", "rawPage", "pages", "properties"].includes(
      key,
    )
      ? [at + "/" + key]
      : []),
    ...privateKeys(child, at + "/" + key),
  ])
}

describe("scalar current metadata consumption", () => {
  for (const count of [3, 101])
    test(
      "a logical read keeps exact relation claims separate from its " +
        count +
        "-row native reference inventory",
      async () => {
        const f = fixture(count, true)
        const result = await f.run(readSkill(rootRef, options))
        const logicalQueries = f.queries.length
        const logicalBodies = bodies(f)
        const snapshot = f.base.json.get("snapshots/" + result.snapshot_id + ".json")
        const physical = await f.run(readSkill(skillPage, { ...options, refresh: true }))
        // The selected content is identical, but effects belong to each call.
        expect({ ...result, freshness: undefined, effects: undefined }).toEqual({
          ...physical,
          freshness: undefined,
          effects: undefined,
        })
        expect(result.effects).toEqual({
          version: 1,
          remote_writes: "none",
          author_content: "unchanged",
        })
        expect(physical.effects).toEqual({
          version: 1,
          remote_writes: "none",
          author_content: "unchanged",
        })
        expect(f.base.json.get("snapshots/" + physical.snapshot_id + ".json")).toEqual(snapshot)
        expect(result.members?.map((entry) => entry.id)).toEqual([
          "skill://other-1?library=library-current",
        ])
        expect(result.required?.map((entry) => entry.id)).toEqual([
          `skill://other-${count - 1}?library=library-current`,
        ])
        expect(logicalBodies).toEqual(["/v1/pages/" + skillPage + "/markdown"])
        expect(bodies(f).every((path) => path === "/v1/pages/" + skillPage + "/markdown")).toBe(
          true,
        )
        expect(rootGets(f)).toHaveLength(4)
        expect(privateKeys(result)).toEqual([])
        expect(
          f.queries
            .slice(0, logicalQueries)
            .every(
              (query) =>
                JSON.stringify(query.fields) ===
                JSON.stringify(query.filtered ? claimFields : fields),
            ),
        ).toBe(true)
        expect(logicalQueries).toBe(3 + Math.ceil(count / 100))
        expect(f.queries.length - logicalQueries).toBe(2 + Math.ceil(count / 100))
      },
    )

  test("relation metadata refresh is a new observation while the old fixed pin stays frozen", async () => {
    const f = fixture(3, true)
    const first = await f.run(readSkill(rootRef, options))
    const before = f.queries.length
    property(f.rows[1]!.properties)["Description"] = rich("description", "Updated Member metadata")
    property(f.rows[2]!.properties)["Description"] = rich(
      "description",
      "Updated Requires metadata",
    )
    const second = await f.run(readSkill(rootRef, { ...options, refresh: true }))
    expect(second.scope).toBe(first.scope)
    expect(second.snapshot_id).toBe(first.snapshot_id)
    expect(property(second.members?.[0]?.metadata).description).toBe("Updated Member metadata")
    expect(property(second.required?.[0]?.metadata).description).toBe("Updated Requires metadata")
    const afterRefresh = f.requests.length
    const fixed = await f.run(readSkill(first.ref, { ...options, offline: true }))
    if (!("content" in first) || !("content" in fixed))
      throw new Error("Scalar text reads must return complete content")
    expect(fixed.content).toBe(first.content)
    expect(fixed.members).toEqual(first.members)
    expect(fixed.required).toEqual(first.required)
    expect(fixed.snapshot_id).toBe(first.snapshot_id)
    expect(f.requests).toHaveLength(afterRefresh)
    expect(f.queries.length - before).toBe(4)
  })

  test("a fresh inventory never replaces the selected page permission check", async () => {
    const f = fixture(3, true)
    f.controls.denySelectedGet = true
    const result = await f.run(readSkill(rootRef, options).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.code).toBe("ACCESS_DENIED")
    expect(f.queries).toHaveLength(1)
    expect(rootGets(f)).toHaveLength(1)
    expect(bodies(f)).toEqual([])
    expect(f.base.semanticWrites().length).toBe(0)
  })

  test("a relation target absent from the complete observation cannot become an empty relation", async () => {
    const f = fixture(3, true)
    f.rows.pop()
    const result = await f.run(readSkill(rootRef, options).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure.code).toBe("SHARED_ROUTER_MEMBER_UNAVAILABLE")
      expect(property(result.failure.details).field).toBe("Requires")
      expect(property(result.failure.details).reason).toBeUndefined()
      expect(result.failure.message).toContain("Requires")
    }
    expect(bodies(f)).toEqual([])
    expect(f.base.semanticWrites().length).toBe(0)
    expect(f.queries).toHaveLength(2)
  })

  for (const relation of ["Members", "Requires"] as const)
    test(
      "disabled " + relation + " metadata reports the selected field without reading bodies",
      async () => {
        const f = fixture(3, true)
        const target = f.rows[relation === "Members" ? 1 : 2]!
        property(property(target.properties).Enabled).checkbox = false
        const result = await f.run(readSkill(rootRef, options).pipe(Effect.result))
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure.code).toBe("SHARED_ROUTER_MEMBER_UNAVAILABLE")
          expect(property(result.failure.details)).toMatchObject({
            field: relation,
            page_id: target.id,
            reason: "disabled",
          })
          expect(result.failure.message).toBe(`A selected ${relation} target is disabled.`)
        }
        expect(bodies(f)).toEqual([])
        expect(f.base.semanticWrites()).toEqual([])
        expect(f.queries).toHaveLength(relation === "Members" ? 2 : 3)
      },
    )

  test("incomplete current relations still fail even after a complete inventory", async () => {
    const f = fixture(3, true)
    property(property(f.base.main.properties).requires).has_more = true
    const result = await f.run(readSkill(rootRef, options).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    expect(f.requests.some((request) => request.path.includes("/properties/requires"))).toBe(true)
    expect(bodies(f)).toEqual([])
    expect(f.base.semanticWrites().length).toBe(0)
    expect(f.queries).toHaveLength(2)
  })

  for (const count of [1, 10, 100, 101, 300])
    test(
      "a cold logical read keeps identity and native reference inventory distinct in a " +
        count +
        "-Skill library",
      async () => {
        const f = fixture(count)
        const result = await f.run(readSkill(rootRef, options))
        expect(result.record.id).toBe(owner)
        expect(rootGets(f)).toHaveLength(2)
        expect(bodies(f)).toEqual(["/v1/pages/" + skillPage + "/markdown"])
        const claims = f.queries.filter((query) => query.filtered)
        const inventory = f.queries.filter((query) => !query.filtered)
        expect(claims).toHaveLength(1)
        expect(claims[0]!.response.results).toHaveLength(1)
        expect(claims[0]!.fields).toEqual(claimFields)
        expect(property(claims[0]!.body).filter).toEqual({
          property: "skill-id",
          rich_text: { equals: "demo" },
        })
        expect(inventory).toHaveLength(count === 1 ? 0 : Math.ceil(count / 100))
        expect(inventory.map((query) => query.cursor ?? null)).toEqual(
          Array.from({ length: count === 1 ? 0 : Math.ceil(count / 100) }, (_, index) =>
            index === 0 ? null : "offset-" + index * 100,
          ),
        )
        for (const query of inventory) {
          expect(query.fields).toEqual(fields)
          expect(property(query.body).page_size).toBe(100)
          expect(property(query.body).filter).toBeUndefined()
          expect(query.responseBytes).toBeGreaterThan(0)
          for (const row of query.response.results)
            expect(
              Object.values(property(property(row).properties))
                .map((field) => property(field).id)
                .sort(),
            ).toEqual([...fields].sort())
        }
        const entries = result.native_references?.entries ?? []
        expect(entries.find((entry) => entry.page_id === skillPage)?.id).toBe(owner)
        if (count > 1)
          expect(entries.find((entry) => entry.page_id === f.externalPage)).toMatchObject({
            id: `skill://other-${count - 1}?library=library-current`,
            name: "Other " + (count - 1),
            availability: "available",
          })
        expect(result.native_references?.unresolved).toEqual([])
        expect(privateKeys(result)).toEqual([])
      },
    )

  test("disabled external Skills remain in the complete observation without target body reads", async () => {
    const f = fixture()
    property(f.rows[1]!.properties)["Enabled"] = {
      id: "enabled",
      type: "checkbox",
      checkbox: false,
    }
    const result = await f.run(readSkill(rootRef, options))
    expect(
      result.native_references?.entries.find((entry) => entry.page_id === f.externalPage),
    ).toMatchObject({
      id: "skill://other-1?library=library-current",
      availability: "disabled",
    })
    expect(result.native_references?.unresolved).toEqual([])
    expect(f.queries).toHaveLength(2)
    expect(bodies(f)).toEqual(["/v1/pages/" + skillPage + "/markdown"])
    expect([...f.base.json.keys()].filter((key) => key.startsWith("cache/catalogs/"))).toEqual([])
    const complete = await f.run(catalog({ ...options, refresh: true }))
    expect(complete.records).toEqual([expect.objectContaining({ id: owner })])
    const cached = [...f.base.json.entries()].find(([key]) =>
      key.startsWith("cache/catalogs/"),
    )?.[1]
    expect(property(cached).records).toEqual([expect.objectContaining({ id: owner })])
  })

  test("an absent external page remains unavailable without fetching that page or its body", async () => {
    const f = fixture(1)
    const unknown = id(9000)
    f.base.bodies.set(skillPage, "[Unavailable](" + pageUrl(unknown) + ")\n")
    const result = await f.run(readSkill(rootRef, options))
    expect(result.native_references?.entries).toEqual([])
    expect(result.native_references?.unresolved).toEqual([
      expect.objectContaining({ page_id: unknown, availability: "unmanaged_or_unavailable" }),
    ])
    expect(f.queries).toHaveLength(2)
    expect(f.requests.some((request) => request.path.includes(unknown))).toBe(false)
  })

  test("an empty intermediate page is exhausted before the referenced final-page target is resolved", async () => {
    const f = fixture()
    f.controls.reply = ({ filtered, cursor, projected, response }) =>
      filtered
        ? response
        : cursor === undefined
          ? { object: "list", results: [projected[0]], has_more: true, next_cursor: "offset-100" }
          : cursor === "offset-100"
            ? { object: "list", results: [], has_more: true, next_cursor: "offset-200" }
            : { object: "list", results: [projected[1]], has_more: false, next_cursor: null }
    const result = await f.run(readSkill(rootRef, options))
    expect(
      result.native_references?.entries.some((entry) => entry.page_id === f.externalPage),
    ).toBe(true)
    expect(f.queries.filter((query) => query.filtered)).toHaveLength(1)
    expect(
      f.queries.filter((query) => !query.filtered).map((query) => query.cursor ?? null),
    ).toEqual([null, "offset-100", "offset-200"])
  })

  test("reexecuting a refresh effect observes changed target metadata and authorization independently", async () => {
    const f = fixture()
    const read = readSkill(rootRef, { ...options, refresh: true })
    const first = await f.run(read)
    const before = f.queries.length
    property(f.rows[1]!.properties)["Description"] = rich("description", "New target metadata")
    f.controls.credential = "another-scalar-credential"
    const second = await f.run(read)
    expect(second.scope).not.toBe(first.scope)
    expect(
      second.native_references?.entries.find((entry) => entry.page_id === f.externalPage)
        ?.description,
    ).toBe("New target metadata")
    expect(f.queries.length - before).toBe(2)
    expect(rootGets(f)).toHaveLength(4)
  })

  test("a later same-scope refresh does not treat the previous invocation's observation as current", async () => {
    const f = fixture()
    const read = readSkill(rootRef, { ...options, refresh: true })
    const first = await f.run(read)
    const before = f.queries.length
    property(f.rows[1]!.properties)["Enabled"] = {
      id: "enabled",
      type: "checkbox",
      checkbox: false,
    }
    const second = await f.run(read)
    expect(second.scope).toBe(first.scope)
    expect(
      second.native_references?.entries.find((entry) => entry.page_id === f.externalPage)
        ?.availability,
    ).toBe("disabled")
    expect(f.queries.length - before).toBe(2)
  })

  test("the full current root GET owns self-link metadata after catalog Name and Description change", async () => {
    const f = fixture()
    f.controls.beforeSelectedGet = () => {
      property(f.base.main.properties)["Name"] = {
        id: "title",
        type: "title",
        title: [{ plain_text: "Fresh root name" }],
      }
      property(f.base.main.properties)["Description"] = rich(
        "description",
        "Fresh root description",
      )
    }
    const result = await f.run(readSkill(rootRef, options))
    expect(result.record.name).toBe("Fresh root name")
    expect(result.record.description).toBe("Fresh root description")
    expect(
      result.native_references?.entries.find((entry) => entry.page_id === skillPage),
    ).toMatchObject({
      id: owner,
      name: "Fresh root name",
      description: "Fresh root description",
    })
    expect(
      result.native_references?.entries.some((entry) => entry.page_id === f.externalPage),
    ).toBe(true)
    expect(rootGets(f)).toHaveLength(2)
  })

  test("a logical Skill ID changing between catalog resolution and the full root GET is rejected before bodies", async () => {
    const f = fixture()
    f.controls.beforeSelectedGet = () => {
      property(f.base.main.properties)["Skill ID"] = rich("skill-id", "replacement-identity")
    }
    const result = await f.run(readSkill(rootRef, options).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    expect(bodies(f)).toEqual([])
    expect(f.base.semanticWrites().length).toBe(0)
  })

  test("an exact page selector still reads that page's current logical identity", async () => {
    const f = fixture()
    f.controls.beforeSelectedGet = () => {
      property(f.base.main.properties)["Skill ID"] = rich("skill-id", "replacement-identity")
    }
    const result = await f.run(readSkill(skillPage, options))
    expect(result.record.id).toBe("skill://replacement-identity?library=library-current")
    expect(rootGets(f)).toHaveLength(2)
  })

  test("the current root remains an identity claimant when a native inventory omits its row", async () => {
    const f = fixture()
    property(f.rows[1]!.properties)["Skill ID"] = rich("skill-id", "demo")
    f.controls.reply = ({ response }) => ({
      ...response,
      results: response.results.filter((row) => property(row).id !== skillPage),
    })
    const result = await f.run(readSkill(skillPage, options).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.code).toBe("SHARED_SKILL_ID_CONFLICT")
    expect(f.queries).toHaveLength(1)
    expect(rootGets(f)).toHaveLength(1)
    expect(bodies(f)).toEqual(["/v1/pages/" + skillPage + "/markdown"])
  })

  test("public catalog results and persisted catalogs never contain raw metadata observations", async () => {
    const f = fixture()
    const result = await f.run(catalog({ ...options, refresh: true }))
    expect(result.records).toHaveLength(2)
    expect(privateKeys(result)).toEqual([])
    const persisted = [...f.base.json.entries()].filter(([key]) =>
      key.startsWith("cache/catalogs/"),
    )
    expect(persisted).toHaveLength(1)
    for (const [, value] of persisted) expect(privateKeys(value)).toEqual([])
    expect(rootGets(f)).toHaveLength(0)
    expect(bodies(f)).toEqual([])
  })

  for (const fault of ["object", "status", "terminal-cursor", "repeating-cursor"] as const)
    test("a malformed " + fault + " inventory fails before current body observation", async () => {
      const f = fixture()
      f.controls.reply = ({ response }) => ({
        ...response,
        ...(fault === "object" ? { object: "page" } : {}),
        ...(fault === "status"
          ? {
              request_status: {
                type: "incomplete",
                incomplete_reason: "query_result_limit_reached",
              } as const,
            }
          : {}),
        ...(fault === "terminal-cursor" ? { next_cursor: "offset-100" } : {}),
        ...(fault === "repeating-cursor" ? { has_more: true, next_cursor: "offset-100" } : {}),
      })
      const result = await f.run(readSkill(rootRef, options).pipe(Effect.result))
      expect(result._tag).toBe("Failure")
      expect(bodies(f)).toEqual([])
      expect(f.base.semanticWrites().length).toBe(0)
    })

  for (const fault of ["foreign-parent", "repeated-page", "disabled-identity-claim"] as const)
    test(
      "complete catalog admission rejects " + fault + " before using its observation",
      async () => {
        const f = fixture()
        if (fault === "foreign-parent")
          property(f.rows[1]!.parent).data_source_id = library.files.data_source_id
        else if (fault === "repeated-page") f.rows.push(structuredClone(f.rows[1]!))
        else {
          const duplicate = structuredClone(f.rows[1]!)
          duplicate.id = id(8000)
          property(duplicate.properties)["Enabled"] = {
            id: "enabled",
            type: "checkbox",
            checkbox: false,
          }
          f.rows.push(duplicate)
        }
        // Explicit catalog admission retains its complete-library contract.
        // Exact stable reads no longer need that discovery step merely to select a root.
        const result = await f.run(catalog({ ...options, refresh: true }).pipe(Effect.result))
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure")
          expect(["INVALID_SHARED_SKILL", "SHARED_SKILL_ID_CONFLICT"]).toContain(
            result.failure.code,
          )
        expect(rootGets(f)).toHaveLength(0)
        expect(bodies(f)).toEqual([])
        expect(f.base.semanticWrites().length).toBe(0)
        const current = await f.run(readSkill(rootRef, options).pipe(Effect.result))
        expect(current._tag === "Failure" && current.failure.code).toBe(
          fault === "foreign-parent"
            ? "INVALID_SHARED_SKILL"
            : fault === "repeated-page"
              ? "SHARED_REFERENCE_INCOMPLETE"
              : "SHARED_SKILL_ID_CONFLICT",
        )
        // Reading the main reveals the external link; its complete reference
        // inventory must then fail without reading the target or publishing a pin.
        expect(rootGets(f)).toHaveLength(1)
        expect(bodies(f)).toEqual(["/v1/pages/" + skillPage + "/markdown"])
        expect([...f.base.json.keys()].some((key) => key.startsWith("snapshots/"))).toBe(false)
        expect(f.base.semanticWrites()).toEqual([])
      },
    )
})
