import { expect, test } from "bun:test"
import { Effect } from "effect"
import { fail, property } from "../src/model.ts"
import { samePublishedMarkdown, type NotionBlockBoundary } from "../src/markdown.ts"
import type { Notion } from "../src/notion.ts"
import type { Receipt } from "../src/publication-model.ts"
import {
  capturePublicationRead,
  publicationReadPhase,
  readPublicationMarkdownMatches,
  readPublicationRootBlocks,
} from "../src/publication-observation.ts"

const id = (value: number) => `33333333-3333-4333-8333-${String(value).padStart(12, "0")}`
const page = id(1),
  table = id(2),
  header = id(3),
  firstRow = id(4),
  secondRow = id(5)
const beforeHeading = id(6),
  afterHeading = id(7),
  tail = id(8),
  foreign = id(99)
const inventory = (owner: string, cursor?: string) =>
  `v1/blocks/${owner}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`
const rootCursor = "root /+",
  rowCursor = "rows /+"
const pagePath = `v1/pages/${page}`,
  markdownPath = `${pagePath}/markdown`
const rich = (content: string, extra: { bold?: boolean; code?: boolean } = {}) => ({
  type: "text",
  text: { content, link: null },
  plain_text: content,
  href: null,
  annotations: {
    bold: extra.bold ?? false,
    code: extra.code ?? false,
    italic: false,
    underline: false,
    strikethrough: false,
    color: "default",
  },
})
const block = (
  blockId: string,
  type: string,
  owner: string,
  hasChildren: boolean,
  body: unknown,
) => ({
  object: "block",
  id: blockId,
  type,
  has_children: hasChildren,
  archived: false,
  in_trash: false,
  parent:
    owner === page ? { type: "page_id", page_id: owner } : { type: "block_id", block_id: owner },
  [type]: body,
})
const textBlock = (blockId: string, type: string, value: string) =>
  block(blockId, type, page, false, { rich_text: [rich(value)], color: "default" })
const list = (results: readonly unknown[], next: string | null = null) => ({
  object: "list",
  results,
  has_more: next !== null,
  next_cursor: next,
})

function fixture(boundaries = false) {
  const rows = [
    block(header, "table_row", table, false, { cells: [[rich("Name")], [rich("Action")]] }),
    block(firstRow, "table_row", table, false, {
      cells: [
        [rich("token", { code: true })],
        [rich("Keep <flag>, "), rich("exact", { bold: true }), rich(".")],
      ],
    }),
    block(secondRow, "table_row", table, false, {
      cells: [[rich("other")], [rich("Keep the second row.")]],
    }),
  ]
  const source =
    "# Before\n\n| Name | Action |\n| --- | --- |\n| `token` | Keep <flag>, **exact**. |\n| other | Keep the second row. |\n\n## After\n\nEnd.\n"
  const actual = [
    "# Before",
    "",
    '<table header-row="true">',
    "<tr>",
    "<td>Name</td>",
    "<td>Action</td>",
    "</tr>",
    "<tr>",
    "<td>`token`</td>",
    "<td>Keep \\<flag\\>, **exact**.</td>",
    "</tr>",
    "<tr>",
    "<td>other</td>",
    "<td>Keep the second row.</td>",
    "</tr>",
    "</table>",
    "",
    "## After",
    "",
    "End.",
    "",
  ].join("\n")
  const responses: Record<string, unknown> = {
    [inventory(page)]: list(
      [
        textBlock(beforeHeading, "heading_1", "Before"),
        block(table, "table", page, true, {
          table_width: 2,
          has_column_header: true,
          has_row_header: false,
        }),
      ],
      rootCursor,
    ),
    [inventory(page, rootCursor)]: list([
      textBlock(afterHeading, "heading_2", "After"),
      textBlock(tail, "paragraph", "End."),
      ...(boundaries
        ? [
            block(id(10), "child_page", page, true, { title: "Retained child" }),
            block(id(11), "child_database", page, true, { title: "Separate database" }),
            block(id(12), "synced_block", page, true, { synced_from: null }),
            block(id(13), "callout", page, true, { rich_text: [rich("Separate container")] }),
          ]
        : []),
    ]),
    [inventory(table)]: list(rows.slice(0, 1), rowCursor),
    [inventory(table, rowCursor)]: list(rows.slice(1)),
    [markdownPath]: {
      object: "page_markdown",
      id: page,
      markdown: actual,
      truncated: false,
      unknown_block_ids: [],
    },
  }
  const reads: string[] = []
  let race = false,
    changed = false
  const api: Notion["Service"] = {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture"),
    request: (path, body, options) =>
      Effect.gen(function* () {
        if (body !== undefined || options?.file || (options?.method && options.method !== "GET"))
          return yield* Effect.fail(
            fail("INVALID_RESPONSE", "Only complete captured GETs are allowed."),
          )
        reads.push(path)
        if (path === pagePath)
          return {
            object: "page",
            id: page,
            archived: false,
            in_trash: false,
            last_edited_time: changed ? "2026-10-22T01:01:00.000Z" : "2026-10-22T01:00:00.000Z",
            properties: {},
          }
        if (!Object.hasOwn(responses, path))
          return yield* Effect.fail(
            fail("INVALID_RESPONSE", "A complete captured GET is unavailable.", { path }),
          )
        if (race && path === inventory(table, rowCursor)) changed = true
        return structuredClone(responses[path])
      }),
  }
  const intent: Receipt["intents"][number] = {
    method: "PATCH",
    path: markdownPath,
    status: "completed",
    response: { id: page },
    body: { type: "replace_content", replace_content: { new_str: source } },
  }
  return {
    api,
    reads,
    responses,
    rows,
    source,
    actual,
    intent,
    race: () => {
      race = true
    },
  }
}

