import { expect, test } from "bun:test"
import {
  compareNativeMarkdown,
  nativeFileTransport,
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

test("native hyperlink equivalence preserves a root selection and complete reference definitions", () => {
  const ref = "skill://router?library=45c64249-e1dd-59ab-ad9f-604ff752ddb4"
  const wire = "skill://router/entrypoint.md/..?library=45c64249-e1dd-59ab-ad9f-604ff752ddb4"
  const expected = `[**run**][ref]\n\n[ref]: ${ref}`
  expect(compareNativeMarkdown({ expected, observed: `[**run**](${wire})` })).toBe("normalized")
  expect(nativeMarkdownTransport(expected)).toBe(expected)
  expect(
    compareNativeMarkdown({
      expected: `[run](${ref})\n\n[extra]: skill://other`,
      observed: `[run](${wire})`,
    }),
  ).toBe("different")
  for (const changed of [
    wire.replace("router/", "other/"),
    wire.replace("/..?", "/../SKILL.md?"),
    wire.replace("45c64249", "55c64249"),
    wire + "&snapshot=s_" + "a".repeat(64),
  ])
    expect(
      compareNativeMarkdown({ expected: `[run](${ref})`, observed: `[run](${changed})` }),
    ).toBe("different")
})

test.each([
  ["skill://router", "skill://router/entrypoint.md/.."],
  ["skill://router/entrypoint.md/..", "skill://router/entrypoint.md/../entrypoint.md/.."],
])(
  "native wire equivalence never changes literal text, code or image sources: %s",
  (input, wire) => {
    for (const wrap of [
      (href: string) => `Literal ${href}`,
      (href: string) => "`" + href + "`",
      (href: string) => "```text\n" + href + "\n```",
      (href: string) => `![image](${href})`,
    ])
      expect(compareNativeMarkdown({ expected: wrap(input), observed: wrap(wire) })).toBe(
        "different",
      )
  },
)

test("native code fences recognize Notion's sh-to-bash spelling without changing payload or transport", () => {
  const expected = "```sh\nntn-skills read EXACT_REF --library ENTRY --json\n```\n"
  const observed = expected.replace("```sh", "```bash")
  expect(compareNativeMarkdown({ expected, observed })).toBe("normalized")
  expect(nativeMarkdownTransport(expected)).toBe(expected)
  expect(
    compareNativeMarkdown({ expected, observed: observed.replace("--json", "--output FILE") }),
  ).toBe("different")
  expect(
    compareNativeMarkdown({ expected, observed: observed.replace("```bash", "```python") }),
  ).toBe("different")
})

test.each(["SKILL.md", "SKILL\\.md"])(
  "native comparison rejects an unexpected filename link even when the input is escaped: %s",
  (filename) => {
    expect(
      compareNativeMarkdown({
        expected: `A new Skill requires root ${filename}.`,
        observed: "A new Skill requires root [SKILL.md](http://SKILL.md).",
      }),
    ).toBe("different")
  },
)

test.each([
  ["Use `code`.", "Use <code>code</code>."],
  ["`&amp;` and `` `literal` ``.", "<code>&amp;</code> and <code>`literal`</code>."],
  [
    "**Use `code`** and [`label`](https://example.com).",
    "<b>Use <code>code</code></b> and [<code>label</code>](https://example.com/).",
  ],
  [
    "`` `[fake](missing.md) `` then ~`real` [go][ref].\n\n[ref]: https://example.com",
    "<code>`[fake](missing.md)</code> then ~`real` [go][ref].\n\n[ref]: https://example.com/",
  ],
  ["`<code>`", "<code><code></code>"],
  ["| A |\n|---|\n| `x &amp;` |", "| A |\n|---|\n| <code>x &amp;</code> |"],
])(
  "native inline code preserves literal content and its surrounding context: %s",
  (expected, observed) => {
    expect(() => validateNativeMarkdown(observed)).not.toThrow()
    expect(compareNativeMarkdown({ expected, observed })).toBe("normalized")
    expect(compareNativeMarkdown({ expected: observed, observed })).toBe("exact")
  },
)

test("native code tags cannot reinterpret entities, hide real links or turn escaped tags into code", () => {
  for (const [expected, observed] of [
    ["`&amp;`", "<code>&</code>"],
    ["`[label](a.md)`", "<code>[label](b.md)</code>"],
    [
      "`` `literal `` [real](https://example.com/a)",
      "<code>`literal</code> [real](https://example.com/b)",
    ],
    ["\\<code>x\\</code>", "<code>x</code>"],
  ] as const)
    expect(compareNativeMarkdown({ expected, observed })).toBe("different")
  for (const malformed of ["<code>unclosed", '<code class="unsafe">text</code>', "text</code>"])
    expect(() => validateNativeMarkdown(malformed)).toThrow()
})

test("native transport folds soft wraps and Markdown code-span line endings", () => {
  const source =
    'Read the selected\nmetadata, then use `ntn-skills read\n--json` with **complete\ncontext** and [the\nsource](https://example.com/a?next=one%20two "Stable title").\n'
  const wire =
    'Read the selected metadata, then use `ntn-skills read --json` with **complete context** and [the source](https://example.com/a?next=one%20two "Stable title").\n'
  expect(nativeMarkdownTransport(source)).toBe(wire)
  expect(compareNativeMarkdown({ expected: source, observed: wire })).toBe("normalized")
})

test("native file transport preserves line boundaries outside the Markdown path domain", () => {
  const markdown = "#!/bin/sh\r\nprintf 'installed current original\\n'"
  expect(nativeFileTransport({ path: "scripts/run.sh", markdown })).toBe(
    markdown.replaceAll("\r\n", "\n"),
  )
  expect(nativeFileTransport({ path: "notes.MARKDOWN", markdown: "soft\nwrap" })).toBe("soft wrap")
  expect(nativeFileTransport({ path: "notes.md", markdown: "soft\nwrap" })).toBe("soft wrap")
})

test.each([
  "https://example.com/docs",
  "<https://example.com/docs>",
  "[https://example.com/docs](https://example.com/target)",
])("native transport preserves literal autolink labels without re-lexing them: %s", (link) => {
  const source = `See ${link}\nfor more.`
  const wire = `See ${link} for more.`
  expect(nativeMarkdownTransport(source)).toBe(wire)
  expect(compareNativeMarkdown({ expected: source, observed: wire })).toBe("normalized")
  expect(
    compareNativeMarkdown({
      expected: source,
      observed: wire.replaceAll("example.com", "changed.example"),
    }),
  ).toBe("different")
})

test("native transport preserves explicit breaks, fenced payloads and native code literals", () => {
  const source = [
    "An explicit two-space break  ",
    "then a backslash break\\",
    "then an HTML<br />break.",
    "",
    "```bash",
    "  printf 'first\\nsecond'",
    "",
    "```",
    "",
    "Native <code>a\nb<br>&amp;</code> stays literal.",
    "",
    '[stable](https://example.com/a?x=1&amp;y=2 "Stable title")',
    "",
    "[unused]: https://example.com/ref?next=x%20y",
    "",
  ].join("\n")
  expect(nativeMarkdownTransport(source)).toBe(source)
  expect(
    compareNativeMarkdown({
      expected: source,
      observed: source.replace("<code>a\nb<br>&amp;</code>", "<code>a b<br>&amp;</code>"),
    }),
  ).toBe("different")
})

test("native transport retains nested list and quote structure while folding their soft wraps", () => {
  const source = [
    "> 3. Parent `ntn-skills",
    ">    list` and wrapped",
    ">    context.",
    ">",
    ">    - Child label",
    ">      continues with [guide](https://example.com/guide).",
    ">",
    ">      ```text",
    ">      line one",
    ">        line two",
    ">      ```",
    ">",
    "> 4. Next item.",
  ].join("\n")
  const wire = nativeMarkdownTransport(source)
  expect(wire).toContain("Parent `ntn-skills list` and wrapped context.")
  expect(wire).toContain("Child label continues with [guide](https://example.com/guide).")
  expect(compareNativeMarkdown({ expected: source, observed: wire })).toBe("normalized")
  expect(compareNativeMarkdown({ expected: source, observed: wire.replace(/^> ?/gmu, "") })).toBe(
    "different",
  )
})

test("native transport preserves the checked state of tight task items with soft wraps", () => {
  const source = "- [x] Child label\n  continues.\n- [ ] Next item."
  const wire = nativeMarkdownTransport(source)
  expect(wire).toContain("- [x] Child label continues.")
  expect(compareNativeMarkdown({ expected: source, observed: wire })).toBe("normalized")
  expect(
    compareNativeMarkdown({ expected: source, observed: wire.replace("- [x]", "- [ ]") }),
  ).toBe("different")
})

test("native transport preserves trailing payload lines in an unclosed fence inside a changed list", () => {
  const source = "- soft\n  wrap\n\n  ```txt\n  keep\n\n"
  const wire = nativeMarkdownTransport(source)
  expect(wire).toContain("- soft wrap")
  expect(compareNativeMarkdown({ expected: source, observed: wire })).toBe("normalized")
})

test("native readback accepts a paragraph child after a fenced block in a list item", () => {
  const expected = [
    "1. Discover without loading bodies:",
    "",
    "   ```bash",
    "   ntn-skills list --library ENTRY --query 'TASK_TERMS'",
    "   ```",
    "",
    "   Use the connected library's ENTRY; continue with `next_cursor`.",
  ].join("\n")
  const observed = [
    "1. Discover without loading bodies:",
    "   ```bash",
    "   ntn-skills list --library ENTRY --query 'TASK_TERMS'",
    "   ```",
    "",
    "   <p>",
    "   Use the connected library's ENTRY; continue with <code>next_cursor</code>.",
    "   </p>",
  ].join("\n")
  expect(() => validateNativeMarkdown(observed)).not.toThrow()
  expect(compareNativeMarkdown({ expected, observed })).toBe("normalized")
  expect(
    compareNativeMarkdown({
      expected,
      observed: observed.replace("\n   <p>\n   Use", "\n<p>\nUse").replace("\n   </p>", "\n</p>"),
    }),
  ).toBe("different")
  expect(
    compareNativeMarkdown({ expected, observed: observed.replace("next_cursor", "cursor") }),
  ).toBe("different")
})

test.each([
  ["Use `ntn-skills read\n--json`.", "Use <code>ntn-skills read<br>--json</code>."],
  ["Wrapped\nprose.", "Wrapped<br />prose."],
  ["First.\n\nSecond.", "<p>\nFirst. Second.\n</p>"],
  ["Body.", '<p class="unknown">\nBody.\n</p>'],
  ["Body.", "<p>\nBody."],
  ["Body.", "<p>\nBody.\n\n</p>"],
  ["[guide](https://example.com/a)", "<p>\n[guide](https://example.com/b)\n</p>"],
  ["[guide](https://example.com/a)", "<p>\n[changed](https://example.com/a)\n</p>"],
])(
  "native paragraph and inline normalization cannot hide a change from %s",
  (expected, observed) => {
    expect(compareNativeMarkdown({ expected, observed })).toBe("different")
  },
)

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
