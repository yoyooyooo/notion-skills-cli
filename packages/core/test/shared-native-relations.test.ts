import { describe, expect, test } from "bun:test"
import { Crypto, Effect, FileSystem, Path, Schema } from "effect"
import { HttpClient } from "effect/http"
import { Notion } from "../src/notion.ts"
import { Store, sha256 } from "../src/store.ts"
import { fail, property, SkillsError, SnapshotSchema, text } from "../src/model.ts"
import { LIBRARY_MARKER, type SharedLibrary } from "../src/shared-library-model.ts"
import { sharedSkillProperties } from "../src/shared-library.ts"
import {
  executeSharedRelationSchema,
  prepareSharedRelationSchema,
} from "../src/shared-library-relations.ts"
import { sharedSnapshotVersion } from "../src/shared-snapshot-identity.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { openSharedSnapshot } from "../src/shared-snapshot.ts"
import { snapshotInfo } from "../src/snapshot.ts"
import {
  sharedSnapshotFixture,
  library,
  skillPage,
  id,
  rich,
  digest,
} from "./shared-snapshot-fixture.ts"

type Runtime =
  | Notion
  | Store
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient

function schemaFixture(fault?: { step: "schema" | "descriptor"; accepted: boolean }) {
  const f = sharedSnapshotFixture()
  let registered: SharedLibrary = structuredClone(library)
  const fields: Record<string, unknown> = Object.fromEntries(
    Object.entries(sharedSkillProperties).map(([name, shape]) => [
      "Renamed " + name,
      {
        ...shape,
        id: library.skills.property_ids[name],
        type: Object.keys(shape)[0],
        name: "Renamed " + name,
      },
    ]),
  )
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  const database = () => ({
    object: "database",
    id: library.skills.database_id,
    parent: { page_id: library.parent_page_id },
    description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(registered) }],
    data_sources: [{ id: library.skills.data_source_id }],
    in_trash: false,
  })
  const dataSource = () => ({
    object: "data_source",
    id: library.skills.data_source_id,
    parent: { database_id: library.skills.database_id },
    properties: structuredClone(fields),
    in_trash: false,
  })
  const run = <A, E>(effect: Effect.Effect<A, E, Runtime>) =>
    f.run(
      Effect.gen(function* () {
        const original = yield* Notion
        const api: Notion["Service"] = {
          ...original,
          request: (path, body, options) =>
            Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
              const method = options?.method ?? (body === undefined ? "GET" : "POST")
              if (path === `v1/databases/${library.skills.database_id}`) {
                calls.push({ path, method, body })
                if (method === "PATCH") {
                  const unknown = fault?.step === "descriptor" ? fault : undefined
                  if (unknown === undefined || unknown.accepted) {
                    const next: unknown = JSON.parse(
                      text(property(body).description).slice(LIBRARY_MARKER.length),
                    )
                    if (typeof next !== "object" || next === null)
                      throw new Error("Invalid fixture descriptor")
                    registered = Schema.decodeUnknownSync(SharedLibrarySchemaForFixture)(next)
                  }
                  if (unknown !== undefined)
                    return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Lost descriptor response"))
                }
                return Effect.succeed(database())
              }
              if (path === `v1/data_sources/${library.skills.data_source_id}`) {
                calls.push({ path, method, body })
                if (method === "PATCH") {
                  const unknown = fault?.step === "schema" ? fault : undefined
                  if (unknown === undefined || unknown.accepted)
                    for (const [name, raw] of Object.entries(property(property(body).properties))) {
                      const value = property(raw)
                      fields[name] = {
                        ...value,
                        id: `relation-${name.toLowerCase()}`,
                        name,
                        type: "relation",
                        relation: { ...property(value.relation), type: "single_property" },
                      }
                    }
                  if (unknown !== undefined)
                    return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Lost schema response"))
                }
                return Effect.succeed(dataSource())
              }
              return original.request(path, body, options)
            }),
        }
        return yield* effect.pipe(Effect.provideService(Notion, api))
      }),
    )
  return {
    ...f,
    run,
    fields,
    calls,
    current: () => registered,
    clearFault: () => {
      fault = undefined
    },
  }
}
// Decode the same public descriptor contract; a fixture never invents stable identities.
import { SharedLibrarySchema as SharedLibrarySchemaForFixture } from "../src/shared-library-model.ts"

