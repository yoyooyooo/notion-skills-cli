import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer } from "effect"
import { portableIdentity, snapshotAuthoredPortable } from "../src/export.ts"
import type { Snapshot } from "../src/model.ts"
import type { NotionBlockBoundary } from "../src/markdown.ts"
import { projectNotionBlocks } from "../src/markdown.ts"
import {
  BUNDLE,
  bodyIdentity,
  canonicalMain,
  portableZip,
  type PortableSkill,
} from "../src/portable.ts"
import { creationMarker, type CreationProof } from "../src/publication-create-identity.ts"
import { Store } from "../src/store.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

const root = "11111111-1111-4111-8111-111111111111"
const child = "22222222-2222-4222-8222-222222222222"
const referencePath = "references/review.md"
const encode = (text: string) => new TextEncoder().encode(text)
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const sourceText =
  "# Review\n\nKeep the context.\n\n0. **Check structure.** Keep it simple.\n\n1. **Check proof.** Keep it exact.\n\n## Result\n\nPreserve every instruction.\n"
const readback =
  "# Review\nKeep the context.\n0. **Check structure.** Keep it simple.\n1. **Check proof.** Keep it exact.\n## Result\nPreserve every instruction.\n"
const proof: CreationProof = {
  version: 1,
  operation_token: "33333333-3333-4333-8333-333333333333",
  operation_id: "p_export_creation_framing",
  intent_index: 1,
  scope: "test",
  database_id: "db",
  data_source_id: "ds",
  role: "reference",
  path: referencePath,
  parent_type: "page_id",
  parent_id: root,
  intended_hash: "a".repeat(64),
  source_sha256: digest(encode(sourceText)),
}
const rich = (content: string, bold = false) => ({
  type: "text",
  text: { content, link: null },
  plain_text: content,
  annotations: {
    bold,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: "default",
  },
})
const rawBlock = (id: string, type: string, spans: ReturnType<typeof rich>[]) => ({
  id,
  type,
  has_children: false,
  parent: { type: "page_id", page_id: child },
  [type]: { rich_text: spans },
})

