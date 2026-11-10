import { expect, test } from "bun:test"
import {
  assertImportedMarkdownContent,
  compatibleImportMarkdown,
} from "../src/shared-import-markdown.ts"
import {
  projectSharedNotionMarkdown,
  sharedNotionMarkdownWire,
} from "../src/shared-notion-projection.ts"

test("import accepts presentation changes without requiring Markdown roundtrip equality", () => {
  const input =
    "##### Heading\n\n**Keep** `a & b` and [guide](references/guide.md).\n\n1. First\n2. Second\n\n```js\nconst value = 1\n```"
  const actual =
    "### Heading\n\n<b>Keep</b> <code>a & b</code> and [guide](references/guide.md).\n\n1. <p>First</p>\n\n2. <p>Second</p>\n\n```javascript\nconst value = 1\n```\n"
  expect(() => assertImportedMarkdownContent(input, actual)).not.toThrow()
  expect(() =>
    assertImportedMarkdownContent("Read example.com.", "Read [example.com](https://example.com)."),
  ).not.toThrow()
})

test("import does not mistake missing text, code mutations or changed explicit targets for formatting", () => {
  for (const [expected, actual] of [
    ["Do not delete data.", "Delete data."],
    ["Read [guide](references/guide.md).", "Read [guide](https://wrong.example/)."],
    ["Read [example.com](https://example.com).", "Read [example.com](http://example.com)."],
    ["Run `safe --dry-run`.", "Run <code>safe --force</code>."],
    ["```py\nif ready:\n    run()\n```", "```python\nif ready:\nrun()\n```"],
    ["Visible body", ""],
  ])
    expect(() => assertImportedMarkdownContent(expected!, actual!)).toThrow()
})

test("generated domain links do not hide an explicit target and known Notion page aliases compare equally", () => {
  expect(() =>
    assertImportedMarkdownContent(
      "example.com and [example.com](https://example.com).",
      "[example.com](http://example.com) and [example.com](https://example.com).",
    ),
  ).not.toThrow()
  expect(() =>
    assertImportedMarkdownContent(
      "[example.com](https://example.com) then example.com.",
      "[example.com](https://example.com) then [example.com](http://example.com).",
    ),
  ).not.toThrow()
  const id = "a".repeat(32)
  expect(() =>
    assertImportedMarkdownContent(
      `[page](https://www.notion.so/${id})`,
      `[page](https://app.notion.com/p/${id})`,
    ),
  ).not.toThrow()
})

test("automatically linked styled labels retain their visible text without replacing authored destinations", () => {
  expect(() =>
    assertImportedMarkdownContent(
      "Update **SKILL.md** after using Telegra.ph.",
      "Update [<b>SKILL.md</b>](http://SKILL.md) after using [Telegra.ph](http://Telegra.ph).",
    ),
  ).not.toThrow()
  for (const [before, after] of [
    ["Read [**SKILL.md**](references/SKILL.md).", "Read [<b>SKILL.md</b>](http://SKILL.md)."],
    ["Read [**SKILL.md**](https://SKILL.md).", "Read [<b>SKILL.md</b>](http://SKILL.md)."],
    ["Read **SKILL.md**.", "Read [<b>SKILL.md</b>](https://wrong.example/)."],
  ])
    expect(() => assertImportedMarkdownContent(before!, after!)).toThrow()
})

test("import compatibility does not rewrite fences or raw resources and keeps historical projection policies", () => {
  const input =
    "##### Deep heading\n\n| A | B |\n| :--- | ---: |\n| pipe \\| literal | value |\n\n```md\n###### Keep literal\n```"
  const next = projectSharedNotionMarkdown(input, { version: 14, purpose: "data_source_create" })
  expect(sharedNotionMarkdownWire(next)).toContain("### Deep heading")
  expect(sharedNotionMarkdownWire(next)).toContain("###### Keep literal")
  expect(sharedNotionMarkdownWire(next)).toContain("pipe \\| literal")
  expect(next.markdown).toBe(input)
  expect(() =>
    projectSharedNotionMarkdown(input, { version: 13, purpose: "data_source_create" }),
  ).toThrow()
  expect(() => projectSharedNotionMarkdown(input, { version: 14, purpose: "body_write" })).toThrow()
  expect(compatibleImportMarkdown("```md\n##### Literal\n``` ")).toContain("##### Literal")
})
