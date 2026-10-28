type RepairKind = "literal_file_line_link" | "literal_dollar_equation"
interface Style {
  readonly code: boolean
  readonly bold: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every((key) => allowed.includes(key))
}

// This repair proves only the observed finite serializer forms. An unsupported
// style is not dropped or compared semantically; it makes the proof unavailable.
function style(value: unknown, allowBold = false): Style | undefined {
  const raw = record(value)
  if (
    !raw ||
    !keys(raw, ["bold", "italic", "strikethrough", "underline", "code", "color"]) ||
    typeof raw.bold !== "boolean" ||
    (raw.bold && !allowBold) ||
    raw.italic !== false ||
    raw.strikethrough !== false ||
    raw.underline !== false ||
    typeof raw.code !== "boolean" ||
    raw.color !== "default"
  )
    return
  return { code: raw.code, bold: raw.bold }
}
function literal(value: string, identifiers = false) {
  return value.replace(/[\\`*_\[\]<>$~]/g, (character, index: number) => {
    if (
      identifiers &&
      character === "_" &&
      /[A-Za-z0-9]/.test(value[index - 1] ?? "") &&
      /[A-Za-z0-9]/.test(value[index + 1] ?? "")
    )
      return character
    return `\\${character}`
  })
}

function textReadback(value: Record<string, unknown>, kind: RepairKind): string | undefined {
  const text = record(value.text),
    format = style(value.annotations, kind === "literal_dollar_equation")
  if (
    value.type !== "text" ||
    !keys(value, ["type", "text", "annotations", "plain_text", "href"]) ||
    !text ||
    !keys(text, ["content", "link"]) ||
    typeof text.content !== "string" ||
    text.content.includes("\r") ||
    value.plain_text !== text.content ||
    !format
  )
    return
  if (kind !== "literal_dollar_equation" && text.content.includes("\n")) return
  const destination = text.link == null ? null : record(text.link)
  if (
    text.link != null &&
    (!destination || !keys(destination, ["url"]) || typeof destination.url !== "string")
  )
    return
  const url = destination?.url ?? null
  if (value.href !== url || (format.code && (text.content.includes("`") || url !== null))) return
  if (
    format.bold &&
    (format.code || url !== null || !text.content || text.content.trim() !== text.content)
  )
    return
  const content = format.code
    ? `\`${text.content}\``
    : literal(text.content, kind === "literal_dollar_equation")
  const formatted = format.bold ? `**${content}**` : content
  if (url === null)
    return kind === "literal_dollar_equation" ? formatted.replaceAll("\n", "<br>") : formatted
  if (text.content.includes("\n") || typeof url !== "string" || !url || /[\s()[\]<>\\]/.test(url))
    return
  let serialized = url
  if (url === "file://line") {
    if (kind !== "literal_file_line_link" || text.content !== "file:line") return
    serialized = "file:line"
  } else {
    if (!/^https?:\/\//.test(url)) return
    // The API omits the root slash on a host-labelled auto-link. This binds
    // actual readback to its physical BEFORE value, not source destinations.
    const root = /^(https?:\/\/([^/:?#@\\\s]+))\/$/.exec(url)
    if (root && text.content === root[2]) serialized = root[1]!
  }
  return `[${content}](${serialized})`
}

function equationReadback(value: Record<string, unknown>): string | undefined {
  const equation = record(value.equation),
    format = style(value.annotations)
  const current = typeof equation?.expression === "string" ? equation.expression : ""
  if (
    value.type !== "equation" ||
    !keys(value, ["type", "equation", "annotations", "plain_text", "href"]) ||
    !equation ||
    !keys(equation, ["expression"]) ||
    !current ||
    /[\r\n$]/.test(current) ||
    !current.trim() ||
    (!current.includes("`") && current !== current.trim()) ||
    value.plain_text !== current ||
    value.href !== null ||
    !format ||
    format.code
  )
    return
  // Preserve the malformed equation's actual serialization. Wrapper backticks
  // belong to that serializer, not to source Markdown, and a currency interval
  // has none inside its expression.
  return "$`" + current.trim() + "`$"
}

/** Exact full-leaf BEFORE coherence. This is not a source-content comparator and
 * cannot authorise a mutation or resolve an unknown request on its own. */
export function sourceRichTextRepairInlineMatches(
  actual: string,
  spans: readonly unknown[],
  kind: RepairKind,
): boolean {
  if (
    !["literal_file_line_link", "literal_dollar_equation"].includes(kind) ||
    actual.includes("\r") ||
    (kind !== "literal_dollar_equation" && actual.includes("\n")) ||
    !Array.isArray(spans) ||
    !spans.length
  )
    return false
  let expected = "",
    equations = 0
  for (const span of spans) {
    const value = record(span)
    if (!value) return false
    let rendered: string | undefined
    if (value.type === "equation") {
      if (kind !== "literal_dollar_equation" || ++equations !== 1) return false
      rendered = equationReadback(value)
    } else rendered = textReadback(value, kind)
    if (rendered === undefined) return false
    expected += rendered
  }
  return (kind !== "literal_dollar_equation" || equations === 1) && actual === expected
}

/** Complete bounded HTML table grammar emitted for the supported root table.
 * Cell content is kept byte-for-byte; arbitrary HTML and extra rows are refused. */
export function sourceRichTextRepairTableCells(
  raw: string,
): readonly (readonly string[])[] | undefined {
  if (raw.includes("\r")) return
  const lines = raw.split("\n")
  while (lines.at(-1) === "") lines.pop()
  if (lines[0] !== '<table header-row="true">' || lines.at(-1) !== "</table>") return
  const rows: string[][] = []
  let cursor = 1,
    width: number | undefined
  while (cursor < lines.length - 1) {
    if (lines[cursor++] !== "<tr>") return
    const cells: string[] = []
    while (cursor < lines.length - 1 && lines[cursor] !== "</tr>") {
      const cell = /^<td>(.*)<\/td>$/.exec(lines[cursor++]!)
      if (!cell || /<\/?(?:table|tr|td)\b/i.test(cell[1]!)) return
      cells.push(cell[1]!)
    }
    if (
      lines[cursor++] !== "</tr>" ||
      !cells.length ||
      (width !== undefined && cells.length !== width)
    )
      return
    width = cells.length
    rows.push(cells)
  }
  return cursor === lines.length - 1 && rows.length ? rows : undefined
}

/** Every physical BEFORE cell participates, including cells outside the selected
 * repair row. A Markdown-only change cannot be hidden by source projection. */
export function sourceRichTextRepairTableMatches(
  raw: string,
  physicalCells: readonly unknown[],
): boolean {
  const rows = sourceRichTextRepairTableCells(raw)
  if (!rows || !Array.isArray(physicalCells) || rows.length !== physicalCells.length) return false
  return rows.every((cells, row) => {
    const physical = physicalCells[row]
    return (
      Array.isArray(physical) &&
      cells.length === physical.length &&
      cells.every(
        (cell, column) =>
          Array.isArray(physical[column]) &&
          sourceRichTextRepairInlineMatches(cell, physical[column], "literal_file_line_link"),
      )
    )
  })
}
