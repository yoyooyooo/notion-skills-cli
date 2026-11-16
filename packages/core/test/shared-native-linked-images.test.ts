import { expect, test } from "bun:test"
import { SourceLexer } from "@notion-skills-cli/markdown"
import {
  projectNativeImageBlocks,
  projectNativeLinkedImages,
} from "../src/shared-native-image-layout.ts"
import { assertImportedMarkdownContent } from "../src/shared-import-markdown.ts"

test("linked-image projection preserves image and destination while making standalone blocks", () => {
  const original =
    '# Before\n\n[![Grant badge](https://img.example/grant.svg)](https://example.org/grant "Grant")\n\nAfter.\n'
  const projected = projectNativeLinkedImages(original)
  expect(projected.kind).toBe("changed")
  if (projected.kind !== "changed") throw new Error("Expected a linked image")
  expect(projected.policy).toBe("native_linked_images_v2")
  expect(projected.markdown).toBe(
    '# Before\n\n![Grant badge](https://img.example/grant.svg)\n\n[Grant badge](https://example.org/grant "Grant")\n\nAfter.\n',
  )
  expect(projected.summary.detached_linked_images).toBe(1)
  expect(projectNativeImageBlocks(original)).toMatchObject({
    kind: "unchanged",
    markdown: original,
  })
  // The old general validator must not silently bless this new representation.
  expect(() => assertImportedMarkdownContent(original, projected.markdown)).toThrow()
  expect(() =>
    assertImportedMarkdownContent(
      projected.markdown,
      projected.markdown.replace('/grant "', '/other "'),
    ),
  ).toThrow()
})

test("spacing and linked images compose without changing unrelated code or HTML", () => {
  const images =
    "[![A](https://img.example/a.svg)](https://example.org/a)\n![B](https://img.example/b.svg)"
  const code =
    "\n\n```md\n" +
    images +
    '\n```\n\n<a href="https://example.org/html"><img src="https://img.example/h.svg"></a>\n'
  const projected = projectNativeLinkedImages(images + code)
  expect(projected.kind).toBe("changed")
  if (projected.kind !== "changed") throw new Error("Expected a linked image")
  expect(projected.summary).toMatchObject({
    paragraphs: 1,
    images: 2,
    linked_images: 1,
    inserted_line_feeds: 1,
    detached_linked_images: 1,
  })
  expect(projected.markdown.endsWith(code)).toBe(true)
  const paragraphs = SourceLexer.lex(projected.markdown).filter(
    (token) => token.type === "paragraph",
  )
  expect(
    paragraphs.slice(0, 3).map((p) => (p.type === "paragraph" ? p.tokens?.[0]?.type : undefined)),
  ).toEqual(["image", "link", "image"])
})

test.each([
  "Text [![A](https://img.example/a)](https://example.org/a) after",
  "- [![A](https://img.example/a)](https://example.org/a)",
  "`[![A](https://img.example/a)](https://example.org/a)`",
  "![A](https://img.example/a)",
])("mixed or nested source is not rewritten: %s", (source) => {
  expect(projectNativeLinkedImages(source)).toMatchObject({ kind: "unchanged", markdown: source })
})

test("reference links are explicitly unsupported rather than inventing a target serialization", () => {
  const source =
    "[![A](https://img.example/a)][destination]\n\n[destination]: https://example.org/a"
  expect(() => projectNativeLinkedImages(source)).toThrow()
})

test("punctuation in a copied label cannot create extra markup or change the explicit href", () => {
  const source = "[![A *bold*](https://img.example/a)](https://example.org/a)"
  const projected = projectNativeLinkedImages(source)
  expect(projected.kind).toBe("changed")
  expect(projected.markdown).toContain("[A \\*bold\\*](https://example.org/a)")
  expect(projected.markdown).toContain("![A *bold*](https://img.example/a)")
})
