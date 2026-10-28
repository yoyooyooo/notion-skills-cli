import { expect, test } from "bun:test"
import { Effect } from "effect"
import {
  fromNotionMarkdown,
  notionMarkdownForComparison,
  projectNotionBlocks,
  samePublishedMarkdown,
} from "../src/markdown.ts"
import { fail } from "../src/model.ts"
import type { Notion } from "../src/notion.ts"
import type { Receipt } from "../src/publication-model.ts"
import { publicationExternalLinksMatch } from "../src/publication-markdown.ts"
import {
  publicationMarkdownMatches,
  publicationReadPhase,
  readPublicationMarkdownMatches,
} from "../src/publication-observation.ts"
import { rewritePageLinks } from "../src/references.ts"

const page = "11111111-1111-4111-8111-111111111111"
const pagePath = `v1/pages/${page}`
const markdownPath = `${pagePath}/markdown`
const inventoryPath = `v1/blocks/${page}/children?page_size=100`
const local = (value: string) => rewritePageLinks(value, "", [], "local")
const mapping = {
  local,
  preserveExternal: (value: string) =>
    rewritePageLinks(value, "", [], "local", [], { preserveExternalUrls: true }),
}
// A paragraph followed by a separate divider needs its original root evidence.
// Filename autolinking is accepted in the raw spelling but lost by the old mapper.
const raw = "Read [EXAMPLE.md](http://EXAMPLE.md).\nA short status.\n---\n## Next\nReady."
const target = "Read EXAMPLE.md.\n\nA short status.\n\n---\n\n## Next\n\nReady."
function block(id: string, type: string, text?: string) {
  return {
    id,
    type,
    has_children: false,
    parent: { type: "page_id", page_id: page },
    [type]: { rich_text: text === undefined ? [] : [{ type: "text", text: { content: text } }] },
  }
}
const roots = [
  block("intro", "paragraph"),
  block("status", "paragraph", "A short status."),
  block("divider", "divider"),
  block("next", "heading_2"),
  block("ready", "paragraph", "Ready."),
]
const boundaries = projectNotionBlocks(roots)!
function intent(value = target): Receipt["intents"][number] {
  return {
    path: markdownPath,
    method: "PATCH",
    status: "completed",
    body: { type: "replace_content", replace_content: { new_str: value } },
  }
}
function reader(actual = raw, evidence: readonly unknown[] = roots, changedMetadata = false) {
  const calls: string[] = []
  let metadataReads = 0
  const api: Notion["Service"] = {
    version: Effect.succeed("test"),
    credentialIdentity: Effect.succeed("test"),
    request: (path, body, options) =>
      Effect.gen(function* () {
        expect(body).toBeUndefined()
        expect(options?.method).toBeUndefined()
        calls.push(path)
        if (path === pagePath)
          return {
            id: page,
            object: "page",
            properties: {},
            archived: false,
            in_trash: false,
            last_edited_time:
              changedMetadata && metadataReads++ > 0
                ? "2026-10-21T00:00:00.000Z"
                : "2026-10-20T00:00:00.000Z",
          }
        if (path === markdownPath)
          return {
            object: "page_markdown",
            markdown: actual,
            truncated: false,
            unknown_block_ids: [],
          }
        if (path === inventoryPath) return { results: evidence, has_more: false, next_cursor: null }
        return yield* Effect.fail(
          fail("INVALID_RESPONSE", "Unexpected retained-target test request."),
        )
      }),
  }
  return { api, calls }
}

test("the raw retained body needs blocks, needs no directed candidate, and fails after lossy mapping", () => {
  expect(publicationMarkdownMatches(intent(), raw, target)).toBe(false)
  expect(publicationMarkdownMatches(intent(), raw, target, boundaries)).toBe(true)
  expect(
    samePublishedMarkdown(fromNotionMarkdown(raw, boundaries), target, undefined, boundaries),
  ).toBe(true)
  expect(notionMarkdownForComparison(raw, target, boundaries)).toBeUndefined()
  expect(publicationMarkdownMatches(intent(), local(raw), local(target), boundaries)).toBe(false)
})

