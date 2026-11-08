import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { property, type SkillsError } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { listSharedFileRequests } from "../src/shared-file-request.ts"
import {
  fileRequestProperty,
  fileRequestResultProperty,
  fileRequestReceiptProperty,
} from "../src/shared-file-request-schema.ts"
import {
  sharedSnapshotFixture,
  library as base,
  skillPage,
  id,
  rich,
} from "./shared-snapshot-fixture.ts"

const fields = {
  [fileRequestProperty]: "request",
  [fileRequestResultProperty]: "result",
  [fileRequestReceiptProperty]: "receipt",
}
const library = {
  ...base,
  skills: { ...base.skills, property_ids: { ...base.skills.property_ids, ...fields } },
  files: { ...base.files, property_ids: { ...base.files.property_ids, ...fields } },
}
function fixture(count = 401) {
  const f = sharedSnapshotFixture({ fileCount: count })
  for (const row of [f.main, ...f.files]) {
    property(row.properties).request = { id: "request", type: "select", select: { name: "none" } }
    property(row.properties).result = rich("result", "")
    property(row.properties).receipt = rich("receipt", "")
  }
  const select = (row: { properties?: unknown }) => {
    property(row.properties).request = {
      id: "request",
      type: "select",
      select: { name: "restore-follow" },
    }
  }
  const fault: { row?: Record<string, unknown>; cursor?: boolean } = {}
  const run = () =>
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        const controlled: Notion["Service"] = {
          ...api,
          request: (path, body, options) =>
            Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
              if (path === `v1/data_sources/${library.files.data_source_id}/query`) {
                f.calls.push({ path, body, method: "POST" })
                const filter = property(property(body).filter).and
                expect(filter).toEqual([
                  { property: "skill", relation: { contains: skillPage } },
                  { property: "request", select: { equals: "restore-follow" } },
                ])
                if (fault.cursor)
                  return Effect.succeed({
                    object: "list",
                    results: [],
                    has_more: true,
                    next_cursor: "repeated",
                  })
                const rows = fault.row
                  ? [fault.row]
                  : f.files.filter(
                      (row) =>
                        property(property(property(row.properties).request).select).name ===
                        "restore-follow",
                    )
                const offset = Number(property(body).start_cursor ?? 0),
                  end = offset + 100
                return Effect.succeed({
                  object: "list",
                  results: structuredClone(rows.slice(offset, end)),
                  has_more: rows.length > end,
                  next_cursor: rows.length > end ? String(end) : null,
                })
              }
              return api.request(path, body, options)
            }),
        }
        return yield* listSharedFileRequests(library, [skillPage]).pipe(
          Effect.provideService(Notion, controlled),
        )
      }),
    )
  return { ...f, run, select, fault }
}

describe("metadata-only native request inventory", () => {
  test("400 supporting files with two requests need one Skill read and one filtered query, with zero body/provider/writes", async () => {
    const f = fixture()
    f.select(f.main)
    f.select(f.files[3]!)
    f.select(f.files[399]!)
    const result = await f.run()
    expect(result.status).toBe("complete")
    expect(result.requests.map((request) => request.file_id)).toEqual([
      "file-main",
      "file-4",
      "file-400",
    ])
    expect(result.requests[0]?.kind).toBe("main")
    expect(f.calls).toHaveLength(2)
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
  })

  test("101 requested references are completely paginated and display property names do not identify fields", async () => {
    const f = fixture(102)
    for (const row of f.files) f.select(row)
    const mainFields = property(f.main.properties)
    mainFields["Renamed Main Identity"] = mainFields.main_file_id
    delete mainFields.main_file_id
    const result = await f.run()
    expect(result.requests).toHaveLength(101)
    expect(f.calls.filter((call) => call.path.includes("/query"))).toHaveLength(2)
    expect(f.readBodyCount()).toBe(0)
  })

  test("unconfigured requests are explicit and cannot trigger schema setup", async () => {
    const f = sharedSnapshotFixture()
    expect(await f.run(listSharedFileRequests(base, [skillPage]))).toEqual({
      status: "not_configured",
      requests: [],
      not_configured: ["skills", "files"],
    })
    expect(f.calls).toHaveLength(0)
  })

  test("a provider-filtered row still must prove one exact Skill relation", async () => {
    const f = fixture(2)
    f.select(f.files[0]!)
    f.fault.row = f.files[0]!
    property(f.fault.row.properties).skill = {
      id: "skill",
      type: "relation",
      relation: [{ id: id(99) }],
      has_more: false,
    }
    await expect(f.run()).rejects.toMatchObject({ code: "SHARED_FILE_REQUEST_SCOPE" })
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
  })

  test("a repeated pagination cursor is incomplete, never a successful empty inventory", async () => {
    const f = fixture(2)
    f.fault.cursor = true
    await expect(f.run()).rejects.toMatchObject({ code: "SHARED_FILE_REQUEST_INCOMPLETE" })
    expect(f.readBodyCount()).toBe(0)
  })
})
