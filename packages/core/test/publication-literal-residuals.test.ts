import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { projectNotionBlocks, type NotionBlockBoundary } from "../src/markdown.ts"
import { decode, fail, SnapshotSchema, type Snapshot } from "../src/model.ts"
import type { Notion } from "../src/notion.ts"
import type { Receipt } from "../src/publication-model.ts"
import {
  publicationReadPhase,
  readPublicationMarkdownMatches,
} from "../src/publication-observation.ts"
import { referencePagesMatch } from "../src/reference-mutation.ts"
import { canonicalMain, type PortableSkill } from "../src/portable.ts"

const page = "11111111-1111-4111-8111-111111111111"
const pagePath = `v1/pages/${page}`,
  markdownPath = `${pagePath}/markdown`
const inventory = `v1/blocks/${page}/children?page_size=100`,
  nextInventory = inventory + "&start_cursor=remaining"
const name = "Exact literal residuals",
  description = "Preserve every original instruction."
interface Span {
  readonly text: string
  readonly bold?: boolean
  readonly code?: boolean
  readonly link?: string
}
interface RawRoot extends Record<string, unknown> {
  readonly id: string
  readonly type: string
  readonly has_children: false
  readonly parent: { readonly type: "page_id"; readonly page_id: string }
}
function root(
  id: string,
  type: string,
  content: string | readonly Span[],
  fields: Record<string, unknown> = {},
): RawRoot {
  const spans: readonly Span[] = typeof content === "string" ? [{ text: content }] : content
  return {
    id,
    type,
    has_children: false,
    parent: { type: "page_id", page_id: page },
    [type]: {
      rich_text: spans.map((span) => ({
        type: "text",
        plain_text: span.text,
        text: { content: span.text, link: span.link === undefined ? null : { url: span.link } },
        annotations: { bold: span.bold ?? false, code: span.code ?? false },
      })),
      ...fields,
    },
  }
}
const cases = [
  {
    key: "task-root positions",
    target: "Before\n\n<task-box>\n\n- [ ] Check one.\n- [x] Check two.\n\n</task-box>\n\nAfter",
    actual: "Before\n\\<task-box\\>\n- [ ] Check one.\n- [x] Check two.\n\\</task-box\\>\nAfter",
    roots: [
      root("a", "paragraph", "Before"),
      root("b", "paragraph", "<task-box>"),
      root("c", "to_do", "Check one.", { checked: false }),
      root("d", "to_do", "Check two.", { checked: true }),
      root("e", "paragraph", "</task-box>"),
      root("f", "paragraph", "After"),
    ],
  },
  {
    key: "adjacent empty quote",
    target: "Before\n\n>\n</template-box>\n\n## After",
    actual: "Before\n>\n\\</template-box\\>\n## After",
    roots: [
      root("a", "paragraph", "Before"),
      root("b", "quote", []),
      root("c", "paragraph", "</template-box>"),
      root("d", "heading_2", "After"),
    ],
  },
  {
    key: "literal heading placeholders",
    target: "Before\n\n# <id>: <ticket name>\n\nAfter",
    actual: "Before\n# \\<id\\>: \\<ticket name\\>\nAfter",
    roots: [
      root("a", "paragraph", "Before"),
      root("b", "heading_1", "<id>: <ticket name>"),
      root("c", "paragraph", "After"),
    ],
  },
  {
    key: "literal paragraph with bold spans",
    target: "## Fields\n\n**From:** <start date>, **To:** <end date>\n\n## After",
    actual: "## Fields\n**From:** \\<start date\\>, **To:** \\<end date\\>\n## After",
    roots: [
      root("a", "heading_2", "Fields"),
      root("b", "paragraph", [
        { text: "From:", bold: true },
        { text: " <start date>, " },
        { text: "To:", bold: true },
        { text: " <end date>" },
      ]),
      root("c", "heading_2", "After"),
    ],
  },
  {
    key: "literal HTML with a heading root",
    target: "Before\n\n<template-box>\n### Write the next question\n\nAfter",
    actual: "Before\n\\<template-box\\>\n### Write the next question\nAfter",
    roots: [
      root("a", "paragraph", "Before"),
      root("b", "paragraph", "<template-box>"),
      root("c", "heading_3", "Write the next question"),
      root("d", "paragraph", "After"),
    ],
  },
  {
    key: "retained wrapper LF serialized as br",
    target: "Before\n\n<extra-notes>\n1. Preserve one extra item.\n</extra-notes>\n\nAfter",
    actual: "Before\n\\<extra-notes\\>\n1. Preserve one extra item.<br>\\</extra-notes\\>\nAfter",
    roots: [
      root("a", "paragraph", "Before"),
      root("b", "paragraph", "<extra-notes>"),
      root("c", "numbered_list_item", "Preserve one extra item.\n</extra-notes>"),
      root("d", "paragraph", "After"),
    ],
  },
  {
    key: "restored positive start with paragraph boundary",
    target: "## Steps\n\nOne paragraph.\n\n3. Keep `x  y` exact.\n\nAfter",
    actual: "## Steps\nOne paragraph.\n1. Keep `x  y` exact.\nAfter",
    roots: [
      root("a", "heading_2", "Steps"),
      root("b", "paragraph", "One paragraph."),
      root(
        "c",
        "numbered_list_item",
        [{ text: "Keep " }, { text: "x  y", code: true }, { text: " exact." }],
        { list_start_index: 3 },
      ),
      root("d", "paragraph", "After"),
    ],
  },
  {
    key: "single literal list item",
    target: "## Fields\n\n1. Describe <goal> and <owner>.\n\n## After",
    actual: "## Fields\n1. Describe \\<goal\\> and \\<owner\\>.\n## After",
    roots: [
      root("a", "heading_2", "Fields"),
      root("b", "numbered_list_item", "Describe <goal> and <owner>."),
      root("c", "heading_2", "After"),
    ],
  },
]
const intent = (target: string): Receipt["intents"][number] => ({
  path: markdownPath,
  method: "PATCH",
  status: "completed",
  response: { id: page },
  body: { type: "replace_content", replace_content: { new_str: target } },
})
function reader(
  actual: string,
  roots: readonly unknown[],
  change: "revision" | "truncated" | "pagination" | undefined = undefined,
) {
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
            properties: {},
            archived: false,
            in_trash: false,
            last_edited_time:
              change === "revision" && revisions++
                ? "2026-10-22T00:00:00.000Z"
                : "2026-10-21T00:00:00.000Z",
          }
        if (path === markdownPath)
          return {
            object: "page_markdown",
            markdown: actual,
            truncated: change === "truncated",
            unknown_block_ids: [],
          }
        if (path === inventory)
          return {
            results: roots.slice(0, 2),
            has_more: true,
            next_cursor: change === "pagination" ? null : "remaining",
          }
        if (path === nextInventory)
          return { results: roots.slice(2), has_more: false, next_cursor: null }
        return yield* Effect.fail(
          fail("INVALID_RESPONSE", "Unexpected literal residual test read."),
        )
      }),
  }
  return { api, calls }
}
function finalInput(actual: string, target: string, blocks: readonly NotionBlockBoundary[]) {
  const portable: PortableSkill = {
    kind: "skill",
    name,
    description,
    main: "SKILL.md",
    files: [
      canonicalMain(name, description, target, { path: "SKILL.md", bytes: new Uint8Array() }),
    ],
  }
  const snapshot = decode(SnapshotSchema, {
    snapshot_id: "test",
    scope: "test",
    version_id: "test",
    created_at: 0,
    entrypoint: "SKILL.md",
    files: [],
    record: {
      id: `notion_page:${page}`,
      kind: "skill",
      locator: { type: "notion_page", page_id: page, database_id: "db", data_source_id: "ds" },
      name,
      alias: "exact-literal-residuals",
      description,
      default_context: false,
      entrypoint: "SKILL.md",
      ref: `skill://${page}/SKILL.md`,
    },
    references: [{ id: page, path: "SKILL.md", markdown: actual, blocks }],
  })
  return { portable, snapshot }
}
const finalResult = (snapshot: Snapshot, portable: PortableSkill) =>
  Effect.runPromise(
    referencePagesMatch(snapshot, portable).pipe(Effect.provide(NodeServices.layer), Effect.result),
  )

