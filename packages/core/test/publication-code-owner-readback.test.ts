import { expect, test } from "bun:test"
import { Effect } from "effect"
import { fail, property } from "../src/model.ts"
import type { Notion } from "../src/notion.ts"
import type { Receipt } from "../src/publication-model.ts"
import { projectNotionBlockTree, samePublishedMarkdown } from "../src/markdown.ts"
import {
  publicationMarkdownMatches,
  publicationReadPhase,
  readPublicationMarkdownMatches,
} from "../src/publication-observation.ts"
import { physicalReadbackTarget } from "../src/publication-physical-target.ts"
import { readAcknowledgedCodeOwner } from "../src/publication-code-languages.ts"
import { rewritePageLinks } from "../src/references.ts"

const id = (value: number) => `55555555-5555-4555-8555-${String(value).padStart(12, "0")}`
const page = id(1),
  quote = id(4),
  destination = id(90),
  foreign = id(99)
const pagePath = `v1/pages/${page}`,
  markdownPath = `${pagePath}/markdown`
const suffix = "?mode=original#section",
  external = "https://example.test/manual?mode=read#section"
const canonicalUrl = `https://www.notion.so/${destination.replaceAll("-", "")}${suffix}`
const physicalUrl = `https://app.notion.com/p/${destination.replaceAll("-", "")}${suffix}`
const inventory = (owner: string, cursor?: string) =>
  `v1/blocks/${owner}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`
const cursor = "root /+"
const rich = (content: string, code = false, link: string | null = null, bold = false) => ({
  type: "text",
  text: { content, link: link === null ? null : { url: link } },
  plain_text: content,
  href: link,
  annotations: {
    bold,
    code,
    italic: false,
    underline: false,
    strikethrough: false,
    color: "default",
  },
})
const block = (
  value: number,
  type: string,
  body: unknown,
  owner = page,
  hasChildren = false,
): Record<string, unknown> => ({
  object: "block",
  id: id(value),
  type,
  has_children: hasChildren,
  archived: false,
  in_trash: false,
  parent:
    owner === page ? { type: "page_id", page_id: owner } : { type: "block_id", block_id: owner },
  last_edited_time: "2026-10-22T01:00:00.000Z",
  [type]: body,
})
const list = (results: readonly unknown[], next: string | null = null) => ({
  object: "list",
  results,
  has_more: next !== null,
  next_cursor: next,
})
function fixture() {
  const source =
    "# Owner\n\n```text\n  exact code bytes\n```\n\n" +
    `> **SHORTCUT:**\n> - \`run\` [manual](${canonicalUrl}) first.\n>\n> **API:**\n> - \`target\` — Keep unchanged.\n> - \`finish\` — End unchanged.\n\n---\n\n## Finish\n\nRead [external](${external}).\n`
  const actual =
    "# Owner\n```plain text\n  exact code bytes\n```\n" +
    `> **SHORTCUT:**\n\t- \`run\` [manual](${physicalUrl}) first.\n\t**API:**\n\t- \`target\` — Keep unchanged.\n\t- \`finish\` — End unchanged.\n---\n## Finish\nRead [external](${external}).`
  const children = [
    block(
      5,
      "bulleted_list_item",
      {
        color: "default",
        rich_text: [
          rich("run", true),
          rich(" "),
          rich("manual", false, physicalUrl),
          rich(" first."),
        ],
      },
      quote,
    ),
    block(
      9,
      "paragraph",
      { color: "default", rich_text: [rich("API:", false, null, true)] },
      quote,
    ),
    block(
      10,
      "bulleted_list_item",
      { color: "default", rich_text: [rich("target", true), rich(" — Keep unchanged.")] },
      quote,
    ),
    block(
      11,
      "bulleted_list_item",
      { color: "default", rich_text: [rich("finish", true), rich(" — End unchanged.")] },
      quote,
    ),
  ]
  const roots = [
    block(2, "heading_1", { color: "default", rich_text: [rich("Owner")] }),
    block(3, "code", {
      language: "plain text",
      rich_text: [rich("  exact code bytes")],
      caption: [],
    }),
    block(
      4,
      "quote",
      { color: "default", rich_text: [rich("SHORTCUT:", false, null, true)] },
      page,
      true,
    ),
    block(6, "divider", {}),
    block(7, "heading_2", { color: "default", rich_text: [rich("Finish")] }),
    block(8, "paragraph", {
      color: "default",
      rich_text: [rich("Read "), rich("external", false, external), rich(".")],
    }),
  ]
  const responses: Record<string, unknown> = {
    [markdownPath]: {
      object: "page_markdown",
      id: page,
      markdown: actual,
      truncated: false,
      unknown_block_ids: [],
    },
    [inventory(page)]: list(roots.slice(0, 3), cursor),
    [inventory(page, cursor)]: list(roots.slice(3)),
    [inventory(quote)]: list(children),
  }
  const reads: string[] = []
  let metadataCalls = 0,
    race = false
  const api: Notion["Service"] = {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture"),
    request: (path, body, options) =>
      Effect.gen(function* () {
        if (body !== undefined || options?.file || (options?.method && options.method !== "GET"))
          return yield* Effect.fail(
            fail("INVALID_RESPONSE", "The code-owner read cannot issue a write."),
          )
        reads.push(path)
        if (path === pagePath)
          return {
            object: "page",
            id: page,
            archived: false,
            in_trash: false,
            last_edited_time:
              race && ++metadataCalls > 1 ? "2026-10-22T01:01:00.000Z" : "2026-10-22T01:00:00.000Z",
            properties: {},
          }
        if (!Object.hasOwn(responses, path))
          return yield* Effect.fail(
            fail("INVALID_RESPONSE", "A complete captured GET is unavailable.", { path }),
          )
        return structuredClone(responses[path])
      }),
  }
  const intent: Receipt["intents"][number] = {
    method: "PATCH",
    path: markdownPath,
    status: "completed",
    response: { id: page },
    body: { markdown_version: "v2", type: "replace_content", replace_content: { new_str: source } },
  }
  const tree = () => [...roots.slice(0, 3), ...children, ...roots.slice(3)]
  return {
    source,
    actual,
    roots,
    children,
    responses,
    reads,
    api,
    intent,
    tree,
    race: () => {
      race = true
    },
  }
}

