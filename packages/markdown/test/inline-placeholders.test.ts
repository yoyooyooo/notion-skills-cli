import assert from "node:assert/strict"
import { test } from "node:test"
import * as candidate from "../src/index.ts"
import type { NotionBlockBoundary, NotionTextSpan } from "../src/index.ts"

const url = "https://example.test/exact?key=one#section"
const span = (text: string, extra: Partial<NotionTextSpan> = {}): NotionTextSpan => ({
  text,
  link: null,
  bold: false,
  code: false,
  ...extra,
})
const paragraph = (id: string, rich_text: readonly NotionTextSpan[]): NotionBlockBoundary => ({
  id,
  type: "paragraph",
  has_children: false,
  rich_text,
})
const fixture = (): { target: string; actual: string; roots: NotionBlockBoundary[] } => ({
  target: `# Start\n\nUse **the exact task** with task-<input> before continuing.\nDone\n\n- Next step.\n\n## Other\n\nAnother task-<input> is shown in \`literal code\` here.\n\n## Links\n\n[docs](${url})`,
  actual: `# Start\nUse **the exact task** with task-\\<input\\> before continuing.\nDone\n- Next step.\n\n## Other\nAnother task-<input> is shown in \`literal code\` here.\n\n## Links\n[docs](${url})`,
  roots: [
    { id: "start", type: "heading_1", has_children: false },
    paragraph("first", [
      span("Use "),
      span("the exact task", { bold: true }),
      span(" with task-<input> before continuing."),
    ]),
    paragraph("second", [span("Done")]),
    {
      id: "next",
      type: "bulleted_list_item",
      has_children: false,
      rich_text: [span("Next step.")],
    },
    { id: "other", type: "heading_2", has_children: false },
    paragraph("other-body", [
      span("Another task-<input> is shown in "),
      span("literal code", { code: true }),
      span(" here."),
    ]),
    { id: "links", type: "heading_2", has_children: false },
    paragraph("docs", [span("docs", { link: url })]),
  ] satisfies NotionBlockBoundary[],
})
type Fixture = ReturnType<typeof fixture>
const proof = (f: Fixture) => candidate.notionMarkdownForComparison(f.actual, f.target, f.roots)
const full = (f: Fixture) => {
  const value = proof(f)
  return value !== undefined && candidate.sameNotionMarkdown(value, f.target)
}
const replaceLiteral = (f: Fixture, literal: string) => {
  f.target = f.target.replace("task-<input> before", `task-${literal} before`)
  f.actual = f.actual.replace("task-\\<input\\> before", `task-\\${literal.slice(0, -1)}\\> before`)
  f.roots[1] = paragraph("first", [
    span("Use "),
    span("the exact task", { bold: true }),
    span(` with task-${literal} before continuing.`),
  ])
}

test("a word-local placeholder needs the exact two original paragraphs and changes only its two escapes", () => {
  const f = fixture(),
    before = JSON.stringify(f)
  assert.equal(candidate.sameNotionMarkdown(f.actual, f.target), false)
  const value = proof(f)
  assert.equal(
    value,
    candidate.fromNotionMarkdown(f.actual, f.roots).replace("task-\\<input\\>", "task-<input>"),
  )
  assert.equal(full(f), true)
  assert.equal(JSON.stringify(f), before)
  assert.equal(value?.includes(url), true)
  assert.equal(value?.includes("`literal code`"), true)
})

test("missing or incomplete original rich text, a one-root substitute, and an empty second paragraph provide no proof", () => {
  const variants: Array<(f: Fixture) => void> = [
    (f) => {
      f.roots.splice(2, 1)
    },
    (f) => {
      f.roots[1] = {
        id: "first",
        type: "paragraph",
        has_children: false,
        text: "Use the exact task with task-<input> before continuing.",
      }
    },
    (f) => {
      f.roots[2] = paragraph("second", [])
    },
    (f) => {
      f.roots[1] = paragraph("first", [
        span("Use the exact task with task-<input> before continuing. Done"),
      ])
      f.roots.splice(2, 1)
    },
  ]
  for (const change of variants) {
    const f = fixture()
    change(f)
    assert.equal(proof(f), undefined)
  }
  const f = fixture()
  assert.equal(candidate.notionMarkdownForComparison(f.actual, f.target), undefined)
})

test("the candidate never borrows code, links, or child-bearing paragraph evidence", () => {
  for (const index of [1, 2])
    for (const change of ["code", "link", "child"]) {
      const f = fixture(),
        root = f.roots[index]!
      f.roots[index] =
        change === "child"
          ? { ...root, has_children: true }
          : paragraph(
              root.id,
              root.rich_text!.map((item) => ({
                ...item,
                ...(change === "code" ? { code: true } : { link: url }),
              })),
            )
      assert.equal(proof(f), undefined)
    }
})

