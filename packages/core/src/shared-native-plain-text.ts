import { Effect } from "effect"
import { fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { parseSkillRef } from "./skill-ref.ts"
import { decodeNativeSkillLink, encodeNativeSkillLink } from "./shared-native-skill-link.ts"
import type { CurrentOperationSession } from "./shared-current-operation.ts"
import { readCurrentBodyBlocks } from "./shared-current-projection.ts"
import {
  nativeMarkdownStructure,
  type NativeMarkdownInline as Inline,
} from "./shared-native-markdown.ts"
import { canonicalSharedJson as canonical } from "./shared-records.ts"

type Document = ReturnType<typeof nativeMarkdownStructure>
type Block = Document["blocks"][number]
type Group = { readonly expected: readonly Inline[]; readonly observed: readonly Inline[] }
type Rich = {
  readonly type: "text"
  readonly text: { readonly content: string; readonly link: { readonly url: string } | null }
  readonly annotations: {
    readonly bold: boolean
    readonly italic: boolean
    readonly strikethrough: boolean
    readonly underline: boolean
    readonly code: boolean
    readonly color: "default"
  }
}
const invalid = () =>
  fail(
    "CURRENT_NATIVE_ROUNDTRIP",
    "The complete native body cannot be bound to an exact inline correction. The current intent remains pending.",
  )
const checked = <A>(read: () => A) =>
  Effect.try({ try: read, catch: (error) => (error instanceof SkillsError ? error : invalid()) })
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b)

function groups(document: Document) {
  const values: (readonly Inline[])[] = []
  const content = (parts: readonly Inline[], keepEmpty = false) => {
    if (parts.some((part) => part.kind === "image") || (!parts.length && !keepEmpty)) return parts
    values.push(parts)
    return { inline_group: values.length - 1 }
  }
  const walk = (blocks: readonly Block[]): readonly unknown[] =>
    blocks.map((block) => {
      switch (block.kind) {
        case "paragraph":
        case "heading":
          return { ...block, content: content(block.content) }
        case "quote":
          return { ...block, blocks: walk(block.blocks) }
        case "list":
          return {
            ...block,
            items: block.items.map((item) => ({ ...item, blocks: walk(item.blocks) })),
          }
        case "table":
          return {
            ...block,
            header: block.header.map((cell) => content(cell, true)),
            rows: block.rows.map((row) => row.map((cell) => content(cell, true))),
          }
        default:
          return block
      }
    })
  return { shape: walk(document.blocks), values }
}

/** Only Notion's added HTTP link for that exact plain domain-like text is eligible.
 * An authored link, code span, changed text or another destination is never repaired. */
function automaticLink(part: Extract<Inline, { kind: "text" }>): boolean {
  if (
    part.code ||
    part.link === null ||
    part.link.title !== null ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:\/[^\s<>]*)?$/iu.test(
      part.text,
    )
  )
    return false
  try {
    return new URL("http://" + part.text).href === part.link.href
  } catch {
    return false
  }
}

/** The Markdown endpoint can drop a Skill hyperlink. Its native wire form is a
 * reversible path spelling; correction never resolves, rebinds or selects it. */
function authoredSkillLink(part: Extract<Inline, { kind: "text" }>): boolean {
  if (part.link === null || part.link.title !== null) return false
  try {
    parseSkillRef(part.link.href)
    return true
  } catch {
    return false
  }
}

function compatible(
  expected: readonly Inline[],
  observed: readonly Inline[],
  added: Set<string>,
  dropped: Set<string>,
): boolean {
  let left = 0,
    right = 0,
    leftOffset = 0,
    rightOffset = 0
  while (left < expected.length && right < observed.length) {
    const a = expected[left]!,
      b = observed[right]!
    if (a.kind !== "text" || b.kind !== "text") {
      if (leftOffset || rightOffset || !same(a, b)) return false
      left++
      right++
      continue
    }
    if (a.code !== b.code || !same(a.style, b.style)) return false
    if (!same(a.link, b.link)) {
      if (a.link === null && !a.code && automaticLink(b)) added.add(canonical(b.link))
      else if (b.link === null && authoredSkillLink(a)) dropped.add(canonical(a.link))
      else return false
    }
    const count = Math.min(a.text.length - leftOffset, b.text.length - rightOffset)
    if (
      count <= 0 ||
      a.text.slice(leftOffset, leftOffset + count) !==
        b.text.slice(rightOffset, rightOffset + count)
    )
      return false
    leftOffset += count
    rightOffset += count
    if (leftOffset === a.text.length) {
      left++
      leftOffset = 0
    }
    if (rightOffset === b.text.length) {
      right++
      rightOffset = 0
    }
  }
  return left === expected.length && right === observed.length
}

