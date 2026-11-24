import { fileRef } from "../src/ref.ts"
import { expect, test } from "bun:test"
import { Crypto, Effect, FileSystem, Path } from "effect"
import { HttpClient } from "effect/http"
import { catalog } from "../src/catalog.ts"
import { CatalogSchema, decode, fail, property, type Snapshot } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { openSkill, readSkill } from "../src/snapshot.ts"
import { Store } from "../src/store.ts"
import {
  currentBytes,
  currentId,
  currentLibrary,
  currentRich,
  currentSkillPage,
  currentSnapshotFixture,
} from "./shared-current-fixture.ts"

const page = currentSkillPage
const database = currentLibrary.skills.database_id
const guide = currentId(100)
const originalMain = "Original main content."
const originalGuide = "\ufeff第一行\n第二行\n第三行"
const frontmatter = "---\nname: authored-name\ndescription: Authored description.\n---\n\n"
type Services =
  | Store
  | Notion
  | Crypto.Crypto
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path

async function fixture() {
  const base = currentSnapshotFixture({ fileCount: 2 })
  base.main.properties.Name.title = [{ plain_text: "Sample Skill" }]
  base.main.properties.Description = currentRich("description", "Use when reviewing.")
  const support = base.files[0]
  if (support === undefined) throw new Error("Expected a current supporting File.")
  support.properties.Path = currentRich("path", "references/guide.md")
  base.bodies.set(page, originalMain)
  base.bodies.set(guide, originalGuide)
  await base.resource(1, "assets/data.bin", new Uint8Array([0, 255, 1]))
  return base
}
const selectedRef = (snapshot: Snapshot, path = "SKILL.md") =>
  fileRef(snapshot.record.id, path, snapshot.snapshot_id)
const currentSource = {
  alias: "frontend",
  database_id: database,
  data_source_ids: [currentLibrary.skills.data_source_id],
  title: "Frontend Skills",
  shared_library: currentLibrary,
}

for (const matches of [0, 1])
  for (const offline of [false, true])
    test(`a bound owner uses its verified cache despite an incomplete catalog with ${matches} matches, offline=${offline}`, async () => {
      const f = await fixture()
      await f.run(readSkill(page, { library: currentLibrary.library_id }))
      await f.run(catalog({ library: currentLibrary.library_id, refresh: true }))
      const key = [...f.json.keys()].find((value) => value.startsWith("cache/catalogs/"))
      if (key === undefined) throw new Error("Expected a real catalog observation")
      const observed = decode(CatalogSchema, f.json.get(key))
      f.json.set(key, {
        ...observed,
        records: observed.records.slice(0, matches),
        coverage: { ...observed.coverage, exhaustive: false, search_index_limited: true },
      })
      f.clearCalls()
      const result = await f.run(
        readSkill(fileRef(`skill://demo?library=${currentLibrary.library_id}`, "SKILL.md"), {
          library: currentLibrary.library_id,
          offline,
        }).pipe(Effect.result),
      )
      expect(result._tag).toBe("Success")
      expect(f.calls).toEqual([])
    })

for (const matches of [0, 1])
  test(`a short ref cannot infer Library from ${matches} discoverable matches`, async () => {
    const f = await fixture()
    f.json.delete("config.json")
    const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
      f.run(
        Effect.gen(function* () {
          const original = yield* Notion
          return yield* effect.pipe(
            Effect.provideService(Notion, {
              ...original,
              request: (path, body, options) =>
                path === "v1/search"
                  ? Effect.succeed({
                      object: "list",
                      results:
                        matches === 0
                          ? []
                          : [
                              {
                                id: currentLibrary.skills.data_source_id,
                                parent: { database_id: database },
                                title: [{ plain_text: "Current Skills" }],
                                properties: f.main.properties,
                                database_type: null,
                              },
                            ],
                      has_more: false,
                      next_cursor: null,
                    })
                  : original.request(path, body, options),
            }),
          )
        }),
      )
    const result = await run(
      readSkill("skill://demo/SKILL.md", { refresh: true }).pipe(Effect.result),
    )
    expect(result._tag === "Failure" && result.failure.code).toBe("LIBRARY_CONTEXT_REQUIRED")
    expect(f.bodyCalls()).toEqual([])
    expect(f.calls.some((call) => call.path.startsWith("v1/pages/"))).toBe(false)
    expect(f.records.size).toBe(1)
  })

