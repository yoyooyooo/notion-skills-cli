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

test("ordinary links can name real directories in the complete current tree", () => {
  const files = [
    {
      path: "SKILL.md",
      bytes: new TextEncoder().encode(
        "[docs](docs/) [same directory](docs) [root](./) [nested](docs/nested/?view=all#top)\n",
      ),
    },
  ]
  expect(
    assertSelectedSharedFileReferences(files, [
      "SKILL.md",
      "docs/guide.md",
      "docs/nested/details.md",
    ]),
  ).toEqual({ checked_files: 1, local_references: 4 })
})

test("parent directory links resolve inside the owner, including its root", () => {
  const markdown = "[parent](../) [root](../../) [current](.)\n"
  const files = [{ path: "docs/nested/guide.md", bytes: new TextEncoder().encode(markdown) }]
  expect(assertSelectedSharedFileReferences(files, ["SKILL.md", "docs/nested/guide.md"])).toEqual({
    checked_files: 1,
    local_references: 3,
  })
  expect(mapSharedMarkdownReferences(files[0]!.path, markdown, (reference) => reference.href)).toBe(
    markdown,
  )
})

test("a directory link requires an actual descendant and images still require files", () => {
  for (const markdown of [
    "[missing](missing/)",
    "[partial name](doc/)",
    "![directory](docs/)",
    "![root](./)",
  ]) {
    expect(() =>
      assertSelectedSharedFileReferences(
        [{ path: "SKILL.md", bytes: new TextEncoder().encode(markdown) }],
        ["SKILL.md", "docs/guide.md"],
      ),
    ).toThrow("absent from the complete directory")
  }
})

test("directory support does not authorize escapes, absolute paths or malformed destinations", () => {
  for (const href of ["../../other/", "%2Foutside/", "bad%ZZ/"]) {
    expect(() =>
      assertSelectedSharedFileReferences(
        [{ path: "docs/guide.md", bytes: new TextEncoder().encode(`[unsafe](${href})`) }],
        ["SKILL.md", "docs/guide.md"],
      ),
    ).toThrow()
  }
})

test("escaped HTML is literal Markdown while unescaped asset attributes remain references", () => {
  const literal =
    '\\<a href="./[SPONSORS.md](http://SPONSORS.md)">\\</a> \\<img src="missing.png">\n'
  expect(sharedMarkdownReferences("README.md", literal)).toEqual([])
  expect(
    assertSelectedSharedFileReferences(
      [{ path: "README.md", bytes: new TextEncoder().encode(literal) }],
      ["README.md"],
    ),
  ).toEqual({ checked_files: 1, local_references: 0 })
  for (const markdown of [
    '<a href="missing.md">real</a>',
    '\\\\<a href="missing.md">real</a>',
    '<img src="missing.png">',
    '\\\\<img src="missing.png">',
    '\\<a href="[authored Markdown](missing.md)">',
  ])
    expect(() =>
      assertSelectedSharedFileReferences(
        [{ path: "README.md", bytes: new TextEncoder().encode(markdown) }],
        ["README.md"],
      ),
    ).toThrow("absent from the complete directory")
})
