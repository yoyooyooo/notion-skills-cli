import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import type { Snapshot } from "../src/model.ts"
import type { NotionBlockBoundary } from "../src/markdown.ts"
import { canonicalMain, type PortableSkill } from "../src/portable.ts"
import { referencePagesMatch } from "../src/reference-mutation.ts"

const root = "11111111-1111-4111-8111-111111111111"
const guide = "22222222-2222-4222-8222-222222222222"
const details = "33333333-3333-4333-8333-333333333333"
const other = "44444444-4444-4444-8444-444444444444"
const notion = (id: string) => `https://app.notion.com/p/${id.replaceAll("-", "")}`
const official = "https://example.test/manual?mode=read#section"
const span = (text: string, code = false, link: string | null = null) => ({
  text,
  code,
  link,
  bold: false,
})
const main = "# Instructions\n\nKeep the complete instructions.\n"

function fixture(external = false) {
  const sourceLink = external ? official : "details.md",
    actualLink = external ? official : notion(details)
  const source = `# Guide\n\n> Read [shared](../../shared/SKILL.md).\n\nKeep this separate instruction.\n\n> Query [manual](${sourceLink}) first.\n>\n> Keep \`target\` unchanged.\n\n---\n\n## Finish\n\nKeep the original ending.\n`
  const actual = `# Guide\n> Read [shared](../../shared/SKILL.md).\nKeep this separate instruction.\n> Query [manual](${actualLink}) first.\n\tKeep \`target\` unchanged.\n---\n## Finish\nKeep the original ending.`
  const blocks: readonly NotionBlockBoundary[] = [
    { id: "heading", type: "heading_1", has_children: false, rich_text: [span("Guide")] },
    {
      id: "first",
      type: "quote",
      has_children: false,
      rich_text: [span("Read "), span("shared", false, "../../shared/SKILL.md"), span(".")],
    },
    {
      id: "separate",
      type: "paragraph",
      has_children: false,
      rich_text: [span("Keep this separate instruction.")],
    },
    {
      id: "query",
      type: "quote",
      has_children: true,
      rich_text: [span("Query "), span("manual", false, actualLink), span(" first.")],
      quote_descendants: [
        {
          id: "child",
          parent_id: "query",
          type: "paragraph",
          has_children: false,
          rich_text: [span("Keep "), span("target", true), span(" unchanged.")],
        },
      ],
    },
    { id: "divider", type: "divider", has_children: false },
    { id: "finish", type: "heading_2", has_children: false, rich_text: [span("Finish")] },
    {
      id: "ending",
      type: "paragraph",
      has_children: false,
      rich_text: [span("Keep the original ending.")],
    },
  ]
  const name = "Source-bound quote mapping",
    description = "Keep source and physical destinations exact."
  const portable: PortableSkill = {
    kind: "skill",
    name,
    description,
    main: "SKILL.md",
    files: [
      canonicalMain(name, description, main, { path: "SKILL.md", bytes: new Uint8Array() }),
      { path: "references/guide.md", bytes: new TextEncoder().encode(source) },
      {
        path: "references/details.md",
        bytes: new TextEncoder().encode("# Details\n\nThe required destination.\n"),
      },
      {
        path: "references/other.md",
        bytes: new TextEncoder().encode("# Other\n\nA different destination.\n"),
      },
    ],
  }
  const snapshot: Snapshot = {
    snapshot_id: "s_source_bound_quote_mapping",
    scope: "test",
    version_id: "test",
    created_at: 0,
    entrypoint: "SKILL.md",
    files: [],
    record: {
      id: `notion_page:${root}`,
      kind: "skill",
      name,
      description,
      alias: "source-bound-quote-mapping",
      locator: { type: "notion_page", page_id: root, database_id: "db", data_source_id: "ds" },
      default_context: false,
      entrypoint: "SKILL.md",
      ref: `skill://${root}/SKILL.md`,
    },
    references: [
      { id: root, path: "SKILL.md", markdown: main },
      { id: guide, path: "references/guide.md", markdown: actual, blocks },
      {
        id: details,
        path: "references/details.md",
        markdown: "# Details\n\nThe required destination.\n",
      },
      { id: other, path: "references/other.md", markdown: "# Other\n\nA different destination.\n" },
    ],
  }
  return { snapshot, portable, actual, actualLink, blocks }
}
type Fixture = ReturnType<typeof fixture>
function withGuide(
  f: Fixture,
  markdown: string,
  blocks: readonly NotionBlockBoundary[] | undefined,
): Fixture {
  return {
    ...f,
    snapshot: {
      ...f.snapshot,
      references: f.snapshot.references!.map((page) =>
        page.id === guide ? { ...page, markdown, blocks } : page,
      ),
    },
  }
}
function withLink(f: Fixture, url: string, physical = true): Fixture {
  return withGuide(
    f,
    f.actual.replace(f.actualLink, url),
    physical
      ? f.blocks.map((block) =>
          block.id === "query"
            ? { ...block, rich_text: [span("Query "), span("manual", false, url), span(" first.")] }
            : block,
        )
      : f.blocks,
  )
}
async function check(f: Fixture, outcome: "Success" | "Failure") {
  const original = JSON.stringify([f.snapshot, f.portable])
  const result = await Effect.runPromise(
    referencePagesMatch(f.snapshot, f.portable).pipe(
      Effect.provide(NodeServices.layer),
      Effect.result,
    ),
  )
  expect(result._tag).toBe(outcome)
  if (result._tag === "Failure") {
    expect(result.failure.code).toBe("WRITE_VERIFICATION_FAILED")
    expect(result.failure.details).toMatchObject({ page_id: guide, path: "references/guide.md" })
  }
  expect(JSON.stringify([f.snapshot, f.portable])).toBe(original)
}

