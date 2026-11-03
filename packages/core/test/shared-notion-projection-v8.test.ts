import { expect, test } from "bun:test"
import {
  projectSharedNotionMarkdown,
  sharedNotionMarkdownWire,
  validateSharedNotionMarkdownProjection,
} from "../src/shared-notion-projection.ts"

test("v8 predicts the independently captured native page-link URL without changing the wire", () => {
  const input =
    "# Owned direct HTTP verification\n\nAH564_83d414ee0adb40009931b792a1658aa0_WRITTEN\n\n[Supporting file](https://www.notion.so/40d5636c236e8164b3a0f4f89c798759)\n"
  const observed =
    "# Owned direct HTTP verification\n\nAH564\\_83d414ee0adb40009931b792a1658aa0\\_WRITTEN\n\n[Supporting file](https://app.notion.com/p/40d5636c236e8164b3a0f4f89c798759)"
  const prior = projectSharedNotionMarkdown(input, { version: 7 })
  const current = projectSharedNotionMarkdown(input)
  expect(current.version).toBe(8)
  expect(current.markdown).toBe(observed)
  expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(prior))
  expect(prior.markdown).not.toBe(observed)
  expect(validateSharedNotionMarkdownProjection(prior)).toEqual(prior)
  expect(validateSharedNotionMarkdownProjection(current)).toEqual(current)
  expect(() => validateSharedNotionMarkdownProjection({ ...prior, version: 8 })).toThrow()
})

test("v8 leaves code, non-Notion links and unobserved URL forms unchanged", () => {
  const target = "https://www.notion.so/40d5636c236e8164b3a0f4f89c798759"
  const input = `\`[code](${target})\`\n\n\`\`\`md\n[code](${target})\n\`\`\`\n\n[external](https://example.com/a) [query](${target}?x=1) [fragment](${target}#section)`
  expect(projectSharedNotionMarkdown(input).markdown).toBe(
    projectSharedNotionMarkdown(input, { version: 7 }).markdown,
  )
})

test("v1-v7 retain their original page-link bytes and policy", () => {
  const input = "[owned](https://www.notion.so/40d5636c236e8164b3a0f4f89c798759)"
  for (const version of [1, 2, 3, 4, 5, 6, 7] as const) {
    const projection = projectSharedNotionMarkdown(input, { version })
    expect(projection.markdown).toBe(input)
    expect(validateSharedNotionMarkdownProjection(projection)).toEqual(projection)
  }
})
