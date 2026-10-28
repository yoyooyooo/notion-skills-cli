import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { Crypto, Effect, FileSystem, Layer, Path, Schema } from "effect"
import type { HttpClient } from "effect/http"
import { authScope } from "../src/catalog.ts"
import { decode, fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { UpstreamState } from "../src/upstream-state.ts"
import {
  creationMarker,
  creationMarkerBlock,
  type CreationProof,
} from "../src/publication-create-identity.ts"
import { canonical } from "../src/publication-effect-proof.ts"
import { PublicationReceiptSchema, type Receipt } from "../src/publication-model.ts"
import { observation } from "../src/publication-observation.ts"
import { reconcilePublication } from "../src/publication-reconcile.ts"
import { resumePublication } from "../src/mutation.ts"
import { showOperation } from "../src/command-operations.ts"
import {
  applyPublicationBodyCompletion,
  planPublicationBodyCompletion,
  reconcilePublicationBodyCompletion,
} from "../src/publication-body-completion.ts"
import {
  BodyCompletionPlanSchema,
  bodyCompletionPlanKey,
} from "../src/publication-body-completion-model.ts"
import { deriveBodyCompletion } from "../src/publication-body-completion-proof.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"
import {
  advanceCompletion,
  completionArray,
  completionChildPath,
  completionDatabase,
  completionDataSource,
  completionFind,
  completionFixture,
  completionPage,
  completionRecord,
  completionRoot,
  completionRows,
  completionSource,
  completionSpan,
} from "./fixtures/publication-body-completion.ts"

const operationId = `p_${"7".repeat(64)}`,
  sourcePath = "references/completion.md"
const receiptKey = `publications/${operationId}.json`
const encode = (value: string) => new TextEncoder().encode(value)
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
type Environment =
  | Store
  | Notion
  | UpstreamState
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
type Fault = "before" | "after" | "ack-read" | "wrong-ack" | "partial-after"

/** The original failed publication and original writing integrity are explicit
 * synthetic fixture seeds. All new plans, pending effects, real fake-transport
 * ACKs and reconciliation certificates are produced by the actual use cases. */
async function fixture() {
  const json = new Map<string, unknown>(),
    objects = new Map<string, Uint8Array>()
  const upstream = upstreamRepositoryFixture(),
    integrity = integrityRepositoryFixture(json)
  let selected = completionFixture().before,
    marker = "",
    rootRaw: Record<string, unknown> = {}
  let stage = 0,
    fault: { step: number; kind: Fault } | undefined,
    readFailure = false,
    losePending = false
  let onRead: ((path: string) => void) | undefined
  const writes: Array<{ path: string; body: unknown }> = []
  const readOverrides = new Map<string, unknown>()
  const stateRoot = mkdtempSync(join(tmpdir(), "publication-body-completion-"))
  const store: Store["Service"] = {
    root: stateRoot,
    configRoot: "/memory",
    cacheRoot: "/memory",
    upstream,
    integrity,
    reserveCacheGeneration: () => Effect.succeed(1),
    listKeys: (prefix) =>
      Effect.sync(() => [...json.keys()].filter((key) => key.startsWith(`${prefix}/`))),
    retireKeys: () => Effect.die(new Error("Unexpected retirement")),
    readJson: (key, schema) =>
      Effect.sync(() =>
        json.has(key) ? decode(schema, structuredClone(json.get(key))) : undefined,
      ),
    writeJson: (key, value) =>
      Effect.gen(function* () {
        json.set(key, structuredClone(value))
        if (
          key === receiptKey &&
          losePending &&
          property(property(value).body_completion).phase === "running"
        ) {
          const attempts = property(property(value).body_completion).attempts
          if (Array.isArray(attempts) && property(attempts.at(-1)).transport === "pending") {
            losePending = false
            return yield* Effect.fail(
              fail(
                "STORAGE_ERROR",
                "The durable pending record committed before its local response was lost.",
              ),
            )
          }
        }
      }),
    readBytes: (key) =>
      objects.has(key)
        ? Effect.succeed(objects.get(key)!.slice())
        : Effect.fail(fail("SNAPSHOT_MISSING", "Missing frozen object")),
    writeBytes: (key, value) =>
      Effect.sync(() => {
        objects.set(key, value.slice())
      }),
    registerBindingWithBase: () => Effect.die(new Error("Unexpected binding write")),
    advanceBaseAndReceipt: () => Effect.die(new Error("Unexpected base write")),
    backup: () => Effect.die(new Error("Unexpected backup")),
    output: () => Effect.die(new Error("Unexpected output")),
  }
  json.set("config.json", { default_database: completionDatabase })
  const originalTree = completionFixture()
  const rootChildren = {
    object: "list",
    type: "block",
    block: {},
    has_more: false,
    next_cursor: null,
    results: [
      {
        object: "block",
        id: completionPage,
        type: "child_page",
        child_page: { title: "completion.md" },
        parent: { type: "page_id", page_id: completionRoot },
        has_children: true,
        in_trash: false,
        archived: false,
      },
    ],
  }
  let derived = deriveBodyCompletion(completionSource, "original-creation-identity", selected)
  assert.ok(derived)
  const api: Notion["Service"] = {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("credential"),
    request: (path, body, options) =>
      Effect.gen(function* () {
        const method = options?.method ?? (body === undefined ? "GET" : "POST")
        if (method !== "GET") {
          const d = derived
          assert.ok(d)
          assert.equal(method, "PATCH")
          const expected = d.requests[stage]
          assert.ok(expected)
          expect({ method, path, body }).toEqual(expected)
          const retained = decode(PublicationReceiptSchema, json.get(receiptKey))
          const pending = retained.body_completion?.attempts.at(-1)
          expect(pending?.transport).toBe("pending")
          expect(pending?.request).toEqual(expected)
          expect(retained.intents.length).toBe(3)
          writes.push({ path, body: structuredClone(body) })
          const active = fault?.step === stage ? fault : undefined
          if (active) fault = undefined
          if (active?.kind === "before")
            return yield* Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Synthetic unknown BEFORE"))
          const effect = advanceCompletion(d, stage, selected)
          selected = effect.after
          stage++
          if (active?.kind === "partial-after") completionRows(selected, d.table_id).pop()
          if (active?.kind === "after" || active?.kind === "partial-after")
            return yield* Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Synthetic unknown AFTER"))
          if (active?.kind === "ack-read") readFailure = true
          if (active?.kind === "wrong-ack")
            return { ...property(effect.response), id: "wrong", results: [] }
          return structuredClone(effect.response)
        }
        onRead?.(path)
        if (readFailure && /^v1\/pages\//.test(path)) {
          readFailure = false
          return yield* Effect.fail(
            fail("NETWORK_ERROR", "Readback failed after the real ACK was saved"),
          )
        }
        if (path === "v1/users/me") return { object: "user", id: "fixture" }
        if (readOverrides.has(path)) return structuredClone(readOverrides.get(path))
        if (path === `v1/databases/${completionDatabase}`)
          return {
            id: completionDatabase,
            database_type: null,
            title: [],
            data_sources: [{ id: completionDataSource, name: "Skills" }],
          }
        if (path === `v1/data_sources/${completionDataSource}`)
          return {
            id: completionDataSource,
            parent: { type: "database_id", database_id: completionDatabase },
            title: [],
            properties: {
              Name: { id: "title", name: "Name", type: "title", title: {} },
              Description: {
                id: "description",
                name: "Description",
                type: "rich_text",
                rich_text: {},
              },
              References: {
                id: "references",
                name: "References",
                type: "rich_text",
                rich_text: {},
              },
            },
          }
        if (path === `v1/pages/${completionRoot}`) return structuredClone(rootRaw)
        if (path === `v1/pages/${completionRoot}/markdown`)
          return {
            object: "page_markdown",
            id: completionRoot,
            markdown: "# Root\n",
            truncated: false,
            unknown_block_ids: [],
          }
        if (path === completionChildPath(completionRoot)) return structuredClone(rootChildren)
        if (path === `v1/pages/${completionPage}`) return structuredClone(selected.page_after)
        if (path === `v1/pages/${completionPage}/markdown`)
          return structuredClone(selected.markdown)
        if (selected.inventories[path]) return structuredClone(selected.inventories[path])
        if (/^v1\/blocks\/[^/]+$/.test(path))
          return structuredClone(completionFind(selected, path.split("/")[2]!))
        return yield* Effect.fail(
          fail("UNEXPECTED", "Unexpected fake transport call", { path, method }),
        )
      }),
  }
  const layer = Layer.mergeAll(
    NodeServices.layer,
    NodeHttpClient.layerFetch,
    Layer.succeed(Store, store),
    Layer.succeed(Notion, api),
    Layer.succeed(UpstreamState, upstream),
  )
  const run = <A, E>(effect: Effect.Effect<A, E, Environment>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))
  const scope = await run(authScope)
  const main =
    "---\nname: completion\ndescription: Use for bounded completion testing.\n---\n\n# Root\n"
  const portable = {
    kind: "skill" as const,
    name: "completion",
    description: "Use for bounded completion testing.",
    main: "SKILL.md",
    files: [
      { path: "SKILL.md", sha256: hash(main) },
      { path: sourcePath, sha256: hash(completionSource) },
    ],
  }
  objects.set(`objects/${hash(main)}`, encode(main))
  objects.set(`objects/${hash(completionSource)}`, encode(completionSource))
  const intended = hash(
    canonical([
      portable.kind,
      portable.name,
      portable.description,
      portable.main,
      portable.files.map((file) => [
        file.path,
        objects.get(`objects/${file.sha256}`)!.length,
        file.sha256,
      ]),
    ]),
  )
  const writing = {
    version: 2 as const,
    operation_id: operationId,
    intended_hash: intended,
    state: "writing" as const,
  }
  const proof: CreationProof = {
    version: 1,
    operation_token: "40000000-0000-4000-8000-000000000001",
    operation_id: operationId,
    intent_index: 1,
    scope,
    database_id: completionDatabase,
    data_source_id: completionDataSource,
    role: "reference",
    path: sourcePath,
    parent_type: "page_id",
    parent_id: completionRoot,
    intended_hash: intended,
    source_sha256: hash(completionSource),
  }
  marker = creationMarker(proof)
  selected = completionFixture(marker).before
  derived = deriveBodyCompletion(completionSource, marker, selected)
  assert.ok(derived)
  const pub = {
    id: "publication",
    type: "rich_text",
    rich_text: [completionSpan(JSON.stringify(writing))],
  }
  rootRaw = {
    object: "page",
    id: completionRoot,
    parent: {
      type: "data_source_id",
      data_source_id: completionDataSource,
      database_id: completionDatabase,
    },
    properties: { Publication: pub },
    in_trash: false,
    archived: false,
    last_edited_time: "2026-10-20T00:00:00.000Z",
  }
  const childPost = {
    parent: { type: "page_id", page_id: completionRoot },
    properties: { title: { title: [completionSpan("completion.md")] } },
    children: [creationMarkerBlock(proof)],
  }
  const guards: Record<string, unknown> = {
    [`v1/pages/${completionRoot}`]: observation(`v1/pages/${completionRoot}`, rootRaw),
    [`v1/pages/${completionRoot}/markdown`]: "# Root\n",
    [completionChildPath(completionRoot)]: observation(
      completionChildPath(completionRoot),
      rootChildren,
    ),
    [`v1/pages/${completionPage}`]: observation(`v1/pages/${completionPage}`, selected.page_after),
    [`v1/pages/${completionPage}/markdown`]: selected.markdown.markdown,
  }
  for (const [path, value] of Object.entries(selected.inventories))
    guards[path] = observation(path, value)
  for (const id of [originalTree.row_id, originalTree.table_id, originalTree.first_table_id]) {
    const path = `v1/blocks/${id}`
    guards[path] = observation(path, completionFind(selected, id))
  }
  const original = decode(PublicationReceiptSchema, {
    format: 1,
    operation_id: operationId,
    operation: "create",
    scope,
    database_id: completionDatabase,
    data_source_id: completionDataSource,
    page_id: completionRoot,
    state: "failed",
    portable,
    guards,
    intents: [
      {
        method: "POST",
        path: "v1/pages",
        body: {
          parent: { type: "data_source_id", data_source_id: completionDataSource },
          properties: { Publication: { rich_text: pub.rich_text } },
        },
        status: "completed",
        response: { id: completionRoot },
      },
      {
        method: "POST",
        path: "v1/pages",
        body: childPost,
        status: "completed",
        response: { id: completionPage },
      },
      {
        method: "PATCH",
        path: `v1/pages/${completionPage}/markdown`,
        body: {
          markdown_version: "v2",
          type: "replace_content",
          replace_content: { new_str: `${marker}\n\n${completionSource}` },
        },
        status: "completed",
        response: { id: completionPage },
      },
    ],
    stages: ["references"],
    conflict: true,
    failure: {
      code: "WRITE_PARTIAL",
      message: "Saved table rows differ from input.",
      details: { cause_code: "WRITE_VERIFICATION_FAILED", stage: `body:${sourcePath}` },
    },
  })
  json.set(receiptKey, structuredClone(original))
  await run(
    integrity.prepare({
      version: 1,
      operation_id: operationId,
      intended_hash: intended,
      marker: writing,
    }),
  )
  const receipt = () => decode(PublicationReceiptSchema, json.get(receiptKey))
  return {
    run,
    store,
    json,
    objects,
    original,
    writes,
    receipt,
    derived,
    readOverrides,
    get snapshot() {
      return selected
    },
    get root() {
      return rootRaw
    },
    plan: () => run(planPublicationBodyCompletion(operationId)),
    setFault: (step: number, kind: Fault) => {
      fault = { step, kind }
    },
    losePending: () => {
      losePending = true
    },
    setReadHook: (hook: ((path: string) => void) | undefined) => {
      onRead = hook
    },
    replaceReceipt: (value: Receipt) => json.set(receiptKey, structuredClone(value)),
    replaceSnapshot: (value: typeof selected) => {
      selected = value
    },
  }
}

