import { describe, expect, test } from "bun:test"
import { SkillsError } from "../src/model.ts"
import { normalizeObservedBody } from "../src/shared-file-state.ts"
import {
  projectSharedNotionMarkdown,
  sharedNotionMarkdownPolicy,
  sharedNotionMarkdownWire,
  validateSharedNotionMarkdownProjection,
} from "../src/shared-notion-projection.ts"

const create = (input: string) =>
  projectSharedNotionMarkdown(input, { purpose: "data_source_create" })
const retained = (input: string) =>
  projectSharedNotionMarkdown(input, { version: 8, purpose: "data_source_create" })

describe("native creation document spacing v9", () => {
  test("predicts the observed single leading LF before an ATX heading without changing wire", () => {
    const input = "\n# Heading\n\nA paragraph.\n"
    const projection = create(input)
    expect(projection.markdown).toBe("# Heading\n\nA paragraph.")
    expect(projection.version).toBe(9)
    expect(projection.input_markdown).toBe(input)
    expect(sharedNotionMarkdownWire(projection)).toBe(sharedNotionMarkdownWire(retained(input)))
    expect(normalizeObservedBody(input)).toBe(input)
  })

  test("predicts the observed ATX heading-to-paragraph separator without changing wire", () => {
    const input = "# Title\n\n## Section\nA paragraph.\n"
    const projection = create(input)
    expect(projection.markdown).toBe("# Title\n\n## Section\n\nA paragraph.")
    expect(sharedNotionMarkdownWire(projection)).toBe(sharedNotionMarkdownWire(retained(input)))
    expect(validateSharedNotionMarkdownProjection(projection)).toEqual(projection)
    expect(sharedNotionMarkdownPolicy(projection).version).toBe(9)
  })

  test.each([
    "# Heading\n\nA paragraph.",
    "\n\n# Heading\n\nA paragraph.",
    "\nA paragraph.",
    "```text\n\n# Heading\nA paragraph.\n```",
    "> # Heading\n> A paragraph.",
    "- # Heading\n  A paragraph.",
    "# Heading\n\n- A list item.",
    "# Heading\n\n```text\nA paragraph.\n```",
  ])("does not generalize the new policy beyond observed document boundaries (%s)", (input) => {
    const projection = create(input)
    expect(projection.markdown).toBe(retained(input).markdown)
    expect(sharedNotionMarkdownWire(projection)).toBe(sharedNotionMarkdownWire(retained(input)))
    expect(projection.input_markdown).toBe(input)
  })

  test("body-write predictions keep the retained v8 behavior", () => {
    const input = "\n# Heading\nA paragraph.\n"
    const previous = projectSharedNotionMarkdown(input, { version: 8, purpose: "body_write" })
    const current = projectSharedNotionMarkdown(input, { purpose: "body_write" })
    expect(current.markdown).toBe(previous.markdown)
    expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(previous))
    expect(normalizeObservedBody(input)).toBe(input)
  })

  test("every retained v1-v8 projection still validates its original exact whitespace", () => {
    const input = "\n# Title\n\n## Section\nA paragraph.\n"
    const expected = input.slice(0, -1)
    for (const version of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
      const projection = projectSharedNotionMarkdown(input, {
        version,
        purpose: "data_source_create",
      })
      expect(projection.markdown).toBe(expected)
      expect(sharedNotionMarkdownWire(projection)).toBe(
        version === 1 ? expected : expected.replace("# Title", "<h1>Title</h1>"),
      )
      expect(validateSharedNotionMarkdownProjection(projection)).toEqual(projection)
    }
  })

  test("current readback cannot redefine the frozen expected body or wire", () => {
    const projection = create("\n# Heading\nA paragraph.\n")
    expect(projection.markdown).toBe("# Heading\n\nA paragraph.")
    for (const changed of [
      { ...projection, markdown: "# Heading\n\nEdited paragraph." },
      { ...projection, markdown: "# Heading\nA paragraph." },
      { ...projection, wire_markdown: "<h1>Heading</h1>\n\nA paragraph." },
    ])
      expect(() => validateSharedNotionMarkdownProjection(changed)).toThrow(SkillsError)
  })
})
