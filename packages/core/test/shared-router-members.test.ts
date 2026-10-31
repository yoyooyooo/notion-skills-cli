import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fail, property, SkillsError, type Source } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { sharedRecordFromPage, sharedSkillId } from "../src/shared-content.ts"
import type { SharedLibrary } from "../src/shared-library-model.ts"
import {
  querySharedRouterMembers,
  renderSharedRouterMembers,
} from "../src/shared-router-members.ts"

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`
const routerPage = id(1)
const membersProperty = "mem%3Aroles"
const library: SharedLibrary = {
  version: 1,
  library_id: "library-router",
  operation_id: "library-router",
  parent_page_id: id(2),
  skills: {
    database_id: id(3),
    data_source_id: id(4),
    property_ids: {
      Name: "title",
      Description: "description",
      Kind: "kind",
      "Skill ID": "skill_id",
      Enabled: "enabled",
      "Default Context": "default",
      Members: membersProperty,
      Tags: "tags",
      References: "references",
      "Main File ID": "main_file_id",
      Projection: "projection",
      Source: "source",
    },
  },
  files: { database_id: id(5), data_source_id: id(6), property_ids: { Name: "title" } },
  records: { database_id: id(7), data_source_id: id(8), property_ids: { Name: "title" } },
}
const source: Source = {
  alias: library.library_id,
  title: "",
  role: "content",
  database_id: library.skills.database_id,
  data_source_ids: [library.skills.data_source_id],
  shared_library: library,
}
const rich = (propertyId: string, value: string) => ({
  id: propertyId,
  type: "rich_text",
  rich_text: [{ type: "text", plain_text: value, text: { content: value } }],
  has_more: false,
})

function row(
  page: string,
  stableId: string,
  name: string,
  kind = "skill",
  enabled = true,
): Record<string, unknown> {
  return {
    object: "page",
    id: page,
    last_edited_time: "2026-10-01T00:00:00.000Z",
    parent: {
      type: "data_source_id",
      data_source_id: library.skills.data_source_id,
      database_id: library.skills.database_id,
    },
    properties: {
      "Renamed title": { id: "title", type: "title", title: [{ plain_text: name }] },
      "Renamed description": rich("description", `${name} instructions`),
      "Renamed identity": rich("skill_id", stableId),
      "Renamed kind": { id: "kind", type: "select", select: { name: kind } },
      "Renamed enabled": { id: "enabled", type: "checkbox", checkbox: enabled },
      "Renamed context": { id: "default", type: "checkbox", checkbox: false },
      Name: { id: "unregistered-title", type: "title", title: [{ plain_text: "Wrong name" }] },
      Description: rich("unregistered-description", "Wrong description"),
      Members: {
        id: "unregistered-members",
        type: "relation",
        relation: [{ id: id(9999) }],
        has_more: false,
      },
    },
  }
}

function list(values: readonly unknown[], index: number, count: number): Record<string, unknown> {
  return {
    object: "list",
    results: values,
    has_more: index + 1 < count,
    next_cursor: index + 1 < count ? `page-${index + 1}` : null,
    request_status: { type: "complete", incomplete_reason: null },
  }
}

function fixture(count = 2) {
  const members = Array.from({ length: count }, (_, index) =>
    row(id(100 + index), `member-${String(index).padStart(3, "0")}`, `Member ${index}`),
  )
  const rawRouter = row(routerPage, "router", "Router", "router")
  const relation = {
    id: membersProperty,
    type: "relation",
    relation: members.slice(0, 25).map((member) => ({ id: member.id })),
    has_more: members.length > 25,
  }
  property(rawRouter.properties)["Renamed Members"] = relation
  const router = sharedRecordFromPage(rawRouter, source, library.skills.data_source_id)
  const relationPages: Record<string, unknown>[] = []
  for (let offset = 0; offset < members.length; offset += 100) {
    const index = Math.floor(offset / 100)
    const page = list(
      members.slice(offset, offset + 100).map((member) => ({
        object: "property_item",
        id: membersProperty,
        type: "relation",
        relation: { id: member.id },
      })),
      index,
      Math.ceil(members.length / 100),
    )
    page.type = "property_item"
    page.property_item = {
      id: membersProperty,
      type: "relation",
      relation: {},
      next_url: page.has_more
        ? `https://api.notion.com/v1/pages/${routerPage}/properties/${membersProperty}?start_cursor=page-${index + 1}&page_size=100`
        : null,
    }
    relationPages.push(page)
  }
  let inventoryRows: unknown[] = [rawRouter, ...members]
  let inventoryPages: Record<string, unknown>[] | undefined
  const calls: { readonly path: string; readonly body: unknown; readonly method: string }[] = []
  const api: Notion["Service"] = {
    version: Effect.succeed("controlled"),
    credentialIdentity: Effect.succeed("controlled"),
    request: (path, body, options) =>
      Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
        const method = options?.method ?? (body === undefined ? "GET" : "POST")
        calls.push({ path, body, method })
        const url = new URL(path, "https://api.notion.com/")
        const cursor = url.searchParams.get("start_cursor") ?? property(body).start_cursor
        const index =
          cursor === undefined || cursor === null
            ? 0
            : Number(String(cursor).replace(/^page-/u, ""))
        if (!Number.isInteger(index) || index < 0)
          return Effect.fail(fail("UNEXPECTED_REQUEST", "Unexpected fixture cursor."))
        if (url.pathname === `/v1/pages/${routerPage}/properties/${membersProperty}`) {
          const result = relationPages[index]
          return result === undefined
            ? Effect.fail(fail("UNEXPECTED_REQUEST", "Unexpected relation page."))
            : Effect.succeed(structuredClone(result))
        }
        if (url.pathname === `/v1/data_sources/${library.skills.data_source_id}/query`) {
          const pages =
            inventoryPages ??
            Array.from({ length: Math.ceil(inventoryRows.length / 100) }, (_, page) =>
              list(
                inventoryRows.slice(page * 100, page * 100 + 100),
                page,
                Math.ceil(inventoryRows.length / 100),
              ),
            )
          const result = pages[index]
          return result === undefined
            ? Effect.fail(fail("UNEXPECTED_REQUEST", "Unexpected inventory page."))
            : Effect.succeed(structuredClone(result))
        }
        return Effect.fail(
          fail(
            "UNEXPECTED_REQUEST",
            "Member bodies, per-page metadata and writes are forbidden in this fixture.",
            { path },
          ),
        )
      }),
  }
  const run = <A, E>(effect: Effect.Effect<A, E, Notion>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(Notion, api)))
  const query = (selectedLibrary: SharedLibrary = library) =>
    querySharedRouterMembers(selectedLibrary, { router, rawPage: rawRouter })
  return {
    members,
    rawRouter,
    router,
    relation,
    relationPages,
    calls,
    run,
    query,
    inventory: (rows: unknown[]) => {
      inventoryRows = rows
    },
    inventoryPages: (pages: Record<string, unknown>[]) => {
      inventoryPages = pages
    },
  }
}

