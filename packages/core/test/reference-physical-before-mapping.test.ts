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
const shared = "../../shared/SKILL.md"
const main = "# Instructions\n\nKeep the complete instructions.\n"
const sourceGuide = `# Guide\n\n> Read [shared instructions](${shared}) first.\n\nContinue with [details](details.md).\n\n## Finish\n\nKeep the original text.\n`
const actualGuide = `# Guide\n> Read [shared instructions](${shared}) first.\nContinue with [details](${notion(details)}).\n## Finish\nKeep the original text.`
const span = (text: string, link: string | null = null) => ({
  text,
  link,
  bold: false,
  code: false,
})
const roots: readonly NotionBlockBoundary[] = [
  {
    id: "guide-heading",
    type: "heading_1",
    has_children: false,
    text: "Guide",
    rich_text: [span("Guide")],
  },
  {
    id: "guide-quote",
    type: "quote",
    has_children: false,
    rich_text: [span("Read "), span("shared instructions", shared), span(" first.")],
  },
  {
    id: "guide-next",
    type: "paragraph",
    has_children: false,
    rich_text: [span("Continue with "), span("details", notion(details)), span(".")],
  },
  {
    id: "guide-finish",
    type: "heading_2",
    has_children: false,
    text: "Finish",
    rich_text: [span("Finish")],
  },
  {
    id: "guide-tail",
    type: "paragraph",
    has_children: false,
    text: "Keep the original text.",
    rich_text: [span("Keep the original text.")],
  },
]
const name = "Physical readback before page mapping"
const description = "Preserve proved sibling boundaries while retaining exact destinations."
const portable: PortableSkill = {
  kind: "skill",
  name,
  description,
  main: "SKILL.md",
  files: [
    canonicalMain(name, description, main, { path: "SKILL.md", bytes: new Uint8Array() }),
    { path: "references/guide.md", bytes: new TextEncoder().encode(sourceGuide) },
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
  snapshot_id: "s_reference_physical_mapping",
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
    alias: "reference-physical-mapping",
    locator: { type: "notion_page", page_id: root, database_id: "db", data_source_id: "ds" },
    default_context: false,
    entrypoint: "SKILL.md",
    ref: `skill://${root}/SKILL.md`,
  },
  references: [
    { id: root, path: "SKILL.md", markdown: main },
    { id: guide, path: "references/guide.md", markdown: actualGuide, blocks: roots },
    {
      id: details,
      path: "references/details.md",
      markdown: "# Details\n\nThe required destination.\n",
    },
    { id: other, path: "references/other.md", markdown: "# Other\n\nA different destination.\n" },
  ],
}
const withGuide = (
  markdown: string,
  blocks: readonly NotionBlockBoundary[] | undefined,
): Snapshot => ({
  ...snapshot,
  references: snapshot.references!.map((page) =>
    page.id === guide ? { ...page, markdown, blocks } : page,
  ),
})
const check = async (input: Snapshot, expected: "Success" | "Failure") => {
  const original = JSON.stringify([input, portable])
  const result = await Effect.runPromise(
    referencePagesMatch(input, portable).pipe(Effect.provide(NodeServices.layer), Effect.result),
  )
  expect(result._tag).toBe(expected)
  if (result._tag === "Failure") {
    expect(result.failure.code).toBe("WRITE_VERIFICATION_FAILED")
    expect(result.failure.details).toMatchObject({ page_id: guide, path: "references/guide.md" })
  }
  expect(JSON.stringify([input, portable])).toBe(original)
}

test("final reference proof retains a physical quote/paragraph boundary before mapping its page link", async () => {
  await check(snapshot, "Success")
})

test("the same mapped body cannot supply its own missing physical sibling evidence", async () => {
  await check(withGuide(actualGuide, undefined), "Failure")
  await check(
    withGuide(
      actualGuide,
      roots.filter((block) => block.id !== "guide-next"),
    ),
    "Failure",
  )
})

test("the paragraph readback must agree with the complete physical destination before mapping", async () => {
  const blocks = roots.map((block) =>
    block.id === "guide-next"
      ? { ...block, rich_text: [span("Continue with "), span("details", notion(other)), span(".")] }
      : block,
  )
  await check(withGuide(actualGuide, blocks), "Failure")
})

test("a different known page still fails the complete source destination comparison", async () => {
  const blocks = roots.map((block) =>
    block.id === "guide-next"
      ? { ...block, rich_text: [span("Continue with "), span("details", notion(other)), span(".")] }
      : block,
  )
  await check(withGuide(actualGuide.replace(notion(details), notion(other)), blocks), "Failure")
})

test("a physically consistent changed sibling cannot be replaced with source text", async () => {
  const blocks = roots.map((block) =>
    block.id === "guide-next"
      ? {
          ...block,
          rich_text: [
            span("Different instructions with "),
            span("details", notion(details)),
            span("."),
          ],
        }
      : block,
  )
  await check(
    withGuide(actualGuide.replace("Continue with ", "Different instructions with "), blocks),
    "Failure",
  )
})

test("a separate content change still fails after the finite boundary recovery", async () => {
  const blocks = roots.map((block) =>
    block.id === "guide-tail"
      ? {
          ...block,
          text: "Unrequested replacement.",
          rich_text: [span("Unrequested replacement.")],
        }
      : block,
  )
  await check(
    withGuide(actualGuide.replace("Keep the original text.", "Unrequested replacement."), blocks),
    "Failure",
  )
})
