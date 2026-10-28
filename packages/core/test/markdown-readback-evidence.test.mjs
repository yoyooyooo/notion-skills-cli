import assert from "node:assert/strict"
import { test } from "node:test"
import { Schema } from "effect"
import * as candidate from "../../markdown/src/index.ts"
import { projectNotionBlocks } from "../src/markdown.ts"
import { NotionBlockBoundarySchema } from "../src/model.ts"

const url = "https://example.test/guide?key=one#section"
const span = (content, options = {}) => ({
  type: "text",
  text: { content, link: options.link ? { url: options.link } : null },
  plain_text: content,
  annotations: { bold: options.bold ?? false, code: options.code ?? false },
})
const raw = (id, type, spans = [], extra = {}) => ({
  id,
  type,
  has_children: false,
  [type]: { rich_text: spans, ...extra },
})
const numbered = () => ({
  target: `# Start\n\n3. First **item** \`code  bytes\` [docs](${url}).\n4. Second item.\n\n## Later\n\n7. Third item.\n\n## End\n\nDone.`,
  actual: `# Start\n1. First **item** \`code  bytes\` [docs](${url}).\n2. Second item.\n\n## Later\n1. Third item.\n\n## End\nDone.`,
  roots: [
    raw("head", "heading_1"),
    raw(
      "first",
      "numbered_list_item",
      [
        span("First "),
        span("item", { bold: true }),
        span(" "),
        span("code  bytes", { code: true }),
        span(" "),
        span("docs", { link: url }),
        span("."),
      ],
      { list_start_index: 3 },
    ),
    raw("second", "numbered_list_item", [span("Second item.")]),
    raw("later", "heading_2"),
    raw("third", "numbered_list_item", [span("Third item.")], { list_start_index: 7 }),
    raw("end", "heading_2"),
    raw("done", "paragraph", [span("Done.")]),
  ],
})
const angle = () => ({
  target: `# Start\n\n- Read \`literal <inner-name>\` and [docs](${url}); use <skill-name>.\n- Finish.\n\n## After\n\nLong paragraph.\n\nBefore tail.\n\n<finish all code verification>\n`,
  actual: `# Start\n- Read \`literal <inner-name>\` and [docs](${url}); use \\<skill-name\\>.\n- Finish.\n## After\nLong paragraph.\nBefore tail.\n\\<finish all code verification\\>`,
  roots: [
    raw("head", "heading_1"),
    raw("first", "bulleted_list_item", [
      span("Read "),
      span("literal <inner-name>", { code: true }),
      span(" and "),
      span("docs", { link: url }),
      span("; use <skill-name>."),
    ]),
    raw("second", "bulleted_list_item", [span("Finish.")]),
    raw("after", "heading_2"),
    raw("long", "paragraph", [span("Long paragraph.")]),
    raw("before", "paragraph", [span("Before tail.")]),
    raw("angle", "paragraph", [span("<finish all code verification>")]),
  ],
})
const result = (fixture) =>
  candidate.notionMarkdownForComparison(
    fixture.actual,
    fixture.target,
    projectNotionBlocks(fixture.roots),
  )
const full = (fixture) => {
  const value = result(fixture)
  return (
    value !== undefined &&
    candidate.sameMarkdownStructure(
      candidate.markdownStructure(value),
      candidate.markdownStructure(fixture.target),
    )
  )
}

test("positive physical list starts repair only the serialized leading number", () => {
  const fixture = numbered(),
    original = JSON.stringify(fixture),
    value = result(fixture)
  assert.equal(candidate.notionMarkdownForComparison(fixture.actual, fixture.target), undefined)
  assert.equal(typeof value, "string")
  assert.deepEqual(candidate.markdownStructure(value), candidate.markdownStructure(fixture.target))
  assert.equal(
    value,
    candidate
      .fromNotionMarkdown(fixture.actual, projectNotionBlocks(fixture.roots))
      .replace("1. First", "3. First")
      .replace("1. Third", "7. Third"),
  )
  assert.equal(JSON.stringify(fixture), original)
  assert.equal(value.includes("`code  bytes`"), true)
  assert.equal(value.includes(url), true)
})

