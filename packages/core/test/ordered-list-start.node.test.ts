import assert from "node:assert/strict"
import { test } from "vitest"
import { sameNotionMarkdown } from "@notion-skills-cli/markdown"
import { planOrderedListStart } from "../src/ordered-list-start.ts"

const page = "11111111-1111-4111-8111-111111111111"
const item = (id: string, text: string, type = "numbered_list_item") => ({
  object: "block",
  id,
  type,
  parent: { type: "page_id", page_id: page },
  has_children: false,
  archived: false,
  in_trash: false,
  last_edited_time: "before",
  [type]: {
    rich_text: [
      {
        type: "text",
        plain_text: text,
        text: { content: text, link: null },
        annotations: { bold: false, code: false },
      },
    ],
  },
})
const roots = [
  item("heading", "Steps", "heading_1"),
  item("first", "First exact item."),
  item("second", "Second exact item."),
  item("tail", "Tail stays exact.", "paragraph"),
]
const numberedBody = (block: (typeof roots)[number]) => {
  const body = block.numbered_list_item
  assert.ok(body !== null && typeof body === "object" && !Array.isArray(body))
  return body
}
const target = "# Steps\n\n0. First exact item.\n1. Second exact item.\n\nTail stays exact.\n"
const actual = "# Steps\n\n1. First exact item.\n2. Second exact item.\n\nTail stays exact.\n"

test("the planner proposes one exact block field and leaves comparison strict", () => {
  assert.equal(sameNotionMarkdown(actual, target), false)
  const plan = planOrderedListStart(page, actual, target, roots)
  assert.equal(plan?.block_id, "first")
  assert.equal(plan?.list_start_index, 0)
  assert.equal(plan?.list_ordinal, 0)
  assert.equal(sameNotionMarkdown(plan!.corrected_markdown, target), true)
  assert.equal(sameNotionMarkdown(actual, target), false)
  assert.equal(planOrderedListStart(page, target, target, roots), undefined)
})

test("the proposed after-document preserves the parsed list boundary before zero", () => {
  const before = "Before text.\n"
  const readback = before + actual.slice(actual.indexOf("1. First"))
  const wanted = before + "\n" + target.slice(target.indexOf("0. First"))
  const evidence = [item("before", "Before text.", "paragraph"), ...roots.slice(1)]
  const plan = planOrderedListStart(page, readback, wanted, evidence)
  assert.equal(plan?.block_id, "first")
  assert.equal(sameNotionMarkdown(plan!.corrected_markdown, wanted), true)
  assert.equal(sameNotionMarkdown(readback, wanted), false)
})

test("wrong words, explicit URLs, code bytes or another structural change authorize no patch", () => {
  for (const changed of [
    actual.replace("Second exact", "Different exact"),
    actual.replace("Tail stays exact.", "Tail stays exact. extra"),
    actual.replace("1. First", "- First"),
  ]) {
    assert.equal(planOrderedListStart(page, changed, target, roots), undefined)
  }
  const site = "\n[site](https://example.test/x)\n"
  assert.equal(
    planOrderedListStart(page, actual + site.replace("https:", "http:"), target + site, roots),
    undefined,
  )
  const code = "\n```text\n  exact bytes\n```\n"
  assert.equal(
    planOrderedListStart(page, actual + code.replace("  exact", " exact"), target + code, roots),
    undefined,
  )
})

test("the complete root inventory proves unique owner, order, leaf structure and count", () => {
  for (const changed of [
    roots.slice(1),
    [roots[0]!, roots[2]!, roots[1]!, roots[3]!],
    [...roots, roots[1]!],
    roots.map((block, index) => (index === 1 ? { ...block, id: "heading" } : block)),
    roots.map((block, index) => (index === 1 ? { ...block, has_children: true } : block)),
    roots.map((block, index) =>
      index === 1 ? { ...block, parent: { type: "page_id", page_id: "foreign" } } : block,
    ),
    roots.map((block, index) => (index === 2 ? item(block.id, "Foreign exact item.") : block)),
  ])
    assert.equal(planOrderedListStart(page, actual, target, changed), undefined)
})

test("unsupported starts, nested items, explicit resets and multiple required corrections refuse", () => {
  assert.equal(
    planOrderedListStart(page, actual, target.replace("0. First", "3. First"), roots),
    undefined,
  )
  const reset = roots.map((block, index) =>
    index === 2
      ? { ...block, numbered_list_item: { ...numberedBody(block), list_start_index: 4 } }
      : block,
  )
  assert.equal(planOrderedListStart(page, actual, target, reset), undefined)
  const numeric = roots.map((block) =>
    block.type === "numbered_list_item"
      ? { ...block, numbered_list_item: { ...numberedBody(block), list_format: "numbers" } }
      : block,
  )
  assert.equal(planOrderedListStart(page, actual, target, numeric)?.block_id, "first")
  for (const [index, list_format] of [
    [1, "roman"],
    [1, "letters"],
    [2, "letters"],
    [2, "roman"],
  ] as const) {
    assert.equal(
      planOrderedListStart(
        page,
        actual,
        target,
        roots.map((block, i) =>
          i === index
            ? { ...block, numbered_list_item: { ...numberedBody(block), list_format } }
            : block,
        ),
      ),
      undefined,
    )
  }
  const nestedActual = actual.replace("2. Second", "   - Nested\n2. Second")
  const nestedTarget = target.replace("1. Second", "   - Nested\n1. Second")
  assert.equal(planOrderedListStart(page, nestedActual, nestedTarget, roots), undefined)
  const moreRoots = [
    ...roots,
    item("other-first", "Other item."),
    item("other-second", "Other second."),
  ]
  assert.equal(
    planOrderedListStart(
      page,
      actual + "\n1. Other item.\n2. Other second.\n",
      target + "\n0. Other item.\n1. Other second.\n",
      moreRoots,
    ),
    undefined,
  )
})