function retainedFixture() {
  const f = fixture(),
    childIds = [id(10), id(11)]
  const children = childIds.map((child, index) =>
    block(child, "child_page", page, true, { title: `guide-${index}.md` }),
  )
  const tags = childIds
    .map(
      (child, index) =>
        `<page url="https://app.notion.com/p/${child.replaceAll("-", "")}">guide-${index}.md</page>`,
    )
    .join("\n")
  const destination = "https://example.test/manual"
  const source =
    f.source
      .slice(0, f.source.indexOf("\n\n## After"))
      .replace("<flag>", "this")
      .replace("Keep the second row.", `[manual](${destination})`) +
    "\n" +
    tags
  const actual =
    f.actual
      .slice(0, f.actual.indexOf("## After"))
      .replace(String.raw`\<flag\>`, "this")
      .replace("Keep the second row.", `[manual](${destination})`) + tags
  f.rows[1]!.table_row = {
    cells: [
      [rich("token", { code: true })],
      [rich("Keep this, "), rich("exact", { bold: true }), rich(".")],
    ],
  }
  f.rows[2]!.table_row = {
    cells: [
      [rich("other")],
      [
        {
          ...rich("manual"),
          text: { content: "manual", link: { url: destination } },
          href: destination,
        },
      ],
    ],
  }
  f.responses[inventory(page, rootCursor)] = list(children)
  f.responses[markdownPath] = {
    object: "page_markdown",
    id: page,
    markdown: actual,
    truncated: false,
    unknown_block_ids: [],
  }
  const intent: Receipt["intents"][number] = {
    ...f.intent,
    body: { type: "replace_content", replace_content: { new_str: source } },
  }
  return { ...f, source, actual, intent, childIds, children, tags, destination }
}

