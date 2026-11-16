import { SourceLexer } from "@notion-skills-cli/markdown"
import type { Token } from "marked"
import { fail } from "./model.ts"
import { assertImportedMarkdownContent } from "./shared-import-markdown.ts"

export const nativeImageBlocksPolicy = "native_image_blocks_v1"

type NativeImageLayout =
  | {
      readonly kind: "unchanged"
      readonly policy: typeof nativeImageBlocksPolicy
      readonly markdown: string
    }
  | {
      readonly kind: "changed"
      readonly policy: typeof nativeImageBlocksPolicy
      readonly markdown: string
      readonly summary: {
        readonly paragraphs: number
        readonly images: number
        readonly linked_images: number
        readonly inserted_line_feeds: number
      }
    }

function imageUnit(token: Token) {
  return (
    token.type === "image" ||
    (token.type === "link" && token.tokens?.length === 1 && token.tokens[0]?.type === "image")
  )
}

function unsupported(): never {
  throw fail(
    "SOURCE_NATIVE_IMAGE_LAYOUT_UNSUPPORTED",
    "The original Markdown cannot be partitioned without changing source spans.",
  )
}

/** Explicit candidate for a new reviewed request. Only top-level paragraphs
 * consisting of images (optionally linked) and whitespace are eligible. All
 * original token bytes remain; inserted blank lines separate adjacent images.
 * Old projection policies and mixed/nested content are never rewritten. */
export function projectNativeImageBlocks(markdown: string): NativeImageLayout {
  const tokens = SourceLexer.lex(markdown)
  if (tokens.map((token) => token.raw).join("") !== markdown) return unsupported()
  const summary = { paragraphs: 0, images: 0, linked_images: 0, inserted_line_feeds: 0 }
  const candidate = tokens
    .map((token) => {
      if (token.type !== "paragraph") return token.raw
      const children = token.tokens ?? []
      if (
        children.some(
          (child) => !imageUnit(child) && !(child.type === "text" && /^\s+$/u.test(child.raw)),
        )
      )
        return token.raw
      const units = children.filter(imageUnit)
      if (units.length < 2) return token.raw
      if (children.map((child) => child.raw).join("") !== token.raw) return unsupported()
      let images = 0,
        gap = "",
        inserted = 0
      const result = children
        .map((child) => {
          if (!imageUnit(child)) {
            gap += child.raw
            return child.raw
          }
          const missing = images === 0 ? 0 : Math.max(0, 2 - (gap.match(/\n/gu)?.length ?? 0))
          images++
          gap = ""
          inserted += missing
          return "\n".repeat(missing) + child.raw
        })
        .join("")
      if (inserted === 0) return token.raw
      summary.paragraphs++
      summary.images += units.length
      summary.linked_images += units.filter((unit) => unit.type === "link").length
      summary.inserted_line_feeds += inserted
      return result
    })
    .join("")
  if (summary.paragraphs === 0)
    return { kind: "unchanged", policy: nativeImageBlocksPolicy, markdown }
  assertImportedMarkdownContent(markdown, candidate)
  return { kind: "changed", policy: nativeImageBlocksPolicy, markdown: candidate, summary }
}