function assertMetadataOnly(f: ReturnType<typeof fixture>) {
  expect(
    f.calls.every(
      (call) =>
        (call.method === "POST" &&
          call.path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query?`)) ||
        (call.method === "GET" &&
          call.path.startsWith(`v1/pages/${routerPage}/properties/${membersProperty}?`)),
    ),
  ).toBe(true)
  expect(f.calls.some((call) => /\/markdown|\/blocks|\/export/.test(call.path))).toBe(false)
  expect(
    f.calls.some(
      (call) =>
        call.path.includes(library.files.data_source_id) ||
        call.path.includes(library.records.data_source_id),
    ),
  ).toBe(false)
}

describe("shared Router members", () => {
  test("uses registered property IDs and one metadata batch, preserving false Default Context members", async () => {
    const f = fixture()
    f.inventory([f.members[1], f.rawRouter, f.members[0]])
    const result = await f.run(f.query())
    expect(result.map((member) => member.id)).toEqual([
      sharedSkillId(library.library_id, "member-000"),
      sharedSkillId(library.library_id, "member-001"),
    ])
    expect(result.map((member) => member.name)).toEqual(["Member 0", "Member 1"])
    expect(
      result.every(
        (member) => member.ref.startsWith("skill://shared_skill%3A") && member.kind === "skill",
      ),
    ).toBe(true)
    expect(result[0]?.metadata).toEqual({
      version: 1,
      library_id: library.library_id,
      skill_id: "member-000",
      page_id: id(100),
      database_id: library.skills.database_id,
      data_source_id: library.skills.data_source_id,
      kind: "skill",
      enabled: true,
      name: "Member 0",
      description: "Member 0 instructions",
    })
    expect(f.calls).toHaveLength(1)
    expect(
      new URL(f.calls[0]!.path, "https://api.notion.com/").searchParams.getAll("filter_properties"),
    ).toEqual(["title", "description", "kind", "skill_id", "enabled", "default"])
    expect(f.calls[0]?.body).toEqual({ page_size: 100 })
    assertMetadataOnly(f)
  })

  test("preserves empty and single-member manual Router semantics", async () => {
    const empty = fixture(0)
    expect(await empty.run(empty.query())).toEqual([])
    expect(empty.calls).toEqual([])
    const single = fixture(1)
    expect(await single.run(single.query())).toHaveLength(1)
    expect(single.calls).toHaveLength(1)
  })

  test("fails a missing registered Members property before any request instead of using its display name", async () => {
    const f = fixture()
    const selected = structuredClone(library)
    const { Members: _, ...rest } = selected.skills.property_ids
    const missing = { ...selected, skills: { ...selected.skills, property_ids: rest } }
    const error = await f.run(Effect.flip(f.query(missing)))
    expect(error.code).toBe("SHARED_ROUTER_MEMBERS_UNAVAILABLE")
    expect(f.calls).toEqual([])
  })

  test("rejects wrong relation type and an incomplete inline relation shape before inventory", async () => {
    for (const value of [
      rich(membersProperty, "not a relation"),
      { id: membersProperty, type: "relation", relation: [] },
    ]) {
      const f = fixture()
      property(f.rawRouter.properties)["Renamed Members"] = value
      expect((await f.run(Effect.flip(f.query()))).code).toBe("SHARED_ROUTER_MEMBERS_UNAVAILABLE")
      expect(f.calls).toEqual([])
    }
  })

  test("rejects non-Router or foreign raw page identity before member queries", async () => {
    for (const mutate of [
      (raw: Record<string, unknown>) => {
        raw.id = id(900)
      },
      (raw: Record<string, unknown>) => {
        property(raw.properties)["Renamed kind"] = {
          id: "kind",
          type: "select",
          select: { name: "skill" },
        }
      },
      (raw: Record<string, unknown>) => {
        property(raw.parent).data_source_id = library.files.data_source_id
      },
    ]) {
      const f = fixture()
      mutate(f.rawRouter)
      await f.run(Effect.flip(f.query()))
      expect(f.calls).toEqual([])
    }
  })

  test("paginates 101 relation members and complete Skills metadata without N+1 or double-encoding property ID", async () => {
    const f = fixture(101)
    const result = await f.run(f.query())
    expect(result).toHaveLength(101)
    expect(new Set(result.map((member) => member.id)).size).toBe(101)
    expect(f.calls.filter((call) => call.method === "GET")).toHaveLength(2)
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(2)
    expect(f.calls.some((call) => call.path.includes("%253A"))).toBe(false)
    expect(f.calls[1]?.path).toContain("start_cursor=page-1")
    assertMetadataOnly(f)
  })

  test("rejects foreign relation wrappers and item property IDs", async () => {
    for (const part of ["wrapper", "item"]) {
      const f = fixture(26)
      if (part === "wrapper") property(f.relationPages[0]!.property_item).id = "other"
      else property((f.relationPages[0]!.results as unknown[])[0]).id = "other"
      expect((await f.run(Effect.flip(f.query()))).code).toBe("SHARED_ROUTER_MEMBERS_INCOMPLETE")
      expect(f.calls).toHaveLength(1)
    }
  })

  test("does not silently deduplicate repeated relation members", async () => {
    const f = fixture(26)
    const values = f.relationPages[0]!.results as unknown[]
    values.push(structuredClone(values[0]))
    expect((await f.run(Effect.flip(f.query()))).code).toBe("SHARED_ROUTER_MEMBERS_INCOMPLETE")
  })

  test("rejects a relation that changed between inline and complete observations", async () => {
    const f = fixture(26)
    const values = f.relationPages[0]!.results as unknown[]
    property(property(values[0]).relation).id = id(900)
    expect((await f.run(Effect.flip(f.query()))).code).toBe("SHARED_ROUTER_MEMBERS_INCOMPLETE")
    expect(f.calls).toHaveLength(1)
  })

  test("rejects missing or repeated relation cursors without fetching an extra page", async () => {
    const missing = fixture(101)
    missing.relationPages[0]!.next_cursor = null
    expect((await missing.run(Effect.flip(missing.query()))).code).toBe(
      "SHARED_ROUTER_MEMBERS_INCOMPLETE",
    )
    expect(missing.calls).toHaveLength(1)
    const repeated = fixture(101)
    repeated.relationPages[1]!.has_more = true
    repeated.relationPages[1]!.next_cursor = "page-1"
    property(repeated.relationPages[1]!.property_item).next_url = "https://api.notion.com/repeated"
    expect((await repeated.run(Effect.flip(repeated.query()))).code).toBe(
      "SHARED_ROUTER_MEMBERS_INCOMPLETE",
    )
    expect(repeated.calls).toHaveLength(2)
  })

  test("missing or inaccessible selected metadata cannot become an empty successful Router", async () => {
    const f = fixture()
    f.inventory([f.rawRouter, f.members[0]])
    const error = await f.run(Effect.flip(f.query()))
    expect(error.code).toBe("SHARED_ROUTER_MEMBER_UNAVAILABLE")
    expect(property(error.details).page_id).toBe(id(101))
  })

  test("rejects a selected member from a foreign source", async () => {
    const f = fixture()
    property(f.members[0]!.parent).data_source_id = library.files.data_source_id
    expect((await f.run(Effect.flip(f.query()))).code).toBe("INVALID_SHARED_SKILL")
    assertMetadataOnly(f)
  })

  test("disabled selected members fail without silently changing the member set", async () => {
    const f = fixture()
    property(property(f.members[0]!.properties)["Renamed enabled"]).checkbox = false
    const error = await f.run(Effect.flip(f.query()))
    expect(error.code).toBe("SHARED_ROUTER_MEMBER_UNAVAILABLE")
    expect(property(error.details).reason).toBe("disabled")
  })

  test("nested Routers and Prompts cannot be selected members", async () => {
    for (const kind of ["router", "prompt"]) {
      const f = fixture()
      property(f.members[0]!.properties)["Renamed kind"] = {
        id: "kind",
        type: "select",
        select: { name: kind },
      }
      expect((await f.run(Effect.flip(f.query()))).code).toBe("INVALID_MEMBERS")
    }
  })

  test("detects selected-to-selected stable ID conflicts", async () => {
    const f = fixture()
    property(f.members[1]!.properties)["Renamed identity"] = rich("skill_id", "member-000")
    expect((await f.run(Effect.flip(f.query()))).code).toBe("SHARED_SKILL_ID_CONFLICT")
  })

  test("detects valid nonmember claims even when disabled without blocking unrelated corrupt rows", async () => {
    for (const enabled of [true, false]) {
      const f = fixture()
      f.inventory([
        f.rawRouter,
        ...f.members,
        row(id(900), "member-000", "Duplicate", "skill", enabled),
      ])
      expect((await f.run(Effect.flip(f.query()))).code).toBe("SHARED_SKILL_ID_CONFLICT")
    }
    const f = fixture()
    f.inventory([
      f.rawRouter,
      ...f.members,
      { id: id(902), properties: {} },
      row(id(903), "unrelated", "Other A"),
      row(id(904), "unrelated", "Other B"),
    ])
    expect(await f.run(f.query())).toHaveLength(2)
    assertMetadataOnly(f)
  })

  test("incomplete metadata status, repeated selected rows and bad final cursors fail", async () => {
    for (const issue of ["status", "duplicate", "cursor"]) {
      const f = fixture()
      const page = list([f.rawRouter, ...f.members], 0, 1)
      if (issue === "status")
        page.request_status = {
          type: "incomplete",
          incomplete_reason: "query_result_limit_reached",
        }
      if (issue === "duplicate") page.results = [f.rawRouter, ...f.members, f.members[0]]
      if (issue === "cursor") page.next_cursor = "unexpected"
      f.inventoryPages([page])
      const error = await f.run(Effect.flip(f.query()))
      expect(["INVALID_RESPONSE", "SHARED_ROUTER_MEMBERS_INCOMPLETE"]).toContain(error.code)
      expect(f.calls).toHaveLength(1)
    }
  })

  test("freezes render metadata, ignoring body-only edit timestamps", async () => {
    const f = fixture()
    const before = await f.run(f.query())
    f.members[0]!.last_edited_time = "2026-10-31T00:00:00.000Z"
    const afterBodyEdit = await f.run(f.query())
    expect(afterBodyEdit).toEqual(before)
    property(f.members[0]!.properties)["Renamed description"] = rich("description", "New metadata")
    const changed = await f.run(f.query())
    expect(changed[0]?.metadata.description).toBe("New metadata")
    expect(before[0]?.metadata.description).toBe("Member 0 instructions")
  })

  test("matches the existing Router Members renderer including empty output", async () => {
    const f = fixture()
    const members = await f.run(f.query())
    expect(renderSharedRouterMembers(members)).toBe(
      `\n\n## Members\n\n- [Member 0](${members[0]!.ref}) — Member 0 instructions\n- [Member 1](${members[1]!.ref}) — Member 1 instructions\n`,
    )
    expect(renderSharedRouterMembers([])).toBe("\n\n## Members\n\n\n")
  })
})
