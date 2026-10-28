import { expect, test } from "bun:test"
import { Schema } from "effect"
import { fromNotionMarkdown, projectNotionBlocks, samePublishedMarkdown } from "../src/markdown.ts"
import { NotionBlockBoundarySchema } from "../src/model.ts"
import { publicationExternalLinksMatch } from "../src/publication-markdown.ts"

const actual = "[EXAMPLE.md](http://EXAMPLE.md)** supports**: An exact suffix."
const target = "**EXAMPLE.md supports**: An exact suffix."
const richText = [
  {
    type: "text",
    text: { content: "EXAMPLE.md", link: { url: "http://example.md/" } },
    plain_text: "EXAMPLE.md",
    annotations: { bold: true, code: false },
  },
  {
    type: "text",
    text: { content: " supports", link: null },
    plain_text: " supports",
    annotations: { bold: true, code: false },
  },
  {
    type: "text",
    text: { content: ": An exact suffix.", link: null },
    plain_text: ": An exact suffix.",
    annotations: { bold: false, code: false },
  },
]
const root = (rich_text: readonly unknown[]) => ({
  id: "paragraph",
  type: "paragraph",
  has_children: false,
  paragraph: { rich_text },
})

test("the core boundary retains exact annotation evidence through snapshot decoding", () => {
  const blocks = projectNotionBlocks([root(richText)])!
  expect(blocks[0]?.text).toBeUndefined()
  expect(blocks[0]?.rich_text).toEqual([
    { text: "EXAMPLE.md", link: "http://example.md/", bold: true, code: false },
    { text: " supports", link: null, bold: true, code: false },
    { text: ": An exact suffix.", link: null, bold: false, code: false },
  ])
  const decoded = blocks.map((block) => Schema.decodeUnknownSync(NotionBlockBoundarySchema)(block))
  expect(decoded).toEqual(blocks)
  expect(samePublishedMarkdown(actual, target)).toBe(false)
  expect(samePublishedMarkdown(actual, target, undefined, decoded)).toBe(true)
  expect(fromNotionMarkdown(actual, decoded)).toBe(actual)
  expect(
    samePublishedMarkdown(
      actual.replace("http://EXAMPLE.md", "https://EXAMPLE.md"),
      target,
      undefined,
      decoded,
    ),
  ).toBe(false)
})

test("a legacy snapshot or incomplete rich text cannot authorize new syntax repair", () => {
  const legacy = Schema.decodeUnknownSync(NotionBlockBoundarySchema)({
    id: "paragraph",
    type: "paragraph",
    has_children: false,
  })
  expect(samePublishedMarkdown(actual, target, undefined, [legacy])).toBe(false)
  for (const values of [
    richText.map((value) => ({ ...value, annotations: undefined })),
    richText.map((value, index) =>
      index === 1 ? { ...value, plain_text: "foreign text" } : value,
    ),
    richText.map((value, index) =>
      index === 0 ? { ...value, text: { ...value.text, link: {} } } : value,
    ),
    richText.map((value, index) =>
      index === 1 ? { ...value, annotations: { bold: false, code: false } } : value,
    ),
  ]) {
    const blocks = projectNotionBlocks([root(values)])!
    expect(samePublishedMarkdown(actual, target, undefined, blocks)).toBe(false)
  }
})

test("the external URL proof shares annotation repair without losing literal destinations", () => {
  const blocks = projectNotionBlocks([
    root(richText),
    {
      id: "after",
      type: "paragraph",
      has_children: false,
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: { content: "site", link: { url: "https://example.test/exact" } },
            annotations: { bold: false, code: false },
          },
        ],
      },
    },
  ])!
  const suffix = "\n\n[site](https://example.test/exact)"
  expect(
    publicationExternalLinksMatch(actual + suffix, target + suffix, (value) => value, blocks),
  ).toBe(true)
  expect(
    publicationExternalLinksMatch(
      actual + suffix.replace("https:", "http:"),
      target + suffix,
      (value) => value,
      blocks,
    ),
  ).toBe(false)
  expect(publicationExternalLinksMatch(actual + suffix, target + suffix, (value) => value)).toBe(
    false,
  )
})
