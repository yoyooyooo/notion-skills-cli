import { isDeepStrictEqual } from "node:util"
import { type Token, type Tokens } from "marked"
import { SourceLexer as Lexer } from "@notion-skills-cli/markdown"
import { fail, property } from "./model.ts"
import { projectNotionBlockTree, samePublishedMarkdown } from "./markdown.ts"
import {
  compileSourceRootBody,
  sourceRootBodyMatches,
  sourceRootRichText,
  sourceRootRichTextMatches,
  type PhysicalNode,
  type SourceRootBodyModel,
} from "./source-root-completion-physical.ts"
import {
  sourceRootCompletionAfterMatches,
  sourceRootCompletionInventory,
} from "./source-root-completion-guards.ts"
import type {
  SourceRootCompletionObservation,
  SourceRootCompletionPlan,
} from "./upstream-source-root-completion-model.ts"

type Span = NonNullable<ReturnType<typeof sourceRootRichText>>[number]
export type SourceRootFidelityParent = Pick<SourceRootCompletionPlan, "input" | "before" | "effect">
const equal = isDeepStrictEqual
const refused = (message: string) => fail("SOURCE_ROOT_FIDELITY_REFUSED", message)
const plain = (span: Span) =>
  span.url === null &&
  !span.style.bold &&
  !span.style.italic &&
  !span.style.strikethrough &&
  !span.style.underline &&
  !span.style.code &&
  span.style.color === "default"

