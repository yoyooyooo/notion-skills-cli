import { expect, test } from "bun:test"
import { Crypto, Effect, FileSystem, Path } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ChildProcessSpawner } from "effect/process"
import { HttpClient } from "effect/http"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { authScope } from "../src/catalog.ts"
import { fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store, sha256 } from "../src/store.ts"
import { executeSharedCreate, reconcileSharedCreate } from "../src/shared-create.ts"
import { prepareSharedSourceProjection } from "../src/shared-source-projection.ts"
import { readSourceDefinition } from "../src/shared-source-definitions.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import {
  projectSharedNotionMarkdown,
  sharedNotionMarkdownWire,
} from "../src/shared-notion-projection.ts"
import { inspectAuditSkill } from "../src/shared-audit-inspect.ts"
import { emptyAuditInventory } from "../src/shared-audit-model.ts"
import { text } from "../src/model.ts"
import { knownImportTablePlusReadback } from "../src/shared-import-table-literals.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import { withSharedAuthoringTarget } from "../src/shared-authoring-context.ts"
import {
  reviewSharedSourceProjectionRepair,
  applySharedSourceProjectionRepair,
  reconcileSharedSourceProjectionRepair,
} from "../src/shared-source-projection-repair.ts"
import { fixture, library, ids } from "./shared-source-projection-fixture.ts"
import { rich } from "./shared-snapshot-fixture.ts"

const nativeTableReadback = (wire: string) =>
  knownImportTablePlusReadback(
    wire.replaceAll("<b>+</b>", "\uE001").replaceAll("\\+", "+"),
  ).markdown.replaceAll("\uE001", "<b>+</b>") + "\n"

async function failedMain() {
  const f = fixture([], {
    markdownImport: true,
    recovery: true,
    main: "---\nname: source-plus-example\ndescription: Original plus meaning\nlicense: MIT\n---\n\n# Original\n\n| Action | Value |\n| --- | --- |\n| New | `brief` + `content` |\n| Link | + [guide](references/a.md) |\n",
    readback: nativeTableReadback,
  })
  const root = mkdtempSync(join(tmpdir(), "source-projection-repair-"))
  let lost: boolean | undefined
  const run = <A, E>(
    action: Effect.Effect<
      A,
      E,
      | Store
      | Notion
      | Crypto.Crypto
      | FileSystem.FileSystem
      | Path.Path
      | HttpClient.HttpClient
      | ChildProcessSpawner.ChildProcessSpawner
    >,
  ) =>
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion,
          store = yield* Store
        const controlled: Notion["Service"] = {
          ...api,
          request: (path, body, options) =>
            Effect.suspend(() => {
              if (options?.method !== "PATCH" || !/^v1\/pages\/[^/]+\/markdown$/u.test(path))
                return api.request(path, body, options)
              f.calls.push({ path, method: "PATCH", body })
              const target = path.split("/")[2]!,
                request = property(body)
              const updates = property(request.update_content).content_updates
              if (
                request.type !== "update_content" ||
                request.markdown_version !== "v2" ||
                !Array.isArray(updates) ||
                updates.length !== 1
              )
                return Effect.fail(
                  fail("TEST_REPAIR_REQUEST", "Expected one exact whole-body update"),
                )
              const update = property(updates[0]),
                before = f.base.bodies.get(target)
              if (before !== update.old_str || typeof update.new_str !== "string")
                return Effect.fail(
                  fail("NOTION_REQUEST_FAILED", "The entire preimage no longer matches", {
                    http_status: 400,
                    notion_code: "validation_error",
                    phase: "definitive_rejection",
                  }),
                )
              const drop = lost
              lost = undefined
              const after = nativeTableReadback(update.new_str)
              if (drop !== false) f.base.bodies.set(target, after)
              if (drop !== undefined)
                return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Controlled missing body ACK"))
              return Effect.succeed({
                object: "page_markdown",
                id: target,
                markdown: after,
                truncated: false,
                unknown_block_ids: [],
              })
            }),
        }
        return yield* action.pipe(
          Effect.provideService(Notion, controlled),
          Effect.provideService(Store, { ...store, root }),
          Effect.provide(NodeServices.layer),
        )
      }),
    )
  const plan = await run(
    Effect.gen(function* () {
      return yield* prepareSharedSourceProjection({
        library,
        definition: yield* readSourceDefinition(library, f.source.id),
        acquired: f.snapshot,
        member: "skills/demo",
        skillId: "original-source-plus",
        enabled: false,
        markdownImport: true,
        storage: "retained",
      })
    }),
  )
  const original = await run(
    executeSharedCreate(library, { plan, mode: "create" }).pipe(Effect.flip),
  )
  expect(original.code).toBe("SHARED_CREATE_BODY_MISMATCH")
  const page = property(original.details).skill_page_id
  if (typeof page !== "string") throw new Error("Expected an original allocated main")
  const before = f.base.bodies.get(page)!
  expect(before).toContain("•")
  const input = { entry: library.skills.database_id, plan, target: page }
  f.clear()
  return {
    ...f,
    run,
    plan,
    page,
    before,
    input,
    losePatch: (visible: boolean) => {
      lost = visible
    },
  }
}

