import { expect, test } from "bun:test"
import { Effect } from "effect"
import { fail, property, type SkillsError } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { initializeCurrentSourceRelations } from "../src/shared-sources-library.ts"
import type { SharedLibrary, TableBinding } from "../src/shared-library-model.ts"
import { currentId as id, currentLibrary } from "./shared-current-fixture.ts"

function fixture() {
  const unregistered = (table: TableBinding) => ({
    ...table,
    property_ids: Object.fromEntries(
      Object.entries(table.property_ids).filter(([name]) => name !== "Origin"),
    ),
  })
  const library: SharedLibrary = {
    ...structuredClone(currentLibrary),
    skills: unregistered(currentLibrary.skills),
    records: unregistered(currentLibrary.records),
    files: {
      ...currentLibrary.files,
      property_ids: { ...unregistered(currentLibrary.files).property_ids, Skill: "a%5B_t" },
    },
    sources: {
      database_id: id(80),
      data_source_id: id(81),
      property_ids: { Skills: "source-skills", Records: "source-records" },
    },
  }
  const relation = (id: string, target: string, reverse: string) => ({
    id,
    type: "relation",
    relation: {
      type: "dual_property",
      data_source_id: target,
      dual_property: { synced_property_id: reverse },
    },
  })
  const row = (table: TableBinding, properties: Record<string, unknown>) => ({
    object: "data_source",
    id: table.data_source_id,
    parent: { database_id: table.database_id },
    in_trash: false,
    properties,
  })
  const rows = new Map<string, ReturnType<typeof row>>([
    [
      library.sources!.data_source_id,
      row(library.sources!, {
        Skills: relation("source-skills", library.skills.data_source_id, "skill%3Aorigin"),
        Records: relation("source-records", library.records.data_source_id, "record-origin"),
      }),
    ],
    [
      library.skills.data_source_id,
      row(library.skills, {
        Origin: relation("skill%3Aorigin", library.sources!.data_source_id, "source-skills"),
      }),
    ],
    [
      library.records.data_source_id,
      row(library.records, {
        Origin: relation("record-origin", library.sources!.data_source_id, "source-records"),
      }),
    ],
    [library.files.data_source_id, row(library.files, {})],
  ])
  const writes: Array<{ path: string; body: unknown }> = []
  let unknown: "accepted" | "absent" | undefined
  const api: Notion["Service"] = {
    credentialIdentity: Effect.succeed("current-schema"),
    version: Effect.succeed("fixture"),
    request: (path, body, options) =>
      Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
        const ds = path.replace("v1/data_sources/", ""),
          saved = rows.get(ds)
        if (!saved) return Effect.fail(fail("TEST_UNEXPECTED", path))
        if (body === undefined && options?.method === undefined)
          return Effect.succeed(structuredClone(saved))
        if (ds !== library.files.data_source_id || options?.method !== "PATCH")
          return Effect.fail(fail("TEST_UNEXPECTED_WRITE", path))
        writes.push({ path, body: structuredClone(body) })
        const fault = unknown
        unknown = undefined
        if (fault !== "absent") {
          const rollup = property(property(property(body).properties).Origin).rollup
          const decoded = property(rollup)
          saved.properties.Origin = {
            id: "file-origin",
            type: "rollup",
            rollup: {
              ...decoded,
              relation_property_id: decodeURIComponent(String(decoded.relation_property_id)),
              rollup_property_id: decodeURIComponent(String(decoded.rollup_property_id)),
            },
          }
        }
        return fault
          ? Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "The response was lost"))
          : Effect.succeed(structuredClone(saved))
      }),
  }
  return {
    library,
    rows,
    writes,
    unknown: (fault: "accepted" | "absent") => {
      unknown = fault
    },
    run: <A>(effect: Effect.Effect<A, SkillsError, Notion>) =>
      Effect.runPromise(effect.pipe(Effect.provideService(Notion, api))),
  }
}

test("current Sources relations bind exact reverse identities and one decoded Files rollup, then repeat without writes", async () => {
  const f = fixture()
  const completed = await f.run(initializeCurrentSourceRelations(f.library, false))
  expect(completed.skills.property_ids.Origin).toBe("skill%3Aorigin")
  expect(completed.records.property_ids.Origin).toBe("record-origin")
  expect(completed.files.property_ids.Origin).toBe("file-origin")
  expect(f.writes).toHaveLength(1)
  expect(await f.run(initializeCurrentSourceRelations(completed, false))).toEqual(completed)
  expect(await f.run(initializeCurrentSourceRelations(completed, true))).toEqual(completed)
  expect(f.writes).toHaveLength(1)
})

test("current initialization rejects foreign source and reverse relation ownership before any write", async () => {
  for (const wrong of ["source-owner", "reverse-target", "reverse-property"] as const) {
    const f = fixture()
    if (wrong === "source-owner")
      f.rows.get(f.library.sources!.data_source_id)!.parent.database_id = id(999)
    else {
      const reverse = property(f.rows.get(f.library.skills.data_source_id)!.properties.Origin)
      if (wrong === "reverse-target") property(reverse.relation).data_source_id = id(999)
      else
        property(property(reverse.relation).dual_property).synced_property_id =
          "another-source-property"
    }
    const result = await f.run(
      initializeCurrentSourceRelations(f.library, false).pipe(Effect.result),
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        code: "LIBRARY_SCHEMA_CONFLICT",
        details: { operation_id: f.library.operation_id },
      },
    })
    expect(f.writes).toHaveLength(0)
  }
})

test("an accepted unknown rollup is resolved from current schema without an ACK ledger or another PATCH", async () => {
  const f = fixture()
  f.unknown("accepted")
  const first = await f.run(initializeCurrentSourceRelations(f.library, false).pipe(Effect.result))
  expect(first).toMatchObject({
    _tag: "Failure",
    failure: {
      code: "WRITE_OUTCOME_UNKNOWN",
      details: { operation_id: f.library.operation_id, role: "Sources", stage: "origins" },
    },
  })
  const current = await f.run(initializeCurrentSourceRelations(f.library, true))
  expect(current.files.property_ids.Origin).toBe("file-origin")
  expect(f.writes).toHaveLength(1)
})

test("an absent unknown rollup stays incomplete on reconciliation without replaying its write", async () => {
  const f = fixture()
  f.unknown("absent")
  await f.run(initializeCurrentSourceRelations(f.library, false).pipe(Effect.result))
  const resumed = await f.run(initializeCurrentSourceRelations(f.library, true).pipe(Effect.result))
  expect(resumed).toMatchObject({ _tag: "Failure", failure: { code: "LIBRARY_INIT_INCOMPLETE" } })
  expect(f.writes).toHaveLength(1)
  expect(f.rows.get(f.library.files.data_source_id)!.properties.Origin).toBeUndefined()
})