export interface SourceRootFidelityEffect {
  readonly index: number
  readonly kind: "restore_literal_entity" | "restore_literal_plus" | "remove_filename_autolink"
  readonly block_id: string
  readonly root_index: number
  readonly row_index: number | null
  readonly column_index: number | null
  readonly occurrences: number
  readonly ancestor_ids: readonly string[]
  readonly source_edit: {
    readonly start: number
    readonly end: number
    readonly source: string
    readonly observed: string
  }
  readonly observed_link: { readonly label: string; readonly url: string } | null
  readonly before_block: Record<string, unknown>
  readonly after_block: Record<string, unknown>
  readonly request: {
    readonly path: string
    readonly method: "PATCH"
    readonly body: Record<string, unknown>
  }
}
export interface SourceRootFidelityDerivation {
  readonly kind: "acknowledged_root_nine_literal_effects"
  readonly effects: readonly SourceRootFidelityEffect[]
  readonly before_body: string
  readonly source_body_model: SourceRootBodyModel
  readonly parent_after_proposed_only: true
}
interface Location {
  readonly token: Token
  readonly start: number
  readonly end: number
  readonly raw: string
}
function list(token: Token): token is Tokens.List {
  return token.type === "list" && Array.isArray(token.items) && typeof token.ordered === "boolean"
}
function table(token: Token): token is Tokens.Table {
  return (
    token.type === "table" &&
    Array.isArray(token.header) &&
    Array.isArray(token.rows) &&
    Array.isArray(token.align)
  )
}
function locations(source: string): readonly Location[] {
  const tokens = Lexer.lex(source),
    result: Location[] = []
  if (tokens.map((token) => token.raw).join("") !== source)
    throw refused("The complete source token ranges must reproduce every authored byte.")
  let offset = 0
  for (const token of tokens) {
    if (list(token)) {
      if (token.items.map((item) => item.raw).join("") !== token.raw)
        throw refused("The original flat list has an unsupported source range.")
      let itemOffset = offset
      for (const item of token.items) {
        result.push({ token, start: itemOffset, end: itemOffset + item.raw.length, raw: item.raw })
        itemOffset += item.raw.length
      }
    } else if (token.type !== "space")
      result.push({ token, start: offset, end: offset + token.raw.length, raw: token.raw })
    offset += token.raw.length
  }
  return result
}
function cellRange(location: Location, row: number, column: number) {
  const token = location.token
  if (!table(token))
    throw refused("A row effect must derive from its original complete source table.")
  const lines = location.raw.split("\n")
  while (lines.at(-1) === "") lines.pop()
  const rows = [token.header, ...token.rows]
  if (lines.length !== rows.length + 1 || !rows[row] || !rows[row]![column])
    throw refused("Only the complete single-line pipe-table source grammar is supported.")
  const lineIndex = row === 0 ? 0 : row + 1,
    line = lines[lineIndex]!
  if (!line.startsWith("|") || !line.endsWith("|") || line.includes("\\|"))
    throw refused("A selected source row cannot contain ambiguous pipe delimiters.")
  const cells = line.slice(1, -1).split("|")
  if (
    cells.length !== token.header.length ||
    cells.some((value, index) => value.trim() !== rows[row]![index]!.text)
  )
    throw refused("All source cells must agree with the complete parsed row.")
  const selected = cells[column]!,
    left = selected.length - selected.trimStart().length
  const start =
    location.start +
    lines.slice(0, lineIndex).reduce((total, value) => total + value.length + 1, 0) +
    1 +
    cells.slice(0, column).reduce((total, value) => total + value.length + 1, 0) +
    left
  return { start, end: start + selected.trim().length, source: selected.trim() }
}
function sourcePhysical(spans: readonly Span[]) {
  return spans.map((span) => {
    if (!span.text || span.text.length > 2000)
      throw refused("A selected source span exceeds the bounded typed PATCH.")
    return {
      type: "text",
      text: { content: span.text, link: span.url === null ? null : { url: span.url } },
      annotations: span.style,
      plain_text: span.text,
      href: span.url,
    }
  })
}
function wire(spans: unknown) {
  if (!sourceRootRichText(spans, false) || !Array.isArray(spans))
    throw refused(
      "The complete requested rich text must retain its physical type, style and destination.",
    )
  return spans.map((value) => {
    const span = property(value),
      body = property(span.text)
    if (typeof body.content !== "string" || !body.content.length || body.content.length > 2000)
      throw refused("A requested text span exceeds its exact API bound.")
    return { type: "text", text: span.text, annotations: span.annotations }
  })
}
function rootHost(url: string, label: string) {
  const match = /^(https?):\/\/([A-Za-z0-9.-]+)\/?$/.exec(url)
  return match &&
    /^[A-Za-z0-9][A-Za-z0-9.-]*\.md$/i.test(label) &&
    match[2]!.toLowerCase() === label.toLowerCase()
    ? `${match[1]}://${label.toLowerCase()}/`
    : undefined
}
function sourceLinks(model: SourceRootBodyModel) {
  return model.roots
    .flatMap((root) =>
      root.type === "table"
        ? root.rows.flatMap((row) => row.flat())
        : "rich_text" in root
          ? root.rich_text
          : [],
    )
    .flatMap((span) => (span.url === null ? [] : [span.url]))
}
function flatten(nodes: readonly PhysicalNode[]): readonly Record<string, unknown>[] {
  return nodes.flatMap((node) => [node.raw, ...flatten(node.children)])
}
export function sourceRootFidelityBody(
  parent: SourceRootFidelityParent,
  effects: readonly SourceRootFidelityEffect[],
  completed: number,
) {
  if (!Number.isSafeInteger(completed) || completed < 0 || completed > effects.length)
    throw refused("The complete source view requires one exact applied-effect prefix.")
  let body = parent.effect.authored_body,
    previous = body.length
  for (const effect of [...effects.slice(completed)].sort(
    (a, b) => b.source_edit.start - a.source_edit.start,
  )) {
    const edit = effect.source_edit
    if (
      !Number.isSafeInteger(edit.start) ||
      !Number.isSafeInteger(edit.end) ||
      edit.start < 0 ||
      edit.end <= edit.start ||
      edit.end > previous ||
      body.slice(edit.start, edit.end) !== edit.source ||
      edit.source === edit.observed
    )
      throw refused("The immutable source edits overlap or differ from their authored bytes.")
    body = body.slice(0, edit.start) + edit.observed + body.slice(edit.end)
    previous = edit.start
  }
  return body
}

/** This is a physical/Markdown coherence proof for a finite observed prefix,
 * never a source-content equivalence rule. Every source root is consumed. */
export function sourceRootFidelityStageMatches(
  parent: SourceRootFidelityParent,
  effects: readonly SourceRootFidelityEffect[],
  observed: SourceRootCompletionObservation,
  completed: number,
) {
  try {
    const inventory = sourceRootCompletionInventory(parent.input.page_id, observed)
    const body = sourceRootFidelityBody(parent, effects, completed),
      compiled = compileSourceRootBody(body)
    if (
      !compiled ||
      !sourceRootBodyMatches(compiled, inventory.ordinary_nodes) ||
      !equal(inventory.references, parent.effect.references)
    )
      return false
    const firstTag = inventory.markdown.indexOf(inventory.references[0]!.tag)
    if (
      firstTag < 0 ||
      !/^[\t\r\n ]*$/.test(
        inventory.markdown.slice(firstTag).replace(/<page url="[^"]+">[^<>]*<\/page>/g, ""),
      )
    )
      return false
    const blocks = projectNotionBlockTree(parent.input.page_id, flatten(inventory.root_nodes))
    if (!blocks) return false
    const links = effects
      .slice(completed)
      .flatMap((effect) => (effect.observed_link ? [effect.observed_link] : []))
    return samePublishedMarkdown(
      inventory.markdown.slice(0, firstTag),
      body,
      (actual, target) =>
        actual === target ||
        links.some(
          (link) =>
            target === link.url && rootHost(actual, link.label) === rootHost(link.url, link.label),
        ),
      blocks,
    )
  } catch {
    return false
  }
}