test("root table reads all paginated direct rows and keeps other resource boundaries closed", async () => {
  const f = fixture(true),
    before = JSON.stringify(f.responses),
    raw: Record<string, unknown> = {}
  const roots = await Effect.runPromise(readPublicationRootBlocks(page, f.api, raw, true))
  expect(f.reads).toEqual([
    inventory(page),
    inventory(table),
    inventory(table, rowCursor),
    inventory(page, rootCursor),
  ])
  expect(roots.map((root) => root.id)).toEqual([
    beforeHeading,
    table,
    afterHeading,
    tail,
    id(10),
    id(11),
    id(12),
    id(13),
  ])
  const evidence = roots[1]?.table_evidence
  expect(evidence).toMatchObject({ width: 2, header_row: true, header_column: false })
  expect(evidence?.rows.map((row) => [row.id, row.parent_id, row.has_children])).toEqual([
    [header, table, false],
    [firstRow, table, false],
    [secondRow, table, false],
  ])
  expect(
    evidence?.rows[1]?.table_row?.cells[1]?.map((span) => [
      span.text,
      span.bold,
      span.code,
      span.link,
    ]),
  ).toEqual([
    ["Keep <flag>, ", false, false, null],
    ["exact", true, false, null],
    [".", false, false, null],
  ])
  expect(roots[1]?.quote_descendants).toBeUndefined()
  expect(roots[1]?.list_table_descendants).toBeUndefined()
  expect(JSON.stringify(f.responses)).toBe(before)
  const count = f.reads.length
  expect(await Effect.runPromise(readPublicationRootBlocks(page, f.api, raw, true))).toEqual(roots)
  expect(f.reads).toHaveLength(count)
})

test("root rows cannot introduce a non-row or a hidden descendant subtree", async () => {
  for (const change of ["wrong-type", "nested-row"] as const) {
    const f = fixture(),
      altered =
        change === "wrong-type"
          ? block(firstRow, "bulleted_list_item", table, true, {
              rich_text: [rich("Do not traverse")],
            })
          : { ...f.rows[1]!, has_children: true }
    f.responses[inventory(table, rowCursor)] = list([altered, f.rows[2]!])
    const result = await Effect.runPromise(
      readPublicationRootBlocks(page, f.api, {}, true).pipe(Effect.result),
    )
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "INVALID_RESPONSE" } })
    expect(f.reads).not.toContain(inventory(firstRow))
  }
})

test("root table rows retain exact parent, globally unique IDs and complete cursor requirements", async () => {
  for (const change of [
    "foreign-parent",
    "repeated-row",
    "root-id",
    "missing-cursor",
    "repeated-cursor",
    "terminal-cursor",
    "unavailable-page",
  ] as const) {
    const f = fixture()
    if (change === "foreign-parent") f.rows[1]!.parent = { type: "block_id", block_id: foreign }
    if (change === "repeated-row") f.rows[1]!.id = header
    if (change === "root-id") f.rows[1]!.id = beforeHeading
    if (change === "missing-cursor")
      f.responses[inventory(table)] = { ...list([f.rows[0]!]), has_more: true }
    if (change === "repeated-cursor")
      f.responses[inventory(table, rowCursor)] = list(f.rows.slice(1), rowCursor)
    if (change === "terminal-cursor")
      f.responses[inventory(table, rowCursor)] = { ...list(f.rows.slice(1)), next_cursor: "extra" }
    if (change === "unavailable-page") delete f.responses[inventory(table, rowCursor)]
    expect(
      await Effect.runPromise(readPublicationRootBlocks(page, f.api, {}, true).pipe(Effect.result)),
    ).toMatchObject({ _tag: "Failure", failure: { code: "INVALID_RESPONSE" } })
  }
})

test("new root table rows share the existing total 4096 block bound", async () => {
  const f = fixture()
  f.responses[inventory(page)] = list([
    block(table, "table", page, true, {
      table_width: 2,
      has_column_header: true,
      has_row_header: false,
    }),
  ])
  for (let offset = 0; offset < 4096; offset += 100) {
    const values = Array.from({ length: Math.min(100, 4096 - offset) }, (_, index) =>
      block(id(1000 + offset + index), "table_row", table, false, {
        cells: [[rich("Name")], [rich("Value")]],
      }),
    )
    f.responses[inventory(table, offset === 0 ? undefined : `row-${offset}`)] = list(
      values,
      offset + 100 < 4096 ? `row-${offset + 100}` : null,
    )
  }
  expect(
    await Effect.runPromise(readPublicationRootBlocks(page, f.api, {}, true).pipe(Effect.result)),
  ).toMatchObject({ _tag: "Failure", failure: { code: "INVALID_RESPONSE" } })
})