function errorCode<A>(
  result: { _tag: "Success"; success: A } | { _tag: "Failure"; failure: unknown },
) {
  if (result._tag !== "Failure" || !(result.failure instanceof SkillsError))
    throw new Error("Expected SkillsError")
  return result.failure.code
}

describe("native Skill relation schema", () => {
  test("plans without writes, registers both exact self-relations, reads back and repeats without PATCH", async () => {
    const f = schemaFixture()
    const plan = await f.run(prepareSharedRelationSchema(library.skills.database_id))
    expect(plan.additions).toEqual(["Members", "Requires"])
    expect(f.calls.every((call) => call.method === "GET")).toBe(true)
    expect(f.records.size).toBe(0)
    const applied = await f.run(executeSharedRelationSchema(plan))
    expect(applied.verified).toBe(true)
    expect(applied.library.skills.property_ids.Members).toBe("relation-members")
    expect(applied.library.skills.property_ids.Requires).toBe("relation-requires")
    expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(2)
    const previous = f.calls.length
    const repeated = await f.run(executeSharedRelationSchema(plan))
    expect(repeated.status).toBe("unchanged")
    expect(f.calls.slice(previous).every((call) => call.method === "GET")).toBe(true)
    expect(f.bodies.get(skillPage)).toBe("# Native main\n")
    expect(f.current().files).toEqual(library.files)
  })

  test("renames preserve registered property IDs; delete and recreate cannot match by name", async () => {
    const f = schemaFixture()
    const plan = await f.run(prepareSharedRelationSchema(library.skills.database_id))
    await f.run(executeSharedRelationSchema(plan))
    f.fields["必读前置"] = f.fields.Requires
    delete f.fields.Requires
    const afterRename = await f.run(prepareSharedRelationSchema(library.skills.database_id))
    expect(afterRename.additions).toEqual([])
    f.fields["必读前置"] = { ...property(f.fields["必读前置"]), id: "replacement-id" }
    expect(
      errorCode(
        await f.run(prepareSharedRelationSchema(library.skills.database_id).pipe(Effect.result)),
      ),
    ).toBe("LIBRARY_SCHEMA_CONFLICT")
  })

  test.each([true, false])(
    "unknown schema response accepted=%s is never replayed",
    async (accepted) => {
      const f = schemaFixture({ step: "schema", accepted })
      const plan = await f.run(prepareSharedRelationSchema(library.skills.database_id))
      expect(errorCode(await f.run(executeSharedRelationSchema(plan).pipe(Effect.result)))).toBe(
        "WRITE_OUTCOME_UNKNOWN",
      )
      const firstPatches = f.calls.filter((call) => call.method === "PATCH").length
      const reconciled = await f.run(executeSharedRelationSchema(plan, "reconcile"))
      expect(reconciled.status).toBe(accepted ? "registration_pending" : "schema_unresolved")
      expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(firstPatches)
      f.clearFault()
      if (accepted) {
        const completed = await f.run(executeSharedRelationSchema(plan))
        expect(completed.verified).toBe(true)
        expect(
          f.calls.filter((call) => call.method === "PATCH" && call.path.includes("data_sources")),
        ).toHaveLength(1)
      } else {
        for (const key of f.json.keys())
          if (key.startsWith("operations/shared-relation-schema/")) f.json.delete(key)
        expect(errorCode(await f.run(executeSharedRelationSchema(plan).pipe(Effect.result)))).toBe(
          "RELATION_SCHEMA_UNKNOWN",
        )
        expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(firstPatches)
      }
    },
  )

  test.each([true, false])(
    "unknown descriptor response accepted=%s only reconciles the original dispatch",
    async (accepted) => {
      const f = schemaFixture({ step: "descriptor", accepted })
      const plan = await f.run(prepareSharedRelationSchema(library.skills.database_id))
      expect(errorCode(await f.run(executeSharedRelationSchema(plan).pipe(Effect.result)))).toBe(
        "WRITE_OUTCOME_UNKNOWN",
      )
      f.clearFault()
      const count = f.calls.filter((call) => call.method === "PATCH").length
      const next = await f.run(executeSharedRelationSchema(plan).pipe(Effect.result))
      if (accepted) {
        expect(next._tag).toBe("Success")
        if (next._tag === "Success") expect(next.success.verified).toBe(true)
      } else expect(errorCode(next)).toBe("RELATION_SCHEMA_UNKNOWN")
      expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(count)
    },
  )

  test("unregistered same-name fields and tampered plans fail before writes", async () => {
    const f = schemaFixture()
    const plan = await f.run(prepareSharedRelationSchema(library.skills.database_id))
    f.fields.Requires = {
      id: "foreign",
      type: "relation",
      relation: { data_source_id: id(999), type: "single_property", single_property: {} },
    }
    expect(errorCode(await f.run(executeSharedRelationSchema(plan).pipe(Effect.result)))).toBe(
      "RELATION_SCHEMA_CONFLICT",
    )
    expect(
      errorCode(
        await f.run(executeSharedRelationSchema({ ...plan, additions: [] }).pipe(Effect.result)),
      ),
    ).toBe("RELATION_SCHEMA_INVALID")
    expect(f.calls.every((call) => call.method === "GET")).toBe(true)
  })
})