test("selected resources retain exact bytes across current edits and remote revocation", async () => {
  const f = await fixture()
  const first = await f.run(openSkill(page))
  const read = await f.run(
    readSkill(first.snapshot_id, { path: "references/guide.md", lines: "2-2" }),
  )
  expect("content" in read && read.content).toBe("第二行")
  expect("has_more" in read && read.has_more).toBe(true)
  expect(read.ref).toContain(`&snapshot=${first.snapshot_id}`)
  f.bodies.set(guide, "Current edited guide.")
  const second = await f.run(openSkill(page, { refresh: true }))
  expect(second.snapshot_id).not.toBe(first.snapshot_id)
  const latest = await f.run(readSkill(selectedRef(second, "references/guide.md")))
  expect("content" in latest && latest.content).toBe("Current edited guide.")
  f.failRequests(() => fail("ACCESS_DENIED", "Remote access revoked."))
  f.clearCalls()
  const selected = await f.run(readSkill(selectedRef(first, "references/guide.md")))
  expect("content" in selected && selected.content).toBe(originalGuide)
  expect(selected.source).toBe("local_snapshot")
  expect(f.calls).toEqual([])
  const denied = await f.run(openSkill(page, { refresh: true }).pipe(Effect.result))
  expect(denied._tag === "Failure" && denied.failure.code).toBe("ACCESS_DENIED")
})

test("selected reads check resource hashes, missing paths and binary content", async () => {
  const f = await fixture()
  const snapshot = await f.run(openSkill(page))
  for (const [path, code] of [
    ["assets/data.bin", "BINARY_FILE"],
    ["absent.md", "FILE_NOT_FOUND"],
  ] as const) {
    const result = await f.run(readSkill(snapshot.snapshot_id, { path }).pipe(Effect.result))
    expect(result._tag === "Failure" && result.failure.code).toBe(code)
  }
  const file = snapshot.files.find((file) => file.path === "references/guide.md")
  if (file === undefined) throw new Error("Expected selected supporting bytes")
  f.objects.set(`objects/${file.sha256}`, currentBytes("tampered"))
  const corrupted = await f.run(
    readSkill(snapshot.snapshot_id, { path: file.path }).pipe(Effect.result),
  )
  expect(corrupted._tag === "Failure" && corrupted.failure.code).toBe("STATE_CORRUPT")
})

test("invalid Notion names carry the physical page and authored value before body acquisition", async () => {
  const f = await fixture()
  const name = "Agent\u200bSkill"
  f.main.properties.Name.title = [{ plain_text: name }]
  const result = await f.run(openSkill(page).pipe(Effect.result))
  expect(result._tag === "Failure" && result.failure).toMatchObject({
    code: "INVALID_SKILL_NAME",
    details: { page_id: page, name },
  })
  expect(f.bodyCalls()).toEqual([])
  expect(
    [...f.json.keys()].some(
      (key) => key.startsWith("snapshots/") || key.startsWith("cache/latest/"),
    ),
  ).toBe(false)
})

for (const name of ["Tty7", "n8n-workflow", "React19", "中文", "Agent Workflow"])
  test(`current snapshots preserve display metadata and authored bytes for ${name}`, async () => {
    const f = await fixture()
    f.main.properties.Name.title = [{ plain_text: name }]
    const snapshot = await f.run(openSkill(page))
    expect(snapshot.record.name).toBe(name)
    const read = await f.run(readSkill(snapshot.snapshot_id))
    expect("content" in read && read.content).toBe(frontmatter + originalMain)
  })

