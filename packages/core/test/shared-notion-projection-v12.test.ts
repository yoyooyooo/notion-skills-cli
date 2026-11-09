import { expect, test } from "bun:test"
import { Schema } from "effect"
import { normalizeObservedBody } from "../src/shared-file-state.ts"
import {
  currentSharedNotionMarkdownVersion,
  projectSharedNotionMarkdown,
  sharedNotionMarkdownPolicy,
  SharedNotionMarkdownPolicySchema,
  sharedNotionMarkdownWire,
  validateSharedNotionMarkdownProjection,
} from "../src/shared-notion-projection.ts"

test("v12 body writes predict the independently observed heading-to-paragraph separator", () => {
  // Exact boundary from the complete AH-703 four-source public-write readback.
  const input =
    "### Working with User-Uploaded Images\nIf a user uploads an image, consider whether they want to:\n"
  const observed =
    "### Working with User-Uploaded Images\n\nIf a user uploads an image, consider whether they want to:"
  const previous = projectSharedNotionMarkdown(input, { version: 11 })
  const current = projectSharedNotionMarkdown(input)
  expect(current.markdown).toBe(observed)
  expect(previous.markdown).toBe(observed.replace("Images\n\n", "Images\n"))
  expect(current.version).toBe(12)
  expect(currentSharedNotionMarkdownVersion).toBe(12)
  expect(current.input_markdown).toBe(input)
  expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(previous))
  expect(validateSharedNotionMarkdownProjection(previous)).toEqual(previous)
  expect(validateSharedNotionMarkdownProjection(current)).toEqual(current)
  expect(
    Schema.decodeUnknownSync(SharedNotionMarkdownPolicySchema)(sharedNotionMarkdownPolicy(current)),
  ).toEqual(sharedNotionMarkdownPolicy(current))
  expect(() => validateSharedNotionMarkdownProjection({ ...current, version: 11 })).toThrow()
  expect(() =>
    validateSharedNotionMarkdownProjection({ ...current, markdown: previous.markdown }),
  ).toThrow()
  expect(normalizeObservedBody(previous.markdown)).not.toBe(normalizeObservedBody(observed))
})

test("v12 body writes predict the independently observed paragraph-to-fence separator", () => {
  const input =
    "Load and work with images using PIL:\n```python\nfrom PIL import Image\n\nuploaded = Image.open('file.png')\n# Use directly, or just as reference for colors/style\n```"
  const observed =
    "Load and work with images using PIL:\n\n```py\nfrom PIL import Image\n\nuploaded = Image.open('file.png')\n# Use directly, or just as reference for colors/style\n```"
  const previous = projectSharedNotionMarkdown(input, { version: 11 })
  const current = projectSharedNotionMarkdown(input)
  expect(current.markdown).toBe(observed)
  expect(previous.markdown).toBe(observed.replace("PIL:\n\n", "PIL:\n"))
  expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(previous))
  expect(validateSharedNotionMarkdownProjection(current)).toEqual(current)
})

test.each([
  "### Heading\n\nA paragraph.\n",
  "A paragraph.\n\n```text\nbody\n```",
  "```text\n## Heading\nA paragraph.\n~~~python\ncode()\n~~~\n```",
  "> ## Heading\n> A paragraph.\n",
  "> A paragraph.\n> ```text\n> body\n> ```",
  "- ## Heading\n  A paragraph.\n",
  "- A paragraph.\n  ```text\n  body\n  ```",
  "# Heading\n\n- A list item.\n",
  "```text\nbody\n```\nA paragraph.",
])("v12 preserves already separated blocks and unrelated or nested boundaries (%s)", (input) => {
  const previous = projectSharedNotionMarkdown(input, { version: 11 })
  const current = projectSharedNotionMarkdown(input)
  expect({ ...current, version: 11 }).toEqual(previous)
  expect(validateSharedNotionMarkdownProjection(current)).toEqual(current)
})

