import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer } from "effect"
import type { HttpClient } from "effect/http"
import { portableIdentity, snapshotAuthoredPortable } from "../src/export.ts"
import { projectNotionBlocks, samePublishedMarkdown } from "../src/markdown.ts"
import { fail, type Snapshot } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import {
  BUNDLE,
  bodyIdentity,
  canonicalMain,
  portableZip,
  type PortableSkill,
} from "../src/portable.ts"
import { publicationSession } from "../src/publication.ts"
import {
  publicationExternalLinksMatch,
  publicationSourceDestination,
  sameRelativeFileDestination,
} from "../src/publication-markdown.ts"
import type { Receipt } from "../src/publication-model.ts"
import {
  observation,
  publicationReadPhase,
  readPublicationMarkdownMatches,
} from "../src/publication-observation.ts"
import { referencePagesMatch } from "../src/reference-mutation.ts"
import { rewritePageLinks } from "../src/references.ts"
import { Store } from "../src/store.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

const root = "11111111-1111-4111-8111-111111111111"
const pagePath = `v1/pages/${root}`,
  bodyPath = `${pagePath}/markdown`
const inventoryPath = `v1/blocks/${root}/children?page_size=100`
const name = "Wizard filename",
  description = "Preserve the frozen script and its exact relative link."
const target =
  "# Wizard\n\nThe delightful UX is solved by [template.sh](template.sh). Read [docs](https://example.org/guide).\n\n## Result\n\nKeep every instruction.\n"
const encode = (text: string) => new TextEncoder().encode(text)
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const rich = (content: string, url: string | null = null) => ({
  type: "text",
  text: { content, link: url === null ? null : { url } },
  plain_text: content,
  annotations: {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: "default",
  },
})
const rawBlock = (index: number, type: string, spans: ReturnType<typeof rich>[]) => ({
  id: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
  type,
  has_children: false,
  parent: { type: "page_id", page_id: root },
  [type]: { rich_text: spans },
})

function fixture(url = "https://template.sh", physicalUrl = `${url}/`) {
  const actual = target.replace("](template.sh)", `](${url})`).replaceAll("\n\n", "\n")
  const roots = [
    rawBlock(1, "heading_1", [rich("Wizard")]),
    rawBlock(2, "paragraph", [
      rich("The delightful UX is solved by "),
      rich("template.sh", physicalUrl),
      rich(". Read "),
      rich("docs", "https://example.org/guide"),
      rich("."),
    ]),
    rawBlock(3, "heading_2", [rich("Result")]),
    rawBlock(4, "paragraph", [rich("Keep every instruction.")]),
  ]
  const blocks = projectNotionBlocks(roots)
  if (!blocks) throw new Error("Complete physical fixture required")
  const source: PortableSkill = {
    kind: "skill",
    name,
    description,
    main: "SKILL.md",
    files: [
      canonicalMain(name, description, target, { path: "SKILL.md", bytes: new Uint8Array() }),
      {
        path: "template.sh",
        bytes: encode("#!/bin/bash\n\n# Exact script bytes.\nprintf '%s\\n' 'wizard'\n"),
      },
      { path: "agents/openai.yaml", bytes: encode("interface:\n  display_name: Wizard\n") },
    ],
  }
  const sourceContext = { path: source.main, files: source.files }
  const local = (markdown: string) => rewritePageLinks(markdown, source.main, [], "local")
  const preserveExternal = (markdown: string) =>
    rewritePageLinks(markdown, source.main, [], "local", [], { preserveExternalUrls: true })
  const body = {
    markdown_version: "v2",
    type: "replace_content",
    replace_content: { new_str: target },
  }
  const intent: Receipt["intents"][number] = {
    path: bodyPath,
    method: "PATCH",
    body,
    status: "completed",
    response: { id: root },
  }
  const raw: Record<string, unknown> = {
    [pagePath]: {
      object: "page",
      id: root,
      parent: { type: "data_source_id", data_source_id: "ds", database_id: "db" },
      last_edited_time: "2026-10-20T14:53:00.000Z",
      archived: false,
      in_trash: false,
      properties: {
        Name: { id: "title", type: "title", title: [rich(name)] },
        Description: { id: "description", type: "rich_text", rich_text: [rich(description)] },
      },
    },
    [bodyPath]: {
      object: "page_markdown",
      id: root,
      markdown: actual,
      truncated: false,
      unknown_block_ids: [],
    },
    [inventoryPath]: { object: "list", results: roots, has_more: false, next_cursor: null },
  }
  const requests: Array<{ path: string; method: string }> = []
  const api: Notion["Service"] = {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture"),
    request: (path, body, options) =>
      Effect.gen(function* () {
        const method = options?.method ?? (body === undefined ? "GET" : "POST")
        requests.push({ path, method })
        if (method !== "GET")
          return yield* Effect.fail(
            fail("UNEXPECTED_WRITE", "Source proof must not mutate Notion."),
          )
        if (!Object.hasOwn(raw, path)) return yield* Effect.fail(fail("UNEXPECTED_GET", path))
        return structuredClone(raw[path])
      }),
  }
  const materialized = canonicalMain(name, description, local(actual), source.files[0]!)
  const captured = [
    materialized,
    ...source.files.slice(1),
    {
      path: BUNDLE,
      bytes: portableZip(
        {
          ...source,
          projection: { name, description, body: bodyIdentity(target) },
        },
        true,
      ),
    },
  ]
  const objects = new Map(
    [...source.files, ...captured].map((file) => [`objects/${digest(file.bytes)}`, file.bytes]),
  )
  const forbidden = () => Effect.die(new Error("Unexpected Store write or unrelated read"))
  const store: Store["Service"] = {
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
    readBytes: (key) =>
      objects.has(key) ? Effect.succeed(objects.get(key)!.slice()) : forbidden(),
  }
  const layer = Layer.mergeAll(
    NodeServices.layer,
    NodeHttpClient.layerFetch,
    Layer.succeed(Store, store),
    Layer.succeed(Notion, api),
  )
  const run = <A, E>(
    effect: Effect.Effect<A, E, Store | Notion | NodeServices.NodeServices | HttpClient.HttpClient>,
  ) => Effect.runPromise(effect.pipe(Effect.provide(layer)))
  const snapshot: Snapshot = {
    snapshot_id: "source-filename",
    scope: "test",
    version_id: "test",
    created_at: 0,
    entrypoint: source.main,
    record: {
      id: `notion_page:${root}`,
      kind: "skill",
      name,
      description,
      alias: "wizard-filename",
      default_context: false,
      entrypoint: source.main,
      ref: `skill://${root}/${source.main}`,
      locator: { type: "notion_page", page_id: root, database_id: "db", data_source_id: "ds" },
    },
    files: captured.map((file) => ({
      path: file.path,
      bytes: file.bytes.length,
      sha256: digest(file.bytes),
    })),
    references: [{ id: root, path: source.main, markdown: actual, blocks }],
  }
  const receipt: Receipt = {
    format: 1,
    operation_id: "p_source-filename-ack",
    operation: "replace",
    state: "running",
    scope: "test",
    database_id: "db",
    data_source_id: "ds",
    page_id: root,
    portable: {
      kind: source.kind,
      name,
      description,
      main: source.main,
      files: source.files.map((file) => ({ path: file.path, sha256: digest(file.bytes) })),
    },
    intents: [intent],
    stages: [],
    guards: Object.fromEntries(
      Object.entries(raw).map(([path, value]) => [path, observation(path, value)]),
    ),
  }
  return {
    source,
    sourceContext,
    actual,
    blocks,
    roots,
    intent,
    body,
    receipt,
    snapshot,
    objects,
    requests,
    api,
    run,
    mapping: { local, preserveExternal, source: sourceContext },
  }
}

