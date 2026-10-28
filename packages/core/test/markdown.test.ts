import { expect, test } from "bun:test"
import {
  fromNotionMarkdown,
  markdownIdentity,
  projectNotionBlocks,
  samePublishedMarkdown,
} from "../src/markdown.ts"

const source = [
  "| Fact | Value |",
  "| --- | --- |",
  "| Supervisor | launchd `RunAtLoad` + `KeepAlive` |",
  "",
  "Follow the commands:",
  "",
  "```bash",
  "first --arg +literal",
  "",
  "second --arg next",
  "```",
  "",
  "- Check the host.",
  "- Check the node.",
  "",
  "Stop before changing configuration.",
  "",
  "[guide](./references/guide.md)",
].join("\n")
const readback = [
  '<table header-row="true">',
  "<tr><td>Fact</td><td>Value</td></tr>",
  "<tr><td>Supervisor</td><td>launchd `RunAtLoad` + `KeepAlive`</td></tr>",
  "</table>",
  "Follow the commands:",
  "```bash",
  "first --arg +literal",
  "",
  "second --arg next",
  "```",
  "- Check the host.",
  "- Check the node.",
  "Stop before changing configuration.",
  "[guide](./references/guide.md)",
].join("\n")

test("v1 block boundaries preserve tables, complete code blocks and paragraphs after lists", () => {
  expect(markdownIdentity(fromNotionMarkdown(readback))).toBe(markdownIdentity(source))
})

test("Notion readback normalization is idempotent", () => {
  const once = fromNotionMarkdown(readback)
  expect(fromNotionMarkdown(once)).toBe(once)
  const notion = [
    "> **来源**<br>官方博客 \\> 转载",
    '<table header-row="true">',
    "<tr><td>A</td><td>B</td></tr>",
    "<tr><td>1</td><td>2</td></tr>",
    "</table>",
    "",
    "```javascript",
    "keep",
    "```",
    "",
    "---",
    "",
    "Next",
  ].join("\n")
  const normalized = fromNotionMarkdown(notion)
  expect(fromNotionMarkdown(normalized)).toBe(normalized)
  expect(fromNotionMarkdown(fromNotionMarkdown(normalized))).toBe(normalized)
})

for (const [name, original, changed] of [
  ["table cell", " + `KeepAlive`", " • `KeepAlive`"],
  ["command argument", "+literal", "literal"],
  ["code blank line", "+literal\n\nsecond", "+literal\nsecond"],
  ["link destination", "./references/guide.md", "./references/other.md"],
  ["list inclusion", "\nStop before", "\n- Stop before"],
] as const) {
  test(`saved-content verification rejects a changed ${name}`, () => {
    expect(markdownIdentity(fromNotionMarkdown(readback.replace(original, changed)))).not.toBe(
      markdownIdentity(source),
    )
  })
}

test("saved-content verification preserves reference-link destinations and executable code languages", () => {
  const input =
    "Read [guide][id].\n\n[id]: https://example.com/original\n\n```bash\necho ready\n```"
  expect(markdownIdentity(input)).not.toBe(markdownIdentity(input.replace("/original", "/changed")))
  expect(markdownIdentity(input)).not.toBe(markdownIdentity(input.replace("```bash", "```python")))
  expect(markdownIdentity(input)).toBe(markdownIdentity(input.replace("```bash", "```shell")))
})

test("v1 split emphasis keeps code-adjacent text and reference links", () => {
  const source =
    "- **`egress_ip` empty**: read **[guide][id]**.\n\n[id]: https://example.com/original"
  const saved =
    "- **`egress_ip`**** empty**: read **[guide][id]**.\n\n[id]: https://example.com/original"
  expect(markdownIdentity(fromNotionMarkdown(saved))).toBe(markdownIdentity(source))
  expect(markdownIdentity(source)).not.toBe(
    markdownIdentity(source.replace("/original", "/changed")),
  )
})

test("Notion inline break readback matches submitted soft and hard paragraph breaks", () => {
  const source = "First instruction\nRead [guide](./references/guide.md)."
  for (const separator of ["<br>", "<br/>", "<br />", " <br> ", "  \n", "\\\n"]) {
    const saved = source.replace("\n", separator)
    expect(markdownIdentity(fromNotionMarkdown(saved))).toBe(markdownIdentity(source))
  }
  expect(markdownIdentity(source.replace("\n", "<br>"))).not.toBe(
    markdownIdentity(source.replace("\n", "")),
  )
})

