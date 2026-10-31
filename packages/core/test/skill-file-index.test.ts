import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fail } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { querySkillFiles } from "../src/skill-file-index.ts"

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const skillId = id(1)
const dataSourceId = id(2)
const propertyIds = {
  "File ID": "t%5C%3Ey",
  Skill: "%7C%5D%7D%3E",
  Path: "Fnaf",
  Projection: "RVi_",
  Status: "VVAT",
}
const rich = (propertyId: string, value: string) => ({
  id: propertyId,
  type: "rich_text",
  rich_text: value === "" ? [] : [{ type: "text", plain_text: value, text: { content: value } }],
})

function file(
  options: {
    n?: number
    path?: string
    fileId?: string
    status?: string
    projection?: string
    relatedIds?: readonly string[]
    hasMoreRelations?: boolean
  } = {},
) {
  const n = options.n ?? 1
  const properties: Record<string, unknown> = {
    "File ID": rich(propertyIds["File ID"], options.fileId ?? `file-${n}`),
    Skill: {
      id: propertyIds.Skill,
      type: "relation",
      relation: (options.relatedIds ?? [skillId]).map((value) => ({ id: value })),
      has_more: options.hasMoreRelations ?? false,
    },
    Path: rich(propertyIds.Path, options.path ?? `scripts/file-${n}.ts`),
    Projection: rich(propertyIds.Projection, options.projection ?? ""),
    Status: {
      id: propertyIds.Status,
      type: "select",
      select: { name: options.status ?? "following" },
    },
  }
  return {
    object: "page",
    id: id(100 + n),
    parent: { type: "data_source_id", data_source_id: dataSourceId },
    last_edited_time: "2026-10-31T08:00:00.000Z",
    properties,
  }
}

const page = (results: unknown[], next: string | null = null) => ({
  object: "list",
  results,
  has_more: next !== null,
  next_cursor: next,
})

function client(responses: unknown[], permissionFailureAt?: number) {
  const calls: Array<{ path: string; body: unknown; method: string | undefined }> = []
  let active = 0
  let maxActive = 0
  const api: Notion["Service"] = {
    version: Effect.succeed("controlled"),
    credentialIdentity: Effect.succeed("controlled"),
    request: (path, body, options) =>
      Effect.gen(function* () {
        const index = calls.length
        calls.push({ path, body, method: options?.method })
        if (index === permissionFailureAt)
          return yield* Effect.fail(fail("NOTION_REQUEST_FAILED", "Notion access denied"))
        return yield* Effect.tryPromise({
          try: async () => {
            active += 1
            maxActive = Math.max(maxActive, active)
            await Promise.resolve()
            active -= 1
            if (index >= responses.length) throw new Error("Unexpected extra Notion request")
            return responses[index]
          },
          catch: () => fail("NOTION_REQUEST_FAILED", "Unexpected Notion request"),
        })
      }),
  }
  return {
    calls,
    maxActive: () => maxActive,
    run: (ids?: Record<string, string>) =>
      Effect.runPromise(
        querySkillFiles({
          dataSourceId,
          skillPageId: skillId,
          ...(ids === undefined ? {} : { propertyIds: ids }),
        }).pipe(Effect.provideService(Notion, api)),
      ),
  }
}

