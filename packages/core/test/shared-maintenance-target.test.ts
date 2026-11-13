import { expect, test } from "bun:test"
import { Effect } from "effect"
import { authScope } from "../src/catalog.ts"
import { property, SnapshotSchema } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { fileRef } from "../src/ref.ts"
import { resolveSharedMaintenanceTarget } from "../src/shared-maintenance-target.ts"
import { sharedSnapshotFixture, library, skillPage } from "./shared-snapshot-fixture.ts"
import { Store } from "../src/store.ts"

test("maintenance resolves exact native URLs without materializing bodies or scanning other libraries", async () => {
  const f = sharedSnapshotFixture({ fileCount: 1 })
  const result = await f.run(
    resolveSharedMaintenanceTarget(
      `https://app.notion.com/p/team/example-${skillPage.replaceAll("-", "")}?source=copy_link`,
    ),
  )
  expect(result).toMatchObject({
    page_id: skillPage,
    entry: library.skills.database_id,
    library_id: library.library_id,
    selected_from: "exact_page_metadata",
    pin: null,
  })
  expect(f.readBodyCount()).toBe(0)
  expect(f.calls.map((call) => call.path)).toEqual([
    `v1/pages/${skillPage}`,
    `v1/databases/${library.skills.database_id}`,
  ])
  expect(f.writeCount()).toBe(0)
})

test("a page with only a data-source parent resolves that exact container instead of searching libraries", async () => {
  const f = sharedSnapshotFixture({ fileCount: 1 })
  delete property(f.main.parent).database_id
  const calls: string[] = []
  const selected = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* resolveSharedMaintenanceTarget(skillPage).pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) => {
            calls.push(path)
            return path === `v1/data_sources/${library.skills.data_source_id}`
              ? Effect.succeed({
                  object: "data_source",
                  id: library.skills.data_source_id,
                  parent: { type: "database_id", database_id: library.skills.database_id },
                })
              : api.request(path, body, options)
          },
        }),
      )
    }),
  )
  expect(selected.entry).toBe(library.skills.database_id)
  expect(calls).toEqual([
    `v1/pages/${skillPage}`,
    `v1/data_sources/${library.skills.data_source_id}`,
    `v1/databases/${library.skills.database_id}`,
  ])
  expect(f.writeCount()).toBe(0)
})

test("a pinned manifest only resolves its same authenticated owner and does not load file objects", async () => {
  const f = sharedSnapshotFixture({ fileCount: 1 })
  const scope = await f.run(authScope)
  // Build the pin through the real current read in this selected auth scope.
  const { readSkill } = await import("../src/snapshot.ts")
  const read = await f.run(readSkill(skillPage, { database: library.skills.database_id }))
  expect(read.snapshot_id).not.toBe("")
  const stored = await f.run(
    Effect.flatMap(Store, (store) =>
      store.readJson(`snapshots/${read.snapshot_id}.json`, SnapshotSchema),
    ),
  )
  expect(stored?.scope).toBe(scope)
  f.clearCalls()
  const ref = fileRef(read.record.id, "SKILL.md", read.snapshot_id)
  const selected = await f.run(resolveSharedMaintenanceTarget(ref))
  expect(selected.page_id).toBe(skillPage)
  expect(selected.pin).toBe(read.snapshot_id)
  expect(f.readBodyCount()).toBe(0)
  expect(f.objectReads).toHaveLength(0)
  const wrong = fileRef(read.record.id, "references/other.md", read.snapshot_id)
  const rejected = await f.run(resolveSharedMaintenanceTarget(wrong).pipe(Effect.result))
  expect(rejected).toMatchObject({ _tag: "Failure", failure: { code: "EXACT_TARGET_REQUIRED" } })
})

test("half-registered direct pages remain diagnosable while display names and foreign entries never broaden scope", async () => {
  const f = sharedSnapshotFixture({ fileCount: 1 })
  property(f.main.properties).main_file_id = {
    id: "main_file_id",
    type: "rich_text",
    rich_text: [],
  }
  expect((await f.run(resolveSharedMaintenanceTarget(skillPage))).page_id).toBe(skillPage)
  f.clearCalls()
  const named = await f.run(resolveSharedMaintenanceTarget("Managed Name").pipe(Effect.result))
  expect(named).toMatchObject({ _tag: "Failure", failure: { code: "EXACT_TARGET_REQUIRED" } })
  expect(f.calls).toHaveLength(0)
  const wrong = await f.run(
    resolveSharedMaintenanceTarget(skillPage, "ffffffff-ffff-4fff-8fff-ffffffffffff").pipe(
      Effect.result,
    ),
  )
  expect(wrong).toMatchObject({ _tag: "Failure", failure: { code: "MAINTENANCE_TARGET_SCOPE" } })
  expect(f.writeCount()).toBe(0)
})

test("one filtered shared identity still requires complete pagination and rejects a duplicated identity", async () => {
  const f = sharedSnapshotFixture({ fileCount: 1 })
  const ref = fileRef(`shared_skill:${library.library_id}:stable-skill`, "SKILL.md")
  const action = resolveSharedMaintenanceTarget(ref, library.skills.database_id)
  const result = await f.run(action)
  expect(result.page_id).toBe(skillPage)
  const queries = f.calls.filter((call) => call.path.includes("/query"))
  expect(queries).toHaveLength(1)
  expect(property(queries[0]!.body).filter).toEqual({
    property: library.skills.property_ids["Skill ID"],
    rich_text: { equals: "stable-skill" },
  })
  const duplicate = { ...structuredClone(f.main), id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }
  const rejected = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* action.pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) =>
            path.includes(`/data_sources/${library.skills.data_source_id}/query`)
              ? Effect.succeed({
                  object: "list",
                  results: [f.main, duplicate],
                  has_more: false,
                  next_cursor: null,
                })
              : api.request(path, body, options),
        }),
      )
    }).pipe(Effect.result),
  )
  expect(rejected).toMatchObject({
    _tag: "Failure",
    failure: { code: "MAINTENANCE_TARGET_AMBIGUOUS" },
  })
  const partial = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* action.pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) =>
            path.includes(`/data_sources/${library.skills.data_source_id}/query`)
              ? Effect.succeed({
                  object: "list",
                  results: [f.main],
                  has_more: true,
                  next_cursor: null,
                })
              : api.request(path, body, options),
        }),
      )
    }).pipe(Effect.result),
  )
  expect(partial).toMatchObject({
    _tag: "Failure",
    failure: { code: "MAINTENANCE_TARGET_INCOMPLETE" },
  })
})
