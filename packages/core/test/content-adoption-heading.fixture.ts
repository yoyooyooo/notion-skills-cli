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
import { planContentAdoption, applyContentAdoption } from "../src/upstream-content-adoption.ts"
import {
  ContentAdoptionAttemptSchema,
  contentAdoptionPlanKey,
} from "../src/publication-content-adoption-authority.ts"
import { openSkill, readSkill } from "../src/snapshot.ts"
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
import { readImportZip } from "../src/import.ts"
import { withoutCreationMarker } from "../src/publication-create-identity.ts"
import { PublicationReceiptSchema } from "../src/publication-model.ts"
import {
  publicationMarker,
  publicationProperties,
  PublicationReadOperation,
} from "../src/publication-integrity.ts"
import { IntegrityIntentSchema } from "../src/publication-integrity-state.ts"
import { terminalPublicationCommitCandidate } from "../src/publication-terminal-commit.ts"
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

export const database = "44444444-4444-4444-8444-444444444444"
export const dataSource = "99999999-9999-4999-8999-999999999999"
export const subscriptionId = "77777777-7777-4777-8777-777777777777"
export const root = "11111111-1111-4111-8111-111111111111"
const upstreamDatabase = "55555555-5555-4555-8555-555555555555"
const upstreamDataSource = "66666666-6666-4666-8666-666666666666"
const encoder = new TextEncoder()
const bundles = new Map<string, Uint8Array>()
const fixtureFetch: typeof globalThis.fetch = Object.assign(
  async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = new URL(String(input))
    if (url.origin !== "https://content-adoption.example.test")
      throw new Error("Unexpected fixture fetch origin")
    const bytes = bundles.get(url.pathname)
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

export function fixture(
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
                annotations: { bold: false, code: false },
              }
            })
          : [
              {
                type: "text",
                text: { content },
                plain_text: content,
                annotations: { bold: false, code: false },
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
    | { effect: "handoff" | "ownership" | "commit"; outcome: "before" | "after" }
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
    parent: { type: "data_source_id", database_id: database, data_source_id: dataSource },
    properties: properties(),
  })
  const stateRoot = mkdtempSync(join(tmpdir(), "missing-root-inventory-production-"))
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
                : undefined
            const fault = effect === propertyFault?.effect ? propertyFault : undefined
            if (fault) propertyFault = undefined
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
        if (path === "v1/file_uploads") return { id: `upload-${++upload}` }
        if (/^v1\/file_uploads\/[^/]+$/.test(path)) {
          const id = path.split("/")[2]!
          return { id, status: uploads.has(id) ? "uploaded" : "pending" }
        }
        if (path.startsWith("v1/file_uploads/") && path.endsWith("/send")) {
          uploadSends++
          uploads.set(
            path.split("/")[2]!,
            objects.get(options!.file!.slice(`${stateRoot}/`.length))!,
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
    changeRootUrl: () => {
      const before = "https://example.test/original?q=1#anchor"
      if (!main.includes(before)) throw new Error("Expected the retained external destination")
      main = main.replace(before, "https://example.test/external-edit?q=1#anchor")
      if (typedLinkRepair) {
        for (const [id, block] of blocks)
          if (property(block.parent).page_id === root) blocks.delete(id)
        for (const block of bodyBlocks(root, main)) blocks.set(block.id, block)
      }
    },
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
    changeAttachedBytes: () => {
      if (!attachment) throw new Error("Expected an acknowledged source attachment")
      const key = new URL(attachment.file.url).pathname
      const original = bundles.get(key)
      if (!original?.length) throw new Error("Expected retained source archive bytes")
      const source = readPortable(readImportZip(original))
      const main = source?.files.find((file) => file.path === source.main)
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
    propertyFault: (effect: "handoff" | "ownership" | "commit", outcome: "before" | "after") => {
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
      return {
        store: machine,
        persisted: saved,
        repository,
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
