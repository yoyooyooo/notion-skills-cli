import assert from "node:assert/strict"
import { test } from "node:test"
import { nativeMarkdownWire } from "../src/native-markdown-wire.ts"

const wire = (markdown: string) => nativeMarkdownWire(markdown)

test("inline placeholder tags are escaped only in the native request body", () => {
  const source =
    "Use <string>, <oneOf>, <chart>, and <N> beside <reason one> and <task-instructions>."
  assert.equal(
    wire(source),
    "Use \\<string\\>, \\<oneOf\\>, \\<chart\\>, and \\<N\\> beside \\<reason one\\> and \\<task-instructions\\>.",
  )
  assert.equal(source.includes("\\<"), false)
  assert.equal(
    wire("**bold _<N>_ text** and ~~<flag>~~"),
    "**bold _\\<N\\>_ text** and ~~\\<flag\\>~~",
  )
  assert.equal(
    wire("> Status <N> follows <reason one>."),
    "> Status \\<N\\> follows \\<reason one\\>.",
  )
  assert.equal(
    wire("- item <string>\n1. numbered <chart>"),
    "- item \\<string\\>\n1. numbered \\<chart\\>",
  )
  assert.equal(wire("# Fields <start date>"), "# Fields \\<start date\\>")
  assert.equal(
    wire("| cell | <string> |\n| - | - |\n| `<N>` | <chart> |"),
    "| cell | \\<string\\> |\n| - | - |\n| `<N>` | \\<chart\\> |",
  )
  assert.equal(
    wire("[<flag>](https://example.test) and ![<N>](https://example.test/a.png)"),
    "[\\<flag\\>](https://example.test) and ![\\<N\\>](https://example.test/a.png)",
  )
  assert.equal(wire("already \\<string\\> plus <oneOf>"), "already \\<string\\> plus \\<oneOf\\>")
})

test("code, destinations, structural tags, and block HTML stay byte for byte", () => {
  const protectedForms = [
    "Keep `<string>` exact.",
    "`` <N> `` stays code.",
    "```js\n<string>\n<N>\n```",
    "~~~\n<flag>\n~~~\n",
    "Intro\n\n    <string>\n",
    "See [docs](https://example.test/<string>) now.",
    "See https://example.test/a now.",
    "See <https://example.test/a> now.",
    "[label]: https://example.test/<N>\n",
    '[lab](https://example.test/a "see <N>")',
    "![icon](https://example.test/<N>.png)",
    '<page url="https://www.notion.so/abc">Title</page>',
    'See <mention-page url="https://www.notion.so/abc">Title</mention-page> now.',
    "Break <br> <table> <td> <tr> <th> <page> here.",
    '<table header-row="true">\n<tr><td><string></td></tr>\n</table>',
    '<div class="x">no</div>',
    "<script>alert(1)</script>",
    "<!-- note -->",
    "<!DOCTYPE html>",
    '<input value="one">',
    "<unknown-block>\ncontent <N>\n</unknown-block>",
    "<overview>\nKeep words.\n</overview>",
    "<overview>\n\nkeep\n\n</overview>",
    "<string>\nnot separated",
    "</string> and <string/> and <string >",
    "math 1 < 2 and 3 > 1",
    "ordinary paragraph",
    "Keep <b>bold</b> and <i>italic</i>.",
    "Keep <em>e</em>, <strong>s</strong>, <code>c</code>, <span>x</span>, and <a>y</a>.",
    "> [ref]: https://example.test/<N>",
    "- [ref]: https://example.test/<N>",
    "> > [ref]: https://example.test/<N>",
  ]
  for (const source of protectedForms) assert.equal(wire(source), source, source)
})

test("a protected span does not prevent escaping a neighboring placeholder", () => {
  assert.equal(
    wire("`<string>` then <N> and [docs](https://example.test/<chart>) then <flag>."),
    "`<string>` then \\<N\\> and [docs](https://example.test/<chart>) then \\<flag\\>.",
  )
  assert.equal(
    wire("```\n<string>\n```\n\nAfter <chart>."),
    "```\n<string>\n```\n\nAfter \\<chart\\>.",
  )
  assert.equal(
    wire("<div>raw</div>\n\n<string>\n\n<script>x</script>"),
    "<div>raw</div>\n\n<string>\n\n<script>x</script>",
  )
  assert.equal(
    wire('<page url="https://www.notion.so/abc">Title</page>\n\nUse <N>.'),
    '<page url="https://www.notion.so/abc">Title</page>\n\nUse \\<N\\>.',
  )
})
test("unmapped quote definitions preserve all source bytes rather than rewriting their destinations", () => {
  const quote = "> [ref]: https://example.test/<N>\n>\n> Use <flag> and <b>bold</b>."
  assert.equal(wire(quote), quote)
  assert.equal(
    wire("- [ref]: https://example.test/<N>\n- Use <flag>"),
    "- [ref]: https://example.test/<N>\n- Use \\<flag\\>",
  )
  assert.equal(
    wire("1. [ref]: https://example.test/<N>\n\n   more <chart>"),
    "1. [ref]: https://example.test/<N>\n\n   more \\<chart\\>",
  )
})

test("literal dollars cannot become native equations while code and link destinations stay exact", () => {
  assert.equal(
    wire("Use $0.09 and $16,531.54; call `$helpers`."),
    "Use \\$0.09 and \\$16,531.54; call `$helpers`.",
  )
  assert.equal(
    wire("[price](https://example.test/$value) costs $9."),
    "[price](https://example.test/$value) costs \\$9.",
  )
  assert.equal(wire("```text\n$helpers\n```"), "```text\n$helpers\n```")
})

test("prose operators and filenames retain their visible meaning in native Markdown", () => {
  assert.equal(
    wire("| fields | fs + fid + po |\n| - | - |\n| guide | success-rate-pitfalls.md §11 |"),
    "| fields | fs \\+ fid \\+ po |\n| - | - |\n| guide | success-rate-pitfalls\\.md §11 |",
  )
  assert.equal(
    wire("Use `fs + fid` and [guide](https://example.test/a+b.md)."),
    "Use `fs + fid` and [guide](https://example.test/a+b.md).",
  )
  assert.equal(wire("+ item\n\n```js\nfs + fid\n```"), "+ item\n\n```js\nfs + fid\n```")
})

test("page child titles remain exact structural data when a tag follows prose", () => {
  const tag =
    '<page url="https://app.notion.com/p/22222222222242228222000000000001">guide.md</page>'
  for (const prefix of ["", "Body\n", "Body\n\n"]) {
    assert.equal(wire(prefix + tag), prefix + tag)
  }
  assert.equal(
    wire("Before $9 + guide.md\n" + tag + "\nAfter $10 + guide.md"),
    "Before \\$9 \\+ guide\\.md\n" + tag + "\nAfter \\$10 \\+ guide\\.md",
  )
})