test("inline break normalization preserves literal code and unrelated HTML", () => {
  for (const source of [
    "`first<br>second`",
    "```text\nfirst<br>second\n```",
    "    first<br>second",
  ]) {
    expect(fromNotionMarkdown(source)).toContain("first<br>second")
    expect(markdownIdentity(fromNotionMarkdown(source))).not.toBe(
      markdownIdentity(source.replace("<br>", " ")),
    )
  }
  for (const source of [
    'first<br class="custom">second',
    "first<hr>second",
    "first&lt;br&gt;second",
  ]) {
    expect(markdownIdentity(source)).not.toBe(markdownIdentity("first second"))
  }
  expect(markdownIdentity("first<br>second")).not.toBe(markdownIdentity("first<br>changed"))
  expect(markdownIdentity("[guide](./references/guide.md)<br>Read it.")).not.toBe(
    markdownIdentity("[guide](./references/other.md)<br>Read it."),
  )
})

test("published comparison accepts Notion inline-code wraps and split links", () => {
  const target = [
    "- [`ws` — workspaces](#ws--workspaces)",
    "",
    "Use `wait --until free` and `tty7 send 83 --enter`.",
    "",
    "Table: `PANE AGENT STATUS MESSAGE`.",
  ].join("\n")
  const actual = [
    "- [`ws`](#ws--workspaces)[ — workspaces](#ws--workspaces)",
    "",
    "Use `wait<br>  --until free` and `tty7 send 83<br>--enter`.",
    "",
    "Table: `PANE AGENT STATUS<br>MESSAGE`.",
  ].join("\n")
  expect(samePublishedMarkdown(actual, target)).toBe(true)
  expect(samePublishedMarkdown(actual.replace("free", "busy"), target)).toBe(false)
  expect(samePublishedMarkdown(actual.replaceAll("#ws--workspaces", "#other"), target)).toBe(false)
  expect(markdownIdentity(fromNotionMarkdown("`first<br>second`"))).not.toBe(
    markdownIdentity("`first second`"),
  )
})

test("published comparison accepts page mentions lifted out of a list", () => {
  const target = [
    "- Read `references/commands.md` for the flags.",
    '<page url="https://app.notion.com/p/3fe5636c236e81398666f73564f0f877">commands.md</page>',
  ].join("\n")
  const actual = [
    "- Read `references/commands.md` for the flags.",
    "",
    '<page url="https://app.notion.com/p/3fe5636c236e81398666f73564f0f877">commands.md</page>',
  ].join("\n")
  expect(samePublishedMarkdown(actual, target)).toBe(true)
  expect(samePublishedMarkdown(actual.replace("flags", "verbs"), target)).toBe(false)
})

test("published comparison accepts rewritten page links lifted out of a list", () => {
  const target = [
    "- Read `references/commands.md` for the flags.",
    "[commands.md](skill://3fe5636c-236e-8139-8666-f73564f0f877/)",
  ].join("\n")
  const actual = [
    "- Read `references/commands.md` for the flags.",
    "",
    "[commands.md](skill://3fe5636c-236e-8139-8666-f73564f0f877/)",
  ].join("\n")
  expect(samePublishedMarkdown(actual, target)).toBe(true)
  expect(
    samePublishedMarkdown(actual.replace("3fe5636c-236e-8139-8666-f73564f0f877", "other"), target),
  ).toBe(false)
})

test("published comparison accepts Notion page hosts and bold split around a link", () => {
  const id = "3fd5636c236e81459d2dd39de0912ebe"
  const sdk = "https://developers.cloudflare.com/agents/"
  const target = [
    `1. Read [cli-and-mcp.md](https://www.notion.so/${id}).`,
    "",
    "| Use |",
    "| --- |",
    `| **Send emails from an AI agent built with [Cloudflare Agents SDK](${sdk})** |`,
  ].join("\n")
  const actual = [
    `1. Read [cli-and-mcp.md](https://app.notion.com/p/${id}).`,
    "",
    "| Use |",
    "| --- |",
    `| **Send emails from an AI agent built with **[**Cloudflare Agents SDK**](${sdk}) |`,
  ].join("\n")
  expect(samePublishedMarkdown(actual, target)).toBe(true)
  expect(
    samePublishedMarkdown(actual.replace(id, "3fd5636c236e81459d2dd39de0912ebf"), target),
  ).toBe(false)
  expect(samePublishedMarkdown(actual.replace("Send emails", "Ship mail"), target)).toBe(false)
  expect(samePublishedMarkdown(actual.replace(sdk, "https://example.com/other"), target)).toBe(
    false,
  )
  expect(
    samePublishedMarkdown(
      `[cli-and-mcp.md](https://app.notion.com/p/${id}#section)`,
      `[cli-and-mcp.md](https://www.notion.so/${id})`,
    ),
  ).toBe(false)
  expect(
    samePublishedMarkdown(
      "**Send emails from an AI agent built with **done",
      "Send emails from an AI agent built with done",
    ),
  ).toBe(false)
  expect(
    samePublishedMarkdown(
      String.raw`\*\*Read \*\*[guide](https://example.com/)`,
      "Read [guide](https://example.com/)",
    ),
  ).toBe(false)
  expect(
    samePublishedMarkdown(
      String.raw`\**Read **[guide](https://example.com/)`,
      "Read [guide](https://example.com/)",
    ),
  ).toBe(false)
  expect(samePublishedMarkdown("# keep the heading", "keep the heading")).toBe(false)
})

