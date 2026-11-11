import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { SkillsError } from "../src/model.ts"
import { normalizeObservedBody } from "../src/shared-file-state.ts"
import {
  projectSharedNotionMarkdown,
  sharedNotionMarkdownPolicy,
  sharedNotionMarkdownWire,
  validateSharedNotionMarkdownProjection,
} from "../src/shared-notion-projection.ts"
import { notionV2Observations } from "./shared-notion-projection-observations.ts"
import native81 from "./fixtures/native81-multiblock-list-readback.json"

const projectV1 = (input: string) => projectSharedNotionMarkdown(input, { version: 1 })
const projectV2 = (
  input: string,
  options: { readonly purpose?: "body_write" | "data_source_create" } = {},
) => projectSharedNotionMarkdown(input, { ...options, version: 2 })

describe("native Markdown projection v13 creation lists", () => {
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

  test("predicts the observed native81 list fragment with generic text and unchanged wire", () => {
    const projection = projectSharedNotionMarkdown(native81.input_markdown, {
      purpose: "data_source_create",
    })
    expect(projection.version).toBe(13)
    expect(projection.markdown).toBe(native81.response_markdown)
    expect(sha256(sharedNotionMarkdownWire(projection))).toBe(native81.wire_markdown_sha256)
    expect(sharedNotionMarkdownPolicy(projection).version).toBe(13)
    expect(validateSharedNotionMarkdownProjection(projection)).toEqual(projection)
  })

  test("retains the fragment's v12 spelling and refuses to relabel its frozen projection", () => {
    const retained = projectSharedNotionMarkdown(native81.input_markdown, {
      version: 12,
      purpose: "data_source_create",
    })
    expect(sha256(retained.markdown)).toBe(native81.v12_markdown_sha256)
    expect(sha256(sharedNotionMarkdownWire(retained))).toBe(native81.wire_markdown_sha256)
    expect(validateSharedNotionMarkdownProjection(retained)).toEqual(retained)
    expect(() => validateSharedNotionMarkdownProjection({ ...retained, version: 13 })).toThrow(
      "differs from its declared input policy",
    )
  })

  test("body-write projection keeps the retained v12 spelling for this creation-only observation", () => {
    const previous = projectSharedNotionMarkdown(native81.input_markdown, {
      version: 12,
      purpose: "body_write",
    })
    const current = projectSharedNotionMarkdown(native81.input_markdown, {
      purpose: "body_write",
    })
    expect(current.markdown).toBe(previous.markdown)
    expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(previous))
  })

  test.each([
    "1. First\n\n2. Second",
    "- First\n\n  ```text\n  literal\n  ```\n\n  Continuation.",
    "1. First\n\n   Continuation without a code child.\n\n2. Second",
    "```text\n1. First\n\n   Continuation.\n```",
  ])("unobserved list shapes and literal code keep their v12 projection (%s)", (input) => {
    const previous = projectSharedNotionMarkdown(input, {
      version: 12,
      purpose: "data_source_create",
    })
    const current = projectSharedNotionMarkdown(input, { purpose: "data_source_create" })
    expect(current.markdown).toBe(previous.markdown)
    expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(previous))
  })
})

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
      const projection = projectV2(sample.request_markdown, {
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
      const projection = projectV2(sample.request_markdown, {
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
    const create = projectV2(input, { purpose: "data_source_create" })
    const write = projectV2(input)
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
    expect(projectV2(input).markdown).toBe(
      "Paragraph with <b>bold </b><b><code>code</code></b><b> bold</b> and <i>italic</i> and <s>strike</s>.\n\nCode: <code>a < b & c > d</code> and <code>a`b</code>.",
    )
  })

  test.each(["", "text", "txt", "plaintext", "plain text"])(
    "explicitly freezes plain-text fences (%s)",
    (language) => {
      const input = `\`\`\`${language}\nliteral <angle> & text\n\`\`\``
      const projection = projectV2(input)
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
    const projection = projectV2(input)
    expect(sharedNotionMarkdownWire(projection)).toBe(input)
    expect(projection.markdown).toBe(`\`\`\`${observed}\nvalue\n\`\`\``)
  })

  test("fenced code remains literal while headings, lists and table cells use their AST spans", () => {
    const input =
      "# Title\n\n- [ ] **Todo**\n- [x] `Done`\n\n| Key | Value |\n| --- | --- |\n| `key` | **value** |\n\n```js\n// # heading **bold** `code`\nconst value = 1\n```"
    const projection = projectV2(input, { purpose: "data_source_create" })
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
    expect(projectV2(input).markdown).toBe(input)
  })

  test("native code containing backticks stays opaque while following Markdown still projects", () => {
    const input = "<b><code>[example](missing.md) and a`b</code></b> [real](real.md) and `outside`."
    expect(projectV2(input).markdown).toBe(
      "<b><code>[example](missing.md) and a`b</code></b> [real](real.md) and <code>outside</code>.",
    )
  })

  test("neither request bytes nor returned bytes can redefine the frozen v2 policy", () => {
    const projection = projectV2("# Title\n\n**Body**", {
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
      expect(() => projectV2(input, { purpose })).toThrow(SkillsError)
    // Retained operations use their saved policy; this limit is not retroactive.
    const retained = projectV1(input)
    expect(retained.markdown).toBe(input)
    expect(retained.input_markdown).toBe(input)
    expect(validateSharedNotionMarkdownProjection(retained)).toEqual(retained)
  })

  test("an unrepresentable indented code block fails before a candidate is accepted", () => {
    expect(() => projectV2("    const value = 1")).toThrow(SkillsError)
  })
})

const projectV3 = (
  input: string,
  options: { readonly purpose?: "body_write" | "data_source_create" } = {},
) => projectSharedNotionMarkdown(input, { ...options, version: 3 })

describe("native Markdown projection v3 inline boundary", () => {
  test.each([
    "Native <code>a`b</code>.\n\nFollowing paragraph.",
    "Markdown ``a`b``.\n\nFollowing paragraph.",
    "**Bold ``a`b`` text**.",
    "<b><code>a`b</code></b>.",
    "# Heading ``a`b``",
    "<h1>Heading <code>a`b</code></h1>",
    "- Native <code>a`b</code>",
    "> Quoted **``a`b``**.",
    "- [ ] Nested\n  - <code>a`b</code>",
    "| ``a`b`` | Heading |\n| --- | --- |\n| Value | Value |",
    "| Heading | Heading |\n| --- | --- |\n| <code>a`b</code> | Value |",
    "[Visible ``a`b``](https://example.com)",
  ])("rejects literal backticks inside inline code before projection (%s)", (input) => {
    for (const purpose of ["body_write", "data_source_create"] as const)
      expect(() => projectV3(input, { purpose })).toThrow(
        "inline code containing a literal backtick",
      )
  })

  test("literal fences remain complete and use the unchanged renderer", () => {
    const input = "```text\n<code>a`b</code>\n``a`b``\n```\n"
    for (const purpose of ["body_write", "data_source_create"] as const) {
      const projected = projectV3(input, { purpose })
      expect(projected.version).toBe(3)
      expect(projected.input_markdown).toBe(input)
      expect(sharedNotionMarkdownWire(projected)).toBe(input.slice(0, -1))
      expect(projected.markdown).toBe("```txt\n<code>a`b</code>\n``a`b``\n```")
      expect(validateSharedNotionMarkdownProjection(projected)).toEqual(projected)
    }
  })

  test("ordinary inline code and literal URL destinations remain accepted", () => {
    for (const input of [
      "Native <code>marker</code> and Markdown `marker`.",
      "[Link](https://example.com/``a`b``)",
      "[Reference][target]\n\n[target]: https://example.com/``a`b``",
      "[visible][``a`b``]\n\n[``a`b``]: https://example.com",
      "[visible][<code>a`b</code>]\n\n[<code>a`b</code>]: https://example.com",
      "![Image](https://example.com/``a`b``)",
      "<!-- <code>a`b</code> -->\n\nOrdinary text.",
      "\\<code>a`b\\</code> and `ordinary`.",
    ]) {
      const projected = projectV3(input)
      expect(projected.version).toBe(3)
      expect(projected.input_markdown).toBe(input)
      expect(sharedNotionMarkdownWire(projected)).toBe(sharedNotionMarkdownWire(projectV2(input)))
      expect(projected.markdown).toBe(projectV2(input).markdown)
    }
  })

  test("old v1/v2 records retain their exact wire, expected body and validation", () => {
    const input = "Native <code>a`b</code>.\n\nNext `code`.\n"
    const historical = {
      format: "notion_markdown_v2",
      normalization_version: 1,
      input_markdown: input,
      removed_terminal_lfs: 1,
    } as const
    const v1 = { version: 1, ...historical, markdown: input.slice(0, -1) } as const
    const v2 = {
      version: 2,
      ...historical,
      purpose: "body_write",
      wire_markdown: input.slice(0, -1),
      markdown: "Native <code>a`b</code>.\n\nNext <code>code</code>.",
    } as const
    expect(projectV1(input)).toEqual(v1)
    expect(projectV2(input)).toEqual(v2)
    expect(validateSharedNotionMarkdownProjection(v1)).toEqual(v1)
    expect(validateSharedNotionMarkdownProjection(v2)).toEqual(v2)
    expect(sharedNotionMarkdownWire(v1)).toBe(input.slice(0, -1))
    expect(sharedNotionMarkdownWire(v2)).toBe(input.slice(0, -1))
    expect(sharedNotionMarkdownPolicy(v2).version).toBe(2)
    expect(() => validateSharedNotionMarkdownProjection({ ...v2, version: 3 })).toThrow(
      "inline code containing a literal backtick",
    )
  })

  test("retained policy metadata reports version 3 without relabeling old records", () => {
    const projected = projectV3("# Title\n\n`marker`\n")
    expect(sharedNotionMarkdownPolicy(projected)).toEqual({
      version: 3,
      format: "notion_markdown_v2",
      normalization_version: 1,
      removed_terminal_lfs: 1,
      purpose: "body_write",
    })
    expect(sharedNotionMarkdownWire(projected)).toBe("# Title\n\n`marker`")
    expect(projected.markdown).toBe("# Title\n\n<code>marker</code>")
  })
})
