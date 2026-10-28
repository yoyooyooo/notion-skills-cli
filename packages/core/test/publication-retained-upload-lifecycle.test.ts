// Real transport failures produce every original receipt, ACK and fence.
// Independent real-service fixture; no receipt, intent, guard or fence fabrication.
// Based on reference-import fixture header SHA256 58c605b01c7bbbaee217c4834b456020a5543ceaa31498046ae29609c5bfeedd.
import {
  integrityRepositoryFixture,
  upstreamRepositoryFixture,
  publicationSourceRows,
  publicationSourceSchema,
} from "./fixtures.ts"
import { afterAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ByteSize, Effect, FileSystem, Layer, Option } from "effect"
import { createSkill, replaceSkill, resumePublication, writeSkill } from "../src/mutation.ts"
import { decode, fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { openSkill, readSkill } from "../src/snapshot.ts"
import { snapshotAuthoredPortable, snapshotPortable } from "../src/export.ts"
import { authScope } from "../src/catalog.ts"
import { cachedRemoteObservation } from "../src/cache.ts"
import { PortableSourceDecoder } from "../src/portable-source.ts"
import { bodyIdentity, readPortable } from "../src/portable.ts"
import { withoutCreationMarker } from "../src/publication-create-identity.ts"
import { PublicationReceiptSchema } from "../src/publication-model.ts"
import { publicationMarker, publicationProperties } from "../src/publication-integrity.ts"
import { IntegrityIntentSchema } from "../src/publication-integrity-state.ts"
import { terminalPublicationCommitCandidate } from "../src/publication-terminal-commit.ts"
import {
  retainedUnusableUploadCandidate,
  retainedUploadCertificates,
  retainedUploadReplacementCandidates,
} from "../src/publication-retained-upload.ts"
import { withoutChildPages } from "../src/references.ts"
import {
  blockPatchRecovery,
  metadata,
  publicationPropertiesMatch,
} from "../src/publication-observation.ts"
import { reconcilePublication } from "../src/publication-reconcile.ts"
import {
  publicationBlockReplacementCandidates,
  publicationPropertyReplacementCandidates,
} from "../src/publication-effect-proof.ts"
import { Lexer } from "marked"
import { markdownIdentity } from "../src/markdown.ts"
import { decodeReferenceLinks } from "../src/reference-links.ts"

const database = "44444444-4444-4444-8444-444444444444"
const root = "11111111-1111-4111-8111-111111111111"
const upstreamDatabase = "55555555-5555-4555-8555-555555555555"
const upstreamDataSource = "66666666-6666-4666-8666-666666666666"
const encoder = new TextEncoder()
const bundles = new Map<string, Uint8Array>()
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => {
    const bytes = bundles.get(new URL(request.url).pathname)
    return bytes
      ? new Response(new Blob([new Uint8Array(bytes).buffer]))
      : new Response(null, { status: 404 })
  },
})
afterAll(() => server.stop(true))

