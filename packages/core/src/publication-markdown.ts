import {
  fromNotionMarkdown,
  markdownStructure,
  samePublishedMarkdown,
  type MarkdownLinkDestinationMatch,
  type NotionBlockBoundary,
} from "./markdown.ts"
import { pageId } from "./ref.ts"

export interface PublicationMarkdownMapping {
  readonly local: (markdown: string) => string
  readonly preserveExternal: (markdown: string) => string
  readonly source?: PublicationMarkdownSource
}

export interface PublicationMarkdownSource {
  readonly path: string
  readonly files: readonly { readonly path: string }[]
}

export type PublicationMarkdownComparator = (
  actual: string,
  target: string,
  blocks?: readonly NotionBlockBoundary[],
  sameLinkDestination?: MarkdownLinkDestinationMatch,
) => boolean

export function notionFilenameAlias(value: string) {
  return /^https?:\/\/([A-Za-z0-9._-]+\.(?:md|markdown))\/?$/i.exec(value)?.[1]
}

function hasExternalMarkdownUrl(markdown: string) {
  const visit = (node: unknown): boolean => {
    if (!Array.isArray(node)) return false
    if (
      (node[0] === "link" || node[0] === "image") &&
      typeof node[1] === "string" &&
      /^https?:\/\//i.test(node[1]) &&
      !pageId(node[1])
    )
      return true
    if (node[0] === "html" && typeof node[1] === "string") {
      // This only selects the stricter proof. HTML itself still compares as a
      // complete AST token, including unquoted attributes and literal prose.
      for (const match of node[1].matchAll(/https?:\/\/[^\s"'<>]+/gi))
        if (!pageId(match[0])) return true
    }
    return node.some(visit)
  }
  return visit(markdownStructure(markdown))
}

// The alias can equal only a real relative filename, never an explicit HTTP URL.
export const sameRelativeFileDestination: MarkdownLinkDestinationMatch = (actual, target) =>
  actual === target || notionFilenameAlias(actual) === target

/** Extend the existing Markdown filename policy only with bound source and live link evidence. */
export function publicationSourceDestination(
  source: PublicationMarkdownSource | undefined,
  blocks?: readonly NotionBlockBoundary[],
): MarkdownLinkDestinationMatch {
  if (!source || !blocks) return sameRelativeFileDestination
  const directory = source.path.slice(0, source.path.lastIndexOf("/") + 1)
  const files = new Set(source.files.map((file) => file.path))
  const hostFile = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/
  // Do not normalize URLs: scheme, filename case, ports and all non-root
  // components remain significant. Only the serialized root slash may differ.
  const rootUrl = (value: string) =>
    /^https?:\/\/[^/:?#@\\\s]+\/?$/.test(value) ? value.replace(/\/$/, "") : undefined
  const links = new Set(
    blocks
      .flatMap((block) => [block, ...(block.descendants ?? [])])
      .flatMap((block) =>
        (block.rich_text ?? []).flatMap((span) => {
          const url = !span.code && span.link !== null ? rootUrl(span.link) : undefined
          return url === undefined ? [] : [url]
        }),
      ),
  )
  return (actual, target) => {
    if (sameRelativeFileDestination(actual, target)) return true
    if (!hostFile.test(target) || !files.has(directory + target)) return false
    const url = rootUrl(actual)
    return (
      url !== undefined &&
      links.has(url) &&
      (url === `https://${target}` || url === `http://${target}`)
    )
  }
}

const compareMarkdown: PublicationMarkdownComparator = (actual, target, blocks, sameLink) =>
  samePublishedMarkdown(actual, target, sameLink, blocks) ||
  samePublishedMarkdown(fromNotionMarkdown(actual, blocks), target, sameLink, blocks)

/** An additional proof; callers still establish body, target and page authority. */
export function publicationExternalLinksMatch(
  actual: string,
  authoredTarget: string,
  preserveExternal: (markdown: string) => string,
  blocks?: readonly NotionBlockBoundary[],
  compare: PublicationMarkdownComparator = compareMarkdown,
  sameLinkDestination: MarkdownLinkDestinationMatch = sameRelativeFileDestination,
) {
  if (!hasExternalMarkdownUrl(authoredTarget)) return true
  // Match original destinations at aligned AST links, never by a URL inventory.
  return compare(
    preserveExternal(actual),
    preserveExternal(authoredTarget),
    blocks,
    sameLinkDestination,
  )
}
