import assert from "node:assert/strict"
import { test } from "node:test"
import {
  codeLanguage,
  fromNotionMarkdown,
  markdownStructure,
  notionMarkdownForComparison,
  sameMarkdownStructure,
  sameNotionMarkdown,
  type NotionBlockBoundary,
} from "../src/index.ts"

const compare = (actual: string, target: string, blocks?: readonly NotionBlockBoundary[]) => {
  const candidate = notionMarkdownForComparison(actual, target, blocks)
  return (
    sameNotionMarkdown(actual, target) ||
    (candidate !== undefined && sameNotionMarkdown(candidate, target))
  )
}
const paragraph = (id: string, text: string): NotionBlockBoundary => ({
  id,
  type: "paragraph",
  has_children: false,
  text,
})
const sentinel = (id: string, type: string): NotionBlockBoundary => ({
  id,
  type,
  has_children: false,
})
const clone = <T>(value: T): T => structuredClone(value)

test("JSX uses the known JavaScript code language without changing unknown labels or code", () => {
  assert.equal(codeLanguage("jsx"), "javascript")
  assert.equal(codeLanguage(" JSX "), "javascript")
  assert.equal(codeLanguage("unknown-language"), "unknown-language")
  assert.equal(
    sameNotionMarkdown(
      "```javascript\nconst item = <View />\n```",
      "```jsx\nconst item = <View />\n```",
    ),
    true,
  )
  assert.equal(
    sameNotionMarkdown(
      "```javascript\nconst item = <Other />\n```",
      "```jsx\nconst item = <View />\n```",
    ),
    false,
  )
  assert.equal(
    sameNotionMarkdown(
      "```text\nconst item = <View />\n```",
      "```unknown-language\nconst item = <View />\n```",
    ),
    false,
  )
})

const commentTarget =
  "Before text.\n\n<!-- independent note -->\n```markdown\nkeep this code\n```\n\nAfter text."
const commentActual =
  "Before text.\n\\<!-- independent note --\\>\n```markdown\nkeep this code\n```\nAfter text."
const commentBlocks = [
  paragraph("before", "Before text."),
  paragraph("comment", "<!-- independent note -->"),
  sentinel("code", "code"),
  paragraph("after", "After text."),
]

test("standalone HTML comments require an authored HTML target and adjacent root evidence", () => {
  assert.equal(sameNotionMarkdown(commentActual, commentTarget), false)
  assert.equal(compare(commentActual, commentTarget, commentBlocks), true)
  const candidate = notionMarkdownForComparison(commentActual, commentTarget, commentBlocks)!
  assert.equal(
    sameMarkdownStructure(markdownStructure(candidate), markdownStructure(commentTarget)),
    true,
  )
  assert.equal(
    fromNotionMarkdown(commentActual, commentBlocks).includes("\\<!-- independent note --\\>"),
    true,
  )
  assert.equal(compare(commentActual, commentTarget), false)
  assert.equal(compare(commentActual, commentTarget, []), false)
})

test("comment proof preserves exact words, preceding prose, code and later content", () => {
  for (const [before, after] of [
    ["independent note", "different note"],
    ["Before text.", "Different text."],
    ["keep this code", "change this code"],
    ["After text.", "Other text."],
  ] as const)
    assert.equal(compare(commentActual.replace(before, after), commentTarget, commentBlocks), false)
  const literalTarget = commentTarget.replace(
    "<!-- independent note -->",
    "\\<!-- independent note --\\>",
  )
  assert.equal(notionMarkdownForComparison(commentActual, literalTarget, commentBlocks), undefined)
  assert.equal(compare(commentActual, literalTarget, commentBlocks), true)
  assert.equal(compare(commentTarget, literalTarget, commentBlocks), false)
  for (const target of [
    commentTarget.replace("<!-- independent note -->", "`<!-- independent note -->`"),
    commentTarget.replace("<!-- independent note -->", "<!-- different note -->"),
    commentTarget.replace(
      "Before text.\n\n<!-- independent note -->",
      "Before text. <!-- independent note -->",
    ),
  ])
    assert.equal(compare(commentActual, target, commentBlocks), false, target)
  const codeActual = "Before text.\n\n```text\n\\<!-- independent note --\\>\n```"
  assert.equal(
    compare(codeActual, "Before text.\n\n<!-- independent note -->\n```text\n```", commentBlocks),
    false,
  )
})

