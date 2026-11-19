import { expect, test } from "bun:test"
import {
  assertSelectedSharedFileReferences,
  mapSharedMarkdownReferences,
  referenceProse,
  sharedMarkdownReferences,
} from "../src/shared-file-references.ts"
import { normalizeCompletedNativeBody } from "../src/shared-native-body-completion.ts"

test("current reference masking preserves every UTF-16 offset and ignores literal code", () => {
  const markdown =
    "---\nname: 😀\n---\n<!-- 😀 [hidden](missing.md) -->\n<code>😀 [code](missing.md)</code> [guide](references/guide.md#part)\n\n```md\n[example](missing.md)\n```\n"
  const visible = referenceProse(markdown)
  expect(visible.length).toBe(markdown.length)
  expect(visible.indexOf("[guide]")).toBe(markdown.indexOf("[guide]"))
  expect(sharedMarkdownReferences("SKILL.md", markdown)).toEqual([
    {
      from: "SKILL.md",
      target: "references/guide.md",
      href: "references/guide.md#part",
      line: 5,
      kind: "link",
    },
  ])
  const mapped = mapSharedMarkdownReferences("SKILL.md", markdown, (link) =>
    link.href.replace("guide.md", "renamed.md"),
  )
  expect(mapped).toBe(
    markdown.replace("[guide](references/guide.md#part)", "[guide](references/renamed.md#part)"),
  )
  const files = [{ path: "SKILL.md", bytes: new TextEncoder().encode(markdown) }]
  expect(assertSelectedSharedFileReferences(files, ["SKILL.md", "references/guide.md"])).toEqual({
    checked_files: 1,
    local_references: 1,
  })
  expect(() => assertSelectedSharedFileReferences(files, ["SKILL.md"])).toThrow(
    "absent from the complete directory",
  )
})

test("current body normalization changes only transport CRLF and refuses unexplained unknown content", () => {
  const body = "[x](https://example.test/a)\r\n```sh\r\necho '  😀'  \r\n\tkeep\r\n```\r\n"
  expect(normalizeCompletedNativeBody(body)).toBe(body.replaceAll("\r\n", "\n"))
  expect(normalizeCompletedNativeBody(body.replaceAll("\r\n", "\n"))).toBe(
    body.replaceAll("\r\n", "\n"),
  )
  expect(() => normalizeCompletedNativeBody('<unknown url="hidden"/>')).toThrow("unavailable body")
})
