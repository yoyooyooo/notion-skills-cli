import assert from "node:assert/strict"
import { test } from "node:test"
import * as candidate from "../src/index.ts"
import type { NotionBlockBoundary } from "../src/index.ts"

const code = "literal:\n---\nkeep  spaces\n"
const raw = `# Start\nRead [docs](https://example.test/exact).\n---\n## After\n\`\`\`text\n${code}\n\`\`\`\nDone.`
const target = `# Start\n\nRead [docs](https://example.test/exact).\n\n---\n\n## After\n\n\`\`\`text\n${code}\n\`\`\`\n\nDone.`
const roots: NotionBlockBoundary[] = [
  { id: "start", type: "heading_1", has_children: false },
  { id: "paragraph", type: "paragraph", has_children: false, text: "Read docs." },
  { id: "divider", type: "divider", has_children: false },
  { id: "after", type: "heading_2", has_children: false },
  { id: "code", type: "code", has_children: false, code: { language: "text", text: code } },
  { id: "done", type: "paragraph", has_children: false, text: "Done." },
]
const normalized = (markdown = raw, blocks = roots) =>
  candidate.fromNotionMarkdown(markdown, blocks)
const proof = (markdown = raw, source = target, blocks = roots) => ({
  candidate: candidate.notionMarkdownForComparison(markdown, source, blocks),
})
const complete = (markdown: string, source = target, blocks = roots) =>
  candidate.sameNotionMarkdown(candidate.fromNotionMarkdown(markdown, blocks), source)

test("an original paragraph and divider repair one setext collision despite a code-internal rule", () => {
  assert.equal(complete(normalized()), false)
  const result = proof()
  if (result.candidate === undefined) throw new Error("Missing proved divider candidate")
  assert.equal(complete(result.candidate), true)
  assert.ok(result.candidate.includes(code))
  assert.equal(result.candidate.replace(".\n\n---", ".\n---"), normalized())
})

test("a real authored setext heading stays a heading even if another divider exists", () => {
  const source = target.replace("exact).\n\n---", "exact).\n---")
  assert.equal(proof(raw, source).candidate, undefined)
  const actualRoots = roots
    .filter((block) => block.id !== "divider")
    .map((block) => (block.id === "paragraph" ? { ...block, type: "heading_2" } : block))
  assert.equal(proof(raw, target, actualRoots).candidate, undefined)
})

test("a later real divider cannot lend its count to an earlier genuine heading", () => {
  const input = "# Start\nTitle\n---\n## After\nAnother paragraph.\n\n---\nDone.\n```text\n---\n```"
  const source =
    "# Start\n\nTitle\n\n---\n\n## After\n\nAnother paragraph.\n\n---\n\nDone.\n\n```text\n---\n```"
  const blocks: NotionBlockBoundary[] = [
    roots[0]!,
    { id: "real-heading", type: "heading_2", has_children: false },
    roots[3]!,
    { id: "other", type: "paragraph", has_children: false, text: "Another paragraph." },
    roots[2]!,
    roots[5]!,
    { ...roots[4]!, code: { language: "text", text: "---" } },
  ]
  assert.equal(proof(input, source, blocks).candidate, undefined)
})

test("missing, duplicate or child-bearing original roots do not establish the boundary", () => {
  assert.equal(proof(raw, target, []).candidate, undefined)
  assert.equal(
    proof(
      raw,
      target,
      roots.filter((block) => block.id !== "divider"),
    ).candidate,
    undefined,
  )
  assert.equal(
    proof(
      raw,
      target,
      roots.map((block) => ({ ...block, id: "duplicate" })),
    ).candidate,
    undefined,
  )
  assert.equal(
    proof(
      raw,
      target,
      roots.map((block) =>
        block.id === "paragraph" || block.id === "divider"
          ? { ...block, has_children: true }
          : block,
      ),
    ).candidate,
    undefined,
  )
})

test("original paragraph bytes, explicit URL and source paragraph position remain bound", () => {
  assert.equal(
    proof(
      raw,
      target,
      roots.map((block) =>
        block.id === "paragraph" ? { ...block, text: "Different docs." } : block,
      ),
    ).candidate,
    undefined,
  )
  assert.equal(
    proof(raw.replace("https://example.test", "http://example.test")).candidate,
    undefined,
  )
  assert.equal(proof(raw, target.replace("Read [docs]", "Use [docs]")).candidate, undefined)
})

test("a moved or unknown original neighbor cannot prove a nearby pair", () => {
  const moved = [roots[3]!, roots[1]!, roots[2]!, roots[0]!, roots[4]!, roots[5]!]
  assert.equal(proof(raw, target, moved).candidate, undefined)
  assert.equal(
    proof(
      raw,
      target,
      roots.map((block) => (block.id === "after" ? { ...block, type: "unknown" } : block)),
    ).candidate,
    undefined,
  )
})

test("duplicate source or original paragraph-divider pairs remain ambiguous", () => {
  const pair = "Read [docs](https://example.test/exact).\n\n---\n\n"
  assert.equal(proof(raw, target.replace("## After", pair + "## After")).candidate, undefined)
  const more = [
    roots[0]!,
    roots[1]!,
    roots[2]!,
    { ...roots[1]!, id: "repeat-paragraph" },
    { ...roots[2]!, id: "repeat-divider" },
    ...roots.slice(3),
  ]
  assert.equal(proof(raw, target, more).candidate, undefined)
})

