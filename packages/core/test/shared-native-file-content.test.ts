import { expect, test } from "bun:test"
import {
  materializeSharedNativeFile,
  sharedNativeAuthoredBody,
  type SharedFileLink,
} from "../src/shared-native-file-content.ts"
import { fileRef } from "../src/ref.ts"

const main = "00000000-0000-4000-8000-000000000001"
const support = "00000000-0000-4000-8000-000000000002"
const files = [
  { page_id: main, path: "SKILL.md" },
  { page_id: support, path: "references/guide.md" },
]
const ref = fileRef("skill://other?library=00000000-0000-4000-8000-000000000111", "SKILL.md")

test("ordinary native bytes including trailing whitespace are not normalized", () => {
  for (const input of ["body\n", "\nbody\n\n", "body  \n\n"])
    expect(materializeSharedNativeFile(input, "SKILL.md", files)).toBe(input)
})

test("multiline child-page transport is omitted but fenced examples remain literal", () => {
  const page = `<page url="https://app.notion.com/p/${support.replaceAll("-", "")}">\nguide.md\n</page>`
  expect(sharedNativeAuthoredBody(`Content.\n\n${page}`)).toBe("Content.\n")
  expect(sharedNativeAuthoredBody(`\`\`\`html\n${page}\n\`\`\``)).toBe(
    `\`\`\`html\n${page}\n\`\`\``,
  )
})

test("native local links become portable paths while external links and code remain intact", () => {
  const url = `https://www.notion.so/${support.replaceAll("-", "")}`
  const input = `Read [guide](${url}) and [external](https://example.com).\n\n\`[guide](${url})\``
  expect(materializeSharedNativeFile(input, "SKILL.md", files)).toBe(
    `Read [guide](references/guide.md) and [external](https://example.com).\n\n\`[guide](${url})\``,
  )
})

test("native-to-consumer preserves balanced parentheses in an actual resource path", () => {
  const bindings = [{ page_id: support, path: "references/guide(one).md" }]
  const native = `[guide](https://app.notion.com/p/${support.replaceAll("-", "")})`
  const inspected = materializeSharedNativeFile(native, "SKILL.md", bindings)
  expect(inspected).toBe("[guide](references/guide(one).md)")
})

test("explicit cross-Skill links resolve only their exact from-path and destination", () => {
  const links: readonly SharedFileLink[] = [
    { from: "SKILL.md", href: "../other/SKILL.md", target: ref },
  ]
  expect(
    materializeSharedNativeFile("Read [other](../other/SKILL.md)", "SKILL.md", files, links),
  ).toBe(`Read [other](${ref})`)
  expect(
    materializeSharedNativeFile(
      "Read [other](../other/SKILL.md)",
      "references/guide.md",
      files,
      links,
    ),
  ).toContain("../other/SKILL.md")
})

test("a selected immutable repository resource keeps its explicit fixed URL", () => {
  const target = `https://github.com/owner/repo/blob/${"a".repeat(40)}/README.md`
  const links: readonly SharedFileLink[] = [{ from: "SKILL.md", href: "../../README.md", target }]
  expect(materializeSharedNativeFile("[README](../../README.md)", "SKILL.md", files, links)).toBe(
    `[README](${target})`,
  )
})
