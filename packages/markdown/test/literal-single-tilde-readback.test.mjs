import assert from "node:assert/strict"
import test from "node:test"
import { literalSingleTildeEdits } from "../src/literal-single-tilde-readback.ts"
import { SourceLexer } from "../src/source-lexer.ts"

const rich = (text, bold = false, annotations = {}) => ({
  text,
  link: null,
  bold,
  code: false,
  annotations: {
    italic: false,
    strikethrough: false,
    underline: false,
    color: "default",
    ...annotations,
  },
})
const sourceLine =
  '默认**过去 7 天**。推断规则："今天"→当天，"这周"→本周一~now，"上周"→上周一~上周日，"这个月"→1日~now。'
const literal = sourceLine.replaceAll("**", "")

function fixture() {
  return {
    source: `### 工作流\n\n${sourceLine}\n\n> **注意**：保留 \`date\` 的字面格式。\n`,
    actual: `### 工作流\n${sourceLine.replaceAll("~", "\\~")}\n> **注意**：保留 \`date\` 的字面格式。\n`,
    blocks: [
      {
        id: "heading",
        type: "heading_3",
        has_children: false,
        text: "工作流",
        rich_text: [rich("工作流")],
      },
      {
        id: "range",
        type: "paragraph",
        has_children: false,
        text: literal,
        rich_text: [
          rich("默认"),
          rich("过去 7 天", true),
          rich(literal.slice("默认过去 7 天".length)),
        ],
      },
      {
        id: "note",
        type: "quote",
        has_children: false,
        text: "注意：保留 date 的字面格式。",
        rich_text: [
          rich("注意", true),
          rich("：保留 "),
          { ...rich("date"), code: true },
          rich(" 的字面格式。"),
        ],
      },
    ],
  }
}

function positioned(markdown) {
  const result = []
  let offset = 0
  for (const token of SourceLexer.lex(markdown)) {
    const start = markdown.indexOf(token.raw, offset)
    if (start < 0) return
    result.push({ token, start, end: start + token.raw.length })
    offset = start + token.raw.length
  }
  return markdown.slice(offset).trim()
    ? undefined
    : result.filter((part) => part.token.type !== "space")
}

function editsFor(value, proof = true) {
  const actual = positioned(value.actual),
    wanted = positioned(value.source)
  if (!actual || !wanted) return []
  const paragraph = actual.find(
    (part) => part.token.type === "paragraph" && part.token.text.includes("过去"),
  )
  return literalSingleTildeEdits(actual, wanted, value.blocks, () => false)
}

test("captured single-tilde ranges match only for the proved literal paragraph", () => {
  const value = fixture(),
    before = JSON.stringify(value)
  const edits = editsFor(value)
  assert.equal(edits.length, 3)
  let repaired = value.actual
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    assert.equal(value.actual.slice(edit.start, edit.end), "\\")
    repaired = repaired.slice(0, edit.start) + edit.text + repaired.slice(edit.end)
  }
  assert.equal(
    repaired.split("\n").find((line) => line.includes("过去")),
    sourceLine,
  )
  assert.equal(repaired.includes("\\"), false)
  assert.equal(JSON.stringify(value), before)
})

test("double-tilde deletion, code, links, styles and partial proof reject", () => {
  const reject = (change) => {
    const value = fixture()
    change(value)
    assert.equal(editsFor(value).length, 0)
  }
  reject((value) => {
    value.source = value.source.replaceAll("~", "~~")
    value.actual = value.actual.replaceAll("\\~", "\\~\\~")
    value.blocks[1].text = value.blocks[1].text.replaceAll("~", "~~")
    value.blocks[1].rich_text[2].text = value.blocks[1].rich_text[2].text.replaceAll("~", "~~")
  })
  reject((value) => {
    value.source = value.source.replace("本周一~now", "`本周一~now`")
    value.actual = value.actual.replace("本周一\\~now", "`本周一~now`")
    value.blocks[1].rich_text.splice(2, 0, { ...rich("本周一~now"), code: true })
  })
  reject((value) => {
    value.source = value.source.replace("1日~now", "[1日~now](https://example.test/range)")
    value.actual = value.actual.replace("1日\\~now", "[1日~now](https://example.test/range)")
    value.blocks[1].rich_text.push({ ...rich("1日~now"), link: "https://example.test/range" })
  })
  reject((value) => {
    value.blocks[1].rich_text[2].text = "changed"
  })
  reject((value) => {
    value.blocks[1].rich_text[2].annotations.strikethrough = true
  })
  reject((value) => {
    value.blocks[1].rich_text[2].annotations.underline = true
  })
  reject((value) => {
    value.blocks[1].rich_text[2].link = "https://example.test/changed"
  })
  reject((value) => {
    value.blocks.push(structuredClone(value.blocks[1]))
    value.blocks.at(-1).id = "duplicate"
  })
  reject((value) => {
    value.actual = value.actual.replace("本周一\\~now", "本周一~now")
  })
  reject((value) => {
    value.source = value.source.replace("本周一~now", "本周一\\~now")
  })
  reject((value) => {
    value.blocks[1].has_children = true
  })
  reject((value) => {
    value.blocks[2].rich_text[0].text = "提示"
  })
  reject((value) => {
    value.actual = value.actual.replace("### 工作流\n", "### 工作流\n\n")
  })
  assert.equal(editsFor(fixture(), true).length, 3)
})