function orderedFixture() {
  const f = fixture()
  const sourceList = `7. Keep exact.\n8. Read [manual](${canonicalUrl}) first.\n9. Finish unchanged.\n`
  const actualList = `1. Keep exact.\n2. Read [manual](${physicalUrl}) first.\n3. Finish unchanged.\n`
  const source =
    f.source.slice(0, f.source.indexOf(">")) +
    sourceList +
    f.source.slice(f.source.indexOf("\n---"))
  const actual =
    f.actual.slice(0, f.actual.indexOf(">")) + actualList + f.actual.slice(f.actual.indexOf("---"))
  const numbered = [
    block(12, "numbered_list_item", {
      color: "default",
      list_start_index: 7,
      rich_text: [rich("Keep exact.")],
    }),
    block(13, "numbered_list_item", {
      color: "default",
      rich_text: [rich("Read "), rich("manual", false, physicalUrl), rich(" first.")],
    }),
    block(14, "numbered_list_item", { color: "default", rich_text: [rich("Finish unchanged.")] }),
  ]
  f.roots.splice(2, 1, ...numbered)
  f.responses[inventory(page)] = list(f.roots.slice(0, 3), cursor)
  f.responses[inventory(page, cursor)] = list(f.roots.slice(3))
  f.responses[markdownPath] = { ...property(f.responses[markdownPath]), markdown: actual }
  const intent = {
    ...f.intent,
    body: { markdown_version: "v2", type: "replace_content", replace_content: { new_str: source } },
  }
  return { ...f, source, actual, intent, numbered, tree: () => f.roots }
}

