import { expect, test } from "bun:test"
import {
  assertImportedMarkdownContent,
  deriveImportedTableCodePaddingRepair,
} from "../src/shared-import-markdown.ts"
import {
  nativeRepairTableRow,
  assertPhysicalCodeRepairReadback,
} from "../src/shared-native-table-code-repair.ts"

const source =
  "# Table\n\n| Kind | Value |\n| --- | --- |\n| Bullet | Numerals `1. 2. 3.` or `•`; en-dash `–`. |\n"
const actual =
  "# Table\n\n| Kind | Value |\n| --- | --- |\n| Bullet | Numerals <code>1. 2. 3.</code> or <code>  • </code>; en-dash <code>–</code>. |\n"

test("a proposal repairs one exact table marker without relaxing normal code comparison", () => {
  expect(() => assertImportedMarkdownContent(source, actual)).toThrow()
  const repair = deriveImportedTableCodePaddingRepair(source, actual)
  expect(repair).toEqual({
    markdown: actual.replace("<code>  • </code>", "<code>•</code>"),
    before_code: "  • ",
    after_code: "•",
    changes: 1,
  })
  expect(() => assertImportedMarkdownContent(source, repair.markdown)).not.toThrow()
})

test("code whitespace, multiple markers, non-table code and unrelated edits are never silently normalized", () => {
  for (const value of [
    actual.replace("  • ", " • "),
    actual.replace("1. 2. 3.", "1. 2.  3."),
    actual.replace("# Table", "# Human edit"),
    actual + "\nOther <code>  • </code>.\n",
    actual.replace("en-dash <code>–</code>", "en-dash <code>  • </code>"),
  ])
    expect(() => deriveImportedTableCodePaddingRepair(source, value)).toThrow()
  expect(() => deriveImportedTableCodePaddingRepair("Use `•`.", "Use <code>  • </code>.")).toThrow()
  expect(() => deriveImportedTableCodePaddingRepair(source, actual.replace("  • ", "•"))).toThrow()
})

test("only the exact physical generated root-link alias in the repaired row may change serialization", () => {
  const source =
    "| Kind | Value |\n| --- | --- |\n| Bullet | Use `•` (production.md). |\n\nOutside production.md.\n"
  const before =
    "| Kind | Value |\n| --- | --- |\n| Bullet | Use <code>  • </code> ([production.md](http://production.md)). |\n\nOutside [production.md](http://production.md).\n"
  const after = before
    .replace("<code>  • </code>", "<code>•</code>")
    .replace("(http://production.md)", "(http://production.md/)")
  const span = (content: string, code = false, url: string | null = null) => ({
    type: "text",
    text: { content, link: url === null ? null : { url } },
    plain_text: content,
    href: url,
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code,
      color: "default",
    },
  })
  const row = nativeRepairTableRow({
    object: "block",
    id: "00000000-0000-4000-8000-000000000901",
    type: "table_row",
    has_children: false,
    in_trash: false,
    parent: { type: "block_id", block_id: "00000000-0000-4000-8000-000000000900" },
    table_row: {
      cells: [
        [span("Bullet")],
        [
          span("Use "),
          span("  • ", true),
          span(" ("),
          span("production.md", false, "http://production.md/"),
          span(")."),
        ],
      ],
    },
  })
  expect(() =>
    assertPhysicalCodeRepairReadback({ expected: source, before, after, row }),
  ).not.toThrow()
  for (const changed of [
    after.replace("http://production.md/", "https://production.md/"),
    after.replace("http://production.md/", "http://production.md/path"),
    after.replace("Outside ", "Outside  "),
    after.replace(
      "Outside [production.md](http://production.md)",
      "Outside [production.md](http://production.md/)",
    ),
    after.replace("<code>•</code>", "<code> • </code>"),
  ])
    expect(() =>
      assertPhysicalCodeRepairReadback({ expected: source, before, after: changed, row }),
    ).toThrow()
  const explicit = source.replace("(production.md)", "([production.md](http://production.md))")
  expect(() =>
    assertPhysicalCodeRepairReadback({ expected: explicit, before, after, row }),
  ).toThrow()
})
