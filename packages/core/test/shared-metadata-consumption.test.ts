import { describe, expect, test } from "bun:test"
import { Effect, type Crypto, type FileSystem, type Path } from "effect"
import type { HttpClient } from "effect/http"
import { catalog } from "../src/catalog.ts"
import { property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { fileRef } from "../src/ref.ts"
import { readSkill } from "../src/snapshot.ts"
import { Store } from "../src/store.ts"
import {
  encode,
  id,
  library,
  rich,
  sharedSnapshotFixture,
  skillPage,
} from "./shared-snapshot-fixture.ts"

const owner = "shared_skill:library-snapshot:stable-skill"
const rootRef = fileRef(owner, "SKILL.md")
const options = { database: library.skills.database_id }
const fields = ["title", "description", "kind", "skill_id", "enabled", "default"]
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
  cursor: string | undefined
  fields: readonly string[]
  body: unknown
  response: MetadataPage
  responseBytes: number
}

/** Only Skills queries are replaced. Every current-page, Files, Records and body
 * operation still follows the shared snapshot fixture's real core boundary. */
function fixture(count = 2) {
  const base = sharedSnapshotFixture({ fileCount: 1 })
  const rows: Record<string, unknown>[] = [base.main]
  for (let index = 1; index < count; index++)
    rows.push({
      ...structuredClone(base.main),
      id: id(1000 + index),
      properties: {
        ...structuredClone(property(base.main.properties)),
        title: { id: "title", type: "title", title: [{ plain_text: "Other " + index }] },
        description: rich("description", "Metadata for other " + index),
        skill_id: rich("skill_id", "other-" + index),
      },
    })
  const externalPage = String(rows.at(-1)!.id)
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
    beforeSelectedGet?: () => void
    reply?: (input: {
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
            request: (path, body, requestOptions) =>
              Effect.suspend(() => {
                const url = new URL(path, "https://fixture.invalid/")
                const method = requestOptions?.method ?? (body === undefined ? "GET" : "POST")
                requests.push({ path, method, body: structuredClone(body) })
                if (url.pathname === skillQuery) {
                  const selectedFields = url.searchParams.getAll("filter_properties")
                  const selected = new Set(selectedFields)
                  const projected = rows.map((row) => ({
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
                    controls.reply?.({ cursor, projected, response: ordinary }) ?? ordinary
                  queries.push({
                    cursor,
                    fields: selectedFields,
                    body: structuredClone(body),
                    response: structuredClone(response),
                    responseBytes: encode(JSON.stringify(response)).byteLength,
                  })
                  return Effect.succeed(structuredClone(response))
                }
                if (url.pathname === "/v1/pages/" + skillPage && method === "GET") {
                  const update = controls.beforeSelectedGet
                  controls.beforeSelectedGet = undefined
                  update?.()
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
  for (const count of [1, 10, 100, 101, 300])
    test(
      "a cold logical read observes " + count + " Skills once with the exact six fields",
      async () => {
        const f = fixture(count)
        const result = await f.run(readSkill(rootRef, options))
        expect(result.record.id).toBe(owner)
        expect(rootGets(f)).toHaveLength(1)
        expect(bodies(f)).toEqual(["/v1/pages/" + skillPage + "/markdown"])
        expect(f.queries).toHaveLength(Math.ceil(count / 100))
        expect(f.queries.map((query) => query.cursor ?? null)).toEqual(
          Array.from({ length: Math.ceil(count / 100) }, (_, index) =>
            index === 0 ? null : "offset-" + index * 100,
          ),
        )
        for (const query of f.queries) {
          expect(query.fields).toEqual(fields)
          expect(property(query.body).page_size).toBe(100)
          expect(property(query.body).filter).toBeUndefined()
          expect(query.responseBytes).toBeGreaterThan(0)
          for (const row of query.response.results)
            expect(Object.keys(property(property(row).properties)).sort()).toEqual(
              [...fields].sort(),
            )
        }
        const entries = result.native_references?.entries ?? []
        expect(entries.find((entry) => entry.page_id === skillPage)?.id).toBe(owner)
        if (count > 1)
          expect(entries.find((entry) => entry.page_id === f.externalPage)).toMatchObject({
            id: "shared_skill:library-snapshot:other-" + (count - 1),
            name: "Other " + (count - 1),
            availability: "available",
          })
        expect(result.native_references?.unresolved).toEqual([])
        expect(privateKeys(result)).toEqual([])
        if (process.env.NTN_SKILLS_SC11_EVIDENCE === "1")
          console.log(
            "SC11_METADATA_COST " +
              JSON.stringify({
                count,
                measurement: "controlled decoded JSON bytes",
                wire_bytes: null,
                request_count: f.queries.length,
                pages: f.queries.map((query) => ({
                  fields: query.fields,
                  cursor: query.cursor ?? null,
                  rows: query.response.results.length,
                  responseBytes: query.responseBytes,
                })),
                total_response_bytes: f.queries.reduce(
                  (sum, query) => sum + query.responseBytes,
                  0,
                ),
                selected_page_gets: rootGets(f).length,
                body_reads: bodies(f).length,
              }),
          )
      },
    )

  test("disabled external Skills remain in the complete observation without target body reads", async () => {
    const f = fixture()
    property(f.rows[1]!.properties).enabled = { id: "enabled", type: "checkbox", checkbox: false }
    const result = await f.run(readSkill(rootRef, options))
    expect(
      result.native_references?.entries.find((entry) => entry.page_id === f.externalPage),
    ).toMatchObject({
      id: "shared_skill:library-snapshot:other-1",
      availability: "disabled",
    })
    expect(result.native_references?.unresolved).toEqual([])
    expect(f.queries).toHaveLength(1)
    expect(bodies(f)).toEqual(["/v1/pages/" + skillPage + "/markdown"])
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
    expect(f.queries).toHaveLength(1)
    expect(f.requests.some((request) => request.path.includes(unknown))).toBe(false)
  })

  test("an empty intermediate page is exhausted before the referenced final-page target is resolved", async () => {
    const f = fixture()
    f.controls.reply = ({ cursor, projected }) =>
      cursor === undefined
        ? { object: "list", results: [projected[0]], has_more: true, next_cursor: "offset-100" }
        : cursor === "offset-100"
          ? { object: "list", results: [], has_more: true, next_cursor: "offset-200" }
          : { object: "list", results: [projected[1]], has_more: false, next_cursor: null }
    const result = await f.run(readSkill(rootRef, options))
    expect(
      result.native_references?.entries.some((entry) => entry.page_id === f.externalPage),
    ).toBe(true)
    expect(f.queries.map((query) => query.cursor ?? null)).toEqual([
      null,
      "offset-100",
      "offset-200",
    ])
  })

  test("reexecuting a refresh effect observes changed target metadata and authorization independently", async () => {
    const f = fixture()
    const read = readSkill(rootRef, { ...options, refresh: true })
    const first = await f.run(read)
    const before = f.queries.length
    property(f.rows[1]!.properties).description = rich("description", "New target metadata")
    f.controls.credential = "another-scalar-credential"
    const second = await f.run(read)
    expect(second.scope).not.toBe(first.scope)
    expect(
      second.native_references?.entries.find((entry) => entry.page_id === f.externalPage)
        ?.description,
    ).toBe("New target metadata")
    expect(f.queries.length - before).toBe(1)
    expect(rootGets(f)).toHaveLength(2)
  })

  test("a later same-scope refresh does not treat the previous invocation's observation as current", async () => {
    const f = fixture()
    const read = readSkill(rootRef, { ...options, refresh: true })
    const first = await f.run(read)
    const before = f.queries.length
    property(f.rows[1]!.properties).enabled = { id: "enabled", type: "checkbox", checkbox: false }
    const second = await f.run(read)
    expect(second.scope).toBe(first.scope)
    expect(
      second.native_references?.entries.find((entry) => entry.page_id === f.externalPage)
        ?.availability,
    ).toBe("disabled")
    expect(f.queries.length - before).toBe(1)
  })

  test("the full current root GET owns self-link metadata after catalog Name and Description change", async () => {
    const f = fixture()
    f.controls.beforeSelectedGet = () => {
      property(f.base.main.properties).title = {
        id: "title",
        type: "title",
        title: [{ plain_text: "Fresh root name" }],
      }
      property(f.base.main.properties).description = rich("description", "Fresh root description")
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
    expect(rootGets(f)).toHaveLength(1)
  })

  test("a logical Skill ID changing between catalog resolution and the full root GET is rejected before bodies", async () => {
    const f = fixture()
    f.controls.beforeSelectedGet = () => {
      property(f.base.main.properties).skill_id = rich("skill_id", "replacement-identity")
    }
    const result = await f.run(readSkill(rootRef, options).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    expect(bodies(f)).toEqual([])
    expect(f.base.writeCount()).toBe(0)
  })

  test("an exact page selector still reads that page's current logical identity", async () => {
    const f = fixture()
    f.controls.beforeSelectedGet = () => {
      property(f.base.main.properties).skill_id = rich("skill_id", "replacement-identity")
    }
    const result = await f.run(readSkill(skillPage, options))
    expect(result.record.id).toBe("shared_skill:library-snapshot:replacement-identity")
    expect(rootGets(f)).toHaveLength(1)
  })

  test("the current root remains an identity claimant when a native inventory omits its row", async () => {
    const f = fixture()
    property(f.rows[1]!.properties).skill_id = rich("skill_id", "stable-skill")
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
      expect(f.base.writeCount()).toBe(0)
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
          property(duplicate.properties).enabled = {
            id: "enabled",
            type: "checkbox",
            checkbox: false,
          }
          f.rows.push(duplicate)
        }
        const result = await f.run(readSkill(rootRef, options).pipe(Effect.result))
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure")
          expect(["INVALID_SHARED_SKILL", "SHARED_SKILL_ID_CONFLICT"]).toContain(
            result.failure.code,
          )
        expect(rootGets(f)).toHaveLength(0)
        expect(bodies(f)).toEqual([])
        expect(f.base.writeCount()).toBe(0)
      },
    )
})
