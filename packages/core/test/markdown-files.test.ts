import { expect, test } from "bun:test"
import {
  decodeMarkdownFiles,
  markdownFileChunks,
  markdownFilesHeader,
} from "../src/markdown-files.ts"
import { property } from "../src/model.ts"

const span = (content: string) => ({
  type: "text",
  text: { content, link: null },
  plain_text: content,
})
const block = (id: string, type: string, owner: string, body: unknown, has_children = false) => ({
  id,
  type,
  has_children,
  parent: {
    type: owner === "page" ? "page_id" : "block_id",
    [owner === "page" ? "page_id" : "block_id"]: owner,
  },
  [type]: body,
})
const file = (path: string, contents: string[], id = path) => [
  block(id, "toggle", "page", { rich_text: [span(path)] }, true),
  ...contents.map((text, i) =>
    block(`${id}:${i}`, "code", id, { rich_text: [span(text)], caption: [], language: "markdown" }),
  ),
]
function fixture() {
  return [
    block("marker", "paragraph", "page", { rich_text: [span(markdownFilesHeader("SKILL.md"))] }),
    ...file("SKILL.md", [
      "---\nname: Demo\n---\n\n# Task\n\n",
      "```sh\nprintf '%s\\n' '<keep>'\n```\n",
    ]),
    ...file("references/中文.md", ["# Guide\n\n[local](../SKILL.md)\n"]),
    ...file("empty.txt", [""]),
  ]
}
test("editable file consumption preserves complete code, resource links, Unicode and empty files", () => {
  const source = fixture(),
    before = JSON.stringify(source),
    parsed = decodeMarkdownFiles(source)!
  expect(parsed.main).toBe("SKILL.md")
  expect(parsed.files.map((file) => file.path)).toEqual([
    "SKILL.md",
    "references/中文.md",
    "empty.txt",
  ])
  expect(new TextDecoder().decode(parsed.files[0]!.bytes)).toBe(
    "---\nname: Demo\n---\n\n# Task\n\n```sh\nprintf '%s\\n' '<keep>'\n```\n",
  )
  expect(new TextDecoder().decode(parsed.files[1]!.bytes)).toBe("# Guide\n\n[local](../SKILL.md)\n")
  expect(parsed.files[2]!.bytes).toEqual(new Uint8Array())
  expect(JSON.stringify(source)).toBe(before)
})
test("a Notion code edit becomes the next source without an archive fallback", () => {
  const blocks = fixture()
  property(blocks[2]!.code).rich_text = [span("Edited actual source.\n")]
  expect(new TextDecoder().decode(decodeMarkdownFiles(blocks)!.files[0]!.bytes)).toStartWith(
    "Edited actual source.\n",
  )
})
for (const issue of [
  "duplicate",
  "traversal",
  "extra-prose",
  "missing-code",
  "wrong-parent",
  "linked-span",
] as const) {
  test(`incomplete or ambiguous file tree refuses ${issue}`, () => {
    const blocks = fixture()
    if (issue === "duplicate") blocks.push(...file("SKILL.md", ["Changed"], "duplicate"))
    if (issue === "traversal") property(blocks[1]!.toggle).rich_text = [span("../escape.md")]
    if (issue === "extra-prose")
      blocks.push(block("extra", "paragraph", "page", { rich_text: [span("Do not omit.")] }))
    if (issue === "missing-code") blocks.splice(2, 2)
    if (issue === "wrong-parent") blocks[2]!.parent = { type: "block_id", block_id: "foreign" }
    if (issue === "linked-span")
      property(blocks[2]!.code).rich_text = [
        { ...span("code"), text: { content: "code", link: { url: "https://example.test" } } },
      ]
    expect(() => decodeMarkdownFiles(blocks)).toThrow()
  })
}
test("native span boundaries preserve surrogate pairs and literal line endings", () => {
  const value = "x".repeat(1999) + "🙂\r\n" + "y".repeat(100004)
  const chunks = markdownFileChunks(value, 2000)
  expect(chunks.join("")).toBe(value)
  expect(chunks.every((chunk) => chunk.length <= 2000 && !/[\uD800-\uDBFF]$/.test(chunk))).toBe(
    true,
  )
})
