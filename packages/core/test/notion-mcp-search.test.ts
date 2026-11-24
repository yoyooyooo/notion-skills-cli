import { expect, test } from "bun:test"
import {
  admitContentSearchMatches,
  assertContentSearchSource,
  contentSearchSource,
  validateContentSearchInput,
} from "../src/notion-mcp-search.ts"
import { fail, property } from "../src/model.ts"
import {
  currentId,
  currentLibrary,
  currentRich,
  currentSnapshotFixture,
} from "./shared-current-fixture.ts"

const match = (pageId: string) => ({ pageId, title: "remote title", snippet: "remote body needle" })
async function setup() {
  const fixture = currentSnapshotFixture()
  const selected = await fixture.run(contentSearchSource(currentLibrary.library_id))
  fixture.clearCalls()
  return { fixture, selected }
}

test("content search accepts current Enabled Skills outside Default Context without reading bodies or changing pins", async () => {
  const { fixture, selected } = await setup()
  expect(fixture.main.properties["Default Context"].checkbox).toBe(false)
  const result = await fixture.run(admitContentSearchMatches(selected, [match(fixture.main.id)]))
  expect(result.records).toHaveLength(1)
  expect(result.records[0]?.locator.page_id).toBe(fixture.main.id)
  expect(result.records[0]?.match.representation).toBe("native")
  expect(fixture.bodyCalls()).toEqual([])
  expect(fixture.semanticWrites()).toEqual([])
  expect(fixture.objects.size).toBe(0)
})

test("fresh disabled qualification withholds every remote title and snippet", async () => {
  const { fixture, selected } = await setup()
  fixture.main.properties.Enabled.checkbox = false
  const result = await fixture.run(admitContentSearchMatches(selected, [match(fixture.main.id)]))
  expect(result).toEqual({ records: [], rejected: 1 })
  expect(JSON.stringify(result)).not.toContain("remote")
})

test("a supporting File maps through its exact current owner; duplicates stay one candidate", async () => {
  const { fixture, selected } = await setup()
  const first = fixture.files[0]!,
    second = fixture.files[1]!
  const result = await fixture.run(
    admitContentSearchMatches(selected, [match(first.id), match(second.id)]),
  )
  expect(result.records).toHaveLength(1)
  expect(result.records[0]?.locator.page_id).toBe(fixture.main.id)
  expect(result.records[0]?.match).toMatchObject({
    pageId: first.id,
    representation: "supporting_file",
  })
  expect(fixture.calls.some((call) => call.path === `v1/pages/${fixture.main.id}`)).toBe(true)
  expect(fixture.bodyCalls()).toEqual([])
})

test("a supporting File whose owner is disabled publishes no match", async () => {
  const { fixture, selected } = await setup()
  fixture.main.properties.Enabled.checkbox = false
  expect(
    await fixture.run(admitContentSearchMatches(selected, [match(fixture.files[0]!.id)])),
  ).toEqual({ records: [], rejected: 1 })
})

test("incomplete and multiple supporting File owners cannot authorize snippets", async () => {
  for (const mode of ["incomplete", "multiple"] as const) {
    const { fixture, selected } = await setup()
    const file = fixture.files[0]!
    if (mode === "incomplete") file.properties.Skill.has_more = true
    else file.properties.Skill.relation.push({ id: currentId(999) })
    expect(await fixture.run(admitContentSearchMatches(selected, [match(file.id)]))).toEqual({
      records: [],
      rejected: 1,
    })
  }
})

test("physical source mismatch and exact page denial are filtered without titles", async () => {
  for (const mode of ["foreign", "denied"] as const) {
    const { fixture, selected } = await setup()
    if (mode === "foreign") fixture.main.parent.data_source_id = currentId(999)
    else
      fixture.failRequests((call) =>
        call.path === `v1/pages/${fixture.main.id}`
          ? fail("ACCESS_DENIED", "secret remote error", { body: "secret payload" })
          : undefined,
      )
    const result = await fixture.run(admitContentSearchMatches(selected, [match(fixture.main.id)]))
    expect(result).toEqual({ records: [], rejected: 1 })
    expect(JSON.stringify(result)).not.toContain("secret")
  }
})

test("same name and stable identity on a second physical page block admission", async () => {
  const { fixture, selected } = await setup()
  fixture.alterResponses((call, value) => {
    if (!call.path.startsWith(`v1/data_sources/${currentLibrary.skills.data_source_id}/query`))
      return value
    return { ...property(value), results: [fixture.main, { ...fixture.main, id: currentId(888) }] }
  })
  const observed = await fixture
    .run(admitContentSearchMatches(selected, [match(fixture.main.id)]))
    .then(
      () => "published",
      (error: unknown) => property(error).code,
    )
  expect(observed).toBe("MCP_ADMISSION_FAILED")
})

test("pending current work is not published as a ready search candidate", async () => {
  const { fixture, selected } = await setup()
  fixture.main.properties["Current State"].select.name = "applying"
  fixture.main.properties.Operation = currentRich("operation", "work-in-progress")
  expect(await fixture.run(admitContentSearchMatches(selected, [match(fixture.main.id)]))).toEqual({
    records: [],
    rejected: 1,
  })
})

