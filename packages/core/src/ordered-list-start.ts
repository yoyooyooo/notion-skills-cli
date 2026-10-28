import { Lexer, type Token, type Tokens } from "marked"
import { sameMarkdownStructure } from "@notion-skills-cli/markdown"
import {
  codeLanguage,
  fromNotionMarkdown,
  markdownStructure,
  projectNotionBlocks,
} from "./markdown.ts"

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

interface Atom {
  readonly code: boolean
  readonly link: string | null
  readonly text: string
}
const space = (): Atom => ({ code: false, link: null, text: " " })
// Block rich text lowercases a bare HTTP host and adds its root slash, while
// Markdown readback can retain the authored host spelling. Only that URL
// serialization is equivalent here; schemes, ports and non-root paths stay exact.
const rootHostDestination = (link: string | null) =>
  link?.replace(
    /^(https?:\/\/)([a-z0-9.-]+)\/?$/i,
    (_match, scheme: string, host: string) => scheme.toLowerCase() + host.toLowerCase() + "/",
  ) ?? null

function normalizedAtoms(atoms: readonly Atom[]) {
  const merged: Atom[] = []
  for (const atom of atoms) {
    const text = atom.code ? atom.text : atom.text.replace(/\s+/g, " ")
    const link = rootHostDestination(atom.link)
    const previous = merged.at(-1)
    if (previous && previous.code === atom.code && previous.link === link) {
      const combined = previous.text + text
      merged[merged.length - 1] = {
        ...atom,
        link,
        text: atom.code ? combined : combined.replace(/\s+/g, " "),
      }
    } else if (text) merged.push({ ...atom, link, text })
  }
  // Only paragraph-edge plain whitespace is insignificant; code bytes and link
  // labels retain their own boundaries and exact destinations.
  const first = merged[0]
  if (first && !first.code && first.link === null)
    merged[0] = { ...first, text: first.text.trimStart() }
  const last = merged.at(-1)
  if (last && !last.code && last.link === null)
    merged[merged.length - 1] = { ...last, text: last.text.trimEnd() }
  return merged.filter((atom) => atom.text)
}

function richAtoms(value: unknown): Atom[] | undefined {
  if (!Array.isArray(value) || !value.length) return
  const result: Atom[] = []
  for (const raw of value) {
    const rich = record(raw)
    const text = record(rich.text)
    const annotations = record(rich.annotations)
    const link = text.link == null ? null : record(text.link).url
    if (
      rich.type !== "text" ||
      typeof text.content !== "string" ||
      (rich.plain_text !== undefined && rich.plain_text !== text.content) ||
      (link !== null && typeof link !== "string") ||
      (annotations.code !== undefined && typeof annotations.code !== "boolean") ||
      annotations.strikethrough === true ||
      annotations.underline === true ||
      (annotations.color !== undefined && annotations.color !== "default")
    )
      return
    result.push({ text: text.content, code: annotations.code === true, link })
  }
  return result
}

function inlineAtoms(
  tokens: readonly Token[] | undefined,
  link: string | null = null,
): Atom[] | undefined {
  if (!tokens) return
  const result: Atom[] = []
  for (const token of tokens) {
    if (token.type === "strong" || token.type === "em" || (token.type === "text" && token.tokens)) {
      const nested = inlineAtoms(token.tokens!, link)
      if (!nested) return
      result.push(...nested)
    } else if (token.type === "text" || token.type === "escape") {
      result.push({ text: token.text, code: false, link })
    } else if (token.type === "codespan") {
      result.push({ text: token.text, code: true, link })
    } else if (token.type === "link" && link === null && !token.title) {
      const nested = inlineAtoms(token.tokens, token.href)
      if (!nested) return
      result.push(...nested)
    } else if (
      token.type === "br" ||
      (token.type === "html" && /^<br[ \t]*\/?>$/i.test(token.raw))
    ) {
      result.push({ ...space(), link })
    } else return
  }
  return result
}

function leafAtoms(tokens: readonly Token[] | undefined): Atom[] | undefined {
  if (!tokens) return
  const result: Atom[] = []
  for (const token of tokens) {
    if (token.type === "space") continue
    if (token.type !== "paragraph" && token.type !== "text") return
    const atoms = inlineAtoms(token.tokens ?? Lexer.lexInline(token.text))
    if (!atoms) return
    if (result.length) result.push(space())
    result.push(...atoms)
  }
  return result.length ? result : undefined
}

