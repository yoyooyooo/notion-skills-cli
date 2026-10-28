import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Crypto, Effect, FileSystem, Layer, Path } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { Lexer } from "marked"
import { authScope } from "../src/catalog.ts"
import { portableIdentity } from "../src/export.ts"
import { markdownRichText } from "../src/markdown-blocks.ts"
import { decode, fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import type { PortableSkill } from "../src/portable.ts"
import { contentAdoptionMemberKey } from "../src/publication-content-adoption-authority.ts"
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
import { planContentAdoption } from "../src/upstream-content-adoption.ts"
import { strictDecode, UpstreamPlanSchema, UpstreamPublisher } from "../src/upstream-model.ts"
import { UpstreamPublisherLive } from "../src/upstream-publication.ts"
import { UpstreamState } from "../src/upstream-state.ts"
import { getSubscription } from "../src/upstream-subscription.ts"
import {
  applySourceRootCompletion,
  planSourceRootCompletion,
  reconcileSourceRootCompletion,
  showSourceRootCompletion,
} from "../src/upstream-source-root-completion.ts"
import {
  decodeSourceRootCompletion,
  sourceRootCompletionKey,
} from "../src/upstream-source-root-completion-model.ts"
import { planSourceRichTextRepair } from "../src/upstream-source-rich-text-repair.ts"
import { importDocument } from "../src/import.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

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
const source =
  "\n# Complete root\n\nOriginal **bold** instructions and [site](https://example.test/original). Read `design-system/<project-slug>/pages/<page-name>.md`.\n\n1. Keep first.\n2. Keep second.\n\n---\n\n"
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
type Fault =
  | "before"
  | "after"
  | "wrong-ack"
  | "truncated-ack"
  | "ack-read"
  | "partial-after"
  | "extra-empty-after"
  | "second-after-drift"

/** Only the frozen upstream plan and legacy remote writing page are fixture
 * inputs. The production apply creates the unsent CREATE_CONFLICT ledger; the
 * completion's plan, claim, pending attempts, ACKs and resolutions all use real
 * production use cases. The external transport alone is simulated. */
async function fixture(initialBody: "empty" | "exact" = "empty") {
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
  let afterReads = 0,
    driftOnSecondAfter = false
  let cacheScope: string | undefined
  let stateGeneration = 0
  const stateRoot = mkdtempSync(join(tmpdir(), "source-root-completion-"))
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
      else throw new Error(`Unsupported test source token: ${token.type}`)
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
    claimCommand: (key, expected, value) =>
      Effect.gen(function* () {
        yield* native.claimCommand(key, expected, value)
        if (losePending && property(value).phase === "pending") {
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
        if (method === "PATCH" && path === `v1/pages/${root}/markdown`) {
          const fault = faults.shift(),
            proposed = property(property(payload).replace_content).new_str
          if (fault === "before")
            return yield* Effect.fail(
              fail("WRITE_OUTCOME_UNKNOWN", "Response lost before the exact root changed"),
            )
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
            ...renderBlocks(root, authored, 100, afterTime),
            ...children,
          )
          revision = afterTime
          body = proposed
          afterReads = 0
          if (fault === "partial-after") {
            roots.splice(1, 1)
            body = body.replace(
              "Original **bold** instructions and [site](https://example.test/original).\n\n",
              "",
            )
          }
          if (fault === "extra-empty-after")
            roots.splice(
              1,
              0,
              block(id(499), root, "paragraph", { rich_text: [], color: "default" }, afterTime),
            )
          if (["after", "partial-after", "extra-empty-after"].includes(fault ?? ""))
            return yield* Effect.fail(
              fail("WRITE_OUTCOME_UNKNOWN", "Response lost after the root request"),
            )
          if (fault === "ack-read") readFailure = true
          if (fault === "second-after-drift") driftOnSecondAfter = true
          return {
            object: "page_markdown",
            id: fault === "wrong-ack" ? id(99) : root,
            markdown: body,
            truncated: fault === "truncated-ack",
            unknown_block_ids: [],
          }
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
            properties: row().properties,
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
          if (revision === afterTime && ++afterReads === 2 && driftOnSecondAfter) {
            body = body.replace("Original **bold** instructions", "An external instruction")
            driftOnSecondAfter = false
          }
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
  const originalJson = canonical(nativeHistory()),
    originalObjects = canonical([...objects].map(([key, value]) => [key, hash(value)]))
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
    referenceBodies,
    referenceBlocks,
    referenceRows,
    properties,
    writes,
    row,
    portable,
    block,
    assertOriginal,
    sourceObjectsUnchanged: () =>
      expect(canonical([...objects].map(([key, value]) => [key, hash(value)]))).toBe(
        originalObjects,
      ),
    fault: (fault: Fault) => {
      faults.push(fault)
    },
    crashAfterPending: () => {
      losePending = true
    },
    setBody: (value: string) => {
      body = value
    },
    changeSubscription: () => {
      subscriptionProperties.Description = rich("External configuration edit")
    },
  }
}

async function planned() {
  const f = await fixture(),
    plan = await f.run(planSourceRootCompletion(f.input))
  expect(f.writes).toEqual([])
  expect(plan).toMatchObject({
    phase: "planned",
    body_verified: false,
    source_bytes_verified: false,
    publication_completed: false,
    attempts: 0,
  })
  return {
    f,
    plan,
    receipt: () => f.run(showSourceRootCompletion(plan.plan_id)),
    apply: () => f.run(applySourceRootCompletion(plan.plan_id, plan.plan_hash)),
    reconcile: () => f.run(reconcileSourceRootCompletion(plan.plan_id, plan.plan_hash)),
  }
}
async function failed(
  f: Awaited<ReturnType<typeof fixture>>,
  effect: Parameters<typeof f.run>[0],
  expected?: string,
) {
  const result = await f.run(effect.pipe(Effect.result))
  expect(result._tag).toBe("Failure")
  if (result._tag !== "Failure") throw new Error("Expected the original native guard to refuse")
  if (expected !== undefined) expect(property(result.failure).code).toBe(expected)
  return result.failure
}

test("empty-root planning is read-only; one PATCH needs two stable whole AFTER proofs before normal CA may plan", async () => {
  const c = await planned(),
    before = await c.receipt()
  expect(before.plan.before_body_verified).toBe(false)
  expect(before.plan.before_source_bytes_verified).toBe(false)
  expect(before.plan.before.page_ids).toEqual([root, referenceOne, referenceTwo].sort())
  expect(before.plan.effect.references.map((reference) => reference.page_id)).toEqual([
    referenceOne,
    referenceTwo,
  ])
  const main = c.f.portable.files.find((file) => file.path === c.f.portable.main)!
  const authored = importDocument(main, c.f.portable).body
  expect(authored).toBe(source)
  expect(authored.startsWith("\n")).toBe(true)
  expect(authored.endsWith("\n\n")).toBe(true)
  expect(before.plan.effect.request.body.replace_content.new_str).toBe(
    `${authored}${authored.endsWith("\n") ? "" : "\n"}${tags}`,
  )
  await failed(c.f, planContentAdoption(c.f.adoption), "SOURCE_ROOT_COMPLETION_REFUSED")
  const leafRefusal = await failed(
    c.f,
    planSourceRichTextRepair({ ...c.f.input, kind: "literal_dollar_equation", block_id: id(100) }),
    "SOURCE_RICH_TEXT_REPAIR_REFUSED",
  )
  expect(property(leafRefusal).message).toContain("root-completion")
  expect(await c.apply()).toMatchObject({
    phase: "body_verified",
    attempts: 1,
    body_verified: true,
    source_bytes_verified: false,
    publication_completed: false,
    original_history_preserved: true,
  })
  expect(c.f.writes).toEqual([
    { path: `v1/pages/${root}/markdown`, method: "PATCH", body: before.plan.effect.request.body },
  ])
  const receipt = await c.receipt()
  expect(receipt.plan).toEqual(before.plan)
  expect(receipt.attempts[0]).toMatchObject({
    outcome: "acknowledged",
    response: { object: "page_markdown", id: root },
  })
  expect(receipt.result?.first_observation.graph_sha256).toBe(receipt.result?.proof.graph_sha256)
  expect(receipt.result?.first_observation.raw).toEqual(receipt.result?.proof.raw)
  expect(receipt.result?.proof).toMatchObject({
    source_proof: "not_installed",
    files: [],
    attachments: [],
  })
  expect(c.f.roots.slice(-2)).toEqual(c.f.children)
  await c.f.assertOriginal()
  c.f.sourceObjectsUnchanged()
  const adoption = await c.f.run(planContentAdoption(c.f.adoption))
  expect(adoption).toMatchObject({
    state: "planned",
    page_id: root,
    source_installation: { state: "pending", independently_verified: false },
  })
  expect(await c.apply()).toMatchObject({
    phase: "body_verified",
    reused: true,
    proof: "retained_historical_result",
  })
  expect(await c.reconcile()).toMatchObject({ phase: "body_verified", reused: true })
  expect(await c.receipt()).toEqual(receipt)
  expect(c.f.writes).toHaveLength(1)
  await c.f.assertOriginal()
}, 60000)

test("unknown exact BEFORE retains its outcome; only explicit apply appends a new pending attempt", async () => {
  const c = await planned()
  c.f.fault("before")
  await failed(
    c.f,
    applySourceRootCompletion(c.plan.plan_id, c.plan.plan_hash),
    "WRITE_OUTCOME_UNKNOWN",
  )
  const unknown = await c.receipt()
  expect(await c.reconcile()).toMatchObject({
    phase: "unknown",
    observation: "exact_before",
    needs_safe_apply: true,
  })
  expect(await c.receipt()).toEqual(unknown)
  expect(c.f.writes).toHaveLength(1)
  expect(await c.apply()).toMatchObject({ phase: "body_verified", attempts: 2 })
  const complete = await c.receipt()
  expect(complete.attempts[0]).toMatchObject({
    ...unknown.attempts[0],
    resolution: { outcome: "known_not_applied" },
  })
  expect(complete.attempts[1]?.outcome).toBe("acknowledged")
  expect(c.f.writes).toHaveLength(2)
  await c.f.assertOriginal()
  c.f.sourceObjectsUnchanged()
}, 60000)

test("unknown exact AFTER uses two stable full reads and records observed-applied without inventing an ACK", async () => {
  const c = await planned()
  c.f.fault("after")
  await failed(
    c.f,
    applySourceRootCompletion(c.plan.plan_id, c.plan.plan_hash),
    "WRITE_OUTCOME_UNKNOWN",
  )
  const unknown = await c.receipt()
  expect(await c.reconcile()).toMatchObject({
    phase: "body_verified",
    attempts: 1,
    source_bytes_verified: false,
  })
  const complete = await c.receipt()
  expect(complete.attempts[0]).toMatchObject({
    ...unknown.attempts[0],
    resolution: { outcome: "observed_applied" },
  })
  expect(complete.attempts[0]?.response).toBeUndefined()
  expect(complete.attempts[0]?.outcome).toBe("unknown")
  expect(c.f.writes).toHaveLength(1)
  await c.f.assertOriginal()
  c.f.sourceObjectsUnchanged()
}, 60000)

test("a crash after durable pending sends nothing and cannot erase the original pending attempt", async () => {
  const c = await planned()
  c.f.crashAfterPending()
  await failed(c.f, applySourceRootCompletion(c.plan.plan_id, c.plan.plan_hash), "STORAGE_ERROR")
  const pending = await c.receipt()
  expect(pending.phase).toBe("pending")
  expect(c.f.writes).toEqual([])
  expect(await c.reconcile()).toMatchObject({
    phase: "pending",
    observation: "exact_before",
    needs_safe_apply: true,
  })
  expect(await c.receipt()).toEqual(pending)
  expect(await c.apply()).toMatchObject({ phase: "body_verified", attempts: 2 })
  const complete = await c.receipt()
  expect(complete.attempts[0]).toMatchObject({
    outcome: "pending",
    resolution: { outcome: "known_not_applied" },
  })
  expect(complete.attempts[0]?.response).toBeUndefined()
  expect(c.f.writes).toHaveLength(1)
  await c.f.assertOriginal()
}, 60000)

test("a genuine ACK survives a failed read and resumes only fresh proof", async () => {
  const c = await planned()
  c.f.fault("ack-read")
  await failed(c.f, applySourceRootCompletion(c.plan.plan_id, c.plan.plan_hash), "ACCESS_DENIED")
  const acknowledged = await c.receipt()
  expect(acknowledged.phase).toBe("acknowledged")
  expect(acknowledged.result).toBeUndefined()
  expect(await c.reconcile()).toMatchObject({ phase: "body_verified", attempts: 1 })
  expect((await c.receipt()).attempts).toEqual(acknowledged.attempts)
  expect(c.f.writes).toHaveLength(1)
  await c.f.assertOriginal()
}, 60000)

for (const fault of ["wrong-ack", "truncated-ack"] as const)
  test(`${fault} is retained as untrusted; only complete observed AFTER resolves it`, async () => {
    const c = await planned()
    c.f.fault(fault)
    await failed(
      c.f,
      applySourceRootCompletion(c.plan.plan_id, c.plan.plan_hash),
      "SOURCE_ROOT_COMPLETION_ACK_INVALID",
    )
    const unknown = await c.receipt()
    expect(unknown.attempts[0]).toMatchObject({
      outcome: "unknown",
      failure: { code: "SOURCE_ROOT_COMPLETION_ACK_INVALID" },
    })
    expect(unknown.attempts[0]?.response).toBeUndefined()
    expect(unknown.attempts[0]?.untrusted_response).toMatchObject(
      fault === "wrong-ack" ? { id: id(99) } : { truncated: true },
    )
    expect(await c.reconcile()).toMatchObject({ phase: "body_verified", attempts: 1 })
    const complete = await c.receipt()
    expect(complete.attempts[0]).toMatchObject({
      ...unknown.attempts[0],
      resolution: { outcome: "observed_applied" },
    })
    expect(complete.attempts[0]?.response).toBeUndefined()
    expect(c.f.writes).toHaveLength(1)
  }, 60000)

for (const fault of ["partial-after", "extra-empty-after"] as const)
  test(`${fault} fences unknown completion even when the retained child pages remain present`, async () => {
    const c = await planned()
    c.f.fault(fault)
    await failed(
      c.f,
      applySourceRootCompletion(c.plan.plan_id, c.plan.plan_hash),
      "WRITE_OUTCOME_UNKNOWN",
    )
    const unknown = await c.receipt()
    await failed(
      c.f,
      reconcileSourceRootCompletion(c.plan.plan_id, c.plan.plan_hash),
      "SOURCE_ROOT_COMPLETION_CONFLICT",
    )
    const conflict = await c.receipt()
    expect(conflict.phase).toBe("conflict")
    expect(conflict.attempts).toEqual(unknown.attempts)
    expect(conflict.result).toBeUndefined()
    await failed(
      c.f,
      applySourceRootCompletion(c.plan.plan_id, c.plan.plan_hash),
      "SOURCE_ROOT_COMPLETION_CONFLICT",
    )
    await failed(c.f, planContentAdoption(c.f.adoption), "SOURCE_ROOT_COMPLETION_REFUSED")
    expect(c.f.writes).toHaveLength(1)
    await c.f.assertOriginal()
  }, 60000)

test("one passing AFTER cannot complete while the second full graph read changes", async () => {
  const c = await planned()
  c.f.fault("second-after-drift")
  await failed(c.f, applySourceRootCompletion(c.plan.plan_id, c.plan.plan_hash))
  const retained = await c.receipt()
  expect(retained.phase).not.toBe("body_verified")
  expect(retained.attempts[0]?.outcome).toBe("acknowledged")
  expect(retained.result).toBeUndefined()
  expect(c.f.writes).toHaveLength(1)
  await failed(c.f, planContentAdoption(c.f.adoption), "SOURCE_ROOT_COMPLETION_REFUSED")
  await c.f.assertOriginal()
}, 60000)

for (const change of ["blank-root", "reference-body", "Files"] as const)
  test(`${change} refuses initial completion before a claim or mutation exists`, async () => {
    const f = await fixture()
    if (change === "blank-root")
      f.roots.unshift(f.block(id(499), root, "paragraph", { rich_text: [], color: "default" }))
    else if (change === "reference-body")
      f.referenceBodies.set(referenceOne, "# Policy\n\nA changed original instruction.\n")
    else
      f.properties.Files = {
        id: "files",
        type: "files",
        files: [
          {
            name: "foreign.txt",
            type: "external",
            external: { url: "https://example.test/foreign.txt" },
          },
        ],
      }
    await failed(f, planSourceRootCompletion(f.input))
    expect(
      await f.run(f.repository.command(sourceRootCompletionKey(f.originalPlan.plan_id, 0))),
    ).toBeUndefined()
    expect(f.writes).toEqual([])
    f.sourceObjectsUnchanged()
  }, 30000)

test("a pre-existing planned CA fences completion before any new claim", async () => {
  const f = await fixture("exact")
  const adoption = await f.run(planContentAdoption(f.adoption))
  expect(adoption.state).toBe("planned")
  expect(
    await f.run(f.repository.command(contentAdoptionMemberKey(f.originalPlan.plan_id, 0))),
  ).toEqual({ plan_id: adoption.plan_id })
  const error = await failed(f, planSourceRootCompletion(f.input), "SOURCE_ROOT_COMPLETION_REFUSED")
  expect(property(error).message).toContain("existing content adoption")
  expect(
    await f.run(f.repository.command(sourceRootCompletionKey(f.originalPlan.plan_id, 0))),
  ).toBeUndefined()
  expect(f.writes).toEqual([])
  await f.assertOriginal()
}, 30000)

test("source-object or whole original operation drift cannot reach the first PATCH", async () => {
  const c = await planned(),
    before = await c.receipt()
  await c.f.run(c.f.repository.saveOperation({ ...c.f.operation, state: "running" }))
  await failed(c.f, applySourceRootCompletion(c.plan.plan_id, c.plan.plan_hash))
  expect(await c.receipt()).toEqual(before)
  await c.f.run(c.f.repository.saveOperation(c.f.operation))
  const key = `objects/${c.f.originalPlan.items[0]!.candidate!.files[0]!.hash}`
  c.f.objects.set(key, encode("Different original source bytes"))
  await failed(c.f, applySourceRootCompletion(c.plan.plan_id, c.plan.plan_hash))
  expect(await c.receipt()).toEqual(before)
  expect(c.f.writes).toEqual([])
}, 30000)

test("a planned operation cannot adopt an externally populated root; wrong hashes and fake terminal states also refuse", async () => {
  const c = await planned(),
    before = await c.receipt()
  await failed(
    c.f,
    applySourceRootCompletion(c.plan.plan_id, "f".repeat(64)),
    "SOURCE_ROOT_COMPLETION_REFUSED",
  )
  for (const value of [
    { ...before, phase: "body_verified" },
    { ...before, phase: "unknown" },
    { ...before, plan: { ...before.plan, before_body_verified: true } },
  ])
    await failed(c.f, decodeSourceRootCompletion(value), "SOURCE_ROOT_COMPLETION_REFUSED")
  expect(await c.receipt()).toEqual(before)
  c.f.setBody(source + tags)
  await failed(
    c.f,
    applySourceRootCompletion(c.plan.plan_id, c.plan.plan_hash),
    "SOURCE_ROOT_COMPLETION_CONFLICT",
  )
  expect(await c.receipt()).toEqual(before)
  expect(c.f.writes).toEqual([])
}, 30000)