test("published comparison accepts Notion autolinks of bare hosts", () => {
  const target = "The public hosts github.com, gitee.com, and gitlab.com select the provider."
  const actual =
    "The public hosts [github.com](http://github.com), [gitee.com](http://gitee.com), and<br>[gitlab.com](https://gitlab.com/) select the provider."
  expect(samePublishedMarkdown(actual, target)).toBe(true)
  expect(samePublishedMarkdown(actual.replace("select", "choose"), target)).toBe(false)
  expect(
    samePublishedMarkdown("See [github.com](https://github.com/org/repo).", "See github.com."),
  ).toBe(false)
  expect(samePublishedMarkdown("See [docs](http://github.com).", "See docs.")).toBe(false)
})

test("published comparison accepts a Notion-escaped details closer", () => {
  const target = [
    "Passing static path checks does not establish browser or perceptual visual acceptance.",
    "",
    "</details>",
    "",
    "The delivery interface exposes four separate claims.",
  ].join("\n")
  const actual = [
    "Passing static path checks does not establish browser or perceptual visual acceptance.",
    "\\</details\\>",
    "The delivery interface exposes four separate claims.",
  ].join("\n")
  expect(samePublishedMarkdown(actual, target)).toBe(true)
  expect(samePublishedMarkdown(actual.replace("four", "five"), target)).toBe(false)
})

function notionBlock(id: string, type: string, parts: readonly (string | { code: string })[]) {
  return {
    id,
    type,
    has_children: false,
    [type]: {
      rich_text: parts.map((part) => ({
        type: "text",
        plain_text: typeof part === "string" ? part : part.code,
        text: { content: typeof part === "string" ? part : part.code, link: null },
        annotations: { bold: true, code: typeof part !== "string" },
      })),
    },
  }
}

// Reduced from a fresh Notion read: a quote with split code emphasis, a separate
// notice paragraph, then a list. The remote Markdown omits the quote boundary.
const quoteReadback = [
  "## 高级用法",
  "> 优先先用 ****`+create`**** 创建成功，再用完整 API update。",
  "**注意**：",
  "- 全天日程的开始日期和结束日期必须分别设置。",
].join("\n")
const quoteSource = quoteReadback
  .replace("****`+create`****", "**`+create`**")
  .replace("。\n**注意**", "。\n\n**注意**")
const quoteRootBlocks = [
  notionBlock("heading", "heading_2", ["高级用法"]),
  notionBlock("quote", "quote", [
    "优先先用 ",
    { code: "+create" },
    " 创建成功，再用完整 API update。",
  ]),
  notionBlock("notice", "paragraph", ["注意", "："]),
  notionBlock("list", "bulleted_list_item", ["全天日程的开始日期和结束日期必须分别设置。"]),
]

test("typed Notion siblings restore the fresh quote-to-notice boundary", () => {
  const evidence = projectNotionBlocks(quoteRootBlocks)!
  expect(evidence[1]?.text).toBe("优先先用 +create 创建成功，再用完整 API update。")
  expect(markdownIdentity(fromNotionMarkdown(quoteReadback))).not.toBe(
    markdownIdentity(quoteSource),
  )
  expect(markdownIdentity(fromNotionMarkdown(quoteReadback, evidence))).toBe(
    markdownIdentity(quoteSource),
  )
})

