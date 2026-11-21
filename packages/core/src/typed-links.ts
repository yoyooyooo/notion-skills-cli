import { Effect } from "effect"
import { fail, property, type SkillsError } from "./model.ts"
import type { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { referenceProse } from "./shared-file-references.ts"

type Block = Record<string, unknown>

export function mapMarkdownLinks(markdown: string, change: (url: string) => string) {
  // Mask code/comments using the same boundary as local resource validation.
  // Offsets stay in the original source; labels and whitespace remain byte exact.
  const visible = referenceProse(markdown)
  const edits: { start: number; end: number; text: string }[] = []
  const pattern =
    /(\]\(\s*<?)([^\s)>]+)(>?)(?=\s|\))|(^[ \t]*\[[^\]\n]+\]:[ \t]*<?)([^\s>]+)(>?)|((?:https?:\/\/)[^\s<>\)\]"']+)/gm
  for (const match of visible.matchAll(pattern)) {
    const href = match[2] ?? match[5] ?? match[7]
    if (href === undefined) continue
    const offset = match.index + (match[1]?.length ?? match[4]?.length ?? 0)
    // Native entity tags are handled separately; URL attributes are not prose.
    const before = visible.slice(0, offset)
    const tag = before.lastIndexOf("<") > before.lastIndexOf(">")
    if (tag && !(before.endsWith("<") && !/[A-Za-z]/u.test(visible[offset - 2] ?? ""))) continue
    if (match[7] !== undefined && /["'=]/u.test(visible[offset - 1] ?? "")) continue
    const text = change(markdown.slice(offset, offset + href.length))
    if (text !== href) edits.push({ start: offset, end: offset + href.length, text })
  }
  let result = markdown
  for (const edit of edits.reverse())
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  return result
}

// Descend only within the selected page's own block tree. A child_page is a
// separate permission/content boundary and is read by readReferences explicitly.
export function readLinkBlocks(
  page: string,
  api: Notion["Service"],
  options?: { readonly completeBodyEvidence?: boolean },
) {
  return Effect.gen(function* () {
    const blocks: Block[] = []
    const identity = (id: string) => pageId(id) ?? id
    const visited = new Set<string>([identity(page)])
    function children(id: string, depth: number): Effect.Effect<void, SkillsError> {
      return Effect.gen(function* () {
        if (depth > 32)
          return yield* Effect.fail(
            fail("INVALID_RESPONSE", "Block nesting exceeds the supported scope."),
          )
        let cursor: string | undefined,
          pages = 0
        const cursors = new Set<string>()
        do {
          if (++pages > 50)
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
          if (
            options?.completeBodyEvidence &&
            (result.object !== "list" || (!result.has_more && result.next_cursor !== null))
          )
            return yield* Effect.fail(
              fail(
                "INVALID_RESPONSE",
                "Body completion requires an explicit complete block inventory.",
              ),
            )
          for (const raw of result.results) {
            const block = property(raw)
            if (typeof block.id !== "string" || typeof block.type !== "string")
              return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid link block identity."))
            {
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
              block.type !== "synced_block"
            )
              yield* children(block.id, depth + 1)
          }
          if (!result.has_more) {
            if (result.next_cursor !== undefined && result.next_cursor !== null)
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
