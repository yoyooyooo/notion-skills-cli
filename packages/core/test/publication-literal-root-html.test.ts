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
import { publicationExternalLinksMatch } from "../src/publication-markdown.ts"
import { referencePagesMatch } from "../src/reference-mutation.ts"
import { canonicalMain, type PortableSkill } from "../src/portable.ts"

const page = "11111111-1111-4111-8111-111111111111"
const pagePath = `v1/pages/${page}`,
  markdownPath = `${pagePath}/markdown`
const inventory = `v1/blocks/${page}/children?page_size=100`
const nextInventory = `${inventory}&start_cursor=remaining`
const name = "Literal root proof",
  description = "Keep original literal instructions."
const root = (id: string, type: string, content: string) => ({
  id,
  type,
  has_children: false,
  parent: { type: "page_id", page_id: page },
  [type]: {
    rich_text: [
      {
        type: "text",
        plain_text: content,
        text: { content, link: null },
        annotations: { bold: false, code: false },
      },
    ],
  },
})
const cases = [
  {
    key: "standalone custom tags",
    target: "Before\n\n<instructions>\n\nKeep every instruction.\n\n</instructions>\n\nAfter",
    actual: "Before\n\\<instructions\\>\nKeep every instruction.\n\\</instructions\\>\nAfter",
    roots: [
      root("a", "paragraph", "Before"),
      root("b", "paragraph", "<instructions>"),
      root("c", "paragraph", "Keep every instruction."),
      root("d", "paragraph", "</instructions>"),
      root("e", "paragraph", "After"),
    ],
  },
  {
    key: "single-line quote placeholders",
    target: "Before\n\n> Status <N> follows <reason one> and <reason two>.\n\nAfter",
    actual: "Before\n> Status \\<N\\> follows \\<reason one\\> and \\<reason two\\>.\nAfter",
    roots: [
      root("a", "paragraph", "Before"),
      root("b", "quote", "Status <N> follows <reason one> and <reason two>."),
      root("c", "paragraph", "After"),
    ],
  },
]
const intent = (target: string): Receipt["intents"][number] => ({
  path: markdownPath,
  method: "PATCH",
  status: "completed",
  body: { type: "replace_content", replace_content: { new_str: target } },
})
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
            properties: {},
            archived: false,
            in_trash: false,
            last_edited_time:
              changedMetadata && metadataReads++
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
        if (path === inventory)
          return { results: roots.slice(0, 2), has_more: true, next_cursor: "remaining" }
        if (path === nextInventory)
          return { results: roots.slice(2), has_more: false, next_cursor: null }
        return yield* Effect.fail(fail("INVALID_RESPONSE", "Unexpected literal-root test request."))
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
      alias: "literal-root-proof",
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
  test(`official ACK reader proves ${item.key} through complete pagination and metadata brackets`, async () => {
    const before = JSON.stringify(item)
    for (const mode of ["fresh", "strict", "cached"] as const) {
      const f = reader(item.actual, item.roots),
        phase = publicationReadPhase()
      if (mode === "cached")
        phase.proofs.set(page, {
          actual: item.actual,
          blocks: projectNotionBlocks(item.roots)!,
          strict_structure: true,
        })
      expect(
        await Effect.runPromise(
          readPublicationMarkdownMatches(
            intent(item.target),
            item.actual,
            item.target,
            f.api,
            phase,
            undefined,
            mode !== "fresh",
          ),
        ),
      ).toBe(true)
      expect(f.calls).toEqual(
        mode === "cached" ? [] : [pagePath, markdownPath, inventory, nextInventory, pagePath],
      )
    }
    expect(JSON.stringify(item)).toBe(before)
  })
  test(`snapshot decoding and the final verifier preserve the same ${item.key} proof`, async () => {
    const blocks = projectNotionBlocks(item.roots)!,
      f = finalInput(item.actual, item.target, blocks),
      before = JSON.stringify(f)
    expect(f.snapshot.references![0]!.blocks).toEqual(blocks)
    expect(await finalResult(f.snapshot, f.portable)).toMatchObject({
      _tag: "Success",
      success: true,
    })
    const changed = finalInput(item.actual.replace("After", "Changed"), item.target, blocks)
    expect(await finalResult(changed.snapshot, changed.portable)).toMatchObject({
      _tag: "Failure",
      failure: { code: "WRITE_VERIFICATION_FAILED" },
    })
    const missing = finalInput(item.actual, item.target, [])
    expect(await finalResult(missing.snapshot, missing.portable)).toMatchObject({
      _tag: "Failure",
      failure: { code: "WRITE_VERIFICATION_FAILED" },
    })
    expect(JSON.stringify(f)).toBe(before)
  })
}
test("a real metadata revision change or foreign physical owner blocks the new reader proof", async () => {
  const item = cases[0]!
  const changed = reader(item.actual, item.roots, true)
  expect(
    await Effect.runPromise(
      readPublicationMarkdownMatches(
        intent(item.target),
        item.actual,
        item.target,
        changed.api,
        publicationReadPhase(),
        undefined,
        true,
      ).pipe(Effect.result),
    ),
  ).toMatchObject({ _tag: "Failure", failure: { code: "WRITE_CONFLICT" } })
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
test("literal tag recovery keeps full explicit external destinations in the final gate", async () => {
  const item = cases[0]!,
    suffix = "\n\n[site](https://example.test/exact)",
    blocks = projectNotionBlocks(item.roots)!
  expect(
    publicationExternalLinksMatch(
      item.actual + suffix,
      item.target + suffix,
      (value) => value,
      blocks,
    ),
  ).toBe(true)
  expect(
    publicationExternalLinksMatch(
      item.actual + suffix.replace("https:", "http:"),
      item.target + suffix,
      (value) => value,
      blocks,
    ),
  ).toBe(false)
  const f = finalInput(
    item.actual + suffix.replace("/exact", "/changed"),
    item.target + suffix,
    blocks,
  )
  expect(await finalResult(f.snapshot, f.portable)).toMatchObject({
    _tag: "Failure",
    failure: { code: "WRITE_VERIFICATION_FAILED" },
  })
})