test("resource projection matches do not acquire exact resource bytes", async () => {
  const { fixture, selected } = await setup()
  fixture.main.properties.Content = currentRich(
    "content",
    JSON.stringify({
      kind: "resource",
      object_id: `resource-${"a".repeat(64)}`,
      sha256: "b".repeat(64),
      bytes: 15,
      mode: "100644",
    }),
  )
  const result = await fixture.run(admitContentSearchMatches(selected, [match(fixture.main.id)]))
  expect(result.records[0]?.match.representation).toBe("projection")
  expect(fixture.recordCalls()).toEqual([])
  expect(fixture.objects.size).toBe(0)
})

test("admitted presentation is bounded and the link is derived from physical identity", async () => {
  const { fixture, selected } = await setup()
  const result = await fixture.run(
    admitContentSearchMatches(selected, [
      {
        pageId: fixture.main.id,
        title: "x".repeat(5000),
        snippet: "\u0000" + "字".repeat(5000),
        url: "https://attacker.invalid/secret",
      },
    ]),
  )
  expect(result.records[0]?.match.title?.length).toBe(512)
  expect(result.records[0]?.match.snippet?.length).toBe(2000)
  expect(result.records[0]?.match.url).toBe(
    `https://www.notion.so/${fixture.main.id.replaceAll("-", "")}`,
  )
  expect(JSON.stringify(result)).not.toContain("attacker")
})

test("query bounds and fresh source identity are separate from display name", async () => {
  expect(() => validateContentSearchInput({ query: " " })).toThrow()
  expect(() => validateContentSearchInput({ query: "term", limit: 51 })).toThrow()
  expect(validateContentSearchInput({ query: " 中文 " })).toEqual({ query: " 中文 ", limit: 20 })
  const { selected } = await setup()
  expect(() =>
    assertContentSearchSource(selected, { ...selected, scope: "another credential" }),
  ).toThrow()
  expect(() =>
    assertContentSearchSource(selected, { ...selected, workspaceId: "another workspace" }),
  ).toThrow()
  expect(() =>
    assertContentSearchSource(selected, {
      ...selected,
      source: { ...selected.source, title: "Renamed" },
    }),
  ).not.toThrow()
  expect(() =>
    assertContentSearchSource(selected, {
      ...selected,
      source: {
        ...selected.source,
        shared_library: { ...selected.source.shared_library, library_id: "82c54ed4-c58b-5af1-84b8-cc0b0eccef53" },
      },
    }),
  ).toThrow()
})

test("owner disablement during the claim query is observed before publication", async () => {
  const { fixture, selected } = await setup()
  fixture.alterResponses((call, value) => {
    if (call.path.startsWith(`v1/data_sources/${currentLibrary.skills.data_source_id}/query`))
      fixture.main.properties.Enabled.checkbox = false
    return value
  })
  expect(await fixture.run(admitContentSearchMatches(selected, [match(fixture.main.id)]))).toEqual({
    records: [],
    rejected: 1,
  })
})

test("an accepted disabled claim cannot be erased by a later enabled page", async () => {
  const { fixture, selected } = await setup()
  fixture.alterResponses((call, value) => {
    if (!call.path.startsWith(`v1/data_sources/${currentLibrary.skills.data_source_id}/query`))
      return value
    const denied = structuredClone(fixture.main)
    denied.properties.Enabled.checkbox = false
    return { ...property(value), results: [denied] }
  })
  expect(await fixture.run(admitContentSearchMatches(selected, [match(fixture.main.id)]))).toEqual({
    records: [],
    rejected: 1,
  })
})

test("supporting File rebinding or trashing during owner lookup retires the snippet", async () => {
  for (const mode of ["owner", "trash"] as const) {
    const { fixture, selected } = await setup()
    const file = fixture.files[0]!
    fixture.alterResponses((call, value) => {
      if (call.path.startsWith(`v1/data_sources/${currentLibrary.skills.data_source_id}/query`)) {
        if (mode === "owner") file.properties.Skill.relation = [{ id: currentId(987) }]
        else Object.assign(file, { in_trash: true })
      }
      return value
    })
    expect(await fixture.run(admitContentSearchMatches(selected, [match(file.id)]))).toEqual({
      records: [],
      rejected: 1,
    })
  }
})

test("a native supporting File cannot bypass its main file's unavailable Source", async () => {
  const { fixture, selected } = await setup()
  fixture.main.properties.Content = currentRich(
    "content",
    JSON.stringify({
      kind: "source",
      source_id: "absent-main-source",
      revision: "a".repeat(64),
      source_path: "SKILL.md",
      sha256: "b".repeat(64),
      bytes: 20,
      mode: "100644",
    }),
  )
  expect(
    await fixture.run(admitContentSearchMatches(selected, [match(fixture.files[0]!.id)])),
  ).toEqual({ records: [], rejected: 1 })
})

test("the final owner read rejects a newly disabled result even after an enabled claim", async () => {
  const { fixture, selected } = await setup()
  let reads = 0
  fixture.alterResponses((call, value) => {
    if (call.path !== `v1/pages/${fixture.main.id}` || ++reads < 2) return value
    const disabled = structuredClone(fixture.main)
    disabled.properties.Enabled.checkbox = false
    return disabled
  })
  expect(await fixture.run(admitContentSearchMatches(selected, [match(fixture.main.id)]))).toEqual({
    records: [],
    rejected: 1,
  })
  expect(reads).toBe(2)
})
