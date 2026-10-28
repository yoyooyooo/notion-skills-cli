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

const database = "44444444-4444-4444-8444-444444444444"
const dataSource = "99999999-9999-4999-8999-999999999999"
const subscriptionId = "77777777-7777-4777-8777-777777777777"
const root = "11111111-1111-4111-8111-111111111111"
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
                annotations: { bold: false, code: false },
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
async function originalConflict(hasFiles = false) {
  const fake = fixture(undefined, hasFiles, undefined, false, true)
  fake.enableOwnership()
  fake.input.clear()
  fake.input.set(
    "SKILL.md",
    canonicalMain(
      "sample-skill",
      "Use for recovery.",
      "# Sample\n\nKeep these exact original instructions.\n",
      {
        path: "SKILL.md",
        bytes: new Uint8Array(),
      },
    ).bytes,
  )
  fake.input.set(
    "references/guide.md",
    encoder.encode("# Guide\n\nKeep this original reference.\n"),
  )
  fake.commitFault("before")
  const original = await fake.run(createSkill("/input", { database }).pipe(Effect.result))
  expect(original._tag).toBe("Failure")
  if (original._tag !== "Failure")
    throw new Error("The original publication must really lose its commit response")
  const oldId = String(property(original.failure.details).operation_id)
  const oldReceipt = fake.receipt(oldId)
  if (oldReceipt.intents.at(-1)?.status !== "unknown")
    throw new Error(
      JSON.stringify({
        original_failure: original.failure,
        last_intent: oldReceipt.intents.at(-1),
      }),
    )
  expect(oldReceipt.intents.at(-1)?.status).toBe("unknown")
  expect(oldReceipt.intents.at(-1)?.response).toBeUndefined()
  expect(publicationMarker(fake.rootPage())?.state).toBe("writing")
  const portable = fake.portableFor(oldId)
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
  }
  return { fake, machine, plan, portable, originalId, originalIntegrity, oldId, oldHistory, input }
}

