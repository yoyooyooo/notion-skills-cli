import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { Effect, Layer } from "effect"
import {
  fromNotionMarkdown,
  projectNotionBlockTree,
  samePublishedMarkdown,
} from "../src/markdown.ts"
import {
  decode,
  fail,
  property,
  SnapshotSchema,
  type NotionPageRecord,
  type Snapshot,
} from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import type { Receipt } from "../src/publication-model.ts"
import {
  capturePublicationRead,
  publicationReadPhase,
  readPublicationMarkdownMatches,
  readPublicationRootBlocks,
} from "../src/publication-observation.ts"
import { publicationExternalLinksMatch } from "../src/publication-markdown.ts"
import { referencePagesMatch } from "../src/reference-mutation.ts"
import { readReferences } from "../src/references.ts"
import { readLinkBlocks } from "../src/typed-links.ts"
import { portableIdentity, snapshotAuthoredPortable } from "../src/export.ts"
import {
  BUNDLE,
  canonicalMain,
  fileOrder,
  portableZip,
  type PortableSkill,
} from "../src/portable.ts"
import { sha256, Store } from "../src/store.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

const page = "11111111-1111-4111-8111-111111111111",
  foreign = "99999999-9999-4999-8999-999999999999"
const pagePath = `v1/pages/${page}`,
  markdownPath = `${pagePath}/markdown`
const id = (value: number) => `22222222-2222-4222-8222-${String(value).padStart(12, "0")}`
const inventory = (owner = page, cursor?: string) =>
  `v1/blocks/${owner}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`
const name = "Physical sibling boundaries",
  description = "Retain the complete text and file graph."
const record: NotionPageRecord = {
  id: `notion_page:${page}`,
  kind: "skill",
  locator: { type: "notion_page", page_id: page, database_id: "db", data_source_id: "ds" },
  name,
  description,
  alias: "physical-boundaries",
  default_context: false,
  entrypoint: "SKILL.md",
  ref: `skill://${page}/SKILL.md`,
}
const metadata = () => ({
  id: page,
  archived: false,
  in_trash: false,
  last_edited_time: "2026-10-21T00:00:00.000Z",
  properties: { References: { id: "references", type: "rich_text", rich_text: [] } },
})
const text = (content: string, extra: { code?: boolean; bold?: boolean; link?: string } = {}) => ({
  type: "text",
  plain_text: content,
  text: { content, link: extra.link ? { url: extra.link } : null },
  annotations: { bold: extra.bold ?? false, code: extra.code ?? false },
})
const block = (
  value: number,
  type: string,
  content: string,
  owner = page,
  hasChildren = false,
): Record<string, unknown> => ({
  id: id(value),
  type,
  has_children: hasChildren,
  parent:
    owner === page ? { type: "page_id", page_id: owner } : { type: "block_id", block_id: owner },
  [type]: { rich_text: [text(content)] },
})
const list = (results: readonly unknown[], next: string | null = null) => ({
  results,
  has_more: next !== null,
  next_cursor: next,
})
function fixture(kind: "nested" | "quote") {
  const responses = new Map<string, unknown>(),
    flat: Record<string, unknown>[] = []
  let actual: string, target: string
  if (kind === "nested") {
    target =
      "1. Before.\n2. Parent.\n   - Branch.\n     - Nested.\n   - Last child.\n\n   First sibling.\n\n   Second sibling.\n3. After."
    actual = target.replaceAll("\n\n", "\n")
    const before = block(1, "numbered_list_item", "Before."),
      parent = block(2, "numbered_list_item", "Parent.", page, true)
    const after = block(3, "numbered_list_item", "After."),
      branch = block(4, "bulleted_list_item", "Branch.", id(2), true)
    const nested = block(5, "bulleted_list_item", "Nested.", id(4)),
      last = block(6, "bulleted_list_item", "Last child.", id(2))
    const first = block(7, "paragraph", "First sibling.", id(2)),
      second = block(8, "paragraph", "Second sibling.", id(2))
    flat.push(before, parent, branch, nested, last, first, second, after)
    responses.set(inventory(), list([before, parent], "root /+"))
    responses.set(inventory(page, "root /+"), list([after]))
    responses.set(inventory(id(2)), list([branch, last], "child /+"))
    responses.set(inventory(id(2), "child /+"), list([first, second]))
    responses.set(inventory(id(4)), list([nested]))
  } else {
    actual =
      "# Before\n\n> **Notice** use [`a/reference.md`](../a/reference.md) safely.\nThis is a separate paragraph.\n\n## After\n"
    target = actual.replace("\nThis is", "\n\nThis is")
    const quote = block(2, "quote", "")
    quote.quote = {
      rich_text: [
        text("Notice", { bold: true }),
        text(" use "),
        text("a/reference.md", { code: true, link: "../a/reference.md" }),
        text(" safely."),
      ],
    }
    flat.push(
      block(1, "heading_1", "Before"),
      quote,
      block(3, "paragraph", "This is a separate paragraph."),
      block(4, "heading_2", "After"),
    )
    responses.set(inventory(), list(flat.slice(0, 2), "root /+"))
    responses.set(inventory(page, "root /+"), list(flat.slice(2)))
  }
  responses.set(markdownPath, {
    object: "page_markdown",
    markdown: actual,
    truncated: false,
    unknown_block_ids: [],
  })
  responses.set(`${pagePath}/properties/references?page_size=100`, list([]))
  const calls: string[] = []
  let race = false,
    changed = false
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
            ...metadata(),
            ...(changed ? { last_edited_time: "2026-10-21T00:01:00.000Z" } : {}),
          }
        if (race && path === inventory(page, "root /+")) changed = true
        if (!responses.has(path))
          return yield* Effect.fail(
            fail("INVALID_RESPONSE", "Unexpected sibling-proof request.", { path }),
          )
        return structuredClone(responses.get(path))
      }),
  }
  const layer = Layer.mergeAll(
    NodeServices.layer,
    NodeHttpClient.layerFetch,
    Layer.succeed(Notion, api),
  )
  const intent: Receipt["intents"][number] = {
    method: "PATCH",
    path: markdownPath,
    status: "completed",
    response: { id: page },
    body: { type: "replace_content", replace_content: { new_str: target } },
  }
  return {
    actual,
    target,
    flat,
    responses,
    calls,
    api,
    intent,
    layer,
    race: () => {
      race = true
    },
  }
}
const check = (f: ReturnType<typeof fixture>, phase = publicationReadPhase()) =>
  readPublicationMarkdownMatches(f.intent, f.actual, f.target, f.api, phase, undefined, true)

