import { Effect } from "effect"
import {
  SourceLexer,
  visibleMarkdownText,
  visibleNotionMarkdownText,
  visibleNotionText,
} from "@notion-skills-cli/markdown"
import { stripNotionInlineBoundaries } from "./markdown.ts"
import type { SkillsError } from "./model.ts"
import { fail, property } from "./model.ts"
import type { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"

type Block = Record<string, unknown>
type Link = { block: Block; field: string; cell?: number; indexes: number[]; url: string }

// The ordinal is the authored destination's document position, never its label.
// Code examples must not participate in either side of this correspondence.
export function mapMarkdownLinks(markdown: string, change: (url: string) => string) {
  let fence: { marker: string; length: number } | undefined
  return markdown
    .split("\n")
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)
      if (fence) {
        if (marker && marker[1]![0] === fence.marker && marker[1]!.length >= fence.length)
          fence = undefined
        return line
      }
      if (marker) {
        fence = { marker: marker[1]![0]!, length: marker[1]!.length }
        return line
      }
      if (/^\s*<page\b[^>]*>[\s\S]*<\/page>\s*$/.test(line)) return line
      return line
        .split(/(`+[^`]*`+)/g)
        .map((part, index) => {
          if (index % 2) return part
          // One pass prevents a replacement destination from being visited twice.
          return part.replace(
            /(\]\(\s*<?)([^\s)>]+)(>?)(?=\s|\))|(^\s*\[[^\]]+\]:\s*<?)([^\s>]+)(>?)|((?:https?:\/\/)[^\s<>\)\]"']+)/g,
            (_all, a, b, c, d, e, f, bare) =>
              a ? `${a}${change(b)}${c}` : d ? `${d}${change(e)}${f}` : change(bare),
          )
        })
        .join("")
    })
    .join("\n")
}

export function hasTypedLinks(markdown: string) {
  let found = false
  mapMarkdownLinks(markdown, (url) => {
    if (pageId(url) && new URL(url).hash.startsWith("#ntn-skills-path=")) found = true
    return url
  })
  return found
}

// Descend only within the selected page's own block tree. A child_page is a
// separate permission/content boundary and is read by readReferences explicitly.
export function readLinkBlocks(
  page: string,
  api: Notion["Service"],
  options?: { readonly structureEvidence?: boolean },
) {
  return Effect.gen(function* () {
    const blocks: Block[] = []
    const identity = (id: string) => (options?.structureEvidence ? (pageId(id) ?? id) : id)
    const visited = new Set<string>([identity(page)])
    function children(id: string, depth: number): Effect.Effect<void, SkillsError> {
      return Effect.gen(function* () {
        if (depth > (options?.structureEvidence ? 32 : 100))
          return yield* Effect.fail(
            fail("INVALID_RESPONSE", "Block nesting exceeds the supported scope."),
          )
        let cursor: string | undefined,
          pages = 0
        const cursors = new Set<string>()
        do {
          if (options?.structureEvidence && ++pages > 50)
            return yield* Effect.fail(
              fail("INVALID_RESPONSE", "Block pagination exceeds the supported scope."),
            )
          const result = property(
            yield* api.request(
              `v1/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
            ),
          )
          if (!Array.isArray(result.results) || typeof result.has_more !== "boolean")
            return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid link block inventory."))
          for (const raw of result.results) {
            const block = property(raw)
            if (typeof block.id !== "string" || typeof block.type !== "string")
              return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid link block identity."))
            if (options?.structureEvidence) {
              const parent = property(block.parent)
              if (
                !(depth === 0
                  ? ["page_id", "block_id"].includes(String(parent.type))
                  : parent.type === "block_id") ||
                typeof parent[String(parent.type)] !== "string" ||
                !pageId(id) ||
                pageId(String(parent[String(parent.type)])) !== pageId(id) ||
                typeof block.has_children !== "boolean" ||
                blocks.length >= 4096
              )
                return yield* Effect.fail(
                  fail("INVALID_RESPONSE", "Block structure has invalid ownership or scope."),
                )
            }
            if (visited.has(identity(block.id)))
              return yield* Effect.fail(
                fail("INVALID_RESPONSE", "Cyclic or repeated link block identity."),
              )
            visited.add(identity(block.id))
            blocks.push(block)
            if (
              block.has_children === true &&
              block.type !== "child_page" &&
              block.type !== "child_database" &&
              (!options?.structureEvidence || block.type !== "synced_block")
            )
              yield* children(block.id, depth + 1)
          }
          if (!result.has_more) {
            if (
              options?.structureEvidence &&
              result.next_cursor !== undefined &&
              result.next_cursor !== null
            )
              return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid terminal block cursor."))
            break
          }
          if (
            typeof result.next_cursor !== "string" ||
            !result.next_cursor ||
            cursors.has(result.next_cursor)
          )
            return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid link block pagination."))
          cursor = result.next_cursor
          cursors.add(cursor)
        } while (cursor)
      })
    }
    yield* children(page, 0)
    return blocks
  })
}

