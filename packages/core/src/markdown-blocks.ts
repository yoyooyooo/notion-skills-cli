import { Effect } from "effect"
import { type Token, type Tokens } from "marked"
import { SourceLexer as Lexer } from "@notion-skills-cli/markdown"
import { fail, property } from "./model.ts"
import type { Notion } from "./notion.ts"
import { codeLanguage } from "./markdown.ts"
import { pageMarkdown } from "./references.ts"
import { planOrderedListStart } from "./ordered-list-start.ts"
import { unsupportedOrderedListStart } from "./ordered-list-capability.ts"
import { literalHtmlTableRowAlreadyExact } from "./markdown-table-readback.ts"
import { retainedChildTableSource } from "./retained-child-table.ts"

type Annotations = { bold?: boolean; italic?: boolean; strikethrough?: boolean; code?: boolean }
type RichText = {
  type: "text"
  text: { content: string; link?: { url: string } }
  annotations: Annotations
}

export function markdownRichText(
  tokens: readonly Token[],
  annotations: Annotations = {},
  url?: string,
): RichText[] {
  return tokens.flatMap((token): RichText[] => {
    if (token.type === "strong" || token.type === "em" || token.type === "del")
      return markdownRichText(
        token.tokens!,
        {
          ...annotations,
          [token.type === "strong" ? "bold" : token.type === "em" ? "italic" : "strikethrough"]:
            true,
        },
        url,
      )
    if (token.type === "link") return markdownRichText(token.tokens!, annotations, token.href)
    if (token.type === "html") {
      // The same literal cell tag already proved by table readback. Its text
      // is the source; breaks and structural tags stay unsupported.
      if (
        !("text" in token) ||
        token.text !== token.raw ||
        token.block === true ||
        typeof token.text !== "string" ||
        !/^<\/?[A-Za-z][^<>\r\n]*>$/.test(token.raw) ||
        /^<\/?(?:br|table|tr|td|th)(?:[ \t/>])/i.test(token.raw)
      )
        throw fail("UNSUPPORTED_MARKDOWN", "Table cells require supported inline Markdown.")
    } else if (
      token.type !== "text" &&
      token.type !== "escape" &&
      token.type !== "codespan" &&
      token.type !== "br"
    )
      throw fail("UNSUPPORTED_MARKDOWN", "Table cells require supported inline Markdown.")
    const content = token.type === "br" ? "\n" : String("text" in token ? token.text : "")
    const parts: RichText[] = []
    for (let start = 0; start < content.length; start += 2000)
      parts.push({
        type: "text",
        text: { content: content.slice(start, start + 2000), ...(url ? { link: { url } } : {}) },
        annotations: { ...annotations, ...(token.type === "codespan" ? { code: true } : {}) },
      })
    return parts
  })
}

/** The same complete cell payload used by publication and ACK evidence. */
export function markdownTableCells(cells: readonly Tokens.TableCell[]) {
  return cells.map((cell) => markdownRichText(cell.tokens))
}

