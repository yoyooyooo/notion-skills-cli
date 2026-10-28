import { expect } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Crypto, Effect, FileSystem, Layer, Path } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { SourceLexer as Lexer } from "@notion-skills-cli/markdown"
import type { Tokens } from "marked"
import { authScope } from "../src/catalog.ts"
import { portableIdentity } from "../src/export.ts"
import { markdownRichText, markdownTableCells } from "../src/markdown-blocks.ts"
import { decode, fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import type { PortableSkill } from "../src/portable.ts"
import { canonical } from "../src/publication-effect-proof.ts"
import { publicationMarker } from "../src/publication-integrity.ts"
import type { PublicationMarker } from "../src/publication-integrity-state.ts"
import { Store, sha256 } from "../src/store.ts"
import { applyUpstream } from "../src/upstream-apply.ts"
import {
  contentDeltas,
  freezePortable,
  subscriptionConfigHash,
  targetKey,
} from "../src/upstream-content.ts"
import { strictDecode, UpstreamPlanSchema, UpstreamPublisher } from "../src/upstream-model.ts"
import { UpstreamPublisherLive } from "../src/upstream-publication.ts"
import { UpstreamState } from "../src/upstream-state.ts"
import { getSubscription } from "../src/upstream-subscription.ts"
import { importDocument } from "../src/import.ts"
import type { SourceRootFidelityEffect } from "../src/source-root-fidelity-effect.ts"
import {
  decodeSourceRootFidelity,
  sourceRootFidelityKey,
} from "../src/upstream-source-root-fidelity-model.ts"
import {
  integrityRepositoryFixture,
  upstreamRepositoryFixture,
  publicationSourceRows,
  publicationSourceSchema,
} from "./fixtures.ts"

const id = (value: number) => `11111111-1111-4111-8111-${String(value).padStart(12, "0")}`
const root = id(1),
  referenceOne = id(10),
  referenceTwo = id(11),
  database = id(20),
  dataSource = id(21)
const subscriptionId = id(22),
  upstreamDatabase = id(23),
  upstreamDataSource = id(24)
const oldId = "p_legacy-empty-root-fixture",
  memberKey = "skills/root-completion-fixture"
const name = "root-completion-fixture",
  description = "Use to verify native empty-root completion recovery."
const beforeTime = "2026-10-18T00:00:00.000Z",
  afterTime = "2026-10-18T00:01:00.000Z"
export const fidelitySource =
  "\n# Complete fidelity root\n\n" +
  "| Category | Exact literal |\n|---|---|\n| First | CLS &lt; 0.1 |\n| Second | Text &lt; 12px |\n\n" +
  "- Keep `--density` in MASTER.md output without a new link.\n\n" +
  "| Problem | Rule |\n|---|---|\n| One | `a` + `b` |\n| Two | `c` + `d` + `e` |\n" +
  "| Three | `f` + `g` + `h` |\n| Four | `i` + `j` + `k` |\n| Five | `l` + `m` |\n| Six | `n` + `o` + `p` |\n\n" +
  "Keep the independent ending and [external](https://example.test/original).\n"
const source = fidelitySource
const distorted = (body: string) =>
  body
    .replaceAll("&lt;", "<")
    .replaceAll(" + ", "  • ")
    .replace("MASTER.md", "[MASTER.md](http://master.md/)")
const referenceSources = [
  {
    id: referenceOne,
    path: "references/policy.md",
    body: "# Policy\n\nKeep `mode` and [policy link](https://example.test/policy).\n",
  },
  { id: referenceTwo, path: "references/guide.md", body: "# Guide\n\nExact guide instructions.\n" },
]
const tags = referenceSources
  .map(
    (reference) =>
      `<page url="https://app.notion.com/p/${reference.id.replaceAll("-", "")}">${reference.path.slice("references/".length)}</page>`,
  )
  .join("\n")
const annotations = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
}
const text = (content: string, url: string | null = null) => ({
  type: "text",
  text: { content, link: url === null ? null : { url } },
  plain_text: content,
  href: url,
  annotations: { ...annotations },
})
const rich = (content: string) => ({ type: "rich_text", rich_text: [text(content)] })
const encode = (value: string) => new TextEncoder().encode(value)
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const unexpectedFetch: typeof globalThis.fetch = Object.assign(
  async () => {
    throw new Error("A missing source archive must not trigger network download or upload")
  },
  {
    preconnect: () => {
      throw new Error("Unexpected preconnect")
    },
  },
)
type Environment =
  | Store
  | Notion
  | UpstreamState
  | UpstreamPublisher
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
export type FidelityFault =
  | "before"
  | "after"
  | "wrong-ack"
  | "ack-read"
  | "partial-after"
  | "other-block"
  | "stale-after"