test("native plan sends nothing; three exact effects keep original intents, source and integrity and return safe resume", async () => {
  const f = await fixture(),
    originalObjects = [...f.objects].map(([key, value]) => [key, hash(value)])
  const nativeIntegrity = await f.run(f.store.integrity.inspect(operationId)),
    plan = await f.plan()
  expect(f.writes.length).toBe(0)
  expect(f.receipt()).toEqual(f.original)
  const result = await f.run(applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash))
  expect(result.outcome).toBe("needs_safe_resume")
  expect(result.publication_completed).toBe(false)
  expect(f.writes).toEqual(plan.requests.map(({ path, body }) => ({ path, body })))
  expect(f.receipt().intents).toEqual(f.original.intents)
  expect(f.receipt().portable).toEqual(f.original.portable)
  expect(f.receipt().state).toBe("running")
  expect(f.receipt().conflict).toBe(false)
  expect(f.receipt().conflict_history?.at(-1)?.failure).toEqual(f.original.failure)
  expect(f.receipt().body_completion?.attempts.map((item) => item.disposition?.kind)).toEqual([
    "acknowledged_verified",
    "acknowledged_verified",
    "acknowledged_verified",
  ])
  expect(await f.run(f.store.integrity.inspect(operationId))).toEqual(nativeIntegrity)
  expect([...f.objects].map(([key, value]) => [key, hash(value)])).toEqual(originalObjects)
})