for (const item of cases) {
  test(`official reader and its fresh cache retain ${item.key}`, async () => {
    const before = JSON.stringify(item)
    for (const strict of [false, true])
      for (const mapped of [false, true]) {
        const f = reader(item.actual, item.roots),
          phase = publicationReadPhase()
        const map = mapped
          ? { local: (value: string) => value, preserveExternal: (value: string) => value }
          : undefined
        expect(
          await Effect.runPromise(
            readPublicationMarkdownMatches(
              intent(item.target),
              item.actual,
              item.target,
              f.api,
              phase,
              map,
              strict,
            ),
          ),
        ).toBe(true)
        expect(f.calls).toEqual([pagePath, markdownPath, inventory, nextInventory, pagePath])
        expect(
          await Effect.runPromise(
            readPublicationMarkdownMatches(
              intent(item.target),
              item.actual,
              item.target,
              f.api,
              phase,
              map,
              strict,
            ),
          ),
        ).toBe(true)
        expect(f.calls).toHaveLength(5)
      }
    expect(JSON.stringify(item)).toBe(before)
  })
  test(`SnapshotSchema and final source-derived verifier retain ${item.key}`, async () => {
    const blocks = projectNotionBlocks(item.roots)!,
      f = finalInput(item.actual, item.target, blocks),
      before = JSON.stringify(f)
    expect(f.snapshot.references![0]!.blocks).toEqual(blocks)
    expect(await finalResult(f.snapshot, f.portable)).toMatchObject({
      _tag: "Success",
      success: true,
    })
    for (const [actual, target, evidence] of [
      [item.actual.replace("After", "Changed"), item.target, blocks],
      [item.actual, item.target + "\n\nUnobserved source instruction.", blocks],
      [item.actual, item.target, []],
    ] as const) {
      const changed = finalInput(actual, target, evidence)
      expect(await finalResult(changed.snapshot, changed.portable)).toMatchObject({
        _tag: "Failure",
        failure: { code: "WRITE_VERIFICATION_FAILED" },
      })
    }
    expect(JSON.stringify(f)).toBe(before)
  })
}
test("new literal families still refuse changed revision, incomplete Markdown, pagination and foreign owners", async () => {
  const item = cases[1]!
  for (const change of ["revision", "truncated", "pagination"] as const) {
    const f = reader(item.actual, item.roots, change)
    const proof = readPublicationMarkdownMatches(
      intent(item.target),
      item.actual,
      item.target,
      f.api,
      publicationReadPhase(),
      undefined,
      true,
    )
    if (change === "truncated") {
      // pageMarkdown synchronously refuses an incomplete envelope inside the
      // existing reader. Effect.result does not turn a thrown defect into a Fail.
      const rejected = await Effect.runPromise(proof).then(
        () => undefined,
        (error) => error,
      )
      expect(rejected).toMatchObject({ _tag: "SkillsError", code: "MARKDOWN_INCOMPLETE" })
      expect(f.calls).toEqual([pagePath, markdownPath])
      continue
    }
    const result = await Effect.runPromise(proof.pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure")
      expect(result.failure.code).toBe(
        change === "revision" ? "WRITE_CONFLICT" : "INVALID_RESPONSE",
      )
  }
  const foreign = reader(
    item.actual,
    item.roots.map((block, index) =>
      index === 1
        ? { ...block, parent: { type: "page_id", page_id: "22222222-2222-4222-8222-222222222222" } }
        : block,
    ),
  )
  expect(
    await Effect.runPromise(
      readPublicationMarkdownMatches(
        intent(item.target),
        item.actual,
        item.target,
        foreign.api,
        publicationReadPhase(),
        undefined,
        true,
      ).pipe(Effect.result),
    ),
  ).toMatchObject({ _tag: "Failure", failure: { code: "INVALID_RESPONSE" } })
})
test("final destination proof rejects an unrelated external URL change after every new boundary family", async () => {
  for (const item of cases) {
    const suffix = "\n\n[Original](https://example.test/a?q=1#keep)"
    const raw = [
      ...item.roots,
      root("external", "paragraph", [
        { text: "Original", link: "https://example.test/a?q=1#keep" },
      ]),
    ]
    const blocks = projectNotionBlocks(raw)!
    const retained = finalInput(item.actual + suffix, item.target + suffix, blocks)
    expect(await finalResult(retained.snapshot, retained.portable)).toMatchObject({
      _tag: "Success",
      success: true,
    })
    const changed = finalInput(
      item.actual + suffix.replace("q=1", "q=2"),
      item.target + suffix,
      blocks,
    )
    expect(await finalResult(changed.snapshot, changed.portable)).toMatchObject({
      _tag: "Failure",
      failure: { code: "WRITE_VERIFICATION_FAILED" },
    })
  }
})
