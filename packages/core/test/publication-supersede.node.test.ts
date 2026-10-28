import { expect, test } from "vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { Clock, ConfigProvider, Effect, Layer } from "effect"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { createPortable } from "../src/mutation.ts"
import { Notion } from "../src/notion.ts"
import { fail, property, text } from "../src/model.ts"
import type { PortableSkill } from "../src/portable.ts"
import { Store, StoreLive, sha256 } from "../src/store.ts"
import { PublicationReceiptSchema, type Receipt } from "../src/publication-model.ts"
import { publicationMarker } from "../src/publication-integrity.ts"
import { creationProofFromBody } from "../src/publication-create-identity.ts"
import { openSkill, readSkill } from "../src/snapshot.ts"
import { snapshotAuthoredPortable } from "../src/export.ts"
import { supersedeApplyOperation, supersedePlanOperation } from "../src/publication-supersede.ts"
import { publicationSourceRows, publicationSourceSchema } from "./fixtures.ts"

const database = "44444444-4444-4444-8444-444444444444"
const dataSource = "55555555-5555-4555-8555-555555555555"
const oldRoot = "11111111-1111-4111-8111-111111111111"
const newRoot = "22222222-2222-4222-8222-222222222222"
const operation = "p_supersede-original"
const encoder = new TextEncoder()
const portable: PortableSkill = {
  kind: "skill",
  name: "Supersede Skill",
  description: "Use for explicit creation after an unknown result.",
  main: "SKILL.md",
  files: [
    {
      path: "SKILL.md",
      bytes: encoder.encode("# Frozen instructions\n\nKeep the original source.\n"),
    },
  ],
}
const rich = (content: string) => ({
  type: "rich_text",
  rich_text: content ? [{ type: "text", text: { content, link: null }, plain_text: content }] : [],
})
const title = (content: string) => ({
  type: "title",
  title: [{ text: { content }, plain_text: content }],
})
interface Page {
  id: string
  parent: Record<string, string>
  properties: Record<string, unknown>
  body: string
  revision: number
  visible: boolean
}

interface OriginalRows {
  publication: Record<string, unknown> | undefined
  intents: Array<Record<string, unknown>>
  integrity: Record<string, unknown> | undefined
}
interface Fixture {
  run: <A, E>(effect: Effect.Effect<A, E, any>) => Promise<A>
  receipt: (id?: string) => Promise<Receipt | undefined>
  rawOriginal: () => OriginalRows
  pages: Map<string, Page>
  requests: Array<{ path: string; method: string; body: unknown }>
  mutations: Array<{ path: string; method: string; body: unknown }>
  rootPosts: unknown[]
  childPosts: unknown[]
  directory: string
  time: (value: number) => void
  credential: (value: string) => void
  query: (value: "paged" | "partial" | "repeat_cursor") => void
  revealOriginal: () => void
  enableSource: () => void
  close: () => Promise<void>
}