test("a lost pending save response sends nothing and preserves an explicit row PATCH successor", async () => {
  const f = await fixture(),
    plan = await f.plan()
  f.losePending()
  const first = await f.run(
    applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash).pipe(Effect.result),
  )
  expect(first._tag).toBe("Failure")
  expect(f.writes.length).toBe(0)
  expect(f.receipt().body_completion?.attempts[0]?.transport).toBe("pending")
  await f.run(applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash))
  const attempts = f.receipt().body_completion!.attempts
  expect(attempts[0]?.transport).toBe("pending")
  expect(attempts[0]?.disposition?.kind).toBe("known_not_applied")
  expect(attempts.length).toBe(4)
  expect(f.writes.length).toBe(3)
  expect(f.receipt().intents).toEqual(f.original.intents)
})

test("unknown row BEFORE is observed without writes then explicitly retried with its original history retained", async () => {
  const f = await fixture(),
    plan = await f.plan()
  f.setFault(0, "before")
  expect(
    (await f.run(applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash).pipe(Effect.result)))
      ._tag,
  ).toBe("Failure")
  expect((await f.run(reconcilePublicationBodyCompletion(plan.plan_id))).phase).toBe("unknown")
  expect(f.writes.length).toBe(1)
  await f.run(applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash))
  expect(f.writes.length).toBe(4)
  expect(f.receipt().body_completion?.attempts[0]?.transport).toBe("unknown")
  expect(f.receipt().body_completion?.attempts[0]?.failure?.code).toBe("WRITE_OUTCOME_UNKNOWN")
  expect(f.receipt().body_completion?.attempts[0]?.disposition?.kind).toBe("known_not_applied")
})