for (const kind of ["nested", "quote"] as const) {
  test(`${kind}: official reader binds all required physical pages and caches one stable proof`, async () => {
    const f = fixture(kind),
      phase = publicationReadPhase(),
      before = JSON.stringify([...f.responses])
    expect(samePublishedMarkdown(f.actual, f.target)).toBe(false)
    expect(await Effect.runPromise(check(f, phase))).toBe(true)
    const calls = f.calls.length
    expect(await Effect.runPromise(check(f, phase))).toBe(true)
    expect(f.calls).toHaveLength(calls)
    expect(f.calls.filter((path) => path === pagePath)).toHaveLength(2)
    for (const path of f.responses.keys())
      if (path.startsWith("v1/blocks/")) expect(f.calls).toContain(path)
    expect(JSON.stringify([...f.responses])).toBe(before)
    expect(fromNotionMarkdown(f.actual, phase.proofs.get(page)!.blocks)).toBe(f.target)
  })

  test(`${kind}: root and reference materialization share the bracketed physical projection`, async () => {
    const f = fixture(kind),
      graph = await Effect.runPromise(
        readReferences(record, metadata()).pipe(Effect.provide(f.layer)),
      )
    expect(graph.pages).toHaveLength(1)
    expect(graph.pages[0]!.blocks).toEqual(projectNotionBlockTree(page, f.flat))
    expect(new TextDecoder().decode(graph.files[0]!.bytes)).toContain(f.target)
    expect(f.calls.at(-1)).toBe(pagePath)
    for (const path of f.responses.keys())
      if (path.startsWith("v1/blocks/"))
        expect(f.calls.filter((call) => call === path)).toHaveLength(1)
  })

  test(`${kind}: metadata changes reject both the ACK reader and standalone graph reader`, async () => {
    const ack = fixture(kind)
    ack.race()
    expect(await Effect.runPromise(check(ack).pipe(Effect.result))).toMatchObject({
      _tag: "Failure",
      failure: { code: "WRITE_CONFLICT" },
    })
    const graph = fixture(kind)
    graph.race()
    expect(
      await Effect.runPromise(
        readReferences(record, metadata()).pipe(Effect.provide(graph.layer), Effect.result),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "PUBLICATION_CHANGED" } })
  })
}

test("snapshot decoding retains exact descendants and heading spans without creating legacy evidence", () => {
  for (const kind of ["nested", "quote"] as const) {
    const f = fixture(kind),
      blocks = projectNotionBlockTree(page, f.flat)!
    const snapshot = decode(SnapshotSchema, {
      snapshot_id: "s_test",
      scope: "test",
      record,
      entrypoint: "SKILL.md",
      version_id: "v_test",
      created_at: 0,
      files: [],
      references: [{ id: page, path: "SKILL.md", markdown: f.actual, blocks }],
    })
    expect(snapshot.references![0]!.blocks).toEqual(blocks)
    expect(
      samePublishedMarkdown(f.actual, f.target, undefined, snapshot.references![0]!.blocks),
    ).toBe(true)
    const legacy = blocks.map(
      ({ descendants: _ignored, rich_text: _spans, text: _text, ...sentinel }) => sentinel,
    )
    expect(samePublishedMarkdown(f.actual, f.target, undefined, legacy)).toBe(false)
  }
})

