import { expect, test } from "bun:test"
import { Effect } from "effect"
import { bindEntryTarget, catalog } from "../src/catalog.ts"
import { fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { pageId } from "../src/notion-id.ts"
import { parseTarget } from "../src/ref.ts"
import { loadSharedLibrary, resolveLibrary, LIBRARY_MARKER } from "../src/shared-library.ts"
import { currentLibrary, currentSnapshotFixture } from "./shared-current-fixture.ts"
import { librarySchemaResponse } from "./library-schema-fixture.ts"

const root = currentLibrary.library_id
const other = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const helper = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

function boundary(rewrite: (path: string, value: unknown) => unknown = (_, value) => value) {
  const requests: string[] = []
  const api: Notion["Service"] = {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("same-token"),
    request: (path, body, options) =>
      Effect.suspend(() => {
        requests.push(path)
        if (body !== undefined || (options?.method !== undefined && options.method !== "GET"))
          return Effect.fail(fail("UNEXPECTED_WRITE", "Root inspection is read-only."))
        const raw = librarySchemaResponse(path, currentLibrary)
        const selected = rewrite(path, raw)
        return selected === undefined
          ? Effect.fail(fail("NOTION_NOT_FOUND", "Exact object unavailable."))
          : Effect.succeed(selected)
      }),
  }
  return {
    requests,
    run: (input = root) =>
      Effect.runPromise(loadSharedLibrary(input).pipe(Effect.provideService(Notion, api))),
  }
}

test("UUID and Notion root URLs normalize before routing; arbitrary library labels are rejected", () => {
  expect(pageId(other.toUpperCase())).toBe(other)
  expect(pageId(other.replaceAll("-", ""))).toBe(other)
  expect(pageId(`https://www.notion.so/Library-${other.replaceAll("-", "")}?v=x`)).toBe(other)
  expect(pageId(`https://notion.so/${other}`)).toBe(other)
  for (const input of [
    "library-production",
    "not-a-uuid",
    "https://evil.example/" + other,
    "a-" + other.replaceAll("-", ""),
    "https://name:secret@notion.so/" + other,
  ])
    expect(pageId(input)).toBeUndefined()
})

test("root inspection verifies actual four-table topology and permits ordinary helper content", async () => {
  const f = boundary((path, value) => {
    if (path.startsWith(`v1/blocks/${root}/children`)) {
      const page = property(value)
      return {
        ...page,
        results: [
          ...(page.results as unknown[]),
          { id: helper, type: "child_database" },
          { id: other, type: "paragraph", paragraph: { rich_text: [] } },
        ],
      }
    }
    if (path === `v1/databases/${helper}`)
      return { id: helper, parent: { page_id: root }, description: [] }
    return value
  })
  expect(await f.run(root.replaceAll("-", ""))).toEqual(currentLibrary)
  for (const role of ["skills", "files", "records", "sources"] as const) {
    expect(f.requests).toContain(`v1/databases/${currentLibrary[role].database_id}`)
    expect(f.requests).toContain(`v1/data_sources/${currentLibrary[role].data_source_id}`)
  }
})

test("copied roots, moved tables, replacement data sources and duplicate descriptors cannot bind", async () => {
  for (const mutate of [
    (path: string, value: unknown) =>
      path === `v1/databases/${currentLibrary.skills.database_id}`
        ? { ...property(value), parent: { page_id: other } }
        : value,
    (path: string, value: unknown) =>
      path === `v1/databases/${currentLibrary.files.database_id}`
        ? { ...property(value), parent: { page_id: other } }
        : value,
    (path: string, value: unknown) =>
      path === `v1/data_sources/${currentLibrary.files.data_source_id}`
        ? { ...property(value), parent: { database_id: other } }
        : value,
  ])
    await expect(boundary(mutate).run()).rejects.toThrow()
  const duplicate = boundary((path, value) => {
    if (path.startsWith(`v1/blocks/${root}/children`))
      return {
        ...property(value),
        results: [
          ...(property(value).results as unknown[]),
          { id: helper, type: "child_database" },
        ],
      }
    if (path === `v1/databases/${helper}`)
      return {
        id: helper,
        parent: { page_id: root },
        description: [
          {
            plain_text:
              LIBRARY_MARKER +
              JSON.stringify({
                ...currentLibrary,
                skills: { ...currentLibrary.skills, database_id: helper },
              }),
          },
        ],
      }
    return value
  })
  await expect(duplicate.run()).rejects.toThrow("exactly one")
})

test("incomplete pagination and inaccessible exact roots never become an empty ready Library", async () => {
  const incomplete = boundary((path, value) =>
    path.startsWith(`v1/blocks/${root}/children`)
      ? { ...property(value), has_more: true, next_cursor: null }
      : value,
  )
  await expect(incomplete.run()).rejects.toThrow()
  const denied = boundary((path, value) => (path === `v1/pages/${root}` ? undefined : value))
  await expect(denied.run()).rejects.toThrow("unavailable")
  expect(denied.requests).toEqual([`v1/pages/${root}`])
})

test("default selection and explicit constraints differ before any target I/O", async () => {
  const f = currentSnapshotFixture()
  f.json.set("config.json", { default_library: other })
  const full = parseTarget(`skill://demo?library=${root}`)
  expect((await f.run(bindEntryTarget(full))).selector).toBe(full.selector)
  expect((await f.run(bindEntryTarget(parseTarget("demo")))).selector).toBe(
    `skill://demo?library=${other}`,
  )
  await expect(f.run(bindEntryTarget(full, { library: other }))).rejects.toThrow("conflicts")
  expect(f.calls).toHaveLength(0)
  f.json.set("config.json", {})
  await expect(f.run(bindEntryTarget(parseTarget("demo")))).rejects.toThrow("default_library")
})

test("SDK resolver and default catalog work with an empty Library and never search other roots", async () => {
  const f = currentSnapshotFixture()
  f.json.set("config.json", { default_library: root })
  f.alterResponses((call, value) =>
    call.path.startsWith(`v1/data_sources/${currentLibrary.skills.data_source_id}/query`)
      ? { results: [], has_more: false, next_cursor: null }
      : value,
  )
  expect(await f.run(resolveLibrary())).toEqual(currentLibrary)
  const listed = await f.run(catalog({ refresh: true }))
  expect(listed.library_id).toBe(root)
  expect(listed.records).toEqual([])
  expect(listed.coverage.method).toBe("explicit_library")
  expect(f.calls.some((call) => call.path === "v1/search")).toBe(false)
})