// Controlled Notion transport, real publication engine, official Node SQL StoreLive.
// Every run closes its SQL scope; the next call must reopen durable plans and receipts.
async function fixture(failure: "root" | "child" = "root"): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "ntn-publication-supersede-"))
  const pages = new Map<string, Page>()
  const requests: Array<{ path: string; method: string; body: unknown }> = []
  const mutations: Array<{ path: string; method: string; body: unknown }> = []
  const rootPosts: unknown[] = []
  const childPosts: unknown[] = []
  let interrupted = false
  let now = 1_000_000
  let credential = "supersede-credential"
  let queryMode: "paged" | "partial" | "repeat_cursor" = "paged"
  let childSequence = 0
  let sourceAvailable = false
  const schema = () => ({
    Name: { id: "title", ...title("") },
    Description: { id: "description", ...rich("") },
    References: { id: "references", ...rich("") },
    Publication: { id: "publication", ...rich("") },
    Kind: { id: "kind", type: "select", select: { name: "skill" } },
    ...(sourceAvailable ? structuredClone(publicationSourceRows) : {}),
  })
  const saveProperties = (page: Page, raw: unknown) => {
    for (const [key, rawValue] of Object.entries(property(raw))) {
      const name =
        (
          {
            title: "Name",
            description: "Description",
            references: "References",
            publication: "Publication",
            kind: "Kind",
          } as Record<string, string>
        )[key] ?? key
      const value = structuredClone(property(rawValue))
      const type = Array.isArray(value.title)
        ? "title"
        : Array.isArray(value.rich_text)
          ? "rich_text"
          : value.select
            ? "select"
            : undefined
      if (Array.isArray(value.rich_text))
        value.rich_text = value.rich_text.map((raw) => ({
          ...property(raw),
          plain_text: String(property(property(raw).text).content ?? ""),
        }))
      if (Array.isArray(value.title))
        value.title = value.title.map((raw) => ({
          ...property(raw),
          plain_text: String(property(property(raw).text).content ?? ""),
        }))
      page.properties[name] = { id: key, ...(type ? { type } : {}), ...value }
    }
  }
  const row = (page: Page) =>
    structuredClone({
      id: page.id,
      parent: page.parent,
      properties: page.properties,
      last_edited_time: new Date(Date.UTC(2026, 9, 18) + page.revision * 1000).toISOString(),
      archived: false,
      in_trash: false,
    })
  const children = (id: string) =>
    [...pages.values()].filter((page) => page.visible && page.parent.page_id === id)
  const markdown = (page: Page) => {
    const tags = children(page.id).map(
      (child) =>
        `<page url="https://www.notion.so/${child.id.replaceAll("-", "")}">${text(property(child.properties.Name).title)}</page>`,
    )
    return `${page.body}${tags.length ? `\n${tags.join("\n")}` : ""}`
  }
  const api = Notion.of({
    version: Effect.succeed("supersede-node-transport"),
    credentialIdentity: Effect.sync(() => credential),
    request: (path, payload, options) =>
      Effect.gen(function* () {
        const method = options?.method ?? (payload === undefined ? "GET" : "POST")
        const call = { path, method, body: structuredClone(payload) }
        requests.push(call)
        if (method !== "GET" && !path.endsWith("/query")) mutations.push(call)
        if (path === "v1/users/me") return { id: "supersede-user", object: "user" }
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
            properties: {
              ...schema(),
              ...(sourceAvailable ? structuredClone(publicationSourceSchema) : {}),
            },
          }
        if (path === `v1/data_sources/${dataSource}/query`) {
          if (queryMode === "partial") return { results: [], has_more: true, next_cursor: null }
          if (!property(payload).start_cursor || queryMode === "repeat_cursor")
            return { results: [], has_more: true, next_cursor: "second" }
          return {
            results: [...pages.values()]
              .filter((page) => page.visible && page.parent.data_source_id === dataSource)
              .map(row),
            has_more: false,
            next_cursor: null,
          }
        }
        if (path === "v1/pages") {
          const parent = property(property(payload).parent)
          const root = typeof parent.data_source_id === "string"
          if (root) rootPosts.push(structuredClone(payload))
          else childPosts.push(structuredClone(payload))
          const lose =
            !interrupted && (failure === "root" ? root : !root && childPosts.length === 2)
          const id = root
            ? rootPosts.length === 1
              ? oldRoot
              : newRoot
            : `33333333-3333-4333-8333-${String(++childSequence).padStart(12, "0")}`
          const page: Page = {
            id,
            parent: root
              ? { database_id: database, data_source_id: String(parent.data_source_id) }
              : { type: "page_id", page_id: String(parent.page_id) },
            properties: root ? schema() : {},
            body: "",
            revision: 0,
            visible: !lose,
          }
          saveProperties(page, property(payload).properties)
          const blocks = property(payload).children
          if (Array.isArray(blocks))
            page.body = blocks
              .map((raw) => text(property(property(raw).paragraph).rich_text))
              .join("\n")
          pages.set(id, page)
          if (lose) {
            interrupted = true
            return yield* Effect.fail(
              fail(
                "WRITE_OUTCOME_UNKNOWN",
                "Initial creation response lost; its object is not API-visible.",
              ),
            )
          }
          return row(page)
        }
        const id = path.split("/")[2]!
        const page = pages.get(id)
        if (!page?.visible)
          return yield* Effect.fail(fail("OBJECT_NOT_FOUND", "Page is not API-visible", { path }))
        if (path === `v1/pages/${id}`) {
          if (method === "PATCH") {
            saveProperties(page, property(payload).properties)
            page.revision++
          }
          return row(page)
        }
        if (path.startsWith(`v1/pages/${id}/properties/references`))
          return {
            results: (property(page.properties.References).rich_text as unknown[]).map(
              (rich_text) => ({ rich_text }),
            ),
            has_more: false,
            next_cursor: null,
          }
        if (path === `v1/pages/${id}/markdown`) {
          if (method === "PATCH") {
            page.body = String(property(property(payload).replace_content).new_str)
              .replace(/<page\b[^>]*>[\s\S]*?<\/page>/g, "")
              .trim()
            page.revision++
          }
          return {
            object: "page_markdown",
            markdown: markdown(page),
            truncated: false,
            unknown_block_ids: [],
          }
        }
        if (path.startsWith(`v1/blocks/${id}/children?`))
          return {
            results: [
              ...(page.body.startsWith("ntn-skills-create:v1:")
                ? [
                    {
                      id: `${page.id}-creation`,
                      type: "paragraph",
                      has_children: false,
                      parent: { type: "page_id", page_id: page.id },
                      paragraph: {
                        rich_text: [
                          {
                            type: "text",
                            text: { content: page.body.split("\n")[0] },
                            plain_text: page.body.split("\n")[0],
                            annotations: { bold: false, code: false },
                          },
                        ],
                      },
                    },
                  ]
                : []),
              ...children(id).map((child) => ({
                id: child.id,
                type: "child_page",
                has_children: false,
                parent: { type: "page_id", page_id: page.id },
                child_page: { title: text(property(child.properties.Name).title) },
              })),
            ],
            has_more: false,
            next_cursor: null,
          }
        return yield* Effect.fail(
          fail("UNEXPECTED", `Unexpected supersede transport request ${method} ${path}`),
        )
      }),
  })
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    sleep: () => Effect.void,
  }
  const config = ConfigProvider.fromUnknown({
    NTN_SKILLS_HOME: join(directory, "state"),
    NTN_SKILLS_CONFIG_HOME: join(directory, "config"),
    NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
  })
  const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
    Effect.runPromise(
      Effect.scoped(effect).pipe(
        Effect.provide(
          StoreLive.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                NodeServices.layer,
                NodeHttpClient.layerFetch,
                Layer.succeed(Notion, api),
              ),
            ),
          ),
        ),
        Effect.provide(ConfigProvider.layer(config)),
        Effect.provideService(Clock.Clock, clock),
      ) as Effect.Effect<A, E>,
    )
  const receipt = (id = operation) =>
    run(
      Effect.flatMap(Store, (store) =>
        store.readJson(`publications/${id}.json`, PublicationReceiptSchema),
      ),
    )
  const rawOriginal = () => {
    const sql = new DatabaseSync(join(directory, "state", "state.sqlite"))
    try {
      return {
        publication: sql.prepare("SELECT * FROM publications WHERE id = ?").get(operation),
        intents: sql
          .prepare("SELECT * FROM publication_intents WHERE operation_id = ? ORDER BY sequence")
          .all(operation),
        integrity: sql
          .prepare("SELECT * FROM integrity_operations WHERE operation_id = ?")
          .get(operation),
      }
    } finally {
      sql.close()
    }
  }
  return {
    run,
    receipt,
    rawOriginal,
    pages,
    requests,
    mutations,
    rootPosts,
    childPosts,
    directory,
    enableSource: () => {
      sourceAvailable = true
    },
    time: (value: number) => {
      now = value
    },
    credential: (value: string) => {
      credential = value
    },
    query: (value: typeof queryMode) => {
      queryMode = value
    },
    revealOriginal: () => {
      pages.get(oldRoot)!.visible = true
    },
    close: () => rm(directory, { recursive: true, force: true }),
  }
}