/** Rebuild the exact earlier review format from its controlled original input;
 * actual dispatch, response, ACK and retained failure all come from the real
 * product path below. Never seed or edit the dispatcher/journal. */
async function legacyV16Review(f: Awaited<ReturnType<typeof failedMain>>) {
  const candidate = await f.run(reviewSharedSourceProjectionRepair(f.input))
  const { review_id: _id, previous: _previous, ...fields } = candidate
  const main = f.plan.files.find((file) => file.path === "SKILL.md")!
  const wire = sharedNotionMarkdownWire(
    projectSharedNotionMarkdown(main.projection.input_markdown, {
      version: 16,
      purpose: "data_source_create",
    }),
  )
  const legacy = {
    ...fields,
    version: 1 as const,
    candidate: {
      ...candidate.candidate,
      policy: 16 as const,
      wire_sha256: await f.run(sha256(wire)),
      wire_bytes: new TextEncoder().encode(wire).length,
    },
  }
  return {
    ...legacy,
    review_id: "source-projection-repair-" + (await f.run(sha256(canonicalSharedJson(legacy)))),
  }
}

test("an exact acknowledged v16 no-op authorizes one separate v17 review without changing either original request", async () => {
  const f = await failedMain(),
    old = await legacyV16Review(f)
  const oldBytes = canonicalSharedJson(old),
    originalBytes = canonicalSharedJson(f.plan)
  await expect(
    f.run(applySharedSourceProjectionRepair({ ...f.input, review: old, reviewId: old.review_id })),
  ).rejects.toMatchObject({ code: "SHARED_CREATE_BODY_MISMATCH" })
  expect(f.base.bodies.get(f.page)).toBe(f.before)
  const firstPatch = f.calls.filter((call) => call.method === "PATCH")
  expect(firstPatch).toHaveLength(1)
  const frozenRequest = canonicalSharedJson(firstPatch[0]!.body)
  f.clear()
  const next = await f.run(reviewSharedSourceProjectionRepair(f.input))
  expect(next.version).toBe(2)
  expect(next.previous).toMatchObject({
    kind: "acknowledged_unchanged_v16",
    review_id: old.review_id,
  })
  if (next.previous.kind !== "acknowledged_unchanged_v16")
    throw new Error("Expected the original acknowledged no-op")
  expect(Object.hasOwn(next.previous.body_ack, "response")).toBe(false)
  expect(Object.hasOwn(property(next.previous.body_ack.response_metadata), "markdown")).toBe(false)
  expect(f.writes()).toHaveLength(0)
  const input = { ...f.input, review: next, reviewId: next.review_id }
  expect(
    (await f.run(applySharedSourceProjectionRepair({ ...input, dryRun: true }))).remote_writes,
  ).toBe(0)
  expect(f.writes()).toHaveLength(0)
  expect((await f.run(applySharedSourceProjectionRepair(input))).verified).toBe(true)
  const successorPatch = f.calls.filter((call) => call.method === "PATCH")
  expect(successorPatch).toHaveLength(1)
  expect(canonicalSharedJson(successorPatch[0]!.body)).not.toBe(frozenRequest)
  expect(f.nativeCreates()).toHaveLength(0)
  expect(canonicalSharedJson(old)).toBe(oldBytes)
  expect(canonicalSharedJson(f.plan)).toBe(originalBytes)
  const previousRecord = await f.run(
    querySharedRecords(library, {
      skillPageId: f.page,
      kind: "operation",
      recordId: "source-projection-review-" + f.plan.operation_id,
    }),
  )
  expect(canonicalSharedJson(previousRecord[0]!.payload)).toBe(oldBytes)
  f.clear()
  expect((await f.run(applySharedSourceProjectionRepair(input))).verified).toBe(true)
  expect(f.writes()).toHaveLength(0)
  expect(
    (await f.run(executeSharedCreate(library, { plan: f.plan, mode: "create" }))).verified,
  ).toBe(true)
  f.base.objects.clear()
  f.base.json.clear()
  f.clear()
  expect((await f.run(reconcileSharedSourceProjectionRepair(input))).verified).toBe(true)
  expect((await f.run(reconcileSharedCreate(library, f.plan))).verified).toBe(true)
  expect(f.writes()).toHaveLength(0)
  for (const [key, row] of f.base.records)
    if (
      text(property(property(row.properties).record).rich_text) ===
      "source-projection-review-" + f.plan.operation_id
    )
      f.base.records.delete(key)
  f.base.objects.clear()
  f.base.json.clear()
  f.clear()
  await expect(f.run(reconcileSharedSourceProjectionRepair(input))).rejects.toBeDefined()
  await expect(f.run(reconcileSharedCreate(library, f.plan))).rejects.toBeDefined()
  expect(f.writes()).toHaveLength(0)
})

