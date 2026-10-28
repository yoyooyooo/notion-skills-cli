import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { fromNotionMarkdown, projectNotionBlocks, samePublishedMarkdown } from "../src/markdown.ts"
import { fail, NotionBlockBoundarySchema } from "../src/model.ts"
import type { Notion } from "../src/notion.ts"
import type { Receipt } from "../src/publication-model.ts"
import { publicationExternalLinksMatch } from "../src/publication-markdown.ts"
import {
  publicationReadPhase,
  readPublicationMarkdownMatches,
} from "../src/publication-observation.ts"

const page = "11111111-1111-4111-8111-111111111111"
const pagePath = `v1/pages/${page}`
const markdownPath = `${pagePath}/markdown`
const inventoryPath = `v1/blocks/${page}/children?page_size=100`
const literal = "A literal example:\n```mermaid\n\tA --> B  \n\n```"
const raw = `# Example\nBefore.\n\`\`\`markdown\n${literal}\n\`\`\`\n## Next\nAfter [docs](https://example.test/exact).`
const target = `# Example\n\nBefore.\n\n\`\`\`\`markdown\n${literal}\n\`\`\`\`\n\n## Next\n\nAfter [docs](https://example.test/exact).`
const text = (content: string, link: string | null = null) => ({
  type: "text",
  text: { content, link: link === null ? null : { url: link } },
  plain_text: content,
  annotations: { bold: false, code: false },
})
const root = (id: string, type: string, body: unknown) => ({
  id,
  type,
  has_children: false,
  parent: { type: "page_id", page_id: page },
  [type]: body,
})
const code = (rich_text: readonly unknown[], language: unknown = "markdown") =>
  root("literal", "code", { language, rich_text })
const codeParts = [text("A literal example:\n"), text("```mermaid\n\tA --> B  \n\n"), text("```")]
const roots = [
  root("title", "heading_1", { rich_text: [text("Example")] }),
  root("before", "paragraph", { rich_text: [text("Before.")] }),
  code(codeParts),
  root("next", "heading_2", { rich_text: [text("Next")] }),
  root("after", "paragraph", {
    rich_text: [text("After "), text("docs", "https://example.test/exact"), text(".")],
  }),
]
function projected(values: readonly unknown[] = roots) {
  const result = projectNotionBlocks(values)
  if (!result) throw new Error("Invalid synthetic root inventory")
  return result
}
function intent(expected = target): Receipt["intents"][number] {
  return {
    method: "PATCH",
    path: markdownPath,
    status: "completed",
    body: { type: "replace_content", replace_content: { new_str: expected } },
  }
}

test("complete original code text and language survive snapshot schema decoding", () => {
  const boundaries = projected()
  expect(boundaries[2]?.code).toEqual({ language: "markdown", text: literal })
  const decoded = boundaries.map((boundary) =>
    Schema.decodeUnknownSync(NotionBlockBoundarySchema)(boundary, { onExcessProperty: "error" }),
  )
  expect(decoded).toEqual(boundaries)
  expect(samePublishedMarkdown(raw, target)).toBe(false)
  expect(samePublishedMarkdown(fromNotionMarkdown(raw, decoded), target, undefined, decoded)).toBe(
    false,
  )
  expect(samePublishedMarkdown(raw, target, undefined, decoded)).toBe(true)
})

test("empty code and source language spelling are retained without content normalization", () => {
  expect(projected([code([], "plain text")])[0]?.code).toEqual({ text: "", language: "plain text" })
  expect(projected([code([text("\tline  \n\n")], "jsx")])[0]?.code).toEqual({
    text: "\tline  \n\n",
    language: "jsx",
  })
})

test("incomplete or contradictory original code leaves an unproved sentinel", () => {
  const incomplete = [
    code(codeParts, null),
    code([{ type: "mention", mention: { type: "page", page: { id: page } } }]),
    code([text(literal, "https://example.test/unrelated")]),
    code([{ ...text(literal), plain_text: "different" }]),
    { ...code(codeParts), has_children: true },
    root("literal", "code", { language: "markdown" }),
  ]
  for (const invalid of incomplete) {
    const boundaries = projected(roots.map((entry) => (entry.id === "literal" ? invalid : entry)))
    expect(boundaries[2]?.type).toBe("code")
    expect(boundaries[2]?.code).toBeUndefined()
    expect(samePublishedMarkdown(raw, target, undefined, boundaries)).toBe(false)
  }
  const legacy = projected().map(({ code: _code, ...boundary }) => boundary)
  expect(samePublishedMarkdown(raw, target, undefined, legacy)).toBe(false)
})

test("the shared external proof preserves an explicit destination through the bound frame", () => {
  const boundaries = projected()
  expect(publicationExternalLinksMatch(raw, target, (value) => value, boundaries)).toBe(true)
  expect(
    publicationExternalLinksMatch(
      raw.replace("https://example.test", "http://example.test"),
      target,
      (value) => value,
      boundaries,
    ),
  ).toBe(false)
  expect(
    publicationExternalLinksMatch(
      raw.replace("A --> B", "A --> C"),
      target,
      (value) => value,
      boundaries,
    ),
  ).toBe(false)
})

function reader(actual = raw, evidence: readonly unknown[] = roots, changeRevision = false) {
  const calls: string[] = []
  let revisions = 0
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
            archived: false,
            in_trash: false,
            properties: {},
            last_edited_time:
              changeRevision && revisions++ > 0
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
        return yield* Effect.fail(fail("INVALID_RESPONSE", "Unexpected code boundary test read"))
      }),
  }
  return { api, calls }
}

for (const mode of ["fresh", "cached"] as const) {
  test(`the publication reader proves the original frame and external URL through ${mode}`, async () => {
    const f = reader(),
      phase = publicationReadPhase()
    if (mode === "cached")
      phase.proofs.set(page, { actual: raw, blocks: projected(), strict_structure: true })
    expect(
      await Effect.runPromise(
        readPublicationMarkdownMatches(
          intent(),
          raw,
          target,
          f.api,
          phase,
          { local: (value) => value, preserveExternal: (value) => value },
          true,
        ),
      ),
    ).toBe(true)
    if (mode === "cached") expect(f.calls).toEqual([])
    else expect(f.calls).toEqual([pagePath, markdownPath, inventoryPath, pagePath])
  })
}

for (const [name, actual, expected, evidence] of [
  [
    "a changed explicit URL",
    raw.replace("https://example.test", "http://example.test"),
    target,
    roots,
  ],
  ["different retained code bytes", raw.replace("A --> B", "A --> C"), target, roots],
  ["a different caller target", raw, target.replace("Before.", "Other."), roots],
  ["a missing code root", raw, target, roots.filter((entry) => entry.id !== "literal")],
] satisfies Array<[string, string, string, readonly unknown[]]>) {
  test("the publication reader refuses " + name, async () => {
    const f = reader(actual, evidence)
    expect(
      await Effect.runPromise(
        readPublicationMarkdownMatches(
          intent(),
          actual,
          expected,
          f.api,
          publicationReadPhase(),
          { local: (value) => value, preserveExternal: (value) => value },
          true,
        ),
      ),
    ).toBe(false)
  })
}

test("the bound frame still refuses a changed metadata bracket", async () => {
  const f = reader(raw, roots, true)
  const result = await Effect.runPromise(
    readPublicationMarkdownMatches(
      intent(),
      raw,
      target,
      f.api,
      publicationReadPhase(),
      undefined,
      true,
    ).pipe(Effect.result),
  )
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "WRITE_CONFLICT" } })
})