test("one original pair cannot authorize two identical readback headings", () => {
  const pair = "Read [docs](https://example.test/exact).\n---\n"
  assert.equal(proof(raw.replace("## After", pair + "## After")).candidate, undefined)
})

test("multiple distinct original paragraph-divider pairs can repair together", () => {
  const input = raw.replace("## After", "## Middle\nSecond paragraph.\n---\n## After")
  const source = target.replace("## After", "## Middle\n\nSecond paragraph.\n\n---\n\n## After")
  const blocks = [
    ...roots.slice(0, 3),
    { id: "middle", type: "heading_2", has_children: false },
    { id: "second", type: "paragraph", has_children: false, text: "Second paragraph." },
    { id: "second-divider", type: "divider", has_children: false },
    ...roots.slice(3),
  ]
  const result = proof(input, source, blocks)
  if (result.candidate === undefined) throw new Error("Missing proved divider candidate")
  assert.ok(result.candidate.includes("Second paragraph.\n\n---"))
  assert.equal(complete(result.candidate, source, blocks), true)
})

test("a boundary candidate never repairs changed code or unrelated body text", () => {
  const result = proof(raw.replace("keep  spaces", "different code"))
  if (result.candidate === undefined) throw new Error("Missing proved divider candidate")
  assert.equal(complete(result.candidate), false)
  assert.ok(result.candidate.includes("different code"))
  assert.equal(complete(result.candidate.replace("Done.", "Different.")), false)
})

test("unclosed code and a different rule spelling remain outside this repair", () => {
  assert.equal(proof(raw.replace(".\n---", ".\n----")).candidate, undefined)
  const inside = "```markdown\nRead [docs](https://example.test/exact).\n---\n"
  assert.equal(candidate.notionMarkdownForComparison(inside, target, roots), undefined)
})

// Exercise both repairs through the one production comparison entry point.
{
  const body = "Literal:\n```text\n---\n```"
  const raw = `# Start\nBefore.\n\`\`\`markdown\n${body}\n\`\`\`\nAfter literal.\n## Middle\nRead [docs](https://example.test/exact).\n---\n## After\nDone.`
  const target = `# Start\n\nBefore.\n\n\`\`\`\`markdown\n${body}\n\`\`\`\`\n\nAfter literal.\n\n## Middle\n\nRead [docs](https://example.test/exact).\n\n---\n\n## After\n\nDone.`
  const roots: NotionBlockBoundary[] = [
    { id: "start", type: "heading_1", has_children: false },
    { id: "before", type: "paragraph", has_children: false, text: "Before." },
    { id: "code", type: "code", has_children: false, code: { language: "markdown", text: body } },
    { id: "after-code", type: "paragraph", has_children: false, text: "After literal." },
    { id: "middle", type: "heading_2", has_children: false },
    { id: "paragraph", type: "paragraph", has_children: false, text: "Read docs." },
    { id: "divider", type: "divider", has_children: false },
    { id: "after", type: "heading_2", has_children: false },
    { id: "done", type: "paragraph", has_children: false, text: "Done." },
  ]
  const proof = (input = raw, source = target, boundaries = roots) =>
    candidate.notionMarkdownForComparison(input, source, boundaries)
  const complete = (input: string | undefined, source = target) =>
    input !== undefined && candidate.sameNotionMarkdown(input, source)

  test("the code wrapper is bound before divider parsing without changing either body", () => {
    assert.equal(complete(candidate.fromNotionMarkdown(raw, roots)), false)
    const result = proof()
    if (result === undefined) throw new Error("Missing composite boundary candidate")
    assert.equal(complete(result), true)
    assert.ok(result.includes(body))
    assert.ok(result.includes("Read [docs](https://example.test/exact).\n\n---"))
    assert.equal(
      candidate
        .markdownStructure(result)
        .filter((node) => Array.isArray(node) && node[0] === "code").length,
      1,
    )
  })

  test("whole comparison refuses changed code, explicit URLs or text through both repairs", () => {
    assert.equal(complete(proof(raw.replace("Literal:", "Different:"))), false)
    assert.equal(complete(proof(raw.replace("https://example.test", "http://example.test"))), false)
    assert.equal(complete(proof(raw.replace("Done.", "Other."))), false)
  })

  test("both repairs retain their independent original block evidence requirements", () => {
    const withoutCode = roots.map(({ code: _code, ...root }) => root)
    assert.equal(complete(proof(raw, target, withoutCode)), false)
    const withoutDivider = roots.filter((root) => root.id !== "divider")
    assert.equal(complete(proof(raw, target, withoutDivider)), false)
    const unknownNeighbor = roots.map((root) =>
      root.id === "after" ? { ...root, type: "unknown" } : root,
    )
    assert.equal(complete(proof(raw, target, unknownNeighbor)), false)
  })

  test("ordinary export cannot infer a target-directed code or divider correction", () => {
    assert.equal(
      candidate.sameNotionMarkdown(candidate.fromNotionMarkdown(raw, roots), target),
      false,
    )
    assert.equal(proof(raw, target, []), undefined)
  })
}