test.each([
  "missing-ack",
  "unknown-applied",
  "unknown-not-applied",
  "changed-body",
  "changed-ack",
] as const)("a preceding v16 %s cannot be promoted to new submission authority", async (guard) => {
  const f = await failedMain(),
    old = await legacyV16Review(f)
  if (guard === "unknown-applied") f.losePatch(true)
  if (guard === "unknown-not-applied") f.losePatch(false)
  await expect(
    f.run(applySharedSourceProjectionRepair({ ...f.input, review: old, reviewId: old.review_id })),
  ).rejects.toBeDefined()
  if (guard === "missing-ack" || guard === "changed-ack") {
    const key = [...f.base.json.keys()].find(
      (key) =>
        key.includes("/source-ack-") &&
        property(property(f.base.json.get(key)).response).object === "page_markdown",
    )!
    expect(key).toBeDefined()
    if (guard === "missing-ack") f.base.json.delete(key)
    else property(f.base.json.get(key)).request_hash = "f".repeat(64)
  } else if (guard === "changed-body")
    f.base.bodies.set(f.page, f.before + "\nNew human instruction.\n")
  f.clear()
  await expect(f.run(reviewSharedSourceProjectionRepair(f.input))).rejects.toBeDefined()
  await expect(
    f.run(executeSharedCreate(library, { plan: f.plan, mode: "create" })),
  ).rejects.toBeDefined()
  expect(f.writes()).toHaveLength(0)
})

test("reviewed source main repair keeps original allocation and completes only through the original create afterwards", async () => {
  const f = await failedMain(),
    originalPlan = canonicalSharedJson(f.plan)
  const review = await f.run(reviewSharedSourceProjectionRepair(f.input))
  expect(review.candidate).toMatchObject({ policy: 17, changed_literals: 2 })
  expect(review.skill_page_id).toBe(f.page)
  expect(f.writes()).toHaveLength(0)
  const input = { ...f.input, review, reviewId: review.review_id }
  expect(
    (await f.run(applySharedSourceProjectionRepair({ ...input, dryRun: true }))).remote_writes,
  ).toBe(0)
  expect(f.writes()).toHaveLength(0)
  const result = await f.run(applySharedSourceProjectionRepair(input))
  expect(result.verified).toBe(true)
  expect(result).toMatchObject({ original_creation_completed: false })
  expect(f.nativeCreates()).toHaveLength(0)
  expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
  const patches = f.calls.find((call) => call.method === "PATCH")!
  expect(property(property(patches.body).update_content).content_updates).toEqual([
    expect.objectContaining({ old_str: f.before }),
  ])
  expect(canonicalSharedJson(f.plan)).toBe(originalPlan)
  expect(f.base.bodies.get(f.page)).not.toContain("•")
  f.clear()
  expect((await f.run(applySharedSourceProjectionRepair(input))).verified).toBe(true)
  expect((await f.run(reconcileSharedSourceProjectionRepair(input))).verified).toBe(true)
  expect(f.writes()).toHaveLength(0)
  const applied = await f.run(executeSharedCreate(library, { plan: f.plan, mode: "create" }))
  expect(applied.verified).toBe(true)
  expect(applied.skill_page_id).toBe(f.page)
  expect(
    f
      .nativeCreates()
      .filter(
        (call) =>
          property(property(call.body).parent).data_source_id === library.skills.data_source_id,
      ),
  ).toHaveLength(0)
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  expect((await f.run(reconcileSharedSourceProjectionRepair(input))).verified).toBe(true)
  expect((await f.run(reconcileSharedCreate(library, f.plan))).verified).toBe(true)
  const cold = await f.run(
    withSharedAuthoringTarget(
      f.page,
      Effect.gen(function* () {
        return yield* openSharedConsumer({
          library,
          target: f.page,
          scope: yield* authScope,
          startedAt: Date.now(),
          forceFull: true,
        })
      }),
    ),
  )
  expect(cold.files).toHaveLength(5)
  expect(f.writes()).toHaveLength(0)
  const audit = await f.run(
    inspectAuditSkill(library, {
      page_id: f.page,
      depth: "content",
      observed_from: Date.now(),
      inventory: {
        ...emptyAuditInventory(),
        skills: [...f.skills.values()],
        files: [...f.files.values()],
        records: [...f.base.records.values()],
        sources: [f.source],
        complete: ["skills", "files", "records", "sources"],
      },
    }),
  )
  expect(
    audit.findings.filter((finding) => finding.code === "OPERATION_OUTCOME_UNOBSERVED"),
  ).toEqual([])
  expect(f.writes()).toHaveLength(0)
  // The original create's completed outcome must depend on the separate proof,
  // even after the author's journal and transient observations are absent.
  const removed = [...f.base.records].find(
    ([, row]) =>
      text(property(property(row.properties).record).rich_text) ===
      "source-projection-review-v17-" + f.plan.operation_id,
  )
  expect(removed).toBeDefined()
  f.base.records.delete(removed![0])
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  await expect(f.run(reconcileSharedCreate(library, f.plan))).rejects.toBeDefined()
  await expect(
    f.run(
      withSharedAuthoringTarget(
        f.page,
        Effect.gen(function* () {
          return yield* openSharedConsumer({
            library,
            target: f.page,
            scope: yield* authScope,
            startedAt: Date.now(),
            forceFull: true,
          })
        }),
      ),
    ),
  ).rejects.toBeDefined()
  expect(f.writes()).toHaveLength(0)
})