test("the tenth row attempt still leaves both append slots in the bounded journal", async () => {
  const f = await fixture(),
    plan = await f.plan()
  for (let index = 0; index < 9; index++) {
    f.setFault(0, "before")
    expect(
      (
        await f.run(
          applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash).pipe(Effect.result),
        )
      )._tag,
    ).toBe("Failure")
  }
  const result = await f.run(applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash))
  expect(result.outcome).toBe("needs_safe_resume")
  expect(f.receipt().body_completion?.attempts.length).toBe(12)
  expect(f.writes.length).toBe(12)
  expect(f.receipt().intents).toEqual(f.original.intents)
})

test("an eleventh row attempt cannot consume the two reserved append slots or alter the retained unknown", async () => {
  const f = await fixture(),
    plan = await f.plan()
  for (let index = 0; index < 10; index++) {
    f.setFault(0, "before")
    expect(
      (
        await f.run(
          applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash).pipe(Effect.result),
        )
      )._tag,
    ).toBe("Failure")
  }
  const before = f.receipt()
  const result = await f.run(
    applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash).pipe(Effect.result),
  )
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure")
    expect(result.failure.message).toBe(
      "The bounded attempt budget must retain one slot for each remaining effect.",
    )
  expect(f.writes.length).toBe(10)
  expect(f.receipt()).toEqual(before)
})

