import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Notion } from "../src/notion.ts"
import { NotionReadOnly, readOnlyNotion, withReadOnlyNotion } from "../src/notion-readonly.ts"
import { property } from "../src/model.ts"

const id = "00000000-0000-4000-8000-000000000001"

function transport() {
  const calls: Array<{ path: string; body: unknown; method: string }> = []
  const api: Notion["Service"] = {
    version: Effect.succeed("controlled"),
    credentialIdentity: Effect.succeed("readonly-test"),
    request: (path, body, options) =>
      Effect.sync(() => {
        calls.push({ path, body, method: options?.method ?? (body === undefined ? "GET" : "POST") })
        return { object: "list", results: [], has_more: false, next_cursor: null }
      }),
  }
  return { api, calls }
}

test("read-only observation admits real semantic queries and retains transport identity", async () => {
  const { api, calls } = transport()
  const result = await Effect.runPromise(
    withReadOnlyNotion(
      Effect.gen(function* () {
        const read = yield* NotionReadOnly
        yield* read.get(`v1/pages/${id}/markdown?markdown_version=v2`)
        yield* read.get(`v1/pages/${id}/properties/%3DudF?start_cursor=next`)
        yield* read.query(`v1/data_sources/${id}/query`, { page_size: 100 })
        yield* read.query(`v1/views/${id}/queries`, { page_size: 100 })
        yield* read.query("v1/search", { query: "owned fixture" })
        return yield* (yield* Notion).credentialIdentity
      }),
    ).pipe(Effect.provideService(Notion, api)),
  )
  expect(result).toBe("readonly-test")
  expect(calls.map((call) => call.method)).toEqual(["GET", "GET", "POST", "POST", "POST"])
})

test("no creation, property, relation, archive, block, upload or encoded-path write reaches transport", async () => {
  const { api, calls } = transport()
  const read = readOnlyNotion(api)
  const attempts: Parameters<Notion["Service"]["request"]>[] = [
    ["v1/pages", { markdown: "created" }],
    [`v1/pages/${id}`, { properties: { Members: { relation: [] } } }, { method: "PATCH" }],
    [`v1/pages/${id}`, { in_trash: true }, { method: "PATCH" }],
    [`v1/pages/${id}/markdown`, { type: "replace_content" }, { method: "PATCH" }],
    [`v1/blocks/${id}/children`, { children: [] }, { method: "PATCH" }],
    ["v1/file_uploads", { mode: "single_part" }],
    [`v1/data_sources/${id}/query`, undefined, { file: "/owned/file" }],
    [`v1/data_sources/${id}/query/../pages`, {}],
    [`v1/data_sources/${id}/%2e%2e/query`, undefined, { method: "GET" }],
    [`v1/data_sources/${id}/query%2f..%2fpages`, {}],
    ["https://api.notion.com/v1/search", {}],
    ["v1/search", { mutate: true }, { method: "GET" }],
  ]
  for (const args of attempts) {
    const result = await Effect.runPromise(read.request(...args).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected a read-only rejection")
    expect(result.failure.code).toBe("NOTION_READ_ONLY")
    expect(property(result.failure.details).phase).toBe("input_rejected")
  }
  expect(calls).toEqual([])
})

test("nested helpers and forked observers inherit the restriction while ordinary writes stay available outside", async () => {
  const { api, calls } = transport()
  const nestedRecovery = Effect.gen(function* () {
    const notion = yield* Notion
    yield* notion.request(`v1/data_sources/${id}/query`, { page_size: 100 })
    return yield* notion.request("v1/pages", { markdown: "missing original receipt" })
  })
  const results = await Effect.runPromise(
    withReadOnlyNotion(
      Effect.all([nestedRecovery.pipe(Effect.result), nestedRecovery.pipe(Effect.result)], {
        concurrency: 2,
      }),
    ).pipe(Effect.provideService(Notion, api)),
  )
  expect(
    results.every(
      (result) => result._tag === "Failure" && result.failure.code === "NOTION_READ_ONLY",
    ),
  ).toBe(true)
  expect(calls.every((call) => call.path.endsWith("/query"))).toBe(true)
  await Effect.runPromise(api.request("v1/pages", { markdown: "explicit authorized write" }))
  expect(calls.at(-1)?.path).toBe("v1/pages")
})