test("current metadata edits do not rewrite authored frontmatter or selected bytes", async () => {
  const f = await fixture()
  const first = await f.run(openSkill(page))
  f.main.properties.Name.title = [{ plain_text: "Renamed Skill" }]
  f.main.properties.Description = currentRich("description", "Current description.")
  const current = await f.run(openSkill(page, { refresh: true }))
  expect(current.record).toMatchObject({
    name: "Renamed Skill",
    alias: "renamed-skill",
    description: "Current description.",
  })
  expect(current.version_id).toBe(first.version_id)
  const read = await f.run(readSkill(current.snapshot_id))
  expect("content" in read && read.content).toBe(frontmatter + originalMain)
  expect(f.semanticWrites()).toEqual([])
})

test("physical page reads accept configured aliases and selected Library checks stay local", async () => {
  const f = await fixture()
  const otherLibrary = {
    ...currentLibrary,
    library_id: "563e49fa-4378-5493-a5ff-8c96321f9ffd",
    operation_id: "other",
    skills: {
      ...currentLibrary.skills,
      database_id: currentId(200),
      data_source_id: currentId(201),
    },
  }
  f.json.set("config.json", {
    sources: [
      currentSource,
      {
        alias: "ops",
        database_id: otherLibrary.skills.database_id,
        title: "Operations Skills",
        data_source_ids: [otherLibrary.skills.data_source_id],
        shared_library: otherLibrary,
      },
    ],
  })
  const snapshot = await f.run(openSkill(page, { library: "frontend" }))
  expect(snapshot.record.locator).toMatchObject({
    type: "shared_skill",
    database_id: database,
    page_id: page,
  })
  const wrongOnline = await f.run(openSkill(page, { library: "ops" }).pipe(Effect.result))
  expect(wrongOnline._tag === "Failure" && wrongOnline.failure.code).toBe("SKILL_NOT_FOUND")
  f.failRequests(() => fail("ACCESS_DENIED", "Remote access revoked."))
  f.clearCalls()
  const read = await f.run(readSkill(snapshot.snapshot_id, { library: "frontend" }))
  expect("content" in read && read.content).toBe(frontmatter + originalMain)
  for (const [selector, code] of [
    ["ops", "LIBRARY_SCOPE_MISMATCH"],
    ["missing", "LIBRARY_NOT_FOUND"],
  ] as const) {
    const result = await f.run(
      readSkill(snapshot.snapshot_id, { library: selector }).pipe(Effect.result),
    )
    expect(result._tag === "Failure" && result.failure.code).toBe(code)
  }
  expect(f.calls).toEqual([])
})

