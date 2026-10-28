// Natural source installation lifecycle: every receipt and ACK is produced by the native writer.
// Fixture transport is copied from current formal content adoption SHA 46635c6b7324dadb0a34406a36893e86f912bbf34850b69d75ee03c41d61391e.
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
import { ByteSize, Crypto, Effect, FileSystem, Layer, Option, Path } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { createSkill, replaceSkill, resumePublication, writeSkill } from "../src/mutation.ts"
import { decode, fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store, sha256 } from "../src/store.ts"
import { UpstreamState } from "../src/upstream-state.ts"
import { UpstreamPublisher, strictDecode, UpstreamPlanSchema } from "../src/upstream-model.ts"
import { UpstreamPublisherLive } from "../src/upstream-publication.ts"
import { applyUpstream } from "../src/upstream-apply.ts"
import {
  freezePortable,
  contentDeltas,
  subscriptionConfigHash,
  targetKey,
} from "../src/upstream-content.ts"
import { getSubscription } from "../src/upstream-subscription.ts"
import {
  planContentAdoption,
  applyContentAdoption,
  readContentAdoptionOriginalInput,
} from "../src/upstream-content-adoption.ts"
import { contentAdoptionDownloadFenceCandidate } from "../src/publication-content-adoption-download.ts"
import {
  ContentAdoptionAttemptSchema,
  contentAdoptionJournal,
  contentAdoptionPlanKey,
  adoptionRefusal,
  contentAdoptionHandoffBody,
  contentAdoptionWriting,
  type ContentAdoptionInput,
} from "../src/publication-content-adoption-authority.ts"
import { DescriptionFinalLfMigration } from "../src/publication-content-adoption-description.ts"
import { loadSnapshot, openSkill, readSkill } from "../src/snapshot.ts"
import { portableIdentity, snapshotAuthoredPortable, snapshotPortable } from "../src/export.ts"
import { authScope } from "../src/catalog.ts"
import { cachedRemoteObservation } from "../src/cache.ts"
import { PortableSourceDecoder } from "../src/portable-source.ts"
import {
  bodyIdentity,
  canonicalMain,
  portableZip,
  readPortable,
  type PortableSkill,
} from "../src/portable.ts"
import { importDocument, readImportZip } from "../src/import.ts"
import { withoutCreationMarker } from "../src/publication-create-identity.ts"
import { PublicationReceiptSchema } from "../src/publication-model.ts"
import {
  publicationMarker,
  publicationProperties,
  PublicationReadOperation,
} from "../src/publication-integrity.ts"
import { IntegrityIntentSchema } from "../src/publication-integrity-state.ts"
import type { PublicationMarker } from "../src/publication-integrity-state.ts"
import { terminalPublicationCommitCandidate } from "../src/publication-terminal-commit.ts"
import { withoutChildPages } from "../src/references.ts"
import {
  blockPatchRecovery,
  metadata,
  publicationPropertiesMatch,
} from "../src/publication-observation.ts"
import { reconcilePublication } from "../src/publication-reconcile.ts"
import {
  canonical,
  publicationBlockReplacementCandidates,
  publicationPropertyReplacementCandidates,
} from "../src/publication-effect-proof.ts"
import { Lexer } from "marked"
import { markdownIdentity } from "../src/markdown.ts"
import { decodeReferenceLinks, referenceLinks } from "../src/reference-links.ts"

