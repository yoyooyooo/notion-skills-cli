import { describe, expect, test } from "bun:test"
import { SkillsError } from "../src/model.ts"
import { normalizeObservedBody } from "../src/shared-file-state.ts"
import {
  projectSharedNotionMarkdown,
  sharedNotionMarkdownWire,
  validateSharedNotionMarkdownProjection,
} from "../src/shared-notion-projection.ts"
import { notionV2Observations } from "./shared-notion-projection-observations.ts"

const projectV1 = (input: string) => projectSharedNotionMarkdown(input, { version: 1 })

describe("retained native Markdown projection v1", () => {
  test("freezes one editor EOF newline as an explicit change while preserving the input", () => {
    const input = "# Title\n\nA body.\n"
    const projection = projectV1(input)
    expect(projection.input_markdown).toBe(input)
    expect(projection.markdown).toBe("# Title\n\nA body.")
    expect(projection.removed_terminal_lfs).toBe(1)
    expect(validateSharedNotionMarkdownProjection(projection)).toEqual(projection)
    expect(normalizeObservedBody(input)).toBe(input)
  })

  test("only CRLF and terminal LF run change; interior whitespace and trailing spaces remain exact", () => {
    const input = "```text\r\na  \r\n\r\nb\r\n```  \r\n\r\n"
    expect(projectV1(input)).toMatchObject({
      input_markdown: input,
      markdown: "```text\na  \n\nb\n```  ",
      removed_terminal_lfs: 2,
    })
    expect(projectV1("text\r").markdown).toBe("text\r")
    expect(projectV1(" ").markdown).toBe(" ")
  })

  test("already projected content and empty content do not acquire a synthetic newline", () => {
    expect(projectV1("# Exact").markdown).toBe("# Exact")
    expect(projectV1("")).toMatchObject({ markdown: "", removed_terminal_lfs: 0 })
    expect(projectV1("\n\n")).toMatchObject({
      input_markdown: "\n\n",
      markdown: "",
      removed_terminal_lfs: 2,
    })
  })

  test("a returned native body cannot redefine the frozen expected projection", () => {
    const projected = projectV1("A_B\n")
    for (const changed of [
      { ...projected, markdown: "A\\_B" },
      { ...projected, removed_terminal_lfs: 0 },
      { ...projected, removed_terminal_lfs: 1.5 },
      { ...projected, version: 2 },
      { ...projected, additional: true },
    ])
      expect(() => validateSharedNotionMarkdownProjection(changed)).toThrow(SkillsError)
  })

  test("unencodable surrogate input and NUL are rejected before identity or dispatch", () => {
    expect(() => projectV1("bad\ud800")).toThrow(SkillsError)
    expect(() => projectV1("bad\u0000")).toThrow(SkillsError)
  })
})