async function withFixture(use: (f: Fixture) => Promise<void>, failure: "root" | "child" = "root") {
  const f = await fixture(failure)
  try {
    await use(f)
  } finally {
    await f.close()
  }
}
async function stopInitial(f: Fixture, source = portable) {
  const stopped = await f.run(
    createPortable(source, { database, operationId: operation }).pipe(Effect.result),
  )
  expect(stopped).toMatchObject({ _tag: "Failure", failure: { code: "WRITE_OUTCOME_UNKNOWN" } })
  const receipt = (await f.receipt())!
  expect(receipt.state).toBe("unknown")
  const intentIndex = receipt.intents.findIndex(
    (intent) => intent.path === "v1/pages" && intent.status === "unknown",
  )
  expect(intentIndex).toBeGreaterThanOrEqual(0)
  expect(receipt.intents[intentIndex]!.response).toBeUndefined()
  return { receipt, intentIndex }
}
const planFor = (intentIndex: number) =>
  supersedePlanOperation(operation, {
    intentIndex,
    operatorIntent: "Create one new publication while retaining the original unknown for review.",
  })
const apply = (plan: { plan_id: string; guard_hash: string }) =>
  supersedeApplyOperation(plan.plan_id, { guardHash: plan.guard_hash })
async function refuseWithoutMutation<A, E>(
  f: Fixture,
  effect: Effect.Effect<A, E, any>,
  before: OriginalRows,
) {
  const writes = f.mutations.length
  const result = await f.run(effect.pipe(Effect.result))
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { code: "PUBLICATION_SUPERSEDE_REFUSED" },
  })
  expect(f.mutations).toHaveLength(writes)
  expect(f.rawOriginal()).toEqual(before)
}