test("unknown append BEFORE never reallocates even on explicit apply", async () => {
  const f = await fixture(),
    plan = await f.plan()
  f.setFault(1, "before")
  await f.run(applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash).pipe(Effect.result))
  const checkpoint = structuredClone(f.receipt().guards),
    count = f.writes.length
  for (let n = 0; n < 2; n++) {
    expect((await f.run(reconcilePublicationBodyCompletion(plan.plan_id))).phase).toBe("unknown")
    expect((await f.run(applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash))).phase).toBe(
      "unknown",
    )
  }
  expect(f.writes.length).toBe(count)
  expect(count).toBe(2)
  expect(f.receipt().guards).toEqual(checkpoint)
  expect(f.receipt().conflict).toBe(true)
})

test("unknown append AFTER gets observed-applied proof without manufacturing an ACK or repeating allocation", async () => {
  const f = await fixture(),
    plan = await f.plan()
  f.setFault(1, "after")
  await f.run(applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash).pipe(Effect.result))
  await f.run(reconcilePublicationBodyCompletion(plan.plan_id))
  const observed = f.receipt().body_completion?.attempts[1]
  expect(observed?.transport).toBe("unknown")
  expect(observed?.response).toBeUndefined()
  expect(observed?.disposition?.kind).toBe("observed_applied")
  expect(f.writes.length).toBe(2)
  await f.run(applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash))
  expect(f.writes.length).toBe(3)
  expect(f.receipt().intents).toEqual(f.original.intents)
})

test("real ACK is saved before readback can fail and reuses its exact allocation", async () => {
  const f = await fixture(),
    plan = await f.plan()
  f.setFault(1, "ack-read")
  expect(
    (await f.run(applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash).pipe(Effect.result)))
      ._tag,
  ).toBe("Failure")
  const ack = f.receipt().body_completion?.attempts[1]
  expect(ack?.transport).toBe("acknowledged")
  expect(property(ack?.response).object).toBe("list")
  await f.run(reconcilePublicationBodyCompletion(plan.plan_id))
  await f.run(applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash))
  expect(f.writes.length).toBe(3)
})

