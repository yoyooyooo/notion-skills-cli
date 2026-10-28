import assert from "node:assert/strict"
import test from "node:test"
import { boldCodeLinkReadbackEdits } from "../src/bold-code-link-readback.ts"
import { boldCodeLinkListReadbackEdits } from "../src/bold-code-link-list-readback.ts"
import { projectNotionBlockTree, samePublishedMarkdown } from "../../core/src/markdown.ts"

const rich = (text, bold = false, code = false, link = null) => ({
  type: "text",
  text: { content: text, link: link === null ? null : { url: link } },
  plain_text: text,
  href: link,
  annotations: {
    bold,
    code,
    italic: false,
    strikethrough: false,
    underline: false,
    color: "default",
  },
})
const block = (id, type, spans) => ({
  object: "block",
  id,
  type,
  has_children: false,
  archived: false,
  in_trash: false,
  parent: { type: "page_id", page_id: "page" },
  [type]: { color: "default", rich_text: spans },
})
function fixture() {
  return {
    source:
      "# Start\n\n**Read [`one.md`](../one.md) and [`two.md`](../two.md)**. Keep the complete tail.\n\n## End\n",
    actual:
      "# Start\n**Read **[**`one.md`**](../one.md)** and **[**`two.md`**](../two.md). Keep the complete tail.\n## End\n",
    blocks: [
      block("before", "heading_1", [rich("Start")]),
      block("leaf", "paragraph", [
        rich("Read ", true),
        rich("one.md", true, true, "../one.md"),
        rich(" and ", true),
        rich("two.md", true, true, "../two.md"),
        rich(". Keep the complete tail."),
      ]),
      block("after", "heading_2", [rich("End")]),
    ],
  }
}
function candidate(fixture) {
  const roots = projectNotionBlockTree("page", fixture.blocks)
  if (!roots) return
  const edits = boldCodeLinkReadbackEdits(fixture.actual, fixture.source, roots)
  if (edits.length !== 1) return
  const edit = edits[0]
  return fixture.actual.slice(0, edit.start) + edit.text + fixture.actual.slice(edit.end)
}

test("complete per-span bold/code-link readback recovers only the proved paragraph", () => {
  const f = fixture(),
    before = JSON.stringify(f)
  assert.equal(samePublishedMarkdown(f.actual, f.source), false)
  assert.equal(
    samePublishedMarkdown(f.actual, f.source, undefined, projectNotionBlockTree("page", f.blocks)),
    true,
  )
  const value = candidate(f)
  assert.ok(value)
  assert.equal(samePublishedMarkdown(value, f.source), true)
  assert.equal(JSON.stringify(f), before)
})

test("physical text, code, bold, destination and complete tail remain exact", () => {
  const changes = [
    (f) => {
      f.blocks[1].paragraph.rich_text[0] = rich("Other ", true)
    },
    (f) => {
      f.blocks[1].paragraph.rich_text[1].annotations.code = false
    },
    (f) => {
      f.blocks[1].paragraph.rich_text[1].annotations.bold = false
    },
    (f) => {
      f.blocks[1].paragraph.rich_text[1] = rich("one.md", true, true, "../other.md")
    },
    (f) => {
      f.blocks[1].paragraph.rich_text.pop()
    },
    (f) => {
      f.blocks[1].paragraph.rich_text.push(rich(" Extra."))
    },
    (f) => {
      f.blocks[1].has_children = true
    },
  ]
  for (const change of changes) {
    const f = fixture()
    change(f)
    assert.equal(candidate(f), undefined)
  }
})

test("readback and source delimiter, text, link and style changes cannot borrow physical proof", () => {
  for (const [side, before, after] of [
    ["actual", "Read ", "Other "],
    ["actual", "** and **", " and **"],
    ["actual", "../one.md", "../one.md#other"],
    ["actual", "complete tail.", "complete tail. Extra."],
    ["source", "**Read", "*Read"],
    ["source", "two.md)**", "two.md)*"],
    ["source", "../two.md", "../other.md"],
    ["source", "Read ", "Read* "],
  ]) {
    const f = fixture()
    f[side] = f[side].replace(before, after)
    assert.equal(candidate(f), undefined, `${side}:${after}`)
  }
})

test("the same two unique physical heading neighbors are required", () => {
  for (const change of [
    (f) => {
      f.blocks.shift()
    },
    (f) => {
      f.blocks.pop()
    },
    (f) => {
      f.blocks[0].heading_1.rich_text[0] = rich("Other")
    },
    (f) => {
      f.blocks[2] = block("after", "paragraph", [rich("End")])
    },
    (f) => {
      f.actual += f.actual
    },
    (f) => {
      f.source += f.source
    },
    (f) => {
      f.actual = f.actual.replace("\n## End", "\nUnobserved paragraph.\n## End")
    },
  ]) {
    const f = fixture()
    change(f)
    assert.equal(candidate(f), undefined)
  }
})

test("literal stars and valid source deletion remain strict, including the observed single-tilde mismatch", () => {
  const f = fixture()
  f.source += "\n## Range\n\nFrom a~b and c~d to e~f.\n"
  f.actual += "## Range\nFrom a\\~b and c\\~d to e\\~f.\n"
  f.blocks.push(
    block("range-heading", "heading_2", [rich("Range")]),
    block("range", "paragraph", [rich("From a~b and c~d to e~f.")]),
  )
  const value = candidate(f)
  assert.ok(value)
  assert.equal(samePublishedMarkdown(value, f.source), false)
  const stars = fixture()
  stars.source = stars.source.replace("Read ", "Read** ")
  assert.equal(candidate(stars), undefined)
})