for (const mode of ["fresh", "cached", "strict"] as const) {
  test(`the retained raw body keeps its full proof before mapping through ${mode}`, async () => {
    const f = reader()
    const phase = publicationReadPhase()
    if (mode === "cached")
      phase.proofs.set(page, { actual: raw, blocks: boundaries, strict_structure: true })
    expect(
      await Effect.runPromise(
        readPublicationMarkdownMatches(
          intent(),
          raw,
          local(target),
          f.api,
          phase,
          mapping,
          mode !== "fresh",
        ),
      ),
    ).toBe(true)
    if (mode === "cached") expect(f.calls).toEqual([])
    else expect(f.calls).toEqual([pagePath, markdownPath, inventoryPath, pagePath])
  })
}

for (const [name, actual, expected, evidence] of [
  ["missing root evidence", raw, target, []],
  ["missing the divider root", raw, target, roots.filter((root) => root.id !== "divider")],
  ["changed prose", raw.replace("Ready.", "Changed."), target, roots],
  [
    "a different filename autolink",
    raw.replace("http://EXAMPLE.md", "http://OTHER.md"),
    target,
    roots,
  ],
  [
    "a changed explicit external scheme",
    raw + "\n\n[site](http://example.test/exact)",
    target + "\n\n[site](https://example.test/exact)",
    [...roots, block("site", "paragraph")],
  ],
  [
    "a missing explicit external link",
    raw + "\n\nsite",
    target + "\n\n[site](https://example.test/exact)",
    [...roots, block("site", "paragraph")],
  ],
  [
    "one-based numbering for a zero-based retained list",
    raw + "\n\n1. first\n2. second",
    target + "\n\n0. first\n1. second",
    [
      ...roots,
      block("first", "numbered_list_item", "first"),
      block("second", "numbered_list_item", "second"),
    ],
  ],
] satisfies Array<[string, string, string, readonly unknown[]]>) {
  test(`the retained raw proof rejects ${name}`, async () => {
    const f = reader(actual, evidence)
    expect(
      await Effect.runPromise(
        readPublicationMarkdownMatches(
          intent(expected),
          actual,
          local(expected),
          f.api,
          publicationReadPhase(),
          mapping,
          true,
        ),
      ),
    ).toBe(false)
    expect(f.calls).toContain(inventoryPath)
  })
}

test("the same retained raw body cannot authorize a different caller target", async () => {
  const f = reader()
  expect(
    await Effect.runPromise(
      readPublicationMarkdownMatches(
        intent(),
        raw,
        local(target.replace("Ready.", "Different target.")),
        f.api,
        publicationReadPhase(),
        mapping,
        true,
      ),
    ),
  ).toBe(false)
})

test("an unchanged explicit external destination retains the same full raw evidence", async () => {
  const suffix = "\n\n[site](https://example.test/exact)"
  const actual = raw + suffix,
    expected = target + suffix
  const evidence = [...roots, block("site", "paragraph")]
  expect(
    publicationExternalLinksMatch(
      actual,
      expected,
      (value) => value,
      projectNotionBlocks(evidence),
    ),
  ).toBe(true)
  const f = reader(actual, evidence)
  expect(
    await Effect.runPromise(
      readPublicationMarkdownMatches(
        intent(expected),
        actual,
        local(expected),
        f.api,
        publicationReadPhase(),
        mapping,
        true,
      ),
    ),
  ).toBe(true)
})