test("the physical projection distinguishes absent, invalid and positive starts", () => {
  const root = raw("one", "numbered_list_item", [span("Body")])
  assert.deepEqual(projectNotionBlocks([root])[0].numbered_list, { start: null })
  for (const value of [0, -1, 1.5, "3", null, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const item = structuredClone(root)
    item.numbered_list_item.list_start_index = value
    assert.equal(projectNotionBlocks([item])[0].numbered_list, undefined)
  }
  for (const value of [1, 3, 27]) {
    const item = structuredClone(root)
    item.numbered_list_item.list_start_index = value
    assert.deepEqual(projectNotionBlocks([item])[0].numbered_list, { start: value })
  }
  for (const value of ["letters", null, 1]) {
    const item = structuredClone(root)
    item.numbered_list_item.list_format = value
    assert.equal(projectNotionBlocks([item])[0].numbered_list, undefined)
  }
})

test("missing or source-only starts, zero and mismatched physical starts cannot pass", () => {
  for (const change of [
    (f) => {
      delete f.roots[1].numbered_list_item.list_start_index
    },
    (f) => {
      f.roots[1].numbered_list_item.list_start_index = 1
    },
    (f) => {
      f.roots[1].numbered_list_item.list_start_index = 4
    },
    (f) => {
      f.roots[1].numbered_list_item.list_start_index = 0
      f.target = f.target.replace("3. First", "0. First")
    },
    (f) => {
      delete f.roots[1].numbered_list_item.list_start_index
      f.target = f.target.replace("3. First", "0. First")
    },
    (f) => {
      f.roots[2].numbered_list_item.list_start_index = 1
    },
    (f) => {
      f.roots[1].numbered_list_item.list_format = "letters"
    },
  ]) {
    const f = numbered()
    change(f)
    assert.equal(full(f), false)
  }
  assert.equal(candidate.sameNotionMarkdown("1. Body", "0. Body"), false)
  assert.equal(candidate.sameNotionMarkdown("1. Body", "3. Body"), false)
})

test("numbered root identity, order, inventory and leaf structure remain necessary", () => {
  for (const change of [
    (f) => {
      f.roots.splice(2, 1)
    },
    (f) => {
      f.roots[2].id = f.roots[1].id
    },
    (f) => {
      ;[f.roots[1], f.roots[2]] = [f.roots[2], f.roots[1]]
    },
    (f) => {
      f.roots[1].has_children = true
    },
    (f) => {
      f.roots[3].type = "unsupported"
    },
    (f) => {
      f.roots[2].numbered_list_item.rich_text[0].text.content = "Other item."
      f.roots[2].numbered_list_item.rich_text[0].plain_text = "Other item."
    },
  ]) {
    const f = numbered()
    change(f)
    assert.equal(full(f), false)
  }
})

test("list evidence preserves inline code, literal text and exact external destinations", () => {
  for (const change of [
    (f) => {
      f.roots[1].numbered_list_item.rich_text[3] = span("code bytes", { code: true })
    },
    (f) => {
      f.roots[1].numbered_list_item.rich_text[3].annotations.code = false
    },
    (f) => {
      f.roots[1].numbered_list_item.rich_text[5].text.link.url = url.replace("one", "two")
    },
    (f) => {
      f.actual = f.actual.replace(url, url.replace("#section", "#other"))
    },
    (f) => {
      f.target = f.target.replace("Done.", "Changed.")
    },
  ]) {
    const f = numbered()
    change(f)
    assert.equal(full(f), false)
  }
})

test("equal-looking physical lists are not resolved by copying source numbers", () => {
  const f = numbered()
  f.actual = f.actual.replace("Third item.", "Second item.")
  f.target = f.target.replace("Third item.", "Second item.")
  f.roots[4].numbered_list_item.rich_text = [span("Second item.")]
  // A different complete item sequence is still independently identifiable.
  assert.equal(full(f), true)
  const actual = "## A\n1. Same.\n\n## B\n1. Same."
  const target = "## A\n\n3. Same.\n\n## B\n\n7. Same."
  const roots = [
    raw("a", "heading_2"),
    raw("one", "numbered_list_item", [span("Same.")], { list_start_index: 3 }),
    raw("b", "heading_2"),
    raw("two", "numbered_list_item", [span("Same.")], { list_start_index: 7 }),
  ]
  assert.equal(full({ actual, target, roots }), false)
})

test("literal-angle list and terminal roots recover exact authored parsing without changing code", () => {
  const f = angle(),
    before = JSON.stringify(f),
    value = result(f)
  assert.equal(candidate.notionMarkdownForComparison(f.actual, f.target), undefined)
  assert.equal(typeof value, "string")
  assert.deepEqual(candidate.markdownStructure(value), candidate.markdownStructure(f.target))
  assert.equal(value.includes("`literal <inner-name>`"), true)
  assert.equal(value.includes(url), true)
  assert.equal(JSON.stringify(f), before)
})

test("angle recovery needs exact original literal spans, code annotations and URLs", () => {
  for (const change of [
    (f) => {
      f.roots[1].bulleted_list_item.rich_text[4] = span("; use <other-name>.")
    },
    (f) => {
      f.roots[1].bulleted_list_item.rich_text[4].annotations.code = true
    },
    (f) => {
      f.roots[1].bulleted_list_item.rich_text[1] = span("literal <changed-name>", { code: true })
    },
    (f) => {
      f.roots[1].bulleted_list_item.rich_text[3].text.link.url = url.replace("one", "two")
    },
    (f) => {
      f.roots[6].paragraph.rich_text[0].annotations.code = true
    },
    (f) => {
      f.roots[6].paragraph.rich_text[0].text.link = { url }
    },
  ]) {
    const f = angle()
    change(f)
    assert.equal(full(f), false)
  }
})

test("missing, moved, duplicate or child-bearing angle roots cannot prove themselves", () => {
  for (const change of [
    (f) => {
      f.roots.splice(6, 1)
    },
    (f) => {
      f.roots[6].id = f.roots[5].id
    },
    (f) => {
      ;[f.roots[5], f.roots[6]] = [f.roots[6], f.roots[5]]
    },
    (f) => {
      f.roots[6].has_children = true
    },
    (f) => {
      f.roots[1].has_children = true
    },
    (f) => {
      f.roots[5].paragraph.rich_text = [span("Changed before.")]
    },
  ]) {
    const f = angle()
    change(f)
    assert.equal(full(f), false)
  }
})

test("authored escapes stay literal while changed prefixes and unrelated content remain different", () => {
  const escaped = angle()
  escaped.target = escaped.target.replace("<skill-name>", "\\<skill-name\\>")
  assert.equal(full(escaped), true)
  assert.equal(result(escaped).includes("\\<skill-name\\>"), true)
  for (const change of [
    (f) => {
      f.actual = f.actual.replace("; use", "; alter")
    },
    (f) => {
      f.target = f.target.replace("Long paragraph.", "Changed paragraph.")
    },
    (f) => {
      f.actual += "\nAdded content."
    },
    (f) => {
      f.target = f.target.replace("\n\n<finish", "\n<finish")
    },
  ]) {
    const f = angle()
    change(f)
    assert.equal(full(f), false)
  }
})

test("attribute values, declarations and literal code do not use the placeholder rule", () => {
  for (const text of ['<widget value="secret">', "<!-- comment -->"]) {
    const f = angle(),
      old = "<finish all code verification>"
    f.target = f.target.replace(old, text)
    f.actual = f.actual.replace("\\<finish all code verification\\>", `\\${text.slice(0, -1)}\\>`)
    f.roots[6].paragraph.rich_text = [span(text)]
    assert.equal(full(f), false, text)
  }
  const f = angle()
  f.target = f.target.replace("<finish all code verification>", "<widget/name>")
  f.actual = f.actual.replace("\\<finish all code verification\\>", "\\<widget/name\\>")
  f.roots[6].paragraph.rich_text = [span("<widget/name>")]
  assert.equal(result(f).includes("\\<widget/name\\>"), true)
})

test("a closing custom tag uses exact physical root evidence and still rejects changed text", () => {
  const f = angle()
  f.target = f.target.replace("<finish all code verification>", "</widget-name>")
  f.actual = f.actual.replace("\\<finish all code verification\\>", "\\</widget-name\\>")
  f.roots[6].paragraph.rich_text = [span("</widget-name>")]
  assert.equal(full(f), true)
  f.roots[6].paragraph.rich_text = [span("</other-name>")]
  assert.equal(full(f), false)
})

test("ordinary conversion leaves numbered starts and angle escapes for source-bound comparison", () => {
  for (const f of [numbered(), angle()]) {
    const roots = projectNotionBlocks(f.roots)
    const converted = candidate.fromNotionMarkdown(f.actual, roots)
    assert.equal(candidate.sameNotionMarkdown(f.actual, f.target), false)
    assert.equal(candidate.sameNotionMarkdown(converted, f.target), false)
    assert.equal(candidate.notionMarkdownForComparison(f.actual, f.target), undefined)
    assert.equal(converted.includes(url), true)
  }
  const numberedFixture = numbered(),
    angleFixture = angle()
  const numberText = candidate.fromNotionMarkdown(
    numberedFixture.actual,
    projectNotionBlocks(numberedFixture.roots),
  )
  const angleText = candidate.fromNotionMarkdown(
    angleFixture.actual,
    projectNotionBlocks(angleFixture.roots),
  )
  assert.equal(numberText.includes("1. First"), true)
  assert.equal(numberText.includes("3. First"), false)
  assert.equal(angleText.includes("\\<skill-name\\>"), true)
  assert.equal(angleText.includes("\\<finish all code verification\\>"), true)
})

test("snapshot decoding retains physical start evidence without granting it to legacy boundaries", () => {
  const fixture = numbered(),
    boundaries = projectNotionBlocks(fixture.roots)
  assert.ok(boundaries)
  const decoded = boundaries.map((boundary) =>
    Schema.decodeUnknownSync(NotionBlockBoundarySchema)(boundary, { onExcessProperty: "error" }),
  )
  assert.deepEqual(decoded, boundaries)
  assert.deepEqual(
    decoded
      .filter((block) => block.type === "numbered_list_item")
      .map((block) => block.numbered_list),
    [{ start: 3 }, { start: null }, { start: 7 }],
  )
  const legacy = decoded.map(({ numbered_list: _evidence, ...boundary }) =>
    Schema.decodeUnknownSync(NotionBlockBoundarySchema)(boundary, { onExcessProperty: "error" }),
  )
  assert.equal(
    candidate.notionMarkdownForComparison(fixture.actual, fixture.target, legacy),
    undefined,
  )
  const repaired = candidate.notionMarkdownForComparison(fixture.actual, fixture.target, decoded)
  assert.equal(typeof repaired, "string")
  assert.deepEqual(
    candidate.markdownStructure(repaired),
    candidate.markdownStructure(fixture.target),
  )
})