test("every related descendant inventory or direct block read invalidates the root and its old bracket", async () => {
  const f = fixture("nested"),
    phase = publicationReadPhase()
  expect(await Effect.runPromise(check(f, phase))).toBe(true)
  const proof = phase.proofs.get(page)!,
    before = phase.before.get(page)!
  for (const path of [inventory(id(2)), inventory(id(4)), `v1/blocks/${id(7)}`]) {
    phase.proofs.set(page, proof)
    phase.before.set(page, before)
    phase.proofs.set(foreign, { actual: "Other", blocks: [] })
    capturePublicationRead(phase, path, {})
    expect(phase.proofs.has(page)).toBe(false)
    expect(phase.before.has(page)).toBe(false)
    expect(phase.proofs.has(foreign)).toBe(true)
  }
  const stale = f.responses.get(inventory(id(2), "child /+"))
  phase.raw[inventory(id(2), "child /+")] = stale
  phase.order.set(inventory(id(2), "child /+"), 0)
  f.responses.set(inventory(id(2), "child /+"), list([f.flat[6]!]))
  const start = f.calls.length
  expect(await Effect.runPromise(check(f, phase))).toBe(false)
  expect(f.calls.slice(start)).toContain(inventory())
  expect(f.calls.slice(start)).toContain(inventory(id(2), "child /+"))
})

test("foreign child ownership, repeated identities and invalid terminal cursors cannot authorize either reader", async () => {
  for (const damage of ["owner", "repeat", "cursor"] as const) {
    for (const reader of ["ack", "graph"] as const) {
      const f = fixture("nested"),
        path = inventory(id(2), "child /+")
      if (damage === "owner")
        f.responses.set(
          path,
          list([{ ...f.flat[5]!, parent: { type: "block_id", block_id: id(4) } }, f.flat[6]!]),
        )
      if (damage === "repeat") f.responses.set(path, list([f.flat[2]!, f.flat[6]!]))
      if (damage === "cursor")
        f.responses.set(path, { ...list([f.flat[5]!, f.flat[6]!]), next_cursor: "unrequested" })
      const result =
        reader === "ack"
          ? await Effect.runPromise(check(f).pipe(Effect.result))
          : await Effect.runPromise(
              readReferences(record, metadata()).pipe(Effect.provide(f.layer), Effect.result),
            )
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: "INVALID_RESPONSE" } })
    }
  }
})

test("new physical traversal never opens child pages, databases or synced content", async () => {
  const f = fixture("nested"),
    boundaries = [
      block(20, "child_page", "Child", page, true),
      block(21, "child_database", "Database", page, true),
      block(22, "synced_block", "Synced", page, true),
    ]
  f.responses.set(inventory(), list(boundaries))
  expect(
    (await Effect.runPromise(readPublicationRootBlocks(page, f.api, {}, true))).map(
      (item) => item.type,
    ),
  ).toEqual(["child_page", "child_database", "synced_block"])
  expect(f.calls).toEqual([inventory()])
  f.calls.length = 0
  expect(
    (await Effect.runPromise(readLinkBlocks(page, f.api, { structureEvidence: true }))).map(
      (item) => item.type,
    ),
  ).toEqual(["child_page", "child_database", "synced_block"])
  expect(f.calls).toEqual([inventory()])
})

test("projected child ownership, DFS order, complete subtree and heading annotations remain strict", () => {
  const f = fixture("nested")
  expect(projectNotionBlockTree(page, f.flat)?.[1]?.descendants).toHaveLength(5)
  expect(
    projectNotionBlockTree(
      page,
      f.flat.filter((node) => node.id !== id(5)),
    )?.[1]?.descendants,
  ).toBeUndefined()
  const reordered = projectNotionBlockTree(page, [
    f.flat[0]!,
    f.flat[1]!,
    f.flat[5]!,
    f.flat[2]!,
    f.flat[3]!,
    f.flat[4]!,
    f.flat[6]!,
    f.flat[7]!,
  ])
  expect(reordered?.[1]?.descendants).toBeDefined()
  expect(samePublishedMarkdown(f.actual, f.target, undefined, reordered)).toBe(false)
  const wrong = structuredClone(f.flat)
  wrong[5]!.parent = { type: "block_id", block_id: foreign }
  expect(projectNotionBlockTree(page, wrong)).toBeUndefined()
  const quote = fixture("quote"),
    broken = structuredClone(quote.flat)
  property(property(broken[0]).heading_1).rich_text = [
    {
      type: "text",
      text: { content: "Before" },
      plain_text: "Different",
      annotations: { bold: false, code: false },
    },
  ]
  const evidence = projectNotionBlockTree(page, broken)!
  expect(evidence[0]!.rich_text).toBeUndefined()
  expect(samePublishedMarkdown(quote.actual, quote.target, undefined, evidence)).toBe(false)
})