describe("native Markdown projection v2", () => {
  test("uses independently captured v2 contracts for common Markdown and explicit languages", () => {
    for (const sample of notionV2Observations.filter((sample) =>
      ["prefix-probe", "explicit-languages-ds"].includes(sample.case),
    )) {
      const projection = projectSharedNotionMarkdown(sample.request_markdown, {
        purpose: "data_source_create",
      })
      expect(projection.markdown).toBe(sample.response_markdown)
      expect(projection.input_markdown).toBe(sample.request_markdown)
    }
  })

  test("combines observed rich/block readback with the separately observed explicit plain-text fence policy", () => {
    for (const sample of notionV2Observations.filter((sample) =>
      ["double-h1-ds", "xml-h1-ds"].includes(sample.case),
    )) {
      const projection = projectSharedNotionMarkdown(sample.request_markdown, {
        purpose: "data_source_create",
      })
      // The old unlabelled fence was guessed as javascript by the service.
      // New wire freezes text, whose separately captured native readback is txt.
      const expected = sample.response_markdown.replace(
        "```javascript\nliteral <angle> & text\n```",
        "```txt\nliteral <angle> & text\n```",
      )
      expect(projection.markdown).toBe(expected)
      expect(sharedNotionMarkdownWire(projection)).toContain("```text\nliteral <angle> & text\n```")
    }
  })

  test("retains the authored H1 and uses XML only for data-source creation", () => {
    const input = "# Native acceptance\n\nRead `references/guide.md`.\n"
    const create = projectSharedNotionMarkdown(input, { purpose: "data_source_create" })
    const write = projectSharedNotionMarkdown(input)
    expect(create.version).toBe(2)
    expect(create.input_markdown).toBe(input)
    expect(create.markdown).toBe("# Native acceptance\n\nRead <code>references/guide.md</code>.")
    expect(write.markdown).toBe(create.markdown)
    expect(sharedNotionMarkdownWire(create)).toBe(
      "<h1>Native acceptance</h1>\n\nRead `references/guide.md`.",
    )
    expect(sharedNotionMarkdownWire(write)).toBe(
      "# Native acceptance\n\nRead `references/guide.md`.",
    )
    expect(validateSharedNotionMarkdownProjection(create)).toEqual(create)
    expect(normalizeObservedBody(input)).toBe(input)
  })

  test("freezes each observed rich-text segment without escaping literal code content", () => {
    const input =
      "Paragraph with **bold `code` bold** and *italic* and ~~strike~~.\n\nCode: `a < b & c > d` and ``a`b``."
    expect(projectSharedNotionMarkdown(input).markdown).toBe(
      "Paragraph with <b>bold </b><b><code>code</code></b><b> bold</b> and <i>italic</i> and <s>strike</s>.\n\nCode: <code>a < b & c > d</code> and <code>a`b</code>.",
    )
  })

  test.each(["", "text", "txt", "plaintext", "plain text"])(
    "explicitly freezes plain-text fences (%s)",
    (language) => {
      const input = `\`\`\`${language}\nliteral <angle> & text\n\`\`\``
      const projection = projectSharedNotionMarkdown(input)
      expect(sharedNotionMarkdownWire(projection)).toBe("```text\nliteral <angle> & text\n```")
      expect(projection.markdown).toBe("```txt\nliteral <angle> & text\n```")
      expect(projection.input_markdown).toBe(input)
    },
  )

  test.each([
    ["bash", "bash"],
    ["sh", "bash"],
    ["shell", "shell"],
    ["py", "py"],
    ["python", "py"],
    ["ts", "ts"],
    ["typescript", "ts"],
    ["json", "json"],
  ])("freezes the observed %s fence readback label %s", (language, observed) => {
    const input = `\`\`\`${language}\nvalue\n\`\`\``
    const projection = projectSharedNotionMarkdown(input)
    expect(sharedNotionMarkdownWire(projection)).toBe(input)
    expect(projection.markdown).toBe(`\`\`\`${observed}\nvalue\n\`\`\``)
  })

  test("fenced code remains literal while headings, lists and table cells use their AST spans", () => {
    const input =
      "# Title\n\n- [ ] **Todo**\n- [x] `Done`\n\n| Key | Value |\n| --- | --- |\n| `key` | **value** |\n\n```js\n// # heading **bold** `code`\nconst value = 1\n```"
    const projection = projectSharedNotionMarkdown(input, { purpose: "data_source_create" })
    expect(projection.markdown).toBe(
      "# Title\n\n- [ ] <b>Todo</b>\n- [x] <code>Done</code>\n\n| Key | Value |\n| --- | --- |\n| <code>key</code> | <b>value</b> |\n\n```javascript\n// # heading **bold** `code`\nconst value = 1\n```",
    )
    expect(sharedNotionMarkdownWire(projection)).toBe(
      input.replace("# Title", "<h1>Title</h1>").replace("```js\n", "```javascript\n"),
    )
  })

  test("already serialized native inline content and link destinations remain exact", () => {
    const input =
      "<b>bold </b><b><code>code</code></b><b> bold</b>\n\n[Local](references/guide.md) and [External](https://example.com/a_b?q=x*y)."
    expect(projectSharedNotionMarkdown(input).markdown).toBe(input)
  })

  test("native code containing backticks stays opaque while following Markdown still projects", () => {
    const input = "<b><code>[example](missing.md) and a`b</code></b> [real](real.md) and `outside`."
    expect(projectSharedNotionMarkdown(input).markdown).toBe(
      "<b><code>[example](missing.md) and a`b</code></b> [real](real.md) and <code>outside</code>.",
    )
  })

  test("neither request bytes nor returned bytes can redefine the frozen v2 policy", () => {
    const projection = projectSharedNotionMarkdown("# Title\n\n**Body**", {
      purpose: "data_source_create",
    })
    if (projection.version !== 2) throw new Error("Expected current projection")
    for (const tampered of [
      { ...projection, markdown: "<b>Body</b>" },
      { ...projection, wire_markdown: "# Title\n\n**Body**" },
      { ...projection, purpose: "body_write" },
      { ...projection, removed_terminal_lfs: 1 },
      { ...projection, normalization_version: 2 },
    ])
      expect(() => validateSharedNotionMarkdownProjection(tampered)).toThrow(SkillsError)
  })

  test.each([
    "Setext title\n============",
    "Setext section\n--------------",
    "---\ncustom: supporting-file-frontmatter\n---\n\nexact support text",
  ])("unverified Setext or supporting frontmatter fails before a v2 candidate (%s)", (input) => {
    for (const purpose of ["body_write", "data_source_create"] as const)
      expect(() => projectSharedNotionMarkdown(input, { purpose })).toThrow(SkillsError)
    // Retained operations use their saved policy; this limit is not retroactive.
    const retained = projectV1(input)
    expect(retained.markdown).toBe(input)
    expect(retained.input_markdown).toBe(input)
    expect(validateSharedNotionMarkdownProjection(retained)).toEqual(retained)
  })

  test("an unrepresentable indented code block fails before a candidate is accepted", () => {
    expect(() => projectSharedNotionMarkdown("    const value = 1")).toThrow(SkillsError)
  })
})