test("current page acquisition fences the owner before and after body reads", async () => {
  const f = await fixture()
  await f.run(openSkill(page))
  const ownerReads = f.calls.flatMap((call, i) => (call.path === `v1/pages/${page}` ? [i] : []))
  const bodyReads = f.calls.flatMap((call, i) => (call.path.includes("/markdown") ? [i] : []))
  expect(ownerReads).toHaveLength(2)
  expect(bodyReads.length).toBe(2)
  expect(ownerReads[0]).toBeLessThan(Math.min(...bodyReads))
  expect(ownerReads[1]).toBeGreaterThan(Math.max(...bodyReads))
  expect(f.calls.filter((call) => call.path === `v1/databases/${database}`)).toHaveLength(3)
  expect(f.calls.some((call) => call.path.split("?")[0] !== `v1/blocks/${currentLibrary.library_id}/children` && /\/ai\/|\/blocks\/|\/properties\//u.test(call.path))).toBe(false)
  expect(f.semanticWrites()).toEqual([])
})

test("explicit refresh reads current native files and resource bytes without a publication prerequisite", async () => {
  const f = await fixture()
  const initial = await f.run(openSkill(page))
  expect(f.recordCalls().length).toBeGreaterThan(0)
  f.clearCalls()
  const unchanged = await f.run(openSkill(page, { refresh: true }))
  expect(unchanged.version_id).toBe(initial.version_id)
  expect(
    f
      .bodyCalls()
      .map((call) => call.path.split("?")[0])
      .sort(),
  ).toEqual([`v1/pages/${page}/markdown`, `v1/pages/${guide}/markdown`].sort())
  expect(f.recordCalls()).toEqual([])
  f.bodies.set(page, "Externally edited main.")
  const mainChanged = await f.run(openSkill(page, { refresh: true }))
  expect(mainChanged.version_id).not.toBe(initial.version_id)
  f.bodies.set(guide, "Externally edited supporting file.")
  const supportChanged = await f.run(openSkill(page, { refresh: true }))
  expect(supportChanged.version_id).not.toBe(mainChanged.version_id)
  await f.resource(1, "assets/data.bin", new Uint8Array([1, 255, 0]))
  const resourceChanged = await f.run(openSkill(page, { refresh: true }))
  expect(resourceChanged.version_id).not.toBe(supportChanged.version_id)
  expect(f.selectedBytes(resourceChanged, "assets/data.bin")).toEqual(new Uint8Array([1, 255, 0]))
  const selectedMain = await f.run(readSkill(initial.snapshot_id))
  expect("content" in selectedMain && selectedMain.content).toBe(frontmatter + originalMain)
  expect(f.semanticWrites()).toEqual([])
})

for (const [change, code] of [
  ["trash", "NOT_SKILL"],
  ["id", "INVALID_RESPONSE"],
  ["database", "LIBRARY_SCOPE_MISMATCH"],
  ["data-source", "LIBRARY_SCOPE_MISMATCH"],
] as const)
  test(`physical page acquisition rejects ${change} drift before any body reads`, async () => {
    const f = await fixture()
    f.alterResponses((call, response) => {
      if (call.path !== `v1/pages/${page}`) return response
      const row = property(response)
      return {
        ...row,
        ...(change === "trash" ? { in_trash: true } : {}),
        ...(change === "id" ? { id: currentId(99) } : {}),
        parent: {
          ...property(row.parent),
          ...(change === "database" ? { database_id: currentId(99) } : {}),
          ...(change === "data-source" ? { data_source_id: currentId(99) } : {}),
        },
      }
    })
    const result = await f.run(openSkill(page, { library: currentLibrary.library_id }).pipe(Effect.result))
    expect(result._tag === "Failure" && result.failure.code).toBe(code)
    expect(f.bodyCalls()).toEqual([])
    expect(f.calls.some(call => call.path === `v1/databases/${currentId(99)}` || call.path === `v1/data_sources/${currentId(99)}`)).toBe(false)
  })

test("stable identity resolution rechecks live metadata while preserving independently authored frontmatter", async () => {
  const f = await fixture()
  const old = structuredClone(f.main)
  f.main.properties.Name.title = [{ plain_text: "Renamed Skill" }]
  f.main.properties.Description = currentRich("description", "Current root description.")
  f.alterResponses((call, response) =>
    call.path.startsWith(`v1/data_sources/${currentLibrary.skills.data_source_id}/query`)
      ? { ...property(response), results: [old] }
      : response,
  )
  const snapshot = await f.run(
    openSkill(`skill://demo?library=${currentLibrary.library_id}`, { library: currentLibrary.library_id }),
  )
  expect(snapshot.record).toMatchObject({
    name: "Renamed Skill",
    alias: "renamed-skill",
    description: "Current root description.",
  })
  const main = await f.run(readSkill(snapshot.snapshot_id))
  expect("content" in main && main.content).toBe(frontmatter + originalMain)
})

for (const [change, code] of [
  ["trash", "INVALID_SHARED_SKILL"],
  ["id", "SHARED_SKILL_ID_CONFLICT"],
  ["database", "INVALID_SHARED_SKILL"],
  ["data-source", "INVALID_SHARED_SKILL"],
  ["stable-id", "SHARED_SKILL_ID_CONFLICT"],
] as const)
  test(`stable identity resolution rejects fresh ${change} ownership drift before body reads`, async () => {
    const f = await fixture()
    const old = structuredClone(f.main)
    f.alterResponses((call, response) => {
      if (call.path.startsWith(`v1/data_sources/${currentLibrary.skills.data_source_id}/query`))
        return { ...property(response), results: [old] }
      if (call.path !== `v1/pages/${page}`) return response
      const row = property(response)
      return {
        ...row,
        ...(change === "trash" ? { in_trash: true } : {}),
        ...(change === "id" ? { id: currentId(99) } : {}),
        parent: {
          ...property(row.parent),
          ...(change === "database" ? { database_id: currentId(99) } : {}),
          ...(change === "data-source" ? { data_source_id: currentId(99) } : {}),
        },
        properties: {
          ...property(row.properties),
          ...(change === "stable-id" ? { "Skill ID": currentRich("skill-id", "different") } : {}),
        },
      }
    })
    const result = await f.run(
      openSkill(`skill://demo?library=${currentLibrary.library_id}`, { library: currentLibrary.library_id }).pipe(
        Effect.result,
      ),
    )
    expect(result._tag === "Failure" && result.failure.code).toBe(code)
    expect(f.bodyCalls()).toEqual([])
    expect(f.calls.some(call => call.path === `v1/databases/${currentId(99)}` || call.path === `v1/data_sources/${currentId(99)}`)).toBe(false)
  })

for (const [change, code] of [
  ["completed", "CURRENT_TREE_CHANGED"],
  ["applying", "CURRENT_OPERATION_PENDING"],
] as const)
  test(`a concurrent ${change} owner change cannot publish acquired bytes as a coherent current snapshot`, async () => {
    const f = await fixture()
    f.alterResponses((call, response) => {
      if (call.path.split("?")[0] === `v1/pages/${page}/markdown`) {
        f.main.last_edited_time = "2026-11-19T00:00:00.000Z"
        if (change === "applying") {
          f.main.properties["Current State"].select = { name: "applying" }
          f.main.properties.Operation = currentRich("operation", "concurrent-write")
        }
      }
      return response
    })
    const result = await f.run(openSkill(page).pipe(Effect.result))
    expect(result._tag === "Failure" && result.failure.code).toBe(code)
    expect([...f.json.keys()].some((key) => key.startsWith("cache/latest/"))).toBe(false)
    expect(f.semanticWrites()).toEqual([])
  })

test("selected relative reads stay inside the owner and work after remote access is revoked", async () => {
  const f = await fixture()
  const snapshot = await f.run(openSkill(page))
  f.failRequests(() => fail("ACCESS_DENIED", "Remote access revoked."))
  f.clearCalls()
  const from = selectedRef(snapshot, "references/guide.md")
  const read = await f.run(readSkill("../SKILL.md", { from, offline: true }))
  expect("content" in read && read.content).toBe(frontmatter + originalMain)
  expect(read.snapshot_id).toBe(snapshot.snapshot_id)
  expect(read.source).toBe("local_snapshot")
  const invalid = await f.run(
    readSkill("../../outside.md", { from, offline: true }).pipe(Effect.result),
  )
  expect(invalid._tag === "Failure" && invalid.failure).toMatchObject({
    code: "CURRENT_SOURCE_REQUIRED",
    details: {
      from_path: "references/guide.md",
      relative_path: "../../outside.md",
      next: "manage_current_source_links",
    },
  })
  expect(f.calls).toEqual([])
})

for (const selector of [
  `notion_page:${page}`,
  "notion_subscription:retired:skill",
  "upstream:retired:skill",
])
  test(`retired selector ${selector.split(":")[0]} cannot be silently mapped to a current Skill`, async () => {
    const f = await fixture()
    const result = await f.run(openSkill(selector).pipe(Effect.result))
    expect(result._tag === "Failure" && result.failure.code).toBe("CURRENT_TARGET_REQUIRED")
    expect(f.calls).toEqual([])
  })