test("a legitimate single quote keeps its authored lazy continuation", () => {
  const source = "> Keep this quoted.\nThis is a lazy continuation."
  const evidence = projectNotionBlocks([
    notionBlock("quote", "quote", ["Keep this quoted.\nThis is a lazy continuation."]),
  ])!
  expect(fromNotionMarkdown(source, evidence)).toBe(fromNotionMarkdown(source))
  expect(markdownIdentity(source)).not.toBe(markdownIdentity(source.replace("\n", "\n\n")))
})

test("changed notice text remains a semantic mismatch with stale or fresh block evidence", () => {
  const changed = quoteReadback.replace("注意", "警告")
  const stale = projectNotionBlocks(quoteRootBlocks)!
  const fresh = projectNotionBlocks(
    quoteRootBlocks.map((block) =>
      block.id === "notice" ? notionBlock("notice", "paragraph", ["警告："]) : block,
    ),
  )!
  expect(fromNotionMarkdown(changed, stale)).toBe(fromNotionMarkdown(changed))
  for (const evidence of [stale, fresh]) {
    expect(markdownIdentity(fromNotionMarkdown(changed, evidence))).not.toBe(
      markdownIdentity(quoteSource),
    )
  }
})

test("missing, duplicated, unknown and unordered anchor mappings cannot restore boundaries", () => {
  const evidence = projectNotionBlocks(quoteRootBlocks)!
  const cases = [
    { markdown: quoteReadback, blocks: evidence.filter((block) => block.type !== "quote") },
    { markdown: quoteReadback, blocks: evidence.filter((block) => block.type !== "paragraph") },
    { markdown: quoteReadback.replace("**注意**：", "Missing notice."), blocks: evidence },
    { markdown: `${quoteReadback}\n\n**注意**：`, blocks: evidence },
    { markdown: `${quoteReadback}\n\n${quoteReadback.split("\n")[1]}`, blocks: evidence },
    { markdown: quoteReadback, blocks: [...evidence, evidence[1]!] },
    {
      markdown: quoteReadback.replace("。\n**注意**", "。\nA lazy continuation.\n**注意**"),
      blocks: evidence,
    },
    { markdown: `\`\`\`text\n${quoteReadback}\n\`\`\``, blocks: evidence },
    {
      markdown: quoteReadback,
      blocks: evidence.map((block) =>
        block.type === "paragraph" ? { ...block, text: undefined } : block,
      ),
    },
    {
      markdown: quoteReadback,
      blocks: [
        evidence[0]!,
        evidence[1]!,
        { id: "unknown", type: "unsupported", has_children: false },
        ...evidence.slice(2),
      ],
    },
    { markdown: quoteReadback, blocks: [evidence[0]!, evidence[2]!, evidence[1]!, evidence[3]!] },
    {
      markdown: quoteReadback,
      blocks: evidence.map((block) =>
        block.type === "quote" ? { ...block, has_children: true } : block,
      ),
    },
  ]
  for (const { markdown, blocks } of cases) {
    expect(fromNotionMarkdown(markdown, blocks)).toBe(fromNotionMarkdown(markdown))
  }
})

test("typed direct quote-to-list boundaries support bulleted and numbered items", () => {
  for (const [type, marker] of [
    ["bulleted_list_item", "-"],
    ["numbered_list_item", "1."],
  ] as const) {
    const saved = `> **Run** \`check\`.\n${marker} Read the result.`
    const evidence = projectNotionBlocks([
      notionBlock("quote", "quote", ["Run ", { code: "check" }, "."]),
      notionBlock("item", type, ["Read the result."]),
    ])!
    expect(fromNotionMarkdown(saved, evidence)).toBe(saved.replace("\n", "\n\n"))
    const separated = saved.replace("\n", "\n\n")
    expect(fromNotionMarkdown(separated, evidence)).toBe(separated)
  }
})

test("unsupported rich text retains a sentinel and invalid metadata rejects the projection", () => {
  const unknown = {
    id: "notice",
    type: "paragraph",
    has_children: false,
    paragraph: { rich_text: [{ type: "mention", plain_text: "注意：" }] },
  }
  const evidence = projectNotionBlocks([quoteRootBlocks[1], unknown])!
  expect(evidence[1]).toEqual({ id: "notice", type: "paragraph", has_children: false })
  expect(fromNotionMarkdown(quoteReadback, evidence)).toBe(fromNotionMarkdown(quoteReadback))
  expect(projectNotionBlocks([{ type: "quote", has_children: false }])).toBeUndefined()
  expect(projectNotionBlocks([quoteRootBlocks[1], quoteRootBlocks[1]])).toBeUndefined()
})

