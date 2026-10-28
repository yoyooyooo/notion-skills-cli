import { afterAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
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
import { canonicalMain, type PortableSkill } from "../src/portable.ts"
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
  applySourceRichTextRepair,
  planSourceRichTextRepair,
  reconcileSourceRichTextRepair,
  showSourceRichTextRepair,
} from "../src/upstream-source-rich-text-repair.ts"
import {
  decodeSourceRichTextRepair,
  sourceRichTextRepairKey,
} from "../src/upstream-source-rich-text-repair-model.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

const id = (value: number) => `11111111-1111-4111-8111-${String(value).padStart(12, "0")}`
const root = id(1),
  selected = id(3),
  preserved = id(4),
  database = id(20),
  dataSource = id(21)
const subscriptionId = id(22),
  upstreamDatabase = id(23),
  upstreamDataSource = id(24)
const oldId = "p_legacy-literal-equation-fixture",
  memberKey = "skills/literal-repair-fixture"
const name = "literal-repair-fixture",
  description = "Use to verify native source repair recovery."
const beforeTime = "2026-10-18T00:00:00.000Z",
  afterTime = "2026-10-18T00:01:00.000Z"
const destination = "https://example.test/issues/1115",
  expression = " prefix uses `json` "
const sourceLeaf = `Warning $${expression}$ for json.country. See [issue](${destination}).`
const actualLeaf =
  "Warning $`" +
  expression.trim() +
  "`$ for [json.country](http://json.country). See [issue](" +
  destination +
  ")."
const prefix = "# Evidence\n\n",
  suffix = "\n\nKeep every original instruction.\n"
const source = prefix + "- " + sourceLeaf + suffix
const actual = prefix + "- " + actualLeaf + suffix
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
const testRoots: string[] = []
afterAll(() => {
  for (const path of testRoots) rmSync(path, { force: true, recursive: true })
})
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
type Fault = "before" | "after" | "wrong-ack" | "ack-read" | "after-other-edit"

/** Only the frozen upstream plan and legacy remote writing page are fixture
 * inputs. The production apply creates the unsent CREATE_CONFLICT ledger; the
 * repair's plan, claim, pending attempts, ACKs and resolutions all use real
 * production use cases. The external transport alone is simulated. */
