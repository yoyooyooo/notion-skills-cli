import { expect, test } from "bun:test"
import { compareNativeMarkdown } from "../src/shared-native-markdown.ts"
import { nativePlainTextPlan } from "../src/shared-native-plain-text.ts"

test("a write plan identifies only added links on the exact original plain spans", () => {
  const expected = "A new Skill requires root SKILL.md. Source options.storage are rejected."
  const observed =
    "A new Skill requires root [SKILL.md](http://SKILL.md). Source [options.storage](http://options.storage) are rejected."
  expect(compareNativeMarkdown({ expected, observed })).toBe("different")
  const plan = nativePlainTextPlan({ expected, observed })
  expect(plan).toHaveLength(1)
  expect(plan?.[0]?.expected).toMatchObject([
    { kind: "text", text: expected, code: false, link: null },
  ])
  expect(nativePlainTextPlan({ expected, observed: expected })).toHaveLength(1)
  expect(compareNativeMarkdown({ expected, observed })).toBe("different")
})

test("the plan preserves existing links, code, styles, nested structures and complete definitions", () => {
  const expected =
    "# **SKILL.md**\n\n> Read options.storage and [authored](https://example.com) with `SKILL.md`.\n>\n> 1. Keep SKILL.md.\n>\n>    ```sh\n>    printf 'SKILL.md\\n'\n>    ```\n\n| Name | Value |\n|---|---|\n| SKILL.md | options.storage |\n\nhttps://example.com\n"
  const observed = expected
    .replace("**SKILL.md**", "**[SKILL.md](http://SKILL.md)**")
    .replace("Read options.storage", "Read [options.storage](http://options.storage)")
    .replace("Keep SKILL.md", "Keep [SKILL.md](http://SKILL.md)")
    .replace(
      "| SKILL.md | options.storage |",
      "| [SKILL.md](http://SKILL.md) | [options.storage](http://options.storage) |",
    )
  expect(nativePlainTextPlan({ expected, observed })).toBeDefined()
  expect(compareNativeMarkdown({ expected, observed })).toBe("different")
  expect(
    nativePlainTextPlan({
      expected,
      observed: observed.replace("https://example.com", "https://other.example"),
    }),
  ).toBeUndefined()
  expect(
    nativePlainTextPlan({ expected: expected + "\n[unused]: https://retained.example", observed }),
  ).toBeUndefined()
})

test.each([
  ["SKILL.md", "[SKILL.md](https://different.example)"],
  ["SKILL.md", "[OTHER.md](http://OTHER.md)"],
  ["**SKILL.md**", "[SKILL.md](http://SKILL.md)"],
  ["`SKILL.md`", "[SKILL.md](http://SKILL.md)"],
  ["[SKILL.md](https://original.example)", "[SKILL.md](http://SKILL.md)"],
  ["Read `a b`.", "Read <code>a<br>b</code>."],
  ["# SKILL.md", "## [SKILL.md](http://SKILL.md)"],
  [
    "SKILL.md\n\noptions.storage",
    "[SKILL.md](http://SKILL.md) [options.storage](http://options.storage)",
  ],
  ["- parent\n  - SKILL.md", "- parent\n- [SKILL.md](http://SKILL.md)"],
  ["```sh\nSKILL.md\n```", "```sh\n[SKILL.md](http://SKILL.md)\n```"],
])("the management plan rejects an unrelated change: %s", (expected, observed) => {
  expect(nativePlainTextPlan({ expected, observed })).toBeUndefined()
  expect(compareNativeMarkdown({ expected, observed })).toBe("different")
})
