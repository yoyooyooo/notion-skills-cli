import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { normalizeObservedBody } from "../src/shared-file-state.ts"
import {
  projectSharedNotionMarkdown,
  sharedNotionMarkdownPolicy,
  SharedNotionMarkdownPolicySchema,
  sharedNotionMarkdownWire,
  validateSharedNotionMarkdownProjection,
} from "../src/shared-notion-projection.ts"

test("v11 predicts the complete observed UserNoDeadlock heading without changing original wire", () => {
  // AH-681: the original 254-byte input and the complete independent v2 GET.
  // The retained v10 prediction differed only at CHECK_DEADLOCK in the heading.
  const input =
    "# UserNoDeadlock\n\nTLC reached 4 states and 3 steps. The chart draws 4 states and 3 arrows.\n\n## NoDeadlock breaks\nThe shortest path has 1 step:\n0. 0\n1. Next: 1\n\n## CHECK_DEADLOCK breaks\nThe shortest path has 3 steps:\n0. 0\n1. Next: 1\n2. Next: 2\n3. Next: 3\n"
  const observed =
    "# UserNoDeadlock\n\nTLC reached 4 states and 3 steps. The chart draws 4 states and 3 arrows.\n\n## NoDeadlock breaks\n\nThe shortest path has 1 step:<br />0. 0\n\n1. Next: 1\n\n## CHECK\\_DEADLOCK breaks\n\nThe shortest path has 3 steps:<br />0. 0\n\n1. Next: 1\n2. Next: 2\n3. Next: 3"
  const previous = projectSharedNotionMarkdown(input, {
    version: 10,
    purpose: "data_source_create",
  })
  const current = projectSharedNotionMarkdown(input, {
    version: 11,
    purpose: "data_source_create",
  })
  expect(Buffer.byteLength(input)).toBe(254)
  expect(createHash("sha256").update(input).digest("hex")).toBe(
    "53433b379971530176a5e150a14c466c4452d07c523b3207e8b6c2b55c68b0cf",
  )
  expect(Buffer.byteLength(observed)).toBe(268)
  expect(createHash("sha256").update(observed).digest("hex")).toBe(
    "8dc200257d528e60e04f84d31c6e80770ec57c5f45acf82b60a5aab3b7ebee04",
  )
  expect(current.markdown).toBe(observed)
  expect(current.version).toBe(11)
  expect(current.input_markdown).toBe(input)
  expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(previous))
  expect(Buffer.byteLength(previous.markdown)).toBe(267)
  expect(previous.markdown).toBe(observed.replace("CHECK\\_DEADLOCK", "CHECK_DEADLOCK"))
  expect(validateSharedNotionMarkdownProjection(previous)).toEqual(previous)
  expect(validateSharedNotionMarkdownProjection(current)).toEqual(current)
  expect(
    Schema.decodeUnknownSync(SharedNotionMarkdownPolicySchema)(sharedNotionMarkdownPolicy(current)),
  ).toEqual(sharedNotionMarkdownPolicy(current))
  expect(() => validateSharedNotionMarkdownProjection({ ...current, version: 10 })).toThrow()
  expect(() =>
    validateSharedNotionMarkdownProjection({ ...current, markdown: previous.markdown }),
  ).toThrow()
  expect(normalizeObservedBody(observed)).toBe(observed)
  expect(normalizeObservedBody(previous.markdown)).not.toBe(normalizeObservedBody(observed))
})

for (const purpose of ["body_write", "data_source_create"] as const) {
  test.each([1, 2, 3, 4])(`v11 escapes only H%i literal text for ${purpose}`, (depth) => {
    const prefix = "#".repeat(depth)
    const input = `${prefix} CHECK_DEADLOCK [], <>, ~>.\n`
    const previous = projectSharedNotionMarkdown(input, { version: 10, purpose })
    const current = projectSharedNotionMarkdown(input, { version: 11, purpose })
    expect(current.markdown).toBe(`${prefix} CHECK\\_DEADLOCK \\[\\], \\<>, \\~>.`)
    expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(previous))
    expect(validateSharedNotionMarkdownProjection(current)).toEqual(current)
  })
}