test("retained source filename proof uses a complete fresh metadata bracket and leaves all inputs unchanged", async () => {
  const f = fixture(),
    before = JSON.stringify([f.receipt, f.source, f.snapshot])
  const phase = publicationReadPhase()
  expect(
    await f.run(
      readPublicationMarkdownMatches(
        f.intent,
        f.actual,
        f.mapping.local(target),
        f.api,
        phase,
        f.mapping,
      ),
    ),
  ).toBe(true)
  expect(phase.proofs.get(root)?.blocks).toEqual(f.blocks)
  expect(f.requests.filter((request) => request.path === pagePath)).toHaveLength(2)
  expect(f.requests.every((request) => request.method === "GET")).toBe(true)
  expect(JSON.stringify([f.receipt, f.source, f.snapshot])).toBe(before)
})

test("new filename aliases require the exact source directory, manifest member and physical link", () => {
  const f = fixture()
  expect(
    publicationSourceDestination(f.sourceContext, f.blocks)("https://template.sh", "template.sh"),
  ).toBe(true)
  expect(
    publicationSourceDestination(f.sourceContext, f.blocks)("https://template.sh/", "template.sh"),
  ).toBe(true)
  for (const same of [
    publicationSourceDestination(undefined, f.blocks),
    publicationSourceDestination(f.sourceContext),
    publicationSourceDestination({ path: "references/guide.md", files: f.source.files }, f.blocks),
    publicationSourceDestination({ path: "SKILL.md", files: [{ path: "unrelated.sh" }] }, f.blocks),
    publicationSourceDestination(f.sourceContext, []),
    publicationSourceDestination(
      f.sourceContext,
      fixture("https://template.sh", "http://template.sh/").blocks,
    ),
  ])
    expect(same("https://template.sh", "template.sh")).toBe(false)
  expect(sameRelativeFileDestination("http://GUIDE.md", "GUIDE.md")).toBe(true)
  expect(
    publicationSourceDestination(f.sourceContext, f.blocks)("http://GUIDE.md", "GUIDE.md"),
  ).toBe(true)
})