const database = "44444444-4444-4444-8444-444444444444"
const dataSource = "99999999-9999-4999-8999-999999999999"
const subscriptionId = "77777777-7777-4777-8777-777777777777"
const root = "11111111-1111-4111-8111-111111111111"
const upstreamDatabase = "55555555-5555-4555-8555-555555555555"
const upstreamDataSource = "66666666-6666-4666-8666-666666666666"
const encoder = new TextEncoder()
const bundles = new Map<string, Uint8Array>()
const downloads = new Map<string, number>()
const resignedFaults = new Map<string, { kind: "network" | "legacy_refusal"; remaining: number }>()
const fixtureFetch: typeof globalThis.fetch = Object.assign(
  async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = new URL(String(input))
    if (url.origin !== "https://content-adoption.example.test")
      throw new Error("Unexpected fixture fetch origin")
    const bytes = bundles.get(url.pathname)
    if (bytes) downloads.set(url.pathname, (downloads.get(url.pathname) ?? 0) + 1)
    const fault = resignedFaults.get(url.pathname)
    if (fault && (downloads.get(url.pathname) ?? 0) >= 2 && fault.remaining > 0) {
      fault.remaining--
      if (fault.kind === "legacy_refusal")
        throw adoptionRefusal("A re-signed Files download failed.")
      throw new TypeError("The signed attachment GET connection was interrupted")
    }
    return bytes ? new Response(bytes.slice().buffer) : new Response(null, { status: 404 })
  },
  {
    preconnect: () => {
      throw new Error("Unexpected fixture preconnect")
    },
  },
)
type FixtureEnvironment =
  | Store
  | Notion
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | HttpClient.HttpClient
  | UpstreamState
  | UpstreamPublisher

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
  let completeDescriptionReadback = false
  const commitFaults: Array<"before" | "after"> = []
  let commitAttempts = 0
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
  const revision = { last_edited_time: "2026-10-18T00:00:00.000Z" }
  let changedUpdated: ((field: Readonly<Record<string, unknown>>) => unknown) | undefined
  const updated = () => {
    const field = {
      id: "updated",
      type: "last_edited_time",
      last_edited_time: revision.last_edited_time,
    }
    return changedUpdated ? changedUpdated(field) : field
  }
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
              last_edited_time: "2026-10-18T00:00:00.000Z",
              id: blockId(id, index),
              parent: { type: "page_id", page_id: id },
              type: "code",
              has_children: false,
              code: {
                language: !token.lang || token.lang === "text" ? "plain text" : token.lang,
                rich_text: [
                  { type: "text", text: { content: token.text }, plain_text: token.text },
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
            last_edited_time: "2026-10-18T00:00:00.000Z",
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
        ...(type === "relation" ? { has_more: false } : {}),
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
                ...(completeDescriptionReadback && name === "Description"
                  ? {
                      text: { ...property(property(item).text), link: null },
                      href: null,
                      annotations: {
                        bold: false,
                        italic: false,
                        strikethrough: false,
                        underline: false,
                        code: false,
                        color: "default",
                      },
                    }
                  : {}),
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
  let uploadFault: { effect: "allocation" | "send"; outcome: "before" | "after" } | undefined
  let filesOverride: ((field: Readonly<Record<string, unknown>>) => unknown) | undefined
  let resignedFault: "network" | "legacy_refusal" | undefined
  let signedUrlSequence = 0
  const ownershipDownloads: number[] = []
  const writeLog: Array<{ path: string; method: string; fields: string[] }> = []
  const downloadCount = () =>
    attachment ? (downloads.get(new URL(attachment.file.url).pathname) ?? 0) : 0
  const input = new Map<string, Uint8Array>([
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
  const integrityJson = json
  const upstream = upstreamRepositoryFixture(json)
  let aliasCompetition = false
  let propertyFault:
    | { effect: "handoff" | "ownership" | "commit" | "attachment"; outcome: "before" | "after" }
    | undefined
  let rootPropertySequence = 0
  const objects = new Map<string, Uint8Array>()
  const rich = (content: string) => ({
    type: "rich_text",
    rich_text: [{ type: "text", text: { content }, plain_text: content }],
  })
  // A member commit precedes publication of its source active map. The real
  // member reader supports this complete subscription with no active map yet.
  const subscriptionProperties: Record<string, unknown> = {
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
    Updated: updated(),
    Editor: {
      id: "editor",
      type: "last_edited_by",
      last_edited_by: { object: "user", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    },
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
      ? {
          Files: (() => {
            const field = {
              id: "files",
              type: "files",
              files: attachment
                ? [
                    {
                      ...attachment,
                      file: {
                        url:
                          attachment.file.url +
                          (resignedFault ? `?signed=${++signedUrlSequence}` : ""),
                      },
                    },
                  ]
                : [],
            }
            return filesOverride ? filesOverride(field) : field
          })(),
        }
      : {}),
  })
  const row = () => ({
    id: root,
    ...revision,
    parent: { type: "data_source_id", database_id: database, data_source_id: dataSource },
    properties: properties(),
  })
  const stateRoot = mkdtempSync(join(tmpdir(), "missing-root-inventory-production-"))
  const uploadStores = new Map<string, Map<string, Uint8Array>>([[stateRoot, objects]])
  const service: Store["Service"] = {
    upstream,
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
      Effect.sync(() => {
        json.set(key, value)
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
  }
  json.set("config.json", { default_database: database, upstream_database: upstreamDatabase })
  const store = Layer.succeed(Store, service)
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("credential"),
    request: (path, payload, options) =>
      Effect.gen(function* () {
        const method = options?.method ?? (payload === undefined ? "GET" : "POST")
        if (method !== "GET" && !path.endsWith("/query") && path !== "v1/search")
          writeLog.push({
            path,
            method,
            fields: Object.keys(property(property(payload).properties)).sort(),
          })
        if (payload === undefined && (!options?.method || options.method === "GET")) {
          reads.set(path, (reads.get(path) ?? 0) + 1)
          readPaths.push(path)
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
        const subscriptionRow = () => ({
          id: subscriptionId,
          parent: {
            type: "data_source_id",
            database_id: upstreamDatabase,
            data_source_id: upstreamDataSource,
          },
          last_edited_time: "2026-10-18T00:00:00.000Z",
          archived: false,
          in_trash: false,
          properties: structuredClone(subscriptionProperties),
        })
        if (path === `v1/data_sources/${upstreamDataSource}`)
          return {
            id: upstreamDataSource,
            parent: { database_id: upstreamDatabase },
            title: [],
            properties: Object.fromEntries(
              Object.entries(subscriptionProperties).map(([name, value]) => [
                name,
                { id: name === "Name" ? "title" : name, type: property(value).type },
              ]),
            ),
          }
        if (path === `v1/data_sources/${upstreamDataSource}/query`)
          return {
            results: [subscriptionRow()],
            has_more: false,
            next_cursor: null,
          }
        if (path === `v1/pages/${subscriptionId}`) {
          if (options?.method === "PATCH") {
            for (const [key, raw] of Object.entries(property(property(payload).properties))) {
              const name = key === "title" ? "Name" : key,
                value = property(raw),
                type = Object.keys(value)[0]!
              const parts = value[type]
              subscriptionProperties[name] = {
                ...property(subscriptionProperties[name]),
                type,
                ...value,
                ...(Array.isArray(parts)
                  ? {
                      [type]: parts.map((part) => ({
                        ...property(part),
                        plain_text: String(property(property(part).text).content ?? ""),
                      })),
                    }
                  : {}),
              }
            }
          }
          return subscriptionRow()
        }
        if (path === `v1/databases/${database}`)
          return {
            id: database,
            database_type: null,
            title: [],
            data_sources: [{ id: dataSource, name: "Skills" }],
          }
        if (path === `v1/data_sources/${dataSource}`)
          return {
            id: dataSource,
            parent: { database_id: database },
            title: [],
            properties: {
              ...properties(),
              ...(ownershipSchema ? structuredClone(publicationSourceSchema) : {}),
            },
          }
        if (path === `v1/data_sources/${dataSource}/query`)
          return {
            results: exists
              ? [
                  row(),
                  ...(aliasCompetition
                    ? [{ ...row(), id: "88888888-8888-4888-8888-888888888888" }]
                    : []),
                ]
              : [],
            has_more: false,
            next_cursor: null,
          }
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
          children.push(child)
          if (typedLinkRepair)
            for (const block of bodyBlocks(child.id, child.body)) blocks.set(block.id, block)
          return {
            id: child.id,
            last_edited_time: "2026-10-18T00:00:00.000Z",
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
            const fieldNames = Object.keys(property(property(payload).properties))
            const effect = publication
              ? commit
                ? "commit"
                : "handoff"
              : fieldNames.includes("Upstream")
                ? "ownership"
                : fieldNames.includes("files")
                  ? "attachment"
                  : undefined
            const fault = effect === propertyFault?.effect ? propertyFault : undefined
            if (fault) propertyFault = undefined
            if (effect === "ownership") ownershipDownloads.push(downloadCount())
            if (fault?.outcome === "before")
              return yield* Effect.fail(
                fail(
                  "WRITE_OUTCOME_UNKNOWN",
                  "Exact adoption property response lost before application",
                ),
              )
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
              const key = `/${crypto.randomUUID()}`
              bundles.set(key, uploads.get(String(property(file.file_upload).id))!)
              if (resignedFault)
                resignedFaults.set(key, {
                  kind: resignedFault,
                  remaining: resignedFault === "network" ? 4 : 1,
                })
              attachment = {
                id: String(property(file.file_upload).id),
                name: String(file.name),
                type: "file",
                file: { url: new URL(key, "https://content-adoption.example.test").href },
              }
            }
            persistProperties(property(payload).properties)
            if (effect) {
              rootPropertySequence++
              revision.last_edited_time = `2026-10-18T00:00:${String(rootPropertySequence).padStart(2, "0")}.000Z`
            }
            if (fault?.outcome === "after")
              return yield* Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "Exact adoption property applied and response lost"),
              )
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
        if (path === "v1/file_uploads") {
          const fault = uploadFault?.effect === "allocation" ? uploadFault : undefined
          if (fault) uploadFault = undefined
          mutations++
          if (fault?.outcome === "before")
            return yield* Effect.fail(
              fail(
                "WRITE_OUTCOME_UNKNOWN",
                "Original source allocation response lost before application",
              ),
            )
          const id = `upload-${++upload}`
          if (fault?.outcome === "after")
            return yield* Effect.fail(
              fail(
                "WRITE_OUTCOME_UNKNOWN",
                "Original source allocation response lost after application",
              ),
            )
          return { id, status: "pending" }
        }
        if (/^v1\/file_uploads\/[^/]+$/.test(path)) {
          const id = path.split("/")[2]!
          return { id, status: uploads.has(id) ? "uploaded" : "pending" }
        }
        if (path.startsWith("v1/file_uploads/") && path.endsWith("/send")) {
          uploadSends++
          mutations++
          const fault = uploadFault?.effect === "send" ? uploadFault : undefined
          if (fault) uploadFault = undefined
          if (fault?.outcome === "before")
            return yield* Effect.fail(
              fail(
                "WRITE_OUTCOME_UNKNOWN",
                "Original source send response lost before application",
              ),
            )
          const absolute = options?.file
          const stores = [...uploadStores].filter(([root]) => absolute?.startsWith(root + "/"))
          if (stores.length !== 1 || !absolute)
            throw new Error("Upload did not use exactly one real fixture Store")
          const [rootPath, bytes] = stores[0]!
          const input = bytes.get(absolute.slice(rootPath.length + 1))
          if (!input) throw new Error("Upload input was not written by the native upload session")
          uploads.set(path.split("/")[2]!, input.slice())
          if (fault?.outcome === "after")
            return yield* Effect.fail(
              fail("WRITE_OUTCOME_UNKNOWN", "Original source send response lost after application"),
            )
          return { status: "uploaded" }
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
            last_edited_time: "2026-10-18T00:00:00.000Z",
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
    Layer.succeed(FetchHttpClient.Fetch, fixtureFetch),
    Layer.succeed(UpstreamState, upstream),
  )
  return {
    children,
    // Initial state from a legacy publisher with no local history. This seeds
    // only the external fixture; every new intent and ACK still comes from the
    // native original apply and the native adoption session.
    seedLegacySource: (portable: PortableSkill, marker: PublicationMarker) => {
      if (
        exists ||
        children.length ||
        [...json.keys()].some((key) => key.startsWith("publications/"))
      )
        throw new Error("Legacy external source must be the initial remote state")
      const source = portable.files.find((file) => file.path === portable.main)
      if (!source) throw new Error("The legacy fixture requires its complete original main")
      exists = true
      completeDescriptionReadback = true
      main = importDocument(source, portable).body
      const referenceSources = portable.files
        .filter((file) => file.path !== portable.main && /\.md$/i.test(file.path))
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      const seeded = referenceSources.map((file, index) => ({
        id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`,
        title:
          file.path.startsWith("references/") &&
          !portable.files.some((source) => source.path === file.path.slice("references/".length))
            ? file.path.slice("references/".length)
            : file.path,
        body: new TextDecoder().decode(file.bytes),
        path: file.path,
      }))
      children.push(...seeded.map(({ id, title, body }) => ({ id, title, body })))
      const links = referenceLinks(seeded.map(({ id, path }) => ({ id, path })))
      if (!links)
        throw new Error("The complete legacy reference graph must fit the original protocol")
      references = links.rich_text.map((item) => ({ ...item, plain_text: item.text.content }))
      persistProperties({
        title: {
          title: [{ type: "text", text: { content: portable.name }, plain_text: portable.name }],
        },
        description: {
          rich_text: [{ type: "text", text: { content: portable.description.slice(0, -1) } }],
        },
        Publication: { rich_text: [{ type: "text", text: { content: JSON.stringify(marker) } }] },
      })
    },
    setDescription: (value: string) =>
      persistProperties({
        description: { rich_text: [{ type: "text", text: { content: value } }] },
      }),
    overrideDescription: (change: (field: Readonly<Record<string, unknown>>) => unknown) => {
      savedProperties.Description = change(property(properties().Description))
    },
    setName: (value: string) =>
      persistProperties({
        title: { title: [{ type: "text", text: { content: value }, plain_text: value }] },
      }),
    enableOwnership: () => {
      ownershipSchema = true
    },
    rootPage: row,
    changeUpdated: (change: (field: Readonly<Record<string, unknown>>) => unknown) => {
      changedUpdated = change
    },
    changeEditor: () => {
      savedProperties.Editor = {
        id: "editor",
        type: "last_edited_by",
        last_edited_by: { object: "user", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      }
    },
    externalRootEdit: () => {
      rootPropertySequence++
      revision.last_edited_time = `2026-10-18T00:00:${String(rootPropertySequence).padStart(2, "0")}.000Z`
    },
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
    changeReferenceRead: (changed?: "url" | "missing_cursor") => {
      referenceReadChange = changed
    },
    changeChildRevision: (changed = true) => {
      changedChildRevision = changed
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
    uploadFault: (effect: "allocation" | "send", outcome: "before" | "after") => {
      uploadFault = { effect, outcome }
    },
    overrideFiles: (change: (field: Readonly<Record<string, unknown>>) => unknown) => {
      filesOverride = change
    },
    failResignedDownload: (kind: "network" | "legacy_refusal") => {
      resignedFault = kind
    },
    downloadCount,
    ownershipDownloads,
    writeLog,
    changeAttachedBytes: (path?: string) => {
      if (!attachment) throw new Error("Expected an acknowledged source attachment")
      const key = new URL(attachment.file.url).pathname
      const original = bundles.get(key)
      if (!original?.length) throw new Error("Expected retained source archive bytes")
      const source = readPortable(readImportZip(original))
      const main = source?.files.find((file) => file.path === (path ?? source.main))
      if (!source || !main || main.bytes.at(-1) !== 0x0a)
        throw new Error("Expected the actual source main with one final LF")
      const changed = main.bytes.slice()
      changed[changed.length - 1] = 0x20
      const packed = portableZip(
        {
          ...source,
          files: source.files.map((file) =>
            file.path === main.path ? { ...file, bytes: changed } : file,
          ),
        },
        true,
      )
      const observed = readPortable(readImportZip(packed))?.files.find(
        (file) => file.path === main.path,
      )
      if (!observed || observed.bytes.length !== main.bytes.length)
        throw new Error("The mutated attachment lost the exact source entry")
      const differences = observed.bytes.reduce(
        (count, byte, index) => count + Number(byte !== main.bytes[index]),
        0,
      )
      if (differences !== 1) throw new Error("The source-byte fixture must change exactly one byte")
      bundles.set(key, packed)
      return differences
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
    retainedOldState: () => structuredClone([...json]),
    competeAlias: () => {
      aliasCompetition = true
    },
    corruptCreation: () => {
      const marker = publicationMarker(row())
      if (!marker?.creation) throw new Error("Expected actual root creation proof")
      persistProperties(
        publicationProperties({
          ...marker,
          creation: { ...marker.creation, source_sha256: "f".repeat(64) },
        }),
      )
    },
    changeOwnerFieldIdentity: () => {
      savedProperties["Published Hash"] = {
        ...property(property(properties())["Published Hash"]),
        id: "external-recreated-property",
      }
    },
    propertyFault: (
      effect: "handoff" | "ownership" | "commit" | "attachment",
      outcome: "before" | "after",
    ) => {
      propertyFault = { effect, outcome }
    },
    forkMachine: () => {
      const saved = new Map<string, unknown>(),
        bytes = new Map<string, Uint8Array>()
      const native = upstreamRepositoryFixture(saved)
      let losePointer = false
      const repository: typeof native = {
        ...native,
        replacePublicationPointer: (...args) =>
          Effect.gen(function* () {
            if (losePointer) {
              losePointer = false
              return yield* Effect.fail(
                fail("STORAGE_ERROR", "Pointer CAS interrupted before its transaction"),
              )
            }
            yield* native.replacePublicationPointer(...args)
          }),
      }
      saved.set("config.json", { default_database: database, upstream_database: upstreamDatabase })
      const machine: Store["Service"] = {
        ...service,
        root: mkdtempSync(join(tmpdir(), "content-adoption-new-machine-")),
        upstream: repository,
        integrity: integrityRepositoryFixture(saved),
        listKeys: (prefix) =>
          Effect.sync(() => [...saved.keys()].filter((key) => key.startsWith(prefix + "/"))),
        retireKeys: (keys) =>
          Effect.sync(() =>
            keys.map((key) => {
              saved.delete(key)
              return { key, retention_path: "fixture_trash" }
            }),
          ),
        readJson: (key, schema) =>
          Effect.sync(() =>
            saved.has(key) ? decode(schema, structuredClone(saved.get(key))) : undefined,
          ),
        writeJson: (key, value) =>
          Effect.sync(() => {
            saved.set(key, structuredClone(value))
          }),
        readBytes: (key) =>
          bytes.has(key)
            ? Effect.succeed(bytes.get(key)!.slice())
            : Effect.fail(fail("SNAPSHOT_MISSING", "Missing new-machine bytes")),
        writeBytes: (key, value) =>
          Effect.sync(() => {
            bytes.set(key, value.slice())
          }),
      }
      uploadStores.set(machine.root, bytes)
      return {
        store: machine,
        persisted: saved,
        repository,
        corruptBytes: (key: string) => {
          const original = bytes.get(key)
          if (!original?.length) throw new Error("Expected a frozen original source object")
          const changed = original.slice()
          changed[0] = changed[0]! ^ 1
          bytes.set(key, changed)
        },
        losePointerOnce: () => {
          losePointer = true
        },
        run: <A, E>(effect: Effect.Effect<A, E, FixtureEnvironment>) =>
          Effect.runPromise(
            effect.pipe(
              Effect.provide(UpstreamPublisherLive),
              Effect.provideService(Store, machine),
              Effect.provideService(UpstreamState, repository),
              Effect.provide(layer),
            ),
          ),
      }
    },
    portableFor: (operationId: string): PortableSkill => {
      const receipt = decode(PublicationReceiptSchema, json.get(`publications/${operationId}.json`))
      return {
        ...receipt.portable,
        files: receipt.portable.files.map((file) => ({
          path: file.path,
          bytes: objects.get(`objects/${file.sha256}`)!.slice(),
        })),
      }
    },
    run: <A, E>(effect: Effect.Effect<A, E, FixtureEnvironment>) =>
      Effect.runPromise(effect.pipe(Effect.provide(UpstreamPublisherLive), Effect.provide(layer))),
  }
}

const memberKey = "skills/sample-skill"
function expectSameSourceFiles(actual: PortableSkill, expected: PortableSkill) {
  expect(new Set(actual.files.map((file) => file.path)).size).toBe(actual.files.length)
  expect(new Set(expected.files.map((file) => file.path)).size).toBe(expected.files.length)
  const byPath = (source: PortableSkill) =>
    source.files
      .map((file) => ({ path: file.path, bytes: Array.from(file.bytes) }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  expect(byPath(actual)).toEqual(byPath(expected))
}

async function originalSourceMissing(withReferences = false, legacyDescription = false) {
  const fake = fixture(undefined, true, undefined, false, true)
  fake.enableOwnership()
  fake.input.clear()
  fake.input.set(
    "SKILL.md",
    encoder.encode(
      "---\nname: sample-skill\ndescription: Use for recovery.\nlicense: MIT\nmetadata:\n  audience: original-source\n---\n\n# Sample\n\nKeep these exact original instructions.\n",
    ),
  )
  if (legacyDescription)
    fake.input.set(
      "SKILL.md",
      encoder.encode(
        "---\nname: sample-skill\ndescription: |\n  Use for recovery.\n  保留内部换行和末尾的一个 LF。\nlicense: MIT\n---\n\n# Sample\n\nKeep these exact original instructions.\n",
      ),
    )
  fake.input.set("examples/case.json", encoder.encode('{"unicode":"原始文本","retain":true}\n'))
  if (withReferences) {
    fake.input.set(
      "NOTES.md",
      encoder.encode("# Preserved notes\n\nAll text sidecars survive with their exact bytes.  \n"),
    )
    fake.input.set(
      "references/guide.md",
      encoder.encode("# Guide\r\n\r\nKeep original reference bytes.  \r\n\r\n"),
    )
    fake.input.set("references/policy.md", encoder.encode("# Policy\n\n原始规则必须保留。\n"))
  }
  let oldId: string, portable: PortableSkill
  if (legacyDescription) {
    const files = [...fake.input].map(([path, bytes]) => ({ path, bytes: bytes.slice() }))
    const document = importDocument(files.find((file) => file.path === "SKILL.md")!)
    portable = {
      kind: "skill",
      name: document.name,
      description: document.description,
      main: "SKILL.md",
      files,
    }
    expect(portable.description).toBe("Use for recovery.\n保留内部换行和末尾的一个 LF。\n")
    oldId = `p_${"d".repeat(64)}`
    const hashes = [...files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((file) => [
        file.path,
        file.bytes.length,
        createHash("sha256").update(file.bytes).digest("hex"),
      ])
    const legacyHash = createHash("sha256")
      .update(
        canonical([
          portable.kind,
          portable.name,
          portable.description.slice(0, -1),
          portable.main,
          hashes,
        ]),
      )
      .digest("hex")
    fake.seedLegacySource(portable, {
      version: 2,
      state: "writing",
      operation_id: oldId,
      intended_hash: legacyHash,
    })
    expect(fake.writeLog).toEqual([])
    expect(fake.retainedOldState().filter(([key]) => key.startsWith("publications/"))).toEqual([])
  } else {
    const original = await fake.run(
      createSkill("/input", {
        database,
        onProgress: (progress) =>
          Effect.sync(() => {
            if (progress.stage === "body:SKILL.md" && progress.status === "started")
              fake.interruptRootBodyCheckpoint()
          }),
      }).pipe(Effect.result),
    )
    expect(original._tag).toBe("Failure")
    if (original._tag !== "Failure")
      throw new Error("The original publication must really fail after its root body ACK")
    oldId = String(property(original.failure.details).operation_id)
    const oldReceipt = fake.receipt(oldId)
    const originalEffects = oldReceipt.intents.filter((intent) => intent.status === "completed")
    expect(
      originalEffects.some((intent) => intent.path === "v1/pages" && intent.method === "POST"),
    ).toBe(true)
    expect(
      originalEffects
        .filter((intent) => intent.path.endsWith("/markdown") && intent.method === "PATCH")
        .map((intent) => intent.path)
        .sort(),
    ).toEqual(
      [root, ...fake.children.map((child) => child.id)]
        .map((id) => `v1/pages/${id}/markdown`)
        .sort(),
    )
    expect(originalEffects.at(-1)?.path).toBe(`v1/pages/${root}/markdown`)
    expect(oldReceipt.intents.every((intent) => intent.status === "completed")).toBe(true)
    expect(fake.rootBodyCheckpoint()).toEqual({ acknowledged: true, readbacks: 2 })
    portable = fake.portableFor(oldId)
  }
  expect(fake.uploadCounts()).toEqual({ allocations: 0, sends: 0 })
  expect(property(property(fake.rootPage().properties).Files).files).toEqual([])
  expect(publicationMarker(fake.rootPage())?.state).toBe("writing")
  const machine = fake.forkMachine()
  const plan = await machine.run(
    Effect.gen(function* () {
      const current = yield* getSubscription(subscriptionId, upstreamDatabase)
      const frozen = yield* freezePortable(portable)
      const scope = yield* authScope
      const pending = strictDecode(UpstreamPlanSchema, {
        version: 1,
        plan_id: "pending",
        plan_hash: "pending",
        created_at: 1,
        subscription_id: subscriptionId,
        subscription_version: current.version,
        scope,
        database_id: upstreamDatabase,
        config_hash: yield* subscriptionConfigHash(current),
        revision: "original-upstream",
        provenance: {},
        source_manifest: {
          version: 1,
          source_id: subscriptionId,
          revision: "original-upstream",
          members: [
            {
              member_key: memberKey,
              source_path: memberKey,
              main: portable.main,
              resources: frozen.files.map((file) => ({ path: file.path, sha256: file.hash })),
            },
          ],
        },
        publisher_subscription_id: subscriptionId,
        target_database_id: database,
        items: [
          {
            member_key: memberKey,
            target_key: targetKey(current, memberKey),
            action: "create",
            reason: "source-added",
            generation: 0,
            content_hash: yield* portableIdentity(portable),
            upstream_hash: yield* portableIdentity(portable),
            candidate: frozen,
            accepted: frozen,
            deltas: contentDeltas(undefined, frozen),
          },
        ],
      })
      const { plan_id: _id, plan_hash: _hash, ...body } = pending
      const hash = yield* sha256(JSON.stringify(body))
      const plan = { ...body, plan_id: `up_${hash}`, plan_hash: hash }
      yield* machine.repository.savePlan(plan)
      return plan
    }),
  )
  // Seed only a frozen original plan; the real apply creates CREATE_CONFLICT and its unsent ledger.
  const failed = await machine.run(applyUpstream(plan.plan_id))
  expect(failed.items[0]?.status).toBe("unknown")
  expect(failed.items[0]?.error_code).toBe("CREATE_CONFLICT")
  const originalId = await machine.run(
    sha256(`${failed.operation_id}:0`).pipe(Effect.map((hash) => `p_${hash}`)),
  )
  expect(machine.persisted.has(`publications/${originalId}.json`)).toBe(false)
  const originalIntegrity = await machine.run(machine.store.integrity.inspect(originalId))
  expect(originalIntegrity?.page_id).toBeUndefined()
  expect(originalIntegrity?.marker.state).toBe("writing")
  expect(await machine.run(machine.store.integrity.inspect(oldId))).toBeUndefined()
  const oldHistory = fake.retainedOldState()
  const input = {
    original_plan_id: plan.plan_id,
    member_key: memberKey,
    page_id: root,
    old_operation_id: oldId,
    install_source_bundle: true,
    ...(legacyDescription ? { descriptor_migration: DescriptionFinalLfMigration } : {}),
  } satisfies ContentAdoptionInput
  return { fake, machine, plan, portable, originalId, originalIntegrity, oldId, oldHistory, input }
}

async function assertCompleted(
  context: Awaited<ReturnType<typeof originalSourceMissing>>,
  adoptionId: string,
) {
  const { fake, machine, plan, portable, originalId, originalIntegrity, oldHistory, oldId } =
    context
  const expectedContentHash = plan.items[0]?.content_hash
  if (typeof expectedContentHash !== "string")
    throw new Error("The original frozen member must retain its content hash")
  const receipt = await machine.run(
    machine.store.readJson(`publications/${adoptionId}.json`, PublicationReceiptSchema),
  )
  expect(receipt?.state).toBe("completed")
  const currentRoot = fake.rootPage()
  expect(property(property(currentRoot.properties).Updated).last_edited_time).toBe(
    currentRoot.last_edited_time,
  )
  expect(property(property(currentRoot.properties).Updated).id).toBe("updated")
  expect(property(property(currentRoot.properties).Updated).type).toBe("last_edited_time")
  expect(receipt?.operation).toBe("replace")
  expect(receipt?.conflict).toBeUndefined()
  expect(receipt?.intents.filter((intent) => intent.status === "completed")).toHaveLength(6)
  expect(receipt?.intents.filter((intent) => intent.path === "v1/file_uploads")).toHaveLength(1)
  expect(receipt?.intents.filter((intent) => intent.path.endsWith("/send"))).toHaveLength(1)
  const properties =
    receipt?.intents.filter(
      (intent) => intent.status === "completed" && intent.path === `v1/pages/${root}`,
    ) ?? []
  expect(properties).toHaveLength(4)
  expect(
    properties.every(
      (intent) =>
        intent.method === "PATCH" && Object.keys(property(intent.body)).join() === "properties",
    ),
  ).toBe(true)
  expect(
    properties.filter((intent) =>
      Object.hasOwn(property(property(intent.body).properties), "files"),
    ),
  ).toHaveLength(1)
  expect(
    receipt?.intents.some(
      (intent) => intent.path.endsWith("/markdown") || intent.path === "v1/pages",
    ),
  ).toBe(false)
  expect(fake.downloadCount()).toBeGreaterThan(0)
  expect(fake.ownershipDownloads.length).toBeGreaterThan(0)
  expect(fake.ownershipDownloads.every((count) => count > 0)).toBe(true)
  expect(fake.uploadCounts()).toEqual({ allocations: 1, sends: 1 })
  expect(publicationMarker(fake.rootPage())?.state).toBe("committed")
  expect(publicationMarker(fake.rootPage())?.creation?.operation_id).toBe(
    context.input.descriptor_migration ? undefined : oldId,
  )
  expect(fake.retainedOldState()).toEqual(oldHistory)
  expect(machine.persisted.has(`publications/${originalId}.json`)).toBe(false)
  expect(await machine.run(machine.store.integrity.inspect(originalId))).toEqual(originalIntegrity)
  const parent = await machine.run(machine.repository.operation(plan.plan_id))
  expect(parent?.items[0]?.publication_operation_id).toBe(adoptionId)
  expect(parent?.items[0]?.page_id).toBe(root)
  expect(parent?.items[0]?.status).toBe("unknown")
  // Current committed files are readable while the original parent/map remain unresolved.
  const beforeMap = await machine.run(getSubscription(subscriptionId, upstreamDatabase))
  expect(beforeMap.published?.members.some((member) => member.page_id === root)).toBe(false)
  const writesBeforeRead = fake.mutations()
  const independent = await machine.run(openSkill(root, { database, refresh: true }))
  const independentSource = await machine.run(snapshotAuthoredPortable(independent))
  expect(await machine.run(portableIdentity(independentSource))).toBe(
    await machine.run(portableIdentity(portable)),
  )
  expectSameSourceFiles(independentSource, portable)
  expect(fake.mutations()).toBe(writesBeforeRead)
  expect(await machine.run(machine.repository.operation(plan.plan_id))).toEqual(parent)
  expect(await machine.run(getSubscription(subscriptionId, upstreamDatabase))).toEqual(beforeMap)
  expect(
    await machine.run(
      machine.store.readJson(`publications/${adoptionId}.json`, PublicationReceiptSchema),
    ),
  ).toEqual(receipt)
  // This is the same committed source read used by the native publisher's
  // verified() path; it still verifies the marker and all source content.
  const committed = await machine.run(
    openSkill(root, { database, refresh: true }).pipe(
      Effect.provideService(PublicationReadOperation, adoptionId),
      Effect.flatMap(snapshotAuthoredPortable),
    ),
  )
  expect(publicationMarker(fake.rootPage())?.operation_id).toBe(adoptionId)
  expect(await machine.run(portableIdentity(committed))).toBe(
    await machine.run(portableIdentity(portable)),
  )
  expectSameSourceFiles(committed, portable)
  const final = await machine.run(applyUpstream(plan.plan_id))
  expect(final.state).toBe("verified")
  expect(final.items[0]?.publication_operation_id).toBe(adoptionId)
  const bindings = await machine.run(machine.repository.bindings(subscriptionId))
  expect(bindings).toHaveLength(1)
  expect(bindings[0]?.generation).toBe(1)
  expect(bindings[0]?.page_id).toBe(root)
  const published = await machine.run(getSubscription(subscriptionId, upstreamDatabase))
  expect(published.status).toBe("verified")
  expect(published.published?.plan_hash).toBe(plan.plan_hash)
  expect(published.published?.members).toEqual([
    {
      member_key: memberKey,
      page_id: root,
      content_hash: expectedContentHash,
      revision: plan.revision,
    },
  ])
  const publicSnapshot = await machine.run(openSkill(root, { database, refresh: true }))
  expect(publicSnapshot.source_projection).toBeDefined()
  expect(publicSnapshot.source_files).toBeDefined()
  // Match the official export --projection source contract. The materialized
  // read view can include its source ZIP and projected links; authored export
  // must still recover every original path and byte from the verified page.
  const exported = await machine.run(snapshotAuthoredPortable(publicSnapshot))
  expect(await machine.run(portableIdentity(exported))).toBe(
    await machine.run(portableIdentity(portable)),
  )
  expectSameSourceFiles(exported, portable)
  const independentHistory = await machine.run(loadSnapshot(independent.snapshot_id))
  expect(independentHistory.files).toEqual(independent.files)
  expect(independentHistory.source_projection).toEqual(independent.source_projection)
  expectSameSourceFiles(
    await machine.run(snapshotAuthoredPortable(independentHistory)),
    independentSource,
  )
  expect(await machine.run(machine.repository.plan(plan.plan_id))).toEqual(plan)
  expect(await machine.run(machine.store.integrity.inspect(originalId))).toEqual(originalIntegrity)
  expect(fake.retainedOldState()).toEqual(oldHistory)
}

async function sourceReceipt(
  context: Awaited<ReturnType<typeof originalSourceMissing>>,
  id: string,
) {
  const value = await context.machine.run(
    context.machine.store.readJson(`publications/${id}.json`, PublicationReceiptSchema),
  )
  if (!value) throw new Error("Expected the real native source-installation receipt")
  return value
}
async function assertOriginalRetained(context: Awaited<ReturnType<typeof originalSourceMissing>>) {
  expect(context.fake.retainedOldState()).toEqual(context.oldHistory)
  expect(await context.machine.run(context.machine.repository.plan(context.plan.plan_id))).toEqual(
    context.plan,
  )
  expect(
    await context.machine.run(context.machine.store.integrity.inspect(context.originalId)),
  ).toEqual(context.originalIntegrity)
  expect(context.machine.persisted.has(`publications/${context.originalId}.json`)).toBe(false)
}
async function plannedSource(withReferences = false) {
  const context = await originalSourceMissing(withReferences)
  const planned = await context.machine.run(planContentAdoption(context.input))
  return { ...context, planned }
}
function expectFailure(
  result: { readonly _tag: string; readonly failure?: unknown },
  code?: string,
) {
  expect(result._tag).toBe("Failure")
  if (result._tag !== "Failure") throw new Error("Expected a real bounded failure")
  if (code) expect(property(result.failure).code).toBe(code)
}

test("Description final LF migration keeps the old hash and all source bytes while its first CA PATCH restores both exact values", async () => {
  const context = await originalSourceMissing(true, true),
    { fake, machine, input, portable } = context
  const oldMarker = publicationMarker(fake.rootPage()),
    oldRaw = structuredClone(fake.rootPage())
  if (!oldMarker || oldMarker.state !== "writing")
    throw new Error("Expected the exact original writing marker")
  const { descriptor_migration: _migration, ...ordinary } = input
  expectFailure(
    await machine.run(planContentAdoption(ordinary).pipe(Effect.result)),
    "CONTENT_ADOPTION_REFUSED",
  )
  const writes = fake.writeLog.length,
    children = structuredClone(fake.children)
  const planned = await machine.run(planContentAdoption(input))
  const saved = decode(
    ContentAdoptionAttemptSchema,
    await machine.run(machine.store.upstream.command(contentAdoptionPlanKey(planned.plan_id))),
  )
  expect(saved.plan.old_marker).toEqual(oldMarker)
  expect(saved.plan.evidence.raw[`v1/pages/${root}`]).toEqual(oldRaw)
  expect(saved.plan.descriptor_migration).toEqual({
    version: 1,
    kind: DescriptionFinalLfMigration,
    property_id: "description",
    source_description: portable.description,
    legacy_description: portable.description.slice(0, -1),
    source_intended_hash: context.originalIntegrity!.intended_hash,
    legacy_intended_hash: oldMarker.intended_hash,
  })
  expect(saved.plan.frozen.description).toBe(portable.description)
  expect(saved.plan.intended_hash).toBe(context.originalIntegrity!.intended_hash)
  expect(saved.plan.intended_hash).not.toBe(oldMarker.intended_hash)
  const archive = await machine.run(
    machine.store.readBytes(`objects/${saved.plan.source_installation!.sha256}`),
  )
  const authored = readPortable(readImportZip(archive))!
  expect(authored.description).toBe(portable.description)
  expect(authored.projection?.description).toBe(portable.description)
  expectSameSourceFiles(authored, portable)
  expect(fake.writeLog).toHaveLength(writes)
  expectFailure(
    await machine.run(planContentAdoption(ordinary).pipe(Effect.result)),
    "CONTENT_ADOPTION_REFUSED",
  )
  const applied = await machine.run(applyContentAdoption(planned.plan_id, planned.plan_hash))
  expect(applied.state).toBe("linked")
  const receipt = await sourceReceipt(context, planned.publication_operation_id)
  expect(receipt.intents).toHaveLength(6)
  expect(receipt.intents[0]?.body).toEqual(contentAdoptionHandoffBody(saved.plan))
  expect(Object.keys(property(property(receipt.intents[0]?.body).properties)).sort()).toEqual([
    "Publication",
    "description",
  ])
  expect(receipt.portable.description).toBe(portable.description)
  expect(
    (await machine.run(machine.store.integrity.inspect(receipt.operation_id)))?.intended_hash,
  ).toBe(saved.plan.intended_hash)
  expect(property(property(fake.rootPage().properties).Description).rich_text).toEqual([
    {
      type: "text",
      text: { content: portable.description, link: null },
      plain_text: portable.description,
      href: null,
      annotations: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: "default",
      },
    },
  ])
  expect(fake.children).toEqual(children)
  expect(
    contentAdoptionJournal(receipt, saved.plan, publicationMarker(fake.rootPage()))?.completed,
  ).toBe(6)
  const split = structuredClone(receipt)
  split.intents[0] = {
    ...split.intents[0]!,
    body: {
      properties: {
        Publication: property(property(receipt.intents[0]?.body).properties).Publication,
      },
    },
  }
  expect(
    contentAdoptionJournal(split, saved.plan, publicationMarker(fake.rootPage())),
  ).toBeUndefined()
  await assertCompleted(context, planned.publication_operation_id)
  await assertOriginalRetained(context)
}, 120000)

for (const outcome of ["before", "after"] as const)
  test(`Description final LF migration resolves its original unknown ${outcome} handoff by the complete marker/Description pair`, async () => {
    const context = await originalSourceMissing(false, true),
      { fake, machine, portable } = context
    const planned = await machine.run(planContentAdoption(context.input))
    fake.propertyFault("handoff", outcome)
    expectFailure(
      await machine.run(
        applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result),
      ),
    )
    const before = await sourceReceipt(context, planned.publication_operation_id)
    expect(before.intents).toHaveLength(1)
    expect(before.intents[0]?.status).toBe("unknown")
    expect(before.intents[0]?.response).toBeUndefined()
    expect(fake.uploadCounts()).toEqual({ allocations: 0, sends: 0 })
    const writes = fake.writeLog.length
    expect(
      (await machine.run(reconcilePublication(planned.publication_operation_id))).outcome,
    ).toBe("needs_safe_resume")
    expect(fake.writeLog).toHaveLength(writes)
    await machine.run(resumePublication(planned.publication_operation_id))
    const after = await sourceReceipt(context, planned.publication_operation_id)
    expect(after.intents[0]?.status).toBe(outcome === "before" ? "failed" : "completed")
    expect(property(after.intents[0]?.response).recovery).toBe(
      outcome === "before" ? "known_not_applied" : "observed_applied",
    )
    expect(property(after.intents[0]?.response).prior_status).toBe("unknown")
    if (outcome === "before") expect(after.intents[1]?.body).toEqual(before.intents[0]?.body)
    expect(
      fake.propertyWrites.filter((fields) => Object.hasOwn(fields, "description")),
    ).toHaveLength(outcome === "before" ? 2 : 1)
    expect(after.portable.description).toBe(portable.description)
    await assertCompleted(context, planned.publication_operation_id)
    await assertOriginalRetained(context)
  }, 120000)

for (const partial of ["marker-only", "description-only"] as const)
  test(`Description final LF migration refuses ${partial} after an unknown first PATCH without acknowledging or replaying it`, async () => {
    const context = await originalSourceMissing(false, true),
      { fake, machine, portable } = context
    const planned = await machine.run(planContentAdoption(context.input))
    const saved = decode(
      ContentAdoptionAttemptSchema,
      await machine.run(machine.store.upstream.command(contentAdoptionPlanKey(planned.plan_id))),
    )
    fake.propertyFault("handoff", "before")
    expectFailure(
      await machine.run(
        applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result),
      ),
    )
    const before = await sourceReceipt(context, planned.publication_operation_id)
    if (partial === "marker-only") fake.setPublication(contentAdoptionWriting(saved.plan))
    else fake.setDescription(portable.description)
    const writes = fake.writeLog.length
    expect(
      (await machine.run(reconcilePublication(planned.publication_operation_id))).outcome,
    ).toBe("conflict")
    expectFailure(
      await machine.run(resumePublication(planned.publication_operation_id).pipe(Effect.result)),
      "WRITE_CONFLICT",
    )
    expect((await sourceReceipt(context, planned.publication_operation_id)).intents).toEqual(
      before.intents,
    )
    expect(fake.writeLog).toHaveLength(writes)
    expect(fake.uploadCounts()).toEqual({ allocations: 0, sends: 0 })
    await assertOriginalRetained(context)
  }, 120000)

test("Description final LF migration rederives every retained proof field and refuses other original metadata or source drift", async () => {
  const context = await originalSourceMissing(false, true),
    { fake, machine, portable } = context
  const writes = fake.writeLog.length
  fake.setName("Other Name")
  expectFailure(
    await machine.run(planContentAdoption(context.input).pipe(Effect.result)),
    "CONTENT_ADOPTION_REFUSED",
  )
  fake.setName(portable.name)
  const planned = await machine.run(planContentAdoption(context.input))
  const saved = decode(
    ContentAdoptionAttemptSchema,
    await machine.run(machine.store.upstream.command(contentAdoptionPlanKey(planned.plan_id))),
  )
  if (!saved.plan.descriptor_migration) throw new Error("Expected the explicit migration authority")
  for (const change of [
    "source_description",
    "legacy_description",
    "source_intended_hash",
    "legacy_intended_hash",
    "property_id",
  ] as const) {
    const changed = {
      ...saved.plan,
      descriptor_migration: { ...saved.plan.descriptor_migration, [change]: "changed" },
    }
    expectFailure(
      await machine.run(
        readContentAdoptionOriginalInput(context.input, changed).pipe(Effect.result),
      ),
      "CONTENT_ADOPTION_REFUSED",
    )
  }
  fake.overrideDescription((field) => ({ ...field, id: "recreated-description" }))
  expectFailure(
    await machine.run(applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result)),
    "CONTENT_ADOPTION_REFUSED",
  )
  fake.setDescription(portable.description.slice(0, -1))
  fake.changeRootBody()
  expectFailure(
    await machine.run(applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result)),
    "CONTENT_ADOPTION_REFUSED",
  )
  fake.changeRootBody(false)
  machine.corruptBytes(`objects/${saved.plan.frozen.files[0]!.hash}`)
  expectFailure(
    await machine.run(applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result)),
  )
  expect(fake.writeLog).toHaveLength(writes)
  expect(machine.persisted.has(`publications/${planned.publication_operation_id}.json`)).toBe(false)
  expect(
    await machine.run(machine.store.upstream.command(contentAdoptionPlanKey(planned.plan_id))),
  ).toEqual(saved)
  await assertOriginalRetained(context)
}, 120000)

test("Description final LF migration still refuses unrequested metadata after the exact combined handoff", async () => {
  const context = await originalSourceMissing(false, true),
    { fake, machine } = context
  const planned = await machine.run(planContentAdoption(context.input))
  fake.propertyFault("handoff", "after")
  expectFailure(
    await machine.run(applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result)),
  )
  const before = await sourceReceipt(context, planned.publication_operation_id),
    writes = fake.writeLog.length
  fake.changeEditor()
  expect((await machine.run(reconcilePublication(planned.publication_operation_id))).outcome).toBe(
    "conflict",
  )
  expect((await sourceReceipt(context, planned.publication_operation_id)).intents).toEqual(
    before.intents,
  )
  expect(fake.writeLog).toHaveLength(writes)
  expect(fake.uploadCounts()).toEqual({ allocations: 0, sends: 0 })
  await assertOriginalRetained(context)
}, 120000)

// The first test independently establishes the missing-byte state; a body match
// alone cannot enter the existing no-content-write adoption path.
test("missing source is explicitly unverified until six real same-page effects, independent download and complete authored export", async () => {
  const context = await originalSourceMissing(),
    { machine, fake, input } = context
  const { install_source_bundle: _mode, ...ordinary } = input
  const strict = await machine.run(planContentAdoption(ordinary).pipe(Effect.result))
  expectFailure(strict, "CONTENT_ADOPTION_REFUSED")
  expect(fake.uploadCounts()).toEqual({ allocations: 0, sends: 0 })
  const writes = fake.writeLog.length
  const planned = await machine.run(planContentAdoption(input))
  expect(planned.complete_file_count).toBe(0)
  expect(planned.source_installation?.state).toBe("pending")
  expect(planned.source_installation?.independently_verified).toBe(false)
  expect(planned.source_installation?.frozen_file_count).toBe(context.portable.files.length)
  expect(fake.writeLog).toHaveLength(writes)
  const saved = await machine.run(
    machine.store.upstream.command(contentAdoptionPlanKey(planned.plan_id)),
  )
  const attempt = decode(ContentAdoptionAttemptSchema, saved)
  expect(attempt.plan.evidence.source_proof).toBe("not_installed")
  expect(attempt.plan.evidence.files).toEqual([])
  expect(attempt.plan.evidence.attachments).toEqual([])
  expect(attempt.plan.evidence.page_ids).toEqual([root])
  const artifact = attempt.plan.source_installation!
  const frozenArchive = await machine.run(machine.store.readBytes(`objects/${artifact.sha256}`))
  expect(createHash("sha256").update(frozenArchive).digest("hex")).toBe(artifact.sha256)
  expect(frozenArchive.length).toBe(artifact.byte_length)
  expectSameSourceFiles(readPortable(readImportZip(frozenArchive))!, context.portable)
  const changedMode = await machine.run(planContentAdoption(ordinary).pipe(Effect.result))
  expectFailure(changedMode, "CONTENT_ADOPTION_REFUSED")
  const applied = await machine.run(applyContentAdoption(planned.plan_id, planned.plan_hash))
  expect(applied.state).toBe("linked")
  expect(applied.complete_file_count).toBe(context.portable.files.length)
  expect(applied.source_installation?.independently_verified).toBe(true)
  expect(applied.publication_operation_id).toBe(planned.publication_operation_id)
  const receipt = await sourceReceipt(context, planned.publication_operation_id)
  expect(receipt.intents).toHaveLength(6)
  expect(receipt.intents.every((intent) => intent.status === "completed")).toBe(true)
  expect(receipt.intents.map((intent) => intent.path)).toEqual([
    `v1/pages/${root}`,
    "v1/file_uploads",
    "v1/file_uploads/upload-1/send",
    `v1/pages/${root}`,
    `v1/pages/${root}`,
    `v1/pages/${root}`,
  ])
  expect(receipt.intents[1]?.artifact).toEqual({
    suboperation_id: `${receipt.operation_id}:upload:1`,
    filename: artifact.filename,
    sha256: artifact.sha256,
    byte_length: artifact.byte_length,
  })
  const received = property(property(fake.rootPage().properties).Files).files
  expect(Array.isArray(received) ? received.length : -1).toBe(1)
  const newWrites = fake.writeLog.slice(writes)
  expect(newWrites).toHaveLength(6)
  expect(
    newWrites.some((write) => write.path === "v1/pages" || write.path.endsWith("/markdown")),
  ).toBe(false)
  expect(fake.ownershipDownloads.every((count) => count > 0)).toBe(true)
  await assertCompleted(context, planned.publication_operation_id)
  const finalWrites = fake.writeLog.length,
    before = await sourceReceipt(context, planned.publication_operation_id)
  expect(
    (await machine.run(applyContentAdoption(planned.plan_id, planned.plan_hash))).verified,
  ).toBe(true)
  expect(
    property(
      property(await machine.run(resumePublication(planned.publication_operation_id))).adoption,
    ).verified,
  ).toBe(true)
  expect(fake.writeLog).toHaveLength(finalWrites)
  expect((await sourceReceipt(context, planned.publication_operation_id)).intents).toEqual(
    before.intents,
  )
  await assertOriginalRetained(context)
}, 120000)

test("multi-reference source installation retains every original page, its guards and every authored file", async () => {
  const context = await plannedSource(true),
    { machine, fake, planned } = context
  const attempt = decode(
    ContentAdoptionAttemptSchema,
    await machine.run(machine.store.upstream.command(contentAdoptionPlanKey(planned.plan_id))),
  )
  const pages = [root, ...fake.children.map((child) => child.id)].sort()
  const children = structuredClone(fake.children),
    writes = fake.writeLog.length
  const referencePaths = context.portable.files
    .filter((file) => file.path !== context.portable.main && /\.md$/i.test(file.path))
    .map((file) => file.path)
    .sort()
  expect(attempt.plan.evidence.page_ids).toEqual(pages)
  expect(attempt.plan.evidence.source_proof).toBe("not_installed")
  expect(attempt.plan.evidence.files).toEqual([])
  expect(attempt.plan.evidence.attachments).toEqual([])
  expect(planned.reference_page_count).toBe(referencePaths.length)
  expect(planned.source_installation?.frozen_file_count).toBe(context.portable.files.length)
  const archive = await machine.run(
    machine.store.readBytes(`objects/${attempt.plan.source_installation!.sha256}`),
  )
  const source = readPortable(readImportZip(archive))!
  expectSameSourceFiles(source, context.portable)
  expect(Object.keys(source.projection!.references!).sort()).toEqual(referencePaths)
  const applied = await machine.run(applyContentAdoption(planned.plan_id, planned.plan_hash))
  expect(applied.state).toBe("linked")
  expect(applied.complete_file_count).toBe(context.portable.files.length)
  expect(applied.reference_page_count).toBe(referencePaths.length)
  expect(fake.children).toEqual(children)
  const newWrites = fake.writeLog.slice(writes)
  expect(newWrites).toHaveLength(6)
  expect(
    newWrites.every(
      (write) =>
        write.path === `v1/pages/${root}` ||
        write.path === "v1/file_uploads" ||
        write.path === "v1/file_uploads/upload-1/send",
    ),
  ).toBe(true)
  const receipt = await sourceReceipt(context, planned.publication_operation_id)
  for (const id of pages)
    for (const intent of receipt.intents) {
      expect(property(intent.guards?.[`v1/pages/${id}`]).id).toBe(id)
      expect(intent.guards?.[`v1/pages/${id}/markdown`]).toBe(
        property(attempt.plan.evidence.raw[`v1/pages/${id}/markdown`]).markdown,
      )
    }
  const committed = publicationMarker(fake.rootPage())
  expect(contentAdoptionJournal(receipt, attempt.plan, committed)?.completed).toBe(6)
  const childPath = `v1/pages/${children[0]!.id}`
  const missingIntentGuard = structuredClone(receipt)
  const guards = { ...missingIntentGuard.intents[0]!.guards }
  delete guards[childPath]
  missingIntentGuard.intents[0] = { ...missingIntentGuard.intents[0]!, guards }
  expect(contentAdoptionJournal(missingIntentGuard, attempt.plan, committed)).toBeUndefined()
  const missingCurrentGuard = structuredClone(receipt)
  delete missingCurrentGuard.guards[childPath + "/markdown"]
  expect(contentAdoptionJournal(missingCurrentGuard, attempt.plan, committed)).toBeUndefined()
  const changedIntentGuard = structuredClone(receipt)
  changedIntentGuard.intents[0] = {
    ...changedIntentGuard.intents[0]!,
    guards: {
      ...changedIntentGuard.intents[0]!.guards,
      [childPath]: {
        ...property(changedIntentGuard.intents[0]!.guards?.[childPath]),
        last_edited_time: "external",
      },
    },
  }
  expect(contentAdoptionJournal(changedIntentGuard, attempt.plan, committed)).toBeUndefined()
  const subset = {
    ...attempt.plan,
    evidence: { ...attempt.plan.evidence, page_ids: pages.slice(0, -1) },
  }
  expect(contentAdoptionJournal(receipt, subset, committed)).toBeUndefined()
  // The official source export after the original parent apply must retain the
  // CRLF/trailing spaces in reference source, not merely equivalent live bodies.
  await assertCompleted(context, planned.publication_operation_id)
}, 120000)

test("multi-reference source installation refuses changed content, metadata, foreign pages and incomplete References before writes", async () => {
  const context = await plannedSource(true),
    { machine, fake, planned } = context
  const originalChildren = structuredClone(fake.children),
    writes = fake.writeLog.length
  const before = await machine.run(
    machine.store.upstream.command(contentAdoptionPlanKey(planned.plan_id)),
  )
  for (const change of ["body", "metadata", "foreign-page", "incomplete-references"] as const) {
    if (change === "body") fake.children[0]!.body += "\nExternal instruction.\n"
    if (change === "metadata") fake.changeChildRevision()
    if (change === "foreign-page") fake.children[0]!.id = "88888888-8888-4888-8888-888888888888"
    if (change === "incomplete-references") fake.changeReferenceRead("missing_cursor")
    try {
      expectFailure(
        await machine.run(
          applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result),
        ),
        "CONTENT_ADOPTION_REFUSED",
      )
      expect(fake.writeLog).toHaveLength(writes)
      expect(fake.uploadCounts()).toEqual({ allocations: 0, sends: 0 })
      expect(fake.ownershipDownloads).toEqual([])
      expect(machine.persisted.has(`publications/${planned.publication_operation_id}.json`)).toBe(
        false,
      )
      expect(
        await machine.run(machine.store.upstream.command(contentAdoptionPlanKey(planned.plan_id))),
      ).toEqual(before)
    } finally {
      fake.children.splice(0, fake.children.length, ...structuredClone(originalChildren))
      fake.changeChildRevision(false)
      fake.changeReferenceRead()
    }
  }
  await assertOriginalRetained(context)
}, 120000)

test("multi-reference source installation cannot replay an unknown allocation despite its complete page graph", async () => {
  const context = await plannedSource(true),
    { machine, fake, planned } = context
  const children = structuredClone(fake.children)
  fake.uploadFault("allocation", "after")
  expectFailure(
    await machine.run(applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result)),
  )
  const before = await sourceReceipt(context, planned.publication_operation_id)
  expect(before.intents).toHaveLength(2)
  expect(before.intents[0]?.status).toBe("completed")
  expect(before.intents[1]?.status).toBe("unknown")
  expect(before.intents[1]?.response).toBeUndefined()
  for (const id of [root, ...children.map((child) => child.id)])
    expect(typeof before.intents[1]?.guards?.[`v1/pages/${id}/markdown`]).toBe("string")
  const writes = fake.writeLog.length,
    counts = fake.uploadCounts()
  const observed = await machine.run(reconcilePublication(planned.publication_operation_id))
  expect(observed.outcome).toBe("unknown")
  expect(observed.verified).toBe(false)
  expectFailure(
    await machine.run(resumePublication(planned.publication_operation_id).pipe(Effect.result)),
    "PUBLICATION_UPLOAD_RECOVERY_REQUIRED",
  )
  expect(fake.writeLog).toHaveLength(writes)
  expect(fake.uploadCounts()).toEqual(counts)
  expect(fake.children).toEqual(children)
  expect(fake.ownershipDownloads).toEqual([])
  expect((await sourceReceipt(context, planned.publication_operation_id)).intents).toEqual(
    before.intents,
  )
  await assertOriginalRetained(context)
}, 120000)

test("a multi-reference archive ACK cannot grant ownership after one downloaded reference source byte changes", async () => {
  const context = await plannedSource(true),
    { machine, fake, planned } = context
  fake.propertyFault("ownership", "before")
  expectFailure(
    await machine.run(applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result)),
  )
  const before = await sourceReceipt(context, planned.publication_operation_id)
  expect(before.intents).toHaveLength(5)
  expect(before.intents.slice(0, 4).every((intent) => intent.status === "completed")).toBe(true)
  expect(before.intents[4]?.status).toBe("unknown")
  expect(fake.changeAttachedBytes("references/guide.md")).toBe(1)
  const writes = fake.writeLog.length
  const observed = await machine.run(reconcilePublication(planned.publication_operation_id))
  expect(observed.outcome).toBe("conflict")
  expect(observed.verified).toBe(false)
  expectFailure(
    await machine.run(resumePublication(planned.publication_operation_id).pipe(Effect.result)),
    "WRITE_CONFLICT",
  )
  expect(fake.writeLog).toHaveLength(writes)
  expect((await sourceReceipt(context, planned.publication_operation_id)).intents).toEqual(
    before.intents,
  )
  expect(property(property(fake.rootPage().properties).Upstream).relation).toEqual([])
  await assertOriginalRetained(context)
}, 120000)

for (const outcome of ["before", "after"] as const)
  test(`unknown original allocation (${outcome}) retains the single attempt and cannot allocate, discover or attach a replacement`, async () => {
    const context = await plannedSource(),
      { machine, fake, planned } = context
    fake.uploadFault("allocation", outcome)
    expectFailure(
      await machine.run(
        applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result),
      ),
    )
    const before = await sourceReceipt(context, planned.publication_operation_id)
    expect(before.state).toBe("unknown")
    expect(before.intents).toHaveLength(2)
    expect(before.intents[0]?.status).toBe("completed")
    expect(before.intents[1]?.status).toBe("unknown")
    expect(before.intents[1]?.response).toBeUndefined()
    const writes = fake.writeLog.length,
      counts = fake.uploadCounts()
    const observed = await machine.run(reconcilePublication(planned.publication_operation_id))
    expect(observed.outcome).toBe("unknown")
    expect(observed.verified).toBe(false)
    expectFailure(
      await machine.run(resumePublication(planned.publication_operation_id).pipe(Effect.result)),
      "PUBLICATION_UPLOAD_RECOVERY_REQUIRED",
    )
    expect(fake.writeLog).toHaveLength(writes)
    expect(fake.uploadCounts()).toEqual(counts)
    expect(fake.ownershipDownloads).toEqual([])
    expect((await sourceReceipt(context, planned.publication_operation_id)).intents).toEqual(
      before.intents,
    )
    expect(
      fake.readPaths.some(
        (path) => path === "v1/file_uploads" || path.startsWith("v1/file_uploads?"),
      ),
    ).toBe(false)
    // An active native publication already owns this page. A second plan entry
    // must refuse; only the original operation's typed recovery may inspect it.
    const retainedAttempt = await machine.run(
      machine.store.upstream.command(contentAdoptionPlanKey(planned.plan_id)),
    )
    expectFailure(
      await machine.run(planContentAdoption(context.input).pipe(Effect.result)),
      "CONTENT_ADOPTION_REFUSED",
    )
    expect(
      await machine.run(machine.store.upstream.command(contentAdoptionPlanKey(planned.plan_id))),
    ).toEqual(retainedAttempt)
    expect(decode(ContentAdoptionAttemptSchema, retainedAttempt).plan.new_operation_id).toBe(
      planned.publication_operation_id,
    )
    expect((await sourceReceipt(context, planned.publication_operation_id)).intents).toEqual(
      before.intents,
    )
    expect(fake.writeLog).toHaveLength(writes)
    await assertOriginalRetained(context)
  }, 120000)

for (const outcome of ["before", "after"] as const)
  test(`unknown original send (${outcome}) requires its acknowledged upload ID and never resends uncertain bytes`, async () => {
    const context = await plannedSource(),
      { machine, fake, planned } = context
    fake.uploadFault("send", outcome)
    expectFailure(
      await machine.run(
        applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result),
      ),
    )
    const before = await sourceReceipt(context, planned.publication_operation_id)
    expect(before.intents).toHaveLength(3)
    expect(before.intents[1]?.status).toBe("completed")
    expect(property(before.intents[1]?.response).id).toBe("upload-1")
    expect(before.intents[2]?.status).toBe("unknown")
    expect(before.intents[2]?.response).toBeUndefined()
    expect(fake.uploadCounts()).toEqual({ allocations: 1, sends: 1 })
    const writes = fake.writeLog.length
    const observed = await machine.run(reconcilePublication(planned.publication_operation_id))
    expect(observed.verified).toBe(false)
    if (outcome === "before") {
      expect(observed.outcome).toBe("unknown")
      expectFailure(
        await machine.run(resumePublication(planned.publication_operation_id).pipe(Effect.result)),
        "PUBLICATION_UPLOAD_RECOVERY_REQUIRED",
      )
      expect(fake.writeLog).toHaveLength(writes)
      expect((await sourceReceipt(context, planned.publication_operation_id)).intents).toEqual(
        before.intents,
      )
      expect(fake.ownershipDownloads).toEqual([])
    } else {
      expect(observed.outcome).toBe("needs_safe_resume")
      const settled = await sourceReceipt(context, planned.publication_operation_id)
      expect(settled.intents[2]?.response).toEqual({
        id: "upload-1",
        status: "uploaded",
        prior_status: "unknown",
        recovery: "observed_uploaded",
      })
      expect(settled.intents[0]).toEqual(before.intents[0])
      expect(settled.intents[1]).toEqual(before.intents[1])
      const resumed = await machine.run(resumePublication(planned.publication_operation_id))
      if (!("verified" in resumed))
        throw new Error("The source continuation must return its native verified result")
      expect(resumed.verified).toBe(true)
      await assertCompleted(context, planned.publication_operation_id)
    }
    expect(fake.uploadCounts()).toEqual({ allocations: 1, sends: 1 })
    await assertOriginalRetained(context)
  }, 120000)

for (const effect of ["attachment", "ownership", "commit"] as const)
  for (const outcome of ["before", "after"] as const)
    test(`source installation ${effect} ${outcome} failure continues the exact original effect after full source proof`, async () => {
      const context = await plannedSource(),
        { machine, fake, planned } = context
      fake.propertyFault(effect, outcome)
      expectFailure(
        await machine.run(
          applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result),
        ),
      )
      const before = await sourceReceipt(context, planned.publication_operation_id)
      const pending = before.intents.at(-1)!,
        originalCount = before.intents.length
      expect(pending.status).toBe("unknown")
      expect(pending.response).toBeUndefined()
      expect(pending.path).toBe(`v1/pages/${root}`)
      expect(fake.uploadCounts()).toEqual({ allocations: 1, sends: 1 })
      const reconciled = await machine.run(reconcilePublication(planned.publication_operation_id))
      expect(reconciled.outcome).toBe(
        effect === "commit" && outcome === "after" ? "success" : "needs_safe_resume",
      )
      const resumed = await machine.run(resumePublication(planned.publication_operation_id))
      if (!("verified" in resumed))
        throw new Error("The source continuation must return its native verified result")
      expect(resumed.verified).toBe(true)
      const after = await sourceReceipt(context, planned.publication_operation_id)
      expect(after.intents.slice(0, originalCount - 1)).toEqual(
        before.intents.slice(0, originalCount - 1),
      )
      expect(after.intents[originalCount - 1]?.status).toBe(
        outcome === "before" ? "failed" : "completed",
      )
      expect(property(after.intents[originalCount - 1]?.response).prior_status).toBe("unknown")
      expect(property(after.intents[originalCount - 1]?.response).recovery).toBe(
        outcome === "before" ? "known_not_applied" : "observed_applied",
      )
      if (outcome === "before") {
        expect(property(after.intents[originalCount - 1]?.response).replayed_by_intent).toBe(
          originalCount,
        )
        expect(after.intents[originalCount]?.body).toEqual(pending.body)
        expect(after.intents[originalCount]?.status).toBe("completed")
      }
      expect(fake.uploadCounts()).toEqual({ allocations: 1, sends: 1 })
      await assertCompleted(context, planned.publication_operation_id)
    }, 120000)

for (const change of [
  "frozen-source",
  "frozen-archive",
  "body",
  "metadata",
  "Files-definition",
] as const)
  test(`source installation refuses ${change} drift before any remote mutation`, async () => {
    const context = await plannedSource(),
      { machine, fake, planned } = context
    const saved = decode(
      ContentAdoptionAttemptSchema,
      await machine.run(machine.store.upstream.command(contentAdoptionPlanKey(planned.plan_id))),
    )
    if (change === "frozen-source")
      machine.corruptBytes(`objects/${saved.plan.frozen.files[0]!.hash}`)
    if (change === "frozen-archive")
      machine.corruptBytes(`objects/${saved.plan.source_installation!.sha256}`)
    if (change === "body") fake.changeRootBody()
    if (change === "metadata") fake.changeDescription()
    if (change === "Files-definition")
      fake.overrideFiles((field) => ({ ...field, id: "recreated-files-field" }))
    const writes = fake.writeLog.length
    expectFailure(
      await machine.run(
        applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result),
      ),
    )
    expect(fake.writeLog).toHaveLength(writes)
    expect(fake.uploadCounts()).toEqual({ allocations: 0, sends: 0 })
    expect(fake.ownershipDownloads).toEqual([])
    await assertOriginalRetained(context)
  }, 120000)

test("a real Files ACK cannot grant ownership when the independently downloaded archive changes one frozen source byte", async () => {
  const context = await plannedSource(),
    { machine, fake, planned } = context
  fake.propertyFault("ownership", "before")
  expectFailure(
    await machine.run(applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result)),
  )
  const before = await sourceReceipt(context, planned.publication_operation_id)
  expect(before.intents).toHaveLength(5)
  expect(before.intents.slice(0, 4).every((intent) => intent.status === "completed")).toBe(true)
  expect(before.intents[4]?.status).toBe("unknown")
  expect(fake.changeAttachedBytes()).toBe(1)
  const writes = fake.writeLog.length
  const observed = await machine.run(reconcilePublication(planned.publication_operation_id))
  expect(observed.outcome).toBe("conflict")
  expect(observed.verified).toBe(false)
  expectFailure(
    await machine.run(resumePublication(planned.publication_operation_id).pipe(Effect.result)),
    "WRITE_CONFLICT",
  )
  expect(fake.writeLog).toHaveLength(writes)
  expect((await sourceReceipt(context, planned.publication_operation_id)).intents).toEqual(
    before.intents,
  )
  expect(property(property(fake.rootPage().properties).Upstream).relation).toEqual([])
  await assertOriginalRetained(context)
}, 120000)

for (const existing of ["resource", "ambiguous-field"] as const)
  test(`source installation refuses an ${existing} before planning and never clears Files`, async () => {
    const context = await originalSourceMissing(),
      { machine, fake } = context
    if (existing === "resource")
      fake.overrideFiles((field) => ({
        ...field,
        files: [
          {
            name: "original.txt",
            type: "external",
            external: { url: "https://example.com/original.txt" },
          },
        ],
      }))
    else fake.overrideFiles((field) => ({ ...field, type: "rich_text", rich_text: [] }))
    const writes = fake.writeLog.length
    expectFailure(
      await machine.run(planContentAdoption(context.input).pipe(Effect.result)),
      "CONTENT_ADOPTION_REFUSED",
    )
    expect(fake.writeLog).toHaveLength(writes)
    expect(fake.uploadCounts()).toEqual({ allocations: 0, sends: 0 })
    await assertOriginalRetained(context)
  }, 120000)

test("a completed source installation links through the original pointer CAS after an interrupted native transaction", async () => {
  const context = await plannedSource(),
    { machine, fake, planned } = context
  machine.losePointerOnce()
  expectFailure(
    await machine.run(applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result)),
    "STORAGE_ERROR",
  )
  const before = await sourceReceipt(context, planned.publication_operation_id)
  expect(before.state).toBe("completed")
  expect(before.intents).toHaveLength(6)
  const writes = fake.writeLog.length
  expect(
    property(
      property(await machine.run(resumePublication(planned.publication_operation_id))).adoption,
    ).verified,
  ).toBe(true)
  expect(fake.writeLog).toHaveLength(writes)
  expect((await sourceReceipt(context, planned.publication_operation_id)).intents).toEqual(
    before.intents,
  )
  await assertCompleted(context, planned.publication_operation_id)
}, 120000)

test("a re-signed download transport failure keeps all four real ACKs recoverable without a conflict fence", async () => {
  const context = await plannedSource(),
    { machine, fake, planned } = context
  fake.failResignedDownload("network")
  expectFailure(
    await machine.run(applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result)),
    "DOWNLOAD_FAILED",
  )
  const before = await sourceReceipt(context, planned.publication_operation_id)
  expect(before.conflict).not.toBe(true)
  expect(before.failure?.code).toBe("DOWNLOAD_FAILED")
  expect(before.intents).toHaveLength(4)
  expect(before.intents.every((intent) => intent.status === "completed")).toBe(true)
  expect(fake.downloadCount()).toBe(5)
  expect(fake.ownershipDownloads).toEqual([])
  const writes = fake.writeLog.length,
    uploads = fake.uploadCounts()
  expect((await machine.run(reconcilePublication(before.operation_id))).outcome).toBe(
    "needs_safe_resume",
  )
  expect(fake.writeLog).toHaveLength(writes)
  expect((await sourceReceipt(context, before.operation_id)).intents).toEqual(before.intents)
  expect(
    property(property(await machine.run(resumePublication(before.operation_id))).adoption).verified,
  ).toBe(true)
  expect(fake.uploadCounts()).toEqual(uploads)
  await assertCompleted(context, before.operation_id)
  await assertOriginalRetained(context)
}, 120000)

test("a former re-signed download fence records complete source proof and retains its actual failure and four ACKs", async () => {
  const context = await plannedSource(),
    { machine, fake, planned } = context
  fake.failResignedDownload("legacy_refusal")
  expectFailure(
    await machine.run(applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result)),
    "WRITE_CONFLICT",
  )
  const before = await sourceReceipt(context, planned.publication_operation_id)
  expect(before.conflict).toBe(true)
  expect(before.intents).toHaveLength(4)
  expect(before.stages).toEqual(["source_bundle"])
  expect(contentAdoptionDownloadFenceCandidate(before)).toBeDefined()
  for (const changed of [
    { ...before, owner: { host: "another-host", pid: 1 } },
    { ...before, stages: [...before.stages, "ownership"] },
    {
      ...before,
      failure: {
        code: "WRITE_CONFLICT",
        message: "Files bytes changed during their metadata bracket.",
      },
    },
    { ...before, intents: before.intents.slice(0, 3) },
    {
      ...before,
      intents: before.intents.map((intent, index) =>
        index === 3 ? { ...intent, status: "unknown" as const } : intent,
      ),
    },
  ])
    expect(contentAdoptionDownloadFenceCandidate(changed)).toBeUndefined()
  const writes = fake.writeLog.length,
    uploads = fake.uploadCounts()
  const reconciled = await machine.run(reconcilePublication(before.operation_id))
  expect(reconciled.outcome).toBe("needs_safe_resume")
  expect(reconciled.verified).toBe(false)
  expect(fake.writeLog).toHaveLength(writes)
  const after = await sourceReceipt(context, before.operation_id)
  expect(after.intents).toEqual(before.intents)
  expect(after.guards).toEqual(before.guards)
  expect(after.failure).toEqual(before.failure)
  expect(after.conflict).toBeUndefined()
  expect(after.conflict_history).toHaveLength(1)
  const history = after.conflict_history![0]!,
    proof = history.content_adoption_download_checkpoint!
  expect(history.failure).toEqual(before.failure)
  expect(history.intent_count).toBe(4)
  expect(proof.original_intent_count).toBe(4)
  expect(proof.root_fresh_sha256).toBe(proof.root_acknowledged_sha256)
  expect(proof.original_journal_sha256).toBe(
    createHash("sha256").update(canonical(before.intents)).digest("hex"),
  )
  const attempt = decode(
    ContentAdoptionAttemptSchema,
    await machine.run(machine.store.upstream.command(contentAdoptionPlanKey(planned.plan_id))),
  )
  expect(proof.archive_sha256).toBe(attempt.plan.source_installation!.sha256)
  expect(proof.archive_bytes).toBe(attempt.plan.source_installation!.byte_length)
  expect(
    property(property(await machine.run(resumePublication(before.operation_id))).adoption).verified,
  ).toBe(true)
  expect(fake.uploadCounts()).toEqual(uploads)
  await assertCompleted(context, before.operation_id)
  await assertOriginalRetained(context)
}, 120000)

for (const change of ["archive-byte", "root-revision"] as const)
  test(`a former re-signed download fence stays closed after ${change} drift`, async () => {
    const context = await plannedSource(),
      { machine, fake, planned } = context
    fake.failResignedDownload("legacy_refusal")
    expectFailure(
      await machine.run(
        applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result),
      ),
      "WRITE_CONFLICT",
    )
    const before = await sourceReceipt(context, planned.publication_operation_id)
    expect(contentAdoptionDownloadFenceCandidate(before)).toBeDefined()
    if (change === "archive-byte") expect(fake.changeAttachedBytes()).toBe(1)
    else fake.externalRootEdit()
    const writes = fake.writeLog.length,
      uploads = fake.uploadCounts()
    const reconciled = await machine.run(reconcilePublication(before.operation_id))
    expect(reconciled.outcome).toBe("conflict")
    expect(reconciled.verified).toBe(false)
    expect(fake.writeLog).toHaveLength(writes)
    expect(fake.uploadCounts()).toEqual(uploads)
    const after = await sourceReceipt(context, before.operation_id)
    expect(after.conflict).toBe(true)
    expect(after.intents).toEqual(before.intents)
    expect(after.guards).toEqual(before.guards)
    expect(after.conflict_history).toEqual(before.conflict_history)
    await assertOriginalRetained(context)
  }, 120000)