function fixture(
  failure?: "registration" | "registration_unknown" | "body" | "attachment",
  hasFiles = false,
  changed?: "main" | "reference",
  normalized = false,
  quoteBoundary = false,
  typedLinkRepair = false,
) {
  let exists = false
  let interrupted = false
  let registrationUnknownArmed = false
  let ownershipUnknownArmed = false
  let ownershipSchema = false
  let main = ""
  const commitFaults: Array<"before" | "after"> = []
  let commitAttempts = 0
  const integrityJson = new Map<string, unknown>()
  let mutations = 0
  let businessPatches = 0
  let failNextRead = false
  let interruptRootReadback = false
  let rootMarkdownAcknowledged = false
  let rootReadbacks = 0
  let changedRootRevision = false
  let changedChildRevision = false
  let referenceReadChange: "url" | "missing_cursor" | undefined
  const readPaths: string[] = []
  let singleQuote = false
  let noticeChanged = false
  const revision =
    quoteBoundary || typedLinkRepair ? { last_edited_time: "2026-10-18T00:00:00.000Z" } : {}
  const blocks = new Map<string, Record<string, unknown>>()
  const inventories = new Map<string, unknown>()
  const blockId = (id: string, index: number) => {
    const value = createHash("sha256")
      .update(id + ":" + index)
      .digest("hex")
      .slice(0, 32)
    return [
      value.slice(0, 8),
      value.slice(8, 12),
      value.slice(12, 16),
      value.slice(16, 20),
      value.slice(20),
    ].join("-")
  }
  interface FixtureBodyBlock extends Record<string, unknown> {
    id: string
    parent: { type: "page_id"; page_id: string }
    type: string
    has_children: false
  }
  const bodyBlocks = (id: string, body: string) =>
    Lexer.lex(body)
      .filter((token) => token.type !== "space" && token.type !== "def")
      .flatMap((token, index): FixtureBodyBlock[] => {
        if (singleQuote && token.type === "paragraph" && token.text.startsWith("注意：")) return []
        if (token.type === "code")
          return [
            {
              ...revision,
              id: blockId(id, index),
              parent: { type: "page_id", page_id: id },
              type: "code",
              has_children: false,
              code: {
                language: !token.lang || token.lang === "text" ? "plain text" : token.lang,
                rich_text: [
                  {
                    type: "text",
                    text: { content: token.text },
                    plain_text: token.text,
                    annotations: {
                      bold: false,
                      italic: false,
                      strikethrough: false,
                      underline: false,
                      code: false,
                      color: "default",
                    },
                  },
                ],
              },
            },
          ]
        const type =
          token.type === "blockquote"
            ? "quote"
            : token.type === "heading"
              ? `heading_${token.depth}`
              : "paragraph"
        const content =
          token.type === "blockquote"
            ? token.text + (singleQuote ? "\n注意：保留原始边界。" : "")
            : "text" in token
              ? String(token.text)
              : token.raw
        const richText = typedLinkRepair
          ? Lexer.lexInline(content).map((token) => {
              const text = "text" in token ? String(token.text) : token.raw
              return {
                type: "text",
                text: {
                  content: text,
                  ...(token.type === "link" ? { link: { url: token.href } } : {}),
                },
                plain_text: text,
                annotations: {
                  bold: false,
                  italic: false,
                  strikethrough: false,
                  underline: false,
                  code: false,
                  color: "default",
                },
              }
            })
          : [
              {
                type: "text",
                text: { content },
                plain_text: content,
                annotations: {
                  bold: false,
                  italic: false,
                  strikethrough: false,
                  underline: false,
                  code: false,
                  color: "default",
                },
              },
            ]
        return [
          {
            ...revision,
            id: blockId(id, index),
            parent: { type: "page_id", page_id: id },
            type,
            has_children: false,
            [type]: { rich_text: richText },
          },
        ]
      })
  const blockMarkdown = (block: Record<string, unknown>) => {
    const values = property(block[String(block.type)]).rich_text
    if (!Array.isArray(values)) throw new Error("Fixture expected a text block")
    return values
      .map((value) => {
        const text = property(property(value).text)
        const url = property(text.link).url
        return typeof url === "string" ? `[${text.content}](${url})` : String(text.content)
      })
      .join("")
  }
  const reads = new Map<string, number>()
  const propertyWrites: Array<Record<string, unknown>> = []
  const children: Array<{ id: string; title: string; body: string }> = []
  let references: unknown[] = []
  const savedProperties: Record<string, unknown> = {}
  const persistProperties = (raw: unknown) => {
    for (const [key, rawValue] of Object.entries(property(raw))) {
      if (["references", "References", "files", "Files"].includes(key)) continue
      const value = property(rawValue)
      const name =
        (
          {
            title: "Name",
            description: "Description",
            publication: "Publication",
            kind: "Kind",
          } as Record<string, string>
        )[key] ?? key
      const type = Array.isArray(value.rich_text)
        ? "rich_text"
        : Array.isArray(value.title)
          ? "title"
          : value.select
            ? "select"
            : Array.isArray(value.relation)
              ? "relation"
              : undefined
      savedProperties[name] = {
        id:
          (ownershipSchema
            ? (
                {
                  Upstream: "upstream",
                  "Sync Mode": "mode",
                  "Upstream Key": "key",
                  "Upstream Revision": "revision",
                  "Published Hash": "hash",
                  "Fork Baseline": "baseline",
                } as Record<string, string>
              )[name]
            : undefined) ?? key,
        ...value,
        ...(type ? { type } : {}),
        ...(value.select
          ? {
              select: {
                id: `option-${String(property(value.select).name)}`,
                color: "default",
                ...property(value.select),
              },
            }
          : {}),
        ...(Array.isArray(value.rich_text)
          ? {
              rich_text: value.rich_text.map((item) => ({
                ...property(item),
                plain_text: property(property(item).text).content,
              })),
            }
          : {}),
      }
    }
  }
  let attachment: { id: string; name: string; type: string; file: { url: string } } | undefined
  const uploads = new Map<string, Uint8Array>()
  let upload = 0
  let uploadSends = 0
  type UploadFault = "unknown_send" | "completed_send" | "unknown_files"
  let originalUploadFault: UploadFault | undefined
  const unusableUploads = new Set<string>()
  const sendAttempts = new Map<string, number>()
  let readInterruption = false
  let stopAfterCertificate = false
  let stopAfterNewAllocation = false
  let replacementFilesResponseLost = false
  let filePropertyIncomplete = false
  const input = new Map([
    [
      "SKILL.md",
      encoder.encode(
        "---\nname: sample-skill\ndescription: Use for recovery.\n---\n\n# Sample\n\nRead [guide](references/guide.md).\n",
      ),
    ],
    ["references/guide.md", encoder.encode("# Guide\n\nRead [policy](./policy.md).\n")],
    [
      "references/policy.md",
      encoder.encode("# Policy\n\nA consumer must keep original page identities.\n"),
    ],
  ])
  const json = new Map<string, unknown>()
  const objects = new Map<string, Uint8Array>()
  const rich = (content: string) => ({
    type: "rich_text",
    rich_text: [{ type: "text", text: { content }, plain_text: content }],
  })
  // A member commit precedes publication of its source active map. The real
  // member reader supports this complete subscription with no active map yet.
  const subscriptionProperties = {
    Name: {
      id: "title",
      type: "title",
      title: [
        { type: "text", text: { content: "Terminal Source" }, plain_text: "Terminal Source" },
      ],
    },
    Description: rich("Use for terminal commit recovery."),
    "Default Context": { type: "checkbox", checkbox: false },
    Enabled: { type: "checkbox", checkbox: true },
    Status: { type: "select", select: { name: "verified" } },
    Source: rich(
      JSON.stringify({
        provider: {
          type: "git",
          url: "https://example.com/terminal-fixture.git",
          ref: "original-upstream",
        },
      }),
    ),
    Ref: rich("original-upstream"),
    "Target Database ID": rich(database),
    Roots: rich("[]"),
    Include: rich("[]"),
    Exclude: rich("[]"),
    Mapping: rich("{}"),
    "Published Members": rich(""),
  }
  const properties = () => ({
    Name: { id: "title", type: "title", title: [{ plain_text: "Sample Skill" }] },
    Description: {
      id: "description",
      type: "rich_text",
      rich_text: [{ plain_text: "Use for recovery." }],
    },
    References: { id: "references", type: "rich_text", rich_text: references },
    Publication: { id: "publication", type: "rich_text", rich_text: [] },
    Kind: { id: "kind", type: "select", select: { name: "skill" } },
    ...(ownershipSchema
      ? {
          ...structuredClone(publicationSourceRows),
          Upstream: { id: "upstream", type: "relation", relation: [], has_more: false },
          "Sync Mode": { id: "mode", type: "select", select: null },
          "Upstream Key": { id: "key", type: "rich_text", rich_text: [] },
          "Upstream Revision": { id: "revision", type: "rich_text", rich_text: [] },
          "Published Hash": { id: "hash", type: "rich_text", rich_text: [] },
          "Fork Baseline": { id: "baseline", type: "rich_text", rich_text: [] },
        }
      : {}),
    ...savedProperties,
    ...(hasFiles
      ? { Files: { id: "files", type: "files", files: attachment ? [attachment] : [] } }
      : {}),
  })
  const row = () => ({
    id: root,
    ...revision,
    parent: { type: "data_source_id", database_id: database, data_source_id: "ds" },
    properties: properties(),
  })
  const stateRoot = mkdtempSync(join(tmpdir(), "missing-root-inventory-production-"))
  const store = Layer.succeed(Store, {
    upstream: upstreamRepositoryFixture(),
    registerBindingWithBase: () => Effect.die(new Error("Unexpected binding transaction")),
    integrity: integrityRepositoryFixture(integrityJson),
    advanceBaseAndReceipt: () => Effect.die(new Error("Unexpected baseline transaction")),
    backup: () => Effect.die(new Error("Unexpected backup")),
    root: stateRoot,
    configRoot: "/memory",
    cacheRoot: "/memory",
    reserveCacheGeneration: (() => {
      let generation = 0
      return () => Effect.sync(() => ++generation)
    })(),
    listKeys: (prefix) =>
      Effect.sync(() => [...json.keys()].filter((key) => key.startsWith(`${prefix}/`))),
    retireKeys: (keys) =>
      Effect.sync(() => {
        for (const key of keys) json.delete(key)
        return keys.map((key) => ({ key, retention_path: "fixture_trash" }))
      }),
    readJson: (key, schema) =>
      Effect.succeed(json.has(key) ? decode(schema, json.get(key)) : undefined),
    writeJson: (key, value) =>
      Effect.gen(function* () {
        json.set(key, structuredClone(value))
        if (
          stopAfterCertificate &&
          key.startsWith("publications/") &&
          Array.isArray(property(value).intents) &&
          (property(value).intents as unknown[]).some(
            (intent) => property(property(intent).recovery).kind === "retained_unusable",
          )
        ) {
          stopAfterCertificate = false
          return yield* Effect.fail(
            fail("NTN_UNAVAILABLE", "Persisted replacement decision; process interrupted"),
          )
        }
      }),
    readBytes: (key) =>
      objects.has(key)
        ? Effect.succeed(objects.get(key)!)
        : Effect.fail(fail("SNAPSHOT_MISSING", "Missing object")),
    writeBytes: (key, bytes) =>
      Effect.sync(() => {
        objects.set(key, bytes)
      }),
    output: () => Effect.fail(fail("UNUSED", "unused")),
  })
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("credential"),
    request: (path, payload, options) =>
      Effect.gen(function* () {
        if (payload === undefined && (!options?.method || options.method === "GET")) {
          reads.set(path, (reads.get(path) ?? 0) + 1)
          readPaths.push(path)
          if (readInterruption) {
            readInterruption = false
            return yield* Effect.fail(
              fail("NTN_UNAVAILABLE", "Read interrupted after an actual upload ACK"),
            )
          }
        }
        if (failNextRead && payload === undefined && !options?.method) {
          failNextRead = false
          return yield* Effect.fail(fail("ACCESS_DENIED", "Final verification read interrupted"))
        }
        if (
          interruptRootReadback &&
          rootMarkdownAcknowledged &&
          path === `v1/pages/${root}/markdown` &&
          payload === undefined &&
          (!options?.method || options.method === "GET")
        ) {
          rootReadbacks++
          if (rootReadbacks === 2) {
            interruptRootReadback = false
            return yield* Effect.fail(
              fail("ACCESS_DENIED", "Root body checkpoint read interrupted"),
            )
          }
        }
        const block = blocks.get(path.split("/")[2]!)
        if (/^v1\/blocks\/[^/]+$/.test(path) && block) {
          if (options?.method === "PATCH") {
            mutations++
            businessPatches++
            const before = typedLinkRepair ? blockMarkdown(block) : undefined
            Object.assign(block, property(payload))
            const field = property(block[String(block.type)]),
              spans = field.rich_text
            if (Array.isArray(spans))
              field.rich_text = spans.map((span) => ({
                ...property(span),
                plain_text: property(property(span).text).content,
                annotations: { bold: false, code: false, ...property(property(span).annotations) },
              }))
            if (before !== undefined) {
              const owner = property(block.parent).page_id
              const after = blockMarkdown(block)
              const child = children.find((child) => child.id === owner)
              if (child) child.body = child.body.replace(before, after)
              else if (owner === root) main = main.replace(before, after)
            }
          }
          return structuredClone(block)
        }
        if (inventories.has(path)) return inventories.get(path)
        if (path === "v1/users/me") return { id: "fixture", object: "user" }
        if (
          path === `v1/databases/${upstreamDatabase}` &&
          payload === undefined &&
          (!options?.method || options.method === "GET")
        )
          return {
            id: upstreamDatabase,
            database_type: null,
            title: [],
            data_sources: [{ id: upstreamDataSource, name: "Upstream" }],
          }
        if (
          path === `v1/pages/${managedOwnership.subscription_id}` &&
          payload === undefined &&
          (!options?.method || options.method === "GET")
        )
          return {
            id: managedOwnership.subscription_id,
            parent: {
              type: "data_source_id",
              database_id: upstreamDatabase,
              data_source_id: upstreamDataSource,
            },
            ...revision,
            archived: false,
            in_trash: false,
            properties: structuredClone(subscriptionProperties),
          }
        if (path === `v1/databases/${database}`)
          return {
            id: database,
            database_type: null,
            title: [],
            data_sources: [{ id: "ds", name: "Skills" }],
          }
        if (path === "v1/data_sources/ds")
          return {
            properties: {
              ...properties(),
              ...(ownershipSchema ? structuredClone(publicationSourceSchema) : {}),
            },
          }
        if (path === "v1/data_sources/ds/query")
          return { results: exists ? [row()] : [], has_more: false, next_cursor: null }
        if (path === "v1/pages") {
          mutations++
          if (property(payload).parent && property(property(payload).parent).data_source_id) {
            exists = true
            persistProperties(property(payload).properties)
            return row()
          }
          const title = String(
            property(
              property(
                (property(property(payload).properties).title as { title: unknown[] }).title[0],
              ).text,
            ).content,
          )
          const child = {
            id: `22222222-2222-4222-8222-${String(children.length + 1).padStart(12, "0")}`,
            title,
            body: ((property(payload).children as unknown[]) ?? [])
              .map((block) => {
                const values = property(property(block).paragraph).rich_text
                return Array.isArray(values)
                  ? values
                      .map((item) => String(property(property(item).text).content ?? ""))
                      .join("")
                  : ""
              })
              .join("\n"),
          }
          if (typedLinkRepair) {
            for (const block of bodyBlocks(child.id, child.body)) blocks.set(block.id, block)
          }
          children.push(child)
          return {
            id: child.id,
            ...revision,
            parent: { type: "page_id", page_id: root },
            properties: {
              title: {
                id: "title",
                type: "title",
                title: [{ type: "text", text: { content: title }, plain_text: title }],
              },
            },
          }
        }
        if (path === `v1/pages/${root}`) {
          if (options?.method === "PATCH") {
            mutations++
            if (!property(property(payload).properties).Publication) businessPatches++
            propertyWrites.push(property(property(payload).properties))
            const publication = property(property(payload).properties).Publication
            const commit =
              publication &&
              publicationMarker({
                properties: {
                  Publication: { type: "rich_text", ...property(publication) },
                },
              })?.state === "committed"
            const commitFault = commit ? commitFaults.shift() : undefined
            if (commit) commitAttempts++
            if (commitFault === "before")
              return yield* Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "Commit request did not apply; response lost"),
              )
            if (
              ownershipUnknownArmed &&
              Object.hasOwn(property(property(payload).properties), "Upstream")
            ) {
              ownershipUnknownArmed = false
              return yield* Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "Ownership response lost before application"),
              )
            }
            if (property(property(payload).properties).references) {
              if (
                (failure === "registration" ||
                  (failure === "registration_unknown" && registrationUnknownArmed)) &&
                !interrupted
              ) {
                interrupted = true
                return yield* Effect.fail(
                  fail(
                    failure === "registration_unknown" ? "WRITE_OUTCOME_UNKNOWN" : "ACCESS_DENIED",
                    "Registration interrupted",
                  ),
                )
              }
              references = (
                property(property(property(payload).properties).references).rich_text as unknown[]
              ).map((value) => {
                const item = property(value)
                return { ...item, plain_text: property(item.text).content }
              })
            }
            const uploaded = property(property(property(payload).properties).files).files
            if (Array.isArray(uploaded)) {
              const file = property(uploaded[0])
              if (originalUploadFault === "unknown_files") {
                originalUploadFault = undefined
                unusableUploads.add(String(property(file.file_upload).id))
                return yield* Effect.fail(
                  fail(
                    "WRITE_OUTCOME_UNKNOWN",
                    "Original Files request did not apply; response lost",
                  ),
                )
              }
              const key = `/${crypto.randomUUID()}`
              bundles.set(key, uploads.get(String(property(file.file_upload).id))!)
              attachment = {
                id: String(property(file.file_upload).id),
                name: String(file.name),
                type: "file",
                file: { url: new URL(key, server.url).href },
              }
            }
            persistProperties(property(payload).properties)
            if (Array.isArray(uploaded) && replacementFilesResponseLost) {
              replacementFilesResponseLost = false
              return yield* Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "Replacement Files applied; response lost"),
              )
            }
            if (commitFault === "after")
              return yield* Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "Commit applied; response lost"),
              )
            if (Array.isArray(uploaded) && failure === "attachment" && !interrupted) {
              interrupted = true
              return yield* Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Attachment response lost"))
            }
          }
          const current = row()
          if (changedRootRevision && payload === undefined && !options?.method) {
            return { ...current, last_edited_time: "2026-10-19T00:00:00.000Z" }
          }
          return current
        }
        if (path.includes(`/blocks/${root}/children`)) {
          return {
            results: [
              ...(typedLinkRepair
                ? [...blocks.values()].filter((block) => property(block.parent).page_id === root)
                : bodyBlocks(root, main)),
              ...children.map((child) => ({
                id: child.id,
                type: "child_page",
                has_children: false,
                parent: { type: "page_id", page_id: root },
                child_page: { title: child.title },
              })),
            ],
            has_more: false,
            next_cursor: null,
          }
        }
        if (path.includes("/blocks/") && path.includes("/children")) {
          const child = children.find((child) => child.id === path.split("/")[2])
          if (child)
            return {
              results: [
                ...(typedLinkRepair ? [] : bodyBlocks(child.id, child.body)),
                ...[...blocks.values()].filter(
                  (block) => property(block.parent).page_id === child.id,
                ),
              ],
              has_more: false,
              next_cursor: null,
            }
        }
        if (
          path.includes("/blocks/") &&
          path.includes("/children") &&
          blocks.has(path.split("/")[2]!)
        )
          return {
            results: [...blocks.values()].filter(
              (block) => property(block.parent).block_id === path.split("/")[2],
            ),
            has_more: false,
            next_cursor: null,
          }
        if (path.includes("/blocks/") && path.includes("/children"))
          return { results: [], has_more: false, next_cursor: null }
        if (path.includes(`/pages/${root}/properties/references`)) {
          const items = structuredClone(references)
          if (referenceReadChange === "url" && items.length) {
            const text = property(property(items[0]).text)
            property(text.link).url = String(property(text.link).url) + "?external=1"
          }
          return {
            object: "list",
            type: "property_item",
            results: items.map((rich_text) => ({
              object: "property_item",
              type: "rich_text",
              id: "references",
              rich_text,
            })),
            has_more: referenceReadChange === "missing_cursor",
            next_cursor: referenceReadChange === "missing_cursor" ? "missing" : null,
          }
        }
        if (path === `v1/pages/${root}/properties/files`)
          return {
            object: "property_item",
            id: "files",
            type: "files",
            files: attachment ? [structuredClone(attachment)] : [],
            ...(filePropertyIncomplete ? { has_more: true, next_cursor: "unexpected" } : {}),
          }
        if (path === "v1/file_uploads") {
          const id = `88888888-8888-4888-8888-${String(++upload).padStart(12, "0")}`
          if (upload > 1 && stopAfterNewAllocation) {
            stopAfterNewAllocation = false
            readInterruption = true
          }
          return { id, status: "pending" }
        }
        if (/^v1\/file_uploads\/[^/]+$/.test(path)) {
          const id = path.split("/")[2]!
          return unusableUploads.has(id)
            ? { id, status: "expired", expiry_time: null, content_length: null }
            : {
                id,
                status: uploads.has(id) ? "uploaded" : "pending",
                expiry_time: "2030-01-01T00:00:00.000Z",
              }
        }
        if (path.startsWith("v1/file_uploads/") && path.endsWith("/send")) {
          uploadSends++
          const id = path.split("/")[2]!
          sendAttempts.set(id, (sendAttempts.get(id) ?? 0) + 1)
          if (unusableUploads.has(id))
            throw new Error("An unusable upload must never be sent again")
          if (originalUploadFault === "unknown_send") {
            originalUploadFault = undefined
            unusableUploads.add(id)
            return yield* Effect.fail(
              fail("WRITE_OUTCOME_UNKNOWN", "Original send outcome is unknown"),
            )
          }
          uploads.set(id, objects.get(options!.file!.slice(`${stateRoot}/`.length))!)
          if (originalUploadFault === "completed_send") {
            originalUploadFault = undefined
            unusableUploads.add(id)
            readInterruption = true
          }
          return { id, status: "uploaded" }
        }
        const id = path.split("/")[2]
        const child = children.find((child) => child.id === id)
        if (path.endsWith("/markdown")) {
          if (options?.method === "PATCH") {
            mutations++
            const removed: string[] = []
            for (const [blockId, block] of blocks) {
              let parent = property(block.parent)
              const seen = new Set<string>()
              while (
                parent.type === "block_id" &&
                typeof parent.block_id === "string" &&
                !seen.has(parent.block_id)
              ) {
                seen.add(parent.block_id)
                parent = property(blocks.get(parent.block_id)?.parent)
              }
              if (parent.page_id === id) removed.push(blockId)
            }
            for (const blockId of removed) blocks.delete(blockId)
            businessPatches++
            if (id === root && interruptRootReadback) {
              rootMarkdownAcknowledged = true
              rootReadbacks = 0
            }
            const submitted = String(property(property(payload).replace_content).new_str)
            const body = typedLinkRepair
              ? submitted.replace(
                  /https:\/\/www\.notion\.so\/([a-f0-9]{32})#ntn-skills-path=[^\s)>]+/g,
                  "https://app.notion.com/p/$1",
                )
              : submitted
            if (child)
              child.body = changed === "reference" ? "# Silently replaced reference\n" : body
            else
              main =
                changed === "main" ? "# Silently replaced instructions\n" : withoutChildPages(body)
            if (typedLinkRepair)
              for (const block of bodyBlocks(String(id), withoutChildPages(body)))
                blocks.set(block.id, block)
            if (failure === "body" && child?.title === "policy.md" && !interrupted) {
              interrupted = true
              return yield* Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Response lost after write"))
            }
          }
          const source = child ? child.body : main
          const body = quoteBoundary
            ? source
                .replace(/(^>[^\n]*(?:\n>[^\n]*)*)\n\n(?=注意：)/gm, "$1\n")
                .replace(
                  "注意：保留原始边界。",
                  noticeChanged ? "注意：外部修改。" : "注意：保留原始边界。",
                )
            : source
          const rendered = normalized
            ? body
                .replace(/([^\n])\n(?=[^\n<])/g, "$1<br>")
                .replaceAll("https://www.notion.so/", "https://app.notion.com/p/")
            : body
          const tags =
            id === root
              ? children
                  .map(
                    (child) =>
                      `<page url="https://app.notion.com/p/${child.id.replaceAll("-", "")}">${child.title}</page>`,
                  )
                  .join("\n")
              : ""
          return {
            ...(options?.method === "PATCH" ? { id } : {}),
            object: "page_markdown",
            markdown: `${rendered}${tags ? "\n" + tags : ""}`,
            truncated: false,
            unknown_block_ids: [],
          }
        }
        if (child)
          return {
            id: child.id,
            ...revision,
            parent: { type: "page_id", page_id: root },
            properties: {
              title: {
                id: "title",
                type: "title",
                title: [{ type: "text", text: { content: child.title }, plain_text: child.title }],
              },
            },
            ...(changedChildRevision ? { last_edited_time: "2026-10-20T00:00:00.000Z" } : {}),
          }
        return yield* Effect.fail(fail("UNEXPECTED", "Unexpected request", { path }))
      }),
  })
  const fs = FileSystem.makeNoop({
    stat: (path) =>
      Effect.succeed({
        type: path === "/input" ? "Directory" : "File",
        mtime: Option.none(),
        atime: Option.none(),
        birthtime: Option.none(),
        dev: 1n,
        ino: Option.none(),
        mode: 0o600,
        nlink: Option.none(),
        uid: Option.none(),
        gid: Option.none(),
        rdev: Option.none(),
        size: ByteSize.bytes(10),
        blksize: Option.none(),
        blocks: Option.none(),
      }),
    readDirectory: () => Effect.succeed([...input.keys()]),
    readFile: (path) => Effect.succeed(input.get(path.slice("/input/".length))!),
  })
  const layer = Layer.mergeAll(
    NodeServices.layer,
    NodeHttpClient.layerFetch,
    store,
    api,
    Layer.succeed(FileSystem.FileSystem, fs),
  )
  return {
    children,
    enableOwnership: () => {
      ownershipSchema = true
    },
    rootPage: row,
    commitFault: (fault: "before" | "after") => {
      commitFaults.push(fault)
    },
    commitAttempts: () => commitAttempts,
    ledger: (id: string) =>
      decode(IntegrityIntentSchema, integrityJson.get(`integrity/operations/${id}`)),
    changeRootBody: (changed = true) => {
      main = changed
        ? main + "\nExternal instruction.\n"
        : main.replace(/\nExternal instruction\.\n$/, "")
    },
    // Only negative tests alter a valid saved authority after its real failure.
    tamperDesiredRevision: (id: string, revision: string) => {
      const receipt = decode(PublicationReceiptSchema, json.get(`publications/${id}.json`))
      const index = receipt.intents.length - 1
      const intent = receipt.intents[index]!
      const marker = publicationMarker({
        properties: {
          Publication: {
            type: "rich_text",
            ...property(property(property(intent.body).properties).Publication),
          },
        },
      })
      if (marker?.state !== "committed") throw new Error("Expected original committed target")
      receipt.intents[index] = {
        ...intent,
        body: { properties: publicationProperties({ ...marker, revision }) },
      }
      json.set(`publications/${id}.json`, receipt)
    },
    tamperLedgerRevision: (id: string, revision: string) => {
      const ledger = decode(IntegrityIntentSchema, integrityJson.get(`integrity/operations/${id}`))
      if (ledger.marker.state !== "committed") throw new Error("Expected original durable commit")
      integrityJson.set(`integrity/operations/${id}`, {
        ...ledger,
        marker: { ...ledger.marker, revision },
      })
    },
    blocks,
    inventories,
    input,
    interruptRootBodyCheckpoint: () => {
      interruptRootReadback = true
    },
    rootBodyCheckpoint: () => ({
      acknowledged: rootMarkdownAcknowledged,
      readbacks: rootReadbacks,
    }),
    // Model a pre-publication-protocol page; never used by enrolled-page conflict cases.
    legacyPublication: () => {
      delete savedProperties.Publication
    },
    setPublication: (marker: unknown) =>
      persistProperties({
        Publication: { rich_text: [{ type: "text", text: { content: JSON.stringify(marker) } }] },
      }),
    mutations: () => mutations,
    businessPatches: () => businessPatches,
    reads,
    readPaths,
    changeReferenceRead: (changed: "url" | "missing_cursor") => {
      referenceReadChange = changed
    },
    changeChildRevision: () => {
      changedChildRevision = true
    },
    collapseQuote: () => {
      singleQuote = true
    },
    changeNotice: () => {
      noticeChanged = true
    },
    interruptRegistration: () => {
      registrationUnknownArmed = true
    },
    interruptOwnership: () => {
      ownershipSchema = true
      ownershipUnknownArmed = true
    },
    uploadCounts: () => ({ allocations: upload, sends: uploadSends }),
    uploadFault: (fault: UploadFault) => {
      originalUploadFault = fault
    },
    interruptAfterCertificate: () => {
      stopAfterCertificate = true
    },
    interruptAfterNewAllocation: () => {
      stopAfterNewAllocation = true
    },
    loseReplacementFilesResponse: () => {
      replacementFilesResponseLost = true
    },
    incompleteFilesProperty: () => {
      filePropertyIncomplete = true
    },
    occupyFiles: () => {
      attachment = {
        id: "99999999-9999-4999-8999-999999999999",
        name: "external.txt",
        type: "file",
        file: { url: "https://example.com/external.txt" },
      }
    },
    sendAttempts: (id: string) => sendAttempts.get(id) ?? 0,
    stagedBytes: (id: string) => {
      const receipt = decode(PublicationReceiptSchema, json.get(`publications/${id}.json`))
      const artifact = receipt.intents.find((intent) => intent.artifact)!.artifact!
      return objects.get(`uploads/${artifact.sha256}/${artifact.filename}`)!
    },
    changeStagedBytes: (id: string) => {
      const receipt = decode(PublicationReceiptSchema, json.get(`publications/${id}.json`))
      const artifact = receipt.intents.find((intent) => intent.artifact)!.artifact!
      const key = `uploads/${artifact.sha256}/${artifact.filename}`
      const bytes = objects.get(key)!.slice()
      bytes[0] = bytes[0]! ^ 1
      objects.set(key, bytes)
    },
    changeAttachedBytes: () => {
      if (!attachment) throw new Error("Expected an acknowledged source attachment")
      const key = new URL(attachment.file.url).pathname
      const original = bundles.get(key)
      if (!original?.length) throw new Error("Expected retained source archive bytes")
      const changed = original.slice()
      changed[0] = changed[0]! ^ 1
      bundles.set(key, changed)
    },
    changeFrozenBytes: (operationId: string) => {
      const receipt = decode(PublicationReceiptSchema, json.get(`publications/${operationId}.json`))
      const file = receipt.portable.files.find((file) => file.path === receipt.portable.main)!
      const original = objects.get(`objects/${file.sha256}`)
      if (!original?.length) throw new Error("Expected the frozen original main source")
      const changed = original.slice()
      changed[0] = changed[0]! ^ 1
      objects.set(`objects/${file.sha256}`, changed)
    },
    failNextRead: () => {
      failNextRead = true
    },
    changeRootRevision: (changed: boolean) => {
      changedRootRevision = changed
    },
    changeDescription: () => {
      savedProperties.Description = {
        id: "description",
        type: "rich_text",
        rich_text: [
          { type: "text", text: { content: "External edit" }, plain_text: "External edit" },
        ],
      }
    },
    changeKind: () => {
      savedProperties.Kind = {
        id: "kind",
        type: "select",
        select: { id: "option-skill", color: "default", name: "prompt" },
      }
    },
    changeResource: () => {
      savedProperties.Files = {
        id: "files",
        type: "files",
        files: [
          {
            id: "external-resource",
            name: "changed.bin",
            type: "external",
            external: { url: "https://example.com/changed.bin" },
          },
        ],
      }
    },
    receipt: (operationId: string) =>
      decode(PublicationReceiptSchema, json.get(`publications/${operationId}.json`)),
    propertyWrites,
    run: <A, E>(effect: Effect.Effect<A, E, any>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>),
  }
}

