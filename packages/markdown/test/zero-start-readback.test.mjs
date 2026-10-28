import { test } from "node:test"
import assert from "node:assert/strict"
import {
  zeroStartPresentation,
  notionMarkdownForComparison,
  markdownStructure,
  sameMarkdownStructure,
} from "../src/index.ts"

const source =
  "# Steps\n\nBefore stays exact.\n\n0. **First.** Keep `x  y` exact.\n1. Visit [docs](https://example.com/a?q=1#two).\n\nTail stays exact.\n"
const plan = zeroStartPresentation(source)
assert.ok(plan)
const span = (text) => ({ text, link: null, bold: false, code: false })

function evidence() {
  return {
    actual: plan.wire.replace(/\n\n/g, "\n").trimEnd(),
    roots: [
      {
        id: "heading",
        type: "heading_1",
        has_children: false,
        text: "Steps",
        rich_text: [span("Steps")],
      },
      {
        id: "before",
        type: "paragraph",
        has_children: false,
        text: "Before stays exact.",
        rich_text: [span("Before stays exact.")],
      },
      ...plan.items.map((item, index) => ({
        id: "zero-" + index,
        type: "paragraph",
        has_children: false,
        rich_text: structuredClone(item.spans),
      })),
      {
        id: "tail",
        type: "paragraph",
        has_children: false,
        text: "Tail stays exact.",
        rich_text: [span("Tail stays exact.")],
      },
    ],
  }
}

for (const escaped of [true, false]) {
  test(
    "single-LF numeric paragraphs prove the complete source and wire; escaped=" + escaped,
    () => {
      const f = evidence()
      if (!escaped) f.actual = f.actual.replace(/^(\d+)\\\. /gm, "$1. ")
      assert.equal(notionMarkdownForComparison(f.actual, source, f.roots), source)
      const wire = notionMarkdownForComparison(f.actual, plan.wire, f.roots)
      assert.equal(typeof wire, "string")
      assert.deepEqual(markdownStructure(wire), markdownStructure(plan.wire))
    },
  )
}

test("single-LF framing requires the unique complete flat paragraph layout", () => {
  const changes = [
    [
      "native list",
      (f) => {
        f.roots[2].type = "numbered_list_item"
      },
    ],
    [
      "duplicate id",
      (f) => {
        f.roots[2].id = f.roots[3].id
      },
    ],
    [
      "missing id",
      (f) => {
        delete f.roots[2].id
      },
    ],
    [
      "nested content",
      (f) => {
        f.roots[2].has_children = true
      },
    ],
    [
      "extra root",
      (f) => {
        f.roots.push({ ...f.roots[4], id: "copy" })
      },
    ],
    [
      "moved group",
      (f) => {
        ;[f.roots[1], f.roots[2]] = [f.roots[2], f.roots[1]]
      },
    ],
  ]
  for (const [label, mutate] of changes) {
    const f = evidence()
    mutate(f)
    assert.equal(notionMarkdownForComparison(f.actual, source, f.roots), undefined, label)
  }
})

test("all paragraph text, digits, bold, code spaces and URL destinations remain exact", () => {
  const changes = [
    [
      "digit",
      (f) => {
        f.roots[2].rich_text[0].text = "1. "
      },
    ],
    [
      "bold",
      (f) => {
        f.roots[2].rich_text[1].bold = false
      },
    ],
    [
      "code spaces",
      (f) => {
        f.roots[2].rich_text.find((x) => x.code).text = "x y"
      },
    ],
    [
      "link destination",
      (f) => {
        f.roots[3].rich_text.find((x) => x.link).link = "https://example.com/other"
      },
    ],
    [
      "ordinary paragraph",
      (f) => {
        f.roots[1].rich_text[0].text = "Changed before."
      },
    ],
  ]
  for (const [label, mutate] of changes) {
    const f = evidence()
    mutate(f)
    assert.equal(notionMarkdownForComparison(f.actual, source, f.roots), undefined, label)
  }
})

test("changed Markdown and copied, nested or fenced numeric text cannot borrow physical evidence", () => {
  const changes = [
    [
      "tail text",
      (f) => {
        f.actual = f.actual.replace("Tail stays exact.", "Changed tail.")
      },
    ],
    [
      "URL query",
      (f) => {
        f.actual = f.actual.replace("q=1#two", "q=2#two")
      },
    ],
    [
      "heading level",
      (f) => {
        f.actual = f.actual.replace("# Steps", "## Steps")
      },
    ],
    [
      "duplicate group",
      (f) => {
        f.actual += "\n" + plan.items.map((x) => x.wire).join("\n")
      },
    ],
    [
      "indented code",
      (f) => {
        f.actual = f.actual.replace(/^([01]\\\.)/gm, "    $1")
      },
    ],
    [
      "fenced code",
      (f) => {
        f.actual = "```text\n" + f.actual + "\n```"
      },
    ],
  ]
  for (const [label, mutate] of changes) {
    const f = evidence()
    mutate(f)
    assert.notEqual(notionMarkdownForComparison(f.actual, source, f.roots), source, label)
  }
})

