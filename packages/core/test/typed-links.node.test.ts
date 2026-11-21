import { expect, test } from "vitest"
import { Effect } from "effect"
import { fail } from "../src/model.ts"
import type { Notion } from "../src/notion.ts"
import { readLinkBlocks } from "../src/typed-links.ts"

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const page = id(1)
const path = (owner: string, cursor?: string) =>
  `v1/blocks/${owner}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`
const block = (n: number, type = "paragraph", children = false, parent = page) => ({
  object: "block",
  id: id(n),
  type,
  has_children: children,
  parent: {
    type: parent === page ? "page_id" : "block_id",
    [parent === page ? "page_id" : "block_id"]: parent,
  },
})
const list = (results: unknown[], cursor: string | null = null) => ({
  object: "list",
  results,
  has_more: cursor !== null,
  next_cursor: cursor,
})
function service(read: (path: string) => unknown) {
  const calls: string[] = []
  const api: Notion["Service"] = {
    version: Effect.succeed("current"),
    credentialIdentity: Effect.succeed("controlled"),
    request: (path, body, options) =>
      Effect.sync(() => {
        expect(body).toBeUndefined()
        expect(options).toBeUndefined()
        calls.push(path)
        return read(path)
      }),
  }
  return { api, calls }
}

test("the current block reader completes every page and nested child without crossing page, database or synced boundaries", async () => {
  const rows = new Map([
    [
      path(page),
      list(
        [
          block(11, "paragraph", true),
          block(12, "child_page", true),
          block(13, "child_database", true),
          block(14, "synced_block", true),
        ],
        "next value",
      ),
    ],
    [path(id(11)), list([block(15, "paragraph", false, id(11))])],
    [path(page, "next value"), list([block(16, "code")])],
  ])
  const { api, calls } = service((path) => {
    const value = rows.get(path)
    if (value === undefined) throw fail("UNEXPECTED", "Crossed a content boundary")
    return structuredClone(value)
  })
  const result = await Effect.runPromise(readLinkBlocks(page, api, { completeBodyEvidence: true }))
  expect(result.map((row) => row.id)).toEqual([11, 15, 12, 13, 14, 16].map(id))
  expect(calls).toEqual([path(page), path(id(11)), path(page, "next value")])
  expect(rows.get(path(id(11)))?.results).toEqual([block(15, "paragraph", false, id(11))])
})

test("foreign ownership, duplicate physical identities and incomplete terminal cursors never return a partial block inventory", async () => {
  for (const scenario of ["foreign", "duplicate", "terminal", "partial"] as const) {
    const { api } = service((request) =>
      scenario === "foreign"
        ? list([block(11, "paragraph", false, id(99))])
        : scenario === "terminal"
          ? { ...list([]), next_cursor: "unobserved" }
          : scenario === "partial"
            ? { ...list([]), object: "partial" }
            : request === path(page)
              ? list([block(11)], "next")
              : list([block(11)]),
    )
    const result = await Effect.runPromise(
      readLinkBlocks(page, api, { completeBodyEvidence: true }).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.code).toBe("INVALID_RESPONSE")
  }
})

test("a repeated cursor and an unbounded page stream stop at the existing finite block boundary", async () => {
  for (const repeated of [true, false]) {
    let pageNumber = 0
    const { api, calls } = service(() => list([], repeated ? "same" : `page-${++pageNumber}`))
    const result = await Effect.runPromise(readLinkBlocks(page, api).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    expect(calls).toHaveLength(repeated ? 2 : 50)
    if (result._tag === "Failure") expect(result.failure.code).toBe("INVALID_RESPONSE")
  }
})

test("nested block recursion stops before dispatch outside the current depth bound", async () => {
  let depth = 0
  const { api, calls } = service(() => {
    const parent = depth === 0 ? page : id(100 + depth)
    depth++
    return list([block(100 + depth, "paragraph", true, parent)])
  })
  const result = await Effect.runPromise(readLinkBlocks(page, api).pipe(Effect.result))
  expect(result._tag).toBe("Failure")
  expect(calls).toHaveLength(33)
  if (result._tag === "Failure") expect(result.failure.code).toBe("INVALID_RESPONSE")
})
