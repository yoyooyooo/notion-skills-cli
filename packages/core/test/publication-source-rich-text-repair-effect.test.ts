import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import { property, type Snapshot } from "../src/model.ts"
import { projectNotionBlockTree, samePublishedMarkdown } from "../src/markdown.ts"
import type { PortableSkill } from "../src/portable.ts"
import { publicationSourceDestination } from "../src/publication-markdown.ts"
import {
  deriveSourceRichTextRepair,
  type SourceRichTextRepairKind,
} from "../src/publication-source-rich-text-repair-effect.ts"
import {
  sourceRichTextRepairInlineMatches,
  sourceRichTextRepairTableMatches,
} from "../src/source-rich-text-repair-readback.ts"

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`
const page = id(1),
  table = id(5),
  selectedRow = id(7),
  selectedLeaf = id(11)
const bodyPath = `v1/pages/${page}/markdown`,
  rootPath = `v1/blocks/${page}/children?page_size=100`
const name = "literal-repair-fixture",
  description = "Use to verify exact single-leaf source repair proposals."
const encode = (value: string) => new TextEncoder().encode(value)
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")
const frontmatter = (body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`
const defaults = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
}
const rich = (content: string, url: string | null = null, code = false) => ({
  type: "text",
  text: { content, link: url === null ? null : { url } },
  plain_text: content,
  href: url,
  annotations: { ...defaults, code },
})
const node = (
  blockId: string,
  type: string,
  body: unknown,
  owner = page,
  hasChildren = false,
): Record<string, unknown> => ({
  id: blockId,
  type,
  parent:
    owner === page ? { type: "page_id", page_id: owner } : { type: "block_id", block_id: owner },
  has_children: hasChildren,
  archived: false,
  in_trash: false,
  last_edited_time: "original-block",
  [type]: body,
})
const leaf = (blockId: string, type: string, spans: readonly unknown[]) =>
  node(blockId, type, { rich_text: spans, color: "default" })
const sourcePrefix = "# Evidence\n\nRead [script](template.sh).\n\nKeep every paragraph.\n\n"
const actualPrefix = "# Evidence\nRead [script](http://template.sh).\nKeep every paragraph.\n\n"
const suffix = "\n\n## End\n\nComplete.\n"

interface Fixture {
  portable: PortableSkill
  snapshot: Snapshot
  raw: Record<string, unknown>
  readonly source: string
  readonly roots: Record<string, unknown>[]
  readonly all: Record<string, unknown>[]
  readonly selection: { readonly kind: SourceRichTextRepairKind; readonly block_id: string }
  readonly actual: string
}

function capture(
  source: string,
  actual: string,
  middle: Record<string, unknown>,
  children: Record<string, unknown>[],
  kind: SourceRichTextRepairKind,
  selected: string,
): Fixture {
  const roots = [
    leaf(id(2), "heading_1", [rich("Evidence")]),
    leaf(id(3), "paragraph", [rich("Read "), rich("script", "http://template.sh/"), rich(".")]),
    leaf(id(4), "paragraph", [rich("Keep every paragraph.")]),
    middle,
    leaf(id(9), "heading_2", [rich("End")]),
    leaf(id(10), "paragraph", [rich("Complete.")]),
  ]
  const all = [...roots.slice(0, 4), ...children, ...roots.slice(4)]
  const blocks = projectNotionBlockTree(page, all)
  if (!blocks) throw new Error("Expected complete production physical projection")
  const portable: PortableSkill = {
    kind: "skill",
    name,
    description,
    main: "SKILL.md",
    files: [
      { path: "SKILL.md", bytes: encode(frontmatter(source)) },
      { path: "template.sh", bytes: encode("# Frozen textual fixture; never executed.\n") },
    ],
  }
  const raw: Record<string, unknown> = {
    [`v1/pages/${page}`]: {
      id: page,
      archived: false,
      in_trash: false,
      last_edited_time: "original-page",
    },
    [bodyPath]: {
      object: "page_markdown",
      id: page,
      markdown: actual,
      truncated: false,
      unknown_block_ids: [],
    },
    [rootPath]: { object: "list", results: roots, has_more: false, next_cursor: null },
    ...(children.length
      ? {
          [`v1/blocks/${middle.id}/children?page_size=100`]: {
            object: "list",
            results: children,
            has_more: false,
            next_cursor: null,
          },
        }
      : {}),
  }
  const currentFiles = [
    { path: "SKILL.md", bytes: encode(frontmatter(actual)) },
    portable.files[1]!,
  ]
  const snapshot: Snapshot = {
    snapshot_id: "s_literal_repair_fixture",
    scope: "fixture",
    version_id: "captured-version",
    created_at: 1,
    entrypoint: "SKILL.md",
    files: currentFiles.map((file) => ({
      path: file.path,
      bytes: file.bytes.length,
      sha256: hash(file.bytes),
    })),
    record: {
      id: `notion_page:${page}`,
      kind: "skill",
      locator: {
        type: "notion_page",
        page_id: page,
        database_id: id(20),
        data_source_id: id(21),
      },
      name,
      alias: name,
      description,
      default_context: false,
      entrypoint: "SKILL.md",
      ref: `skill://${page}/SKILL.md`,
    },
    references: [{ id: page, path: "SKILL.md", markdown: actual, blocks }],
  }
  return {
    portable,
    snapshot,
    raw,
    source,
    roots,
    all,
    selection: { kind, block_id: selected },
    actual,
  }
}