test("the new raw path still refuses a changed metadata bracket", async () => {
  const f = reader(raw, roots, true)
  const result = await Effect.runPromise(
    readPublicationMarkdownMatches(
      intent(),
      raw,
      local(target),
      f.api,
      publicationReadPhase(),
      mapping,
      true,
    ).pipe(Effect.result),
  )
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "WRITE_CONFLICT" } })
})
function rich(
  text: string,
  options: { bold?: boolean; code?: boolean; link?: string | null } = {},
) {
  return {
    type: "text",
    text: { content: text, ...(options.link ? { link: { url: options.link } } : {}) },
    annotations: {
      bold: options.bold === true,
      italic: false,
      strikethrough: false,
      underline: false,
      code: options.code === true,
      color: "default",
    },
    plain_text: text,
    href: options.link ?? null,
  }
}
function spanBlock(id: string, type: string, spans: readonly ReturnType<typeof rich>[]) {
  return {
    id,
    type,
    has_children: false,
    parent: { type: "page_id", page_id: page },
    [type]: { rich_text: spans },
  }
}

test("proved heading gaps and plain marker punctuation retain the original acknowledged body", async () => {
  const headingTarget = "# Title\n\n**Keep** [`GUIDE.md`](GUIDE.md) exact."
  const headingActual = "# Title\n**Keep **[**`GUIDE.md`**](GUIDE.md) exact."
  const headingRoots = [
    spanBlock("title", "heading_1", [rich("Title")]),
    spanBlock("body", "paragraph", [
      rich("Keep ", { bold: true }),
      rich("GUIDE.md", { bold: true, code: true, link: "GUIDE.md" }),
      rich(" exact."),
    ]),
  ]
  const marker = "plain-token:v1:abc"
  const markerTarget = `${marker}\n\n# Body`
  const markerActual = `${marker.replaceAll(":", "\\:")}\n# Body`
  const markerRoots = [
    spanBlock("marker", "paragraph", [rich("plain-token"), rich(":v1:"), rich("abc")]),
    spanBlock("body", "heading_1", [rich("Body")]),
  ]
  for (const [name, actual, expected, evidence] of [
    ["heading", headingActual, headingTarget, headingRoots],
    ["marker", markerActual, markerTarget, markerRoots],
  ] as const) {
    const projected = projectNotionBlocks(evidence)!
    expect(publicationMarkdownMatches(intent(expected), actual, expected, projected), name).toBe(
      true,
    )
    const f = reader(actual, evidence)
    expect(
      await Effect.runPromise(
        readPublicationMarkdownMatches(
          intent(expected),
          actual,
          local(expected),
          f.api,
          publicationReadPhase(),
          mapping,
          true,
        ),
      ),
    ).toBe(true)
  }
  const changed = headingActual.replace("exact.", "changed.")
  expect(
    await Effect.runPromise(
      readPublicationMarkdownMatches(
        intent(headingTarget),
        changed,
        local(headingTarget),
        reader(changed, headingRoots).api,
        publicationReadPhase(),
        mapping,
        true,
      ),
    ),
  ).toBe(false)
  const foreignMarker = markerActual.replace("abc", "xyz")
  expect(
    await Effect.runPromise(
      readPublicationMarkdownMatches(
        intent(markerTarget),
        foreignMarker,
        local(markerTarget),
        reader(foreignMarker, markerRoots).api,
        publicationReadPhase(),
        mapping,
        true,
      ),
    ),
  ).toBe(false)
})