interface RootGroup {
  readonly type: string
  readonly blocks: Record<string, unknown>[]
  readonly items: Atom[][]
  readonly literal?: readonly [string, string]
}

export interface OrderedListStartPlan {
  readonly page_id: string
  readonly block_id: string
  readonly list_ordinal: number
  readonly list_start_index: 0
  readonly corrected_markdown: string
}

/** A proposed remote correction, never a Markdown equivalence rule. */
export function planOrderedListStart(
  pageId: string,
  actual: string,
  target: string,
  roots: readonly unknown[],
): OrderedListStartPlan | undefined {
  const blocks = roots.map(record)
  const ids = new Set<string>()
  for (const block of blocks) {
    const parent = record(block.parent)
    if (
      typeof block.id !== "string" ||
      !block.id ||
      ids.has(block.id) ||
      typeof block.type !== "string" ||
      block.has_children !== false ||
      parent.type !== "page_id" ||
      parent.page_id !== pageId ||
      block.archived === true ||
      block.in_trash === true
    )
      return
    ids.add(block.id)
  }
  const boundaries = projectNotionBlocks(blocks)
  if (!boundaries) return
  const normalized = fromNotionMarkdown(actual, boundaries)
  const expected = markdownStructure(target)
  if (sameMarkdownStructure(markdownStructure(normalized), expected)) return
  const actualTokens = Lexer.lex(normalized).filter(
    (token) => !["space", "def"].includes(token.type),
  )
  const targetTokens = Lexer.lex(target).filter((token) => !["space", "def"].includes(token.type))
  const actualLists = actualTokens.filter(
    (token): token is Tokens.List => token.type === "list" && token.ordered,
  )
  const targetLists = targetTokens.filter(
    (token): token is Tokens.List => token.type === "list" && token.ordered,
  )
  if (!actualLists.length || actualLists.length !== targetLists.length) return

  // Bind the complete ordered root content, including code/link evidence, to
  // the actual readback. Types and visible words alone cannot identify a root.
  // Adjacent paragraphs may serialize together; no other root is discarded.
  const rootGroups: RootGroup[] = []
  for (const block of blocks) {
    const type = String(block.type)
    const mapped = (
      {
        paragraph: "paragraph",
        heading_1: "heading_1",
        heading_2: "heading_2",
        heading_3: "heading_3",
        quote: "blockquote",
        code: "code",
        divider: "hr",
        numbered_list_item: "ordered",
        bulleted_list_item: "unordered",
      } as Record<string, string>
    )[type]
    if (!mapped) return
    const data = record(block[type])
    if (mapped === "hr") {
      rootGroups.push({ type: mapped, blocks: [block], items: [] })
      continue
    }
    const atoms = richAtoms(data.rich_text)
    if (!atoms || !normalizedAtoms(atoms).length) return
    if (mapped === "code") {
      if (
        typeof data.language !== "string" ||
        atoms.some((atom) => atom.code || atom.link !== null) ||
        (data.caption !== undefined && (!Array.isArray(data.caption) || data.caption.length))
      )
        return
      rootGroups.push({
        type: mapped,
        blocks: [block],
        items: [],
        literal: [codeLanguage(data.language), atoms.map((atom) => atom.text).join("")],
      })
      continue
    }
    const prior = rootGroups.at(-1)
    if (prior?.type === mapped && ["paragraph", "ordered", "unordered"].includes(mapped)) {
      prior.blocks.push(block)
      if (mapped === "paragraph") prior.items[0]!.push(space(), ...atoms)
      else prior.items.push(atoms)
    } else rootGroups.push({ type: mapped, blocks: [block], items: [atoms] })
  }
  const tokenGroups: Array<{
    type: string
    items: Atom[][]
    literal?: readonly [string, string]
    token: Token
  }> = []
  for (const token of actualTokens) {
    const type =
      token.type === "list"
        ? token.ordered
          ? "ordered"
          : "unordered"
        : token.type === "heading"
          ? `heading_${token.depth}`
          : token.type
    const items: Atom[][] = []
    let literal: readonly [string, string] | undefined
    if (token.type === "list") {
      for (const item of token.items) {
        if (item.task) return
        const atoms = leafAtoms(item.tokens)
        if (!atoms) return
        items.push(atoms)
      }
    } else if (token.type === "paragraph" || token.type === "heading") {
      const atoms = inlineAtoms(token.tokens)
      if (!atoms) return
      items.push(atoms)
    } else if (token.type === "blockquote") {
      const atoms = leafAtoms(token.tokens)
      if (!atoms) return
      items.push(atoms)
    } else if (token.type === "code") {
      literal = [codeLanguage(token.lang ?? ""), token.text]
    } else if (token.type !== "hr") return
    const prior = tokenGroups.at(-1)
    if (type === "paragraph" && prior?.type === type) prior.items[0]!.push(space(), ...items[0]!)
    else tokenGroups.push({ type, items, ...(literal ? { literal } : {}), token })
  }
  if (rootGroups.length !== tokenGroups.length) return
  const signatures = new Set<string>()
  const groups: Record<string, unknown>[][] = []
  for (const [index, group] of rootGroups.entries()) {
    const actualGroup = tokenGroups[index]!
    const signature = (value: Pick<RootGroup, "type" | "items" | "literal">) =>
      JSON.stringify([value.type, value.items.map(normalizedAtoms), value.literal ?? null])
    if (signature(group) !== signature(actualGroup)) return
    if (group.type === "ordered") {
      // Repeated list content cannot identify which equal-looking list a root
      // belongs to independently. Refuse ambiguity even with matching types.
      const key = signature(group)
      if (signatures.has(key)) return
      signatures.add(key)
      const list = actualGroup.token as Tokens.List
      const first = record(group.blocks[0]!.numbered_list_item)
      if (
        (first.list_start_index ?? 1) !== list.start ||
        (first.list_format !== undefined && first.list_format !== "numbers") ||
        group.blocks.slice(1).some((block) => {
          const data = record(block.numbered_list_item)
          return (
            data.list_start_index !== undefined ||
            (data.list_format !== undefined && data.list_format !== "numbers")
          )
        })
      )
        return
      groups.push(group.blocks)
    }
  }
  if (groups.length !== actualLists.length) return

  const candidates: OrderedListStartPlan[] = []
  for (const [ordinal, list] of actualLists.entries()) {
    const wanted = targetLists[ordinal]!
    const first = groups[ordinal]![0]!
    const start = record(first.numbered_list_item).list_start_index
    // v1 deliberately covers the observed default-one serialization of zero.
    // Other starts and nested list semantics require their own verified support.
    if (
      list.start !== 1 ||
      wanted.start !== 0 ||
      (start !== undefined && start !== 1) ||
      wanted.items.length !== list.items.length ||
      wanted.items.some(
        (item) =>
          item.task ||
          item.tokens.some((token) => !["text", "paragraph", "space"].includes(token.type)),
      )
    )
      continue
    let offset = 0
    let found = -1
    for (const token of actualTokens) {
      const next = normalized.indexOf(token.raw, offset)
      if (next < 0) return
      if (token === list) {
        found = next
        break
      }
      offset = next + token.raw.length
    }
    const prefix = /^( {0,3})1([.)][ \t]+)/.exec(list.raw)
    if (found < 0 || !prefix) continue
    const position = found + prefix[1]!.length
    const before = normalized.slice(0, found)
    // Only one can interrupt a CommonMark paragraph. Preserve the already
    // parsed list boundary in this proposed-after document when changing it to
    // zero; this string is proof input, never a readback equivalence or write.
    const separation = before && !/\n[ \t]*\n$/.test(before) ? "\n" : ""
    const corrected =
      before + separation + normalized.slice(found, position) + "0" + normalized.slice(position + 1)
    if (!sameMarkdownStructure(markdownStructure(corrected), expected)) continue
    candidates.push({
      page_id: pageId,
      block_id: String(first.id),
      list_ordinal: ordinal,
      list_start_index: 0,
      corrected_markdown: corrected,
    })
  }
  return candidates.length === 1 ? candidates[0] : undefined
}