const form = "https://app.notion.com/p/4055636c236e815989caf4f20f907c00"
const valueForm = "https://app.notion.com/p/4055636c236e815f81c8f9ff7fa2c4d4"
const sourceForm = "https://www.notion.so/4055636c236e815989caf4f20f907c00"
const sourceValue = "https://www.notion.so/4055636c236e815f81c8f9ff7fa2c4d4"
const capturedSource = `**严禁在未先阅读本文中的创建参数规则、[\`lark-approval-instance-form-control-parameters.md\`](${sourceForm}) 和 [\`lark-approval-instance-value-sourcing.md\`](${sourceValue}) 的情况下直接提单。**`
const capturedReadback = `**严禁在未先阅读本文中的创建参数规则、**[**\`lark-approval-instance-form-control-parameters.md\`**](${form})** 和 **[**\`lark-approval-instance-value-sourcing.md\`**](${valueForm})** 的情况下直接提单。**`
function listFixture() {
  return {
    source: `## 严禁行为\n\n- ${capturedSource}\n- **严禁跳过 \`approvals.get\`。**\n`,
    actual: `## 严禁行为\n- ${capturedReadback}\n- **严禁跳过 \`approvals.get\`。**\n`,
    blocks: [
      block("heading", "heading_2", [rich("严禁行为")]),
      block("leaf", "bulleted_list_item", [
        rich("严禁在未先阅读本文中的创建参数规则、", true),
        rich("lark-approval-instance-form-control-parameters.md", true, true, form),
        rich(" 和 ", true),
        rich("lark-approval-instance-value-sourcing.md", true, true, valueForm),
        rich(" 的情况下直接提单。", true),
      ]),
      block("next", "bulleted_list_item", [
        rich("严禁跳过 ", true),
        rich("approvals.get", true, true),
        rich("。", true),
      ]),
    ],
  }
}
function listCandidate(fixture) {
  const roots = projectNotionBlockTree("page", fixture.blocks)
  if (!roots) return
  const edits = boldCodeLinkListReadbackEdits(fixture.actual, fixture.source, roots)
  if (edits.length !== 1) return
  const edit = edits[0]
  return fixture.actual.slice(0, edit.start) + edit.text + fixture.actual.slice(edit.end)
}

test("one bold list leaf bordering inline code links restores the exact source item", () => {
  const f = listFixture(),
    before = JSON.stringify(f)
  assert.equal(samePublishedMarkdown(f.actual, f.source), false)
  const value = listCandidate(f)
  assert.equal(value, `## 严禁行为\n- ${capturedSource}\n- **严禁跳过 \`approvals.get\`。**\n`)
  assert.equal(
    samePublishedMarkdown(
      value,
      f.source,
      (left, right) =>
        left.replace("www.notion.so", "app.notion.com/p") === right || left === right,
    ),
    true,
  )
  assert.equal(JSON.stringify(f), before)
  assert.equal(
    boldCodeLinkReadbackEdits(f.actual, f.source, projectNotionBlockTree("page", f.blocks)).length,
    0,
  )
})

test("changed text, code, href, owner and literal star boundaries reject the list leaf", () => {
  const reject = (change) => {
    const f = listFixture()
    change(f)
    assert.equal(listCandidate(f), undefined)
  }
  reject((f) => {
    f.blocks[1].bulleted_list_item.rich_text[2] = rich(" 或 ", true)
  })
  reject((f) => {
    f.blocks[1].bulleted_list_item.rich_text[1].annotations.code = false
  })
  reject((f) => {
    f.blocks[1].bulleted_list_item.rich_text[1].annotations.bold = false
  })
  reject((f) => {
    f.blocks[1].bulleted_list_item.rich_text[1] = rich(
      "lark-approval-instance-form-control-parameters.md",
      true,
      true,
      form + "#other",
    )
  })
  reject((f) => {
    f.blocks[1].bulleted_list_item.rich_text.push(rich(" Extra", true))
  })
  reject((f) => {
    f.blocks[1].bulleted_list_item.rich_text.pop()
  })
  reject((f) => {
    f.blocks[1].has_children = true
  })
  reject((f) => {
    const copy = structuredClone(f.blocks[1])
    copy.id = "foreign"
    f.blocks.splice(2, 0, copy)
    f.source = f.source.replace("\n- **严禁跳过", "\n- " + capturedSource + "\n- **严禁跳过")
    f.actual = f.actual.replace("\n- **严禁跳过", "\n- " + capturedReadback + "\n- **严禁跳过")
  })
  reject((f) => {
    f.blocks[1].id = f.blocks[2].id
  })
  reject((f) => {
    f.actual = f.actual.replace("** 和 **", " 和 **")
  })
  reject((f) => {
    f.actual = f.actual.replace("规则、**[", "规则、****[")
  })
  reject((f) => {
    f.source = f.source.replace("规则、[", "规则、**[")
  })
  reject((f) => {
    f.source = f.source.replace(sourceForm, sourceForm + "/other")
  })
  reject((f) => {
    f.actual = f.actual.replace("approvals.get", "approvals.list")
  })
  reject((f) => {
    f.blocks[2].bulleted_list_item.rich_text[1] = rich("approvals.list", true, true)
  })
  reject((f) => {
    f.actual += f.actual
    f.source += f.source
  })
  reject((f) => {
    f.blocks[1].type = "numbered_list_item"
  })
})
