import { expect, test } from "bun:test"
import { mapMarkdownLinks } from "../src/typed-links.ts"

const page = "https://www.notion.so/00000000000040008000000000000001"
test("current link mapping keeps inline, native and fenced code literal", () => {
  const markdown = `[\`code label\`](${page}) and \`[example](${page})\`\n\n<code>[native](${page})</code>\n\n\`\`\`md\n[fenced](${page})\n\`\`\`\n`
  const seen: string[] = []
  const output = mapMarkdownLinks(markdown, (url) => {
    seen.push(url)
    return "references/guide.md"
  })
  expect(seen).toEqual([page])
  expect(output).toBe(
    markdown.replace(`[\`code label\`](${page})`, "[\`code label\`](references/guide.md)"),
  )
})

test("astral text hidden before a current link never shifts its authored destination", () => {
  for (const prefix of ["<code>😀</code> ", "<!--😀--> ", "---\nname: 😀\n---\n"]) {
    const markdown = `${prefix}[Guide](${page}) tail`,
      seen: string[] = []
    const output = mapMarkdownLinks(markdown, (url) => {
      seen.push(url)
      return "references/guide.md"
    })
    expect(seen).toEqual([page])
    expect(output).toBe(`${prefix}[Guide](references/guide.md) tail`)
  }
})