test.each(["partial-after", "wrong-ack"] as const)(
  "%s stays fenced and never replays an allocation",
  async (kind) => {
    const f = await fixture(),
      plan = await f.plan()
    f.setFault(1, kind)
    await f.run(applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash).pipe(Effect.result))
    const count = f.writes.length
    expect(
      (await f.run(reconcilePublicationBodyCompletion(plan.plan_id).pipe(Effect.result)))._tag,
    ).toBe("Failure")
    expect(
      (
        await f.run(
          applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash).pipe(Effect.result),
        )
      )._tag,
    ).toBe("Failure")
    expect(f.writes.length).toBe(count)
    expect(f.receipt().guards).toEqual(f.original.guards)
    expect(f.receipt().conflict).toBe(true)
  },
)

test("Markdown-only BEFORE change cannot be hidden by a correct complete physical model", async () => {
  const f = await fixture()
  f.snapshot.markdown.markdown = String(f.snapshot.markdown.markdown).replace(
    "| Range |",
    "| Changed |",
  )
  const altered = structuredClone(f.original)
  altered.guards[`v1/pages/${completionPage}/markdown`] = f.snapshot.markdown.markdown
  f.replaceReceipt(altered)
  expect((await f.run(planPublicationBodyCompletion(operationId).pipe(Effect.result)))._tag).toBe(
    "Failure",
  )
  expect(f.writes.length).toBe(0)
  expect(f.receipt()).toEqual(altered)
})

test("a changed frozen object or native receipt during preflight prevents the first send", async () => {
  for (const mode of ["source", "receipt"]) {
    const f = await fixture(),
      plan = await f.plan()
    if (mode === "source")
      f.objects.set(`objects/${hash(completionSource)}`, encode(completionSource + "edited"))
    else
      f.setReadHook((path) => {
        if (path !== `v1/pages/${completionRoot}`) return
        f.setReadHook(undefined)
        const changed = f.receipt()
        changed.stages.push("concurrent-edit")
        f.replaceReceipt(changed)
      })
    expect(
      (
        await f.run(
          applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash).pipe(Effect.result),
        )
      )._tag,
    ).toBe("Failure")
    expect(f.writes.length).toBe(0)
  }
})

test("an old guarded selected block cannot detach from the current inventory behind a same-content replacement", async () => {
  const f = await fixture(),
    oldId = String(
      property(
        completionArray(f.snapshot.inventories[completionChildPath(completionPage)]!.results)[2],
      ).id,
    )
  const newId = "40000000-0000-4000-8000-000000000099",
    before = structuredClone(f.snapshot)
  f.readOverrides.set(`v1/blocks/${oldId}`, structuredClone(completionFind(before, oldId)))
  f.readOverrides.set(
    completionChildPath(oldId),
    structuredClone(before.inventories[completionChildPath(oldId)]),
  )
  completionFind(before, oldId).id = newId
  const inventories = { ...before.inventories },
    rows = structuredClone(inventories[completionChildPath(oldId)]!)
  for (const row of completionArray(rows.results))
    completionRecord(row).parent = { type: "block_id", block_id: newId }
  delete inventories[completionChildPath(oldId)]
  inventories[completionChildPath(newId)] = rows
  f.replaceSnapshot({ ...before, inventories })
  expect((await f.run(planPublicationBodyCompletion(operationId).pipe(Effect.result)))._tag).toBe(
    "Failure",
  )
  expect(f.writes.length).toBe(0)
  expect(f.receipt()).toEqual(f.original)
})

test("rehashed stored plan cannot substitute an unsubmitted request", async () => {
  const f = await fixture(),
    captured = await f.plan()
  const decoded = Schema.decodeUnknownSync(BodyCompletionPlanSchema)(captured.plan)
  const { plan_id: _id, plan_hash: _hash, ...body } = decoded
  const changed = {
    ...body,
    requests: body.requests.map((request, index) =>
      index === 0
        ? {
            ...request,
            body: { table_row: { cells: [[{ type: "text", text: { content: "attacker" } }]] } },
          }
        : request,
    ),
  }
  const planHash = hash(canonical(changed)),
    planId = `pbc_${planHash}`
  await f.run(
    f.store.upstream.createCommand(bodyCompletionPlanKey(planId), {
      ...changed,
      plan_id: planId,
      plan_hash: planHash,
    }),
  )
  expect(
    (await f.run(applyPublicationBodyCompletion(planId, planHash).pipe(Effect.result)))._tag,
  ).toBe("Failure")
  expect(f.writes.length).toBe(0)
  expect(f.receipt()).toEqual(f.original)
})

