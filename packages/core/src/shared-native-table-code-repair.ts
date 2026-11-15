import { Schema } from "effect"
import { fail, property } from "./model.ts"
import { pageId } from "./ref.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import {
  assertImportedMarkdownContent,
  deriveImportedTableCodePaddingRepair,
} from "./shared-import-markdown.ts"
import { mapMarkdownLinks } from "./typed-links.ts"

const Annotations = Schema.Struct({
  bold: Schema.Boolean,
  italic: Schema.Boolean,
  strikethrough: Schema.Boolean,
  underline: Schema.Boolean,
  code: Schema.Boolean,
  color: Schema.String,
})
export const RepairRichTextSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.Struct({
    content: Schema.String,
    link: Schema.NullOr(Schema.Struct({ url: Schema.String })),
  }),
  annotations: Annotations,
})
export const RepairTableRowSchema = Schema.Struct({
  row_id: Schema.String,
  table_id: Schema.String,
  cells: Schema.Array(Schema.Array(RepairRichTextSchema)),
})
export type RepairTableRow = typeof RepairTableRowSchema.Type
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
export const SourceFileRepairProofSchema = Schema.Struct({
  review_id: Schema.String.check(Schema.isPattern(/^source-file-repair-[a-f0-9]{64}$/u)),
  file_id: Schema.String,
  review_record_hash: Hash,
  outcome_record_hash: Hash,
})
export type SourceFileRepairProof = typeof SourceFileRepairProofSchema.Type
const invalid = () =>
  fail(
    "SOURCE_FILE_REPAIR_UNSUPPORTED",
    "The complete physical table row is outside the exact code-marker repair contract.",
  )

/** Normalize only API-owned response metadata. Every editable rich-text field
 * is retained; mentions/equations/unknown spans are not silently flattened. */
export function nativeRepairTableRow(input: unknown): RepairTableRow {
  const raw = property(input),
    parent = property(raw.parent),
    value = property(raw.table_row)
  if (
    raw.object !== "block" ||
    raw.type !== "table_row" ||
    raw.has_children !== false ||
    raw.archived === true ||
    raw.in_trash === true ||
    typeof raw.id !== "string" ||
    pageId(raw.id) !== raw.id ||
    parent.type !== "block_id" ||
    typeof parent.block_id !== "string" ||
    pageId(parent.block_id) !== parent.block_id ||
    !Array.isArray(value.cells) ||
    value.cells.length < 1 ||
    value.cells.length > 100
  )
    throw invalid()
  const cells = value.cells.map((cell: unknown) => {
    if (!Array.isArray(cell) || cell.length > 100) throw invalid()
    return cell.map((item: unknown) => {
      const span = property(item),
        text = property(span.text)
      if (
        span.type !== "text" ||
        typeof text.content !== "string" ||
        span.plain_text !== text.content ||
        (span.href ?? null) !== (text.link === null ? null : property(text.link).url)
      )
        throw invalid()
      return Schema.decodeUnknownSync(RepairRichTextSchema)(
        { type: span.type, text: span.text, annotations: span.annotations },
        { onExcessProperty: "error" },
      )
    })
  })
  return { row_id: raw.id, table_id: parent.block_id, cells }
}

export function deriveNativeTableCodePatch(before: RepairTableRow) {
  let changed = 0
  const cells = before.cells.map((cell) =>
    cell.map((span) => {
      if (!span.annotations.code || span.text.content !== "  • ") return span
      if (span.text.link !== null) throw invalid()
      changed++
      return { ...span, text: { ...span.text, content: "•" } }
    }),
  )
  if (changed !== 1) throw invalid()
  return { ...before, cells }
}

export const sameNativeRepairRow = (a: RepairTableRow, b: RepairTableRow) =>
  canonicalSharedJson(a) === canonicalSharedJson(b)

/** Keep byte equality outside the one repaired row. Within it, permit only
 * root-slash serialization of an already-bound physical bare-host link.
 * Strict original code/text/explicit destinations remain independently checked. */
export function assertPhysicalCodeRepairReadback(input: {
  expected: string
  before: string
  after: string
  row: RepairTableRow
}) {
  const proposed = deriveImportedTableCodePaddingRepair(input.expected, input.before).markdown
  assertImportedMarkdownContent(input.expected, input.after)
  if (proposed === input.after) return
  const before = input.before.split("\n"),
    candidate = proposed.split("\n"),
    actual = input.after.split("\n")
  const at = before.flatMap((line, index) => (line === candidate[index] ? [] : [index]))
  if (at.length !== 1 || candidate.length !== actual.length || before.length !== candidate.length)
    throw fail(
      "SOURCE_FILE_REPAIR_REQUIRED",
      "Native readback changed structure beyond the exact reviewed table row.",
    )
  const target = at[0]!
  if (candidate.some((line, index) => index !== target && line !== actual[index]))
    throw fail(
      "SOURCE_FILE_REPAIR_REQUIRED",
      "Native readback changed bytes outside the original repaired row.",
    )
  const aliases = new Map<string, string>()
  // A later automatic link must never "stand in" for a changed authored
  // destination. Only URLs absent from the original URL-bearing prose are
  // eligible for this narrow provider-generated representation exception.
  // mapMarkdownLinks shares the original code/comment masking boundary.
  const originalUrls = new Set<string>()
  mapMarkdownLinks(input.expected, (href) => {
    originalUrls.add(href)
    return href
  })
  for (const cell of input.row.cells)
    for (const span of cell) {
      const href = span.text.link?.url
      if (href === undefined || span.annotations.code) continue
      const match = /^(https?:\/\/)([A-Za-z0-9][A-Za-z0-9.-]*)\/?$/u.exec(href)
      if (!match || span.text.content !== match[2]) continue
      const base = match[1]! + match[2]!
      if (originalUrls.has(base) || originalUrls.has(base + "/")) continue
      aliases.set(base, href)
      aliases.set(base + "/", href)
    }
  const normalize = (line: string) => mapMarkdownLinks(line, (href) => aliases.get(href) ?? href)
  if (normalize(candidate[target]!) !== normalize(actual[target]!))
    throw fail(
      "SOURCE_FILE_REPAIR_REQUIRED",
      "The repaired row has a change other than an already-bound bare-host root slash.",
    )
}