test("multiline explicit quote anchors match rich-text newlines before a separate notice", () => {
  const saved = [
    "> **日程更新建议：**",
    "> 优先先用 ****`+create`**** 创建成功，再用完整 API update。",
    "**注意**：",
    "- 全天日程的开始日期和结束日期必须分别设置。",
  ].join("\n")
  const evidence = projectNotionBlocks([
    notionBlock("quote", "quote", [
      "日程更新建议：\n优先先用 ",
      { code: "+create" },
      " 创建成功，再用完整 API update。",
    ]),
    quoteRootBlocks[2],
    quoteRootBlocks[3],
  ])!
  const expected = saved.replace("。\n**注意**", "。\n\n**注意**")
  expect(markdownIdentity(fromNotionMarkdown(saved, evidence))).toBe(
    markdownIdentity(fromNotionMarkdown(expected)),
  )
  const lazy = saved.replace("> 优先先用", "优先先用")
  expect(fromNotionMarkdown(lazy, evidence)).toBe(fromNotionMarkdown(lazy))
  const duplicated = `${saved}\n\n${saved.split("\n").slice(0, 2).join("\n")}`
  expect(fromNotionMarkdown(duplicated, evidence)).toBe(fromNotionMarkdown(duplicated))
})

test("all uniquely locatable supported roots must preserve actual Markdown order", () => {
  const saved = "> Quoted\nNotice\n- Item"
  const roots = [
    notionBlock("quote", "quote", ["Quoted"]),
    notionBlock("notice", "paragraph", ["Notice"]),
    notionBlock("list", "bulleted_list_item", ["Item"]),
  ]
  const contradictory = projectNotionBlocks([roots[2], roots[0], roots[1]])!
  expect(fromNotionMarkdown(saved, contradictory)).toBe(fromNotionMarkdown(saved))
  expect(fromNotionMarkdown(saved, projectNotionBlocks(roots))).toBe("> Quoted\n\nNotice\n- Item")
})

test("a separate multiline paragraph maps as one exact contiguous source span", () => {
  const saved = "> Quoted\nFirst **notice** line.\nSecond \`notice\` line.\n- Item"
  const roots = [
    notionBlock("quote", "quote", ["Quoted"]),
    notionBlock("notice", "paragraph", [
      "First notice line.\nSecond ",
      { code: "notice" },
      " line.",
    ]),
    notionBlock("list", "bulleted_list_item", ["Item"]),
  ]
  const evidence = projectNotionBlocks(roots)!
  const expected = saved.replace("Quoted\n", "Quoted\n\n")
  expect(fromNotionMarkdown(saved, evidence)).toBe(expected)
  expect(markdownIdentity(fromNotionMarkdown(saved, evidence))).toBe(markdownIdentity(expected))
  const changed = saved.replace("Second", "Changed")
  expect(fromNotionMarkdown(changed, evidence)).toBe(fromNotionMarkdown(changed))
  const interrupted = saved.replace("\nSecond", "\n\nSecond")
  expect(fromNotionMarkdown(interrupted, evidence)).toBe(fromNotionMarkdown(interrupted))
})

test("an unsupported earlier rich quote stays a sentinel without blocking a later proven pair", () => {
  const prefix = "> **Policy**<br><u>*~~formatted~~*</u> \`example\`.\n\n## Next\n"
  const saved = `${prefix}> Quoted\nNotice\n- Item`
  const evidence = projectNotionBlocks([
    notionBlock("complex", "quote", ["Policy\nformatted ", { code: "example" }, "."]),
    notionBlock("heading", "heading_2", ["Next"]),
    notionBlock("quote", "quote", ["Quoted"]),
    notionBlock("notice", "paragraph", ["Notice"]),
    notionBlock("list", "bulleted_list_item", ["Item"]),
  ])!
  expect(fromNotionMarkdown(saved, evidence)).toBe(`${prefix}> Quoted\n\nNotice\n- Item`)
})

test("a notice substring inside a table cell is not a duplicate standalone paragraph anchor", () => {
  const table =
    '<table header-row="true">\n<tr><td>参数</td><td>说明</td></tr>\n<tr><td>summary</td><td>日程标题。注意：标题中不应该出现时间、地点、人物信息</td></tr>\n</table>\n'
  const saved = `${table}${quoteReadback}`
  const evidence = projectNotionBlocks([
    { id: "table", type: "table", has_children: true },
    ...quoteRootBlocks,
  ])!
  expect(markdownIdentity(fromNotionMarkdown(saved, evidence))).toBe(
    markdownIdentity(fromNotionMarkdown(`${table}${quoteSource}`)),
  )
  const duplicate = `${saved}\n\n**注意**：`
  expect(fromNotionMarkdown(duplicate, evidence)).toBe(fromNotionMarkdown(duplicate))
})