test.each(["metadata", "new_id"] as const)(
  "stable dual AFTER rejects %s drift before checkpointing an append",
  async (kind) => {
    const f = await fixture(),
      plan = await f.plan()
    let reads = 0
    f.setReadHook((path) => {
      if (f.writes.length !== 2 || path !== `v1/pages/${completionPage}` || ++reads !== 3) return
      f.setReadHook(undefined)
      if (kind === "metadata") {
        property(f.snapshot.page_before.properties).user_field = { date: "2026-10-22" }
        property(f.snapshot.page_after.properties).user_field = { date: "2026-10-22" }
      } else
        completionRecord(completionRows(f.snapshot, f.derived!.table_id).at(-1)).id =
          "40000000-0000-4000-8000-000000000088"
    })
    expect(
      (
        await f.run(
          applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash).pipe(Effect.result),
        )
      )._tag,
    ).toBe("Failure")
    expect(f.writes.length).toBe(2)
    expect(f.receipt().conflict).toBe(true)
    expect(f.receipt().body_completion?.attempts[1]?.transport).toBe("acknowledged")
    expect(f.receipt().body_completion?.attempts[1]?.disposition).toBeUndefined()
    expect(f.receipt().guards).toEqual(f.original.guards)
  },
)

test("ordinary routes are fenced while completion is unresolved and operation show exposes its journal", async () => {
  const f = await fixture(),
    plan = await f.plan()
  f.setFault(1, "before")
  await f.run(applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash).pipe(Effect.result))
  const count = f.writes.length,
    before = f.receipt()
  expect((await f.run(reconcilePublication(operationId).pipe(Effect.result)))._tag).toBe("Failure")
  expect((await f.run(resumePublication(operationId).pipe(Effect.result)))._tag).toBe("Failure")
  const shown = await f.run(showOperation(operationId))
  expect(shown.resume_supported).toBe(false)
  expect(shown.next.argv).toContain("body-completion-reconcile")
  expect(f.writes.length).toBe(count)
  expect(f.receipt()).toEqual(before)
})

test("reapplying a verified historical result never rolls back later ordinary publication progress", async () => {
  const f = await fixture(),
    plan = await f.plan()
  await f.run(applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash))
  const later = f.receipt()
  later.stages.push("later-ordinary-stage")
  later.guards[`v1/pages/${completionRoot}/markdown`] = "Later ordinary progress\n"
  f.replaceReceipt(later)
  const result = await f.run(applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash))
  expect(result.reused).toBe(true)
  expect(f.writes.length).toBe(3)
  expect(f.receipt()).toEqual(later)
})

test.each(["verified_pending", "running_certificate"] as const)(
  "a schema-valid %s journal is rejected by its phase invariant",
  async (kind) => {
    const f = await fixture(),
      plan = await f.plan()
    await f.run(applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash))
    const current = f.receipt(),
      journal = current.body_completion
    assert.ok(journal)
    const corrupted = {
      ...current,
      body_completion:
        kind === "verified_pending"
          ? {
              ...journal,
              attempts: journal.attempts.map((attempt, index) => {
                if (index !== journal.attempts.length - 1) return attempt
                const { disposition: _proof, response: _response, ...pending } = attempt
                return { ...pending, transport: "pending" as const }
              }),
            }
          : { ...journal, phase: "running" as const },
    }
    f.replaceReceipt(decode(PublicationReceiptSchema, corrupted))
    const before = f.receipt(),
      result = await f.run(
        applyPublicationBodyCompletion(plan.plan_id, plan.plan_hash).pipe(Effect.result),
      )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure")
      expect(result.failure.message).toBe(
        kind === "verified_pending"
          ? "A verified journal cannot contain an unresolved effect."
          : "The journal phase and completion certificate disagree.",
      )
    expect(f.writes.length).toBe(3)
    expect(f.receipt()).toEqual(before)
  },
)