test.each([
  "## CHECK_DEADLOCK `CODE_[]<>~` <code>CODE_[]<>~</code>\n",
  '## CHECK_DEADLOCK [label](folder/[index]_name~.md "title_[]<>")\n',
  '## CHECK_DEADLOCK <span data-note="[]<>~_">label</span>\n',
  "## CHECK_DEADLOCK \\_ \\[\\] \\< \\~\n",
  "   ### CHECK_DEADLOCK ###\n",
  "## **CHECK_DEADLOCK**\n",
])("v11 preserves heading syntax and protected token bytes (%s)", (input) => {
  const previous = projectSharedNotionMarkdown(input, { version: 10 })
  const current = projectSharedNotionMarkdown(input, { version: 11 })
  expect(current.markdown).toBe(previous.markdown.replace("CHECK_DEADLOCK", "CHECK\\_DEADLOCK"))
  expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(previous))
  expect(validateSharedNotionMarkdownProjection(previous)).toEqual(previous)
  expect(validateSharedNotionMarkdownProjection(current)).toEqual(current)
})

test("v11 keeps complete reference-link tokens and their destinations inside headings", () => {
  const input =
    "## CHECK_DEADLOCK [saved_label][target_id]\n\n[target_id]: folder/[index]_name~.md\n"
  const previous = projectSharedNotionMarkdown(input, { version: 10 })
  const current = projectSharedNotionMarkdown(input, { version: 11 })
  expect(current.markdown).toBe(previous.markdown.replace("CHECK_DEADLOCK", "CHECK\\_DEADLOCK"))
  expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(previous))
})

test("v11 keeps native code and resolved links when literal tildes cross code-token boundaries", () => {
  const input =
    "## CHECK_DEADLOCK <code>CODE_[]<>~</code> NEXT_CHECK [saved_label][target_id] <code>CODE_[]<>~</code>\n\n[target_id]: folder/[index]_name~.md\n"
  const previous = projectSharedNotionMarkdown(input, { version: 10 })
  const current = projectSharedNotionMarkdown(input, { version: 11 })
  expect(current.markdown).toBe(
    previous.markdown
      .replace("CHECK_DEADLOCK", "CHECK\\_DEADLOCK")
      .replace("NEXT_CHECK", "NEXT\\_CHECK"),
  )
  expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(previous))
  expect(validateSharedNotionMarkdownProjection(current)).toEqual(current)
})

test("v11 leaves literal fences, nonheading paragraphs and list structure at the v10 policy", () => {
  const input =
    "```md\n## CHECK_DEADLOCK [], <>, ~>.\n```\n\nCHECK_DEADLOCK [], <>, ~>.\n\n- CHECK_DEADLOCK [], <>, ~>.\n- [ ] Saved task\n"
  const previous = projectSharedNotionMarkdown(input, { version: 10 })
  const current = projectSharedNotionMarkdown(input, { version: 11 })
  expect(current.markdown).toBe(previous.markdown)
  expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(previous))
})

test.each([5, 6])("v11 preserves the original unsupported H%i boundary", (depth) => {
  const input = `${"#".repeat(depth)} CHECK_DEADLOCK\n`
  for (const options of [{ version: 10 as const }, { version: 11 as const }])
    expect(() => projectSharedNotionMarkdown(input, options)).toThrow(
      expect.objectContaining({ code: "SHARED_MARKDOWN_PROJECTION_UNSUPPORTED" }),
    )
})

test("retained v1-v10 heading policies keep their exact original bytes", () => {
  const input = "## CHECK_DEADLOCK breaks\n"
  for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const) {
    const previous = projectSharedNotionMarkdown(input, { version })
    expect(previous.version).toBe(version)
    expect(previous.markdown).toBe("## CHECK_DEADLOCK breaks")
    expect(sharedNotionMarkdownWire(previous)).toBe("## CHECK_DEADLOCK breaks")
    expect(validateSharedNotionMarkdownProjection(previous)).toEqual(previous)
  }
})