describe("native relation snapshots", () => {
  test("ordinary Skill exports lightweight members/required and reads no selected target bodies", async () => {
    const f = sharedSnapshotFixture()
    const registered = {
      ...library,
      skills: {
        ...library.skills,
        property_ids: { ...library.skills.property_ids, Members: "members", Requires: "requires" },
      },
    }
    for (const field of ["members", "requires"])
      property(f.main.properties)[field] = {
        id: field,
        type: "relation",
        relation: [{ id: id(90) }],
        has_more: false,
      }
    const target = structuredClone(f.main)
    target.id = id(90)
    property(target.properties).skill_id = rich("skill_id", "target-skill")
    property(target.properties).title = {
      id: "title",
      type: "title",
      title: [{ plain_text: "Target" }],
    }
    const snapshot = await f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* openSharedSnapshot({
          library: registered,
          rawPage: f.main,
          target: skillPage,
          scope: digest("shared-fixture-scope"),
          startedAt: Date.now(),
        }).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) =>
              path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`)
                ? Effect.succeed({
                    object: "list",
                    results: [f.main, target],
                    has_more: false,
                    next_cursor: null,
                  })
                : api.request(path, body, options),
          }),
        )
      }),
    )
    expect(snapshot.members).toHaveLength(1)
    expect(snapshot.required).toHaveLength(1)
    expect(snapshot.router_members).toBeUndefined()
    const info = snapshotInfo(snapshot)
    expect(info.members).toEqual(snapshot.members)
    expect(info.required).toEqual(snapshot.required)
    expect(f.readBodyCount()).toBe(3)
    expect(f.calls.some((call) => call.path.includes(`/${id(90)}/markdown`))).toBe(false)
    const main = snapshot.files.find((file) => file.path === "SKILL.md")
    if (!main) throw new Error("Missing main")
    expect(new TextDecoder().decode(f.objects.get(`objects/${main.sha256}`))).toContain(
      "## Members",
    )
    expect(f.bodies.get(skillPage)).toBe("# Native main\n")
  })

  test("old snapshots serialize identically and absent relation fields retain the exact historical hash input", async () => {
    const f = sharedSnapshotFixture()
    const old = await f.open()
    const legacy = f.json.get(`snapshots/${old.snapshot_id}.json`)
    const decoded = Schema.decodeUnknownSync(SnapshotSchema)(legacy)
    expect(decoded.members).toBeUndefined()
    expect(decoded.required).toBeUndefined()
    expect(JSON.stringify(decoded)).toBe(JSON.stringify(legacy))
    const input = { record: old.record, files: old.files, source: null, ownership: [] }
    const expected = await f.run(sha256(canonicalSharedJson({ version: 1, ...input })))
    expect(await f.run(sharedSnapshotVersion(input))).toBe(expected)
    expect(
      await f.run(sharedSnapshotVersion({ ...input, members: undefined, required: undefined })),
    ).toBe(expected)
    expect(await f.run(sharedSnapshotVersion({ ...input, members: [], required: [] }))).not.toBe(
      expected,
    )
  })
})
