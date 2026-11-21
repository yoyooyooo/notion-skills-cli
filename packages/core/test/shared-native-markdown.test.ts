import { expect, test } from "bun:test"
import {
  compareNativeMarkdown,
  nativeMarkdownTransport,
  validateNativeMarkdown,
} from "../src/shared-native-markdown.ts"

test("native comparison admits presentation normalization across a complete Markdown document", () => {
  const expected =
    "# Notes\r\n\r\nA _word_ and **strong** [link](https://example.com).\r\n\r\n* first\r\n* second\r\n\r\n1. one\r\n2. two\r\n\r\n- [x] complete\r\n\r\n> quoted\r\n\r\n~~~js\r\nconst answer = 42\r\n~~~\r\n\r\n| A | B |\r\n|---|---|\r\n| one | two |\r\n"
  const observed =
    "Notes\n=====\n\nA *word* and __strong__ [link](https://example.com/).\n\n- first\n- second\n\n1. one\n2. two\n\n- [x] complete\n\n> quoted\n\n```javascript\nconst answer = 42\n```\n\n|A|B|\n|---|---|\n|one|two|"
  expect(compareNativeMarkdown({ expected, observed })).toBe("normalized")
  expect(compareNativeMarkdown({ expected: observed, observed })).toBe("exact")
  expect(nativeMarkdownTransport(expected)).toBe(expected.replaceAll("\r\n", "\n"))
})

test.each([
  ["one two", "one"],
  ["# Heading", "## Heading"],
  ["[label](https://example.com/a)", "[label](https://example.com/b)"],
  ["[label](https://example.com)", "[changed](https://example.com)"],
  ["```python\n  print(1)\n```", "```python\nprint(1)\n```"],
  ["```text\nline\n\n```", "```text\nline\n```"],
  ["- parent\n  - child", "- parent\n- child"],
  ["- [x] done", "- [ ] done"],
  ["3. start", "1. start"],
  ["| A |\n|---|\n| one |", "| A |\n|---|\n| two |"],
  ["a\n\nb", "a b"],
  ["**bold**", "bold"],
])("native comparison rejects a material change from %s", (expected, observed) => {
  expect(compareNativeMarkdown({ expected, observed })).toBe("different")
})

test("native comparison retains link definitions and escaped or code text", () => {
  expect(
    compareNativeMarkdown({
      expected: "[link][ref]\n\n[ref]: https://example.com",
      observed: "[link](https://example.com/)",
    }),
  ).toBe("normalized")
  expect(
    compareNativeMarkdown({ expected: "Text\n\n[unused]: https://example.com", observed: "Text" }),
  ).toBe("different")
  expect(compareNativeMarkdown({ expected: "A &amp; B", observed: "A & B" })).toBe("normalized")
  expect(compareNativeMarkdown({ expected: "`&amp;`", observed: "`&`" })).toBe("different")
  expect(compareNativeMarkdown({ expected: "a\\\nb", observed: "a<br />b" })).toBe("normalized")
  expect(compareNativeMarkdown({ expected: "**bold**", observed: "<b>bold</b>" })).toBe(
    "normalized",
  )
})

test("native admission rejects unknown structures before a write, including unsupported encoding", () => {
  for (const markdown of [
    '<custom-block definition-id="x" />',
    "<div>text</div>",
    "    indented code",
    "##### too deep",
    "x\ry",
    "\uFEFFbody",
    "body\u0000",
    "![inline](https://example.com/image.png) text",
  ]) {
    expect(() => validateNativeMarkdown(markdown)).toThrow()
  }
  expect(() => validateNativeMarkdown("# Native\r\n\r\nText\r\n")).not.toThrow()
  expect(compareNativeMarkdown({ expected: "Text", observed: "<unknown />" })).toBe("different")
})
