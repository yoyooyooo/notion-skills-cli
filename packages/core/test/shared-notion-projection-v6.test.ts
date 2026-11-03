import { expect, test } from "bun:test"
import {
  projectSharedNotionMarkdown,
  sharedNotionMarkdownWire,
  validateSharedNotionMarkdownProjection,
} from "../src/shared-notion-projection.ts"

test("v6 freezes paragraph and simple-list text breaks before dispatch", () => {
  const source =
    "# Guide\n\nFirst line\nwith **bold**.\n\n- Check this\n  continuation.\n- Another item."
  const expected =
    "# Guide\n\nFirst line<br />with <b>bold</b>.\n\n- Check this<br />continuation.\n- Another item."
  const current = projectSharedNotionMarkdown(source, { version: 6, purpose: "data_source_create" })
  expect(current.version).toBe(6)
  expect(current.markdown).toBe(expected)
  const previous = projectSharedNotionMarkdown(source, {
    version: 5,
    purpose: "data_source_create",
  })
  expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(previous))
  expect(previous.markdown).toContain("First line\nwith <b>bold</b>")
  expect(validateSharedNotionMarkdownProjection(previous)).toEqual(previous)
  expect(validateSharedNotionMarkdownProjection(current)).toEqual(current)
  expect(() => validateSharedNotionMarkdownProjection({ ...previous, version: 6 })).toThrow()
})

test("inline and fenced code retain literal bytes instead of treating code as text blocks", () => {
  const source =
    "Literal `<br />` and `https://example.com/a_b`.\n\n```python\nvalue = 'https://example.com/a_b'\nprint(value)\n```"
  const current = projectSharedNotionMarkdown(source)
  expect(current.markdown).toBe(projectSharedNotionMarkdown(source, { version: 5 }).markdown)
  expect(current.markdown).toContain("value = 'https://example.com/a_b'\nprint(value)")
})

test("native link annotation moves inside the label without changing its destination", () => {
  const source = "- **[COMMON_PATTERNS.md](COMMON_PATTERNS.md)**: first\n  second."
  expect(projectSharedNotionMarkdown(source).markdown).toBe(
    "- [<b>COMMON\\_PATTERNS.md</b>](COMMON_PATTERNS.md): first<br />second.",
  )
  const code = "Read [`a_b`](../folder/a_b.md?x=1#anchor)."
  expect(projectSharedNotionMarkdown(code).markdown).toBe(
    projectSharedNotionMarkdown(code, { version: 5 }).markdown,
  )
})

test("bare HTTP links use the observed native link form, not a destination rewrite", () => {
  const source = "Registry: https://www.npmjs.com/package/example"
  expect(projectSharedNotionMarkdown(source).markdown).toBe(
    "Registry: [https://www.npmjs.com/package/example](https://www.npmjs.com/package/example)",
  )
})

test("explicit breaks preserve their role and existing native breaks remain stable", () => {
  expect(projectSharedNotionMarkdown("First  \nSecond").markdown).toBe("First<br />Second")
  expect(projectSharedNotionMarkdown("First<br />Second").markdown).toBe("First<br />Second")
})