type Fault = FidelityFault

/** Only the frozen upstream plan and legacy remote writing page are fixture
 * inputs. The production apply creates the unsent CREATE_CONFLICT ledger; the
 * completion's plan, claim, pending attempts, ACKs and resolutions all use real
 * production use cases. The external transport alone is simulated. */
export async function sourceRootFidelityFixture(initialBody: "empty" | "exact" = "empty") {
  const json = new Map<string, unknown>(),
    objects = new Map<string, Uint8Array>()
  const native = upstreamRepositoryFixture(json),
    faults: Fault[] = []
  const writes: Array<{ path: string; body: unknown; method: string }> = []
  const retiredCacheKeys: string[] = []
  let losePending = false,
    readFailure = false,
    revision = beforeTime,
    body = initialBody === "exact" ? source + tags : tags
  let patchCount = 0,
    changeParentAtPending = false,
    foreignClaimAtPending = false
  let stale: Map<string, unknown> | undefined
  const descendants = new Map<string, Record<string, unknown>[]>()
  const applied = new Set<string>()
  let cacheScope: string | undefined
  let stateGeneration = 0
  const stateRoot = mkdtempSync(join(tmpdir(), "source-root-completion-"))
  const crypto = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* Crypto.Crypto
    }).pipe(Effect.provide(NodeServices.layer)),
  )
  const portable: PortableSkill = {
    kind: "skill",
    name,
    description,
    main: "SKILL.md",
    files: [
      {
        path: "SKILL.md",
        bytes: encode(
          `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${source}`,
        ),
      },
      ...referenceSources.map((reference) => ({
        path: reference.path,
        bytes: encode(reference.body),
      })),
      { path: "notes.txt", bytes: encode("Keep these exact frozen source bytes.\n") },
    ],
  }
  const intended = hash(
    canonical([
      portable.kind,
      name,
      description,
      portable.main,
      [...portable.files]
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((file) => [file.path, file.bytes.length, hash(file.bytes)]),
    ]),
  )
  const marker: PublicationMarker = {
    version: 2,
    operation_id: oldId,
    intended_hash: intended,
    state: "writing",
  }
  const normalized = (values: readonly unknown[]) =>
    values.map((raw) => {
      const value = property(raw),
        item = property(value.text),
        link = item.link == null ? null : property(item.link)
      return {
        type: "text",
        text: { content: item.content, link },
        annotations: { ...annotations, ...property(value.annotations) },
        plain_text: item.content,
        href: link?.url ?? null,
      }
    })
  const block = (
    blockId: string,
    owner: string,
    type: string,
    value: Record<string, unknown>,
    time = beforeTime,
  ) => ({
    object: "block",
    id: blockId,
    type,
    parent: { type: "page_id", page_id: owner },
    has_children: type === "child_page",
    archived: false,
    in_trash: false,
    created_time: time,
    last_edited_time: time,
    created_by: { object: "user", id: id(30) },
    last_edited_by: { object: "user", id: id(30) },
    [type]: value,
  })
  const renderBlocks = (owner: string, markdown: string, start: number, time = beforeTime) => {
    const result: Record<string, unknown>[] = []
    const add = (type: string, value: Record<string, unknown>) =>
      result.push(block(id(start + result.length), owner, type, value, time))
    for (const token of Lexer.lex(markdown)) {
      if (token.type === "space") continue
      if (token.type === "heading" || token.type === "paragraph") {
        if (!Array.isArray(token.tokens))
          throw new Error("A test source text block needs its complete inline tokens")
        add(token.type === "heading" ? `heading_${token.depth}` : "paragraph", {
          rich_text: normalized(markdownRichText(token.tokens)),
          color: "default",
        })
      } else if (token.type === "list")
        for (const [index, item] of token.items.entries())
          add(token.ordered ? "numbered_list_item" : "bulleted_list_item", {
            rich_text: normalized(markdownRichText(Lexer.lexInline(item.text))),
            color: "default",
            ...(token.ordered && index === 0 ? { list_start_index: token.start } : {}),
          })
      else if (token.type === "hr") add("divider", {})
      else if (token.type === "table") {
        const tableId = id(start + result.length)
        const rows = [token.header, ...token.rows].map(
          (cells: Tokens.TableCell[], index: number) => ({
            ...block(
              id(start + 1000 + result.length * 100 + index),
              owner,
              "table_row",
              {
                cells: markdownTableCells(cells).map(normalized),
              },
              time,
            ),
            parent: { type: "block_id", block_id: tableId },
          }),
        )
        result.push({
          ...block(
            tableId,
            owner,
            "table",
            { table_width: token.header.length, has_column_header: true, has_row_header: false },
            time,
          ),
          has_children: true,
        })
        descendants.set(tableId, rows)
      } else throw new Error(`Unsupported test source token: ${token.type}`)
    }
    return result
  }
  const children = referenceSources.map((reference) =>
    block(reference.id, root, "child_page", { title: reference.path.slice("references/".length) }),
  )
  const roots: Record<string, unknown>[] =
    initialBody === "exact" ? [...renderBlocks(root, source, 100), ...children] : [...children]
  const referenceBodies = new Map(
    referenceSources.map((reference) => [reference.id, reference.body]),
  )
  const referenceBlocks = new Map(
    referenceSources.map((reference, index) => [
      reference.id,
      renderBlocks(reference.id, reference.body, 200 + index * 100),
    ]),
  )
  const referenceRows = new Map(
    referenceSources.map((reference) => [
      reference.id,
      {
        object: "page",
        id: reference.id,
        archived: false,
        in_trash: false,
        last_edited_time: beforeTime,
        last_edited_by: { object: "user", id: id(30) },
        parent: { type: "page_id", page_id: root },
        properties: {
          title: {
            id: "title",
            type: "title",
            title: [text(reference.path.slice("references/".length))],
          },
        },
      },
    ]),
  )
  const referenceRich = referenceSources.flatMap((reference, index) => [
    ...(index ? [text("\n")] : []),
    text(reference.path, `https://www.notion.so/${reference.id.replaceAll("-", "")}`),
  ])
  const subscriptionProperties: Record<string, unknown> = {
    Name: { id: "title", type: "title", title: [text("Literal repair source")] },
    Description: rich(description),
    "Default Context": { type: "checkbox", checkbox: false },
    Enabled: { type: "checkbox", checkbox: true },
    Status: { type: "select", select: { name: "verified" } },
    Source: rich(
      JSON.stringify({
        provider: {
          type: "git",
          url: "https://example.test/fixture.git",
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
  const properties: Record<string, unknown> = {
    ...structuredClone(publicationSourceRows),
    Name: { id: "title", type: "title", title: [text(name)] },
    Description: { id: "description", ...rich(description) },
    Kind: { id: "kind", type: "select", select: { name: "skill" } },
    References: { id: "references", type: "rich_text", rich_text: referenceRich },
    Files: { id: "files", type: "files", files: [] },
    Publication: { id: "publication", ...rich(JSON.stringify(marker)) },
    Upstream: { id: "upstream", type: "relation", relation: [], has_more: false },
    "Sync Mode": { id: "mode", type: "select", select: null },
    "Upstream Key": { id: "key", type: "rich_text", rich_text: [] },
    "Upstream Revision": { id: "revision", type: "rich_text", rich_text: [] },
    "Published Hash": { id: "hash", type: "rich_text", rich_text: [] },
    "Fork Baseline": { id: "baseline", type: "rich_text", rich_text: [] },
    Editor: {
      id: "editor",
      type: "last_edited_by",
      last_edited_by: { object: "user", id: id(30) },
    },
  }
  const row = () => ({
    object: "page",
    id: root,
    archived: false,
    in_trash: false,
    last_edited_time: revision,
    last_edited_by: { object: "user", id: id(30) },
    parent: { type: "data_source_id", database_id: database, data_source_id: dataSource },
    properties: {
      ...structuredClone(properties),
      Updated: { id: "updated", type: "last_edited_time", last_edited_time: revision },
    },
  })
  const subscription = () => ({
    id: subscriptionId,
    archived: false,
    in_trash: false,
    last_edited_time: beforeTime,
    parent: {
      type: "data_source_id",
      database_id: upstreamDatabase,
      data_source_id: upstreamDataSource,
    },
    properties: structuredClone(subscriptionProperties),
  })
  const repository: typeof native = {
    ...native,
    claimCommand: (key, expected, value, guard) =>
      Effect.gen(function* () {
        if (
          key.startsWith("source-root-fidelity:") &&
          property(value).phase === "pending" &&
          guard
        ) {
          if (changeParentAtPending) {
            changeParentAtPending = false
            yield* native.saveCommand(guard.operation_id, {
              ...property(guard.expected),
              injected: "changed before pending CAS",
            })
          }
          if (foreignClaimAtPending) {
            foreignClaimAtPending = false
            yield* native.createCommand("content-adoption:plan:foreign", {
              plan: {
                page_id: root,
                item_index: 0,
                original_plan: { items: [{ target_key: "foreign-target" }] },
              },
            })
          }
        }
        yield* native.claimCommand(key, expected, value, guard)
        if (
          losePending &&
          key.startsWith("source-root-fidelity:") &&
          property(value).phase === "pending"
        ) {
          losePending = false
          return yield* Effect.fail(
            fail("STORAGE_ERROR", "The pending CAS committed, but its local response was lost"),
          )
        }
      }),
  }
  const store: Store["Service"] = {
    root: stateRoot,
    configRoot: "/memory",
    cacheRoot: "/memory",
    upstream: repository,
    integrity: integrityRepositoryFixture(json),
    reserveCacheGeneration: () => Effect.sync(() => ++stateGeneration),
    listKeys: (prefix) =>
      Effect.sync(() => [...json.keys()].filter((key) => key.startsWith(prefix + "/"))),
    retireKeys: (keys) =>
      Effect.gen(function* () {
        const prefix = `cache/catalogs/${cacheScope}/`
        if (
          !cacheScope ||
          keys.some(
            (key) =>
              !key.startsWith(prefix) || !/^[a-zA-Z0-9_-]+\.json$/.test(key.slice(prefix.length)),
          )
        )
          return yield* Effect.fail(
            fail(
              "FIXTURE_HISTORY_RETIRE",
              "Only this fixture's scoped catalog cache can be retired",
              { keys },
            ),
          )
        return yield* Effect.sync(() =>
          keys.map((key) => {
            retiredCacheKeys.push(key)
            json.delete(key)
            return { key, retention_path: `fixture_cache_trash/${key}` }
          }),
        )
      }),
    readJson: (key, schema) =>
      Effect.sync(() =>
        json.has(key) ? decode(schema, structuredClone(json.get(key))) : undefined,
      ),
    writeJson: (key, value) =>
      Effect.sync(() => {
        json.set(key, structuredClone(value))
      }),
    readBytes: (key) =>
      objects.has(key)
        ? Effect.succeed(objects.get(key)!.slice())
        : Effect.fail(fail("SNAPSHOT_MISSING", "Missing fixture source object")),
    writeBytes: (key, value) =>
      Effect.sync(() => {
        objects.set(key, value.slice())
      }),
    registerBindingWithBase: () => Effect.die(new Error("Unexpected binding mutation")),
    advanceBaseAndReceipt: () => Effect.die(new Error("Unexpected base mutation")),
    backup: () => Effect.die(new Error("Unexpected backup")),
    output: () => Effect.die(new Error("Unexpected output")),
  }
  json.set("config.json", { default_database: database, upstream_database: upstreamDatabase })
  const api: Notion["Service"] = {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("credential"),
    request: (path, payload, options) =>
      Effect.gen(function* () {
        const method = options?.method ?? (payload === undefined ? "GET" : "POST")
        if (method !== "GET" && !path.endsWith("/query"))
          writes.push({ path, method, body: structuredClone(payload) })
        if (method === "GET" && stale?.has(path)) return structuredClone(stale.get(path))
        if (method === "PATCH" && path === `v1/pages/${root}/markdown`) {
          const proposed = property(property(payload).replace_content).new_str
          const main = portable.files.find((file) => file.path === portable.main)!
          const authored = importDocument(main, portable).body
          const expected = `${authored}${authored.endsWith("\n") ? "" : "\n"}${tags}`
          if (
            canonical(payload) !==
              canonical({
                markdown_version: "v2",
                type: "replace_content",
                replace_content: { new_str: expected },
              }) ||
            typeof proposed !== "string"
          )
            return yield* Effect.fail(
              fail("UNEXPECTED", "The transport received a different root request", payload),
            )
          roots.splice(
            0,
            roots.length,
            ...renderBlocks(root, distorted(authored), 100, afterTime),
            ...children,
          )
          revision = afterTime
          body = distorted(authored) + tags
          return {
            object: "page_markdown",
            id: root,
            markdown: body,
            truncated: false,
            unknown_block_ids: [],
          }
        }
        if (method === "PATCH" && /^v1\/blocks\//.test(path)) {
          const claim = yield* decodeSourceRootFidelity(
            yield* native.command(sourceRootFidelityKey(originalPlan.plan_id, 0)),
          ).pipe(Effect.provideService(Crypto.Crypto, crypto))
          const attempt = claim.attempts.at(-1),
            effect = attempt && claim.plan.effects[attempt.effect_index]
          if (
            claim.phase !== "pending" ||
            !attempt ||
            attempt.outcome !== "pending" ||
            !effect ||
            effect.request.path !== path ||
            canonical(payload) !== canonical(effect.request.body)
          )
            return yield* Effect.fail(
              fail(
                "FIXTURE_UNCLAIMED_PATCH",
                "A typed request arrived without its exact durable pending journal.",
              ),
            )
          const fault = faults.shift()
          if (fault === "before")
            return yield* Effect.fail(
              fail("WRITE_OUTCOME_UNKNOWN", "The one response was lost before its block changed."),
            )
          if (fault === "stale-after") {
            stale = new Map<string, unknown>([
              [`v1/pages/${root}`, row()],
              [
                `v1/pages/${root}/markdown`,
                {
                  object: "page_markdown",
                  id: root,
                  markdown: body,
                  truncated: false,
                  unknown_block_ids: [],
                },
              ],
              [
                `v1/blocks/${root}/children?page_size=100`,
                {
                  object: "list",
                  results: structuredClone(roots),
                  has_more: false,
                  next_cursor: null,
                },
              ],
              ...[...descendants].map(
                ([owner, rows]) =>
                  [
                    `v1/blocks/${owner}/children?page_size=100`,
                    {
                      object: "list",
                      results: structuredClone(rows),
                      has_more: false,
                      next_cursor: null,
                    },
                  ] satisfies [string, unknown],
              ),
            ])
          }
          applyBlock(effect)
          const found = allBlocks().find((value) => value.id === effect.block_id)!
          const response = structuredClone(found)
          if (fault === "partial-after") {
            const cells = property(found.table_row).cells
            if (!Array.isArray(cells) || !Array.isArray(cells[0]))
              throw new Error("The partial fixture fault needs a table row")
            cells[0].push(text(" foreign partial text"))
          }
          if (fault === "other-block")
            property(roots[0]!.heading_1).rich_text = [text("Foreign heading")]
          if (fault === "after")
            return yield* Effect.fail(
              fail("WRITE_OUTCOME_UNKNOWN", "The one response was lost after its block changed."),
            )
          if (fault === "ack-read") readFailure = true
          return fault === "wrong-ack" ? { ...response, id: id(99) } : response
        }
        if (path === `v1/pages/${subscriptionId}` && method === "PATCH") {
          for (const [key, value] of Object.entries(property(property(payload).properties))) {
            const field = property(value),
              fieldName = key === "title" ? "Name" : key
            subscriptionProperties[fieldName] = {
              ...property(subscriptionProperties[fieldName]),
              ...field,
            }
          }
          return subscription()
        }
        if (method !== "GET" && !path.endsWith("/query"))
          return yield* Effect.fail(
            fail("UNEXPECTED", "A root completion tried another remote mutation", {
              path,
              method,
              payload,
            }),
          )
        if (path === "v1/users/me") return { object: "user", id: "fixture" }
        if (path === `v1/databases/${database}`)
          return {
            id: database,
            database_type: null,
            title: [],
            data_sources: [{ id: dataSource, name: "Skills" }],
          }
        if (path === `v1/databases/${upstreamDatabase}`)
          return {
            id: upstreamDatabase,
            database_type: null,
            title: [],
            data_sources: [{ id: upstreamDataSource, name: "Upstream" }],
          }
        if (path === `v1/data_sources/${dataSource}`)
          return {
            id: dataSource,
            parent: { database_id: database },
            title: [],
            properties: { ...row().properties, ...structuredClone(publicationSourceSchema) },
          }
        if (path === `v1/data_sources/${upstreamDataSource}`)
          return {
            id: upstreamDataSource,
            parent: { database_id: upstreamDatabase },
            title: [],
            properties: Object.fromEntries(
              Object.entries(subscriptionProperties).map(([key, value]) => [
                key,
                { id: key === "Name" ? "title" : key, type: property(value).type },
              ]),
            ),
          }
        if (path === `v1/data_sources/${dataSource}/query`)
          return { results: [row()], has_more: false, next_cursor: null }
        if (path === `v1/data_sources/${upstreamDataSource}/query`)
          return { results: [subscription()], has_more: false, next_cursor: null }
        if (path === `v1/pages/${subscriptionId}`) return subscription()
        if (path === `v1/pages/${root}`) {
          if (readFailure) {
            readFailure = false
            return yield* Effect.fail(
              fail("ACCESS_DENIED", "The independent AFTER read was interrupted"),
            )
          }
          return row()
        }
        if (path === `v1/pages/${root}/markdown`) {
          return {
            object: "page_markdown",
            id: root,
            markdown: body,
            truncated: false,
            unknown_block_ids: [],
          }
        }
        if (path === `v1/blocks/${root}/children?page_size=100`)
          return {
            object: "list",
            results: structuredClone(roots),
            has_more: false,
            next_cursor: null,
          }
        for (const [owner, rows] of descendants)
          if (path === `v1/blocks/${owner}/children?page_size=100`)
            return {
              object: "list",
              results: structuredClone(rows),
              has_more: false,
              next_cursor: null,
            }
        if (path === `v1/pages/${root}/properties/references?page_size=100`)
          return {
            object: "list",
            type: "property_item",
            results: referenceRich.map((value) => ({
              object: "property_item",
              id: "references",
              type: "rich_text",
              rich_text: value,
            })),
            has_more: false,
            next_cursor: null,
          }
        for (const reference of referenceSources) {
          if (path === `v1/pages/${reference.id}`)
            return structuredClone(referenceRows.get(reference.id))
          if (path === `v1/pages/${reference.id}/markdown`)
            return {
              object: "page_markdown",
              id: reference.id,
              markdown: referenceBodies.get(reference.id),
              truncated: false,
              unknown_block_ids: [],
            }
          if (path === `v1/blocks/${reference.id}/children?page_size=100`)
            return {
              object: "list",
              results: structuredClone(referenceBlocks.get(reference.id)),
              has_more: false,
              next_cursor: null,
            }
        }
        return yield* Effect.fail(fail("UNEXPECTED", "Unexpected fixture read", { path, method }))
      }),
  }
  const layer = Layer.mergeAll(
    NodeServices.layer,
    NodeHttpClient.layerFetch,
    Layer.succeed(Store, store),
    Layer.succeed(Notion, api),
    Layer.succeed(UpstreamState, repository),
    Layer.succeed(FetchHttpClient.Fetch, unexpectedFetch),
  )
  const run = <A, E>(effect: Effect.Effect<A, E, Environment>) =>
    Effect.runPromise(effect.pipe(Effect.provide(UpstreamPublisherLive), Effect.provide(layer)))
  const originalPlan = await run(
    Effect.gen(function* () {
      const current = yield* getSubscription(subscriptionId, upstreamDatabase),
        frozen = yield* freezePortable(portable)
      const scope = yield* authScope,
        identity = yield* portableIdentity(portable)
      cacheScope = scope
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
            content_hash: identity,
            upstream_hash: identity,
            candidate: frozen,
            accepted: frozen,
            deltas: contentDeltas(undefined, frozen),
          },
        ],
      })
      const { plan_id: _id, plan_hash: _hash, ...value } = pending
      const planHash = yield* sha256(JSON.stringify(value)),
        plan = { ...value, plan_id: `up_${planHash}`, plan_hash: planHash }
      yield* repository.savePlan(plan)
      return plan
    }),
  )
  const operation = await run(applyUpstream(originalPlan.plan_id))
  expect(operation.items[0]).toMatchObject({
    member_key: memberKey,
    status: "unknown",
    error_code: "CREATE_CONFLICT",
  })
  const originalId = "p_" + hash(`${operation.operation_id}:0`)
  const originalIntegrity = await run(store.integrity.inspect(originalId))
  expect(originalIntegrity).toEqual({
    version: 1,
    operation_id: originalId,
    intended_hash: intended,
    marker: { version: 2, operation_id: originalId, intended_hash: intended, state: "writing" },
  })
  expect(json.has(`publications/${originalId}.json`)).toBe(false)
  expect(await run(store.integrity.inspect(oldId))).toBeUndefined()
  const input = {
    original_plan_id: originalPlan.plan_id,
    member_key: memberKey,
    page_id: root,
    old_operation_id: oldId,
  }
  const adoption = {
    original_plan_id: originalPlan.plan_id,
    member_key: memberKey,
    page_id: root,
    old_operation_id: oldId,
    install_source_bundle: true as const,
  }
  writes.length = 0
  const nativeHistory = () =>
    [...json].filter(([key]) => !key.startsWith("cache/") && !key.startsWith("cache-generations/"))
  const originalJson = canonical(nativeHistory())
  const originalObjects = new Map([...objects].map(([key, value]) => [key, value.slice()]))
  const originalCacheRetirements = [...retiredCacheKeys]
  const originalCommandKeys = [
    "subscription-map",
    "subscription-map:intended",
    "subscription-map:checkpoint",
    "accepted-config",
  ]
    .map((suffix) => `${originalPlan.plan_id}:${suffix}`)
    .concat(`${operation.operation_id}:projections`)
  const originalCommands = await run(
    Effect.forEach(originalCommandKeys, (key) => repository.command(key)),
  )
  const assertOriginal = async () => {
    expect(await run(repository.plan(originalPlan.plan_id))).toEqual(originalPlan)
    expect(await run(repository.operation(originalPlan.plan_id))).toEqual(operation)
    expect(await run(store.integrity.inspect(originalId))).toEqual(originalIntegrity)
    expect(await run(store.integrity.inspect(oldId))).toBeUndefined()
    expect(await run(repository.bindings(subscriptionId))).toEqual([])
    expect(await run(repository.target(originalPlan.items[0]!.target_key))).toBeUndefined()
    expect(
      await run(Effect.forEach(originalCommandKeys, (key) => repository.command(key))),
    ).toEqual(originalCommands)
    expect(canonical(nativeHistory())).toBe(originalJson)
    expect(retiredCacheKeys).toEqual(originalCacheRetirements)
    expect(publicationMarker(row())).toEqual(marker)
  }
  const allBlocks = () => [...roots, ...[...descendants.values()].flat()]
  let reviewedEffects: readonly SourceRootFidelityEffect[] | undefined
  const applyBlock = (effect: SourceRootFidelityEffect) => {
    const found = allBlocks().find((value) => value.id === effect.block_id)
    if (!found) throw new Error("The target block is absent from the fixture's complete graph")
    const type = String(found.type),
      fields = property(effect.request.body[type])
    found[type] = {
      ...property(found[type]),
      ...fields,
      ...(type === "table_row"
        ? { cells: (Array.isArray(fields.cells) ? fields.cells : []).map(normalized) }
        : { rich_text: normalized(Array.isArray(fields.rich_text) ? fields.rich_text : []) }),
    }
    revision = new Date(Date.parse(afterTime) + ++patchCount * 1000).toISOString()
    found.last_edited_time = revision
    for (const ancestor of effect.ancestor_ids) {
      const value = allBlocks().find((block) => block.id === ancestor)
      if (!value) throw new Error("The selected table ancestor is absent")
      value.last_edited_time = revision
    }
    applied.add(effect.block_id)
    if (!reviewedEffects)
      throw new Error("The source view was not frozen before the first typed request")
    let current = source
    for (const selected of [...reviewedEffects]
      .filter((value) => !applied.has(value.block_id))
      .sort((a, b) => b.source_edit.start - a.source_edit.start)) {
      const edit = selected.source_edit
      current = current.slice(0, edit.start) + edit.observed + current.slice(edit.end)
    }
    body = current + tags
  }
  const sourceObjectsUnchanged = (archive?: {
    readonly archive_sha256: string
    readonly archive_bytes: number
  }) => {
    for (const [key, bytes] of originalObjects) {
      const current = objects.get(key)
      expect(current).toEqual(bytes)
      if (!current) throw new Error("An original frozen source object is missing")
      expect(hash(current)).toBe(hash(bytes))
    }
    const allowed = new Set(originalObjects.keys())
    if (archive) {
      const key = `objects/${archive.archive_sha256}`,
        bytes = objects.get(key)
      expect(bytes).toBeDefined()
      if (!bytes) throw new Error("The ordinary CA plan's exact source archive is missing")
      expect(hash(bytes)).toBe(archive.archive_sha256)
      expect(bytes.length).toBe(archive.archive_bytes)
      allowed.add(key)
    }
    expect([...objects.keys()].sort()).toEqual([...allowed].sort())
  }
  return {
    run,
    input,
    adoption,
    repository,
    native,
    store,
    json,
    objects,
    originalPlan,
    operation,
    originalId,
    originalIntegrity,
    roots,
    children,
    descendants,
    referenceBodies,
    referenceBlocks,
    referenceRows,
    properties,
    writes,
    row,
    portable,
    block,
    assertOriginal,
    sourceObjectsUnchanged,
    fault: (fault: Fault) => {
      faults.push(fault)
    },
    crashAfterPending: () => {
      losePending = true
    },
    freezeEffects: (effects: readonly SourceRootFidelityEffect[]) => {
      reviewedEffects = effects
    },
    applyUnjournaled: applyBlock,
    revealAfter: () => {
      stale = undefined
    },
    changeParentBeforePending: () => {
      changeParentAtPending = true
    },
    foreignClaimBeforePending: () => {
      foreignClaimAtPending = true
    },
    setBody: (value: string) => {
      body = value
    },
    changeSubscription: () => {
      subscriptionProperties.Description = rich("External configuration edit")
    },
  }
}
