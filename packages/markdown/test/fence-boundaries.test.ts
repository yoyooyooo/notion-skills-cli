import assert from "node:assert/strict"
import { test } from "node:test"
import * as candidate from "../src/index.ts"

const code = (api: typeof candidate, text: string) =>
  api
    .markdownStructure(text)
    .filter((node): node is unknown[] => Array.isArray(node) && node[0] === "code")

test("an info-bearing marker inside code does not inject LF after literal frontmatter rules", () => {
  const raw = "````markdown\nalpha\n````javascript\n---\nname: Sample\n---\n````"
  const intended = code(candidate, raw)
  assert.deepEqual(code(candidate, candidate.fromNotionMarkdown(raw)), intended)
  assert.equal(
    candidate.markdownIdentity(candidate.fromNotionMarkdown(raw)),
    candidate.markdownIdentity(raw),
  )
})

test("inline boundary cleanup preserves four literal stars after a nonclosing info marker", () => {
  const raw = "````text\nalpha\n````javascript\nkeep **** exact\n````"
  assert.equal(candidate.stripNotionInlineBoundaries(raw), raw)
})

test("same or longer info markers remain literal for both backticks and tildes", () => {
  for (const marker of ["`", "~"]) {
    for (const innerLength of [4, 5]) {
      const outer = marker.repeat(4),
        inner = marker.repeat(innerLength)
      const raw = `${outer}markdown\nalpha\n${inner}javascript\n---\nkeep **** exact\n---\n${outer}`
      assert.deepEqual(code(candidate, candidate.fromNotionMarkdown(raw)), code(candidate, raw))
      assert.equal(candidate.stripNotionInlineBoundaries(raw), raw)
    }
  }
})

test("a valid longer empty closing marker ends code and normal prose resumes", () => {
  const raw = "````text\nalpha\n````javascript\nkeep **** exact\n`````  \nOutside **** prose."
  const result = candidate.stripNotionInlineBoundaries(raw)
  assert.ok(result.includes("keep **** exact"))
  assert.ok(result.endsWith("Outside  prose."))
  assert.deepEqual(code(candidate, candidate.fromNotionMarkdown(raw)), code(candidate, raw))
})

test("an unclosed outer fence cannot end at a trailing info marker", () => {
  const raw = "````text\nalpha\n````javascript\n---\nkeep **** exact\n---"
  assert.deepEqual(code(candidate, candidate.fromNotionMarkdown(raw)), code(candidate, raw))
  assert.equal(candidate.stripNotionInlineBoundaries(raw), raw)
})

test("code tabs, blank lines, trailing spaces and break tags retain their exact bytes", () => {
  const raw = "````text\n\talpha  \n\n````javascript\n---\n\tkeep<br> **** exact  \n\n---\n````"
  const restored = candidate.fromNotionMarkdown(raw)
  assert.deepEqual(code(candidate, restored), code(candidate, raw))
  assert.equal(candidate.fromNotionMarkdown(restored), restored)
  assert.equal(candidate.stripNotionInlineBoundaries(raw), raw)
})

test("different code bytes stay unequal under every whitespace variant", () => {
  for (const [actual, target] of [
    ["a\n\nb", "a\nb"],
    ["a  ", "a"],
    ["\ta", "a"],
    ["---\n", "---"],
  ]) {
    assert.equal(
      candidate.sameNotionMarkdown(
        `\`\`\`\`text\n${actual}\n\`\`\`\``,
        `\`\`\`\`text\n${target}\n\`\`\`\``,
      ),
      false,
    )
  }
})