test("comment proof refuses missing, foreign, reordered, duplicated or nested root evidence", () => {
  const variants: NotionBlockBoundary[][] = [
    commentBlocks.slice(1),
    [commentBlocks[0]!, commentBlocks[2]!, commentBlocks[1]!, commentBlocks[3]!],
    [
      commentBlocks[0]!,
      { ...commentBlocks[1]!, text: "<!-- foreign -->" },
      ...commentBlocks.slice(2),
    ],
    [commentBlocks[0]!, { ...commentBlocks[1]!, has_children: true }, ...commentBlocks.slice(2)],
    [commentBlocks[0]!, commentBlocks[1]!, sentinel("code", "quote"), commentBlocks[3]!],
    [commentBlocks[0]!, { ...commentBlocks[1]!, id: "before" }, ...commentBlocks.slice(2)],
    [
      ...commentBlocks,
      ...commentBlocks.map((block) => ({ ...block, id: `duplicate-${block.id}` })),
    ],
  ]
  for (const blocks of variants) assert.equal(compare(commentActual, commentTarget, blocks), false)
  const twice = `${commentActual}\n\n${commentActual}`
  assert.equal(compare(twice, `${commentTarget}\n\n${commentTarget}`, commentBlocks), false)
})

const setextTarget =
  "---\nname: example\ndescription: An exact description\n---\n\n# Heading\n\nBody text."
const setextRaw =
  "---\nname: example<br>description: An exact description\n---\n# Heading\nBody text."
const setextBlocks = [
  paragraph("unrelated", "A known prefix removed before comparison."),
  sentinel("first", "divider"),
  paragraph("body", "name: example\ndescription: An exact description"),
  sentinel("last", "divider"),
  sentinel("heading", "heading_1"),
  paragraph("tail", "Body text."),
]
const setextActual = fromNotionMarkdown(setextRaw, setextBlocks)

test("a leading multiline setext heading requires its exact divider paragraph divider proof", () => {
  assert.equal(sameNotionMarkdown(setextActual, setextTarget), false)
  assert.equal(compare(setextActual, setextTarget, setextBlocks), true)
  assert.equal(compare(setextActual, setextTarget), false)
  assert.equal(compare(setextActual, setextTarget, []), false)
  assert.equal(fromNotionMarkdown(setextActual, setextBlocks).includes("<br>"), true)
  // Earlier sentinels need no particular text or application-specific meaning.
  assert.equal(
    compare(setextActual, setextTarget, [
      { ...setextBlocks[0]!, text: "unrelated text" },
      ...setextBlocks.slice(1),
    ]),
    true,
  )
})

test("setext proof cannot borrow a foreign paragraph, line order, delimiter or later content", () => {
  for (const actual of [
    setextActual.replace("exact description", "other description"),
    setextActual.replace(
      "name: example<br>description: An exact description",
      "description: An exact description<br>name: example",
    ),
    setextActual.replace("<br>", " "),
    setextActual.replace("\n---\n\n# Heading", "\n***\n\n# Heading"),
    setextActual.replace("Body text.", "Different text."),
    `Extra text.\n\n${setextActual}`,
  ])
    assert.equal(compare(actual, setextTarget, setextBlocks), false, actual)
  const variants = [
    setextBlocks.filter((block) => block.id !== "first"),
    setextBlocks.map((block) => (block.id === "body" ? { ...block, text: "foreign" } : block)),
    setextBlocks.map((block) => (block.id === "body" ? { ...block, has_children: true } : block)),
    setextBlocks.map((block) => (block.id === "last" ? { ...block, type: "paragraph" } : block)),
    [
      ...setextBlocks,
      ...setextBlocks.slice(1, 4).map((block) => ({ ...block, id: `duplicate-${block.id}` })),
    ],
  ]
  for (const blocks of variants) assert.equal(compare(setextActual, setextTarget, blocks), false)
  assert.equal(
    compare(setextActual, setextTarget.replace("\n---\n\n#", "\n\\---\n\n#"), setextBlocks),
    false,
  )
  assert.equal(
    compare(
      `\`\`\`text\n${setextActual}\n\`\`\``,
      `\`\`\`text\n${setextTarget}\n\`\`\``,
      setextBlocks,
    ),
    false,
  )
})

