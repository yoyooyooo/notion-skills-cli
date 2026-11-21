import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import type { SharedLibrary } from "../src/shared-library-model.ts"
import { registeredSkillProperties } from "../src/shared-library.ts"
import { inspectSharedRelationSchema } from "../src/shared-library-relations.ts"
import { openSharedSnapshot } from "../src/shared-snapshot.ts"
import { snapshotInfo } from "../src/snapshot.ts"
import {
  currentSnapshotFixture,
  currentLibrary,
  currentSkillPage,
  currentScope,
  currentId,
  currentRich,
} from "./shared-current-fixture.ts"

const relatedLibrary: SharedLibrary = {
  ...currentLibrary,
  skills: {
    ...currentLibrary.skills,
    property_ids: {
      ...currentLibrary.skills.property_ids,
      Members: "members",
      Requires: "requires",
    },
  },
}
function schemaFixture(library = relatedLibrary) {
  const f = currentSnapshotFixture({ fileCount: 0 })
  const fields: Record<string, unknown> = Object.fromEntries(
    Object.entries(registeredSkillProperties(library.skills)).map(([name, shape]) => [
      "Renamed " + name,
      {
        ...shape,
        id: library.skills.property_ids[name],
        type: Object.keys(shape)[0],
        ...(property(shape).relation === undefined
          ? {}
          : {
              relation: {
                ...property(property(shape).relation),
                type: "single_property",
              },
            }),
      },
    ]),
  )
  const calls: string[] = []
  const inspect = () =>
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* inspectSharedRelationSchema(library).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) => {
              expect(body).toBeUndefined()
              expect(options?.method ?? "GET").toBe("GET")
              calls.push(path)
              if (path === `v1/databases/${library.skills.database_id}`)
                return Effect.succeed({
                  id: library.skills.database_id,
                  parent: { page_id: library.parent_page_id },
                  data_sources: [{ id: library.skills.data_source_id }],
                  in_trash: false,
                })
              if (path === `v1/data_sources/${library.skills.data_source_id}`)
                return Effect.succeed({
                  id: library.skills.data_source_id,
                  parent: { database_id: library.skills.database_id },
                  properties: fields,
                  in_trash: false,
                })
              return api.request(path, body, options)
            },
          }),
        )
      }),
    )
  return { fields, calls, inspect }
}

describe("current native relation schema", () => {
  test("read-only inspection follows registered IDs across display renames", async () => {
    const f = schemaFixture()
    const result = await f.inspect()
    expect(result.ready).toBe(true)
    expect(result.bindings).toEqual({
      Members: "members",
      Requires: "requires",
    })
    expect(result.next_action).toBeNull()
    expect(f.calls).toHaveLength(2)
    f.fields["Another display name"] = f.fields["Renamed Members"]
    delete f.fields["Renamed Members"]
    expect((await f.inspect()).ready).toBe(true)
    property(f.fields["Another display name"]).id = "a-recreated-property"
    await expect(f.inspect()).rejects.toMatchObject({
      code: "LIBRARY_SCHEMA_CONFLICT",
    })
  })

  test("missing bindings are explicit and do not advertise a retired upgrade command", async () => {
    const missing = structuredClone(currentLibrary)
    delete missing.skills.property_ids.Members
    delete missing.skills.property_ids.Requires
    const f = schemaFixture(missing)
    const result = await f.inspect()
    expect(result.ready).toBe(false)
    expect(result.missing).toEqual(["Members", "Requires"])
    expect(result.next_action).toBe("register_current_relation_properties")
    expect(result).not.toHaveProperty("upgrade_argv")
    expect(f.calls).toHaveLength(2)
  })

  test("inspection rejects a changed relation target and repeated property identity", async () => {
    const f = schemaFixture()
    property(property(f.fields["Renamed Members"]).relation).data_source_id = currentId(99)
    await expect(f.inspect()).rejects.toMatchObject({
      code: "LIBRARY_SCHEMA_CONFLICT",
    })
    property(property(f.fields["Renamed Members"]).relation).data_source_id =
      relatedLibrary.skills.data_source_id
    f.fields.Duplicate = structuredClone(f.fields["Renamed Members"])
    await expect(f.inspect()).rejects.toMatchObject({
      code: "LIBRARY_SCHEMA_CONFLICT",
    })
  })
})

test("ordinary current reads expose Members and Requires without downloading their bodies", async () => {
  const f = currentSnapshotFixture({ fileCount: 1 })
  const author = f.bodies.get(currentSkillPage)
  for (const field of ["members", "requires"])
    property(f.main.properties)[field] = {
      id: field,
      type: "relation",
      relation: [{ id: currentId(90) }],
      has_more: false,
    }
  const target = structuredClone(f.main)
  target.id = currentId(90)
  property(target.properties)["Skill ID"] = currentRich("skill-id", "target-skill")
  property(target.properties)["Main File ID"] = currentRich("main-id", "main-target")
  property(target.properties).Name = {
    id: "title",
    type: "title",
    title: [{ plain_text: "Target" }],
  }
  const selected = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* openSharedSnapshot({
        library: relatedLibrary,
        rawPage: f.main,
        target: currentSkillPage,
        scope: currentScope,
        startedAt: Date.now(),
      }).pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) =>
            path.startsWith(`v1/data_sources/${currentLibrary.skills.data_source_id}/query`)
              ? Effect.succeed({
                  object: "list",
                  results: [target],
                  has_more: false,
                  next_cursor: null,
                })
              : api.request(path, body, options),
        }),
      )
    }),
  )
  expect(selected.members).toHaveLength(1)
  expect(selected.required).toHaveLength(1)
  expect(selected.router_members).toBeUndefined()
  expect(snapshotInfo(selected).members).toEqual(selected.members)
  expect(snapshotInfo(selected).required).toEqual(selected.required)
  expect(f.bodyCalls()).toHaveLength(2)
  expect(f.calls.some((call) => call.path.includes(`/${target.id}/markdown`))).toBe(false)
  expect(f.bodies.get(currentSkillPage)).toBe(author)
  expect(f.semanticWrites()).toHaveLength(0)
})