// Reduced from the acknowledged maintain replacement: the ordinary paragraph
// gained an autolink while the zero-start items remained physical paragraphs.
const maintainParagraph =
  "Only edit the verification skill's own directory (its SKILL.md, features/, and any harness scripts it owns). Never edit product code during a run: a behavior the map describes that the app no longer does is either doc drift (fix the map) or a product regression (report it, don't paper over it in docs)."
const maintainSource = [
  "## Edit scope",
  "",
  maintainParagraph,
  "",
  "## Pass",
  "",
  "0. **Locate the target.** Find the verification skill to maintain: the project-local skill whose body has launch/drive sections and a feature map (usually `.cursor/skills/verify-*/`). Several candidates → ask which one; none → stop and point at `/create-verification-skill` instead of inventing a target.",
  "1. **Index hygiene.** Read the feature map README and glob its sibling files. Fix missing, extra, duplicate, or dead entries. Lightweight; no generated inventory.",
  "",
].join("\n")
const maintainPlan = zeroStartPresentation(maintainSource)
assert.ok(maintainPlan)

function maintainEvidence(
  markdownUrl = "http://SKILL.md",
  physicalUrl = "http://skill.md/",
  compact = true,
) {
  const [before, after] = maintainParagraph.split("SKILL.md")
  let actual = maintainPlan.wire.replace(
    maintainParagraph,
    `${before}[SKILL.md](${markdownUrl})${after}`,
  )
  if (compact)
    actual = actual
      .replace(/\n\n/g, "\n")
      .replace(/^(\d+)\\\. /gm, "$1. ")
      .trimEnd()
  return {
    actual,
    roots: [
      {
        id: "scope-heading",
        type: "heading_2",
        has_children: false,
        rich_text: [span("Edit scope")],
      },
      {
        id: "scope",
        type: "paragraph",
        has_children: false,
        rich_text: [span(before), { ...span("SKILL.md"), link: physicalUrl }, span(after)],
      },
      { id: "pass-heading", type: "heading_2", has_children: false, rich_text: [span("Pass")] },
      ...maintainPlan.items.map((item, index) => ({
        id: "maintain-zero-" + index,
        type: "paragraph",
        has_children: false,
        rich_text: structuredClone(item.spans),
      })),
    ],
  }
}

for (const compact of [true, false]) {
  test(
    "maintain autolink serialization preserves the complete zero-start source; compact=" + compact,
    () => {
      const f = maintainEvidence("http://SKILL.md", "http://skill.md/", compact)
      const before = structuredClone(f)
      assert.equal(notionMarkdownForComparison(f.actual, maintainSource, f.roots), maintainSource)
      const comparedWire =
        notionMarkdownForComparison(f.actual, maintainPlan.wire, f.roots) ?? f.actual
      assert.equal(
        sameMarkdownStructure(
          markdownStructure(comparedWire),
          markdownStructure(maintainPlan.wire),
        ),
        true,
      )
      assert.deepEqual(f, before)
    },
  )
}

test("physical autolinks cannot change scheme, ports, paths, queries, fragments or credentials", () => {
  for (const physicalUrl of [
    "https://skill.md/",
    "http://skill.md:80",
    "http://skill.md/a",
    "http://skill.md/a/..",
    "http://skill.md/?q=1",
    "http://skill.md/#part",
    "http://user@skill.md/",
  ]) {
    const f = maintainEvidence("http://SKILL.md", physicalUrl)
    assert.equal(
      notionMarkdownForComparison(f.actual, maintainSource, f.roots),
      undefined,
      physicalUrl,
    )
  }
})

test("matching physical and Markdown URLs cannot conceal a non-root autolink destination", () => {
  for (const url of [
    "http://SKILL.md:80",
    "https://SKILL.md:443",
    "http://SKILL.md/a/..",
    "http://SKILL.md/?q=1",
  ]) {
    const f = maintainEvidence(url, url)
    assert.equal(notionMarkdownForComparison(f.actual, maintainSource, f.roots), undefined, url)
  }
})

test("an authored explicit link retains its exact destination during zero-start comparison", () => {
  for (const destination of ["http://skill.md", "http://SKILL.md/", "https://SKILL.md"]) {
    const target = maintainSource.replace("SKILL.md", `[SKILL.md](${destination})`)
    const f = maintainEvidence()
    assert.equal(
      sameMarkdownStructure(
        markdownStructure(`[SKILL.md](http://SKILL.md)`),
        markdownStructure(`[SKILL.md](${destination})`),
      ),
      false,
      destination,
    )
    assert.equal(notionMarkdownForComparison(f.actual, target, f.roots), undefined, destination)
  }
})