test("final proof binds relative source links to the known graph before decoding a complete quote interval", async () => {
  await check(fixture(), "Success")
})

test("graph mapping cannot supply missing physical descendants or an omitted sibling", async () => {
  const f = fixture()
  await check(withGuide(f, f.actual, undefined), "Failure")
  await check(
    withGuide(
      f,
      f.actual,
      f.blocks.filter((block) => block.id !== "separate"),
    ),
    "Failure",
  )
  await check(
    withGuide(
      f,
      f.actual,
      f.blocks.map((block) =>
        block.id === "query" ? { ...block, quote_descendants: undefined } : block,
      ),
    ),
    "Failure",
  )
})

test("a different known page cannot borrow the source destination", async () => {
  await check(withLink(fixture(), notion(other)), "Failure")
})

test("Notion URL aliases preserve the exact query and fragment", async () => {
  for (const suffix of ["?mode=other", "#unrequested", "?mode=other#unrequested"])
    await check(withLink(fixture(), notion(details) + suffix), "Failure")
})

test("a readback URL still needs its complete physical counterpart", async () => {
  await check(withLink(fixture(), notion(other), false), "Failure")
  await check(withLink(fixture(), `http://www.notion.so/${details.replaceAll("-", "")}`), "Failure")
})

test("matching physical and Markdown content changes cannot replace the frozen source", async () => {
  const f = fixture()
  await check(
    withGuide(
      f,
      f.actual.replace("Keep `target` unchanged.", "Keep `other` unchanged."),
      f.blocks.map((block) =>
        block.id === "query"
          ? {
              ...block,
              quote_descendants: [
                {
                  id: "child",
                  parent_id: "query",
                  type: "paragraph",
                  has_children: false,
                  rich_text: [span("Keep "), span("other", true), span(" unchanged.")],
                },
              ],
            }
          : block,
      ),
    ),
    "Failure",
  )
})

test("the original explicit external destination gate remains active", async () => {
  await check(fixture(true), "Success")
  for (const url of [
    "https://example.test/manual?mode=write#section",
    "https://example.test/manual?mode=read#other",
    "https://other.test/manual?mode=read#section",
    "http://example.test/manual?mode=read#section",
  ])
    await check(withLink(fixture(true), url), "Failure")
})

test("whole-page verification still rejects content outside the recovered interval", async () => {
  const f = fixture()
  await check(
    withGuide(
      f,
      f.actual.replace("Keep the original ending.", "Unrequested replacement."),
      f.blocks.map((block) =>
        block.id === "ending" ? { ...block, rich_text: [span("Unrequested replacement.")] } : block,
      ),
    ),
    "Failure",
  )
})
