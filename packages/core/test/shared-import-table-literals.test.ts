import { expect, test } from "bun:test"
import {
  assertImportedMarkdownContent,
  assertImportedTablePlusRepairable,
} from "../src/shared-import-markdown.ts"
import {
  projectSharedNotionMarkdown,
  sharedNotionMarkdownWire,
  validateSharedNotionMarkdownProjection,
} from "../src/shared-notion-projection.ts"
import {
  escapeImportTablePlus,
  protectImportTablePlus,
  knownImportTablePlusReadback,
} from "../src/shared-import-table-literals.ts"

test("explicit v16 import escapes only ordinary table plus signs and keeps v14 frozen", () => {
  const input =
    "# Instructions\n\n| Action | Contract |\n| --- | --- |\n| New | `brief` + `content` |\n| More | + guide + **details** |\n"
  const old = projectSharedNotionMarkdown(input, { version: 14, purpose: "data_source_create" })
  const next = projectSharedNotionMarkdown(input, { version: 16, purpose: "data_source_create" })
  expect(next.markdown).toBe(old.markdown)
  expect(next.input_markdown).toBe(input)
  expect(sharedNotionMarkdownWire(next)).toBe(
    sharedNotionMarkdownWire(old).replaceAll(" + ", " \\+ "),
  )
  expect(validateSharedNotionMarkdownProjection(old)).toEqual(old)
  expect(validateSharedNotionMarkdownProjection(next)).toEqual(next)
  expect(() => validateSharedNotionMarkdownProjection({ ...old, version: 16 })).toThrow()
  expect(() => projectSharedNotionMarkdown(input, { version: 16, purpose: "body_write" })).toThrow()
  expect(() => assertImportedMarkdownContent(input, sharedNotionMarkdownWire(next))).not.toThrow()
})

test("table code, HTML code, destinations, authored escapes and outside text remain byte-identical", () => {
  const input =
    "Paragraph + literal.\n\n```md\n| + |\n| - |\n```\n\n" +
    "| Value |\n| --- |\n| `a + b` and <code>c+d</code> + [a+b](https://example.test/a+b) + \\+ |\n"
  const result = escapeImportTablePlus(input)
  expect(result.changed).toBe(2)
  expect(result.markdown).toBe(
    input.replace("</code> + ", "</code> \\+ ").replace(") + ", ") \\+ "),
  )
  expect(escapeImportTablePlus(result.markdown)).toEqual({ markdown: result.markdown, changed: 0 })
  expect(() => assertImportedMarkdownContent(input, result.markdown)).not.toThrow()
})

test("known previous table corruption is recognized without accepting unrelated text or code changes", () => {
  const input = "# Original\n\n| Value |\n| --- |\n| first + second and `a+b` |\n"
  const bad = knownImportTablePlusReadback(input)
  expect(bad).toEqual({ markdown: input.replace("first + second", "first • second"), changed: 1 })
  expect(() => assertImportedMarkdownContent(input, bad.markdown)).toThrow()
  expect(() =>
    assertImportedMarkdownContent(bad.markdown, bad.markdown.replace("a+b", "a•b")),
  ).toThrow()
  expect(() =>
    assertImportedMarkdownContent(bad.markdown, bad.markdown.replace("Original", "Edited")),
  ).toThrow()
  expect(knownImportTablePlusReadback("No table + ordinary value.").changed).toBe(0)
})

test("nested formatting preserves all markers and full text", () => {
  const input = "| Value |\n| --- |\n| **a + b** and _c + d_ and ~~e + f~~ |\n"
  const escaped = escapeImportTablePlus(input)
  expect(escaped.changed).toBe(3)
  expect(escaped.markdown).toBe(input.replaceAll(" + ", " \\+ "))
  expect(() => assertImportedMarkdownContent(input, escaped.markdown)).not.toThrow()
})

test("explicit v17 protects table plus with presentation spans while the failed v16 candidate remains frozen", () => {
  const input =
    "| Value |\n| --- |\n| `a+b` + **next + last** and [c+d](https://example.test/c+d) |\n\nOutside + stays.\n"
  const next = projectSharedNotionMarkdown(input, { version: 17, purpose: "data_source_create" })
  expect(protectImportTablePlus(input).changed).toBe(2)
  expect(sharedNotionMarkdownWire(next)).toContain("`a+b` <b>+</b> **next <b>+</b> last**")
  expect(next.markdown).toBe(input.trimEnd())
  expect(() => assertImportedMarkdownContent(input, sharedNotionMarkdownWire(next))).not.toThrow()
  expect(validateSharedNotionMarkdownProjection(next)).toEqual(next)
  const prior = projectSharedNotionMarkdown(input, { version: 16, purpose: "data_source_create" })
  expect(sharedNotionMarkdownWire(prior)).toContain("`a+b` \\+ **next \\+ last**")
  expect(() => validateSharedNotionMarkdownProjection({ ...prior, version: 17 })).toThrow()
})

test("repair recognizes only a subset of original table plus positions, never arbitrary bullet normalization", () => {
  const input =
    "Paragraph + stays.\n\n| Value |\n| --- |\n| alpha + `beta` + `gamma` |\n| literal • stays and `a+b` |\n"
  const altered = input.replace("`beta` + `gamma`", "`beta` • `gamma`")
  expect(assertImportedTablePlusRepairable(input, altered)).toBe(1)
  expect(() => assertImportedMarkdownContent(input, altered)).toThrow()
  expect(() =>
    assertImportedTablePlusRepairable(input, altered.replace("Paragraph +", "Paragraph •")),
  ).toThrow()
  expect(() =>
    assertImportedTablePlusRepairable(input, altered.replace("literal •", "literal +")),
  ).toThrow()
  expect(() => assertImportedTablePlusRepairable(input, altered.replace("a+b", "a•b"))).toThrow()
  expect(() => assertImportedTablePlusRepairable(input, input)).toThrow()
})