test("source filenames never authorize path, query, fragment, credentials, port, encoding or case changes", () => {
  for (const url of [
    "https://template.sh:443",
    "https://template.sh/path",
    "https://template.sh?x=1",
    "https://template.sh#run",
    "https://user@template.sh",
    "https://Template.sh",
    "https://template.sh//",
    "https://template.sh/../",
    "https://template%2esh",
    "https://template.sh\\path",
  ]) {
    const f = fixture(url, url)
    const same = publicationSourceDestination(f.sourceContext, f.blocks)
    expect(same(url, "template.sh")).toBe(false)
    expect(samePublishedMarkdown(f.actual, target, same, f.blocks)).toBe(false)
  }
  const f = fixture(),
    same = publicationSourceDestination(f.sourceContext, f.blocks)
  for (const target of [
    "./template.sh",
    "../template.sh",
    "dir/template.sh",
    "template.sh?x=1",
    "template.sh#run",
    "http://template.sh",
  ])
    expect(same("https://template.sh", target)).toBe(false)
})

test("an explicit external destination stays exact beside a proven relative filename", async () => {
  const f = fixture(),
    same = publicationSourceDestination(f.sourceContext, f.blocks)
  expect(
    publicationExternalLinksMatch(f.actual, target, (value) => value, f.blocks, undefined, same),
  ).toBe(true)
  for (const altered of [
    f.actual.replace("https://example.org/guide", "http://example.org/guide"),
    f.actual.replace("https://example.org/guide", "https://example.org/guide?different=1"),
  ]) {
    expect(
      publicationExternalLinksMatch(altered, target, (value) => value, f.blocks, undefined, same),
    ).toBe(false)
  }
  const explicit = target.replace("](template.sh)", "](http://template.sh)")
  expect(
    publicationExternalLinksMatch(f.actual, explicit, (value) => value, f.blocks, undefined, same),
  ).toBe(false)
  const denied = { ...f.mapping, source: { path: "SKILL.md", files: [{ path: "unrelated.sh" }] } }
  expect(
    await f.run(
      readPublicationMarkdownMatches(
        f.intent,
        f.actual,
        f.mapping.local(target),
        f.api,
        publicationReadPhase(),
        denied,
      ),
    ),
  ).toBe(false)
})

test("original acknowledged replacement is reused without adding intents or making another mutation", async () => {
  const f = fixture(),
    before = JSON.stringify(f.receipt)
  const result = await f.run(
    Effect.gen(function* () {
      const publication = yield* publicationSession(f.receipt, {})
      return yield* publication.notion.request(bodyPath, f.body, { method: "PATCH" })
    }),
  )
  expect(result).toMatchObject({ markdown: f.actual })
  expect(f.requests.every((request) => request.method === "GET")).toBe(true)
  expect(JSON.stringify(f.receipt)).toBe(before)
})

test("final verification binds the full authored body and manifest, including mixed external links", async () => {
  const f = fixture()
  expect(await f.run(referencePagesMatch(f.snapshot, f.source))).toBe(true)
  for (const snapshot of [
    {
      ...f.snapshot,
      references: f.snapshot.references!.map((page) => ({ ...page, blocks: undefined })),
    },
    {
      ...f.snapshot,
      references: f.snapshot.references!.map((page) => ({
        ...page,
        markdown: page.markdown + "\nExtra instruction.",
      })),
    },
    {
      ...f.snapshot,
      references: f.snapshot.references!.map((page) => ({
        ...page,
        markdown: page.markdown.replace("https://example.org", "http://example.org"),
      })),
    },
  ]) {
    const result = await f.run(referencePagesMatch(snapshot, f.source).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.code).toBe("WRITE_VERIFICATION_FAILED")
  }
  expect(
    (
      await f.run(
        referencePagesMatch(f.snapshot, {
          ...f.source,
          files: f.source.files.filter((file) => file.path !== "template.sh"),
        }).pipe(Effect.result),
      )
    )._tag,
  ).toBe("Failure")
})

test("source export retains all three original files byte for byte with the current complete proof", async () => {
  const f = fixture(),
    before = JSON.stringify(f.snapshot)
  const objectHashes = [...f.objects].map(([key, bytes]) => [key, digest(bytes)])
  const saved = await f.run(snapshotAuthoredPortable(f.snapshot))
  expect(await f.run(portableIdentity(saved))).toBe(await f.run(portableIdentity(f.source)))
  expect(saved.files.map((file) => file.path).sort()).toEqual(
    f.source.files.map((file) => file.path).sort(),
  )
  for (const file of f.source.files)
    expect(saved.files.find((saved) => saved.path === file.path)!.bytes).toEqual(file.bytes)
  expect(JSON.stringify(f.snapshot)).toBe(before)
  expect([...f.objects].map(([key, bytes]) => [key, digest(bytes)])).toEqual(objectHashes)
  const withoutProof = {
    ...f.snapshot,
    references: f.snapshot.references!.map((page) => ({ ...page, blocks: undefined })),
  }
  const materialized = await f.run(snapshotAuthoredPortable(withoutProof))
  expect(materialized.files.find((file) => file.path === f.source.main)!.bytes).not.toEqual(
    f.source.files[0]!.bytes,
  )
  for (const file of f.source.files.slice(1))
    expect(materialized.files.find((saved) => saved.path === file.path)!.bytes).toEqual(file.bytes)
})