function tableFixture() {
  const source =
    sourcePrefix +
    "| Field | Action |\n| --- | --- |\n" +
    "| file:line | Keep `exact` text. |\n| other | Preserve this row. |" +
    suffix
  const tableMarkdown = [
    '<table header-row="true">',
    "<tr>",
    "<td>Field</td>",
    "<td>Action</td>",
    "</tr>",
    "<tr>",
    "<td>[file:line](file:line)</td>",
    "<td>Keep `exact` text.</td>",
    "</tr>",
    "<tr>",
    "<td>other</td>",
    "<td>Preserve this row.</td>",
    "</tr>",
    "</table>",
  ].join("\n")
  const rows = [
    node(id(6), "table_row", { cells: [[rich("Field")], [rich("Action")]] }, table),
    node(
      selectedRow,
      "table_row",
      {
        cells: [
          [rich("file:line", "file://line")],
          [rich("Keep "), rich("exact", null, true), rich(" text.")],
        ],
      },
      table,
    ),
    node(id(8), "table_row", { cells: [[rich("other")], [rich("Preserve this row.")]] }, table),
  ]
  return {
    ...capture(
      source,
      actualPrefix + tableMarkdown + suffix,
      node(
        table,
        "table",
        { table_width: 2, has_column_header: true, has_row_header: false },
        page,
        true,
      ),
      rows,
      "literal_file_line_link",
      selectedRow,
    ),
    tableMarkdown,
    rows,
  }
}

function equationFixture() {
  const expression = " prefix uses `json` ",
    destination = "https://example.test/issues/1115"
  const sourceLeaf = `Warning $${expression}$ for json.country. See [issue](${destination}).`
  const actualLeaf =
    "Warning $`" +
    expression.trim() +
    "`$ for [json.country](http://json.country). See [issue](" +
    destination +
    ")."
  const spans = [
    rich("Warning "),
    {
      type: "equation",
      equation: { expression },
      plain_text: expression,
      href: null,
      annotations: { ...defaults },
    },
    rich(" for "),
    rich("json.country", "http://json.country/"),
    rich(". See "),
    rich("issue", destination),
    rich("."),
  ]
  return {
    ...capture(
      sourcePrefix + "- " + sourceLeaf + suffix,
      actualPrefix + "- " + actualLeaf + suffix,
      leaf(selectedLeaf, "bulleted_list_item", spans),
      [],
      "literal_dollar_equation",
      selectedLeaf,
    ),
    sourceLeaf,
    actualLeaf,
    spans,
    destination,
  }
}

const derive = (f: Fixture) =>
  deriveSourceRichTextRepair(f.portable, page, f.raw, f.snapshot, f.selection)
function changeMarkdown(f: Fixture, markdown: string) {
  f.raw[bodyPath] = { ...property(f.raw[bodyPath]), markdown }
  f.snapshot = {
    ...f.snapshot,
    references: f.snapshot.references!.map((reference) => ({ ...reference, markdown })),
  }
}
function rejects(f: Fixture) {
  const before = JSON.stringify(f)
  expect(() => derive(f)).toThrow()
  expect(JSON.stringify(f)).toBe(before)
}
function expectProposedWholeBody(f: Fixture, proposed: ReturnType<typeof derive>) {
  const root = proposed.snapshot.references![0]!
  expect(proposed.proposed_only).toBe(true)
  expect(
    samePublishedMarkdown(
      root.markdown,
      f.source,
      publicationSourceDestination({ path: f.portable.main, files: f.portable.files }, root.blocks),
      root.blocks,
    ),
  ).toBe(true)
  expect(root.blocks).toHaveLength(f.roots.length)
  expect(proposed.effect.source_sha256).toBe(hash(f.portable.files[0]!.bytes))
  expect(proposed.effect.request).toMatchObject({
    path: `v1/blocks/${f.selection.block_id}`,
    method: "PATCH",
  })
}