test("supersede reopens a query-zero plan, creates one new root, and exposes a complete normal read without touching the original unknown", async () => {
  await withFixture(async (f) => {
    const { receipt, intentIndex } = await stopInitial(f)
    const original = f.rawOriginal()
    const start = f.requests.length,
      writes = f.mutations.length
    const plan = await f.run(planFor(intentIndex))
    expect(plan).toMatchObject({
      old_operation_id: operation,
      old_intent_index: intentIndex,
      target_kind: "root",
      parent_id: dataSource,
      discovery: { complete: true, candidate_count: 0, outcome: "unknown" },
      original: receipt,
    })
    expect(plan.new_operation_id).not.toBe(operation)
    expect(plan.expires_at_ms - plan.created_at_ms).toBe(300_000)
    expect(plan.operator_intent).toContain("one new publication")
    expect(plan.risk).toContain("old unknown remains under review")
    expect(
      f.requests
        .slice(start)
        .filter(({ path }) => path.endsWith("/query"))
        .map(({ body }) => property(body).start_cursor),
    ).toEqual([undefined, "second"])
    expect(f.mutations).toHaveLength(writes)
    expect(f.rawOriginal()).toEqual(original)
    await f.run(
      Effect.flatMap(Store, (store) =>
        store.upstream.command(`publication-supersede:plan:${plan.plan_id}`),
      ).pipe(
        Effect.tap((saved) =>
          Effect.sync(() => expect(saved).toMatchObject({ state: "planned", plan })),
        ),
      ),
    )
    const result = await f.run(apply(plan))
    expect(result.state).toBe("verified")
    expect(f.rootPosts).toHaveLength(2)
    const newReceipt = (await f.receipt(plan.new_operation_id))!
    expect(newReceipt).toMatchObject({
      state: "completed",
      operation_id: plan.new_operation_id,
      page_id: newRoot,
    })
    expect(newReceipt.intents.filter((intent) => intent.path === "v1/pages")).toHaveLength(1)
    expect(creationProofFromBody(f.rootPosts[1])?.operation_id).toBe(plan.new_operation_id)
    expect(creationProofFromBody(f.rootPosts[1])?.operation_token).not.toBe(
      creationProofFromBody(f.rootPosts[0])?.operation_token,
    )
    expect(publicationMarker({ properties: f.pages.get(newRoot)!.properties })).toMatchObject({
      state: "committed",
      operation_id: plan.new_operation_id,
    })
    expect(f.rawOriginal()).toEqual(original)
    const read = await f.run(readSkill(newRoot, { database, refresh: true }))
    expect(read).toMatchObject({ path: "SKILL.md", has_more: false })
    expect("content" in read && read.content).toContain("Keep the original source.")
    expect("content" in read && read.content).not.toContain("ntn-skills-create:")
    const snapshot = await f.run(openSkill(newRoot, { database, refresh: true }))
    const saved = await f.run(snapshotAuthoredPortable(snapshot))
    expect(saved.files.map(({ path }) => path)).toEqual(["SKILL.md"])
    expect(new TextDecoder().decode(saved.files[0]!.bytes)).toContain("# Frozen instructions")
    f.revealOriginal()
    expect(publicationMarker({ properties: f.pages.get(oldRoot)!.properties })).toMatchObject({
      state: "writing",
      operation_id: operation,
    })
    const after = f.mutations.length
    expect(await f.run(apply(plan))).toEqual(result)
    expect(f.mutations).toHaveLength(after)
    expect(f.rootPosts).toHaveLength(2)
    expect(f.rawOriginal()).toEqual(original)
    await refuseWithoutMutation(f, planFor(intentIndex), original)
  })
}, 30_000)