test("non-list content and nested roots cannot move the proposed list identity", () => {
  const live = "# Alpha\n\n1. Same item.\n\n# Beta\n\n1. Different item.\n"
  const wanted = live.replace("1. Same item.", "0. Same item.")
  const evidence = [
    item("alpha", "Alpha", "heading_1"),
    item("list-alpha", "Same item."),
    item("beta", "Beta", "heading_1"),
    item("list-beta", "Different item."),
  ]
  assert.equal(planOrderedListStart(page, live, wanted, evidence)?.block_id, "list-alpha")
  assert.equal(
    planOrderedListStart(page, live, wanted, [
      evidence[2]!,
      evidence[1]!,
      evidence[0]!,
      evidence[3]!,
    ]),
    undefined,
  )
  assert.equal(
    planOrderedListStart(
      page,
      actual,
      target,
      roots.map((block, index) => (index === 0 ? { ...block, has_children: true } : block)),
    ),
    undefined,
  )
  assert.equal(
    planOrderedListStart(
      page,
      actual,
      target,
      roots.map((block, index) =>
        index === 3 ? item(block.id, "Different tail.", "paragraph") : block,
      ),
    ),
    undefined,
  )
})

test("repeated list signatures cannot borrow an indistinguishable root identity", () => {
  const live = "# Alpha\n\n1. Same item.\n\n# Beta\n\n1. Same item.\n"
  const wanted = live.replace("1. Same item.", "0. Same item.")
  const evidence = [
    item("alpha", "Alpha", "heading_1"),
    item("list-alpha", "Same item."),
    item("beta", "Beta", "heading_1"),
    item("list-beta", "Same item."),
  ]
  assert.equal(planOrderedListStart(page, live, wanted, evidence), undefined)
  assert.equal(
    planOrderedListStart(page, live, wanted, [
      evidence[2]!,
      evidence[3]!,
      evidence[0]!,
      evidence[1]!,
    ]),
    undefined,
  )
})

test("raw rich text must independently prove explicit destinations and code bytes", () => {
  const live = "1. [site](https://example.test/right) and `exact code`\n"
  const wanted = live.replace("1.", "0.")
  const block = item("first", "unused")
  const rich = (text: string, link: string | null, code = false) => ({
    type: "text",
    plain_text: text,
    text: { content: text, link: link === null ? null : { url: link } },
    annotations: { bold: false, code },
  })
  const linked = {
    ...block,
    numbered_list_item: {
      rich_text: [
        rich("site", "https://example.test/right"),
        rich(" and ", null),
        rich("exact code", null, true),
      ],
    },
  }
  assert.equal(planOrderedListStart(page, live, wanted, [linked])?.block_id, "first")
  for (const bad of [
    rich("site", "https://example.test/wrong"),
    rich("site", "http://example.test/right"),
    rich("site", null),
  ]) {
    assert.equal(
      planOrderedListStart(page, live, wanted, [
        {
          ...linked,
          numbered_list_item: { rich_text: [bad, ...linked.numbered_list_item.rich_text.slice(1)] },
        },
      ]),
      undefined,
    )
  }
  for (const bad of [rich("exact code", null, false), rich("exact  code", null, true)]) {
    assert.equal(
      planOrderedListStart(page, live, wanted, [
        {
          ...linked,
          numbered_list_item: {
            rich_text: [...linked.numbered_list_item.rich_text.slice(0, 2), bad],
          },
        },
      ]),
      undefined,
    )
  }
})

test("a bare-host autolink keeps its exact physical identity across endpoint serialization", () => {
  const rich = (text: string, link: string | null) => ({
    type: "text",
    plain_text: text,
    text: { content: text, link: link === null ? null : { url: link } },
    annotations: { bold: false, code: false },
  })
  const linked = (href: string) => ({
    ...item("linked", "unused", "paragraph"),
    paragraph: {
      rich_text: [rich("Read ", null), rich("SKILL.md", href), rich(".", null)],
    },
  })
  const live = "Read [SKILL.md](http://SKILL.md).\n\n" + actual
  const wanted = "Read SKILL.md.\n\n" + target
  for (const href of ["http://skill.md/", "http://skill.md", "http://SKILL.md/"]) {
    const plan = planOrderedListStart(page, live, wanted, [linked(href), ...roots])
    assert.equal(plan?.block_id, "first")
    assert.equal(sameNotionMarkdown(live, wanted), false)
    assert.equal(sameNotionMarkdown(plan!.corrected_markdown, wanted), true)
  }
  for (const href of [
    "https://skill.md/",
    "http://other.md/",
    "http://skill.md:80/",
    "http://skill.md:8080/",
    "http://skill.md/path",
    "http://skill.md/?q=1",
    "http://skill.md/#part",
    "http://user@skill.md/",
  ]) {
    assert.equal(planOrderedListStart(page, live, wanted, [linked(href), ...roots]), undefined)
  }
  assert.equal(
    planOrderedListStart(page, live.replace("Read ", "Changed "), wanted, [
      linked("http://skill.md/"),
      ...roots,
    ]),
    undefined,
  )
})
