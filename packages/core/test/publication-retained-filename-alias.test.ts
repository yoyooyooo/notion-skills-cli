import { expect, test } from "bun:test"
import { Effect } from "effect"
import { projectNotionBlocks } from "../src/markdown.ts"
import { fail } from "../src/model.ts"
import type { Notion } from "../src/notion.ts"
import type { Receipt } from "../src/publication-model.ts"
import {
  publicationMarkdownMatches,
  publicationReadPhase,
  readPublicationMarkdownMatches,
} from "../src/publication-observation.ts"
import { notionFilenameAlias } from "../src/publication-markdown.ts"
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
const original = {
  actual:
    "Read [EXAMPLE.md](http://EXAMPLE.md) and [reference](http://GUIDE.md).\nA short status.\n---\n## Next\nReady.",
  target:
    "Read EXAMPLE.md and [reference](GUIDE.md).\n\nA short status.\n\n---\n\n## Next\n\nReady.",
}
const rich = (content: string, url?: string) => ({
  type: "text",
  text: { content, link: url === undefined ? null : { url } },
  annotations: {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: "default",
  },
})
const block = (id: string, type: string, richText: ReturnType<typeof rich>[] = []) => ({
  id,
  type,
  has_children: false,
  parent: { type: "page_id", page_id: page },
  [type]: { rich_text: richText },
})
function fixture() {
  return {
    ...original,
    roots: [
      block("intro", "paragraph", [
        rich("Read "),
        rich("EXAMPLE.md", "http://EXAMPLE.md"),
        rich(" and "),
        rich("reference", "http://GUIDE.md"),
        rich("."),
      ]),
      block("status", "paragraph", [rich("A short status.")]),
      block("divider", "divider"),
      block("next", "heading_2", [rich("Next")]),
      block("ready", "paragraph", [rich("Ready.")]),
    ],
  }
}
function intent(target: string): Receipt["intents"][number] {
  return {
    path: markdownPath,
    method: "PATCH",
    status: "completed",
    body: { type: "replace_content", replace_content: { new_str: target } },
  }
}
function reader(actual: string, roots: readonly unknown[], changedMetadata = false) {
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
                ? "2026-10-21T01:00:00.000Z"
                : "2026-10-21T00:00:00.000Z",
          }
        if (path === markdownPath)
          return {
            object: "page_markdown",
            markdown: actual,
            truncated: false,
            unknown_block_ids: [],
          }
        if (path === inventoryPath) return { results: roots, has_more: false, next_cursor: null }
        return yield* Effect.fail(
          fail("INVALID_RESPONSE", "Unexpected filename-alias test request."),
        )
      }),
  }
  return { api, calls }
}
function boundaries(roots: readonly unknown[]) {
  const result = projectNotionBlocks(roots)
  if (!result) throw new Error("Test requires valid root blocks")
  return result
}

test("existing filename policy is needed before physical readback spelling is mapped", () => {
  const f = fixture(),
    evidence = boundaries(f.roots),
    originalIntent = intent(f.target)
  expect(publicationMarkdownMatches(originalIntent, f.actual, f.target, evidence)).toBe(false)
  expect(
    publicationMarkdownMatches(originalIntent, local(f.actual), local(f.target), evidence),
  ).toBe(false)
  expect(
    publicationMarkdownMatches(
      originalIntent,
      f.actual,
      f.target,
      evidence,
      (actual, expected) => actual === expected || notionFilenameAlias(actual) === expected,
    ),
  ).toBe(true)
})

for (const mode of ["fresh", "cached", "strict"] as const) {
  test(`the ${mode} reader binds the raw body and existing filename policy to the retained target`, async () => {
    const f = fixture(),
      r = reader(f.actual, f.roots),
      phase = publicationReadPhase()
    const originalIntent = intent(f.target),
      before = JSON.stringify({ f, originalIntent })
    if (mode === "cached")
      phase.proofs.set(page, {
        actual: f.actual,
        blocks: boundaries(f.roots),
        strict_structure: true,
      })
    expect(
      await Effect.runPromise(
        readPublicationMarkdownMatches(
          originalIntent,
          f.actual,
          local(f.target),
          r.api,
          phase,
          mapping,
          mode !== "fresh",
        ),
      ),
    ).toBe(true)
    expect(JSON.stringify({ f, originalIntent })).toBe(before)
    expect(r.calls).toEqual(
      mode === "cached" ? [] : [pagePath, markdownPath, inventoryPath, pagePath],
    )
  })
}