test("full root content, identity, ordering, adjacency and neighboring sentinels are required", () => {
  const variants: Array<(f: Fixture) => void> = [
    (f) => {
      f.roots[2] = paragraph("second", [span("Else")])
    },
    (f) => {
      f.roots[1] = { ...f.roots[1]!, id: "second" }
    },
    (f) => {
      ;[f.roots[1], f.roots[2]] = [f.roots[2]!, f.roots[1]!]
    },
    (f) => {
      f.roots.splice(2, 0, paragraph("interloper", [span("Other")]))
    },
    (f) => {
      f.roots[0] = { ...f.roots[0]!, type: "unknown" }
    },
    (f) => {
      f.roots[3] = { ...f.roots[3]!, type: "unknown" }
    },
    (f) => {
      f.roots.push(...f.roots.slice(1, 3).map((root) => ({ ...root, id: `copy-${root.id}` })))
    },
  ]
  for (const change of variants) {
    const f = fixture()
    change(f)
    assert.equal(proof(f), undefined)
  }
})

test("ordinary HTML, attributes, closing tags, declarations and non-word-local forms stay strict", () => {
  for (const literal of [
    '<input value="one">',
    "</input>",
    "<!-- input -->",
    "<input/>",
    "<input-name>",
  ]) {
    const f = fixture()
    replaceLiteral(f, literal)
    assert.equal(proof(f), undefined, literal)
  }
  for (const context of ["task ", "task", "", "task-"]) {
    const f = fixture()
    f.target = f.target.replace(
      "task-<input> before",
      `${context}<input>${context === "task-" ? ".before" : " before"}`,
    )
    f.actual = f.actual.replace(
      "task-\\<input\\> before",
      `${context}\\<input\\>${context === "task-" ? ".before" : " before"}`,
    )
    f.roots[1] = paragraph("first", [
      span(
        `Use the exact task with ${context}<input>${context === "task-" ? ".before" : " before"} continuing.`,
      ),
    ])
    assert.equal(proof(f), undefined)
  }
  for (const closing of ["</input>", "</INPUT >", "</input\n>"]) {
    const f = fixture()
    f.target += `\n\n${closing}`
    assert.equal(proof(f), undefined)
  }
})

test("source escapes, nested markup, a second HTML token, and nonexact readback escape spelling do not trigger the rule", () => {
  for (const change of [
    (f: Fixture) => {
      f.target = f.target.replace("task-<input> before", "task-\\<input\\> before")
    },
    (f: Fixture) => {
      f.target = f.target.replace("task-<input> before", "**task-<input> before**")
    },
    (f: Fixture) => {
      f.target = f.target.replace("task-<input> before", "task-<input> <br>before")
    },
    (f: Fixture) => {
      f.actual = f.actual.replace("task-\\<input\\>", "task-<input\\>")
    },
    (f: Fixture) => {
      f.actual = f.actual.replace("task-\\<input\\>", "task-\\<input>")
    },
    (f: Fixture) => {
      f.actual = f.actual.replace("task-\\<input\\>", "task-\\\\<input\\\\>")
    },
  ]) {
    const f = fixture()
    change(f)
    assert.equal(proof(f), undefined)
  }
})

test("duplicate source or readback paragraphs and a foreign equal-looking pair cannot prove the location", () => {
  const f = fixture(),
    source = "Use **the exact task** with task-<input> before continuing.\nDone"
  const raw = source.replace("<input>", "\\<input\\>")
  f.target += `\n\n## Copy\n\n${source}`
  f.actual += `\n\n## Copy\n${raw}`
  f.roots.push(
    { id: "copy", type: "heading_2", has_children: false },
    ...f.roots.slice(1, 3).map((root) => ({ ...root, id: `copy-${root.id}` })),
  )
  assert.equal(proof(f), undefined)
  const moved = fixture()
  moved.roots[1] = paragraph("first", [span("A different original paragraph.")])
  moved.roots.splice(
    6,
    0,
    ...fixture()
      .roots.slice(1, 3)
      .map((root) => ({ ...root, id: `moved-${root.id}` })),
  )
  assert.equal(proof(moved), undefined)
})

