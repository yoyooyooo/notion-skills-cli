import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { fail, property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { executeSharedCreate, reconcileSharedCreate } from "../src/shared-create.ts"
import { prepareSharedSourceProjection } from "../src/shared-source-projection.ts"
import { readSourceDefinition } from "../src/shared-source-definitions.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import { sharedCreateOutcomeId } from "../src/shared-create-outcome.ts"
import {
  applySharedRetainedImportRecovery,
  reviewSharedRetainedImportRecovery,
} from "../src/shared-create-retained-recovery.ts"
import {
  applySharedSourceFileResubmission,
  reviewSharedSourceFileResubmission,
  reconcileSharedSourceFileResubmission,
  loadCompletedSourceFileResubmissions,
} from "../src/shared-source-file-resubmission.ts"
import { fixture, library } from "./shared-source-projection-fixture.ts"
import { rich } from "./shared-snapshot-fixture.ts"

const target = "references/rejected.md"
const markdown =
  "# Rejected\n\n" +
  Array.from(
    { length: 10 },
    (_, i) => `[![Badge ${i}](https://img.example/${i}.svg)](https://example.org/${i})`,
  ).join("\n") +
  "\n\nKeep every other original byte.\n"

async function rejectedOriginal() {
  const runtime = fixture(
    [
      {
        path: "references/b-before.md",
        bytes: new TextEncoder().encode("## Before\n\nA later acknowledged prefix member.\n"),
        mode: "100644",
      },
      { path: target, bytes: new TextEncoder().encode(markdown), mode: "100644" },
      {
        path: "references/z-tail.md",
        bytes: new TextEncoder().encode("## Tail\n\nAn undispatched original suffix.\n"),
        mode: "100644",
      },
    ],
    { markdownImport: true, recovery: true },
  )
  const root = mkdtempSync(join(tmpdir(), "source-file-resubmission-"))
  const run: typeof runtime.run = (effect) =>
    runtime.run(
      Effect.gen(function* () {
        const store = yield* Store
        return yield* effect.pipe(Effect.provideService(Store, { ...store, root }))
      }),
    )
  const f = { ...runtime, run }
  const plan = await f.run(
    Effect.gen(function* () {
      return yield* prepareSharedSourceProjection({
        library,
        definition: yield* readSourceDefinition(library, f.source.id),
        acquired: f.snapshot,
        member: "skills/demo",
        skillId: "rejected-resubmission-original",
        enabled: false,
        markdownImport: true,
        storage: "retained",
      })
    }),
  )
  const failure = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* executeSharedCreate(library, { plan, mode: "create" }).pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) =>
            api.request(path, body, options).pipe(
              Effect.flatMap((response) => {
                const page = path.replace(/^v1\/pages\//u, "").replace(/\/markdown\?.*$/u, "")
                return path.includes("/markdown?") && f.files.has(page)
                  ? Effect.fail(
                      fail(
                        "SHARED_CREATE_BODY_MISMATCH",
                        "Controlled old semantic validator refusal.",
                      ),
                    )
                  : Effect.succeed(response)
              }),
            ),
        }),
        Effect.flip,
      )
    }),
  )
  expect(failure.code).toBe("SHARED_CREATE_BODY_MISMATCH")
  const page = String(property(failure.details).skill_page_id)
  const input = { entry: library.skills.database_id, plan, target: page }
  const retainedReview = await f.run(reviewSharedRetainedImportRecovery(input))
  expect(retainedReview.bindings).toHaveLength(2)
  const parent = { ...input, review: retainedReview, reviewId: retainedReview.review_id }
  const rejected = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* applySharedRetainedImportRecovery(parent).pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) => {
            if (
              path === "v1/pages" &&
              options?.method === "POST" &&
              property(property(body).parent).data_source_id === library.files.data_source_id &&
              text(
                property(property(property(body).properties)[library.files.property_ids.Path!])
                  .rich_text,
              ) === target
            )
              return Effect.fail(
                fail("NOTION_REQUEST_FAILED", "Controlled definitive native rejection", {
                  phase: "definitive_rejection",
                  http_status: 400,
                  notion_code: "validation_error",
                }),
              )
            return api.request(path, body, options)
          },
        }),
        Effect.flip,
      )
    }),
  )
  expect(rejected.code).toBe("SOURCE_WRITE_NOT_APPLIED")
  const failures = await f.run(
    querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      recordId: sharedCreateOutcomeId(plan.operation_id),
    }),
  )
  f.clear()
  return {
    ...f,
    plan,
    page,
    input,
    parent,
    retainedReview,
    failure: canonicalSharedJson(failures[0]),
    frozenPlan: canonicalSharedJson(plan),
  }
}