function blockLinks(blocks: readonly Block[]) {
  const links: Link[] = []
  for (const block of blocks) {
    if (block.type === "code") continue
    const field = String(block.type)
    const data = property(block[field])
    const lists = Array.isArray(data.rich_text)
      ? [data.rich_text]
      : field === "table_row" && Array.isArray(data.cells)
        ? data.cells
        : []
    for (const [cell, list] of lists.entries()) {
      if (!Array.isArray(list)) throw fail("INVALID_RESPONSE", "Invalid block rich text.")
      let previous: Link | undefined
      for (const [index, raw] of list.entries()) {
        const text = property(raw)
        const url = property(property(text.text).link).url
        // An explicit link may have an inline-code label. Code blocks are
        // excluded above; ordinary inline code has no text.link destination.
        if (typeof url !== "string" || !pageId(url)) {
          previous = undefined
          continue
        }
        if (previous?.url === url && previous.indexes.at(-1) === index - 1)
          previous.indexes.push(index)
        else {
          previous = {
            block,
            field,
            ...(field === "table_row" ? { cell } : {}),
            indexes: [index],
            url,
          }
          links.push(previous)
        }
      }
    }
  }
  return links
}

function blockText(blocks: readonly Block[]) {
  return blocks
    .filter((block) => block.type !== "code")
    .map((block) => {
      const data = property(block[String(block.type)])
      const lists = Array.isArray(data.rich_text)
        ? [data.rich_text]
        : Array.isArray(data.cells)
          ? data.cells
          : []
      return lists
        .flat()
        .map((raw) =>
          visibleNotionText(
            String(property(raw).plain_text ?? property(property(raw).text).content ?? ""),
          ),
        )
        .join("")
    })
    .join("")
}

function correspondence(
  markdown: string,
  blocks: readonly Block[],
  format: "authored" | "readback",
) {
  const urls: string[] = []
  mapMarkdownLinks(markdown, (url) => {
    if (pageId(url)) urls.push(url)
    return url
  })
  const links = blockLinks(blocks)
  // Whitespace across rich-text/block boundaries is not stable. Exact body
  // equivalence is checked separately; this projection binds ordered links.
  const visible = (value: string) => value.replace(/\s/g, "")
  const project = format === "readback" ? visibleNotionMarkdownText : visibleMarkdownText
  const sourceText = visible(project(markdown.replace(/<page\b[^>]*>[\s\S]*?<\/page>/g, "")))
  const savedText = visible(blockText(blocks))
  if (sourceText !== savedText)
    throw fail(
      "TYPED_LINK_AMBIGUOUS",
      "The complete visible block content differs from the Markdown destination context.",
      { expected_length: sourceText.length, actual_length: savedText.length },
    )
  if (
    urls.length !== links.length ||
    urls.some((url, index) => pageId(url) !== pageId(links[index]!.url))
  )
    throw fail(
      "TYPED_LINK_AMBIGUOUS",
      "Markdown destinations do not correspond exactly to the page's ordered block links.",
      { markdown_links: urls.length, block_links: links.length },
    )
  return { urls, links }
}