test("the original code owner uses the same finite physical target spelling as final verification", async () => {
  const f = fixture(),
    before = JSON.stringify({ source: f.source, intent: f.intent, responses: f.responses })
  const blocks = projectNotionBlockTree(page, f.tree())
  expect(blocks).toBeDefined()
  expect(publicationMarkdownMatches(f.intent, f.actual, f.source, blocks)).toBe(false)
  const target = physicalReadbackTarget(f.source, blocks)
  expect(target).toBe(f.source.replace(canonicalUrl, physicalUrl))
  expect(samePublishedMarkdown(target, f.source)).toBe(true)
  const state = await Effect.runPromise(readAcknowledgedCodeOwner(page, f.source, f.intent, f.api))
  expect(state.markdown).toBe(f.actual)
  expect(state.roots.map((root) => root.id)).toEqual(f.roots.map((root) => root.id))
  expect(
    state.roots.filter((root) => root.type === "code").map((root) => property(root.code).language),
  ).toEqual(["plain text"])
  expect(f.reads).toEqual([
    pagePath,
    markdownPath,
    inventory(page),
    inventory(quote),
    inventory(page, cursor),
    pagePath,
  ])
  expect(JSON.stringify({ source: f.source, intent: f.intent, responses: f.responses })).toBe(
    before,
  )
})

test("physical spelling cannot invent a destination, query, fragment, scheme or alias without unique evidence", async () => {
  for (const change of ["page", "query", "fragment", "scheme", "missing", "ambiguous"] as const) {
    const f = fixture()
    let url = physicalUrl
    if (change === "page")
      url = physicalUrl.replace(destination.replaceAll("-", ""), foreign.replaceAll("-", ""))
    if (change === "query") url = physicalUrl.replace("mode=original", "mode=other")
    if (change === "fragment") url = physicalUrl.replace("#section", "#other")
    if (change === "scheme") url = physicalUrl.replace("https:", "http:")
    property(f.children[0]!.bulleted_list_item).rich_text = [
      rich("run", true),
      rich(" "),
      rich("manual", false, change === "missing" ? null : url),
      rich(" first."),
    ]
    f.responses[markdownPath] = {
      ...property(f.responses[markdownPath]),
      markdown: f.actual.replace(physicalUrl, url),
    }
    let blocks = projectNotionBlockTree(page, f.tree())
    if (change === "ambiguous" && blocks)
      blocks = [
        ...blocks,
        {
          id: foreign,
          type: "paragraph",
          has_children: false,
          rich_text: [{ text: "another alias", code: false, bold: false, link: canonicalUrl }],
        },
      ]
    expect(physicalReadbackTarget(f.source, blocks)).toBe(f.source)
    if (change !== "ambiguous") {
      const result = await Effect.runPromise(
        readAcknowledgedCodeOwner(page, f.source, f.intent, f.api).pipe(Effect.result),
      )
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: "WRITE_CONFLICT" } })
    }
  }
})

test("code-owner comparison still rejects matching physical and Markdown drift outside or within the recovered quote", async () => {
  for (const change of ["code", "child", "ending", "external"] as const) {
    const f = fixture()
    let markdown = f.actual
    if (change === "code") {
      property(f.roots[1]!.code).rich_text = [rich("  changed code bytes")]
      markdown = markdown.replace("  exact code bytes", "  changed code bytes")
    }
    if (change === "child") {
      property(f.children[2]!.bulleted_list_item).rich_text = [
        rich("other", true),
        rich(" — Keep unchanged."),
      ]
      markdown = markdown.replace("`target` — Keep unchanged.", "`other` — Keep unchanged.")
    }
    if (change === "ending") {
      property(f.roots[5]!.paragraph).rich_text = [rich("Changed ending.")]
      markdown = markdown.replace(`Read [external](${external}).`, "Changed ending.")
    }
    if (change === "external") {
      const changed = external.replace("mode=read", "mode=write")
      property(f.roots[5]!.paragraph).rich_text = [
        rich("Read "),
        rich("external", false, changed),
        rich("."),
      ]
      markdown = markdown.replace(external, changed)
    }
    f.responses[markdownPath] = { ...property(f.responses[markdownPath]), markdown }
    const result = await Effect.runPromise(
      readAcknowledgedCodeOwner(page, f.source, f.intent, f.api).pipe(Effect.result),
    )
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "WRITE_CONFLICT" } })
  }
})