function projectedAfter(
  parent: SourceRootFidelityParent,
  before: SourceRootCompletionObservation,
  effects: readonly SourceRootFidelityEffect[],
) {
  const raw = structuredClone(before.raw),
    byId = new Map(effects.map((effect) => [effect.block_id, effect.after_block]))
  for (const [path, response] of Object.entries(raw)) {
    if (!/^v1\/blocks\/[^/]+\/children\?/.test(path)) continue
    const list = property(response)
    if (!Array.isArray(list.results))
      throw refused("A complete physical response was lost while projecting the reviewed effects.")
    list.results = list.results.map((value) => byId.get(String(property(value).id)) ?? value)
  }
  const markdown = property(raw[`v1/pages/${parent.input.page_id}/markdown`])
  markdown.markdown = parent.effect.request.body.replace_content.new_str
  return { ...before, raw }
}

/** Derive exactly the evidenced UIUX distortion family. No input supplies block
 * IDs, replacement text or arbitrary effects; all targets come from the source
 * model and the closed, genuinely acknowledged root's present physical graph. */
export function deriveSourceRootFidelity(
  parent: SourceRootFidelityParent,
  before: SourceRootCompletionObservation,
): SourceRootFidelityDerivation {
  const inventory = sourceRootCompletionInventory(parent.input.page_id, before)
  const model = compileSourceRootBody(parent.effect.authored_body),
    ranges = locations(parent.effect.authored_body)
  if (
    !model ||
    model.roots.length !== inventory.ordinary_nodes.length ||
    ranges.length !== model.roots.length ||
    inventory.references.length !== 2 ||
    before.page_ids.length !== 3 ||
    before.attachments.length
  )
    throw refused(
      "The acknowledged body must retain its complete source root order and exactly two original reference pages.",
    )
  const effects: SourceRootFidelityEffect[] = []
  for (const [rootIndex, wanted] of model.roots.entries()) {
    const node = inventory.ordinary_nodes[rootIndex]!,
      location = ranges[rootIndex]!
    if (sourceRootBodyMatches({ version: 1, roots: [wanted] }, [node])) continue
    if (
      wanted.type === "table" &&
      node.raw.type === "table" &&
      node.children.length === wanted.rows.length
    ) {
      for (const [rowIndex, cells] of wanted.rows.entries()) {
        const row = node.children[rowIndex]!,
          rawCells = property(row.raw.table_row).cells
        if (!Array.isArray(rawCells) || rawCells.length !== cells.length)
          throw refused("A selected table row has a different complete physical shape.")
        const differences = cells
          .map((spans, column) =>
            sourceRootRichTextMatches(rawCells[column], spans) ? -1 : column,
          )
          .filter((column) => column >= 0)
        if (!differences.length) continue
        if (differences.length !== 1)
          throw refused(
            "Only one precisely evidenced literal cell may differ in each selected row.",
          )
        const column = differences[0]!,
          source = cells[column]!
        const candidates = [
          { kind: "restore_literal_entity" as const, from: "&lt;", to: "<" },
          { kind: "restore_literal_plus" as const, from: " + ", to: "  • " },
        ].flatMap((candidate) => {
          const count = source.reduce(
            (total, span) => total + (plain(span) ? span.text.split(candidate.from).length - 1 : 0),
            0,
          )
          const observed = source.map((span) =>
            plain(span)
              ? { ...span, text: span.text.replaceAll(candidate.from, candidate.to) }
              : span,
          )
          return count && sourceRootRichTextMatches(rawCells[column], observed)
            ? [{ ...candidate, count }]
            : []
        })
        if (candidates.length !== 1)
          throw refused(
            "The table differs beyond an exact source-bound entity or plus literal distortion.",
          )
        const candidate = candidates[0]!,
          range = cellRange(location, rowIndex, column)
        const afterCells = structuredClone(rawCells)
        afterCells[column] = sourcePhysical(source)
        const after = { ...row.raw, table_row: { cells: afterCells } }
        effects.push({
          index: effects.length,
          kind: candidate.kind,
          block_id: String(row.raw.id),
          root_index: rootIndex,
          row_index: rowIndex,
          column_index: column,
          occurrences: candidate.count,
          ancestor_ids: [String(node.raw.id)],
          source_edit: {
            ...range,
            observed: range.source.replaceAll(candidate.from, candidate.to),
          },
          observed_link: null,
          before_block: row.raw,
          after_block: after,
          request: {
            path: `v1/blocks/${row.raw.id}`,
            method: "PATCH",
            body: { table_row: { cells: afterCells.map(wire) } },
          },
        })
      }
    } else if (
      wanted.type === "bulleted_list_item" &&
      node.raw.type === wanted.type &&
      node.children.length === 0
    ) {
      const rawText = property(node.raw.bulleted_list_item).rich_text,
        spans = sourceRootRichText(rawText, false)
      if (!spans || !Array.isArray(rawText))
        throw refused("The filename-link leaf has unsupported physical rich text.")
      const candidates = spans.filter(
        (span) =>
          span.url !== null &&
          rootHost(span.url, span.text) !== undefined &&
          plain({ ...span, url: null }),
      )
      if (candidates.length !== 1)
        throw refused("Only one exact plain filename autolink is supported in the complete leaf.")
      const linked = candidates[0]!
      if (
        linked.url === null ||
        sourceLinks(model).some(
          (url) => rootHost(url, linked.text) === rootHost(linked.url!, linked.text),
        )
      )
        throw refused(
          "An original explicit source destination cannot use the filename serialization proof.",
        )
      const without = rawText.map((value) => {
        const span = property(value),
          text = property(span.text)
        return text.content === linked.text && property(text.link).url === linked.url
          ? { ...span, text: { ...text, link: null }, href: null }
          : value
      })
      if (
        !sourceRootRichTextMatches(without, wanted.rich_text) ||
        location.raw.split(linked.text).length !== 2
      )
        throw refused(
          "The complete physical leaf differs from its source beyond the single filename link.",
        )
      const start = location.start + location.raw.indexOf(linked.text),
        afterText = sourcePhysical(wanted.rich_text)
      effects.push({
        index: effects.length,
        kind: "remove_filename_autolink",
        block_id: String(node.raw.id),
        root_index: rootIndex,
        row_index: null,
        column_index: null,
        occurrences: 1,
        ancestor_ids: [],
        source_edit: {
          start,
          end: start + linked.text.length,
          source: linked.text,
          observed: `[${linked.text}](${linked.url})`,
        },
        observed_link: { label: linked.text, url: linked.url },
        before_block: node.raw,
        after_block: {
          ...node.raw,
          bulleted_list_item: { ...property(node.raw.bulleted_list_item), rich_text: afterText },
        },
        request: {
          path: `v1/blocks/${node.raw.id}`,
          method: "PATCH",
          body: { bulleted_list_item: { rich_text: wire(afterText) } },
        },
      })
    } else
      throw refused(
        "An unsupported or unselected complete source root differs from the acknowledged physical tree.",
      )
  }
  const entities = effects.filter((effect) => effect.kind === "restore_literal_entity"),
    plus = effects.filter((effect) => effect.kind === "restore_literal_plus"),
    link = effects.filter((effect) => effect.kind === "remove_filename_autolink")
  const affected = new Set(effects.flatMap((effect) => [effect.block_id, ...effect.ancestor_ids]))
  const timesProven = flatten(inventory.root_nodes)
    .filter((block) => affected.has(String(block.id)))
    .every(
      (block) =>
        typeof block.last_edited_time === "string" &&
        Number.isFinite(Date.parse(block.last_edited_time)),
    )
  if (
    effects.length !== 9 ||
    new Set(effects.map((effect) => effect.block_id)).size !== 9 ||
    entities.length !== 2 ||
    entities.some((effect) => effect.occurrences !== 1) ||
    plus.length !== 6 ||
    plus.reduce((total, effect) => total + effect.occurrences, 0) !== 10 ||
    link.length !== 1 ||
    !timesProven ||
    !sourceRootFidelityStageMatches(parent, effects, before, 0)
  )
    throw refused(
      "The complete raw Markdown and physical BEFORE must prove exactly two entity rows, six plus rows and one filename leaf.",
    )
  if (!sourceRootCompletionAfterMatches(parent, projectedAfter(parent, before, effects)))
    throw refused(
      "The nine proposed block effects must reproduce the entire original source model and every retained reference resource.",
    )
  return {
    kind: "acknowledged_root_nine_literal_effects",
    effects,
    before_body: sourceRootFidelityBody(parent, effects, 0),
    source_body_model: model,
    parent_after_proposed_only: true,
  }
}