export function restoreTypedLinks(page: string, markdown: string, api: Notion["Service"]) {
  return Effect.gen(function* () {
    if (!hasTypedLinks(markdown)) return
    const blocks = yield* readLinkBlocks(page, api)
    const matched = yield* Effect.try({
      try: () => correspondence(markdown, blocks, "authored"),
      catch: (error) => error as SkillsError,
    })
    const changes = new Map<Block, Block>()
    for (const [index, url] of matched.urls.entries()) {
      if (!new URL(url).hash.startsWith("#ntn-skills-path=")) continue
      const link = matched.links[index]!
      if (url === link.url) continue
      let body = changes.get(link.block)
      if (!body) {
        body = structuredClone(property(link.block[link.field]))
        changes.set(link.block, body)
      }
      const list = link.cell === undefined ? body.rich_text : (body.cells as unknown[][])[link.cell]
      for (const position of link.indexes) {
        const text = property((list as unknown[])[position])
        text.text = { ...property(text.text), link: { url } }
      }
    }
    // Validate the complete correspondence before making any repair mutation.
    for (const [block, data] of changes) {
      const field = String(block.type)
      const clean = (values: unknown[]) =>
        values.map((raw) => {
          const value = property(raw)
          return {
            type: value.type,
            ...(value.type === "text"
              ? { text: value.text }
              : { [String(value.type)]: value[String(value.type)] }),
            ...(value.annotations ? { annotations: value.annotations } : {}),
          }
        })
      const payload =
        field === "table_row"
          ? { cells: (data.cells as unknown[][]).map(clean) }
          : { rich_text: clean(data.rich_text as unknown[]) }
      // This read is retained by Publication before PATCH, along with the original
      // Markdown intent. Every URL and concrete block locator is in that journal.
      yield* api.request(`v1/blocks/${block.id}`)
      yield* api.request(`v1/blocks/${block.id}`, { [field]: payload }, { method: "PATCH" })
    }
    const saved = yield* readLinkBlocks(page, api)
    const verified = yield* Effect.try({
      try: () => correspondence(markdown, saved, "authored"),
      catch: (error) => error as SkillsError,
    })
    if (
      verified.urls.some(
        (url, index) =>
          new URL(url).hash.startsWith("#ntn-skills-path=") && verified.links[index]!.url !== url,
      )
    )
      return yield* Effect.fail(
        fail(
          "WRITE_VERIFICATION_FAILED",
          "Notion block links differ from the authored typed destinations.",
        ),
      )
  })
}

// Notion serializes one rich-text link as adjacent links at annotation edges.
// Join only exact explicit destinations; complete block correspondence remains
// mandatory, and already valid readback keeps its original bytes.
function joinReadbackLinks(markdown: string) {
  let fence: { marker: string; length: number } | undefined
  return markdown
    .split("\n")
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)
      if (fence) {
        if (
          marker &&
          marker[1]![0] === fence.marker &&
          marker[1]!.length >= fence.length &&
          /^[ \t]*$/.test(line.slice(marker[0].length))
        )
          fence = undefined
        return line
      }
      if (marker) {
        fence = { marker: marker[1]![0]!, length: marker[1]!.length }
        return line
      }
      const tokens = SourceLexer.lexInline(line)
      if (tokens.map((token) => token.raw).join("") !== line) return line
      const result: string[] = []
      let previous: { href: string; text: string } | undefined
      for (const token of tokens) {
        if (
          token.type === "link" &&
          token.title == null &&
          pageId(token.href) &&
          token.raw === `[${token.text}](${token.href})`
        ) {
          if (previous && previous.href === token.href) {
            previous.text += token.text
            result[result.length - 1] = `[${previous.text}](${previous.href})`
          } else {
            previous = { href: token.href, text: token.text }
            result.push(token.raw)
          }
        } else {
          previous = undefined
          result.push(token.raw)
        }
      }
      return result.join("")
    })
    .join("\n")
}

export function materializeTypedLinks(
  page: string,
  markdown: string,
  api: Notion["Service"],
  preloadedBlocks?: readonly Block[],
) {
  return Effect.gen(function* () {
    const blocks = preloadedBlocks ?? (yield* readLinkBlocks(page, api))
    const links = blockLinks(blocks)
    if (!links.some((link) => new URL(link.url).hash.startsWith("#ntn-skills-path=")))
      return markdown
    let source = stripNotionInlineBoundaries(markdown)
    const matched = yield* Effect.try({
      try: () => {
        try {
          return correspondence(source, blocks, "readback")
        } catch (error) {
          const joined = joinReadbackLinks(source)
          if (joined === source) throw error
          const matched = correspondence(joined, blocks, "readback")
          source = joined
          return matched
        }
      },
      catch: (error) => error as SkillsError,
    })
    let index = 0
    return mapMarkdownLinks(source, (url) => {
      if (!pageId(url)) return url
      const saved = matched.links[index++]!.url
      return new URL(saved).hash.startsWith("#ntn-skills-path=") ? saved : url
    })
  })
}
