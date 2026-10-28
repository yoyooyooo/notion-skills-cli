import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import {
  fromNotionMarkdown,
  markdownIdentity,
  markdownStructure,
  sameMarkdownStructure,
  sameNotionMarkdown,
  visibleMarkdownText,
  visibleNotionMarkdownText,
  visibleNotionText,
} from "../src/index.ts"

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.md`, import.meta.url), "utf8")
const live = fixture("brand-live")
const target = fixture("brand-target")

test("the complete retained brand-marks readback equals its authored body", () => {
  assert.equal(sameNotionMarkdown(live, target), true)
  assert.equal(markdownIdentity(fromNotionMarkdown(live)), markdownIdentity(target))
  assert.equal(fromNotionMarkdown(fromNotionMarkdown(live)), fromNotionMarkdown(live))
})

for (const [name, before, after] of [
  ["command", "brands capture", "brands delete"],
  ["word", "Semantic", "Different"],
  ["URL", "https://partner.example.com", "https://other.example.com"],
] as const) {
  test(`a changed ${name} in the retained body is rejected`, () => {
    assert.ok(live.includes(before))
    assert.equal(sameNotionMarkdown(live.replace(before, after), target), false)
  })
}

test("repeated list fences preserve intervening prose, code tabs and following items", () => {
  const actual = [
    "10. Run:",
    "\t```bash",
    "echo first",
    "\t```",
    "\tThen inspect:",
    "\t```text",
    "\tkeep\tspaces  ",
    "",
    "second<br>line",
    "\t```",
    "11. Done.",
    "Outside.",
  ].join("\n")
  const expected = [
    "10. Run:",
    "",
    "    ```bash",
    "    echo first",
    "    ```",
    "",
    "    Then inspect:",
    "",
    "    ```text",
    "    \tkeep\tspaces  ",
    "",
    "    second<br>line",
    "    ```",
    "",
    "11. Done.",
    "",
    "Outside.",
  ].join("\n")
  assert.equal(sameNotionMarkdown(actual, expected), true)
  const restored = fromNotionMarkdown(actual)
  assert.equal(fromNotionMarkdown(restored), restored)
  assert.equal(sameNotionMarkdown(actual.replace("\tkeep", "keep"), expected), false)
  assert.equal(sameNotionMarkdown(actual.replace("second<br>line", "second line"), expected), false)
})

test("an unclosed list fence cannot borrow the next item's closing fence", () => {
  const actual = "1. First\n\t```bash\necho first\n2. Next\n\t```bash\necho next\n\t```"
  const expected =
    "1. First\n   ```bash\n   echo first\n   ```\n2. Next\n   ```bash\n   echo next\n   ```"
  assert.equal(sameNotionMarkdown(actual, expected), false)
})

test("normalizing an outer code fence preserves literal inner Notion-looking examples", () => {
  const source = "````markdown\n1. Example:\n\t```text\nkeep\n\t```\n````"
  assert.equal(fromNotionMarkdown(source), source)
})

test("automatic bare-domain links do not erase explicit destination changes", () => {
  assert.equal(
    sameNotionMarkdown("Use [github.com](https://github.com/).", "Use github.com."),
    true,
  )
  for (const url of [
    "http://github.com",
    "https://github.com:8443",
    "https://github.com/path",
    "https://github.com/?q=1",
    "https://github.com/#part",
  ]) {
    assert.equal(
      sameNotionMarkdown(`[github.com](${url})`, "[github.com](https://github.com)"),
      false,
    )
  }
  assert.equal(sameNotionMarkdown("[github.com](https://github.com:8443)", "github.com"), false)
})

test("an application destination policy leaves the default comparison strict", () => {
  const actual = "Read [guide](http://SKILL.md)."
  const expected = "Read [guide](SKILL.md)."
  const alias = (candidate: string, target: string) =>
    candidate === target || (candidate === "http://SKILL.md" && target === "SKILL.md")
  assert.equal(sameNotionMarkdown(actual, expected), false)
  assert.equal(sameMarkdownStructure(markdownStructure(actual), markdownStructure(expected)), false)
  assert.equal(
    sameMarkdownStructure(markdownStructure(actual), markdownStructure(expected), alias),
    true,
  )
  for (const changed of [
    "Read [other](http://SKILL.md).",
    'Read [guide](http://SKILL.md "changed title").',
    "Read guide.",
    "Read [guide](http://SKILL.md).\n\nExtra content.",
  ]) {
    assert.equal(
      sameMarkdownStructure(markdownStructure(changed), markdownStructure(expected), alias),
      false,
    )
  }
  assert.equal(
    sameMarkdownStructure(
      markdownStructure("![guide](http://SKILL.md)"),
      markdownStructure("![guide](SKILL.md)"),
      alias,
    ),
    false,
  )
  assert.equal(sameNotionMarkdown(actual, expected), false)
})