test("direct row reads invalidate that table's cached root proof and metadata bracket", async () => {
  const f = fixture(),
    roots = await Effect.runPromise(readPublicationRootBlocks(page, f.api, {}, true))
  for (const path of [`v1/blocks/${firstRow}`, inventory(firstRow), inventory(table)]) {
    const phase = publicationReadPhase()
    phase.proofs.set(page, { actual: f.actual, blocks: roots, strict_structure: true })
    phase.before.set(page, { sequence: 1, value: { id: page } })
    phase.proofs.set(foreign, { actual: "Other page", blocks: [] })
    capturePublicationRead(phase, path, {})
    expect(phase.proofs.has(page)).toBe(false)
    expect(phase.before.has(page)).toBe(false)
    expect(phase.proofs.has(foreign)).toBe(true)
  }
})

test("quote and list-table descendant reads invalidate only their own cached root proof", () => {
  for (const field of ["quote_descendants", "list_table_descendants"] as const) {
    const roots: readonly NotionBlockBoundary[] = [
      {
        id: table,
        type: "quote",
        has_children: true,
        [field]: [{ id: firstRow, parent_id: table, type: "paragraph", has_children: false }],
      },
    ]
    const phase = publicationReadPhase()
    phase.proofs.set(page, { actual: "Before", blocks: roots, strict_structure: true })
    phase.before.set(page, { sequence: 1, value: { id: page } })
    phase.proofs.set(foreign, { actual: "Other page", blocks: [] })
    capturePublicationRead(phase, `v1/blocks/${firstRow}`, {})
    expect(phase.proofs.has(page)).toBe(false)
    expect(phase.before.has(page)).toBe(false)
    expect(phase.proofs.has(foreign)).toBe(true)
  }
})

test("retained raw child blocks and child page observations invalidate the containing proof", () => {
  const f = retainedFixture()
  for (const path of [
    `v1/blocks/${f.childIds[0]}`,
    `v1/pages/${f.childIds[0]}`,
    `v1/pages/${f.childIds[0]}/markdown`,
  ]) {
    const phase = publicationReadPhase()
    // A projected sentinel must not be the only record of the physical child.
    phase.proofs.set(page, {
      actual: f.actual,
      blocks: [],
      raw_root_blocks: f.children,
      strict_structure: true,
    })
    phase.before.set(page, { sequence: 1, value: { id: page } })
    phase.proofs.set(foreign, { actual: "Other page", blocks: [] })
    capturePublicationRead(phase, path, {})
    expect(phase.proofs.has(page)).toBe(false)
    expect(phase.before.has(page)).toBe(false)
    expect(phase.proofs.has(foreign)).toBe(true)
  }
})

test("the real ACK reader frames retained child tags only with its complete bracketed raw root proof", async () => {
  const f = retainedFixture(),
    phase = publicationReadPhase(),
    original = JSON.stringify({ intent: f.intent, responses: f.responses })
  const check = () =>
    readPublicationMarkdownMatches(f.intent, f.actual, f.source, f.api, phase, undefined, true)
  expect(samePublishedMarkdown(f.actual, f.source)).toBe(false)
  expect(await Effect.runPromise(check())).toBe(true)
  const proof = phase.proofs.get(page)
  expect(proof?.raw_root_blocks?.map((root) => property(root).id)).toEqual([
    beforeHeading,
    table,
    ...f.childIds,
  ])
  expect(proof?.actual).toBe(f.actual)
  const calls = f.reads.length
  expect(await Effect.runPromise(check())).toBe(true)
  expect(f.reads).toHaveLength(calls)
  expect(JSON.stringify({ intent: f.intent, responses: f.responses })).toBe(original)
  if (!proof) throw new Error("The successful bracket must retain its proof.")
  phase.proofs.set(page, { actual: proof.actual, blocks: proof.blocks, strict_structure: true })
  expect(await Effect.runPromise(check())).toBe(false)
  expect(f.reads).toHaveLength(calls)
})

