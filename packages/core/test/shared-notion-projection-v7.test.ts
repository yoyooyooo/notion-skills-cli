import { expect, test } from "bun:test"
import {
  projectSharedNotionMarkdown,
  sharedNotionMarkdownWire,
  validateSharedNotionMarkdownProjection,
} from "../src/shared-notion-projection.ts"

test("v7 predicts the independently observed native v2 literal underscore response before dispatch", () => {
  // AH-564 real POST/GET evidence retained the exact v6 mismatch, not a success.
  const input =
    "# Owned direct HTTP verification\n\nAH564_cc2d17cd94b74952b4ff4249ef47e0ef_INITIAL\n\n[Supporting file](references/guide.md)\n"
  const observed =
    "# Owned direct HTTP verification\n\nAH564\\_cc2d17cd94b74952b4ff4249ef47e0ef\\_INITIAL\n\n[Supporting file](references/guide.md)"
  const previous = projectSharedNotionMarkdown(input, {
    version: 6,
    purpose: "data_source_create",
  })
  const current = projectSharedNotionMarkdown(input, { version: 7, purpose: "data_source_create" })
  expect(current.version).toBe(7)
  expect(current.markdown).toBe(observed)
  expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(previous))
  expect(previous.markdown).toBe(input.trimEnd())
  expect(validateSharedNotionMarkdownProjection(previous)).toEqual(previous)
  expect(validateSharedNotionMarkdownProjection(current)).toEqual(current)
  expect(() => validateSharedNotionMarkdownProjection({ ...previous, version: 7 })).toThrow()
})

test("v7 keeps literal code, escaped text and link destinations unchanged", () => {
  const input =
    "plain_id, escaped\\_id, `code_id`, <code>native_id</code> and [label](folder/file_id.md).\n\n```js\nconst key_id = 'value_id'\n```"
  const previous = projectSharedNotionMarkdown(input, { version: 6 })
  const current = projectSharedNotionMarkdown(input, { version: 7 })
  expect(current.markdown).toBe(previous.markdown.replace("plain_id", "plain\\_id"))
  expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(previous))
  expect(validateSharedNotionMarkdownProjection(previous)).toEqual(previous)
})

test("retained v1-v6 projections keep the same literal text and declared policy", () => {
  for (const version of [1, 2, 3, 4, 5, 6] as const) {
    const projection = projectSharedNotionMarkdown("original_id", { version })
    expect(projection.markdown).toBe("original_id")
    expect(validateSharedNotionMarkdownProjection(projection)).toEqual(projection)
  }
})