const retainedSource =
  "---\nname: sample-skill\ndescription: Use for recovery.\n---\n\n# Sample\n\nKeep the original source artifact and publication identity.\n"
const managedOwnership = {
  subscription_id: "77777777-7777-4777-8777-777777777777",
  member_key: "retained-upload",
  mode: "tracked" as const,
  published_hash: createHash("sha256").update(retainedSource).digest("hex"),
  revision: "original-upstream",
}

async function stopAtUnusableUpload(
  fault: "unknown_send" | "completed_send" | "unknown_files",
  reference = false,
) {
  const f = fixture(undefined, true, undefined, false, false, true)
  f.enableOwnership()
  await f.run(
    Effect.flatMap(Store, (store) =>
      store.writeJson("config.json", { upstream_database: upstreamDatabase }),
    ),
  )
  f.input.clear()
  f.input.set("SKILL.md", encoder.encode(retainedSource))
  if (reference)
    f.input.set(
      "references/guide.md",
      encoder.encode("# Guide\n\nRetain this exact referenced source.\n"),
    )
  f.uploadFault(fault)
  const stopped = await f.run(
    createSkill("/input", { database, ownership: managedOwnership }).pipe(Effect.result),
  )
  expect(stopped._tag).toBe("Failure")
  if (stopped._tag !== "Failure")
    throw new Error("Expected an actual upload transport interruption")
  expect(stopped.failure.code).toBe(
    fault === "completed_send" ? "WRITE_PARTIAL" : "WRITE_OUTCOME_UNKNOWN",
  )
  if (fault === "completed_send")
    expect(property(stopped.failure.details).cause_code).toBe("NTN_UNAVAILABLE")
  const id = String(property(stopped.failure.details).operation_id)
  const original = structuredClone(f.receipt(id))
  expect(original.conflict).toBeUndefined()
  expect(original.owner).toBeUndefined()
  expect(original.result).toBeUndefined()
  expect(original.page_id).toBe(root)
  if (fault === "completed_send") {
    expect(original.intents).toHaveLength(6)
    expect(original.intents.every((intent) => intent.status === "completed")).toBe(true)
  }
  const candidate = retainedUnusableUploadCandidate(original, metadata(f.rootPage()))
  expect(candidate).toBeDefined()
  if (!candidate)
    throw new Error("The actual original sequence must be eligible before testing recovery")
  expect(original.intents[candidate.send_index]!.status).toBe(
    fault === "unknown_send" ? "unknown" : "completed",
  )
  expect(candidate.files_intent_index === undefined).toBe(fault !== "unknown_files")
  expect(f.sendAttempts(candidate.upload_id)).toBe(1)
  expect(f.uploadCounts()).toEqual({ allocations: 1, sends: 1 })
  expect(f.stagedBytes(id).length).toBe(candidate.artifact.byte_length)
  expect(createHash("sha256").update(f.stagedBytes(id)).digest("hex")).toBe(
    candidate.artifact.sha256,
  )
  return { f, id, original, candidate }
}