test("framing preserves caller identity, every table row and explicit external destinations", async () => {
  for (const change of [
    "caller-target",
    "physical-row",
    "external-destination",
    "foreign-child",
  ] as const) {
    const f = retainedFixture(),
      phase = publicationReadPhase()
    let actual = f.actual,
      target = f.source
    if (change === "caller-target") target = target.replace("Keep this", "Changed this")
    if (change === "physical-row") {
      f.rows[1]!.table_row = {
        cells: [[rich("token", { code: true })], [rich("Changed physical instructions.")]],
      }
      actual = actual.replace("Keep this, **exact**.", "Changed physical instructions.")
      f.responses[markdownPath] = { ...property(f.responses[markdownPath]), markdown: actual }
    }
    if (change === "external-destination") {
      actual = actual.replace(f.destination, "https://example.test/other")
      f.responses[markdownPath] = { ...property(f.responses[markdownPath]), markdown: actual }
    }
    if (change === "foreign-child") f.children[0]!.parent = { type: "page_id", page_id: foreign }
    const result = await Effect.runPromise(
      readPublicationMarkdownMatches(f.intent, actual, target, f.api, phase, undefined, true).pipe(
        Effect.result,
      ),
    )
    expect(result._tag === "Failure" || result.success === false).toBe(true)
  }
})

test("a retained-child read forces a fresh root bracket before the next ACK comparison", async () => {
  const f = retainedFixture(),
    phase = publicationReadPhase()
  const check = () =>
    readPublicationMarkdownMatches(f.intent, f.actual, f.source, f.api, phase, undefined, true)
  expect(await Effect.runPromise(check())).toBe(true)
  const calls = f.reads.length
  f.children[0]!.child_page = { title: "Changed child title" }
  capturePublicationRead(phase, `v1/pages/${f.childIds[0]}`, { object: "page", id: f.childIds[0] })
  expect(await Effect.runPromise(check())).toBe(false)
  expect(f.reads.slice(calls)).toContain(pagePath)
  expect(f.reads.slice(calls)).toContain(inventory(page, rootCursor))
})

test("the real ACK reader binds literal-table decoding to fresh complete rows and rejects later physical drift", async () => {
  const f = fixture(),
    phase = publicationReadPhase()
  const check = () =>
    readPublicationMarkdownMatches(f.intent, f.actual, f.source, f.api, phase, undefined, true)
  expect(samePublishedMarkdown(f.actual, f.source)).toBe(false)
  expect(await Effect.runPromise(check())).toBe(true)
  expect(
    phase.proofs.get(page)?.blocks.find((root) => root.id === table)?.table_evidence?.rows,
  ).toHaveLength(3)
  const calls = f.reads.length
  expect(await Effect.runPromise(check())).toBe(true)
  expect(f.reads).toHaveLength(calls)
  f.rows[2]!.table_row = { cells: [[rich("other")], [rich("Changed physical instructions.")]] }
  capturePublicationRead(phase, `v1/blocks/${secondRow}`, f.rows[2])
  expect(await Effect.runPromise(check())).toBe(false)
  expect(f.reads.slice(calls)).toContain(inventory(table, rowCursor))
})

test("root table pagination cannot outlive its metadata bracket", async () => {
  const f = fixture()
  f.race()
  expect(
    await Effect.runPromise(
      readPublicationMarkdownMatches(
        f.intent,
        f.actual,
        f.source,
        f.api,
        publicationReadPhase(),
        undefined,
        true,
      ).pipe(Effect.result),
    ),
  ).toMatchObject({ _tag: "Failure", failure: { code: "WRITE_CONFLICT" } })
})