test("independent quote boundaries preserve ambiguous local bytes while restoring a separate unique pair", () => {
  const unique = "> Proven quote.\nProven notice."
  const uniqueRoots = [
    notionBlock("proven-quote", "quote", ["Proven quote."]),
    notionBlock("proven-notice", "paragraph", ["Proven notice."]),
  ]
  for (const repeatedType of ["quote", "paragraph"] as const) {
    const repeated = repeatedType === "quote" ? "> Repeated quote." : "Repeated notice."
    const ambiguous = `> Repeated quote.\nRepeated notice.\n\n${repeated}`
    const ambiguousRoots = [
      notionBlock("ambiguous-quote", "quote", ["Repeated quote."]),
      notionBlock("ambiguous-notice", "paragraph", ["Repeated notice."]),
      notionBlock("repeated-root", repeatedType, [
        repeatedType === "quote" ? "Repeated quote." : "Repeated notice.",
      ]),
    ]
    for (const ambiguousFirst of [true, false]) {
      const saved = ambiguousFirst ? `${ambiguous}\n\n${unique}` : `${unique}\n\n${ambiguous}`
      const roots = ambiguousFirst
        ? [...ambiguousRoots, ...uniqueRoots]
        : [...uniqueRoots, ...ambiguousRoots]
      const restored = fromNotionMarkdown(saved, projectNotionBlocks(roots)!)
      const expected = saved.replace(unique, unique.replace("\n", "\n\n"))
      expect(restored).toBe(expected)
      expect(markdownIdentity(restored)).toBe(markdownIdentity(expected))
      expect(markdownIdentity(restored)).not.toBe(
        markdownIdentity(expected.replace("> Repeated quote.\n", "> Repeated quote.\n\n")),
      )
    }
  }
})

test("independent quote boundaries reject global overlap, order, type and structural contradictions", () => {
  const unique = "> Proven quote.\nProven notice."
  const uniqueRoots = [
    notionBlock("proven-quote", "quote", ["Proven quote."]),
    notionBlock("proven-notice", "paragraph", ["Proven notice."]),
  ]
  const cases = [
    {
      tail: "First line.\nSecond line.",
      roots: [
        notionBlock("combined", "paragraph", ["First line.\nSecond line."]),
        notionBlock("overlap", "paragraph", ["Second line."]),
      ],
    },
    {
      tail: "First line.\nSecond line.",
      roots: [
        notionBlock("second", "paragraph", ["Second line."]),
        notionBlock("first", "paragraph", ["First line."]),
      ],
    },
    {
      tail: "> Wrong type.",
      roots: [notionBlock("wrong-type", "paragraph", ["Wrong type."])],
    },
    {
      tail: "> Another quote.\nLazy continuation.\nAnother notice.",
      roots: [
        notionBlock("another-quote", "quote", ["Another quote."]),
        notionBlock("another-notice", "paragraph", ["Another notice."]),
      ],
    },
  ]
  for (const { tail, roots } of cases) {
    const saved = `${unique}\n\n${tail}`
    const evidence = projectNotionBlocks([...uniqueRoots, ...roots])!
    expect(fromNotionMarkdown(saved, evidence)).toBe(fromNotionMarkdown(saved))
  }
})

test("independent quote boundaries preserve legal lazy quotes beside a proven pair", () => {
  const lazy = "> Keep this quoted.\nThis is a lazy continuation."
  const saved = `${lazy}\n\n> Proven quote.\nProven notice.`
  const evidence = projectNotionBlocks([
    notionBlock("lazy-quote", "quote", ["Keep this quoted.\nThis is a lazy continuation."]),
    notionBlock("proven-quote", "quote", ["Proven quote."]),
    notionBlock("proven-notice", "paragraph", ["Proven notice."]),
  ])!
  const expected = saved.replace("> Proven quote.\n", "> Proven quote.\n\n")
  expect(fromNotionMarkdown(saved, evidence)).toBe(expected)
  expect(fromNotionMarkdown(lazy, evidence.slice(0, 1))).toBe(lazy)
  expect(fromNotionMarkdown(saved)).toBe(saved)
})