async function verifyRetainedResult(setup: Awaited<ReturnType<typeof stopAtUnusableUpload>>) {
  const { f, id, original, candidate } = setup
  const current = f.receipt(id)
  expect(current.state).toBe("completed")
  expect(current.result?.verified).toBe(true)
  expect(current.page_id).toBe(original.page_id)
  expect(current.owner).toBeUndefined()
  expect(current.conflict).toBeUndefined()
  expect(retainedUploadCertificates(current)).toHaveLength(1)
  const proof = retainedUploadReplacementCandidates(current)?.[0]
  expect(proof?.replacement).toBeDefined()
  if (!proof?.replacement) throw new Error("Expected the real later whole Files ACK")
  expect(proof.replacement.upload_id).not.toBe(candidate.upload_id)
  expect(f.sendAttempts(candidate.upload_id)).toBe(1)
  expect(f.sendAttempts(proof.replacement.upload_id)).toBe(1)
  expect(f.uploadCounts()).toEqual({ allocations: 2, sends: 2 })
  expect(
    current.intents
      .slice(0, original.intents.length)
      .map(({ recovery: _added, ...intent }) => intent),
  ).toEqual(original.intents)
  expect(proof.certificate.artifact).toEqual(candidate.artifact)
  const snapshot = await f.run(openSkill(root, { database, refresh: true }))
  const exported = await f.run(snapshotAuthoredPortable(snapshot))
  expect(
    exported.files.map((file) => [
      file.path,
      createHash("sha256").update(file.bytes).digest("hex"),
    ]),
  ).toEqual(original.portable.files.map((file) => [file.path, file.sha256]))
  const writes = f.mutations()
  const observed = await f.run(reconcilePublication(id))
  expect(observed).toMatchObject({ outcome: "success", verified: true })
  expect(f.mutations()).toBe(writes)
  expect(
    f
      .receipt(id)
      .intents.slice(0, original.intents.length)
      .map(({ recovery: _added, ...intent }) => intent),
  ).toEqual(original.intents)
}

