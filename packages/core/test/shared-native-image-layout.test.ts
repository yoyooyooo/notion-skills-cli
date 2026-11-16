import { expect, test } from "bun:test"
import { projectNativeImageBlocks } from "../src/shared-native-image-layout.ts"
import { assertImportedMarkdownContent } from "../src/shared-import-markdown.ts"
import { projectSharedNotionMarkdown } from "../src/shared-notion-projection.ts"

const first = '![First](https://images.example/first.png?size=2 "Original title")'
const second = "[![Second](https://images.example/second.svg)](https://example.test/sponsor)"
const third = "![Third](https://images.example/third.png)"

test("explicit image layout inserts only paragraph boundaries and preserves the linked badge", () => {
  const before = `# Original\n\n${first}\n${second}\n${third}\n\nKeep \`a + b\` and [guide](guide.md).\n`
  const after = `# Original\n\n${first}\n\n${second}\n\n${third}\n\nKeep \`a + b\` and [guide](guide.md).\n`
  const result = projectNativeImageBlocks(before)
  expect(result).toEqual({
    kind: "changed",
    policy: "native_image_blocks_v1",
    markdown: after,
    summary: { paragraphs: 1, images: 3, linked_images: 1, inserted_line_feeds: 2 },
  })
  expect(() => assertImportedMarkdownContent(before, after)).not.toThrow()
  expect(projectNativeImageBlocks(after)).toEqual({
    kind: "unchanged",
    policy: "native_image_blocks_v1",
    markdown: after,
  })
})

test("same-line images retain their exact source tokens and original separator whitespace", () => {
  const before = `${first} ${third}`
  expect(projectNativeImageBlocks(before)).toEqual({
    kind: "changed",
    policy: "native_image_blocks_v1",
    markdown: `${first} \n\n${third}`,
    summary: { paragraphs: 1, images: 2, linked_images: 0, inserted_line_feeds: 2 },
  })
})

test("mixed text, lists, quotes, code, tables and HTML keep their original bytes", () => {
  for (const before of [
    `Read ${first}\n${third}`,
    `${first}\nCaption\n${third}`,
    `${first}\n[ordinary link](guide.md)\n${third}`,
    `[Label ${first}](https://example.test/sponsor)\n${third}`,
    `- ${first}\n  ${third}`,
    `> ${first}\n> ${third}`,
    `\`\`\`md\n${first}\n${third}\n\`\`\``,
    `| Image |\n| --- |\n| ${first} ${third} |`,
    `<div>\n${first}\n${third}\n</div>`,
    `<img src="https://images.example/first.png">\n${third}`,
  ])
    expect(projectNativeImageBlocks(before)).toEqual({
      kind: "unchanged",
      policy: "native_image_blocks_v1",
      markdown: before,
    })
})

test("an already separated layout produces no new candidate", () => {
  for (const before of ["", "Keep all text.", first, `${first}\n\n${second}\n\n${third}`])
    expect(projectNativeImageBlocks(before)).toEqual({
      kind: "unchanged",
      policy: "native_image_blocks_v1",
      markdown: before,
    })
})

test("image captions, source URLs, outer link targets and code retain the existing strict checks", () => {
  const before = `${first}\n${second}\n\nKeep \`a + b\`.`
  const after = projectNativeImageBlocks(before).markdown
  for (const changed of [
    after.replace("First", "Changed"),
    after.replace("https://images.example/first.png", "https://images.example/other.png"),
    after.replace("https://example.test/sponsor", "https://example.test/changed"),
    after.replace(second, "![Second](https://images.example/second.svg)"),
    after.replace("a + b", "a - b"),
  ])
    expect(() => assertImportedMarkdownContent(before, changed)).toThrow()
})

test("native image layout does not change old import policy or the default projection", () => {
  const before = `${first}\n${second}`
  const old = projectSharedNotionMarkdown(before, { version: 14, purpose: "data_source_create" })
  const current = projectSharedNotionMarkdown("Plain body")
  expect(old.version).toBe(14)
  expect(old).toHaveProperty("wire_markdown", before)
  expect(current.version).toBe(15)
  expect(projectNativeImageBlocks(before).markdown).not.toBe(before)
  expect(old).toHaveProperty("wire_markdown", before)
})
