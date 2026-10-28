import { test } from "node:test"
import assert from "node:assert/strict"
import {
  fromNotionMarkdown,
  markdownStructure,
  notionMarkdownForComparison,
  sameMarkdownStructure,
} from "../src/index.ts"
import { SourceLexer } from "../src/source-lexer.ts"

const span = (text, values = {}) => ({ text, link: null, bold: false, code: false, ...values })
function fixture(start = 15, name = "A") {
  const first = `**Elbows ${name}.**`,
    second = `Wrists ${name}.`,
    third = `Finish ${name}.`
  const child1 = "Keep `angle  exact`.",
    child2 = `**Guard ${name}** stays exact.`,
    child3 = "Keep the hand aligned."
  const root1 = `${name}-first`,
    root2 = `${name}-second`
  const bullet = (id, parent_id, rich_text) => ({
    id,
    parent_id,
    type: "bulleted_list_item",
    has_children: false,
    rich_text,
  })
  return {
    source: `# Before ${name}\n\n${start}. ${first}\n    - ${child1}\n    - ${child2}\n${start + 1}. ${second}\n    - ${child3}\n${start + 2}. ${third}\n\n## After ${name}\n\nTail ${name}.\n`,
    actual: `# Before ${name}\n1. ${first}\n\t- ${child1}\n\t- ${child2}\n2. ${second}\n\t- ${child3}\n3. ${third}\n## After ${name}\nTail ${name}.\n`,
    roots: [
      {
        id: `${name}-before`,
        type: "heading_1",
        has_children: false,
        text: `Before ${name}`,
        rich_text: [span(`Before ${name}`)],
      },
      {
        id: root1,
        type: "numbered_list_item",
        has_children: true,
        numbered_list: { start },
        rich_text: [span(`Elbows ${name}.`, { bold: true })],
        descendants: [
          bullet(`${name}-child-1`, root1, [
            span("Keep "),
            span("angle  exact", { code: true }),
            span("."),
          ]),
          bullet(`${name}-child-2`, root1, [
            span(`Guard ${name}`, { bold: true }),
            span(" stays exact."),
          ]),
        ],
      },
      {
        id: root2,
        type: "numbered_list_item",
        has_children: true,
        numbered_list: { start: null },
        rich_text: [span(second)],
        descendants: [bullet(`${name}-child-3`, root2, [span(child3)])],
      },
      {
        id: `${name}-third`,
        type: "numbered_list_item",
        has_children: false,
        numbered_list: { start: null },
        rich_text: [span(third)],
      },
      {
        id: `${name}-after`,
        type: "heading_2",
        has_children: false,
        text: `After ${name}`,
        rich_text: [span(`After ${name}`)],
      },
      {
        id: `${name}-tail`,
        type: "paragraph",
        has_children: false,
        text: `Tail ${name}.`,
        rich_text: [span(`Tail ${name}.`)],
      },
    ],
  }
}
function matches(value) {
  const candidate = notionMarkdownForComparison(value.actual, value.source, value.roots)
  return sameMarkdownStructure(
    markdownStructure(candidate ?? value.actual),
    markdownStructure(value.source),
  )
}
function rejects(cases) {
  for (const [name, mutate] of cases) {
    const value = fixture()
    mutate(value)
    assert.equal(matches(value), false, name)
  }
}
test("complete direct bullet descendants retain the positive physical start without changing captured inputs", () => {
  const value = fixture(),
    before = JSON.stringify(value)
  assert.equal(
    sameMarkdownStructure(
      markdownStructure(fromNotionMarkdown(value.actual, value.roots)),
      markdownStructure(value.source),
    ),
    false,
  )
  assert.equal(matches(value), true)
  assert.ok(
    notionMarkdownForComparison(value.actual, value.source, value.roots)?.includes(
      "15. **Elbows A.**",
    ),
  )
  assert.ok(fromNotionMarkdown(value.actual, value.roots).includes("1. **Elbows A.**"))
  assert.equal(JSON.stringify(value), before)
})
test("separate complete nested groups retain their own starts 15, 6 and 10", () => {
  const values = [fixture(15, "A"), fixture(6, "B"), fixture(10, "C")]
  assert.equal(
    matches({
      source: values.map((value) => value.source).join("\n"),
      actual: values.map((value) => value.actual).join("\n"),
      roots: values.flatMap((value) => value.roots),
    }),
    true,
  )
})
test("missing, zero, different and continuation starts cannot supply nested start evidence", () => {
  rejects([
    [
      "missing first",
      (value) => {
        delete value.roots[1].numbered_list
      },
    ],
    [
      "null first",
      (value) => {
        value.roots[1].numbered_list.start = null
      },
    ],
    [
      "one first",
      (value) => {
        value.roots[1].numbered_list.start = 1
      },
    ],
    [
      "zero first",
      (value) => {
        value.roots[1].numbered_list.start = 0
      },
    ],
    [
      "different first",
      (value) => {
        value.roots[1].numbered_list.start = 14
      },
    ],
    [
      "missing continuation",
      (value) => {
        delete value.roots[2].numbered_list
      },
    ],
    [
      "explicit continuation",
      (value) => {
        value.roots[2].numbered_list.start = 16
      },
    ],
    [
      "zero source remains outside this path",
      (value) => {
        value.source = value.source.replace("15. **Elbows", "0. **Elbows")
        value.roots[1].numbered_list.start = 0
      },
    ],
  ])
})
test("all nested physical children must be consumed with exact owner, order, IDs and leaf shape", () => {
  rejects([
    [
      "missing inventory",
      (value) => {
        delete value.roots[1].descendants
      },
    ],
    [
      "missing child",
      (value) => {
        value.roots[1].descendants.pop()
      },
    ],
    [
      "extra blank child",
      (value) => {
        value.roots[1].descendants.push({
          id: "hidden",
          parent_id: "A-first",
          type: "bulleted_list_item",
          has_children: false,
          rich_text: [span("")],
        })
      },
    ],
    [
      "wrong owner",
      (value) => {
        value.roots[1].descendants[0].parent_id = "A-second"
      },
    ],
    [
      "reordered children",
      (value) => {
        value.roots[1].descendants.reverse()
      },
    ],
    [
      "paragraph instead of bullet",
      (value) => {
        value.roots[1].descendants[0].type = "paragraph"
      },
    ],
    [
      "unread child subtree",
      (value) => {
        value.roots[1].descendants[0].has_children = true
      },
    ],
    [
      "duplicate root ID",
      (value) => {
        value.roots[1].descendants[0].id = "A-tail"
      },
    ],
    [
      "duplicate sibling subtree ID",
      (value) => {
        value.roots[1].descendants[0].id = "A-child-3"
      },
    ],
    [
      "unexpected alternate evidence",
      (value) => {
        value.roots[1].quote_descendants = []
      },
    ],
    [
      "blank extra root",
      (value) => {
        value.roots.splice(2, 0, {
          id: "blank",
          type: "paragraph",
          has_children: false,
          rich_text: [span("")],
        })
      },
    ],
  ])
})
test("new nested evidence binds bold, code and text to both source and actual Markdown", () => {
  rejects([
    [
      "physical head loses bold",
      (value) => {
        value.roots[1].rich_text[0].bold = false
      },
    ],
    [
      "actual head loses bold",
      (value) => {
        value.actual = value.actual.replace("**Elbows A.**", "Elbows A.")
      },
    ],
    [
      "source head loses bold",
      (value) => {
        value.source = value.source.replace("**Elbows A.**", "Elbows A.")
      },
    ],
    [
      "physical child loses bold",
      (value) => {
        value.roots[1].descendants[1].rich_text[0].bold = false
      },
    ],
    [
      "physical child loses code",
      (value) => {
        value.roots[1].descendants[0].rich_text[1].code = false
      },
    ],
    [
      "same changed Markdown cannot replace physical code",
      (value) => {
        value.actual = value.actual.replace("angle  exact", "angle changed")
        value.source = value.source.replace("angle  exact", "angle changed")
      },
    ],
    [
      "extra physical link",
      (value) => {
        value.roots[1].descendants[0].rich_text[1].link = "https://example.com/code"
      },
    ],
    [
      "unrelated body drift",
      (value) => {
        value.actual = value.actual.replace("Tail A.", "Changed tail.")
      },
    ],
  ])
})
test("nested inline evidence rejects unproved whitespace and inline token forms", () => {
  rejects([
    [
      "physical LF",
      (value) => {
        value.roots[1].descendants[0].rich_text[0].text = "Keep\n"
      },
    ],
    [
      "physical CR",
      (value) => {
        value.roots[1].descendants[0].rich_text[0].text = "Keep\r"
      },
    ],
    [
      "physical tab",
      (value) => {
        value.roots[1].descendants[0].rich_text[0].text = "Keep\t"
      },
    ],
    [
      "actual tab inside inline text",
      (value) => {
        value.actual = value.actual.replace("Keep `angle", "Keep\t`angle")
      },
    ],
    [
      "source CR inside inline text",
      (value) => {
        value.source = value.source.replace("Keep `angle", "Keep\r`angle")
      },
    ],
    [
      "unproved emphasis",
      (value) => {
        value.actual = value.actual.replace("Keep the hand aligned.", "*Keep the hand aligned.*")
        value.source = value.source.replace("Keep the hand aligned.", "*Keep the hand aligned.*")
      },
    ],
    [
      "unproved explicit link",
      (value) => {
        value.actual = value.actual.replace(
          "Keep the hand aligned.",
          "[Keep the hand aligned.](https://example.com/)",
        )
        value.source = value.source.replace(
          "Keep the hand aligned.",
          "[Keep the hand aligned.](https://example.com/)",
        )
      },
    ],
  ])
})
test("same-style physical span segmentation is the only new inline presentation variation", () => {
  const value = fixture()
  value.roots[1].rich_text = [span("Elbows ", { bold: true }), span("A.", { bold: true })]
  value.roots[1].descendants[0].rich_text[1] = span("angle ", { code: true })
  value.roots[1].descendants[0].rich_text.splice(2, 0, span(" exact", { code: true }))
  assert.equal(matches(value), true)
})
test("equal-looking complete nested groups cannot borrow one another's starts", () => {
  const first = fixture(),
    second = fixture()
  for (const root of second.roots) {
    root.id = `second-${root.id}`
    for (const child of root.descendants ?? []) {
      child.id = `second-${child.id}`
      child.parent_id = root.id
    }
  }
  assert.equal(
    matches({
      source: first.source + "\n" + second.source,
      actual: first.actual + "\n" + second.actual,
      roots: [...first.roots, ...second.roots],
    }),
    false,
  )
})