test("root supersede keeps frozen unavailable origin after the content schema becomes provenance-aware", async () => {
  await withFixture(async (f) => {
    const { receipt, intentIndex } = await stopInitial(f)
    expect(receipt.context?.source_intent).toEqual({ mode: "manual_when_supported" })
    expect(receipt.source_binding).toEqual({ status: "unavailable", data_source_id: dataSource })
    f.enableSource()
    const plan = await f.run(planFor(intentIndex))
    expect((await f.run(apply(plan))).state).toBe("verified")
    const successor = (await f.receipt(plan.new_operation_id))!
    expect(successor.context?.source_intent).toEqual(receipt.context?.source_intent)
    expect(successor.source_binding).toEqual(receipt.source_binding)
    expect(property(f.pages.get(newRoot)!.properties["Source Type"]).select).toBeNull()
    expect(property(f.pages.get(newRoot)!.properties["Builtin ID"]).rich_text).toEqual([])
    expect(
      f.mutations.some((request) =>
        Object.hasOwn(property(property(request.body).properties), "Source Type"),
      ),
    ).toBe(false)
  })
}, 30_000)

test("a delayed original with a different publication marker is never selected as the superseding identity", async () => {
  await withFixture(async (f) => {
    const { intentIndex } = await stopInitial(f)
    const original = f.rawOriginal()
    const delayed = f.pages.get(oldRoot)!
    const marker = publicationMarker({ properties: delayed.properties })!
    delayed.properties.Publication = {
      id: "publication",
      ...rich(JSON.stringify({ ...marker, operation_id: "p_other-delayed" })),
    }
    delayed.properties.Name = { id: "title", ...title("Other delayed skill") }
    delayed.visible = true
    const delayedBefore = structuredClone(delayed)
    const plan = await f.run(planFor(intentIndex))
    expect(plan.discovery.candidate_page_ids).toEqual([])
    await f.run(apply(plan))
    expect((await f.receipt(plan.new_operation_id))!.page_id).toBe(newRoot)
    expect(f.pages.get(oldRoot)).toEqual(delayedBefore)
    expect(f.mutations.some(({ path }) => path.startsWith(`v1/pages/${oldRoot}`))).toBe(false)
    expect(f.rawOriginal()).toEqual(original)
  })
}, 30_000)

for (const mode of ["partial", "repeat_cursor"] as const) {
  test(`supersede refuses ${mode} discovery before claiming a new creation`, async () => {
    await withFixture(async (f) => {
      const { intentIndex } = await stopInitial(f)
      const original = f.rawOriginal(),
        writes = f.mutations.length
      f.query(mode)
      const result = await f.run(planFor(intentIndex).pipe(Effect.result))
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: "INVALID_RESPONSE" } })
      expect(f.rootPosts).toHaveLength(1)
      expect(f.mutations).toHaveLength(writes)
      expect(f.rawOriginal()).toEqual(original)
    })
  })
}

