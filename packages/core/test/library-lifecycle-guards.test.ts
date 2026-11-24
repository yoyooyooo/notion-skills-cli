import { expect, test } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "node:os"
import { fail, property, type SkillsError } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { loadSharedLibrary, LIBRARY_MARKER } from "../src/shared-library.ts"
import { withLibraryInitialization } from "../src/shared-library-initialization.ts"
import { currentId, currentLibrary } from "./shared-current-fixture.ts"
import { currentWriteFixture } from "./shared-current-write-fixture.ts"
import { librarySchemaResponse } from "./library-schema-fixture.ts"

const roles = ["skills", "files", "records", "sources"] as const
const physicalRoot = currentLibrary.library_id
const childrenPath = `v1/blocks/${physicalRoot}/children`

function fixture() {
  // Freeze the service's physical facts before any candidate declaration changes.
  // Responses never synthesize an expected parent from the descriptor under test.
  const facts = new Map<string, Record<string, unknown>>()
  for (const path of [
    `v1/pages/${physicalRoot}`,
    childrenPath,
    ...roles.flatMap((role) => [
      `v1/databases/${currentLibrary[role].database_id}`,
      `v1/data_sources/${currentLibrary[role].data_source_id}`,
    ]),
  ]) facts.set(path, structuredClone(property(librarySchemaResponse(path, currentLibrary))))
  const calls: Array<{ path: string; method: string }> = []
  const api: Notion["Service"] = {
    version: Effect.succeed("controlled"),
    credentialIdentity: Effect.succeed("controlled"),
    request: (path, body, options) => Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
      const method = options?.method ?? (body === undefined ? "GET" : "POST")
      calls.push({ path, method })
      const raw = facts.get(path) ?? facts.get(path.split("?")[0]!)
      return method === "GET" && raw !== undefined
        ? Effect.succeed(structuredClone(raw))
        : Effect.fail(fail("UNEXPECTED_GUARD_FIXTURE_IO", "No mutation or undeclared route is allowed.", { path, method }))
    }),
  }
  return {
    facts,
    calls,
    read: (root = physicalRoot) => Effect.runPromise(loadSharedLibrary(root).pipe(Effect.provideService(Notion, api))),
  }
}

test("Library admission reads the independent root and all four physical bindings without mutation", async () => {
  const f = fixture()
  expect(await f.read()).toEqual(currentLibrary)
  expect(f.calls.every((call) => call.method === "GET")).toBe(true)
  for (const role of roles) {
    expect(f.calls.filter((call) => call.path === `v1/databases/${currentLibrary[role].database_id}`)).toHaveLength(1)
    expect(f.calls.some((call) => call.path === `v1/data_sources/${currentLibrary[role].data_source_id}`)).toBe(true)
  }
})

test("a requested root cannot borrow another root's otherwise valid descriptor and tables", async () => {
  const f = fixture(), requestedRoot = currentId(901)
  f.facts.set(`v1/pages/${requestedRoot}`, { ...f.facts.get(`v1/pages/${physicalRoot}`), id: requestedRoot })
  f.facts.set(`v1/blocks/${requestedRoot}/children`, structuredClone(f.facts.get(childrenPath)!))
  await expect(f.read(requestedRoot)).rejects.toMatchObject({ code: "LIBRARY_SCHEMA_CONFLICT" })
  expect(f.calls.every((call) => call.method === "GET")).toBe(true)
})

test("unchanged declarations cannot conceal a moved Files database", async () => {
  const f = fixture(), path = `v1/databases/${currentLibrary.files.database_id}`
  f.facts.set(path, { ...f.facts.get(path), parent: { type: "page_id", page_id: currentId(901) } })
  await expect(f.read()).rejects.toMatchObject({ code: "LIBRARY_SCHEMA_CONFLICT" })
  expect(f.calls.some((call) => call.path === `v1/data_sources/${currentLibrary.files.data_source_id}`)).toBe(false)
})

test("unchanged declarations cannot conceal a foreign Files data-source parent", async () => {
  const f = fixture(), path = `v1/data_sources/${currentLibrary.files.data_source_id}`
  f.facts.set(path, { ...f.facts.get(path), parent: { type: "database_id", database_id: currentId(901) } })
  await expect(f.read()).rejects.toMatchObject({ code: "LIBRARY_SCHEMA_CONFLICT" })
})

test("a descriptor cannot become Ready before the Sources schema is actually read", async () => {
  const f = fixture(), path = `v1/data_sources/${currentLibrary.sources.data_source_id}`
  f.facts.set(path, { ...f.facts.get(path), properties: {} })
  await expect(f.read()).rejects.toMatchObject({ code: "LIBRARY_SCHEMA_CONFLICT" })
  expect(f.calls.some((call) => call.path === path)).toBe(true)
})

test("Library discovery checks later root pages before admitting a unique descriptor", async () => {
  const f = fixture(), extraId = currentId(901)
  const second = { ...currentLibrary, skills: { ...currentLibrary.skills, database_id: extraId, data_source_id: currentId(902) } }
  f.facts.set(`v1/databases/${extraId}`, {
    ...structuredClone(f.facts.get(`v1/databases/${currentLibrary.skills.database_id}`)!),
    id: extraId,
    data_sources: [{ id: second.skills.data_source_id }],
    description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(second) }],
  })
  f.facts.set(`${childrenPath}?page_size=100`, { ...f.facts.get(childrenPath), has_more: true, next_cursor: "second-page" })
  f.facts.set(`${childrenPath}?page_size=100&start_cursor=second-page`, {
    results: [{ id: extraId, type: "child_database" }], has_more: false, next_cursor: null,
  })
  await expect(f.read()).rejects.toMatchObject({ code: "LIBRARY_AMBIGUOUS" })
  expect(f.calls.some((call) => call.path.endsWith("&start_cursor=second-page"))).toBe(true)
  expect(f.calls.every((call) => call.method === "GET")).toBe(true)
})

test("root CREATE sees its independent original intent in the Store before dispatch", async () => {
  const f = currentWriteFixture(tmpdir()), observations: unknown[][] = []
  const api: Notion["Service"] = {
    version: Effect.succeed("controlled"),
    credentialIdentity: Effect.succeed("controlled"),
    request: () => Effect.suspend(() => {
      observations.push(structuredClone([...f.json.values()]))
      return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "The CREATE may have reached the service."))
    }),
  }
  const operation = "library-before-root"
  const result = await f.run(withLibraryInitialization(currentId(901), operation, "create", (session) =>
    session.perform("create:root", "never", Effect.gen(function* () {
      return yield* (yield* Notion).request("v1/pages", { parent: { page_id: currentId(901) } })
    })),
  ).pipe(Effect.provideService(Notion, api), Effect.result))
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "WRITE_OUTCOME_UNKNOWN" } })
  expect(observations).toHaveLength(1)
  expect(observations[0]).toHaveLength(1)
  expect(observations[0]![0]).toMatchObject({
    version: 2, operation_id: operation, parent_page_id: currentId(901), root_page_id: null,
    in_flight: { action: "create:root" },
  })
  expect([...f.json.values()]).toEqual(observations[0]!)
})
