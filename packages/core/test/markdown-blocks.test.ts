import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { Token, Tokens } from "marked"
import { markdownTableCells, restoreMarkdownBlocks } from "../src/markdown-blocks.ts"
import { SourceLexer } from "@notion-skills-cli/markdown"
import { fail, property } from "../src/model.ts"
import type { Notion } from "../src/notion.ts"

const source = "| Rule | Value |\n| --- | --- |\n| Supervisor | `RunAtLoad` + `KeepAlive` |\n"
const rich = (content: string) => [{ type: "text", text: { content } }]
function fixture(malformed = false) {
  const rows = [
    { id: "header", type: "table_row", table_row: { cells: [rich("Rule"), rich("Value")] } },
    {
      id: "value",
      type: "table_row",
      table_row: { cells: [rich("Supervisor"), rich("RunAtLoad • KeepAlive")] },
    },
  ]
  let writes = 0
  const api: Notion["Service"] = {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture"),
    request: (path, body, options) =>
      Effect.gen(function* () {
        if (path === "v1/blocks/page/children?page_size=100")
          return { results: [{ id: "table", type: "table" }], has_more: false }
        if (path === "v1/blocks/table/children?page_size=100")
          return { results: malformed ? rows.slice(0, 1) : rows, has_more: false }
        if (path === "v1/blocks/value" && options?.method === "PATCH") {
          writes++
          rows[1]!.table_row = property(body).table_row as (typeof rows)[1]["table_row"]
          return rows[1]
        }
        return yield* Effect.fail(fail("UNEXPECTED", "Unexpected fixture request", { path }))
      }),
  }
  return { api, rows, writes: () => writes }
}

test("table repair restores literal plus and code annotations, then leaves identical rows alone", async () => {
  const f = fixture()
  await Effect.runPromise(restoreMarkdownBlocks("page", source, f.api))
  const cells = f.rows[1]!.table_row.cells
  expect(cells[1]!.map((part) => part.text.content).join("")).toBe("RunAtLoad + KeepAlive")
  expect(cells[1]!.map((part) => property(part).annotations)).toEqual([
    { code: true },
    {},
    { code: true },
  ])
  expect(cells[0]!.map((part) => part.text.content).join("")).toBe("Supervisor")
  expect(f.writes()).toBe(1)
  await Effect.runPromise(restoreMarkdownBlocks("page", source, f.api))
  expect(f.writes()).toBe(1)
})

test("table shape mismatch fails before overwriting any row", async () => {
  const f = fixture(true)
  const result = await Effect.runPromise(
    restoreMarkdownBlocks("page", source, f.api).pipe(Effect.result),
  )
  expect(result._tag === "Failure" && result.failure.code).toBe("WRITE_VERIFICATION_FAILED")
  expect(f.writes()).toBe(0)
  expect(f.rows[1]!.table_row.cells[1]![0]!.text.content).toBe("RunAtLoad • KeepAlive")
})

test("code repair restores an unlabeled block without changing code or equivalent shell labels", async () => {
  const blocks = [
    {
      id: "diagram",
      type: "code",
      code: { language: "javascript", rich_text: rich("<Platform>.<Account>\n\nidentity") },
    },
    { id: "command", type: "code", code: { language: "shell", rich_text: rich("echo ready") } },
  ]
  const api: Notion["Service"] = {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture"),
    request: (path, body, options) =>
      Effect.gen(function* () {
        if (path === "v1/blocks/page/children?page_size=100")
          return { results: blocks, has_more: false }
        if (path === "v1/blocks/diagram" && options?.method === "PATCH") {
          Object.assign(blocks[0]!.code, property(body).code)
          return blocks[0]
        }
        return yield* Effect.fail(fail("UNEXPECTED", "Unexpected fixture request", { path }))
      }),
  }
  await Effect.runPromise(
    restoreMarkdownBlocks(
      "page",
      "```\n<Platform>.<Account>\n\nidentity\n```\n\n```bash\necho ready\n```",
      api,
    ),
  )
  expect(blocks.map((block) => block.code.language)).toEqual(["plain text", "shell"])
  expect(blocks[0]!.code.rich_text).toEqual(rich("<Platform>.<Account>\n\nidentity"))
  expect(blocks[1]!.code.rich_text).toEqual(rich("echo ready"))
})

test("literal img tags in table cells stay exact text while other html stays unsupported", () => {
  const source = [
    "| Shortcut | Notes |",
    "| --- | --- |",
    "| [`+template-create`](references/lark-mail-template-create.md) | Create a personal mail template. Scans HTML <img src> local paths. |",
    "| [`+template-update`](references/lark-mail-template-update.md) | Update a template and rewrite <img> local paths. |",
  ].join("\n")
  const table = SourceLexer.lex(source).find((token) => token.type === "table")
  if (!table || table.type !== "table") throw new Error("expected the literal img table")
  const cells = markdownTableCells([
    table.header[1]!,
    ...table.rows.map((row: Tokens.TableCell[]) => row[1]!),
  ])
  expect(cells.map((cell) => cell.map((part) => part.text.content).join(""))).toEqual([
    "Notes",
    "Create a personal mail template. Scans HTML <img src> local paths.",
    "Update a template and rewrite <img> local paths.",
  ])
  expect(cells[1]!.map((part) => part.text.link?.url)).toEqual([undefined])
  expect(cells[0]!.map((part) => part.annotations)).toEqual([{}])
  const linked = SourceLexer.lex("| A | [keep](https://example.test/a) |\n| --- | --- |\n").find(
    (token) => token.type === "table",
  )
  if (!linked || linked.type !== "table") throw new Error("expected the linked cell")
  expect(markdownTableCells(linked.header)[1]).toEqual([
    {
      type: "text",
      text: { content: "keep", link: { url: "https://example.test/a" } },
      annotations: {},
    },
  ])
  for (const cell of ["<br>", "<table>", "<td>"]) {
    const rejected = SourceLexer.lex(`| A | ${cell} |\n| --- | --- |\n`).find(
      (token) => token.type === "table",
    )
    if (!rejected || rejected.type !== "table") throw new Error(`expected a table for ${cell}`)
    const html = rejected.header[1]!.tokens.filter((token: Token) => token.type === "html")
    expect(html.map((token: Token) => token.raw)).toEqual([cell])
    expect(() => markdownTableCells([rejected.header[1]!])).toThrow(
      "Table cells require supported inline Markdown.",
    )
  }
})