async function reviewed() {
  const f = await rejectedOriginal()
  const saved = await f.run(reviewSharedSourceFileResubmission({ ...f.input, path: target }))
  expect(saved.review.bindings).toHaveLength(3)
  expect(saved.review.changes).toEqual({
    paragraphs: 1,
    images: 10,
    linked_images: 10,
    inserted_line_feeds: 9,
  })
  return { ...f, saved, request: { ...f.input, review: saved, reviewId: saved.review.review_id } }
}

test("one independently reviewed native ACK resumes the original producer and survives a cold Store", async () => {
  const f = await reviewed()
  const originalPending = [...f.base.json].find(
    ([, value]) => property(value).operation === f.saved.original_dispatch.operation,
  )
  const originalNegative = [...f.base.json].find(
    ([, value]) =>
      property(value).operation_id === f.saved.original_dispatch.operation &&
      property(value).status === "not_applied",
  )
  const dry = await f.run(applySharedSourceFileResubmission({ ...f.request, dryRun: true }))
  expect(dry.remote_writes).toBe(0)
  expect(f.writes()).toHaveLength(0)
  f.clear()
  let responseBytes = 0
  const done = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* applySharedSourceFileResubmission(f.request).pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) =>
            api.request(path, body, options).pipe(
              Effect.tap((response) =>
                Effect.sync(() => {
                  responseBytes += new TextEncoder().encode(JSON.stringify(response)).length
                }),
              ),
            ),
        }),
      )
    }),
  )
  expect(done.status).toBe("completed")
  expect(done.verified).toBe(true)
  expect(done.original_creation_completed).toBe(false)
  expect(f.nativeCreates()).toHaveLength(1)
  const requests = f.calls.length
  expect(requests).toBeGreaterThan(0)
  expect(responseBytes).toBeGreaterThan(0)
  console.info(
    `resubmission controlled apply: ${requests} requests, ${responseBytes} response bytes`,
  )
  const candidate = property(f.nativeCreates()[0]!.body).markdown
  expect(typeof candidate).toBe("string")
  expect(
    String(candidate).length - String(property(f.saved.original_dispatch.body).markdown).length,
  ).toBe(9)
  expect(originalPending && f.base.json.get(originalPending[0])).toEqual(f.saved.original_dispatch)
  expect(originalNegative && f.base.json.get(originalNegative[0])).toEqual(
    f.saved.original_rejection,
  )
  expect(canonicalSharedJson(f.plan)).toBe(f.frozenPlan)
  f.clear()
  expect((await f.run(applySharedSourceFileResubmission(f.request))).verified).toBe(true)
  expect(f.writes()).toHaveLength(0)
  const parent = await f.run(applySharedRetainedImportRecovery(f.parent))
  expect(parent.verified).toBe(true)
  expect(f.nativeCreates()).toHaveLength(f.plan.files.length - 4)
  const failures = await f.run(
    querySharedRecords(library, {
      skillPageId: f.page,
      kind: "operation",
      recordId: sharedCreateOutcomeId(f.plan.operation_id),
    }),
  )
  expect(canonicalSharedJson(failures[0])).toBe(f.failure)
  const completions = await f.run(
    querySharedRecords(library, {
      skillPageId: f.page,
      kind: "operation",
      recordId: "retained-readback-outcome-" + f.plan.operation_id,
    }),
  )
  expect(property(completions[0]!.payload).version).toBe(2)
  expect(property(completions[0]!.payload).file_resubmissions).toHaveLength(1)
  if (!("file_page_id" in done)) throw new Error("Expected completed independent page")
  f.base.bodies.set(done.file_page_id, "# A legitimate later page edit\n")
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  expect((await f.run(reconcileSharedSourceFileResubmission(f.request))).verified).toBe(true)
  expect((await f.run(reconcileSharedCreate(library, f.plan))).verified).toBe(true)
  expect(f.writes()).toHaveLength(0)
})