test("independent quote boundaries keep true body edits distinct with stale or fresh evidence", () => {
  const saved =
    "> Proven quote.\nProven notice.\n\n> Other quote.\nRepeated notice.\n\nRepeated notice."
  const roots = [
    notionBlock("proven-quote", "quote", ["Proven quote."]),
    notionBlock("proven-notice", "paragraph", ["Proven notice."]),
    notionBlock("other-quote", "quote", ["Other quote."]),
    notionBlock("other-notice", "paragraph", ["Repeated notice."]),
    notionBlock("repeat", "paragraph", ["Repeated notice."]),
  ]
  const approved = saved.replace("Proven quote.\n", "Proven quote.\n\n")
  const changed = saved.replace("Proven notice.", "Changed notice.")
  const stale = projectNotionBlocks(roots)!
  const fresh = projectNotionBlocks(
    roots.map((block) =>
      block.id === "proven-notice"
        ? notionBlock("proven-notice", "paragraph", ["Changed notice."])
        : block,
    ),
  )!
  expect(fromNotionMarkdown(changed, stale)).toBe(changed)
  expect(fromNotionMarkdown(changed, fresh)).toBe(
    changed.replace("Proven quote.\n", "Proven quote.\n\n"),
  )
  for (const evidence of [stale, fresh]) {
    expect(markdownIdentity(fromNotionMarkdown(changed, evidence))).not.toBe(
      markdownIdentity(approved),
    )
  }
})

// Exact roots 87–89 and raw lines 87–89 from the retained Notion read.
const adjacentQuote =
  "Candidate 只有在 owner 针对当前 frontier 接受后才成为 canonical fact，realtime 只负责 projection。"
const adjacentNotice = "语义解压："
const adjacentFollowing =
  "Agent 生成的回复一开始只是一个“候选结果”，还不能被当作频道里的正式消息。拥有最终决定权的组件会检查这个候选结果是否仍对应频道的最新状态；只有它明确接受之后，这条回复才成为所有参与者共同承认的正式事实。实时推送层只负责把已经成立的事实尽快送到界面，它不拥有把候选结果变成事实的权力。这里的 `frontier` 可以理解为“该决定基于的最新已知进度”。"