function fixture(
  changed = false,
  variant?: {
    source: string
    readback: string
    blocks: readonly NotionBlockBoundary[]
  },
) {
  const name = "Reference source",
    description = "Preserve exact authored bytes."
  const mainBody = "# Main\n\nKeep the complete reference.\n"
  const authored = variant?.source ?? sourceText
  const actual = variant?.readback ?? readback
  const main = canonicalMain(name, description, mainBody, {
    path: "SKILL.md",
    bytes: new Uint8Array(),
  })
  const resource = { path: "agents/review.yaml", bytes: encode("mode: review\n") }
  const source: PortableSkill = {
    kind: "skill",
    name,
    description,
    main: main.path,
    files: [main, { path: referencePath, bytes: encode(authored) }, resource],
  }
  const currentText = changed
    ? actual.replace("Keep it simple.", "Check the changed instruction.")
    : actual
  const marker = creationMarker({ ...proof, source_sha256: digest(encode(authored)) })
  const blocks = projectNotionBlocks([
    rawBlock("marker", "paragraph", [
      rich("ntn-skills-create"),
      rich(":v1:"),
      rich(marker.slice("ntn-skills-create:v1:".length)),
    ]),
    rawBlock("heading", "heading_1", [rich("Review")]),
    rawBlock("context", "paragraph", [rich("Keep the context.")]),
    rawBlock("zero", "paragraph", [
      rich("0. "),
      rich("Check structure.", true),
      rich(changed ? " Check the changed instruction." : " Keep it simple."),
    ]),
    rawBlock("one", "paragraph", [
      rich("1. "),
      rich("Check proof.", true),
      rich(" Keep it exact."),
    ]),
    rawBlock("result-heading", "heading_2", [rich("Result")]),
    rawBlock("result", "paragraph", [rich("Preserve every instruction.")]),
  ])
  if (!blocks) throw new Error("Complete physical fixture required")
  const materialized = encode(currentText)
  const captured = [
    main,
    { path: referencePath, bytes: materialized },
    resource,
    {
      path: BUNDLE,
      bytes: portableZip(
        {
          ...source,
          projection: {
            name,
            description,
            body: bodyIdentity(mainBody),
            references: { [referencePath]: bodyIdentity(actual) },
          },
        },
        true,
      ),
    },
  ]
  const objects = new Map(captured.map((file) => [`objects/${digest(file.bytes)}`, file.bytes]))
  const snapshot: Snapshot = {
    snapshot_id: "s_export_creation_framing",
    scope: "test",
    version_id: "test",
    created_at: 0,
    entrypoint: main.path,
    record: {
      id: `notion_page:${root}`,
      kind: "skill",
      name,
      alias: "reference-source",
      description,
      default_context: false,
      entrypoint: main.path,
      ref: `skill://${root}/${main.path}`,
      locator: { type: "notion_page", page_id: root, database_id: "db", data_source_id: "ds" },
    },
    files: captured.map((file) => ({
      path: file.path,
      bytes: file.bytes.length,
      sha256: digest(file.bytes),
    })),
    references: [
      { id: root, path: main.path, markdown: mainBody },
      {
        id: child,
        path: referencePath,
        markdown: `${marker.replaceAll(":", "\\:")}\n${currentText}`,
        blocks: variant ? [blocks[0]!, ...variant.blocks] : blocks,
      },
    ],
  }
  const forbidden = () => Effect.die(new Error("Unexpected store operation in pure export fixture"))
  const store = Layer.succeed(Store, {
    root: "/memory",
    configRoot: "/memory",
    cacheRoot: "/memory",
    integrity: integrityRepositoryFixture(),
    upstream: upstreamRepositoryFixture(),
    reserveCacheGeneration: forbidden,
    listKeys: forbidden,
    retireKeys: forbidden,
    readJson: forbidden,
    writeJson: forbidden,
    writeBytes: forbidden,
    registerBindingWithBase: forbidden,
    advanceBaseAndReceipt: forbidden,
    backup: forbidden,
    output: forbidden,
    readBytes: (key) => (objects.has(key) ? Effect.succeed(objects.get(key)!) : forbidden()),
  })
  const live = Layer.mergeAll(NodeServices.layer, store)
  const run = <A, E>(effect: Effect.Effect<A, E, Store | NodeServices.NodeServices>) =>
    Effect.runPromise(effect.pipe(Effect.provide(live)))
  return { source, snapshot, materialized, objects, run }
}

test("authored export retains exact source bytes after creation-marker zero-list readback", async () => {
  const f = fixture()
  const before = JSON.stringify(f.snapshot)
  const objectHashes = [...f.objects].map(([key, bytes]) => [key, digest(bytes)])
  const saved = await f.run(snapshotAuthoredPortable(f.snapshot))
  expect(await f.run(portableIdentity(saved))).toBe(await f.run(portableIdentity(f.source)))
  expect(saved.files.find((file) => file.path === referencePath)!.bytes).toEqual(encode(sourceText))
  expect(saved.files.find((file) => file.path === "agents/review.yaml")!.bytes).toEqual(
    encode("mode: review\n"),
  )
  expect(JSON.stringify(f.snapshot)).toBe(before)
  expect([...f.objects].map(([key, bytes]) => [key, digest(bytes)])).toEqual(objectHashes)
})

test("authored export refuses a marker whose physical paragraph belongs to another creation", async () => {
  const f = fixture()
  const wrong = creationMarker({ ...proof, operation_id: "p_another_creation" })
  const snapshot: Snapshot = {
    ...f.snapshot,
    references: f.snapshot.references!.map((page) =>
      page.path === referencePath
        ? {
            ...page,
            blocks: page.blocks!.map((block, index) =>
              index === 0
                ? {
                    ...block,
                    text: wrong,
                    rich_text: [{ text: wrong, link: null, bold: false, code: false }],
                  }
                : block,
            ),
          }
        : page,
    ),
  }
  const result = await f.run(snapshotAuthoredPortable(snapshot).pipe(Effect.result))
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.code).toBe("WRITE_VERIFICATION_FAILED")
})