test("the complete comparison still rejects changed prose, code bytes, explicit URLs and authored literal stars", () => {
  for (const change of [
    (f: Fixture) => {
      f.actual = f.actual.replace("before continuing.", "after continuing.")
    },
    (f: Fixture) => {
      f.target = f.target.replace("Next step.", "Other step.")
    },
    (f: Fixture) => {
      f.actual = f.actual.replace("`literal code`", "`literal  code`")
    },
    ...[
      url.replace("https:", "http:"),
      url.replace("/exact", "/else"),
      url.replace("one", "two"),
      url.replace("#section", "#other"),
    ].map((changed) => (f: Fixture) => {
      f.actual = f.actual.replace(url, changed)
    }),
    (f: Fixture) => {
      f.roots[1] = paragraph("first", [
        span("Use *the exact task* with task-<input> before continuing."),
      ])
    },
  ]) {
    const f = fixture()
    change(f)
    assert.equal(full(f), false)
  }
})

test("ordinary conversion and sameNotionMarkdown remain independent of this evidence-directed candidate", () => {
  const f = fixture()
  const normalized = candidate.fromNotionMarkdown(f.actual, f.roots)
  assert.equal(normalized.includes("task-\\<input\\>"), true)
  assert.equal(candidate.sameNotionMarkdown(f.actual, f.target), false)
  assert.equal(candidate.sameNotionMarkdown(normalized, f.target), false)
})

const strongFixture = () => {
  const f = fixture()
  f.target = f.target
    .replace("**the exact task**", "the exact task")
    .replace("task-<input> before", "**task-<input>** before")
  f.actual = f.actual
    .replace("**the exact task**", "the exact task")
    .replace("task-\\<input\\> before", "**task-\\<input\\>** before")
    .replace("\nDone\n", "\n**Done**\n")
  f.roots[1] = paragraph("first", [
    span("Use the exact task with "),
    span("task-<input>", { bold: true }),
    span(" before continuing."),
  ])
  f.roots[2] = paragraph("second", [span("Done", { bold: true })])
  return f
}

test("an exact strong word placeholder binds its original bold span and the same readback wrapper", () => {
  const f = strongFixture(),
    before = JSON.stringify(f)
  assert.equal(full(f), true)
  assert.equal(
    proof(f),
    candidate.fromNotionMarkdown(f.actual, f.roots).replace("task-\\<input\\>", "task-<input>"),
  )
  assert.equal(JSON.stringify(f), before)
  const underscore = strongFixture()
  underscore.target = underscore.target.replace("**task-<input>**", "__task-<input>__")
  assert.equal(full(underscore), true)
})

test("strong placeholders refuse missing bold authority, broader wrappers, code, links and closing HTML", () => {
  const variants: Array<(f: Fixture) => void> = [
    (f) => {
      f.roots[1] = paragraph("first", [
        span("Use the exact task with task-<input> before continuing."),
      ])
    },
    (f) => {
      f.roots[1] = paragraph("first", [
        span("Use the exact task with "),
        span("task-<input> before", { bold: true }),
        span(" continuing."),
      ])
    },
    (f) => {
      f.roots[1] = paragraph("first", [
        span("Use the exact task with "),
        span("task-<input>", { bold: true, code: true }),
        span(" before continuing."),
      ])
    },
    (f) => {
      f.roots[1] = paragraph("first", [
        span("Use the exact task with "),
        span("task-<input>", { bold: true, link: url }),
        span(" before continuing."),
      ])
    },
    (f) => {
      f.target = f.target.replace("**task-<input>** before", "**task-<input> before**")
    },
    (f) => {
      f.target = f.target.replace("**task-<input>**", "*task-<input>*")
    },
    (f) => {
      f.actual = f.actual.replace("**task-\\<input\\>**", "task-\\<input\\>")
    },
    (f) => {
      f.actual = f.actual.replace("**task-\\<input\\>**", "*task-\\<input\\>*")
    },
    (f) => {
      f.target += "\n\n</input>"
    },
  ]
  for (const change of variants) {
    const f = strongFixture()
    change(f)
    assert.equal(proof(f), undefined)
  }
})

const adjacentStrongFixture = () => {
  const f = strongFixture()
  f.target = f.target.replace("continuing.\nDone", "continuing.\n\n**Done**")
  return f
}

test("two adjacent authored paragraphs bind separately to the original pair merged in readback", () => {
  const f = adjacentStrongFixture(),
    before = JSON.stringify(f)
  assert.equal(full(f), true)
  assert.equal(
    proof(f),
    candidate.fromNotionMarkdown(f.actual, f.roots).replace("task-\\<input\\>", "task-<input>"),
  )
  assert.equal(JSON.stringify(f), before)
})
