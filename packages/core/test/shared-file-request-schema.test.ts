import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fail, property, SkillsError, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import {
  fileRequestProperty,
  fileRequestResultProperty,
  fileRequestReceiptProperty,
  initializeSharedFileRequests,
  registerSharedFileProperties,
} from "../src/shared-file-request-schema.ts"
import { LIBRARY_MARKER, type SharedLibrary } from "../src/shared-library-model.ts"
import { library, sharedSnapshotFixture } from "./shared-snapshot-fixture.ts"

function fixture() {
  const f = sharedSnapshotFixture()
  let descriptor = LIBRARY_MARKER + JSON.stringify(library)
  let unknown: boolean | undefined
  const schemas = new Map(
    [library.skills, library.files].map((table) => [
      table.data_source_id,
      {
        object: "data_source",
        id: table.data_source_id,
        parent: { database_id: table.database_id },
        properties: {} as Record<string, unknown>,
      },
    ]),
  )
  const run: typeof f.run = (effect) =>
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        const controlled: Notion["Service"] = {
          ...api,
          request: (path, body, options) =>
            Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
              const method = options?.method ?? (body === undefined ? "GET" : "POST")
              if (path === `v1/databases/${library.skills.database_id}`) {
                if (method === "PATCH") {
                  f.calls.push({ path, method, body })
                  descriptor = text(property(body).description)
                }
                return api.request(path).pipe(
                  Effect.map((row) => ({
                    ...property(row),
                    description: [{ plain_text: descriptor }],
                  })),
                )
              }
              const schema = [...schemas.values()].find(
                (row) => path === `v1/data_sources/${row.id}`,
              )
              if (schema !== undefined) {
                f.calls.push({ path, method, body })
                if (method === "PATCH") {
                  const accepted = unknown !== false
                  if (accepted)
                    for (const [name, value] of Object.entries(property(property(body).properties)))
                      schema.properties[name] = {
                        id: `${schema.id === library.skills.data_source_id ? "s" : "f"}-${name === fileRequestProperty ? "request" : name === fileRequestReceiptProperty ? "receipt" : "result"}`,
                        name,
                        type: Object.keys(property(value))[0],
                        ...property(value),
                        ...(property(value).rollup === undefined
                          ? {}
                          : {
                              // Captured Notion schema: property.id is URL-encoded; nested rollup IDs are raw.
                              rollup: {
                                ...property(property(value).rollup),
                                relation_property_id: decodeURIComponent(
                                  String(property(property(value).rollup).relation_property_id),
                                ),
                                rollup_property_id: decodeURIComponent(
                                  String(property(property(value).rollup).rollup_property_id),
                                ),
                              },
                            }),
                      }
                  if (unknown !== undefined) {
                    unknown = undefined
                    return Effect.fail(
                      fail("WRITE_OUTCOME_UNKNOWN", "Injected schema response loss"),
                    )
                  }
                }
                return Effect.succeed(structuredClone(schema))
              }
              return api.request(path, body, options)
            }),
        }
        return yield* effect.pipe(Effect.provideService(Notion, controlled))
      }),
    )
  return {
    ...f,
    run,
    schemas,
    unknown: (accepted: boolean) => {
      unknown = accepted
    },
    patches: () => f.calls.filter((call) => call.method === "PATCH"),
  }
}