test("the existing complete-tree ownership, pagination and metadata bracket remain mandatory", async () => {
  for (const change of ["missing-tree", "foreign-owner", "terminal-cursor", "metadata"] as const) {
    const f = fixture()
    if (change === "missing-tree") delete f.responses[inventory(quote)]
    if (change === "foreign-owner") f.children[0]!.parent = { type: "block_id", block_id: foreign }
    if (change === "terminal-cursor")
      f.responses[inventory(page, cursor)] = {
        ...property(f.responses[inventory(page, cursor)]),
        next_cursor: "unexpected",
      }
    if (change === "metadata") f.race()
    const result = await Effect.runPromise(
      readAcknowledgedCodeOwner(page, f.source, f.intent, f.api).pipe(Effect.result),
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { code: change === "metadata" ? "WRITE_CONFLICT" : "INVALID_RESPONSE" },
    })
  }
})

test("the original ACK reader reuses the same source-bound spelling before flat ordered-start proof", async () => {
  const f = orderedFixture(),
    before = JSON.stringify({ source: f.source, intent: f.intent, responses: f.responses })
  const blocks = projectNotionBlockTree(page, f.tree())
  expect(publicationMarkdownMatches(f.intent, f.actual, f.source, blocks)).toBe(false)
  expect(
    publicationMarkdownMatches(
      f.intent,
      f.actual,
      physicalReadbackTarget(f.source, blocks),
      blocks,
    ),
  ).toBe(true)
  const local = (value: string) => rewritePageLinks(value, "", [], "local")
  const mapping = {
    local,
    preserveExternal: (value: string) =>
      rewritePageLinks(value, "", [], "local", [], { preserveExternalUrls: true }),
  }
  const phase = publicationReadPhase()
  const read = () =>
    Effect.runPromise(
      readPublicationMarkdownMatches(f.intent, f.actual, local(f.source), f.api, phase, mapping),
    )
  expect(await read()).toBe(true)
  expect(phase.proofs.get(page)?.blocks).toEqual(blocks)
  const calls = f.reads.length
  expect(await read()).toBe(true)
  expect(f.reads.length).toBe(calls)
  expect(JSON.stringify({ source: f.source, intent: f.intent, responses: f.responses })).toBe(
    before,
  )
})

test("ACK spelling proof cannot change caller identity, ordered start, destinations or external links", async () => {
  for (const change of ["caller", "start", "destination", "external"] as const) {
    const f = orderedFixture()
    const local = (value: string) => rewritePageLinks(value, "", [], "local")
    const mapping = {
      local,
      preserveExternal: (value: string) =>
        rewritePageLinks(value, "", [], "local", [], { preserveExternalUrls: true }),
    }
    let caller = local(f.source),
      actual = f.actual
    if (change === "caller") caller += "\nUnretained instruction."
    if (change === "start") property(f.numbered[0]!.numbered_list_item).list_start_index = 8
    if (change === "destination") {
      const changed = physicalUrl.replace("#section", "#other")
      property(f.numbered[1]!.numbered_list_item).rich_text = [
        rich("Read "),
        rich("manual", false, changed),
        rich(" first."),
      ]
      actual = actual.replace(physicalUrl, changed)
    }
    if (change === "external") {
      const changed = external.replace("mode=read", "mode=write")
      property(f.roots.at(-1)!.paragraph).rich_text = [
        rich("Read "),
        rich("external", false, changed),
        rich("."),
      ]
      actual = actual.replace(external, changed)
    }
    f.responses[markdownPath] = { ...property(f.responses[markdownPath]), markdown: actual }
    const result = await Effect.runPromise(
      readPublicationMarkdownMatches(
        f.intent,
        actual,
        caller,
        f.api,
        publicationReadPhase(),
        mapping,
      ),
    )
    expect(result).toBe(false)
  }
})