for (const moment of ["plan", "apply"] as const) {
  test(`an exact unique original discovered during ${moment} refuses supersede without adopting or rewriting it`, async () => {
    await withFixture(async (f) => {
      const { intentIndex } = await stopInitial(f)
      const original = f.rawOriginal()
      const plan = moment === "apply" ? await f.run(planFor(intentIndex)) : undefined
      f.revealOriginal()
      if (plan) await refuseWithoutMutation(f, apply(plan), original)
      else await refuseWithoutMutation(f, planFor(intentIndex), original)
      expect(f.rootPosts).toHaveLength(1)
      expect(f.requests.some(({ path }) => path === `v1/pages/${oldRoot}/markdown`)).toBe(true)
      expect((await f.receipt())!.page_id).toBeUndefined()
    })
  })
}

for (const time of ["expired", "clock_backwards"] as const) {
  test(`an ${time} exact plan refuses before issuing a new root POST`, async () => {
    await withFixture(async (f) => {
      const { intentIndex } = await stopInitial(f)
      const plan = await f.run(planFor(intentIndex)),
        original = f.rawOriginal()
      f.time(time === "expired" ? plan.expires_at_ms + 1 : plan.created_at_ms - 1)
      await refuseWithoutMutation(f, apply(plan), original)
      expect(f.rootPosts).toHaveLength(1)
    })
  })
}

test("the reviewed plan remains valid at exactly five minutes", async () => {
  await withFixture(async (f) => {
    const { intentIndex } = await stopInitial(f)
    const plan = await f.run(planFor(intentIndex)),
      original = f.rawOriginal()
    f.time(plan.expires_at_ms)
    expect((await f.run(apply(plan))).state).toBe("verified")
    expect(f.rootPosts).toHaveLength(2)
    expect(f.rawOriginal()).toEqual(original)
  })
}, 30_000)

test("a changed guard hash or authentication scope never consumes the accepted creation plan", async () => {
  await withFixture(async (f) => {
    const { intentIndex } = await stopInitial(f)
    const plan = await f.run(planFor(intentIndex)),
      original = f.rawOriginal()
    await refuseWithoutMutation(
      f,
      supersedeApplyOperation(plan.plan_id, { guardHash: "f".repeat(64) }),
      original,
    )
    f.credential("foreign-credential")
    await refuseWithoutMutation(f, apply(plan), original)
    expect(f.rootPosts).toHaveLength(1)
    f.credential("supersede-credential")
    expect((await f.run(apply(plan))).state).toBe("verified")
  })
}, 30_000)

test("a foreign parent substituted into the old pending creation is refused", async () => {
  await withFixture(async (f) => {
    const { receipt, intentIndex } = await stopInitial(f)
    const plan = await f.run(planFor(intentIndex))
    const changed: Receipt = structuredClone(receipt)
    changed.intents[intentIndex] = {
      ...changed.intents[intentIndex]!,
      body: {
        ...property(changed.intents[intentIndex]!.body),
        parent: { data_source_id: "foreign-source" },
      },
    }
    await f.run(
      Effect.flatMap(Store, (store) => store.writeJson(`publications/${operation}.json`, changed)),
    )
    await refuseWithoutMutation(f, apply(plan), f.rawOriginal())
    expect(f.rootPosts).toHaveLength(1)
  })
})

test("changing the frozen source bytes after plan refuses apply without replacing the old unknown", async () => {
  await withFixture(async (f) => {
    const { receipt, intentIndex } = await stopInitial(f)
    const plan = await f.run(planFor(intentIndex)),
      original = f.rawOriginal()
    await writeFile(
      join(f.directory, "state", "objects", receipt.portable.files[0]!.sha256),
      "Changed frozen source",
    )
    await refuseWithoutMutation(f, apply(plan), original)
    expect(f.rootPosts).toHaveLength(1)
  })
})

test("changing the retained source digest to another valid object refuses the reviewed plan", async () => {
  await withFixture(async (f) => {
    const { receipt, intentIndex } = await stopInitial(f)
    const plan = await f.run(planFor(intentIndex))
    const changed: Receipt = structuredClone(receipt)
    await f.run(
      Effect.gen(function* () {
        const store = yield* Store
        const bytes = encoder.encode("# Different frozen source\n")
        const hash = yield* sha256(bytes)
        yield* store.writeBytes(`objects/${hash}`, bytes)
        changed.portable.files[0] = { ...changed.portable.files[0]!, sha256: hash }
        yield* store.writeJson(`publications/${operation}.json`, changed)
      }),
    )
    await refuseWithoutMutation(f, apply(plan), f.rawOriginal())
    expect(f.rootPosts).toHaveLength(1)
  })
})