test("one root table proposal binds every BEFORE cell and preserves all adjacent paragraph roots", () => {
  const f = tableFixture(),
    before = JSON.stringify(f)
  expect(
    sourceRichTextRepairTableMatches(
      f.tableMarkdown,
      f.rows.map((row) => property(row.table_row).cells),
    ),
  ).toBe(true)
  const proposed = derive(f)
  expectProposedWholeBody(f, proposed)
  expect(proposed.effect.ancestor_ids).toEqual([page, table])
  expect(proposed.effect.source_root_index).toBe(3)
  expect(proposed.effect.source_row_index).toBe(1)
  expect(proposed.snapshot.references![0]!.blocks!.map((block) => block.type)).toEqual([
    "heading_1",
    "paragraph",
    "paragraph",
    "table",
    "heading_2",
    "paragraph",
  ])
  const cells = property(property(proposed.effect.request.body).table_row).cells
  if (!Array.isArray(cells)) throw new Error("Expected the proposed table row cells")
  expect(cells).toHaveLength(2)
  expect(
    cells
      .flatMap((cell) => (Array.isArray(cell) ? cell : []))
      .flatMap((item) => {
        const link = property(property(item).text).link
        return link === null || link === undefined ? [] : [property(link).url]
      }),
  ).toEqual([])
  expect(JSON.stringify(f)).toBe(before)
})

test("one validation equation leaf reconstructs frozen source while retaining the explicit issue destination", () => {
  const f = equationFixture(),
    before = JSON.stringify(f)
  expect(sourceRichTextRepairInlineMatches(f.actualLeaf, f.spans, "literal_dollar_equation")).toBe(
    true,
  )
  const proposed = derive(f)
  expectProposedWholeBody(f, proposed)
  expect(proposed.effect.ancestor_ids).toEqual([page])
  expect(proposed.effect.source_item_index).toBe(0)
  const richText = property(property(proposed.effect.request.body).bulleted_list_item).rich_text
  if (!Array.isArray(richText)) throw new Error("Expected the proposed bulleted list rich text")
  expect(richText.every((item) => property(item).type === "text")).toBe(true)
  expect(
    richText.flatMap((item) => {
      const link = property(property(item).text).link
      return link === null || link === undefined ? [] : [property(link).url]
    }),
  ).toEqual([f.destination])
  expect(JSON.stringify(f)).toBe(before)
})

for (const selected of [true, false])
  test(`coherent raw and snapshot Markdown-only changes in ${selected ? "selected" : "unselected"} table cells refuse`, () => {
    const f = tableFixture()
    changeMarkdown(
      f,
      selected
        ? f.actual.replace("Keep `exact`", "Discard `exact`")
        : f.actual.replace("Preserve this row.", "Discard this row."),
    )
    rejects(f)
  })

test("a complete selected equation Markdown-only edit is not hidden by frozen source reconstruction", () => {
  for (const change of [
    (value: string) => value.replace("Warning", "Changed warning"),
    (value: string) => value.replace("issues/1115", "issues/1116"),
  ]) {
    const f = equationFixture()
    changeMarkdown(f, change(f.actual))
    rejects(f)
  }
})

test("raw Markdown and snapshot body or physical projection must identify the same complete observation", () => {
  for (const change of ["raw-body", "snapshot-body", "snapshot-blocks", "truncated"] as const) {
    const f = tableFixture(),
      reference = f.snapshot.references![0]!
    if (change === "raw-body")
      f.raw[bodyPath] = { ...property(f.raw[bodyPath]), markdown: f.actual + "\nExtra" }
    if (change === "snapshot-body")
      f.snapshot = { ...f.snapshot, references: [{ ...reference, markdown: f.actual + "\nExtra" }] }
    if (change === "snapshot-blocks")
      f.snapshot = {
        ...f.snapshot,
        references: [{ ...reference, blocks: reference.blocks!.slice(1) }],
      }
    if (change === "truncated") f.raw[bodyPath] = { ...property(f.raw[bodyPath]), truncated: true }
    rejects(f)
  }
})

test("paragraph filename evidence requires its frozen manifest and never aliases an explicit external URL", () => {
  for (const change of [
    "missing-manifest",
    "external-scheme",
    "external-path",
    "readback-port",
  ] as const) {
    const f = equationFixture()
    if (change === "missing-manifest")
      f.portable = {
        ...f.portable,
        files: f.portable.files.filter((file) => file.path !== "template.sh"),
      }
    else if (change === "readback-port")
      changeMarkdown(f, f.actual.replace("http://template.sh", "http://template.sh:8080"))
    else
      f.portable = {
        ...f.portable,
        files: f.portable.files.map((file) =>
          file.path !== f.portable.main
            ? file
            : {
                ...file,
                bytes: encode(
                  frontmatter(
                    f.source.replace(
                      "](template.sh)",
                      change === "external-scheme"
                        ? "](https://template.sh)"
                        : "](http://template.sh/path)",
                    ),
                  ),
                ),
              },
        ),
      }
    rejects(f)
  }
})