test("extra physical roots cannot authorize reuse of the archived reference bytes", async () => {
  const f = fixture()
  const snapshot: Snapshot = {
    ...f.snapshot,
    references: f.snapshot.references!.map((page) =>
      page.path === referencePath
        ? {
            ...page,
            blocks: [
              ...page.blocks!,
              {
                id: "extra",
                type: "paragraph",
                has_children: false,
                text: "Extra root.",
                rich_text: [{ text: "Extra root.", link: null, bold: false, code: false }],
              },
            ],
          }
        : page,
    ),
  }
  const saved = await f.run(snapshotAuthoredPortable(snapshot))
  expect(saved.files.find((file) => file.path === referencePath)!.bytes).toEqual(f.materialized)
  expect(await f.run(portableIdentity(saved))).not.toBe(await f.run(portableIdentity(f.source)))
})

test("real reference edits replace retained source bytes even with a correct creation marker", async () => {
  const f = fixture(true)
  const saved = await f.run(snapshotAuthoredPortable(f.snapshot))
  expect(saved.files.find((file) => file.path === referencePath)!.bytes).toEqual(f.materialized)
  expect(await f.run(portableIdentity(saved))).not.toBe(await f.run(portableIdentity(f.source)))
})

test("source export binds graph destinations before recovering quote children", async () => {
  const destination = `https://app.notion.com/p/${root.replaceAll("-", "")}`
  const source = `# Review\n\n> Read [main](../SKILL.md) first.\n>\n> Keep \`target\` unchanged.\n\n---\n\n## Result\n\nPreserve every instruction.\n`
  const actual = `# Review\n> Read [main](${destination}) first.\n\tKeep \`target\` unchanged.\n---\n## Result\nPreserve every instruction.`
  const span = (text: string, code = false, link: string | null = null) => ({
    text,
    code,
    link,
    bold: false,
  })
  const blocks: NotionBlockBoundary[] = [
    { id: "heading", type: "heading_1", has_children: false, rich_text: [span("Review")] },
    {
      id: "quote",
      type: "quote",
      has_children: true,
      rich_text: [span("Read "), span("main", false, destination), span(" first.")],
      quote_descendants: [
        {
          id: "nested",
          parent_id: "quote",
          type: "paragraph",
          has_children: false,
          rich_text: [span("Keep "), span("target", true), span(" unchanged.")],
        },
      ],
    },
    { id: "divider", type: "divider", has_children: false },
    { id: "result-heading", type: "heading_2", has_children: false, rich_text: [span("Result")] },
    {
      id: "result",
      type: "paragraph",
      has_children: false,
      rich_text: [span("Preserve every instruction.")],
    },
  ]
  for (const changed of [false, true]) {
    const f = fixture(false, {
      source,
      readback: changed ? actual.replace("unchanged.", "changed.") : actual,
      blocks: changed
        ? blocks.map((block) =>
            block.id === "quote"
              ? {
                  ...block,
                  quote_descendants: [
                    {
                      id: "nested",
                      parent_id: "quote",
                      type: "paragraph",
                      has_children: false,
                      rich_text: [span("Keep "), span("target", true), span(" changed.")],
                    },
                  ],
                }
              : block,
          )
        : blocks,
    })
    const saved = await f.run(snapshotAuthoredPortable(f.snapshot))
    expect(
      (await f.run(portableIdentity(saved))) === (await f.run(portableIdentity(f.source))),
    ).toBe(!changed)
    expect(saved.files.find((file) => file.path === referencePath)!.bytes).toEqual(
      changed ? f.materialized : encode(source),
    )
  }
})
