import { SourceLexer } from "@notion-skills-cli/markdown"
import type { Token } from "marked"
import { fail } from "./model.ts"
import { assertImportedMarkdownContent } from "./shared-import-markdown.ts"
import type { SharedCreatePlan } from "./shared-create-model.ts"

export const nativeImageBlocksPolicy = "native_image_blocks_v1"
export const nativeLinkedImagesPolicy = "native_linked_images_v2"
export type NativeImagePolicy = typeof nativeImageBlocksPolicy | typeof nativeLinkedImagesPolicy

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

type NativeLinkedImageLayout =
  | {
      readonly kind: "unchanged"
      readonly policy: typeof nativeLinkedImagesPolicy
      readonly markdown: string
    }
  | {
      readonly kind: "changed"
      readonly policy: typeof nativeLinkedImagesPolicy
      readonly markdown: string
      readonly summary: Extract<NativeImageLayout, { kind: "changed" }>["summary"] & {
        readonly detached_linked_images: number
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

/** Forward representation for a separately authorized request, never a new
 * equivalence rule for arbitrary source/readback pairs. Keep each image token
 * and the complete outer link destination/title bytes. Only an image-only
 * top-level paragraph can acquire an adjacent explicit text link. */
export function projectNativeLinkedImages(markdown: string): NativeLinkedImageLayout {
  const spaced = projectNativeImageBlocks(markdown)
  const tokens = SourceLexer.lex(spaced.markdown)
  if (tokens.map((token) => token.raw).join("") !== spaced.markdown) return unsupported()
  let detached = 0
  const candidate = tokens
    .map((paragraph) => {
      if (paragraph.type !== "paragraph") return paragraph.raw
      const parts = paragraph.tokens ?? []
      const meaningful = parts.filter((part) => !(part.type === "text" && /^\s*$/u.test(part.raw)))
      const link = meaningful[0]
      if (
        meaningful.length !== 1 ||
        link?.type !== "link" ||
        link.tokens?.length !== 1 ||
        link.tokens[0]?.type !== "image"
      )
        return paragraph.raw
      const image = link.tokens[0]
      if (
        parts.map((part) => part.raw).join("") !== paragraph.raw ||
        !link.raw.startsWith(`[${image.raw}](`) ||
        !link.raw.endsWith(")") ||
        /[\r\n]/u.test(image.text)
      )
        return unsupported()
      // Escape the copied label, not the image or the original link suffix.
      const label = (image.text || "Image link").replace(/[\\`*_[\]<>~]/gu, "\\$&")
      const textLink = `[${label}${link.raw.slice(1 + image.raw.length)}`
      detached++
      return parts
        .map((part) => (part === link ? `${image.raw}\n\n${textLink}` : part.raw))
        .join("")
    })
    .join("")
  const summary = {
    ...(spaced.kind === "changed"
      ? spaced.summary
      : { paragraphs: 0, images: 0, linked_images: 0, inserted_line_feeds: 0 }),
    detached_linked_images: detached,
  }
  return detached === 0
    ? { kind: "unchanged" as const, policy: nativeLinkedImagesPolicy, markdown }
    : { kind: "changed" as const, policy: nativeLinkedImagesPolicy, markdown: candidate, summary }
}

export function projectNativeImages(markdown: string, policy: NativeImagePolicy) {
  if (policy === nativeImageBlocksPolicy) return projectNativeImageBlocks(markdown)
  if (policy === nativeLinkedImagesPolicy) return projectNativeLinkedImages(markdown)
  return unsupported()
}

/** Only consumers holding the verified resubmission authority select this
 * expected reading representation. The frozen input/event/source remain intact. */
export function nativeResubmissionReadbackFile(
  file: SharedCreatePlan["files"][number],
  policy: NativeImagePolicy,
) {
  if (policy === nativeImageBlocksPolicy) return file
  const projected = projectNativeLinkedImages(file.projection.markdown)
  if (projected.kind !== "changed") return unsupported()
  return { ...file, projection: { ...file.projection, markdown: projected.markdown } }
}