test.each(["ack", "journal", "body", "source", "owner", "review"] as const)(
  "projection repair refuses %s drift before any remote write",
  async (guard) => {
    const f = await failedMain(),
      review = await f.run(reviewSharedSourceProjectionRepair(f.input))
    if (guard === "ack") {
      const key = [...f.base.json.keys()].find(
        (key) =>
          key.includes("/source-ack-") &&
          property(property(f.base.json.get(key)).response).id === f.page,
      )!
      expect(key).toBeDefined()
      f.base.json.delete(key)
    } else if (guard === "journal") {
      const key = [...f.base.json.keys()].find(
        (key) =>
          key.startsWith("operations/shared-native-create/") &&
          key.endsWith(`/${f.plan.operation_id}.json`),
      )!
      expect(key).toBeDefined()
      f.base.json.delete(key)
    } else if (guard === "body")
      f.base.bodies.set(f.page, f.before.replace("Original", "Human edit"))
    else if (guard === "source") f.source.properties[ids.Ref!] = rich(ids.Ref!, "changed")
    else if (guard === "owner")
      property(f.skills.get(f.page)!.properties).enabled = {
        id: "enabled",
        type: "checkbox",
        checkbox: true,
      }
    f.clear()
    await expect(
      f.run(
        applySharedSourceProjectionRepair({
          ...f.input,
          review,
          reviewId: guard === "review" ? "wrong-digest" : review.review_id,
        }),
      ),
    ).rejects.toBeDefined()
    expect(f.writes()).toHaveLength(0)
  },
)

test.each([false, true])(
  "unknown body repair visible=%s never gains completion from current equality",
  async (visible) => {
    const f = await failedMain(),
      review = await f.run(reviewSharedSourceProjectionRepair(f.input))
    const input = { ...f.input, review, reviewId: review.review_id }
    f.losePatch(visible)
    await expect(f.run(applySharedSourceProjectionRepair(input))).rejects.toBeDefined()
    expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
    f.clear()
    await expect(f.run(applySharedSourceProjectionRepair(input))).rejects.toBeDefined()
    await expect(f.run(reconcileSharedSourceProjectionRepair(input))).rejects.toBeDefined()
    // The original import cannot bypass an independently unresolved body write
    // merely because the provider applied it and its current text is correct.
    await expect(
      f.run(executeSharedCreate(library, { plan: f.plan, mode: "create" })),
    ).rejects.toMatchObject({
      code: "SOURCE_PROJECTION_REPAIR_PENDING",
    })
    expect(f.writes()).toHaveLength(0)
  },
)

test("a human change beyond the known table mutation cannot be reviewed into a repair", async () => {
  const f = await failedMain()
  f.base.bodies.set(f.page, f.before + "\nA new human instruction.\n")
  await expect(f.run(reviewSharedSourceProjectionRepair(f.input))).rejects.toBeDefined()
  expect(f.writes()).toHaveLength(0)
})