test("fenced code retains literal break tags, escapes, blank lines and private-use characters", () => {
  for (const [actual, expected] of [
    ["a<br>b", "a b"],
    ["a\uE000b", "ab"],
    ["a\\:b", "a:b"],
    ["a\n\nb", "a\nb"],
  ]) {
    assert.equal(
      sameNotionMarkdown(`\`\`\`text\n${actual}\n\`\`\``, `\`\`\`text\n${expected}\n\`\`\``),
      false,
    )
  }
})

test("syntax comparison does not own page aliases, IDs or skill URL policy", () => {
  const id = "11111111111111111111111111111111"
  assert.equal(
    sameNotionMarkdown(
      `[page](https://app.notion.com/p/${id})`,
      `[page](https://www.notion.so/${id})`,
    ),
    false,
  )
  assert.equal(sameNotionMarkdown("[page](skill://one/)", "[page](skill://two/)"), false)
  assert.equal(sameNotionMarkdown("a\uE000b", "ab"), false)
  assert.equal(sameNotionMarkdown("can not", "cannot"), false)
})

test("visible text shares the syntax parser while rich text keeps literal Markdown characters", () => {
  const markdown =
    "<details>\n<summary>Read</summary>\n\nUse `literal ****` and [guide](https://example.com).\n\n```text\nnot visible\n```\n\n</details>"
  const visible = visibleMarkdownText(markdown)
  assert.ok(visible.includes("Read"))
  assert.ok(visible.includes("literal ****"))
  assert.ok(visible.includes("guide"))
  assert.ok(!visible.includes("not visible"))
  assert.ok(!visible.includes("<details>"))
  assert.equal(visibleNotionText("`literal` **stars** <br> next"), "`literal` **stars** next")
})

test("the retained rationale readback restores italic text around an inline code boundary", () => {
  const actual = fixture("rationale-shape-live")
  const expected = fixture("rationale-shape-target")
  assert.equal(sameNotionMarkdown(actual, expected), true)
  assert.equal(visibleNotionMarkdownText(actual), visibleMarkdownText(expected))
  assert.equal(fromNotionMarkdown(fromNotionMarkdown(actual)), fromNotionMarkdown(actual))
  assert.equal(
    sameNotionMarkdown(actual.replace("boundary-discipline", "foreign-principle"), expected),
    false,
  )
  assert.equal(sameNotionMarkdown(actual.replace("does not do", "does do"), expected), false)
})

test("author input keeps literal stars instead of applying Notion emphasis repair", () => {
  const authored = "*Use **`code`**.*"
  assert.equal(visibleMarkdownText(authored), "*Use code.*")
  assert.equal(visibleNotionMarkdownText(authored), "Use code.")
})

test("Notion emphasis repair preserves escaped, unmatched and code-literal stars", () => {
  for (const input of [
    "\\*Use **`code`**.\\*",
    "*Use **`code`**.",
    "Use **`code`**.*",
    "**`code`**",
    "`*Use **code**.*`",
    "```text\n*Use **`code`**.*\n```",
    "*Use **`unterminated**.*",
  ]) {
    assert.equal(fromNotionMarkdown(input), input)
  }
  assert.equal(visibleMarkdownText(fromNotionMarkdown("\\*Use **`code`**.\\*")), "*Use code.*")
  assert.equal(sameNotionMarkdown("\\*Use **`code`**.\\*", "Use `code`."), false)
  const actual = "*Keep **``literal ` and ****``** intact.*"
  const expected = "*Keep ``literal ` and ****`` intact.*"
  assert.equal(sameNotionMarkdown(actual, expected), true)
  assert.equal(visibleMarkdownText(fromNotionMarkdown(actual)), "Keep literal ` and **** intact.")
  assert.equal(sameNotionMarkdown(actual.replace("and ****", "and **"), expected), false)
})

test("paragraph-edge whitespace is presentation while code and destinations remain literal", () => {
  assert.equal(
    sameNotionMarkdown(
      "> **Instruction:**\n> - Keep content.\n",
      "> **Instruction:** \n> - Keep content.\n",
    ),
    true,
  )
  assert.equal(sameNotionMarkdown("Keep `token`.  \n", "Keep `token`.\n"), true)
  assert.equal(sameNotionMarkdown("Keep `token `.\n", "Keep `token`.\n"), false)
  assert.equal(sameNotionMarkdown("```text\nkeep \n```", "```text\nkeep\n```"), false)
  assert.equal(
    sameNotionMarkdown(
      "[reference](https://example.test/a)",
      "[reference](https://example.test/b)",
    ),
    false,
  )
  assert.equal(sameNotionMarkdown("Keep both words", "Keepboth words"), false)
})