describe("native file request schema", () => {
  test("captured raw rollup references match encoded stable IDs and renamed labels cannot substitute a different target", async () => {
    const f = fixture()
    const input = {
      namespace: "rollup-fixture",
      properties: () => ({
        "Selected Revision": {
          rollup: {
            relation_property_id: "%7DAIm",
            rollup_property_id: "%5DRi_",
            function: "show_original",
          },
        },
      }),
      writerContract: {},
    }
    const result = await f.run(registerSharedFileProperties(library, input))
    expect(result.status).toBe("verified_applied")
    if (!("library" in result) || result.library === undefined)
      throw new Error("Missing registered library")
    const rollup = property(
      property(f.schemas.get(library.files.data_source_id)!.properties["Selected Revision"]).rollup,
    )
    expect(rollup.relation_property_id).toBe("}AIm")
    expect(rollup.rollup_property_id).toBe("]Ri_")
    rollup.rollup_property_id = "another-stable-field"
    rollup.rollup_property_name = "Selected Revision"
    f.clearCalls()
    await expect(f.run(registerSharedFileProperties(result.library, input))).rejects.toMatchObject({
      code: "SHARED_FILE_REQUEST_SCHEMA",
    })
    expect(f.patches()).toHaveLength(0)
  })
  test("dry-run plans independent user/result fields on both main and supporting tables without writes", async () => {
    const f = fixture()
    const result = await f.run(initializeSharedFileRequests(library, true))
    expect(result.status).toBe("planned")
    expect("tables" in result && result.tables?.map((table) => table.role)).toEqual([
      "skills",
      "files",
    ])
    expect(f.patches()).toHaveLength(0)
    expect(
      [...f.schemas.values()].every((schema) => Object.keys(schema.properties).length === 0),
    ).toBe(true)
  })

  test("schema creation registers stable property IDs once and survives property display renaming", async () => {
    const f = fixture()
    const result = await f.run(initializeSharedFileRequests(library))
    expect(result.status).toBe("verified_applied")
    if (!("library" in result) || result.library === undefined)
      throw new Error("Missing registered library")
    const registered: SharedLibrary = result.library
    expect(registered.skills.property_ids[fileRequestProperty]).toBe("s-request")
    expect(registered.files.property_ids[fileRequestResultProperty]).toBe("f-result")
    expect(registered.files.property_ids[fileRequestReceiptProperty]).toBe("f-receipt")
    expect(f.patches()).toHaveLength(3)
    expect(f.patches().some((call) => call.path.includes("/pages/"))).toBe(false)
    const skills = f.schemas.get(library.skills.data_source_id)!
    skills.properties["Request renamed in UI"] = skills.properties[fileRequestProperty]
    delete skills.properties[fileRequestProperty]
    f.clearCalls()
    expect((await f.run(initializeSharedFileRequests(registered))).status).toBe("unchanged")
    expect(f.patches()).toHaveLength(0)
  })

  test("a colliding ordinary property is not converted or cleared", async () => {
    const f = fixture(),
      schema = f.schemas.get(library.files.data_source_id)!
    schema.properties[fileRequestProperty] = {
      id: "existing-user-text",
      type: "rich_text",
      rich_text: {},
    }
    await expect(f.run(initializeSharedFileRequests(library))).rejects.toMatchObject({
      code: "SHARED_FILE_REQUEST_SCHEMA",
    })
    expect(f.patches()).toHaveLength(0)
    expect(property(schema.properties[fileRequestProperty]).type).toBe("rich_text")
  })

  test("an unregistered same-name property with a matching type is not claimed without its original schema receipt", async () => {
    const f = fixture()
    for (const schema of f.schemas.values())
      for (const [name, shape] of Object.entries({
        [fileRequestProperty]: {
          select: { options: [{ name: "none" }, { name: "restore-follow" }] },
        },
        [fileRequestResultProperty]: { rich_text: {} },
        [fileRequestReceiptProperty]: { rich_text: {} },
      }))
        schema.properties[name] = { id: `unowned-${name}`, type: Object.keys(shape)[0], ...shape }
    await expect(f.run(initializeSharedFileRequests(library))).rejects.toMatchObject({
      code: "SHARED_FILE_REQUEST_SCHEMA",
    })
    expect(f.patches()).toHaveLength(0)
  })

  test.each([false, true])(
    "an unknown schema write (accepted: %s) cannot replay or use matching fields as an acknowledgment",
    async (accepted) => {
      const f = fixture()
      f.unknown(accepted)
      await expect(f.run(initializeSharedFileRequests(library))).rejects.toMatchObject({
        code: "SOURCE_WRITE_UNKNOWN",
      })
      f.clearCalls()
      if (accepted)
        expect((await f.run(initializeSharedFileRequests(library))).status).toBe("unknown")
      else
        await expect(f.run(initializeSharedFileRequests(library))).rejects.toMatchObject({
          code: "SOURCE_WRITE_UNKNOWN",
        })
      expect(f.patches()).toHaveLength(0)
    },
  )
})
