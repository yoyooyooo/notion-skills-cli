import { describe, expect, test } from "bun:test"
import { SkillsError } from "../src/model.ts"
import { normalizeObservedBody } from "../src/shared-file-state.ts"
import {
  projectSharedNotionMarkdown,
  sharedNotionMarkdownWire,
  validateSharedNotionMarkdownProjection,
} from "../src/shared-notion-projection.ts"

// Minimized from the independently retained restore-follow v2 response.
// The full real candidate is 4474 bytes; its native response is 4558 bytes.
const input =
  "1. **One**\n\n2. See [`guide`](references/guide.md).\n\n\n## Table\n\n" +
  "| Key | Value |\n|---|---|\n| [`guide`](references/guide.md) | end|"
const observed =
  "1. <b>One</b>\n2. See [<code>guide</code>](references/guide.md).\n\n## Table\n\n" +
  "| Key | Value |\n| --- | --- |\n| [<code>guide</code>](references/guide.md) | end |"

const projectV4: typeof projectSharedNotionMarkdown = (input, options = {}) =>
  projectSharedNotionMarkdown(input, { version: 4, ...options })

describe("native Markdown projection v4", () => {
  test.each(["body_write", "data_source_create"] as const)(
    "predicts retained list, link-label and table readback before %s",
    (purpose) => {
      const projection = projectV4(input, { purpose })
      expect(projection.version).toBe(4)
      expect(projection.input_markdown).toBe(input)
      expect(sharedNotionMarkdownWire(projection)).toBe(input)
      expect(projection.markdown).toBe(observed)
      expect(validateSharedNotionMarkdownProjection(projection)).toEqual(projection)
      expect(normalizeObservedBody(input)).toBe(input)
    },
  )

  test("saved v3 bytes keep their old meaning and cannot be relabelled as v4", () => {
    const retained = projectV4(input, { version: 3 })
    expect(retained.markdown).toBe(input.replace("**One**", "<b>One</b>"))
    expect(validateSharedNotionMarkdownProjection(retained)).toEqual(retained)
    expect(() => validateSharedNotionMarkdownProjection({ ...retained, version: 4 })).toThrow(
      SkillsError,
    )
    const current = projectV4(input)
    expect(() => validateSharedNotionMarkdownProjection({ ...current, version: 3 })).toThrow(
      SkillsError,
    )
  })

  test("visible link labels change without rewriting URL escaping or a literal title", () => {
    const source = '[`visible`](https://example.com/a_b?q=x*y#part "literal title")'
    expect(projectV4(source).markdown).toBe(
      '[<code>visible</code>](https://example.com/a_b?q=x*y#part "literal title")',
    )
    expect(sharedNotionMarkdownWire(projectV4(source))).toBe(source)
  })

  test("list paragraphs, nested lists and fenced examples retain their content boundaries", () => {
    for (const source of [
      "1. First\n\n   Second paragraph.\n\n2. Last",
      "- Parent\n  - Child\n\nParagraph",
      "```text\n" + input + "\n```",
    ]) {
      const retained = projectV4(source, { version: 3 })
      const current = projectV4(source)
      expect(current.markdown).toBe(retained.markdown)
      expect(current.input_markdown).toBe(source)
      expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(retained))
    }
  })

  test("table syntax padding is separate from literal code-space content", () => {
    const source = "| A | B |\n|---|---|\n| `  padded  ` | value|"
    expect(projectV4(source).markdown).toBe(
      "| A | B |\n| --- | --- |\n| <code> padded </code> | value |",
    )
  })

  test.each([
    "| A | B |\n| :--- | ---: |\n| one | two |",
    "| A | B |\n| --- | --- |\n| one | two | lost |",
    "| A | B |\n| --- | --- |\n| a\\|b | value |",
  ])("unverified alignment or unaccounted source spans cannot disappear (%s)", (source) => {
    expect(() => projectV4(source)).toThrow(SkillsError)
  })
})

describe("native Markdown projection v5", () => {
  test("freezes the native paragraph/list separator without changing wire or old policy 4", () => {
    const source = "**Not allowed**:\n- First\n- Second"
    const observed = "<b>Not allowed</b>:\n\n- First\n- Second"
    const retained = projectV4(source)
    const current = projectSharedNotionMarkdown(source, { version: 5 })
    expect(retained.markdown).toBe("<b>Not allowed</b>:\n- First\n- Second")
    expect(current.version).toBe(5)
    expect(current.markdown).toBe(observed)
    expect(current.input_markdown).toBe(source)
    expect(sharedNotionMarkdownWire(current)).toBe(source)
    expect(validateSharedNotionMarkdownProjection(retained)).toEqual(retained)
    expect(validateSharedNotionMarkdownProjection(current)).toEqual(current)
    expect(() => validateSharedNotionMarkdownProjection({ ...retained, version: 5 })).toThrow(
      SkillsError,
    )
  })

  test("an existing separator and list-like fenced text keep their exact boundaries", () => {
    for (const source of ["Paragraph.\n\n- First\n- Second", "```text\nParagraph.\n- First\n```"])
      expect(projectSharedNotionMarkdown(source, { version: 5 }).markdown).toBe(
        projectV4(source).markdown,
      )
  })
})
