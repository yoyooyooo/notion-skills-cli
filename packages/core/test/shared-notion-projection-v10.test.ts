import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { normalizeObservedBody } from "../src/shared-file-state.ts"
import {
  projectSharedNotionMarkdown,
  sharedNotionMarkdownWire,
  validateSharedNotionMarkdownProjection,
} from "../src/shared-notion-projection.ts"

test("new creation predicts the independently captured Counter v2 body without changing wire", () => {
  // AH-681: original real POST and complete markdown_version=v2 GET.
  // Keep the failed v9 bytes as well as the independently observed response.
  const input =
    "# Counter\n\nTLC reached 4 states and 3 steps. The chart draws 4 states and 3 arrows.\n\n## Rules that hold\nLow, StaysSmall\nTLC checked Low only in the initial states, because it has no [], <>, or ~>. List it as an INVARIANT to check every state.\n"
  const observed =
    "# Counter\n\nTLC reached 4 states and 3 steps. The chart draws 4 states and 3 arrows.\n\n## Rules that hold\n\nLow, StaysSmall<br />TLC checked Low only in the initial states, because it has no \\[\\], \\<>, or \\~>. List it as an INVARIANT to check every state."
  const previous = projectSharedNotionMarkdown(input, {
    version: 9,
    purpose: "data_source_create",
  })
  const current = projectSharedNotionMarkdown(input, {
    version: 10,
    purpose: "data_source_create",
  })
  expect(Buffer.byteLength(observed)).toBe(252)
  expect(createHash("sha256").update(observed).digest("hex")).toBe(
    "4d9eeba3acbf58d70b94061b0ae64b021695ae50c18cb46fc2232125c94000b1",
  )
  expect(current.markdown).toBe(observed)
  expect(current.version).toBe(10)
  expect(current.input_markdown).toBe(input)
  expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(previous))
  expect(createHash("sha256").update(previous.markdown).digest("hex")).toBe(
    "ffd67a55989457e58ba5529f7c9f4dd75eba6dd6ecdc17131afafc276f06e26b",
  )
  expect(validateSharedNotionMarkdownProjection(previous)).toEqual(previous)
  expect(validateSharedNotionMarkdownProjection(current)).toEqual(current)
  expect(() => validateSharedNotionMarkdownProjection({ ...previous, version: 10 })).toThrow()
  expect(normalizeObservedBody(observed)).toBe(observed)
  expect(normalizeObservedBody(previous.markdown)).not.toBe(normalizeObservedBody(observed))
})

test("new literal escaping preserves code, existing escapes, link destinations and native tags", () => {
  const input =
    "literal [], <>; escaped\\[\\]\\<; `[]<>~_`; <code>[]<>~_</code>; [label](folder/[index]_name.md).\n\n```txt\n[]<>~_\n```"
  const previous = projectSharedNotionMarkdown(input, { version: 9 })
  const current = projectSharedNotionMarkdown(input, { version: 10 })
  expect(current.markdown).toBe(previous.markdown.replace("literal [], <>", "literal \\[\\], \\<>"))
  expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(previous))
  expect(validateSharedNotionMarkdownProjection(previous)).toEqual(previous)
  expect(validateSharedNotionMarkdownProjection(current)).toEqual(current)
})

test("literal item text is escaped without changing structural list and task markers", () => {
  const input = "- Literal [], <>, ~>.\n- [ ] Already a task\n"
  const previous = projectSharedNotionMarkdown(input, { version: 9 })
  const current = projectSharedNotionMarkdown(input, { version: 10 })
  expect(current.markdown).toBe(
    previous.markdown.replace("Literal [], <>, ~>.", "Literal \\[\\], \\<>, \\~>."),
  )
  expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(previous))
  expect(current.markdown).toContain("- [ ] Already a task")
})

test("creation predicts the independently observed paragraph-to-fence blank line", () => {
  // The real slack-gif-creator v2 response added this separator at five sites.
  const input =
    "Load and work with images using PIL:\n```python\nfrom PIL import Image\n\nuploaded = Image.open('file.png')\n# Use directly, or just as reference for colors/style\n```"
  const observed =
    "Load and work with images using PIL:\n\n```py\nfrom PIL import Image\n\nuploaded = Image.open('file.png')\n# Use directly, or just as reference for colors/style\n```"
  const previous = projectSharedNotionMarkdown(input, {
    version: 9,
    purpose: "data_source_create",
  })
  const current = projectSharedNotionMarkdown(input, {
    version: 10,
    purpose: "data_source_create",
  })
  expect(current.markdown).toBe(observed)
  expect(previous.markdown).toBe(observed.replace("PIL:\n\n", "PIL:\n"))
  expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(previous))
  expect(validateSharedNotionMarkdownProjection(previous)).toEqual(previous)
  expect(validateSharedNotionMarkdownProjection(current)).toEqual(current)
  expect(normalizeObservedBody(previous.markdown)).not.toBe(normalizeObservedBody(observed))
})

test.each([
  "A paragraph.\n\n```text\nbody\n```",
  "```text\nA paragraph.\n~~~js\nbody\n~~~\n```",
  "> A paragraph.\n> ```text\n> body\n> ```",
  "- A paragraph.\n  ```text\n  body\n  ```",
  "```text\nbody\n```\nA paragraph.",
])("new creation separator keeps unrelated boundaries unchanged (%s)", (input) => {
  const previous = projectSharedNotionMarkdown(input, {
    version: 9,
    purpose: "data_source_create",
  })
  const current = projectSharedNotionMarkdown(input, {
    version: 10,
    purpose: "data_source_create",
  })
  expect(current.markdown).toBe(previous.markdown)
  expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(previous))
})

test("paragraph-to-fence body-write policy retains the original exact separator", () => {
  const input = "A paragraph.\n```text\nbody\n```"
  const previous = projectSharedNotionMarkdown(input, { version: 9, purpose: "body_write" })
  const current = projectSharedNotionMarkdown(input, { version: 10, purpose: "body_write" })
  expect(current.markdown).toBe(previous.markdown)
  expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(previous))
})