async function assertCompleted(
  context: Awaited<ReturnType<typeof originalConflict>>,
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
  expect(receipt?.intents.filter((intent) => intent.status === "completed")).toHaveLength(3)
  expect(
    receipt?.intents.every(
      (intent) => intent.path === `v1/pages/${root}` && intent.method === "PATCH",
    ),
  ).toBe(true)
  expect(
    receipt?.intents.every((intent) => Object.keys(property(intent.body)).join() === "properties"),
  ).toBe(true)
  expect(
    receipt?.intents.every(
      (intent) => !Object.hasOwn(property(property(intent.body).properties), "Files"),
    ),
  ).toBe(true)
  expect(publicationMarker(fake.rootPage())?.state).toBe("committed")
  expect(publicationMarker(fake.rootPage())?.creation?.operation_id).toBe(oldId)
  expect(fake.retainedOldState()).toEqual(oldHistory)
  expect(machine.persisted.has(`publications/${originalId}.json`)).toBe(false)
  expect(await machine.run(machine.store.integrity.inspect(originalId))).toEqual(originalIntegrity)
  const parent = await machine.run(machine.repository.operation(plan.plan_id))
  expect(parent?.items[0]?.publication_operation_id).toBe(adoptionId)
  expect(parent?.items[0]?.page_id).toBe(root)
  expect(parent?.items[0]?.status).toBe("unknown")
  // A committed member's own complete content is readable before its parent's
  // active map is published. Reading it does not advance that map or operation.
  const beforeMap = await machine.run(getSubscription(subscriptionId, upstreamDatabase))
  expect(beforeMap.published?.members.some((member) => member.page_id === root)).toBe(false)
  const readMutations = fake.mutations()
  const independent = await machine.run(openSkill(root, { database, refresh: true }))
  const independentSource = await machine.run(snapshotAuthoredPortable(independent))
  expectSameSourceFiles(independentSource, portable)
  expect(fake.mutations()).toBe(readMutations)
  expect((await machine.run(getSubscription(subscriptionId, upstreamDatabase))).published).toEqual(
    beforeMap.published,
  )
  expect((await machine.run(machine.repository.operation(plan.plan_id)))?.items[0]?.status).toBe(
    "unknown",
  )
  // This is the same committed source read used by the native publisher's
  // verified() path; it still verifies the marker and all source content.
  const committed = await machine.run(
    openSkill(root, { database, refresh: true }).pipe(
      Effect.provideService(PublicationReadOperation, adoptionId),
      Effect.flatMap(snapshotPortable),
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
  const independentHistory = await machine.run(loadSnapshot(independent.snapshot_id))
  expect(independentHistory.files).toEqual(independent.files)
  expect(independentHistory.source_projection).toEqual(independent.source_projection)
  expectSameSourceFiles(await machine.run(snapshotAuthoredPortable(independentHistory)), portable)
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
  expect(await machine.run(machine.repository.plan(plan.plan_id))).toEqual(plan)
  expect(await machine.run(machine.store.integrity.inspect(originalId))).toEqual(originalIntegrity)
  expect(fake.retainedOldState()).toEqual(oldHistory)
}

for (const hasFiles of [false, true])
  test(`same-page content adoption preserves all source bytes and original lineage (Files=${hasFiles})`, async () => {
    const context = await originalConflict(hasFiles)
    const { fake, machine, input } = context
    const planned = await machine.run(planContentAdoption(input))
    const bodyWrites = fake.businessPatches(),
      pages = fake.children.map((child) => child.id)
    const counts = fake.uploadCounts()
    const applied = await machine.run(applyContentAdoption(planned.plan_id, planned.plan_hash))
    expect(applied.page_id).toBe(root)
    expect(fake.children.map((child) => child.id)).toEqual(pages)
    // Ownership is the single business property effect; body and file writes do not recur.
    expect(fake.businessPatches() - bodyWrites).toBe(1)
    expect(fake.uploadCounts()).toEqual(counts)
    await assertCompleted(context, planned.publication_operation_id)
  })

for (const effect of ["handoff", "ownership", "commit"] as const)
  for (const outcome of ["before", "after"] as const)
    test(`ordinary resume retains the real ${effect}/${outcome} unknown and completes only missing property effects`, async () => {
      const context = await originalConflict()
      const { fake, machine, input } = context
      const planned = await machine.run(planContentAdoption(input))
      const bodyWrites = fake.businessPatches(),
        uploads = fake.uploadCounts()
      fake.propertyFault(effect, outcome)
      const failed = await machine.run(
        applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result),
      )
      expect(failed._tag).toBe("Failure")
      const retained = await machine.run(
        machine.store.readJson(
          `publications/${planned.publication_operation_id}.json`,
          PublicationReceiptSchema,
        ),
      )
      expect(retained?.intents.at(-1)?.status).toBe("unknown")
      expect(retained?.intents.at(-1)?.response).toBeUndefined()
      const originalIntent = retained?.intents.at(-1)
      const index = (retained?.intents.length ?? 1) - 1
      await machine.run(reconcilePublication(planned.publication_operation_id))
      await machine.run(resumePublication(planned.publication_operation_id))
      const complete = await machine.run(
        machine.store.readJson(
          `publications/${planned.publication_operation_id}.json`,
          PublicationReceiptSchema,
        ),
      )
      expect(complete?.intents[index]?.body).toEqual(originalIntent?.body)
      expect(complete?.intents[index]?.guards).toEqual(originalIntent?.guards)
      expect(complete?.intents[index]?.status).toBe(outcome === "after" ? "completed" : "failed")
      expect(property(complete?.intents[index]?.response).recovery).toBe(
        outcome === "after" ? "observed_applied" : "known_not_applied",
      )
      expect(fake.businessPatches() - bodyWrites).toBe(
        effect === "ownership" && outcome === "before" ? 2 : 1,
      )
      expect(fake.uploadCounts()).toEqual(uploads)
      await assertCompleted(context, planned.publication_operation_id)
    })

test("a completed new publication resumes the original pointer CAS without another remote content or property write", async () => {
  const context = await originalConflict()
  const { fake, machine } = context
  const planned = await machine.run(planContentAdoption(context.input))
  machine.losePointerOnce()
  expect(
    (
      await machine.run(
        applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result),
      )
    )._tag,
  ).toBe("Failure")
  const writes = fake.mutations()
  await machine.run(resumePublication(planned.publication_operation_id))
  expect(fake.mutations()).toBe(writes)
  await assertCompleted(context, planned.publication_operation_id)
})