function paragraphBefore(value, markdown, rich_text) {
  value.source = value.source.replace("# Before A\n\n", `${markdown}\n\n`)
  value.actual = value.actual.replace("# Before A\n", `${markdown}\n`)
  value.roots[0] = {
    id: "A-before",
    type: "paragraph",
    has_children: false,
    text: rich_text.map((item) => item.text).join(""),
    rich_text,
  }
  return value
}

test("only the fully bound first-item child indentation grows with the retained marker width", () => {
  const value = fixture(123)
  value.source = value.source.replaceAll("\n    -", "\n     -")
  const converted = fromNotionMarkdown(value.actual, value.roots)
  const candidate = notionMarkdownForComparison(value.actual, value.source, value.roots)
  assert.equal(matches(value), true)
  assert.ok(candidate)
  const before = converted.split("\n").find((line) => line.endsWith("- Keep `angle  exact`."))
  const after = candidate.split("\n").find((line) => line.endsWith("- Keep `angle  exact`."))
  assert.ok(before)
  assert.equal(after, "  " + before)
  assert.equal(
    candidate.split("\n").find((line) => line.endsWith("- Keep the hand aligned.")),
    converted.split("\n").find((line) => line.endsWith("- Keep the hand aligned.")),
  )
})

test("a source-proven preceding paragraph retains its boundary before a complete nested list", () => {
  for (const start of [15, 10]) {
    const prefix =
      start === 15
        ? "Read `tests/arm-ranges.test.js` and `gamePlayerMotion`."
        : "The archery shot cycle stays exact."
    const spans =
      start === 15
        ? [
            span("Read "),
            span("tests/arm-ranges.test.js", { code: true }),
            span(" and "),
            span("gamePlayerMotion", { code: true }),
            span("."),
          ]
        : [span(prefix)]
    const value = paragraphBefore(fixture(start), prefix, spans)
    const before = JSON.stringify(value)
    assert.equal(matches(value), true)
    const candidate = notionMarkdownForComparison(value.actual, value.source, value.roots)
    assert.ok(candidate?.startsWith(prefix + `\n\n${start}. **Elbows A.**`))
    assert.equal(JSON.stringify(value), before)
  }
})