test("the retained proof still requires the whole body and complete original root boundary", async () => {
  const variants = [
    { ...fixture(), roots: [] },
    { ...fixture(), roots: fixture().roots.filter((root) => root.id !== "divider") },
    { ...fixture(), actual: original.actual.replace("Ready.", "Changed.") },
    { ...fixture(), actual: original.actual.replace("http://EXAMPLE.md", "http://OTHER.md") },
    { ...fixture(), actual: original.actual.replace("http://GUIDE.md", "http://OTHER.md") },
    { ...fixture(), actual: original.actual.replace("[reference](http://GUIDE.md)", "reference") },
  ]
  for (const f of variants) {
    const r = reader(f.actual, f.roots)
    expect(
      await Effect.runPromise(
        readPublicationMarkdownMatches(
          intent(f.target),
          f.actual,
          local(f.target),
          r.api,
          publicationReadPhase(),
          mapping,
          true,
        ),
      ),
    ).toBe(false)
  }
})

test("relative aliases do not permit path, query, fragment, credentials, or non-Markdown destinations", async () => {
  for (const destination of [
    "http://GUIDE.md/path",
    "http://GUIDE.md?x=1",
    "http://GUIDE.md#one",
    "http://user@GUIDE.md",
    "http://GUIDE.md:8080",
    "http://guide.md",
    "http://GUIDE.txt",
  ]) {
    const f = fixture(),
      actual = f.actual.replace("http://GUIDE.md", destination),
      r = reader(actual, f.roots)
    expect(
      await Effect.runPromise(
        readPublicationMarkdownMatches(
          intent(f.target),
          actual,
          local(f.target),
          r.api,
          publicationReadPhase(),
          mapping,
          true,
        ),
      ),
    ).toBe(false)
  }
})

test("authored explicit URLs remain strict while a separate relative alias is accepted", async () => {
  const expectedUrl = "https://example.test/exact?key=one#part"
  for (const actualUrl of [
    expectedUrl,
    "http://example.test/exact?key=one#part",
    "https://example.test/other?key=one#part",
    "https://example.test/exact?key=two#part",
    "https://example.test/exact?key=one#other",
  ]) {
    const f = fixture(),
      actual = f.actual + `\n\n[site](${actualUrl})`,
      target = f.target + `\n\n[site](${expectedUrl})`
    const r = reader(actual, [
      ...f.roots,
      block("external", "paragraph", [rich("site", actualUrl)]),
    ])
    expect(
      await Effect.runPromise(
        readPublicationMarkdownMatches(
          intent(target),
          actual,
          local(target),
          r.api,
          publicationReadPhase(),
          mapping,
          true,
        ),
      ),
    ).toBe(actualUrl === expectedUrl)
  }
})

test("an authored absolute Markdown URL cannot use the relative alias policy", async () => {
  const f = fixture(),
    target = f.target.replace("(GUIDE.md)", "(https://GUIDE.md)"),
    r = reader(f.actual, f.roots)
  expect(
    await Effect.runPromise(
      readPublicationMarkdownMatches(
        intent(target),
        f.actual,
        local(target),
        r.api,
        publicationReadPhase(),
        mapping,
        true,
      ),
    ),
  ).toBe(false)
})

test("the raw body cannot authorize another retained or caller target", async () => {
  const f = fixture(),
    r = reader(f.actual, f.roots)
  expect(
    await Effect.runPromise(
      readPublicationMarkdownMatches(
        intent(f.target),
        f.actual,
        local(f.target.replace("Ready.", "Other target.")),
        r.api,
        publicationReadPhase(),
        mapping,
        true,
      ),
    ),
  ).toBe(false)
})

test("a changed metadata bracket still fences the raw filename proof", async () => {
  const f = fixture(),
    r = reader(f.actual, f.roots, true)
  const result = await Effect.runPromise(
    readPublicationMarkdownMatches(
      intent(f.target),
      f.actual,
      local(f.target),
      r.api,
      publicationReadPhase(),
      mapping,
      true,
    ).pipe(Effect.result),
  )
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "WRITE_CONFLICT" } })
})