for (const fault of ["unknown_send", "completed_send", "unknown_files"] as const) {
  test(`same original publication retains ${fault} history and verifies one independent source artifact`, async () => {
    const setup = await stopAtUnusableUpload(fault, fault === "unknown_files")
    const { f, id } = setup
    const result = await f.run(resumePublication(id, { newArtifact: true }))
    expect(result).toMatchObject({ operation_id: id, verified: true, resumed: true })
    await verifyRetainedResult(setup)
  })
}

for (const boundary of ["certificate", "allocation"] as const) {
  test(`an interruption after the replacement ${boundary} reuses the same recorded suboperation`, async () => {
    const setup = await stopAtUnusableUpload("unknown_send")
    const { f, id, original } = setup
    if (boundary === "certificate") f.interruptAfterCertificate()
    else f.interruptAfterNewAllocation()
    const stopped = await f.run(resumePublication(id, { newArtifact: true }).pipe(Effect.result))
    expect(stopped._tag).toBe("Failure")
    expect(f.receipt(id).conflict).toBeUndefined()
    expect(retainedUploadCertificates(f.receipt(id))).toHaveLength(1)
    expect(f.uploadCounts().allocations).toBe(boundary === "certificate" ? 1 : 2)
    expect(
      f
        .receipt(id)
        .intents.slice(0, original.intents.length)
        .map(({ recovery: _added, ...intent }) => intent),
    ).toEqual(original.intents)
    await f.run(resumePublication(id))
    await verifyRetainedResult(setup)
  }, 60_000)
}