const boldActual = "[EXAMPLE.md](http://EXAMPLE.md)** supports**: The exact suffix."
const boldTarget = "**EXAMPLE.md supports**: The exact suffix."
const boldBlocks: NotionBlockBoundary[] = [
  {
    id: "bold",
    type: "paragraph",
    has_children: false,
    rich_text: [
      { text: "EXAMPLE.md", link: "http://example.md/", bold: true, code: false },
      { text: " supports", link: null, bold: true, code: false },
      { text: ": The exact suffix.", link: null, bold: false, code: false },
    ],
  },
]

test("a split bold suffix is repaired only from target strong syntax and ordered rich text", () => {
  assert.equal(sameNotionMarkdown(boldActual, boldTarget), false)
  assert.equal(compare(boldActual, boldTarget, boldBlocks), true)
  assert.equal(
    compare(boldActual.replace("[EXAMPLE.md]", "[**EXAMPLE.md**]"), boldTarget, boldBlocks),
    true,
  )
  assert.equal(compare(boldActual, boldTarget), false)
  assert.equal(fromNotionMarkdown(boldActual, boldBlocks), boldActual)
  assert.equal(
    notionMarkdownForComparison(boldActual, boldTarget, boldBlocks),
    "[EXAMPLE.md](http://EXAMPLE.md) supports: The exact suffix.",
  )
  assert.equal(compare(boldActual, "EXAMPLE.md supports: The exact suffix.", boldBlocks), false)
  assert.equal(
    compare(boldActual, "EXAMPLE.md\\*\\* supports\\*\\*: The exact suffix.", boldBlocks),
    true,
  )
})

test("split bold proof preserves URLs, words, literal markers and inline or fenced code", () => {
  for (const actual of [
    boldActual.replace("http://EXAMPLE.md", "https://EXAMPLE.md"),
    boldActual.replace("http://EXAMPLE.md", "http://different.test"),
    boldActual.replace("supports", "replaces"),
    boldActual.replace("exact suffix", "changed suffix"),
    boldActual.replace("** supports**", "\\*\\* supports\\*\\*"),
    `\`${boldActual}\``,
    `\`\`\`text\n${boldActual}\n\`\`\``,
  ])
    assert.equal(compare(actual, boldTarget, boldBlocks), false)
  assert.equal(compare(boldActual, boldTarget.replace("supports", "replaces"), boldBlocks), false)
  assert.equal(
    compare(boldActual, "[EXAMPLE.md](https://EXAMPLE.md) supports: The exact suffix.", boldBlocks),
    false,
  )
})

test("split bold proof refuses missing, changed, reordered or duplicate annotations", () => {
  const changes = [
    (blocks: NotionBlockBoundary[]) => [{ ...blocks[0]!, rich_text: undefined }],
    (blocks: NotionBlockBoundary[]) => [{ ...blocks[0]!, has_children: true }],
    (blocks: NotionBlockBoundary[]) => [
      {
        ...blocks[0]!,
        rich_text: blocks[0]!.rich_text!.map((span, index) =>
          index === 1 ? { ...span, bold: false } : span,
        ),
      },
    ],
    (blocks: NotionBlockBoundary[]) => [
      {
        ...blocks[0]!,
        rich_text: blocks[0]!.rich_text!.map((span, index) =>
          index === 1 ? { ...span, code: true } : span,
        ),
      },
    ],
    (blocks: NotionBlockBoundary[]) => [
      {
        ...blocks[0]!,
        rich_text: blocks[0]!.rich_text!.map((span, index) =>
          index === 0 ? { ...span, link: "http://other.test" } : span,
        ),
      },
    ],
    (blocks: NotionBlockBoundary[]) => [
      { ...blocks[0]!, rich_text: [...blocks[0]!.rich_text!].reverse() },
    ],
    (blocks: NotionBlockBoundary[]) => [...blocks, { ...blocks[0]!, id: "duplicate" }],
  ]
  for (const change of changes)
    assert.equal(compare(boldActual, boldTarget, change(clone(boldBlocks))), false)
})

test("a literal-star paragraph cannot borrow a later identical bold paragraph's annotations", () => {
  const actual = `${boldActual}\n\n**[EXAMPLE.md](http://EXAMPLE.md) supports**: The exact suffix.`
  const target = `${boldTarget}\n\n${boldTarget}`
  const literal: NotionBlockBoundary = {
    id: "literal",
    type: "paragraph",
    has_children: false,
    rich_text: [
      { text: "EXAMPLE.md", link: "http://example.md/", bold: false, code: false },
      { text: "** supports**: The exact suffix.", link: null, bold: false, code: false },
    ],
  }
  assert.equal(sameNotionMarkdown(actual, target), false)
  assert.equal(notionMarkdownForComparison(actual, target, [literal, ...boldBlocks]), undefined)
  assert.equal(compare(actual, target, [literal, ...boldBlocks]), false)
})