test.each(["negative", "target_ack", "prefix_ack", "wire", "body", "owner"] as const)(
  "resubmission refuses changed %s evidence before any remote write",
  async (guard) => {
    const f = await reviewed()
    let saved = f.saved
    if (guard === "negative") {
      const key = [...f.base.json.keys()].find((key) =>
        key.endsWith(
          "source-rejection-" +
            f.saved.original_dispatch.operation.slice("source-op-".length) +
            ".json",
        ),
      )!
      f.base.json.delete(key)
    } else if (guard === "target_ack") {
      const pending = [...f.base.json.keys()].find((key) =>
        key.endsWith(f.saved.original_dispatch.operation + ".json"),
      )!
      f.base.json.set(pending.replace("/source-op-", "/source-ack-"), { version: 1 })
    } else if (guard === "prefix_ack") {
      const last = f.saved.review.allocations.at(-1)!
      const key = [...f.base.json.keys()].find(
        (key) =>
          key.includes("/source-ack-") &&
          property(property(f.base.json.get(key)).response).id === last.page_id,
      )!
      f.base.json.delete(key)
    } else if (guard === "wire") {
      saved = {
        ...f.saved,
        original_dispatch: {
          ...f.saved.original_dispatch,
          body: { ...property(f.saved.original_dispatch.body), markdown: markdown + "altered" },
        },
      }
    } else if (guard === "body")
      f.base.bodies.set(f.saved.review.bindings.at(-1)!.page_id, "# Changed prefix\n")
    else
      property(f.skills.get(f.page)!.properties).enabled = {
        id: "enabled",
        type: "checkbox",
        checkbox: true,
      }
    f.clear()
    await expect(
      f.run(applySharedSourceFileResubmission({ ...f.request, review: saved })),
    ).rejects.toBeDefined()
    expect(f.writes()).toHaveLength(0)
  },
)

test.each([false, true])(
  "an independent unknown visible=%s is never replayed or replaced by a fresh review",
  async (visible) => {
    const f = await reviewed()
    f.unknown("file", visible)
    await expect(f.run(applySharedSourceFileResubmission(f.request))).rejects.toBeDefined()
    expect(f.nativeCreates()).toHaveLength(1)
    f.clear()
    await expect(f.run(applySharedSourceFileResubmission(f.request))).rejects.toBeDefined()
    await expect(f.run(applySharedRetainedImportRecovery(f.parent))).rejects.toBeDefined()
    await expect(f.run(reconcileSharedSourceFileResubmission(f.request))).rejects.toBeDefined()
    expect(f.writes()).toHaveLength(0)
    if (!visible) {
      const again = await f.run(reviewSharedSourceFileResubmission({ ...f.input, path: target }))
      expect(again).toEqual(f.saved)
      await expect(
        f.run(applySharedSourceFileResubmission({ ...f.request, review: again })),
      ).rejects.toBeDefined()
      expect(f.writes()).toHaveLength(0)
    }
  },
)

test.each(["missing", "changed"] as const)(
  "shared completion cannot bypass a %s local new ACK when continuing the parent",
  async (change) => {
    const f = await reviewed()
    expect((await f.run(applySharedSourceFileResubmission(f.request))).verified).toBe(true)
    const [proof] = await f.run(loadCompletedSourceFileResubmissions(library, f.plan, f.page))
    if (!proof) throw new Error("Expected completed substitution")
    const key = [...f.base.json.keys()].find((key) =>
      key.endsWith(
        "source-ack-" + proof.new_dispatch.operation.slice("source-op-".length) + ".json",
      ),
    )!
    if (change === "missing") f.base.json.delete(key)
    else f.base.json.set(key, { ...property(f.base.json.get(key)), response_hash: "0".repeat(64) })
    f.clear()
    expect((await f.run(reconcileSharedSourceFileResubmission(f.request))).verified).toBe(true)
    await expect(f.run(applySharedRetainedImportRecovery(f.parent))).rejects.toBeDefined()
    expect(f.writes()).toHaveLength(0)
  },
)

test.each(["replacement_body", "advanced_prefix_body", "replacement_owner"] as const)(
  "the parent refuses current %s drift before its first new write",
  async (change) => {
    const f = await reviewed()
    const done = await f.run(applySharedSourceFileResubmission(f.request))
    if (!("file_page_id" in done)) throw new Error("Expected completed independent page")
    if (change === "replacement_body")
      f.base.bodies.set(done.file_page_id, f.base.bodies.get(done.file_page_id)! + "\n")
    else if (change === "advanced_prefix_body") {
      const page = f.saved.review.bindings.at(-1)!.page_id
      f.base.bodies.set(page, f.base.bodies.get(page)! + "\n")
    } else
      property(f.files.get(done.file_page_id)!.properties).skill = {
        id: "skill",
        type: "relation",
        relation: [],
        has_more: false,
      }
    f.clear()
    // Historical proof remains valid; only permission to perform fresh writes expires.
    expect((await f.run(reconcileSharedSourceFileResubmission(f.request))).verified).toBe(true)
    await expect(f.run(applySharedRetainedImportRecovery(f.parent))).rejects.toBeDefined()
    expect(f.writes()).toHaveLength(0)
  },
)