async function fixture(initialBody: "broken" | "exact" = "broken") {
  const json = new Map<string, unknown>(),
    objects = new Map<string, Uint8Array>()
  const native = upstreamRepositoryFixture(json),
    faults: Fault[] = []
  const writes: Array<{ path: string; body: unknown; method: string }> = []
  const retiredCacheKeys: string[] = []
  let losePending = false,
    readFailure = false,
    revision = beforeTime,
    body = initialBody === "exact" ? source : actual
  let cacheScope: string | undefined
  let stateGeneration = 0
  const stateRoot = mkdtempSync(join(tmpdir(), "source-rich-text-repair-"))
  testRoots.push(stateRoot)
  const portable: PortableSkill = {
    kind: "skill",
    name,
    description,
    main: "SKILL.md",
    files: [
      canonicalMain(name, description, source, { path: "SKILL.md", bytes: new Uint8Array() }),
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
  const expectedRichText = markdownRichText(Lexer.lexInline(sourceLeaf))
  const block = (blockId: string, type: string, values: readonly unknown[]) => ({
    object: "block",
    id: blockId,
    type,
    parent: { type: "page_id", page_id: root },
    has_children: false,
    archived: false,
    in_trash: false,
    last_edited_time: beforeTime,
    last_edited_by: { object: "user", id: id(30) },
    [type]: { rich_text: values, color: "default" },
  })
  const roots: Record<string, unknown>[] = [
    block(id(2), "heading_1", [text("Evidence")]),
    block(
      selected,
      "bulleted_list_item",
      initialBody === "exact"
        ? normalized(expectedRichText)
        : [
            text("Warning "),
            {
              type: "equation",
              equation: { expression },
              plain_text: expression,
              href: null,
              annotations: { ...annotations },
            },
            text(" for "),
            text("json.country", "http://json.country/"),
            text(". See "),
            text("issue", destination),
            text("."),
          ],
    ),
    block(preserved, "paragraph", [text("Keep every original instruction.")]),
  ]
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
    References: { id: "references", type: "rich_text", rich_text: [] },
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
        if (method === "PATCH" && path === `v1/blocks/${selected}`) {
          const fault = faults.shift()
          if (fault === "before")
            return yield* Effect.fail(
              fail("WRITE_OUTCOME_UNKNOWN", "Response lost before the exact leaf changed"),
            )
          if (
            canonical(payload) !==
            canonical({ bulleted_list_item: { rich_text: expectedRichText } })
          )
            return yield* Effect.fail(
              fail("UNEXPECTED", "The transport received a different leaf effect", payload),
            )
          roots[1] = {
            ...roots[1],
            last_edited_time: afterTime,
            bulleted_list_item: { rich_text: normalized(expectedRichText), color: "default" },
          }
          revision = afterTime
          body = source
          if (fault === "after-other-edit") {
            roots[2] = {
              ...roots[2],
              paragraph: { rich_text: [text("External instruction.")], color: "default" },
            }
            body = source.replace("Keep every original instruction.", "External instruction.")
          }
          if (fault === "after" || fault === "after-other-edit")
            return yield* Effect.fail(
              fail("WRITE_OUTCOME_UNKNOWN", "Response lost after the leaf changed"),
            )
          if (fault === "ack-read") readFailure = true
          return {
            ...structuredClone(roots[1]),
            ...(fault === "wrong-ack" ? { id: id(99) } : {}),
            request_id: id(40),
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
            fail("UNEXPECTED", "A repair tried another remote mutation", { path, method, payload }),
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
        if (path === `v1/pages/${root}/markdown`)
          return {
            object: "page_markdown",
            id: root,
            markdown: body,
            truncated: false,
            unknown_block_ids: [],
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
            results: [],
            has_more: false,
            next_cursor: null,
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
    kind: "literal_dollar_equation" as const,
    block_id: selected,
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
  const assertOriginal = async () => {
    expect(await run(repository.plan(originalPlan.plan_id))).toEqual(originalPlan)
    expect(await run(repository.operation(originalPlan.plan_id))).toEqual(operation)
    expect(await run(store.integrity.inspect(originalId))).toEqual(originalIntegrity)
    expect(await run(store.integrity.inspect(oldId))).toBeUndefined()
    expect(await run(repository.bindings(subscriptionId))).toEqual([])
    expect(await run(repository.target(originalPlan.items[0]!.target_key))).toBeUndefined()
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
    properties,
    writes,
    row,
    portable,
    expectedRichText,
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
    plan = await f.run(planSourceRichTextRepair(f.input))
  expect(f.writes).toEqual([])
  expect(plan).toMatchObject({
    state: "planned",
    body_verified: false,
    source_bytes_verified: false,
    publication_completed: false,
    attempt_count: 0,
  })
  return {
    f,
    plan,
    receipt: () => f.run(showSourceRichTextRepair(plan.plan_id)),
    apply: () => f.run(applySourceRichTextRepair(plan.plan_id, plan.plan_hash)),
    reconcile: () => f.run(reconcileSourceRichTextRepair(plan.plan_id, plan.plan_hash)),
  }
}
async function failed(
  f: Awaited<ReturnType<typeof fixture>>,
  effect: Parameters<typeof f.run>[0],
  expected: string,
) {
  const result = await f.run(effect.pipe(Effect.result))
  expect(result._tag).toBe("Failure")
  if (result._tag !== "Failure") throw new Error("Expected the native safety gate to refuse")
  expect(property(result.failure).code).toBe(expected)
  return result.failure
}

test("native plan is read-only; one acknowledged leaf is independently verified before unchanged CA can plan", async () => {
  const f = await fixture()
  await failed(f, planContentAdoption(f.adoption), "CONTENT_ADOPTION_REFUSED")
  const plan = await f.run(planSourceRichTextRepair(f.input)),
    before = await f.run(showSourceRichTextRepair(plan.plan_id))
  expect(before.plan.before_body_verified).toBe(false)
  expect(before.plan.before_source_bytes_verified).toBe(false)
  expect(before.plan.source_installation).toBeDefined()
  expect(before.attempts).toEqual([])
  expect(f.writes).toEqual([])
  await failed(f, planContentAdoption(f.adoption), "SOURCE_RICH_TEXT_REPAIR_REFUSED")
  const completed = await f.run(applySourceRichTextRepair(plan.plan_id, plan.plan_hash))
  expect(completed).toMatchObject({
    state: "body_verified",
    body_verified: true,
    source_bytes_verified: false,
    publication_completed: false,
    original_history_preserved: true,
    attempt_count: 1,
  })
  expect(f.writes).toEqual([
    {
      path: `v1/blocks/${selected}`,
      method: "PATCH",
      body: { bulleted_list_item: { rich_text: f.expectedRichText } },
    },
  ])
  const receipt = await f.run(showSourceRichTextRepair(plan.plan_id))
  expect(receipt.plan).toEqual(before.plan)
  expect(receipt.attempts[0]).toMatchObject({
    outcome: "acknowledged",
    response: { id: selected, request_id: id(40) },
  })
  expect(receipt.attempts[0]?.resolution).toBeUndefined()
  expect(receipt.result?.proof).toMatchObject({
    source_proof: "not_installed",
    files: [],
    attachments: [],
  })
  await f.assertOriginal()
  f.sourceObjectsUnchanged()
  const adoption = await f.run(planContentAdoption(f.adoption))
  expect(adoption).toMatchObject({
    state: "planned",
    page_id: root,
    source_installation: { state: "pending", independently_verified: false },
  })
  const replay = await f.run(applySourceRichTextRepair(plan.plan_id, plan.plan_hash))
  expect(replay).toMatchObject({ state: "body_verified", reused: true })
  expect(await f.run(showSourceRichTextRepair(plan.plan_id))).toEqual(receipt)
  expect(f.writes).toHaveLength(1)
  await f.assertOriginal()
}, 30000)

test("an unknown exact BEFORE resolves only with a new pending CAS; reconciliation itself never sends", async () => {
  const c = await planned()
  c.f.fault("before")
  await failed(
    c.f,
    applySourceRichTextRepair(c.plan.plan_id, c.plan.plan_hash),
    "WRITE_OUTCOME_UNKNOWN",
  )
  const unknown = await c.receipt()
  expect(unknown.phase).toBe("unknown")
  expect(unknown.attempts).toHaveLength(1)
  expect(await c.reconcile()).toMatchObject({
    state: "unknown",
    observation: "exact_before",
    needs_safe_apply: true,
  })
  expect(await c.receipt()).toEqual(unknown)
  expect(c.f.writes).toHaveLength(1)
  expect(await c.apply()).toMatchObject({ state: "body_verified", attempt_count: 2 })
  const complete = await c.receipt()
  expect(complete.attempts[0]).toMatchObject({
    ...unknown.attempts[0],
    resolution: { outcome: "known_not_applied" },
  })
  expect(complete.attempts[1]?.outcome).toBe("acknowledged")
  expect(c.f.writes).toHaveLength(2)
  await c.f.assertOriginal()
}, 30000)

test("an unknown exact AFTER is independently proven without replay or fabricated acknowledgement", async () => {
  const c = await planned()
  c.f.fault("after")
  await failed(
    c.f,
    applySourceRichTextRepair(c.plan.plan_id, c.plan.plan_hash),
    "WRITE_OUTCOME_UNKNOWN",
  )
  const unknown = await c.receipt()
  expect(await c.reconcile()).toMatchObject({
    state: "body_verified",
    attempt_count: 1,
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
}, 30000)

test("a crash after durable pending and before transport remains exact BEFORE without erasing that attempt", async () => {
  const c = await planned()
  c.f.crashAfterPending()
  await failed(c.f, applySourceRichTextRepair(c.plan.plan_id, c.plan.plan_hash), "STORAGE_ERROR")
  const pending = await c.receipt()
  expect(pending.phase).toBe("pending")
  expect(pending.attempts[0]?.outcome).toBe("pending")
  expect(c.f.writes).toEqual([])
  expect(await c.reconcile()).toMatchObject({
    state: "pending",
    observation: "exact_before",
    needs_safe_apply: true,
  })
  expect(await c.receipt()).toEqual(pending)
  expect(await c.apply()).toMatchObject({ state: "body_verified", attempt_count: 2 })
  const complete = await c.receipt()
  expect(complete.attempts[0]).toMatchObject({
    outcome: "pending",
    resolution: { outcome: "known_not_applied" },
  })
  expect(complete.attempts[0]?.response).toBeUndefined()
  expect(c.f.writes).toHaveLength(1)
  await c.f.assertOriginal()
}, 30000)

test("a genuine ACK survives a failed fresh read and resumes verification without another PATCH", async () => {
  const c = await planned()
  c.f.fault("ack-read")
  await failed(c.f, applySourceRichTextRepair(c.plan.plan_id, c.plan.plan_hash), "ACCESS_DENIED")
  const acknowledged = await c.receipt()
  expect(acknowledged.phase).toBe("acknowledged")
  expect(acknowledged.attempts[0]?.outcome).toBe("acknowledged")
  expect(acknowledged.result).toBeUndefined()
  expect(await c.reconcile()).toMatchObject({ state: "body_verified", attempt_count: 1 })
  expect((await c.receipt()).attempts).toEqual(acknowledged.attempts)
  expect(c.f.writes).toHaveLength(1)
  await c.f.assertOriginal()
}, 30000)

test("a mismatched response is retained as untrusted and only actual full AFTER can resolve it", async () => {
  const c = await planned()
  c.f.fault("wrong-ack")
  await failed(
    c.f,
    applySourceRichTextRepair(c.plan.plan_id, c.plan.plan_hash),
    "SOURCE_RICH_TEXT_REPAIR_ACK_INVALID",
  )
  const unknown = await c.receipt()
  expect(unknown.attempts[0]).toMatchObject({
    outcome: "unknown",
    untrusted_response: { id: id(99) },
    failure: { code: "SOURCE_RICH_TEXT_REPAIR_ACK_INVALID" },
  })
  expect(unknown.attempts[0]?.response).toBeUndefined()
  expect(await c.reconcile()).toMatchObject({ state: "body_verified", attempt_count: 1 })
  const complete = await c.receipt()
  expect(complete.attempts[0]).toMatchObject({
    ...unknown.attempts[0],
    resolution: { outcome: "observed_applied" },
  })
  expect(complete.attempts[0]?.response).toBeUndefined()
  expect(c.f.writes).toHaveLength(1)
}, 30000)

test("another physical block changing after an unknown result fences the repair without replay", async () => {
  const c = await planned()
  c.f.fault("after-other-edit")
  await failed(
    c.f,
    applySourceRichTextRepair(c.plan.plan_id, c.plan.plan_hash),
    "WRITE_OUTCOME_UNKNOWN",
  )
  const unknown = await c.receipt()
  await failed(
    c.f,
    reconcileSourceRichTextRepair(c.plan.plan_id, c.plan.plan_hash),
    "SOURCE_RICH_TEXT_REPAIR_CONFLICT",
  )
  const conflict = await c.receipt()
  expect(conflict.phase).toBe("conflict")
  expect(conflict.attempts).toEqual(unknown.attempts)
  expect(conflict.result).toBeUndefined()
  await failed(
    c.f,
    applySourceRichTextRepair(c.plan.plan_id, c.plan.plan_hash),
    "SOURCE_RICH_TEXT_REPAIR_CONFLICT",
  )
  await failed(c.f, planContentAdoption(c.f.adoption), "SOURCE_RICH_TEXT_REPAIR_REFUSED")
  expect(c.f.writes).toHaveLength(1)
  await c.f.assertOriginal()
}, 30000)

for (const field of ["body", "editor"] as const)
  test(`an ACK is insufficient when a later ${field} changes`, async () => {
    const c = await planned()
    c.f.fault("ack-read")
    await failed(c.f, applySourceRichTextRepair(c.plan.plan_id, c.plan.plan_hash), "ACCESS_DENIED")
    const acknowledged = await c.receipt()
    if (field === "body") c.f.setBody(source + "\nExternal instruction.\n")
    else
      c.f.properties.Editor = {
        id: "editor",
        type: "last_edited_by",
        last_edited_by: { object: "user", id: id(31) },
      }
    const result = await c.f.run(
      reconcileSourceRichTextRepair(c.plan.plan_id, c.plan.plan_hash).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    const retained = await c.receipt()
    expect(retained.phase).not.toBe("body_verified")
    expect(retained.attempts).toEqual(acknowledged.attempts)
    expect(retained.result).toBeUndefined()
    expect(c.f.writes).toHaveLength(1)
  }, 30000)

test("the frozen whole native authority and exact source bytes are rechecked before a first PATCH", async () => {
  for (const changed of [
    "operation",
    "projection-command",
    "subscription",
    "source-object",
  ] as const) {
    const c = await planned(),
      before = await c.receipt()
    if (changed === "operation")
      await c.f.run(c.f.repository.saveOperation({ ...c.f.operation, state: "running" }))
    else if (changed === "projection-command")
      await c.f.run(
        c.f.repository.saveCommand(`${c.f.operation.operation_id}:projections`, {
          operation_id: `${c.f.operation.operation_id}:projections`,
          entries: [{ target_key: "new-external-target" }],
        }),
      )
    else if (changed === "subscription") c.f.changeSubscription()
    else {
      const key = `objects/${c.f.originalPlan.items[0]!.candidate!.files[0]!.hash}`
      c.f.objects.set(key, encode("Different frozen source bytes"))
    }
    const result = await c.f.run(
      applySourceRichTextRepair(c.plan.plan_id, c.plan.plan_hash).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    expect(await c.receipt()).toEqual(before)
    expect(c.f.writes).toEqual([])
  }
}, 30000)

test("an already planned content adoption fences a repair before any new claim or PATCH", async () => {
  const f = await fixture("exact")
  const adoption = await f.run(planContentAdoption(f.adoption))
  expect(adoption.state).toBe("planned")
  expect(
    await f.run(f.repository.command(contentAdoptionMemberKey(f.originalPlan.plan_id, 0))),
  ).toEqual({ plan_id: adoption.plan_id })
  await failed(f, planSourceRichTextRepair(f.input), "SOURCE_RICH_TEXT_REPAIR_REFUSED")
  expect(
    await f.run(f.repository.command(sourceRichTextRepairKey(f.originalPlan.plan_id, 0))),
  ).toBeUndefined()
  expect(f.writes).toEqual([])
  await f.assertOriginal()
}, 30000)

test("wrong reviewed hashes and contradictory terminal receipts fail closed without changing the claim", async () => {
  const c = await planned(),
    before = await c.receipt()
  await failed(
    c.f,
    applySourceRichTextRepair(c.plan.plan_id, "f".repeat(64)),
    "SOURCE_RICH_TEXT_REPAIR_REFUSED",
  )
  for (const value of [
    { ...before, phase: "body_verified" },
    { ...before, phase: "unknown" },
    { ...before, plan: { ...before.plan, before_body_verified: true } },
    { ...before, plan: { ...before.plan, effect: { ...before.plan.effect, block_id: preserved } } },
  ])
    await failed(c.f, decodeSourceRichTextRepair(value), "SOURCE_RICH_TEXT_REPAIR_REFUSED")
  expect(await c.receipt()).toEqual(before)
  expect(c.f.writes).toEqual([])
}, 30000)