describe("selected Skill Files index", () => {
  test("paginates serially with one metadata request per page and no body GETs", async () => {
    const first = Array.from({ length: 100 }, (_, n) => file({ n: n + 1 }))
    const api = client([page(first, "cursor-2"), page([file({ n: 101 })])])
    const result = await api.run()
    expect(result).toHaveLength(101)
    expect(api.calls).toHaveLength(2)
    expect(api.maxActive()).toBe(1)
    for (const call of api.calls) {
      const url = new URL(call.path, "https://api.notion.com/")
      expect(url.pathname).toBe(`/v1/data_sources/${dataSourceId}/query`)
      expect(call.method).toBe("POST")
      expect(url.searchParams.getAll("filter_properties")).toEqual([
        "File ID",
        "Skill",
        "Path",
        "Projection",
        "Status",
      ])
    }
    expect(api.calls[0]?.body).toEqual({
      page_size: 100,
      filter: { property: "Skill", relation: { contains: skillId } },
    })
    expect(api.calls[1]?.body).toEqual({
      page_size: 100,
      filter: { property: "Skill", relation: { contains: skillId } },
      start_cursor: "cursor-2",
    })
  })

  test("uses stable property IDs after Notion columns are renamed", async () => {
    const original = file()
    const renamed = {
      ...original,
      properties: Object.fromEntries(
        Object.entries(original.properties).map(([name, value]) => [`renamed-${name}`, value]),
      ),
    }
    const api = client([page([renamed])])
    const result = await api.run(propertyIds)
    expect(result[0]?.file_id).toBe("file-1")
    expect(api.calls[0]?.body).toEqual({
      page_size: 100,
      filter: { property: propertyIds.Skill, relation: { contains: skillId } },
    })
    const call = api.calls[0]
    if (call === undefined) throw new Error("Missing query call")
    expect(
      new URL(call.path, "https://api.notion.com/").searchParams.getAll("filter_properties"),
    ).toEqual(Object.values(propertyIds))
  })

  test("preserves projection evidence and treats status as a display mirror", async () => {
    const projection = {
      normalization_version: 1 as const,
      sha256: "a".repeat(64),
      source_revision: "source-v2",
    }
    const result = await client([
      page([file({ status: "custom", projection: JSON.stringify(projection) })]),
    ]).run()
    expect(result[0]).toEqual({
      file_id: "file-1",
      page_id: id(101),
      skill_page_id: skillId,
      path: "scripts/file-1.ts",
      last_edited_time: "2026-10-31T08:00:00.000Z",
      display_status: "custom",
      baseline: projection,
    })
    expect(result[0]).not.toHaveProperty("ownership")
  })

  test("allows an empty Projection and leaves main entrypoint collision checks to the composer", async () => {
    const result = await client([page([file({ path: "SKILL.md" })])]).run()
    expect(result[0]?.path).toBe("SKILL.md")
    expect(result[0]).not.toHaveProperty("baseline")
  })

  test("returns an empty index using one selected-Skill query", async () => {
    const api = client([page([])])
    expect(await api.run()).toEqual([])
    expect(api.calls).toHaveLength(1)
  })

  test("rejects request_status incomplete even when has_more is false", async () => {
    const api = client([
      {
        ...page([file()]),
        request_status: { type: "incomplete", incomplete_reason: "query_result_limit_reached" },
      },
    ])
    await expect(api.run()).rejects.toThrow("incomplete")
    expect(api.calls).toHaveLength(1)
  })

  test("rejects a repeated pagination cursor instead of fetching forever", async () => {
    const api = client([page([file()], "again"), page([file({ n: 2 })], "again")])
    await expect(api.run()).rejects.toThrow("cursor")
    expect(api.calls).toHaveLength(2)
  })

  test("rejects has_more without a usable cursor", async () => {
    await expect(client([{ ...page([]), has_more: true }]).run()).rejects.toThrow()
  })

  test("rejects a duplicate page across response pages", async () => {
    const duplicate = { ...file({ n: 2 }), id: id(101) }
    await expect(client([page([file()], "next"), page([duplicate])]).run()).rejects.toThrow(
      "repeated a page",
    )
  })

  test("rejects duplicate logical File IDs across different pages", async () => {
    await expect(client([page([file(), file({ n: 2, fileId: "file-1" })])]).run()).rejects.toThrow(
      "File ID",
    )
  })

  test("rejects duplicate canonical Paths across different files", async () => {
    await expect(
      client([page([file(), file({ n: 2, path: "scripts/file-1.ts" })])]).run(),
    ).rejects.toThrow("Path")
  })

  test.each(["./a.txt", "a//b.txt", "a/../b.txt", "../escape", "/absolute", "a\\b", "a\nb", ""])(
    "rejects unsafe or noncanonical Path %j",
    async (path) => {
      await expect(client([page([file({ path })])]).run()).rejects.toThrow()
    },
  )

  test.each([{ relatedIds: [] }, { relatedIds: [id(9)] }, { relatedIds: [skillId, id(9)] }])(
    "rejects invalid relation ownership %j",
    async ({ relatedIds }) => {
      await expect(client([page([file({ relatedIds })])]).run()).rejects.toThrow()
    },
  )

  test("rejects a truncated relation", async () => {
    await expect(client([page([file({ hasMoreRelations: true })])]).run()).rejects.toThrow(
      "relation",
    )
  })

  test("rejects a row with a different data source parent despite a matching Skill relation", async () => {
    const row = { ...file(), parent: { type: "data_source_id", data_source_id: id(999) } }
    await expect(client([page([row])]).run()).rejects.toThrow("another data source")
  })

  test("rejects a missing or non-data-source parent", async () => {
    await expect(client([page([{ ...file(), parent: undefined }])]).run()).rejects.toThrow()
    await expect(
      client([page([{ ...file(), parent: { type: "page_id", page_id: skillId } }])]).run(),
    ).rejects.toThrow("another data source")
  })

  test("rejects unknown display ownership values", async () => {
    await expect(client([page([file({ status: "automatic" })])]).run()).rejects.toThrow("status")
  })

  test.each(["File ID", "Skill", "Path", "Projection", "Status"])(
    "rejects missing required property %s",
    async (field) => {
      const row = file()
      delete row.properties[field]
      await expect(client([page([row])]).run()).rejects.toThrow()
    },
  )

  test.each([
    "not json",
    "{}",
    '{"normalization_version":2,"sha256":"bad"}',
    JSON.stringify({ normalization_version: 1, sha256: "a".repeat(64), unexpected: true }),
  ])("rejects invalid projection %s", async (projection) => {
    await expect(client([page([file({ projection })])]).run()).rejects.toThrow("Projection")
  })

  test("rejects missing timestamps and malformed File IDs", async () => {
    const row = { ...file(), last_edited_time: "" }
    await expect(client([page([row])]).run()).rejects.toThrow()
    await expect(client([page([file({ fileId: "x".repeat(257) })])]).run()).rejects.toThrow(
      "File ID",
    )
  })

  test("does not return a partial index or perform fallback page reads on permission failure", async () => {
    const api = client([page([file()], "next")], 1)
    await expect(api.run()).rejects.toThrow("Notion access denied")
    expect(api.calls).toHaveLength(2)
    expect(api.calls.every((call) => call.path.includes("/data_sources/"))).toBe(true)
  })

  test("rejects duplicate configured property IDs before any request", async () => {
    const api = client([])
    await expect(api.run({ ...propertyIds, Path: propertyIds["File ID"] })).rejects.toThrow(
      "distinct",
    )
    expect(api.calls).toHaveLength(0)
  })
})