test("a new paragraph boundary cannot discard physical style or permit unproved inline forms", () => {
  for (const [name, markdown, spans] of [
    ["missing physical bold", "**Before** A.", [span("Before A.")]],
    ["unproved emphasis", "*Before* A.", [span("Before A.")]],
    ["physical tab", "Before A.", [span("Before\tA.")]],
    ["physical LF", "Before A.", [span("Before\nA.")]],
    ["physical link", "Before A.", [span("Before A.", { link: "https://example.com/" })]],
  ]) {
    const value = paragraphBefore(fixture(), markdown, spans)
    assert.equal(matches(value), false, name)
  }
})

test("a final nested item may leave exactly its parser terminal LF outside item raw", () => {
  const value = fixture(6)
  value.source = value.source
    .replace("8. Finish A.\n", "8. Finish A.\n    - Last child stays exact.\n")
    .replace("\n\n## After A", "\n\n- Separate root.\n\n## After A")
  value.actual = value.actual.replace(
    "3. Finish A.\n",
    "3. Finish A.\n\t- Last child stays exact.\n- Separate root.\n",
  )
  const last = value.roots.find(
    (root) =>
      root.type === "numbered_list_item" &&
      root.rich_text?.map((item) => item.text).join("") === "Finish A.",
  )
  assert.ok(last)
  last.has_children = true
  last.descendants = [
    {
      id: "A-terminal-child",
      parent_id: last.id,
      type: "bulleted_list_item",
      has_children: false,
      rich_text: [{ text: "Last child stays exact.", link: null, bold: false, code: false }],
    },
  ]
  value.roots.splice(4, 0, {
    id: "A-following-root",
    type: "bulleted_list_item",
    has_children: false,
    rich_text: [{ text: "Separate root.", link: null, bold: false, code: false }],
  })
  const before = JSON.stringify(value)
  const converted = fromNotionMarkdown(value.actual, value.roots)
  const list = SourceLexer.lex(converted).find(
    (token) => token.type === "list" && token.ordered && token.start === 1,
  )
  assert.ok(list)
  const items = list.items.map((item) => item.raw).join("")
  assert.ok(list.raw.startsWith(items))
  assert.equal(list.raw.slice(items.length), "\n")
  assert.equal(matches(value), true)
  assert.equal(JSON.stringify(value), before)
})