test("issuing a replacement review plan invalidates the older unconsumed plan", async () => {
  await withFixture(async (f) => {
    const { intentIndex } = await stopInitial(f)
    const first = await f.run(planFor(intentIndex)),
      original = f.rawOriginal()
    const accepted = await f.run(planFor(intentIndex))
    expect(accepted.plan_id).not.toBe(first.plan_id)
    await refuseWithoutMutation(f, apply(first), original)
    expect((await f.run(apply(accepted))).state).toBe("verified")
    expect(f.rootPosts).toHaveLength(2)
    expect(f.rawOriginal()).toEqual(original)
  })
}, 30_000)

const childPortable: PortableSkill = {
  ...portable,
  files: [
    ...portable.files,
    {
      path: "references/guide.md",
      bytes: encoder.encode("# Guide\n\nKeep the existing sibling.\n"),
    },
    {
      path: "references/policy.md",
      bytes: encoder.encode("# Policy\n\nCreate only the missing reference.\n"),
    },
  ],
}

test("a missing child supersede retains its known root and sibling identities and completes normal reference reads", async () => {
  await withFixture(async (f) => {
    const { receipt, intentIndex } = await stopInitial(f, childPortable)
    expect(receipt.page_id).toBe(oldRoot)
    const original = f.rawOriginal()
    const sibling = [...f.pages.values()].find(
      (page) => page.visible && page.parent.page_id === oldRoot,
    )!
    const siblingId = sibling.id
    const writes = f.mutations.length
    const plan = await f.run(planFor(intentIndex))
    expect(plan).toMatchObject({ target_kind: "child", parent_id: oldRoot })
    expect(plan.owned_known_siblings).toEqual(expect.arrayContaining([oldRoot, siblingId]))
    expect(f.mutations).toHaveLength(writes)
    expect(f.rawOriginal()).toEqual(original)
    await f.run(apply(plan))
    expect(f.rootPosts).toHaveLength(1)
    expect(f.childPosts).toHaveLength(3)
    const newReceipt = (await f.receipt(plan.new_operation_id))!
    expect(newReceipt).toMatchObject({ state: "completed", page_id: oldRoot })
    expect(f.pages.get(siblingId)!.visible).toBe(true)
    expect(creationProofFromBody(f.childPosts[2])?.operation_id).toBe(plan.new_operation_id)
    const snapshot = await f.run(openSkill(oldRoot, { database, refresh: true }))
    expect(snapshot.references?.find(({ path }) => path === "references/guide.md")?.id).toBe(
      siblingId,
    )
    expect(snapshot.references).toHaveLength(3)
    const guide = await f.run(
      readSkill(oldRoot, { database, refresh: true, path: "references/guide.md" }),
    )
    const policy = await f.run(
      readSkill(oldRoot, { database, refresh: true, path: "references/policy.md" }),
    )
    expect("content" in guide && guide.content).toContain("Keep the existing sibling.")
    expect("content" in policy && policy.content).toContain("Create only the missing reference.")
    expect(f.rawOriginal()).toEqual(original)
    const after = f.mutations.length
    await f.run(apply(plan))
    expect(f.mutations).toHaveLength(after)
    expect(f.childPosts).toHaveLength(3)
  }, "child")
}, 30_000)

test("a known sibling edit after a child plan refuses all superseding mutations", async () => {
  await withFixture(async (f) => {
    const { intentIndex } = await stopInitial(f, childPortable)
    const plan = await f.run(planFor(intentIndex)),
      original = f.rawOriginal()
    const sibling = [...f.pages.values()].find(
      (page) => page.visible && page.parent.page_id === oldRoot,
    )!
    sibling.body = "External sibling edit"
    sibling.revision++
    await refuseWithoutMutation(f, apply(plan), original)
    expect(f.rootPosts).toHaveLength(1)
    expect(f.childPosts).toHaveLength(2)
    expect(sibling.body).toBe("External sibling edit")
  }, "child")
})
