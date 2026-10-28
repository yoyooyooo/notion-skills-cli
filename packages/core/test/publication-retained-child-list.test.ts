import { expect, test } from "bun:test"
import { Effect } from "effect"
import { fail, property } from "../src/model.ts"
import { projectNotionBlocks } from "../src/markdown.ts"
import type { Notion } from "../src/notion.ts"
import type { Receipt } from "../src/publication-model.ts"
import {
  publicationMarkdownMatches,
  publicationReadPhase,
  readPublicationMarkdownMatches,
} from "../src/publication-observation.ts"
import { retainedChildListComparison } from "../src/retained-child-list.ts"
import { rewritePageLinks } from "../src/references.ts"

const id = (value: number) => `44444444-4444-4444-8444-${String(value).padStart(12, "0")}`
const page = id(1),
  pagePath = `v1/pages/${page}`,
  markdownPath = `${pagePath}/markdown`
const childIds = [id(6), id(7)],
  external = "https://example.test/manual",
  cursor = "roots /+"
const inventory = (next?: string) =>
  `v1/blocks/${page}/children?page_size=100${next ? `&start_cursor=${encodeURIComponent(next)}` : ""}`
const rich = (content: string, url: string | null = null, code = false) => ({
  type: "text",
  text: { content, link: url === null ? null : { url } },
  plain_text: content,
  href: url,
  annotations: {
    bold: false,
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
  hasChildren = false,
): Record<string, unknown> => ({
  object: "block",
  id: id(value),
  type,
  has_children: hasChildren,
  archived: false,
  in_trash: false,
  parent: { type: "page_id", page_id: page },
  [type]: body,
})
const list = (results: readonly unknown[], next: string | null = null) => ({
  object: "list",
  results,
  has_more: next !== null,
  next_cursor: next,
})

function fixture() {
  const route = `https://app.notion.com/p/${childIds[0]!.replaceAll("-", "")}`
  const wanted = `https://www.notion.so/${childIds[0]!.replaceAll("-", "")}#ntn-skills-path=references%2Fguide-0.md&heading=example`
  const tags = childIds
    .map(
      (child, index) =>
        `<page url="https://app.notion.com/p/${child.replaceAll("-", "")}">guide-${index}.md</page>`,
    )
    .join("\n")
  const tail =
    "- Open [other](../other/SKILL.md)\n- Keep `literal` and [manual](" + external + ")\n"
  const source = `# Start\n\n[Route](${wanted})\n\n## Related\n\n${tail}${tags}`
  const actual = `# Start\n[Route](${route})\n## Related\n${tail}${tags}`
  const leaves = [
    block(4, "bulleted_list_item", {
      color: "default",
      rich_text: [rich("Open "), rich("other", "../other/SKILL.md")],
    }),
    block(5, "bulleted_list_item", {
      color: "default",
      rich_text: [
        rich("Keep "),
        rich("literal", null, true),
        rich(" and "),
        rich("manual", external),
      ],
    }),
  ]
  const children = childIds.map((_, index) =>
    block(6 + index, "child_page", { title: `guide-${index}.md` }, true),
  )
  const roots = [
    block(2, "heading_1", { rich_text: [rich("Start")], color: "default" }),
    block(3, "paragraph", { rich_text: [rich("Route", route)], color: "default" }),
    block(8, "heading_2", { rich_text: [rich("Related")], color: "default" }),
    ...leaves,
    ...children,
  ]
  const responses: Record<string, unknown> = {
    [inventory()]: list(roots.slice(0, 4), cursor),
    [inventory(cursor)]: list(roots.slice(4)),
    [markdownPath]: {
      object: "page_markdown",
      id: page,
      markdown: actual,
      truncated: false,
      unknown_block_ids: [],
    },
  }
  const reads: string[] = []
  let changed = false,
    race = false
  const api: Notion["Service"] = {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture"),
    request: (path, body, options) =>
      Effect.gen(function* () {
        if (body !== undefined || options?.file || (options?.method && options.method !== "GET"))
          return yield* Effect.fail(
            fail("INVALID_RESPONSE", "Only complete captured GETs are allowed."),
          )
        reads.push(path)
        if (path === pagePath)
          return {
            object: "page",
            id: page,
            archived: false,
            in_trash: false,
            last_edited_time: changed ? "2026-10-22T01:01:00.000Z" : "2026-10-22T01:00:00.000Z",
            properties: {},
          }
        if (!Object.hasOwn(responses, path))
          return yield* Effect.fail(
            fail("INVALID_RESPONSE", "A complete captured GET is unavailable.", { path }),
          )
        if (race && path === inventory(cursor)) changed = true
        return structuredClone(responses[path])
      }),
  }
  const intent: Receipt["intents"][number] = {
    method: "PATCH",
    path: markdownPath,
    status: "completed",
    response: { id: page },
    body: { type: "replace_content", replace_content: { new_str: source } },
    typed_links: { page_id: page, markdown: source, state: "pending" },
  }
  const local = (value: string) => rewritePageLinks(value, "", [], "local")
  const mapping = {
    local,
    preserveExternal: (value: string) =>
      rewritePageLinks(value, "", [], "local", [], { preserveExternalUrls: true }),
  }
  return {
    roots,
    leaves,
    children,
    source,
    actual,
    tags,
    tail,
    intent,
    mapping,
    api,
    responses,
    reads,
    race: () => {
      race = true
    },
  }
}

test("a complete flat physical list proves only its retained-child parser separator", () => {
  const f = fixture(),
    before = JSON.stringify(f)
  for (const markdown of [f.source, f.actual]) {
    const framed = retainedChildListComparison(page, markdown, f.roots)
    expect(framed).toBe(markdown.replace("\n" + f.tags, "\n\n" + f.tags))
    expect(framed?.endsWith(f.tags)).toBe(true)
    expect(framed && retainedChildListComparison(page, framed, f.roots)).toBe(framed)
  }
  expect(JSON.stringify(f)).toBe(before)
})

test("list framing refuses any changed leaf span, style, destination, order or hidden descendant", () => {
  for (const change of [
    "text",
    "link",
    "style",
    "code",
    "unknown-field",
    "missing-leaf",
    "reordered-leaves",
    "nested",
  ] as const) {
    const f = fixture(),
      body = property(f.leaves[1]!.bulleted_list_item)
    if (!Array.isArray(body.rich_text)) throw new Error("Fixture spans are required")
    const span = property(body.rich_text.at(-1))
    if (change === "text") {
      property(span.text).content = "changed"
      span.plain_text = "changed"
    }
    if (change === "link") {
      property(span.text).link = { url: "https://example.test/other" }
      span.href = "https://example.test/other"
    }
    if (change === "style") property(span.annotations).bold = true
    if (change === "code") property(span.annotations).code = true
    if (change === "unknown-field") body.unsupported = true
    if (change === "missing-leaf") f.roots.splice(3, 1)
    if (change === "reordered-leaves") f.roots.splice(3, 2, f.leaves[1]!, f.leaves[0]!)
    if (change === "nested") f.leaves[1]!.has_children = true
    expect(retainedChildListComparison(page, f.source, f.roots)).toBeUndefined()
  }
})

test("framing requires the complete ordered child suffix and the supported flat list grammar", () => {
  for (const change of [
    "foreign-owner",
    "duplicate-id",
    "archived",
    "missing-tag",
    "reordered-tags",
    "extra-tag",
    "title",
    "non-suffix-child",
    "fenced",
    "quoted",
    "ordered",
    "task",
  ] as const) {
    const f = fixture()
    let markdown = f.source
    if (change === "foreign-owner") f.children[0]!.parent = { type: "page_id", page_id: id(90) }
    if (change === "duplicate-id") f.children[0]!.id = f.leaves[0]!.id
    if (change === "archived") f.children[0]!.in_trash = true
    if (change === "missing-tag") markdown = markdown.slice(0, markdown.lastIndexOf("\n"))
    if (change === "reordered-tags")
      markdown = markdown.replace(f.tags, f.tags.split("\n").reverse().join("\n"))
    if (change === "extra-tag") markdown += "\n" + f.tags.split("\n")[0]
    if (change === "title") markdown = markdown.replace(">guide-0.md</page>", ">changed.md</page>")
    if (change === "non-suffix-child")
      f.roots.push(block(91, "paragraph", { rich_text: [rich("extra")], color: "default" }))
    if (change === "fenced") markdown = markdown.replace(f.tail, "```text\n" + f.tail)
    if (change === "quoted")
      markdown = markdown.replace(
        f.tail,
        f.tail
          .split("\n")
          .map((line) => (line ? "> " + line : ""))
          .join("\n"),
      )
    if (change === "ordered") markdown = markdown.replace(f.tail, f.tail.replace(/^- /gm, "1. "))
    if (change === "task") markdown = markdown.replace(f.tail, f.tail.replace(/^- /gm, "- [ ] "))
    expect(retainedChildListComparison(page, markdown, f.roots)).toBeUndefined()
  }
})

test("native ACK framing binds complete paginated raw roots and still requires typed-link restoration", async () => {
  const f = fixture(),
    phase = publicationReadPhase(),
    before = JSON.stringify({ intent: f.intent, responses: f.responses })
  const projected = projectNotionBlocks(f.roots)
  expect(projected).toBeDefined()
  expect(publicationMarkdownMatches(f.intent, f.actual, f.source, projected)).toBe(false)
  const check = () =>
    readPublicationMarkdownMatches(
      f.intent,
      f.actual,
      f.mapping.local(f.source),
      f.api,
      phase,
      f.mapping,
      true,
    )
  expect(await Effect.runPromise(check())).toBe(true)
  expect(f.reads).toEqual([pagePath, markdownPath, inventory(), inventory(cursor), pagePath])
  const proof = phase.proofs.get(page)
  expect(proof?.raw_root_blocks).toEqual(f.roots)
  const calls = f.reads.length
  expect(await Effect.runPromise(check())).toBe(true)
  expect(f.reads).toHaveLength(calls)
  const completed: Receipt["intents"][number] = {
    ...f.intent,
    typed_links: { page_id: page, markdown: f.source, state: "completed" },
  }
  expect(
    await Effect.runPromise(
      readPublicationMarkdownMatches(
        completed,
        f.actual,
        f.mapping.local(f.source),
        f.api,
        phase,
        f.mapping,
        true,
      ),
    ),
  ).toBe(false)
  expect(JSON.stringify({ intent: f.intent, responses: f.responses })).toBe(before)
  if (!proof) throw new Error("The same-bracket proof is required")
  phase.proofs.set(page, { actual: proof.actual, blocks: proof.blocks, strict_structure: true })
  expect(await Effect.runPromise(check())).toBe(false)
  expect(f.reads).toHaveLength(calls)
})

test("native framing preserves original target identity, explicit external links and physical list content", async () => {
  for (const change of [
    "caller-target",
    "external-destination",
    "physical-list",
    "child-title",
  ] as const) {
    const f = fixture()
    let actual = f.actual,
      target = f.mapping.local(f.source)
    if (change === "caller-target") target = target.replace("Related", "Changed")
    if (change === "external-destination")
      actual = actual.replace(external, "https://example.test/other")
    if (change === "physical-list")
      property(f.leaves[0]!.bulleted_list_item).rich_text = [rich("Changed physical content")]
    if (change === "child-title") property(f.children[0]!.child_page).title = "changed.md"
    f.responses[markdownPath] = { ...property(f.responses[markdownPath]), markdown: actual }
    const result = await Effect.runPromise(
      readPublicationMarkdownMatches(
        f.intent,
        actual,
        target,
        f.api,
        publicationReadPhase(),
        f.mapping,
        true,
      ).pipe(Effect.result),
    )
    expect(result._tag === "Failure" || result.success === false).toBe(true)
  }
})

test("a retained-list boundary cannot outlive its metadata bracket or incomplete pagination", async () => {
  for (const change of ["metadata", "missing-page", "contradictory-cursor"] as const) {
    const f = fixture()
    if (change === "metadata") f.race()
    if (change === "missing-page") delete f.responses[inventory(cursor)]
    if (change === "contradictory-cursor")
      f.responses[inventory(cursor)] = {
        ...property(f.responses[inventory(cursor)]),
        next_cursor: "unexpected",
      }
    const result = await Effect.runPromise(
      readPublicationMarkdownMatches(
        f.intent,
        f.actual,
        f.mapping.local(f.source),
        f.api,
        publicationReadPhase(),
        f.mapping,
        true,
      ).pipe(Effect.result),
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { code: change === "metadata" ? "WRITE_CONFLICT" : "INVALID_RESPONSE" },
    })
  }
})