test("extra physical roots remain visible even when their new snapshot projection is internally consistent", () => {
  const f = equationFixture()
  f.roots.push(leaf(id(99), "paragraph", [rich("Unsubmitted root.")]))
  const blocks = projectNotionBlockTree(page, f.roots)
  if (!blocks) throw new Error("Expected complete changed physical projection")
  f.snapshot = {
    ...f.snapshot,
    references: f.snapshot.references!.map((reference) => ({ ...reference, blocks })),
  }
  rejects(f)
})

function currencyFixture() {
  const sourceLeaf =
    "**Fixed decimals per metric**: money 2, percentages 1 or 2, counts none. Thousands separators\n" +
    'everywhere ("$16,531.54"); abbreviate only in a capacity line ("12.7k of 20.0k"). A sign on every\n' +
    'change ("-$0.09", "+10,100 (+0.20%)"). No space after the currency sign (one screen\'s "$ 89.00"\n' +
    'beside "$15.00" is flagged).'
  const expression = '0.09", "+10,100 (+0.20%)"). No space after the currency sign (one screen\'s "'
  const actualLeaf =
    "**Fixed decimals per metric**: money 2, percentages 1 or 2, counts none. Thousands separators<br>" +
    'everywhere ("\\$16,531.54"); abbreviate only in a capacity line ("12.7k of 20.0k"). A sign on every<br>' +
    `change ("-$\`${expression}\`$ 89.00"<br>beside "\\$15.00" is flagged).`
  const spans = [
    rich("Fixed decimals per metric", null, false),
    rich(
      ": money 2, percentages 1 or 2, counts none. Thousands separators\n" +
        'everywhere ("$16,531.54"); abbreviate only in a capacity line ("12.7k of 20.0k"). A sign on every\nchange ("-',
    ),
    {
      type: "equation",
      equation: { expression },
      plain_text: expression,
      href: null,
      annotations: { ...defaults },
    },
    rich(' 89.00"\nbeside "$15.00" is flagged).'),
  ]
  spans[0]!.annotations.bold = true
  return {
    ...capture(
      sourcePrefix + "- " + sourceLeaf + suffix,
      actualPrefix + "- " + actualLeaf + suffix,
      leaf(selectedLeaf, "bulleted_list_item", spans),
      [],
      "literal_dollar_equation",
      selectedLeaf,
    ),
    sourceLeaf,
    actualLeaf,
    spans,
    expression,
  }
}

test("one multiline currency equation repairs the exact frozen source leaf", () => {
  const f = currencyFixture(),
    before = JSON.stringify(f)
  expect(sourceRichTextRepairInlineMatches(f.actualLeaf, f.spans, "literal_dollar_equation")).toBe(
    true,
  )
  const proposed = derive(f)
  expectProposedWholeBody(f, proposed)
  const richText = property(property(proposed.effect.request.body).bulleted_list_item).rich_text
  if (!Array.isArray(richText)) throw new Error("Expected the proposed bulleted list rich text")
  const literal = richText.map((item) => property(property(item).text).content).join("")
  expect(richText.every((item) => property(item).type === "text")).toBe(true)
  expect(literal).toBe(
    f.sourceLeaf.replace("**Fixed decimals per metric**", "Fixed decimals per metric"),
  )
  expect(property(richText[0]).text).toEqual({ content: "Fixed decimals per metric" })
  expect(property(property(richText[0]).annotations).bold).toBe(true)
  expect(literal).not.toContain("<br>")
  expect(JSON.stringify(f)).toBe(before)
})

test("currency repair rejects a changed equation, missing text, CRLF and duplicate ownership", () => {
  const changed = currencyFixture()
  const equation = changed.spans.find((span) => span.type === "equation")
  if (!equation || !("equation" in equation))
    throw new Error("Expected the captured currency equation")
  equation.equation.expression += "x"
  equation.plain_text += "x"
  rejects(changed)
  const missing = currencyFixture(),
    missingText = missing.spans[1]!
  if (!("text" in missingText)) throw new Error("Expected the captured currency text span")
  missingText.text.content = missingText.text.content.replace("Thousands", "Missing")
  missingText.plain_text = missingText.text.content
  rejects(missing)
  const carriage = currencyFixture()
  changeMarkdown(carriage, carriage.actual.replace("<br>", "\r\n"))
  rejects(carriage)
  const duplicate = currencyFixture()
  duplicate.portable = {
    ...duplicate.portable,
    files: duplicate.portable.files.map((file) =>
      file.path !== duplicate.portable.main
        ? file
        : {
            ...file,
            bytes: encode(
              frontmatter(
                duplicate.source.replace(suffix, "\n\n- " + duplicate.sourceLeaf + suffix),
              ),
            ),
          },
    ),
  }
  rejects(duplicate)
})
