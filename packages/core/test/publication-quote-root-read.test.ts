import { test, expect } from "bun:test"
import { Effect } from "effect"
import { property, fail } from "../src/model.ts"
import type { Notion } from "../src/notion.ts"
import { readPublicationRootBlocks } from "../src/publication-observation.ts"

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`
const page = id(1),
  quote = id(2),
  paragraph = id(3),
  bullet = id(4),
  table = id(5),
  header = id(6),
  row = id(7),
  childPage = id(8)
const path = (owner: string) => `v1/blocks/${owner}/children?page_size=100`
const rich = (content: string) => ({
  type: "text",
  text: { content, link: null },
  plain_text: content,
  href: null,
  annotations: {
    bold: false,
    code: false,
    italic: false,
    underline: false,
    strikethrough: false,
    color: "default",
  },
})
const block = (
  blockId: string,
  type: string,
  parent: string,
  hasChildren: boolean,
  body: unknown,
) => ({
  id: blockId,
  type,
  has_children: hasChildren,
  archived: false,
  in_trash: false,
  parent:
    parent === page ? { type: "page_id", page_id: parent } : { type: "block_id", block_id: parent },
  [type]: body,
})
const list = (results: readonly unknown[]) => ({
  object: "list",
  results,
  has_more: false,
  next_cursor: null,
})
function fixture() {
  const responses: Record<string, unknown> = {
    [path(page)]: list([
      block(quote, "quote", page, true, { rich_text: [rich("Quoted procedure.")] }),
      block(childPage, "child_page", page, true, { title: "Separate page" }),
    ]),
    [path(quote)]: list([
      block(paragraph, "paragraph", quote, false, { rich_text: [rich("Read first.")] }),
      block(bullet, "bulleted_list_item", quote, false, { rich_text: [rich("Keep the source.")] }),
      block(table, "table", quote, true, {
        table_width: 2,
        has_column_header: true,
        has_row_header: false,
      }),
    ]),
    [path(table)]: list([
      block(header, "table_row", table, false, { cells: [[rich("Name")], [rich("Action")]] }),
      block(row, "table_row", table, false, { cells: [[rich("token")], [rich("Keep")]] }),
    ]),
  }
  const reads: string[] = []
  const api: Notion["Service"] = {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture"),
    request: (key, body, options) =>
      Effect.gen(function* () {
        if (
          body !== undefined ||
          options?.file ||
          (options?.method && options.method !== "GET") ||
          !Object.hasOwn(responses, key)
        )
          return yield* Effect.fail(
            fail("UNEXPECTED", "Only complete captured block GETs are allowed", { path: key }),
          )
        reads.push(key)
        return structuredClone(responses[key])
      }),
  }
  return { responses, reads, api }
}

test("ACK root proof reads a complete quote table tree without crossing a child page", async () => {
  const f = fixture(),
    before = JSON.stringify(f.responses)
  const roots = await Effect.runPromise(readPublicationRootBlocks(page, f.api, {}))
  expect(f.reads).toEqual([path(page), path(quote), path(table)])
  expect(roots.map((root) => root.id)).toEqual([quote, childPage])
  const descendants = property(roots[0]).quote_descendants
  expect(Array.isArray(descendants)).toBe(true)
  if (!Array.isArray(descendants)) throw new Error("Expected complete quote descendant evidence")
  expect(descendants.map((value) => property(value).id)).toEqual([
    paragraph,
    bullet,
    table,
    header,
    row,
  ])
  expect(property(roots[1]).quote_descendants).toBeUndefined()
  expect(JSON.stringify(f.responses)).toBe(before)
})

test("quote children retain exact parent and unique block identity requirements", async () => {
  for (const change of ["foreign-parent", "duplicate-id", "missing-cursor"] as const) {
    const f = fixture()
    const children = property(f.responses[path(quote)]).results
    if (!Array.isArray(children)) throw new Error("Expected child inventory")
    if (change === "foreign-parent")
      children[0] = { ...property(children[0]), parent: { type: "block_id", block_id: id(99) } }
    if (change === "duplicate-id") children[1] = { ...property(children[1]), id: paragraph }
    if (change === "missing-cursor")
      f.responses[path(quote)] = {
        ...property(f.responses[path(quote)]),
        has_more: true,
        next_cursor: null,
      }
    const result = await Effect.runPromise(
      readPublicationRootBlocks(page, f.api, {}).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
  }
})

test("table roots retain only their own row evidence instead of granting quote descendant authority", async () => {
  const f = fixture()
  f.responses[path(page)] = list([
    block(table, "table", page, true, {
      table_width: 2,
      has_column_header: true,
      has_row_header: false,
    }),
  ])
  const roots = await Effect.runPromise(readPublicationRootBlocks(page, f.api, {}))
  expect(f.reads).toEqual([path(page), path(table)])
  expect(roots[0]?.table_evidence?.rows.map((value) => value.id)).toEqual([header, row])
  expect(property(roots[0]).quote_descendants).toBeUndefined()
  expect(property(roots[0]).list_table_descendants).toBeUndefined()
})

test("ACK root proof reads every row only under its actual root list owner", async () => {
  const f = fixture(),
    owner = id(9)
  f.responses[path(page)] = list([
    block(owner, "numbered_list_item", page, true, {
      rich_text: [rich("Mapping:")],
      list_format: "numbers",
    }),
  ])
  f.responses[path(owner)] = list([
    block(table, "table", owner, true, {
      table_width: 2,
      has_column_header: true,
      has_row_header: false,
    }),
  ])
  const roots = await Effect.runPromise(readPublicationRootBlocks(page, f.api, {}))
  expect(f.reads).toEqual([path(page), path(owner), path(table)])
  const descendants = property(roots[0]).list_table_descendants
  expect(Array.isArray(descendants)).toBe(true)
  if (!Array.isArray(descendants)) throw new Error("Expected complete list table evidence")
  expect(descendants.map((value) => property(value).id)).toEqual([table, header, row])
  expect(property(roots[0]).descendants).toBeUndefined()
  expect(property(roots[0]).quote_descendants).toBeUndefined()
  expect(property(roots[0]).numbered_list).toEqual({ start: null })
})

test("same-content root sibling tables and deeper list tables cannot impersonate a direct table child", async () => {
  for (const sibling of [true, false]) {
    const f = fixture(),
      owner = id(9),
      nested = id(10)
    const tableBody = { table_width: 2, has_column_header: true, has_row_header: false }
    f.responses[path(page)] = list([
      block(owner, "numbered_list_item", page, true, { rich_text: [rich("Mapping:")] }),
      ...(sibling ? [block(table, "table", page, true, tableBody)] : []),
    ])
    f.responses[path(owner)] = list(
      sibling
        ? []
        : [block(nested, "numbered_list_item", owner, true, { rich_text: [rich("Nested:")] })],
    )
    f.responses[path(nested)] = list([block(table, "table", nested, true, tableBody)])
    const roots = await Effect.runPromise(readPublicationRootBlocks(page, f.api, {}))
    if (sibling) {
      expect(f.reads).toContain(path(table))
      expect(roots[1]?.table_evidence?.rows.map((value) => value.id)).toEqual([header, row])
    } else expect(f.reads).not.toContain(path(table))
    expect(property(roots[0]).list_table_descendants).toBeUndefined()
  }
})