test("a missing root revision keeps legacy graph data from acquiring new boundary authority", async () => {
  const f = fixture("nested"),
    before = metadata()
  Reflect.deleteProperty(before, "last_edited_time")
  const graph = await Effect.runPromise(
    readReferences(record, before).pipe(Effect.provide(f.layer)),
  )
  expect(graph.pages[0]!.blocks).toBeUndefined()
  expect(samePublishedMarkdown(f.actual, f.target, undefined, graph.pages[0]!.blocks)).toBe(false)
})

function readOnlyObjects(objects: ReadonlyMap<string, Uint8Array>) {
  const refused = () => Effect.fail(fail("UNEXPECTED_WRITE", "The boundary fixture is read-only."))
  return Layer.succeed(Store, {
    root: "/fixture",
    configRoot: "/fixture",
    cacheRoot: "/fixture",
    integrity: integrityRepositoryFixture(),
    upstream: upstreamRepositoryFixture(),
    reserveCacheGeneration: refused,
    listKeys: refused,
    retireKeys: refused,
    readJson: refused,
    writeJson: refused,
    writeBytes: refused,
    registerBindingWithBase: refused,
    advanceBaseAndReceipt: refused,
    backup: refused,
    output: refused,
    readBytes: (key) =>
      objects.has(key)
        ? Effect.succeed(objects.get(key)!)
        : Effect.fail(fail("MISSING_OBJECT", "Missing fixture source.")),
  })
}

for (const kind of ["nested", "quote"] as const) {
  test(`${kind}: final verifier and source export preserve the complete original ZIP file bytes`, async () => {
    const f = fixture(kind),
      graph = await Effect.runPromise(
        readReferences(record, metadata()).pipe(Effect.provide(f.layer)),
      )
    const portable: PortableSkill = {
      kind: "skill",
      name,
      description,
      main: "SKILL.md",
      files: [
        canonicalMain(name, description, f.target, { path: "SKILL.md", bytes: new Uint8Array() }),
        {
          path: "agents/settings.yaml",
          bytes: new TextEncoder().encode("interface:\n  display_name: Siblings\n"),
        },
      ],
    }
    const bundle = {
      path: BUNDLE,
      bytes: portableZip({ ...portable, projection: { name, description, body: f.target } }, true),
    }
    const files = [...graph.files, bundle, portable.files[1]!],
      objects = new Map<string, Uint8Array>(),
      entries: Snapshot["files"][number][] = []
    for (const file of files) {
      const hash = await Effect.runPromise(
        sha256(file.bytes).pipe(Effect.provide(NodeServices.layer)),
      )
      objects.set(`objects/${hash}`, file.bytes)
      entries.push({ path: file.path, bytes: file.bytes.length, sha256: hash })
    }
    const snapshot = decode(SnapshotSchema, {
      snapshot_id: "s_test",
      scope: "test",
      record,
      entrypoint: "SKILL.md",
      version_id: graph.version_id,
      created_at: 0,
      files: entries,
      references: graph.pages,
    })
    expect(
      await Effect.runPromise(
        referencePagesMatch(snapshot, portable).pipe(Effect.provide(NodeServices.layer)),
      ),
    ).toBe(true)
    const exported = await Effect.runPromise(
      snapshotAuthoredPortable(snapshot).pipe(
        Effect.provide(readOnlyObjects(objects)),
        Effect.provide(NodeServices.layer),
      ),
    )
    expect(exported.files.map((file) => [file.path, [...file.bytes]])).toEqual(
      [...portable.files].sort(fileOrder).map((file) => [file.path, [...file.bytes]]),
    )
    expect(
      await Effect.runPromise(portableIdentity(exported).pipe(Effect.provide(NodeServices.layer))),
    ).toBe(
      await Effect.runPromise(portableIdentity(portable).pipe(Effect.provide(NodeServices.layer))),
    )
    const missing = {
      ...snapshot,
      references: snapshot.references!.map((reference) => ({ ...reference, blocks: [] })),
    }
    expect(
      await Effect.runPromise(
        referencePagesMatch(missing, portable).pipe(
          Effect.provide(NodeServices.layer),
          Effect.result,
        ),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "WRITE_VERIFICATION_FAILED" } })
    const changed = f.actual + "\n\n[site](https://example.test/changed)"
    expect(
      publicationExternalLinksMatch(
        changed,
        f.target + "\n\n[site](https://example.test/original)",
        (value) => value,
        graph.pages[0]!.blocks,
      ),
    ).toBe(false)
  })
}