/** An intermediate management plan, never a relaxed comparison or consumption result. */
export function nativePlainTextPlan(input: {
  readonly expected: string
  readonly observed: string
}): readonly Group[] | undefined {
  const expected = nativeMarkdownStructure(input.expected)
  let observed: Document
  try {
    observed = nativeMarkdownStructure(input.observed)
  } catch {
    return
  }
  const a = groups(expected),
    b = groups(observed),
    added = new Set<string>(),
    dropped = new Set<string>()
  if (!same(a.shape, b.shape) || a.values.length !== b.values.length) return
  for (const [index, value] of a.values.entries())
    if (!compatible(value, b.values[index]!, added, dropped)) return
  const original = new Set(expected.destinations.map(canonical)),
    actual = new Set(observed.destinations.map(canonical))
  if (
    [...original].some((value) => !actual.has(value) && !dropped.has(value)) ||
    [...actual].some((value) => !original.has(value) && !added.has(value))
  )
    return
  return a.values.map((expected, index) => ({ expected, observed: b.values[index]! }))
}

function append(parts: Inline[], part: Inline): void {
  if (part.kind === "text" && !part.text) return
  const previous = parts.at(-1)
  if (
    previous?.kind === "text" &&
    part.kind === "text" &&
    same({ ...previous, text: "" }, { ...part, text: "" })
  )
    parts[parts.length - 1] = { ...previous, text: previous.text + part.text }
  else parts.push(part)
}
function url(value: string): string {
  try {
    const parsed = new URL(value)
    if (/^https?:$/u.test(parsed.protocol)) return parsed.href
  } catch {
    /* Other protocols are validated by their own parser below. */
  }
  return decodeNativeSkillLink(value)
}
function inlineFromRich(input: unknown): readonly Inline[] {
  if (!Array.isArray(input)) throw invalid()
  const result: Inline[] = []
  for (const raw of input) {
    const span = property(raw),
      text = property(span.text),
      annotations = property(span.annotations)
    if (
      span.type !== "text" ||
      typeof text.content !== "string" ||
      span.plain_text !== text.content ||
      !["bold", "italic", "strikethrough", "underline", "code"].every(
        (key) => typeof annotations[key] === "boolean",
      ) ||
      annotations.color !== "default"
    )
      throw invalid()
    const selected = text.link === null ? null : property(text.link)
    if (selected !== null && typeof selected.url !== "string") throw invalid()
    const link = selected === null ? null : { href: url(String(selected.url)), title: null }
    if (
      (link === null && span.href !== null) ||
      (link !== null && (typeof span.href !== "string" || url(span.href) !== link.href))
    )
      throw invalid()
    const style = {
      bold: annotations.bold === true,
      italic: annotations.italic === true,
      strike: annotations.strikethrough === true,
      underline: annotations.underline === true,
    }
    if (annotations.code === true)
      append(result, { kind: "text", text: text.content, style, link, code: true })
    else
      for (const [index, value] of text.content.split("\n").entries()) {
        if (index) append(result, { kind: "break", style, link })
        append(result, { kind: "text", text: value, style, link, code: false })
      }
  }
  return result
}
function richFromInline(parts: readonly Inline[]): readonly Rich[] {
  const result: Rich[] = []
  for (const part of parts) {
    if (part.kind === "image" || part.link?.title != null) throw invalid()
    const text = part.kind === "break" ? "\n" : part.text
    const annotations = {
      bold: part.style.bold,
      italic: part.style.italic,
      strikethrough: part.style.strike,
      underline: part.style.underline,
      code: part.kind === "text" && part.code,
      color: "default" as const,
    }
    const link = part.link === null ? null : { url: encodeNativeSkillLink(part.link.href) }
    for (let start = 0; start < text.length; ) {
      let end = Math.min(start + 2000, text.length)
      if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--
      result.push({ type: "text", text: { content: text.slice(start, end), link }, annotations })
      start = end
    }
  }
  if (result.length > 100) throw invalid()
  return result
}

const textTypes = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "heading_4",
  "quote",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
])
export type CurrentNativePlainTextTarget = {
  readonly id: string
  readonly parent: string
  readonly type: string
  readonly shape: string
  readonly groups: readonly Group[]
  readonly body: Record<string, unknown>
  readonly changed: boolean
}
function blockShape(raw: Record<string, unknown>): string {
  const type = String(raw.type),
    body = { ...property(raw[type]) }
  delete body.rich_text
  delete body.cells
  return canonical({ type, parent: raw.parent, has_children: raw.has_children, body })
}
function blockGroups(raw: Record<string, unknown>): readonly (readonly Inline[])[] {
  if (raw.type === "table_row") {
    const cells = property(raw.table_row).cells
    if (!Array.isArray(cells)) throw invalid()
    return cells.map(inlineFromRich)
  }
  if (!textTypes.has(String(raw.type))) return []
  const parts = inlineFromRich(property(raw[String(raw.type)]).rich_text)
  return parts.length ? [parts] : []
}

