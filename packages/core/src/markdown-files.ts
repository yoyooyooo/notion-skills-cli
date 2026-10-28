import { Effect } from "effect"
import { fail, property, type SkillsError } from "./model.ts"
import type { Notion } from "./notion.ts"
import { normalizePath } from "./ref.ts"
import type { PortableSkill } from "./portable.ts"

export const MARKDOWN_FILES_MARKER = "ntn-skills-markdown-files:v1"
export interface MarkdownFiles {
  readonly main: string
  readonly files: PortableSkill["files"]
}
const text = (value: unknown) => {
  if (!Array.isArray(value))
    throw fail("MARKDOWN_FILES_INVALID", "Expected complete literal rich text.")
  return value
    .map((value) => {
      const span = property(value),
        body = property(span.text)
      if (
        span.type !== "text" ||
        typeof body.content !== "string" ||
        body.link != null ||
        (span.plain_text !== undefined && span.plain_text !== body.content)
      )
        throw fail("MARKDOWN_FILES_INVALID", "Markdown file text contains a nonliteral span.")
      return body.content
    })
    .join("")
}
export function markdownFileChunks(value: string, size = 100000) {
  const chunks: string[] = []
  for (let start = 0; start < value.length; ) {
    let end = Math.min(start + size, value.length)
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--
    chunks.push(value.slice(start, end))
    start = end
  }
  return chunks.length ? chunks : [""]
}
export const markdownFileSpans = (value: string) =>
  markdownFileChunks(value, 2000)
    .filter(Boolean)
    .map((content) => ({ type: "text", text: { content } }))
export const markdownFileCode = (value: string) => ({
  object: "block",
  type: "code",
  code: { language: "markdown", rich_text: markdownFileSpans(value), caption: [] },
})
export function markdownFilesHeader(main: string) {
  if (normalizePath(main) !== main) throw fail("INVALID_PATH", "Invalid Markdown entrypoint.")
  return `${MARKDOWN_FILES_MARKER} ${JSON.stringify({ main })}`
}
export function decodeMarkdownFiles(
  blocks: readonly Record<string, unknown>[],
): MarkdownFiles | undefined {
  const roots = blocks.filter((block) => block.type !== "child_page")
  const root = roots[0]
  if (root?.type !== "paragraph") return
  const spans = property(root.paragraph).rich_text
  if (
    !Array.isArray(spans) ||
    !spans.some((span) =>
      String(property(property(span).text).content ?? "").includes(MARKDOWN_FILES_MARKER),
    )
  )
    return
  const first = text(spans)
  if (!first.startsWith(MARKDOWN_FILES_MARKER)) return
  let main: string
  try {
    const parsed = JSON.parse(first.slice(MARKDOWN_FILES_MARKER.length).trim())
    if (
      Object.keys(parsed).join(",") !== "main" ||
      typeof parsed.main !== "string" ||
      normalizePath(parsed.main) !== parsed.main
    )
      throw Error()
    main = parsed.main
  } catch {
    throw fail("MARKDOWN_FILES_INVALID", "The editable file entrypoint marker is invalid.")
  }
  const files: Array<{ path: string; bytes: Uint8Array }> = [],
    seen = new Set<string>()
  let current: { path: string; id: string; chunks: string[] } | undefined
  const finish = () => {
    if (!current) return
    if (!current.chunks.length)
      throw fail("MARKDOWN_FILES_INVALID", "A file has no code content block.", {
        path: current.path,
      })
    files.push({ path: current.path, bytes: new TextEncoder().encode(current.chunks.join("")) })
  }
  const rootOwner = property(root.parent)
  for (const block of roots.slice(1)) {
    const parent = property(block.parent)
    if (
      block.type === "toggle" &&
      parent.type === rootOwner.type &&
      parent[String(parent.type)] === rootOwner[String(rootOwner.type)]
    ) {
      finish()
      const path = text(property(block.toggle).rich_text)
      if (!path || normalizePath(path) !== path || seen.has(path) || typeof block.id !== "string")
        throw fail("MARKDOWN_FILES_INVALID", "A file path is invalid or duplicated.", { path })
      seen.add(path)
      current = { path, id: block.id, chunks: [] }
    } else if (
      current &&
      block.type === "code" &&
      block.has_children === false &&
      parent.type === "block_id" &&
      parent.block_id === current.id
    ) {
      if (text(property(block.code).caption ?? []) !== "")
        throw fail(
          "MARKDOWN_FILES_INVALID",
          "File code captions cannot carry unconsumed instructions.",
        )
      current.chunks.push(text(property(block.code).rich_text))
    } else
      throw fail("MARKDOWN_FILES_INVALID", "Unexpected content outside the editable file tree.", {
        block_id: block.id,
        type: block.type,
      })
  }
  finish()
  if (
    !seen.has(main) ||
    files.length > 10000 ||
    files.reduce((n, f) => n + f.bytes.length, 0) > 128 * 1024 * 1024
  )
    throw fail(
      "MARKDOWN_FILES_INVALID",
      "The editable file tree is incomplete or exceeds its bounds.",
    )
  return { main, files }
}
export function readMarkdownFileBlocks(page: string, api: Notion["Service"]) {
  return Effect.gen(function* () {
    const blocks: Record<string, unknown>[] = [],
      seen = new Set<string>()
    const walk = (id: string, depth: number): Effect.Effect<void, SkillsError> =>
      Effect.gen(function* () {
        if (depth > 2 || seen.has(id))
          return yield* Effect.fail(
            fail("MARKDOWN_FILES_INVALID", "Invalid file tree depth or repeated owner."),
          )
        seen.add(id)
        let cursor: string | undefined
        const cursors = new Set<string>()
        do {
          const raw = property(
            yield* api.request(
              `v1/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
            ),
          )
          if (!Array.isArray(raw.results) || typeof raw.has_more !== "boolean")
            return yield* Effect.fail(
              fail("INVALID_RESPONSE", "Incomplete editable file inventory."),
            )
          for (const value of raw.results) {
            const block = property(value),
              parent = property(block.parent)
            if (
              typeof block.id !== "string" ||
              typeof block.has_children !== "boolean" ||
              !["page_id", "block_id"].includes(String(parent.type)) ||
              parent[String(parent.type)] !== id ||
              blocks.length >= 20000
            )
              return yield* Effect.fail(
                fail("MARKDOWN_FILES_INVALID", "File block ownership is incomplete."),
              )
            blocks.push(block)
            if (block.has_children && block.type !== "child_page") yield* walk(block.id, depth + 1)
          }
          if (!raw.has_more) break
          if (
            typeof raw.next_cursor !== "string" ||
            !raw.next_cursor ||
            cursors.has(raw.next_cursor)
          )
            return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid editable file cursor."))
          cursor = raw.next_cursor
          cursors.add(cursor)
        } while (cursor)
      })
    yield* walk(page, 0)
    return blocks
  })
}