test("all known root positions must be monotonic outside the repair triple", () => {
  const wrongCommentOrder = [commentBlocks[3]!, ...commentBlocks.slice(0, 3)]
  assert.equal(compare(commentActual, commentTarget, wrongCommentOrder), false)
  const wrongSetextOrder = [setextBlocks[0]!, ...setextBlocks.slice(4), ...setextBlocks.slice(1, 4)]
  assert.equal(compare(setextActual, setextTarget, wrongSetextOrder), false)
})

test("an unlocated intervening sibling cannot establish the candidate's position", () => {
  const actual = `# Before\n\n${boldActual}\n\n# After`
  const target = `# Before\n\n${boldTarget}\n\n# After`
  const blocks = [sentinel("before", "heading_1"), ...boldBlocks, sentinel("after", "heading_1")]
  assert.equal(compare(actual, target, blocks), true)
  const interrupted = [blocks[0]!, sentinel("unknown", "unsupported"), ...blocks.slice(1)]
  assert.equal(compare(actual, target, interrupted), false)
  const unknownBefore = [sentinel("unknown", "unsupported"), ...boldBlocks, blocks.at(-1)!]
  assert.equal(compare(actual, target, unknownBefore), false)
})

test("a document-start exception accepts only known absent leaf paragraphs", () => {
  const absent = paragraph("omitted", "A known prefix removed before comparison.")
  assert.equal(compare(boldActual, boldTarget, [absent, ...boldBlocks]), true)
  for (const first of [
    sentinel("unknown", "paragraph"),
    paragraph("empty", ""),
    { ...absent, has_children: true },
    { ...absent, text: "** supports**" },
    { ...absent, rich_text: [{ text: "** supports**", link: null, bold: false, code: false }] },
  ])
    assert.equal(compare(boldActual, boldTarget, [first, ...boldBlocks]), false)
})

test("combined repairs use original source offsets without authorizing a later literal-star mismatch", () => {
  const actual = [setextRaw, commentActual, boldActual].join("\n\n")
  const target = [setextTarget, commentTarget, boldTarget].join("\n\n")
  const blocks = [...setextBlocks, ...commentBlocks, ...boldBlocks]
  assert.equal(sameNotionMarkdown(actual, target), false)
  assert.equal(compare(actual, target, blocks), true)
  const duplicate = `${actual}\n\n**[EXAMPLE.md](http://EXAMPLE.md) supports**: The exact suffix.`
  const doubledTarget = `${target}\n\n${boldTarget}`
  const literal: NotionBlockBoundary = {
    id: "literal",
    type: "paragraph",
    has_children: false,
    rich_text: [
      { text: "EXAMPLE.md", link: "http://example.md/", bold: false, code: false },
      { text: "** supports**: The exact suffix.", link: null, bold: false, code: false },
    ],
  }
  const wrong = [...setextBlocks, ...commentBlocks, literal, ...boldBlocks]
  const candidate = notionMarkdownForComparison(duplicate, doubledTarget, wrong)
  assert.equal(typeof candidate, "string")
  assert.ok(candidate!.includes(boldActual))
  assert.equal(compare(duplicate, doubledTarget, wrong), false)
})

test("evidence repairs preserve explicit external destinations at their AST positions", () => {
  const target = `${commentTarget}\n\n[site](https://example.test/x) [site](http://example.test/x)`
  const actual = `${commentActual}\n[site](https://example.test/x) [site](http://example.test/x)`
  assert.equal(compare(actual, target, commentBlocks), true)
  assert.equal(
    compare(
      actual.replace("https://example.test/x", "http://example.test/x"),
      target,
      commentBlocks,
    ),
    false,
  )
  assert.equal(
    compare(
      actual.replace("https://example.test/x", "https://example.test/other"),
      target,
      commentBlocks,
    ),
    false,
  )
  assert.equal(
    compare(
      actual.replace("[site](https://example.test/x)", "[other](https://example.test/x)"),
      target,
      commentBlocks,
    ),
    false,
  )
})