test("a mapped nonempty graph proves the frozen raw heading gap without renaming the target", async () => {
  const child = "22222222-2222-4222-8222-222222222222"
  const notion = "https://www.notion.so/22222222222242228222222222222222"
  const source = `# Title\n\n**Keep** [\`Guide\`](${notion}) exact.\n\n## Next`
  const actual = `# Title\n**Keep **[**\`Guide\`**](${notion}) exact.\n\n## Next`
  const pages = [
    { id: page, path: "SKILL.md", title: "Skill", markdown: source },
    { id: child, path: "references/guide.md", title: "Guide", markdown: "# Guide" },
  ]
  const localSource = rewritePageLinks(source, "SKILL.md", pages, "local")
  expect(localSource).not.toBe(source)
  const graph = {
    local: (value: string) => rewritePageLinks(value, "SKILL.md", pages, "local"),
    preserveExternal: (value: string) =>
      rewritePageLinks(value, "SKILL.md", pages, "local", [], { preserveExternalUrls: true }),
    source: { path: "SKILL.md", files: [{ path: "SKILL.md" }, { path: "references/guide.md" }] },
  }
  const evidence = [
    spanBlock("title", "heading_1", [rich("Title")]),
    spanBlock("body", "paragraph", [
      rich("Keep ", { bold: true }),
      rich("Guide", { bold: true, code: true, link: notion }),
      rich(" exact."),
    ]),
    spanBlock("next", "heading_2", [rich("Next")]),
  ]
  const projected = projectNotionBlocks(evidence)!
  expect(notionMarkdownForComparison(actual, localSource, projected)).toBeUndefined()
  expect(
    await Effect.runPromise(
      readPublicationMarkdownMatches(
        intent(source),
        actual,
        localSource,
        reader(actual, evidence).api,
        publicationReadPhase(),
        graph,
        true,
      ),
    ),
  ).toBe(true)
  const changed = actual.replace("exact.", "changed.")
  expect(
    await Effect.runPromise(
      readPublicationMarkdownMatches(
        intent(source),
        changed,
        localSource,
        reader(changed, evidence).api,
        publicationReadPhase(),
        graph,
        true,
      ),
    ),
  ).toBe(false)
  const otherActual = actual.replaceAll(notion, "OTHER.md")
  const moved = evidence.map((block, index) =>
    index === 1
      ? {
          ...block,
          paragraph: {
            rich_text: [
              rich("Keep ", { bold: true }),
              rich("OTHER.md", { bold: true, code: true, link: "OTHER.md" }),
              rich(" exact."),
            ],
          },
        }
      : block,
  )
  expect(
    await Effect.runPromise(
      readPublicationMarkdownMatches(
        intent(source),
        otherActual,
        localSource,
        reader(otherActual, moved).api,
        publicationReadPhase(),
        graph,
        true,
      ),
    ),
  ).toBe(false)
  expect(
    await Effect.runPromise(
      readPublicationMarkdownMatches(
        intent(source),
        actual,
        localSource.replace("exact.", "other target."),
        reader(actual, evidence).api,
        publicationReadPhase(),
        graph,
        true,
      ),
    ),
  ).toBe(false)
})

test("continuous bold code links retain both exact destinations through split Notion spans", async () => {
  const source =
    "# Title\n\n**Read [`first.md`](first.md) and [`second.md`](second.md)** exactly.\n\n## Next"
  const actual =
    "# Title\n**Read **[**`first.md`**](first.md)** and **[**`second.md`**](second.md) exactly.\n## Next"
  const evidence = [
    spanBlock("title", "heading_1", [rich("Title")]),
    spanBlock("body", "paragraph", [
      rich("Read ", { bold: true }),
      rich("first.md", { bold: true, code: true, link: "first.md" }),
      rich(" and ", { bold: true }),
      rich("second.md", { bold: true, code: true, link: "second.md" }),
      rich(" exactly."),
    ]),
    spanBlock("next", "heading_2", [rich("Next")]),
  ]
  expect(
    await Effect.runPromise(
      readPublicationMarkdownMatches(
        intent(source),
        actual,
        local(source),
        reader(actual, evidence).api,
        publicationReadPhase(),
        mapping,
        true,
      ),
    ),
  ).toBe(true)
  for (const changed of [
    actual.replace(" exactly.", " changed."),
    actual.replace("(second.md)", "(other.md)"),
  ]) {
    expect(
      await Effect.runPromise(
        readPublicationMarkdownMatches(
          intent(source),
          changed,
          local(source),
          reader(changed, evidence).api,
          publicationReadPhase(),
          mapping,
          true,
        ),
      ),
    ).toBe(false)
  }
})