// Preserve table literals and code languages changed by Notion's Markdown parser.
export function restoreMarkdownBlocks(pageId: string, markdown: string, api: Notion["Service"]) {
  return Effect.gen(function* () {
    const initialTokens = Lexer.lex(markdown)
    if (!initialTokens.some((token) => token.type === "table" || token.type === "code")) return
    const children: Record<string, unknown>[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const result = property(
        yield* api.request(
          `v1/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
        ),
      )
      if (!Array.isArray(result.results) || typeof result.has_more !== "boolean")
        return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid Markdown block inventory."))
      children.push(...result.results.map(property))
      if (!result.has_more) {
        if (result.next_cursor !== null && result.next_cursor !== undefined)
          return yield* Effect.fail(
            fail("INVALID_RESPONSE", "Unexpected Markdown block final cursor."),
          )
        break
      }
      if (
        typeof result.next_cursor !== "string" ||
        !result.next_cursor ||
        seen.has(result.next_cursor)
      )
        return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid Markdown block pagination."))
      cursor = result.next_cursor
      seen.add(cursor)
    } while (cursor)
    const authored = retainedChildTableSource(pageId, markdown, children)
    const tokens = authored === undefined ? initialTokens : Lexer.lex(authored)
    const tables = tokens.filter((token): token is Tokens.Table => token.type === "table")
    const codes = tokens.filter((token): token is Tokens.Code => token.type === "code")
    const savedTables = children.filter((block) => block.type === "table")
    const savedCodes = children.filter((block) => block.type === "code")
    if (savedCodes.length !== codes.length)
      return yield* Effect.fail(
        fail("WRITE_VERIFICATION_FAILED", "Saved code block count differs from input."),
      )
    for (const [index, code] of codes.entries()) {
      const block = savedCodes[index]!
      const saved = property(block.code)
      if (typeof block.id !== "string" || typeof saved.language !== "string")
        return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid code block."))
      if (codeLanguage(saved.language) !== codeLanguage(code.lang))
        yield* api.request(
          `v1/blocks/${block.id}`,
          {
            code: {
              language: codeLanguage(code.lang) === "text" ? "plain text" : codeLanguage(code.lang),
            },
          },
          { method: "PATCH" },
        )
    }
    if (savedTables.length !== tables.length)
      return yield* Effect.fail(
        fail("WRITE_VERIFICATION_FAILED", "Saved table count differs from input."),
      )
    for (const [index, table] of tables.entries()) {
      const rows = property(
        yield* api.request(`v1/blocks/${savedTables[index]!.id}/children?page_size=100`),
      )
      const input = [table.header, ...table.rows]
      if (
        !Array.isArray(rows.results) ||
        rows.has_more !== false ||
        rows.results.length !== input.length
      )
        return yield* Effect.fail(
          fail("WRITE_VERIFICATION_FAILED", "Saved table rows differ from input."),
        )
      for (const [rowIndex, cells] of input.entries()) {
        const row = property(rows.results[rowIndex])
        const actual = property(row.table_row).cells
        if (!Array.isArray(actual) || actual.length !== cells.length)
          return yield* Effect.fail(
            fail("WRITE_VERIFICATION_FAILED", "Saved table width differs from input."),
          )
        if (literalHtmlTableRowAlreadyExact(cells, row, savedTables[index]!.id)) continue
        const expected = yield* Effect.try({
          try: () => markdownTableCells(cells),
          catch: (error) => error as import("./model.ts").SkillsError,
        })
        const text = (values: unknown[]) =>
          values
            .map((value) => {
              const item = property(value)
              return String(item.plain_text ?? property(item.text).content ?? "")
            })
            .join("")
        if (expected.some((cell, column) => text(cell) !== text(actual[column] as unknown[])))
          yield* api.request(
            `v1/blocks/${row.id}`,
            { table_row: { cells: expected } },
            { method: "PATCH" },
          )
      }
    }
  })
}

/** Diagnose a default-one serialization without treating one and zero as
 * equivalent. The public block API cannot write the required correction. */
export function restoreOrderedListStart(pageId: string, markdown: string, api: Notion["Service"]) {
  return Effect.gen(function* () {
    if (
      !Lexer.lex(markdown).some(
        (token) => token.type === "list" && token.ordered && token.start === 0,
      )
    )
      return
    const actual = pageMarkdown(yield* api.request(`v1/pages/${pageId}/markdown`))
    const roots: unknown[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const raw = property(
        yield* api.request(
          `v1/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
        ),
      )
      if (!Array.isArray(raw.results) || typeof raw.has_more !== "boolean")
        return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid ordered-list block inventory."))
      roots.push(...raw.results)
      if (!raw.has_more) {
        if (raw.next_cursor !== null && raw.next_cursor !== undefined)
          return yield* Effect.fail(
            fail("INVALID_RESPONSE", "Unexpected ordered-list final cursor."),
          )
        break
      }
      if (typeof raw.next_cursor !== "string" || !raw.next_cursor || cursors.has(raw.next_cursor))
        return yield* Effect.fail(
          fail("INVALID_RESPONSE", "Incomplete ordered-list block inventory."),
        )
      cursor = raw.next_cursor
      cursors.add(cursor)
    } while (cursor)
    const repair = planOrderedListStart(pageId, actual, markdown, roots)
    if (repair) return yield* Effect.fail(unsupportedOrderedListStart())
  })
}