const adjacentReadback = `> ${adjacentQuote}\n**${adjacentNotice}**\n> ${adjacentFollowing}`
const adjacentRoots = [
  notionBlock("4f543d4d-ad7f-4dd1-8ee4-b37ec2b6352a", "quote", [adjacentQuote]),
  notionBlock("921172ea-bdad-46c5-a587-ebe4cde25833", "paragraph", [adjacentNotice]),
  notionBlock("9ccef97a-52f6-4af9-b9a4-e05dbec62222", "quote", [
    adjacentFollowing.replace(/`/g, ""),
  ]),
]

test("adjacent quote pairs restore the exact retained three-root fixture with a repeated notice", () => {
  for (const repeated of [false, true]) {
    const saved = adjacentReadback + (repeated ? `\n\n**${adjacentNotice}**` : "")
    const roots = repeated
      ? [...adjacentRoots, notionBlock("repeated-notice", "paragraph", [adjacentNotice])]
      : adjacentRoots
    const expected = saved.replace(`\n**${adjacentNotice}**`, `\n\n**${adjacentNotice}**`)
    expect(fromNotionMarkdown(saved, projectNotionBlocks(roots)!)).toBe(expected)
    expect(markdownIdentity(fromNotionMarkdown(saved, projectNotionBlocks(roots)!))).toBe(
      markdownIdentity(expected),
    )
  }
})

test("adjacent quote pairs match complete multiline spans even when both individual anchors repeat", () => {
  const pair =
    "> First quoted line.\n> Second quoted line.\nFirst notice line.\nSecond notice line."
  const saved = `${pair}\n> Following quote.\n\n> First quoted line.\n> Second quoted line.\n\nFirst notice line.\nSecond notice line.`
  const roots = [
    notionBlock("quote", "quote", ["First quoted line.\nSecond quoted line."]),
    notionBlock("notice", "paragraph", ["First notice line.\nSecond notice line."]),
    notionBlock("following", "quote", ["Following quote."]),
    notionBlock("repeated-quote", "quote", ["First quoted line.\nSecond quoted line."]),
    notionBlock("repeated-notice", "paragraph", ["First notice line.\nSecond notice line."]),
  ]
  const expected = saved.replace(
    "Second quoted line.\nFirst notice",
    "Second quoted line.\n\nFirst notice",
  )
  expect(fromNotionMarkdown(saved, projectNotionBlocks(roots)!)).toBe(expected)
  expect(markdownIdentity(fromNotionMarkdown(saved, projectNotionBlocks(roots)!))).toBe(
    markdownIdentity(expected),
  )
})

test("adjacent quote pairs require one exact pair and uninterrupted correctly ordered root evidence", () => {
  const quote = notionBlock("quote", "quote", ["Quoted."])
  const notice = notionBlock("notice", "paragraph", ["Repeated notice."])
  const following = notionBlock("following", "quote", ["Following quote."])
  const repeated = notionBlock("repeated", "paragraph", ["Repeated notice."])
  const pair = "> Quoted.\nRepeated notice."
  const saved = `${pair}\n> Following quote.\n\nRepeated notice.`
  const unknown = { id: "unknown", type: "unsupported", has_children: false }
  for (const roots of [
    [quote, unknown, notice, following, repeated],
    [quote, notice, unknown, following, repeated],
    [following, quote, notice, repeated],
    [quote, notice, repeated, following],
  ]) {
    expect(fromNotionMarkdown(saved, projectNotionBlocks(roots)!)).toBe(saved)
  }
  const duplicated = `${pair}\n\n${pair}\n> Following quote.`
  const duplicateRoots = [
    quote,
    notice,
    notionBlock("duplicate-quote", "quote", ["Quoted."]),
    notionBlock("duplicate-notice", "paragraph", ["Repeated notice."]),
    following,
  ]
  expect(fromNotionMarkdown(duplicated, projectNotionBlocks(duplicateRoots)!)).toBe(duplicated)
  const interrupted = saved.replace("Repeated notice.\n>", "Repeated notice.\nExtra body text.\n>")
  expect(
    fromNotionMarkdown(interrupted, projectNotionBlocks([quote, notice, following, repeated])!),
  ).toBe(interrupted)
  const restored = saved.replace("Quoted.\n", "Quoted.\n\n")
  expect(
    fromNotionMarkdown(saved, projectNotionBlocks([quote, notice, following, repeated])!),
  ).toBe(restored)
})

test("adjacent quote pairs keep genuine edits distinct with stale and fresh complete evidence", () => {
  const saved = `${adjacentReadback}\n\n**${adjacentNotice}**`
  const roots = [...adjacentRoots, notionBlock("repeated-notice", "paragraph", [adjacentNotice])]
  const approved = saved.replace(`\n**${adjacentNotice}**`, `\n\n**${adjacentNotice}**`)
  const changed = saved.replace("canonical fact", "proposed fact")
  const stale = projectNotionBlocks(roots)!
  const fresh = projectNotionBlocks(
    roots.map((block) =>
      block.id === adjacentRoots[0]!.id
        ? notionBlock(block.id, "quote", [adjacentQuote.replace("canonical fact", "proposed fact")])
        : block,
    ),
  )!
  expect(fromNotionMarkdown(changed, stale)).toBe(changed)
  expect(fromNotionMarkdown(changed, fresh)).toBe(
    changed.replace(`\n**${adjacentNotice}**`, `\n\n**${adjacentNotice}**`),
  )
  for (const evidence of [stale, fresh]) {
    expect(markdownIdentity(fromNotionMarkdown(changed, evidence))).not.toBe(
      markdownIdentity(approved),
    )
  }
})

test("Notion quote lists, thematic breaks, and list fences read back as authored markdown", () => {
  const source = [
    "> Use these tools:",
    "> - Search first.",
    "> - Fetch the page.",
    "",
    "Then describe the goal.",
    "",
    "---",
    "",
    "## Next",
    "",
    "1. Run the converter:",
    "   ```bash",
    "   python report.py",
    "   ```",
    "2. Keep the PDF.",
  ].join("\n")
  const saved = [
    "> Use these tools:",
    "\t- Search first.",
    "\t- Fetch the page.",
    "Then describe the goal.",
    "---",
    "## Next",
    "1. Run the converter:",
    "\t```bash",
    "python report.py",
    "\t```",
    "2. Keep the PDF.",
  ].join("\n")
  const evidence = projectNotionBlocks([
    notionBlock("quote", "quote", ["Use these tools:"]),
    notionBlock("goal", "paragraph", ["Then describe the goal."]),
    { id: "rule", type: "divider", has_children: false },
    notionBlock("next", "heading_2", ["Next"]),
    notionBlock("run", "numbered_list_item", ["Run the converter:"]),
    notionBlock("keep", "numbered_list_item", ["Keep the PDF."]),
  ])!
  expect(markdownIdentity(fromNotionMarkdown(saved, evidence))).toBe(markdownIdentity(source))
})