for (const change of ["body", "creation", "Files", "alias"] as const)
  test(`content-adopt plan rejects original ${change} differences before new journal or mutation`, async () => {
    const context = await originalConflict(change === "Files")
    const { fake, machine } = context
    if (change === "body") fake.changeRootBody()
    if (change === "creation") fake.corruptCreation()
    if (change === "Files") expect(fake.changeAttachedBytes()).toBe(1)
    if (change === "alias") fake.competeAlias()
    const writes = fake.mutations(),
      persisted = structuredClone([...machine.persisted])
    const result = await machine.run(planContentAdoption(context.input).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (change === "Files" && result._tag === "Failure") {
      expect(result.failure.code).toBe("CONTENT_ADOPTION_REFUSED")
      expect(result.failure.message).toBe(
        "The downloaded source bundle differs from the original frozen portable bytes.",
      )
    }
    expect(fake.mutations()).toBe(writes)
    expect([...machine.persisted]).toEqual(persisted)
    expect(fake.retainedOldState()).toEqual(context.oldHistory)
  })

test("an alias created after planning refuses apply while preserving both original operation histories", async () => {
  const context = await originalConflict()
  const planned = await context.machine.run(planContentAdoption(context.input))
  context.fake.competeAlias()
  const writes = context.fake.mutations()
  const result = await context.machine.run(
    applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result),
  )
  expect(result._tag).toBe("Failure")
  expect(context.fake.mutations()).toBe(writes)
  expect(
    context.machine.persisted.has(`publications/${planned.publication_operation_id}.json`),
  ).toBe(false)
  expect(context.fake.retainedOldState()).toEqual(context.oldHistory)
})

for (const changed of ["body", "owner-field-identity"] as const)
  test(`external ${changed} changes after an unknown handoff retain the new fence and both original histories`, async () => {
    const context = await originalConflict()
    const { fake, machine } = context
    const planned = await machine.run(planContentAdoption(context.input))
    fake.propertyFault("handoff", "after")
    expect(
      (
        await machine.run(
          applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result),
        )
      )._tag,
    ).toBe("Failure")
    const before = await machine.run(
      machine.store.readJson(
        `publications/${planned.publication_operation_id}.json`,
        PublicationReceiptSchema,
      ),
    )
    if (changed === "body") fake.changeRootBody()
    else fake.changeOwnerFieldIdentity()
    const writes = fake.mutations()
    expect(
      (await machine.run(reconcilePublication(planned.publication_operation_id))).outcome,
    ).toBe("conflict")
    expect(
      (await machine.run(resumePublication(planned.publication_operation_id).pipe(Effect.result)))
        ._tag,
    ).toBe("Failure")
    const after = await machine.run(
      machine.store.readJson(
        `publications/${planned.publication_operation_id}.json`,
        PublicationReceiptSchema,
      ),
    )
    expect(after?.conflict).toBe(true)
    expect(after?.failure?.code).toBe("CONTENT_ADOPTION_REFUSED")
    expect(after?.intents).toEqual(before?.intents)
    expect(fake.mutations()).toBe(writes)
    expect(fake.retainedOldState()).toEqual(context.oldHistory)
    expect(await machine.run(machine.store.integrity.inspect(context.originalId))).toEqual(
      context.originalIntegrity,
    )
  })

const changedEditedFields: ReadonlyArray<
  readonly [string, (fake: Awaited<ReturnType<typeof originalConflict>>["fake"]) => void]
> = [
  [
    "automatic timestamp no longer equals its root revision",
    (fake) =>
      fake.changeUpdated((field) => ({ ...field, last_edited_time: "2026-10-18T00:00:00.000Z" })),
  ],
  [
    "automatic field identity changed",
    (fake) => fake.changeUpdated((field) => ({ ...field, id: "different-updated-property" })),
  ],
  [
    "automatic field type changed",
    (fake) => fake.changeUpdated((field) => ({ ...field, type: "date" })),
  ],
  [
    "automatic field gained another key",
    (fake) => fake.changeUpdated((field) => ({ ...field, external: true })),
  ],
  [
    "automatic field lost its timestamp",
    (fake) =>
      fake.changeUpdated((field) => {
        const { last_edited_time: _time, ...rest } = field
        return rest
      }),
  ],
  ["a last_edited_by property changed", (fake) => fake.changeEditor()],
]