/** Bind the entire Markdown observation to a complete physical block inventory.
 * The request is rebuilt from original author spans, so an accepted PATCH has
 * the same identity after Notion coalesces its rich_text response. */
export function planCurrentNativePlainText(input: {
  readonly page: string
  readonly groups: readonly Group[]
  readonly pendingAction?: string
}) {
  return Effect.gen(function* () {
    const targets: CurrentNativePlainTextTarget[] = [],
      seen = new Set<string>()
    let offset = 0
    const visit = (parent: string, depth: number): Effect.Effect<void, SkillsError, Notion> =>
      Effect.gen(function* () {
        if (depth > 64) return yield* Effect.fail(invalid())
        for (const block of yield* readCurrentBodyBlocks(parent)) {
          if (seen.has(block.id) || seen.size >= 20000) return yield* Effect.fail(invalid())
          seen.add(block.id)
          const observed = yield* checked(() => blockGroups(block.value))
          const selected = input.groups.slice(offset, offset + observed.length)
          offset += observed.length
          if (
            observed.length !== selected.length ||
            observed.some((parts, index) => !same(parts, selected[index]!.observed))
          )
            return yield* Effect.fail(invalid())
          const changed = selected.some((group) => !same(group.expected, group.observed))
          const pending = input.pendingAction === `native:${input.page}:plain:${block.id}`
          if (changed || pending) {
            if (
              !selected.some((group) =>
                group.expected.some(
                  (part) =>
                    part.kind === "text" &&
                    ((!part.code && part.link === null) || authoredSkillLink(part)),
                ),
              )
            )
              return yield* Effect.fail(invalid())
            const body = yield* checked(() => ({
              [String(block.value.type)]:
                block.value.type === "table_row"
                  ? { cells: selected.map((group) => richFromInline(group.expected)) }
                  : { rich_text: richFromInline(selected[0]!.expected) },
            }))
            if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 450000)
              return yield* Effect.fail(invalid())
            targets.push({
              id: block.id,
              parent,
              type: String(block.value.type),
              shape: blockShape(block.value),
              groups: selected,
              body,
              changed,
            })
          }
          if (block.value.has_children === true) yield* visit(block.id, depth + 1)
        }
      })
    yield* visit(input.page, 0)
    if (offset !== input.groups.length) return yield* Effect.fail(invalid())
    if (
      input.pendingAction?.startsWith(`native:${input.page}:plain:`) &&
      !targets.some((target) => input.pendingAction === `native:${input.page}:plain:${target.id}`)
    )
      return yield* Effect.fail(invalid())
    return targets
  })
}

export function applyCurrentNativePlainText(input: {
  readonly page: string
  readonly targets: readonly CurrentNativePlainTextTarget[]
  readonly dispatch: CurrentOperationSession["dispatch"]
}) {
  return Effect.gen(function* () {
    const api = yield* Notion
    for (const target of input.targets) {
      const observe = (raw: unknown) =>
        checked(() => {
          const value = property(raw),
            parent = property(value.parent)
          if (
            value.object !== "block" ||
            typeof value.id !== "string" ||
            pageId(value.id) !== target.id ||
            value.type !== target.type ||
            !["page_id", "block_id"].includes(String(parent.type)) ||
            pageId(String(parent[String(parent.type)])) !== target.parent ||
            value.in_trash === true ||
            value.archived === true ||
            blockShape(value) !== target.shape
          )
            throw invalid()
          const actual = blockGroups(value)
          if (
            actual.length !== target.groups.length ||
            actual.some(
              (parts, index) =>
                !compatible(target.groups[index]!.expected, parts, new Set(), new Set()),
            )
          )
            throw invalid()
          return actual.every((parts, index) => same(parts, target.groups[index]!.expected))
            ? { status: "complete" as const, value: undefined }
            : { status: "missing" as const }
        })
      yield* input.dispatch({
        key: `native:${input.page}:plain:${target.id}`,
        replay: "idempotent",
        request: {
          path: `v1/blocks/${target.id}`,
          body: target.body,
          options: { method: "PATCH", content: "body" },
        },
        observe: () =>
          Effect.gen(function* () {
            return yield* observe(
              yield* api.request(`v1/blocks/${target.id}`, undefined, { content: "body" }),
            )
          }),
        acknowledge: (raw) =>
          Effect.gen(function* () {
            if ((yield* observe(raw)).status !== "complete") return yield* Effect.fail(invalid())
          }),
      })
    }
  })
}
