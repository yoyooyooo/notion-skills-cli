import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import type { Snapshot } from "../src/model.ts"
import { canonicalMain, type PortableSkill } from "../src/portable.ts"
import { projectNotionBlocks } from "../src/markdown.ts"
import { referencePagesMatch } from "../src/reference-mutation.ts"

const page = "11111111-1111-4111-8111-111111111111"
const name = "Final filename proof",
  description = "Keep source and physical roots bound."
const target =
  "Read EXAMPLE.md and [reference](GUIDE.md).\n\nA short status.\n\n---\n\n## Next\n\nReady."
const actual =
  "Read [EXAMPLE.md](http://EXAMPLE.md) and [reference](http://GUIDE.md).\nA short status.\n---\n## Next\nReady."
const rich = (content: string, url: string | null = null) => ({
  type: "text",
  text: { content, link: url === null ? null : { url } },
  annotations: {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: "default",
  },
})
const block = (id: string, type: string, spans: ReturnType<typeof rich>[] = []) => ({
  id,
  type,
  has_children: false,
  parent: { type: "page_id", page_id: page },
  [type]: { rich_text: spans },
})
const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer), Effect.result))
function fixture(source = target) {
  const roots = [
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
  ]
  const blocks = projectNotionBlocks(roots)
  if (!blocks) throw new Error("Complete root fixture required")
  const portable: PortableSkill = {
    kind: "skill",
    name,
    description,
    main: "SKILL.md",
    files: [
      canonicalMain(name, description, source, { path: "SKILL.md", bytes: new Uint8Array() }),
      {
        path: "agents/openai.yaml",
        bytes: new TextEncoder().encode("interface:\n  display_name: Example\n"),
      },
      { path: "HTML-REPORT.md", bytes: new TextEncoder().encode("# Retained text attachment\n") },
    ],
  }
  const snapshot: Snapshot = {
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
      alias: "final-filename-proof",
      description,
      default_context: false,
      entrypoint: "SKILL.md",
      ref: `skill://${page}/SKILL.md`,
    },
    references: [
      { id: page, path: "SKILL.md", markdown: actual, blocks },
      {
        id: "22222222-2222-4222-8222-222222222222",
        path: "HTML-REPORT.md",
        markdown: "# Retained text attachment\n",
        blocks: [],
      },
    ],
  }
  return { portable, snapshot, roots }
}
async function rejects(snapshot: Snapshot, portable: PortableSkill) {
  const result = await run(referencePagesMatch(snapshot, portable))
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.code).toBe("WRITE_VERIFICATION_FAILED")
}
test("final verifier shares the existing raw source policy only with physical roots", async () => {
  const f = fixture(),
    before = JSON.stringify(f)
  const result = await run(referencePagesMatch(f.snapshot, f.portable))
  expect(result._tag).toBe("Success")
  if (result._tag === "Success") expect(result.success).toBe(true)
  expect(JSON.stringify(f)).toBe(before)
  await rejects(
    {
      ...f.snapshot,
      references: f.snapshot.references!.map((row) => ({ ...row, blocks: undefined })),
    },
    f.portable,
  )
})
test("complete source prose and the ordered divider remain required", async () => {
  const f = fixture()
  await rejects(f.snapshot, fixture(target + "\n\nAdditional source instruction.").portable)
  await rejects(
    {
      ...f.snapshot,
      references: f.snapshot.references!.map((row) => ({
        ...row,
        markdown: row.markdown + "\nUnsubmitted text.",
      })),
    },
    f.portable,
  )
  await rejects(
    {
      ...f.snapshot,
      references: f.snapshot.references!.map((row) => ({
        ...row,
        blocks: row.blocks!.filter((block) => block.type !== "divider"),
      })),
    },
    f.portable,
  )
})
test("filename aliases do not erase port, path, query, fragment, credentials, or case", async () => {
  for (const url of [
    "http://GUIDE.md:8080",
    "http://GUIDE.md/other",
    "http://GUIDE.md?x=1",
    "http://GUIDE.md#part",
    "http://user@GUIDE.md",
    "http://guide.md",
  ]) {
    const f = fixture()
    await rejects(
      {
        ...f.snapshot,
        references: f.snapshot.references!.map((row) => ({
          ...row,
          markdown: row.markdown.replace("http://GUIDE.md", url),
        })),
      },
      f.portable,
    )
  }
})
test("explicit external source URLs retain their exact scheme and components", async () => {
  for (const url of [
    "https://GUIDE.md",
    "http://GUIDE.md/path",
    "http://GUIDE.md?x=1",
    "http://GUIDE.md#part",
  ]) {
    const f = fixture(target.replace("](GUIDE.md)", `](${url})`))
    await rejects(f.snapshot, f.portable)
  }
})
test("page graph and live metadata still bind the complete source", async () => {
  const f = fixture()
  await rejects(
    { ...f.snapshot, record: { ...f.snapshot.record, description: "Changed" } },
    f.portable,
  )
  await rejects({ ...f.snapshot, references: [] }, f.portable)
  await rejects(
    {
      ...f.snapshot,
      references: [
        ...f.snapshot.references!,
        {
          id: "22222222-2222-4222-8222-222222222222",
          path: "references/extra.md",
          markdown: "Extra",
        },
      ],
    },
    f.portable,
  )
})