test("body-write spacing does not borrow creation's leading-LF or H1 wire policy", () => {
  const input = "\n# Heading\nA paragraph.\n"
  const previous = projectSharedNotionMarkdown(input, { version: 11 })
  const current = projectSharedNotionMarkdown(input)
  const create = projectSharedNotionMarkdown(input, { purpose: "data_source_create" })
  expect(current.markdown).toBe("\n# Heading\n\nA paragraph.")
  expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(previous))
  expect(sharedNotionMarkdownWire(current)).toBe("\n# Heading\nA paragraph.")
  expect(create.markdown).toBe("# Heading\n\nA paragraph.")
  expect(sharedNotionMarkdownWire(create)).toBe("\n<h1>Heading</h1>\nA paragraph.")
})

test("v12 keeps previously covered creation paragraph boundaries and wire", () => {
  const input = "\n# Heading\nA paragraph.\n```python\nprint('ready')\n```\n"
  const previous = projectSharedNotionMarkdown(input, {
    version: 11,
    purpose: "data_source_create",
  })
  const current = projectSharedNotionMarkdown(input, { purpose: "data_source_create" })
  expect({ ...current, version: 11 }).toEqual(previous)
})

test.each([
  [
    "unordered list",
    "## Lane roles\n- Main progress\n- Review\n",
    "## Lane roles\n\n- Main progress\n- Review",
  ],
  [
    "ordered list",
    "## Absorb\n1. Save report\n2. Inspect report\n",
    "## Absorb\n\n1. Save report\n2. Inspect report",
  ],
  [
    "fenced code",
    "## Review start\n```bash\nprintf ready\n```\n",
    "## Review start\n\n```bash\nprintf ready\n```",
  ],
])("v12 creation predicts the observed heading-to-%s separator", (_shape, input, observed) => {
  const previous = projectSharedNotionMarkdown(input, {
    version: 11,
    purpose: "data_source_create",
  })
  const current = projectSharedNotionMarkdown(input, { purpose: "data_source_create" })
  expect(current.markdown).toBe(observed)
  expect(previous.markdown).toBe(observed.replace("\n\n", "\n"))
  expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(previous))
  expect(validateSharedNotionMarkdownProjection(previous)).toEqual(previous)
  expect(validateSharedNotionMarkdownProjection(current)).toEqual(current)
  expect(() =>
    validateSharedNotionMarkdownProjection({ ...current, markdown: previous.markdown }),
  ).toThrow()
  const body = projectSharedNotionMarkdown(input, { purpose: "body_write" })
  const oldBody = projectSharedNotionMarkdown(input, { version: 11, purpose: "body_write" })
  expect({ ...body, version: 11 }).toEqual(oldBody)
})

test.each([
  "## Heading\n\n- An item.\n",
  "## Heading\n\n```text\nbody\n```",
  "```text\n## Heading\n- A literal item\n~~~bash\nliteral\n~~~\n```",
  "> ## Heading\n> - An item.\n",
  "> ## Heading\n> ```text\n> literal\n> ```",
])("v12 creation keeps existing separators and fenced/nested heading boundaries (%s)", (input) => {
  const previous = projectSharedNotionMarkdown(input, {
    version: 11,
    purpose: "data_source_create",
  })
  const current = projectSharedNotionMarkdown(input, { purpose: "data_source_create" })
  expect({ ...current, version: 11 }).toEqual(previous)
})

test("retained v1-v11 creation policies keep the original heading-to-list boundary", () => {
  const input = "## Heading\n- First\n- Second\n"
  for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const) {
    const previous = projectSharedNotionMarkdown(input, { version, purpose: "data_source_create" })
    expect(previous.markdown).toBe(input.slice(0, -1))
    expect(sharedNotionMarkdownWire(previous)).toBe(input.slice(0, -1))
    expect(validateSharedNotionMarkdownProjection(previous)).toEqual(previous)
  }
})

test("retained v1-v11 body-write policies keep their original exact separators", () => {
  const input = "## Heading\nA paragraph.\n```text\nbody\n```\n"
  const wire = input.slice(0, -1)
  for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const) {
    const previous = projectSharedNotionMarkdown(input, { version, purpose: "body_write" })
    expect(previous.markdown).toBe(version === 1 ? wire : wire.replace("```text", "```txt"))
    expect(sharedNotionMarkdownWire(previous)).toBe(wire)
    expect(validateSharedNotionMarkdownProjection(previous)).toEqual(previous)
  }
})