test("an acknowledged resubmission resumes only proof publication after interrupted full readback", async () => {
  const f = await reviewed()
  let page: string | undefined,
    interrupted = false
  await expect(
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* applySharedSourceFileResubmission(f.request).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) => {
              if (
                page !== undefined &&
                !interrupted &&
                path === `v1/pages/${page}/markdown?markdown_version=v2`
              ) {
                interrupted = true
                return Effect.fail(
                  fail("NOTION_REQUEST_FAILED", "Controlled post-ACK readback interruption"),
                )
              }
              return api.request(path, body, options).pipe(
                Effect.tap((response) =>
                  Effect.sync(() => {
                    if (
                      path === "v1/pages" &&
                      options?.method === "POST" &&
                      property(property(body).parent).data_source_id ===
                        library.files.data_source_id
                    )
                      page = String(property(response).id)
                  }),
                ),
              )
            },
          }),
        )
      }),
    ),
  ).rejects.toBeDefined()
  expect(interrupted).toBe(true)
  expect(f.nativeCreates()).toHaveLength(1)
  f.clear()
  expect((await f.run(reconcileSharedSourceFileResubmission(f.request))).status).toBe(
    "completion_pending",
  )
  const dry = await f.run(applySharedSourceFileResubmission({ ...f.request, dryRun: true }))
  expect(dry).toMatchObject({ status: "reviewed", native_pages_to_create: 0, remote_writes: 0 })
  expect(f.writes()).toHaveLength(0)
  expect((await f.run(applySharedSourceFileResubmission(f.request))).verified).toBe(true)
  expect(f.nativeCreates()).toHaveLength(0)
})

test.each(["original_wire", "new_ack", "readback"] as const)(
  "cold completion refuses a missing complete %s proof",
  async (missing) => {
    const f = await reviewed()
    await f.run(applySharedSourceFileResubmission(f.request))
    const [proof] = await f.run(loadCompletedSourceFileResubmissions(library, f.plan, f.page))
    if (!proof) throw new Error("Expected completed substitution")
    await f.run(applySharedRetainedImportRecovery(f.parent))
    const reviewRows = await f.run(
      querySharedRecords(library, {
        skillPageId: f.page,
        kind: "operation",
        entityId: "source-file-resubmission-reviews-v1",
      }),
    )
    const outcomeRows = await f.run(
      querySharedRecords(library, {
        skillPageId: f.page,
        kind: "operation",
        entityId: "source-file-resubmission-outcomes-v1",
      }),
    )
    const recordId =
      missing === "original_wire"
        ? "input-" + property(property(reviewRows[0]!.payload).plan).sha256
        : missing === "new_ack"
          ? "input-" + property(property(outcomeRows[0]!.payload).proof).sha256
          : "body-" + proof.observation.body_sha256
    let removed = false
    for (const [key, row] of f.base.records)
      if (text(property(property(row.properties).record).rich_text) === recordId) {
        f.base.records.delete(key)
        removed = true
      }
    expect(removed).toBe(true)
    f.base.json.clear()
    f.base.objects.clear()
    f.clear()
    await expect(f.run(reconcileSharedSourceFileResubmission(f.request))).rejects.toBeDefined()
    await expect(f.run(reconcileSharedCreate(library, f.plan))).rejects.toBeDefined()
    expect(f.writes()).toHaveLength(0)
  },
)

test.each([false, true])(
  "a parent completion cannot downgrade to version 1 with resubmission indexes removed=%s",
  async (removeIndexes) => {
    const f = await reviewed()
    await f.run(applySharedSourceFileResubmission(f.request))
    await f.run(applySharedRetainedImportRecovery(f.parent))
    const row = [...f.base.records.values()].find(
      (row) =>
        text(property(property(row.properties).record).rich_text) ===
        "retained-readback-outcome-" + f.plan.operation_id,
    )!
    const fields = property(row.properties)
    const envelope = property(JSON.parse(text(property(fields.payload).rich_text)))
    expect(envelope.operation_id).toMatch(/^retained-readback-resubmitted-[a-f0-9]{64}$/u)
    const payload = property(envelope.payload)
    payload.version = 1
    delete payload.file_resubmissions
    const canonical = canonicalSharedJson(envelope)
    fields.payload = rich("payload", canonical)
    fields.hash = rich("hash", createHash("sha256").update(canonical).digest("hex"))
    if (removeIndexes) {
      let removed = 0
      for (const [key, record] of f.base.records) {
        const entity = text(property(property(record.properties).entity).rich_text)
        if (
          entity === "source-file-resubmission-reviews-v1" ||
          entity === "source-file-resubmission-outcomes-v1"
        ) {
          f.base.records.delete(key)
          removed++
        }
      }
      expect(removed).toBe(2)
    }
    f.base.json.clear()
    f.base.objects.clear()
    f.clear()
    await expect(f.run(reconcileSharedCreate(library, f.plan))).rejects.toBeDefined()
    expect(f.writes()).toHaveLength(0)
  },
)