for (const changed of [
  "body",
  "metadata",
  "revision",
  "occupied_files",
  "incomplete_files",
  "frozen_bytes",
  "staged_bytes",
] as const) {
  test(`retained upload replacement refuses ${changed} before allocating another resource`, async () => {
    const { f, id, original } = await stopAtUnusableUpload("unknown_files")
    if (changed === "body") f.changeRootBody()
    if (changed === "metadata") f.changeDescription()
    if (changed === "revision") f.changeRootRevision(true)
    if (changed === "occupied_files") {
      f.occupyFiles()
      expect(property(property(property(f.rootPage()).properties).Files).files).toHaveLength(1)
    }
    if (changed === "incomplete_files") f.incompleteFilesProperty()
    if (changed === "frozen_bytes") f.changeFrozenBytes(id)
    if (changed === "staged_bytes") f.changeStagedBytes(id)
    const writes = f.mutations()
    const stopped = await f.run(resumePublication(id, { newArtifact: true }).pipe(Effect.result))
    expect(stopped._tag).toBe("Failure")
    expect(f.uploadCounts()).toEqual({ allocations: 1, sends: 1 })
    expect(f.mutations()).toBe(writes)
    expect(f.receipt(id).intents).toEqual(original.intents)
    expect(f.receipt(id).owner).toBeUndefined()
    expect(f.receipt(id).state).not.toBe("completed")
  })
}

test("an actual external-edit fence still requires native reconciliation before upload recovery", async () => {
  const { f, id } = await stopAtUnusableUpload("unknown_send")
  f.changeRootBody(true)
  const stopped = await f.run(resumePublication(id, { newArtifact: true }).pipe(Effect.result))
  expect(stopped._tag).toBe("Failure")
  expect(f.receipt(id).conflict).toBe(true)
  f.changeRootBody(false)
  const retry = await f.run(resumePublication(id, { newArtifact: true }).pipe(Effect.result))
  expect(retry._tag).toBe("Failure")
  expect(f.receipt(id).conflict).toBe(true)
  expect(f.uploadCounts()).toEqual({ allocations: 1, sends: 1 })
  expect(retainedUploadCertificates(f.receipt(id))).toEqual([])
})
