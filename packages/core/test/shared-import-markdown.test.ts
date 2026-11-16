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

test("class-only div and span presentation can flatten while code and authored destinations remain strict", () => {
  const source =
    '<div class="c2"><div>Visible <span class="eyebrow">heading</span></div><div class="meta">Read [guide](guide.md).</div></div>'
  expect(() =>
    assertImportedMarkdownContent(source, "Visible heading\n\nRead [guide](guide.md)."),
  ).not.toThrow()
  expect(() =>
    assertImportedMarkdownContent(source, "Visible\n\nRead [guide](guide.md)."),
  ).toThrow()
  expect(() =>
    assertImportedMarkdownContent(source, "Visible heading\n\nRead [guide](wrong.md)."),
  ).toThrow()
  for (const input of [
    '<span data-policy="retain">Visible</span>',
    '<div id="original">Visible</div>',
    '<span aria-label="do not remove">Visible</span>',
    '<div style="display:none">Visible</div>',
    '`<div class="meta">Visible</div>`',
  ])
    expect(() => assertImportedMarkdownContent(input, "Visible")).toThrow()
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

test("a native table that returns only image alt text cannot prove its authored HTML image source", () => {
  const source = [
    "| Preview | Theme |",
    "| --- | --- |",
    '| <img src="https://github.com/example/image.png" width="260" alt="Theme preview"> | Classic |',
  ].join("\n")
  const observed = ["| Preview | Theme |", "| --- | --- |", "| Theme preview | Classic |"].join(
    "\n",
  )
  expect(() => assertImportedMarkdownContent(source, observed)).toThrow()
  // Matching a visible alt label or keeping a separate href must not excuse
  // loss of the authored image source and its physical representation.
  expect(() =>
    assertImportedMarkdownContent(
      '<a href="./SPONSORS.md"><img src="https://github.com/example/sponsors.png" alt="Sponsors"></a>',
      '<a href="./SPONSORS.md"></a>',
    ),
  ).toThrow()
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

test("a later automatic URL cannot supply the destination of an earlier changed authored link", () => {
  const source = "[example.com](https://example.com) then example.com."
  const changed = "[example.com](http://example.com) then [example.com](https://example.com)."
  expect(() => assertImportedMarkdownContent(source, changed)).toThrow()
  expect(() =>
    assertImportedMarkdownContent(
      source,
      "[example.com](https://example.com) then [example.com](http://example.com).",
    ),
  ).not.toThrow()
  const unrelated = "[public.example](https://safe.example) then safe.example."
  expect(() =>
    assertImportedMarkdownContent(
      unrelated,
      "[public.example](https://public.example) then [safe.example](https://safe.example).",
    ),
  ).toThrow()
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

test("self-labelled URL autolinks in preserved comment text do not add an authored destination", () => {
  const url = "https://example.test/canonical"
  const before = `Source ${url}.\n\n<!-- canonical: ${url} | do not copy -->`
  const after = `Source [${url}](${url}).\n\n\\<!-- canonical: [${url}](${url}) \\| do not copy -->`
  expect(() => assertImportedMarkdownContent(before, after)).not.toThrow()
  expect(() =>
    assertImportedMarkdownContent(before, after.replace(`](${url})`, "](https://wrong.example/)")),
  ).toThrow()
  expect(() =>
    assertImportedMarkdownContent(`[${url}](${url})`, `[${url}](http://example.test/canonical)`),
  ).toThrow()
})

test("table plus signs are content, not interchangeable native list bullets", () => {
  const before = "| Action | Contract |\n| --- | --- |\n| New document | brief + content |\n"
  expect(() => assertImportedMarkdownContent(before, before.replace(" + ", " • "))).toThrow()
  const code = "Use `brief + content`."
  expect(() =>
    assertImportedMarkdownContent(code, "Use <code>brief + content</code>."),
  ).not.toThrow()
  expect(() => assertImportedMarkdownContent(code, "Use <code>brief • content</code>.")).toThrow()
})

test("empty list wrappers from native import preserve content rather than inventing text", () => {
  const before =
    "## Summary\n\n- \n\n## Validation\n\n- [ ] Run `safe --dry-run`\n- [ ] Review manually\n"
  const after =
    "## Summary\n\n<ul>\n<li></li>\n</ul>\n\n## Validation\n\n- [ ] Run <code>safe --dry-run</code>\n- [ ] Review manually\n"
  expect(() => assertImportedMarkdownContent(before, after)).not.toThrow()
  expect(() =>
    assertImportedMarkdownContent("- Keep all content\n", "<ul><li></li></ul>\n"),
  ).toThrow()
  expect(() =>
    assertImportedMarkdownContent(
      before,
      after.replace("<li></li>", "<li>Injected instruction</li>"),
    ),
  ).toThrow()
  expect(() =>
    assertImportedMarkdownContent("Literal `<ul><li></li></ul>`.", "Literal ."),
  ).toThrow()
  expect(() =>
    assertImportedMarkdownContent(before, after.replace("<ul>", "<unknown-list>")),
  ).toThrow()
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