for (const [name, change] of changedEditedFields)
  test(`root edit-time projection refuses ${name} after a real applied response loss`, async () => {
    const context = await originalConflict()
    const { fake, machine } = context
    const planned = await machine.run(planContentAdoption(context.input))
    fake.propertyFault("handoff", "after")
    const failed = await machine.run(
      applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result),
    )
    expect(failed._tag).toBe("Failure")
    const key = `publications/${planned.publication_operation_id}.json`
    const before = await machine.run(machine.store.readJson(key, PublicationReceiptSchema))
    expect(before?.intents.at(-1)?.status).toBe("unknown")
    expect(before?.intents.at(-1)?.response).toBeUndefined()
    change(fake)
    const writes = fake.mutations()
    expect(
      (await machine.run(reconcilePublication(planned.publication_operation_id))).outcome,
    ).toBe("conflict")
    expect(
      (await machine.run(resumePublication(planned.publication_operation_id).pipe(Effect.result)))
        ._tag,
    ).toBe("Failure")
    const after = await machine.run(machine.store.readJson(key, PublicationReceiptSchema))
    expect(after?.conflict).toBe(true)
    expect(after?.failure?.code).toBe("CONTENT_ADOPTION_REFUSED")
    expect(after?.intents).toEqual(before?.intents)
    expect(fake.mutations()).toBe(writes)
    expect(fake.retainedOldState()).toEqual(context.oldHistory)
    expect(await machine.run(machine.store.integrity.inspect(context.originalId))).toEqual(
      context.originalIntegrity,
    )
  })

test("an automatic timestamp and root revision moving together before any own write still refuse apply", async () => {
  const context = await originalConflict()
  const { fake, machine } = context
  const planned = await machine.run(planContentAdoption(context.input))
  fake.externalRootEdit()
  const writes = fake.mutations()
  const failed = await machine.run(
    applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result),
  )
  expect(failed._tag).toBe("Failure")
  expect(machine.persisted.has(`publications/${planned.publication_operation_id}.json`)).toBe(false)
  expect(fake.mutations()).toBe(writes)
  expect(fake.retainedOldState()).toEqual(context.oldHistory)
  expect(await machine.run(machine.store.integrity.inspect(context.originalId))).toEqual(
    context.originalIntegrity,
  )
})

test("an unapplied pending handoff keeps exact root guards even when both automatic timestamps move together", async () => {
  const context = await originalConflict()
  const { fake, machine } = context
  const planned = await machine.run(planContentAdoption(context.input))
  fake.propertyFault("handoff", "before")
  expect(
    (
      await machine.run(
        applyContentAdoption(planned.plan_id, planned.plan_hash).pipe(Effect.result),
      )
    )._tag,
  ).toBe("Failure")
  const key = `publications/${planned.publication_operation_id}.json`
  const before = await machine.run(machine.store.readJson(key, PublicationReceiptSchema))
  expect(before?.intents.at(-1)?.status).toBe("unknown")
  expect(before?.intents.at(-1)?.response).toBeUndefined()
  fake.externalRootEdit()
  const writes = fake.mutations()
  expect((await machine.run(reconcilePublication(planned.publication_operation_id))).outcome).toBe(
    "conflict",
  )
  expect(
    (await machine.run(resumePublication(planned.publication_operation_id).pipe(Effect.result)))
      ._tag,
  ).toBe("Failure")
  const after = await machine.run(machine.store.readJson(key, PublicationReceiptSchema))
  expect(after?.conflict).toBe(true)
  expect(after?.intents).toEqual(before?.intents)
  expect(fake.mutations()).toBe(writes)
  expect(fake.retainedOldState()).toEqual(context.oldHistory)
  expect(await machine.run(machine.store.integrity.inspect(context.originalId))).toEqual(
    context.originalIntegrity,
  )
})
