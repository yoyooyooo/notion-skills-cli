import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { authScope } from "../src/catalog.ts"
import { fail, property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import { makeSharedCreatePlan } from "../src/shared-create-model.ts"
import {
  applySharedCreateContinuation,
  applySharedCreateRecovery,
  reconcileSharedCreateRecovery,
  reviewSharedCreateContinuation,
  reviewSharedCreateRecovery,
} from "../src/shared-create-recovery.ts"
import { executeSharedCreate, loadPendingSharedCreates } from "../src/shared-create.ts"
import {
  canonicalSharedJson,
  querySharedRecords,
  appendSharedRecord,
  canonicalSharedRecordEnvelope,
} from "../src/shared-records.ts"
import {
  sharedCreateRecoveryReviewId,
  sharedCreateRecoveryOutcomeId,
} from "../src/shared-create-recovery-completion.ts"
import { sharedCreateContinuationReviewId } from "../src/shared-create-continuation-model.ts"
import { encodeSharedRecordStorage } from "../src/shared-record-codec.ts"
import { SharedRecordKindSchema } from "../src/shared-records.ts"
import { FileEventSchema } from "../src/shared-file-state.ts"
import type { SharedLibrary } from "../src/shared-library-model.ts"
import {
  fixture,
  fixedProjection,
  library as sourceLibrary,
} from "./shared-source-projection-fixture.ts"

const library: SharedLibrary = sourceLibrary

const encode = (value: string) => new TextEncoder().encode(value)
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalSharedJson(value)).digest("hex")
const counterInput =
  "# Counter\n\nTLC reached 4 states and 3 steps. The chart draws 4 states and 3 arrows.\n\n## Rules that hold\nLow, StaysSmall\nTLC checked Low only in the initial states, because it has no [], <>, or ~>. List it as an INVARIANT to check every state.\n"
const counterActual =
  "# Counter\n\nTLC reached 4 states and 3 steps. The chart draws 4 states and 3 arrows.\n\n## Rules that hold\n\nLow, StaysSmall<br />TLC checked Low only in the initial states, because it has no \\[\\], \\<>, or \\~>. List it as an INVARIANT to check every state."
// Complete public corpus input (254 B) and independent live v2 response (268 B).
// The service observation is deliberately not derived from the product renderer.
const userInput =
  "# UserNoDeadlock\n\nTLC reached 4 states and 3 steps. The chart draws 4 states and 3 arrows.\n\n## NoDeadlock breaks\nThe shortest path has 1 step:\n0. 0\n1. Next: 1\n\n## CHECK_DEADLOCK breaks\nThe shortest path has 3 steps:\n0. 0\n1. Next: 1\n2. Next: 2\n3. Next: 3\n"
const userActual =
  "# UserNoDeadlock\n\nTLC reached 4 states and 3 steps. The chart draws 4 states and 3 arrows.\n\n## NoDeadlock breaks\n\nThe shortest path has 1 step:<br />0. 0\n\n1. Next: 1\n\n## CHECK\\_DEADLOCK breaks\n\nThe shortest path has 3 steps:<br />0. 0\n\n1. Next: 1\n2. Next: 2\n3. Next: 3"

async function originalFailure(version: 9 | 10, extras: Parameters<typeof fixture>[0] = []) {
  const f = fixture(
    [
      {
        path: "scripts/test/corpus/Counter/report.md",
        bytes: encode(counterInput),
        mode: "100644",
      },
      {
        path: "scripts/test/corpus/UserNoDeadlock/report.md",
        bytes: encode(userInput),
        mode: "100644",
      },
      ...extras,
    ],
    {
      recovery: true,
      main: "---\nname: initial-source\ndescription: Initial complete member\nlicense: MIT\n---\n\n# Initial\n\nComplete fixed source.\n",
      readback: (wire) => {
        if (wire.startsWith("<h1>Counter</h1>")) return counterActual
        if (wire.startsWith("<h1>UserNoDeadlock</h1>")) return userActual
        return wire.replace(/^<h1>([^\n]*)<\/h1>(?=\n|$)/u, "# $1")
      },
    },
  )
  const prepared = await f.prepare(true),
    member = f.snapshot.members[0]!
  const plan = await f.run(
    makeSharedCreatePlan(
      library,
      {
        portable: {
          ...member.portable,
          files: member.portable.files.filter((file) => file.path.endsWith(".md")),
        },
        sourceProjection: fixedProjection(prepared),
        enabled: true,
      },
      version,
    ),
  )
  const failure = await f.run(Effect.flip(executeSharedCreate(library, { plan, mode: "create" })))
  expect(failure.code).toBe("SHARED_CREATE_BODY_MISMATCH")
  const target = property(failure.details).skill_page_id
  if (typeof target !== "string") throw new Error("Expected original acknowledged main")
  const selection = {
    entry: library.skills.database_id,
    operationId: plan.operation_id,
    target,
    plan,
  }
  f.clear()
  return { f, plan, target, selection }
}

test("original v10 known mismatch has a separately typed v11 recovery and preserves every allocated page", async () => {
  const { f, plan, target, selection } = await originalFailure(10)
  const before = [...f.base.bodies],
    originalPlan = digest(plan)
  const review = await f.run(reviewSharedCreateRecovery(selection))
  expect(review.version).toBe(4)
  expect(review.projection_version).toBe(11)
  expect(review.bindings).toHaveLength(plan.files.length)
  expect(f.writes()).toHaveLength(0)
  const dry = await f.run(
    applySharedCreateRecovery({ plan, review, reviewId: review.review_id, dryRun: true }),
  )
  expect(property(dry).remaining_pages).toBe(0)
  expect(f.writes()).toHaveLength(0)
  const result = await f.run(
    applySharedCreateRecovery({ plan, review, reviewId: review.review_id }),
  )
  expect(result.status).toBe("recovered")
  expect(property(result).created_pages).toBe(0)
  expect(f.nativeCreates()).toHaveLength(0)
  expect(
    f.calls.filter((call) => call.method === "PATCH" && call.path.includes("/markdown")),
  ).toHaveLength(0)
  expect([...f.base.bodies]).toEqual(before)
  expect(digest(plan)).toBe(originalPlan)
  f.credential("cold-v11-recovery")
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  expect(property(await f.run(reconcileSharedCreateRecovery(selection))).verified).toBe(true)
  const consumed = await f.run(
    Effect.gen(function* () {
      return yield* openSharedConsumer({
        library,
        target,
        scope: yield* authScope,
        startedAt: Date.now(),
        forceFull: true,
        readOnly: true,
      })
    }),
  )
  expect(consumed.files).toHaveLength(7)
  expect(consumed.files.find((file) => file.path === "scripts/run.js")?.mode).toBe("100755")
  expect(f.writes()).toHaveLength(0)
})

async function acknowledgedRecoveryFailure(extras: Parameters<typeof fixture>[0] = []) {
  const state = await originalFailure(9, extras),
    { f, plan, selection } = state
  const review = await f.run(reviewSharedCreateRecovery(selection))
  expect(review.version).toBe(3)
  expect(review.projection_version).toBe(10)
  const failed = await f.run(
    Effect.flip(applySharedCreateRecovery({ plan, review, reviewId: review.review_id })),
  )
  expect(failed.code).toBe("SHARED_CREATE_RECOVERY_REQUIRED")
  expect(f.nativeCreates()).toHaveLength(plan.files.length - review.bindings.length)
  expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(0)
  expect(
    await f.run(querySharedRecords(library, { skillPageId: state.target, kind: "file_event" })),
  ).toHaveLength(0)
  f.clear()
  return { ...state, review }
}

test("all acknowledged v10 recovery allocations continue by an explicit v11 decision without another native POST", async () => {
  const { f, plan, target, selection, review: originalReview } = await acknowledgedRecoveryFailure()
  const before = [...f.base.bodies],
    reviewHash = digest(originalReview)
  const review = await f.run(reviewSharedCreateContinuation(selection))
  expect(review.version).toBe(2)
  expect(review.original_write_outcome).toBe("acknowledged")
  expect(property(review).projection_version).toBe(11)
  expect(review.bindings).toHaveLength(plan.files.length)
  expect(f.writes()).toHaveLength(0)
  const dry = await f.run(
    applySharedCreateContinuation({ plan, review, reviewId: review.continuation_id, dryRun: true }),
  )
  expect(property(dry).remaining_pages).toBe(0)
  expect(f.writes()).toHaveLength(0)
  const result = await f.run(
    applySharedCreateContinuation({ plan, review, reviewId: review.continuation_id }),
  )
  expect(result.status).toBe("recovered")
  expect(f.nativeCreates()).toHaveLength(0)
  expect(
    f.calls.filter((call) => call.method === "PATCH" && call.path.includes("/markdown")),
  ).toHaveLength(0)
  expect([...f.base.bodies]).toEqual(before)
  expect(digest(originalReview)).toBe(reviewHash)
  f.credential("cold-acknowledged-continuation")
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  expect(await f.run(reconcileSharedCreateRecovery(selection))).toMatchObject({
    verified: true,
    verification: "original_acknowledged_continuation_outcome",
    continuation_operation_id: review.continuation_id,
    created_pages: 0,
    existing_pages_preserved: plan.files.length,
    current_snapshot_verified: false,
  })
  const consumed = await f.run(
    Effect.gen(function* () {
      return yield* openSharedConsumer({
        library,
        target,
        scope: yield* authScope,
        startedAt: Date.now(),
        forceFull: true,
        readOnly: true,
      })
    }),
  )
  expect(consumed.files).toHaveLength(7)
  expect(f.writes()).toHaveLength(0)
})

type FailureFixture = Awaited<ReturnType<typeof acknowledgedRecoveryFailure>>
function dispatches(f: FailureFixture["f"], operation: string) {
  return [...f.base.json]
    .filter(
      ([key, value]) =>
        /\/source-op-[a-f0-9]{64}\.json$/u.test(key) &&
        String(property(value).identity).startsWith(operation + ":"),
    )
    .map(([key, value]) => ({
      key,
      value: property(value),
      ackKey: key.replace("/source-op-", "/source-ack-"),
    }))
}

test("complete 407-file continuation keeps all 35 ACKs within ordinary individual Record budgets", async () => {
  const extras: NonNullable<Parameters<typeof fixture>[0]> = [
    ...Array.from({ length: 31 }, (_, index) => ({
      path: `scripts/test/corpus/Extra${String(index).padStart(2, "0")}/report.md`,
      bytes: encode(`# Extra ${index}\n\nComplete body.\n`),
      mode: "100644" as const,
    })),
    ...Array.from({ length: 369 }, (_, index) => ({
      path: `data/extra${String(index).padStart(3, "0")}.json`,
      bytes: encode(`{"index":${index}}\n`),
      mode: "100644" as const,
    })),
  ]
  const { f, plan, selection, target } = await acknowledgedRecoveryFailure(extras)
  expect(fixedProjection(plan).binding.files).toHaveLength(407)
  expect(plan.files).toHaveLength(35)
  const review = await f.run(reviewSharedCreateContinuation(selection))
  expect(review.version).toBe(2)
  if (review.version !== 2) throw new Error("Expected all-acknowledged continuation")
  expect(review.allocations).toHaveLength(35)
  expect(
    encode(
      canonicalSharedJson({ version: 1, operation_id: review.continuation_id, payload: review }),
    ).length,
  ).toBeLessThanOrEqual(65_536)
  const before = [...f.base.bodies]
  const result = await f.run(
    applySharedCreateContinuation({ plan, review, reviewId: review.continuation_id }),
  )
  expect(result.status).toBe("recovered")
  expect(f.nativeCreates()).toHaveLength(0)
  expect([...f.base.bodies]).toEqual(before)
  for (const ref of review.allocations) {
    const row = record(f, ref.record_id)
    expect(encode(canonicalSharedJson(row.envelope)).length).toBeLessThanOrEqual(65_536)
  }
  f.base.json.clear()
  f.base.objects.clear()
  f.credential("cold-complete-407-continuation")
  f.clear()
  const consumed = await f.run(
    Effect.gen(function* () {
      return yield* openSharedConsumer({
        library,
        target,
        scope: yield* authScope,
        startedAt: Date.now(),
        forceFull: true,
        readOnly: true,
      })
    }),
  )
  expect(consumed.files).toHaveLength(407)
  expect(consumed.files.find((file) => file.path === "scripts/run.js")?.mode).toBe("100755")
  expect(f.writes()).toHaveLength(0)
}, 60_000)

test("continuation preserves main-first allocation when the complete input sorts another path first", async () => {
  const { f, plan, selection, target } = await acknowledgedRecoveryFailure([
    { path: "A.md", bytes: encode("# Before main\n\nComplete.\n"), mode: "100644" },
  ])
  expect(plan.files[0]?.path).toBe("A.md")
  const review = await f.run(reviewSharedCreateContinuation(selection))
  expect(review.bindings[0]?.page_id).toBe(target)
  const result = await f.run(
    applySharedCreateContinuation({ plan, review, reviewId: review.continuation_id }),
  )
  expect(result.status).toBe("recovered")
  expect(f.nativeCreates()).toHaveLength(0)
})

test("an oversized complete native ACK is refused before review or any Record creation", async () => {
  const { f, plan, selection } = await originalFailure(10)
  const native = dispatches(f, plan.operation_id).find(
    (item) =>
      property(property(item.value.body).parent).data_source_id === library.skills.data_source_id,
  )!
  const ack = structuredClone(property(f.base.json.get(native.ackKey)))
  property(ack.response).large_generated_field = "x".repeat(65_536)
  ack.response_hash = digest(ack.response)
  f.base.json.set(native.ackKey, ack)
  const result = await f.run(Effect.flip(reviewSharedCreateRecovery(selection)))
  expect(result.code).toBe("SHARED_RECORD_TOO_LARGE")
  expect(f.writes()).toHaveLength(0)
})

test.each([
  "missing-record-dispatch",
  "missing-record-ack",
  "missing-native-ack",
  "changed-recovery-journal",
  "extra-unknown-request",
  "extra-acknowledged-request",
  "cross-scope-dispatch",
  "already-projected",
  "already-enabled",
  "initial-event-present",
] as const)("acknowledged continuation rejects %s before any write", async (kind) => {
  const { f, plan, selection, review } = await acknowledgedRecoveryFailure()
  const all = dispatches(f, review.review_id)
  const record = all.find(
    (item) =>
      property(property(item.value.body).parent).data_source_id === library.records.data_source_id,
  )!
  const native = all.find(
    (item) =>
      property(property(item.value.body).parent).data_source_id === library.files.data_source_id,
  )!
  expect(record).toBeDefined()
  expect(native).toBeDefined()
  if (kind === "missing-record-dispatch") f.base.json.delete(record.key)
  if (kind === "missing-record-ack") f.base.json.delete(record.ackKey)
  if (kind === "missing-native-ack") f.base.json.delete(native.ackKey)
  if (kind === "changed-recovery-journal") {
    const key = [...f.base.json.keys()].find((item) =>
      item.startsWith("operations/shared-native-recovery/"),
    )!
    const value = structuredClone(property(f.base.json.get(key)))
    property(value.review).decision = "invented-decision"
    f.base.json.set(key, value)
  }
  if (kind === "extra-unknown-request" || kind === "extra-acknowledged-request") {
    const body = { ...property(native.value.body), markdown: "Extra unapproved allocation" }
    const request = {
      identity: review.review_id + ":" + digest(["v1/pages", "POST", body]),
      path: "v1/pages",
      method: "POST",
      body,
    }
    const dispatch = { version: 1, operation: "source-op-" + digest(request), ...request }
    const key = native.key.replace(/source-op-[a-f0-9]{64}/u, dispatch.operation)
    f.base.json.set(key, dispatch)
    if (kind === "extra-acknowledged-request") {
      const ack = structuredClone(property(f.base.json.get(native.ackKey)))
      ack.operation_id = dispatch.operation
      ack.request_hash = digest(dispatch)
      property(ack.response).id = "00000000-0000-4000-8000-000000009999"
      ack.response_hash = digest(ack.response)
      f.base.json.set(key.replace("/source-op-", "/source-ack-"), ack)
    }
  }
  if (kind === "cross-scope-dispatch") {
    const key = native.key.replace(/shared-sources\/[^/]+\//u, "shared-sources/another-scope/")
    f.base.json.set(key, f.base.json.get(native.key))
    f.base.json.delete(native.key)
  }
  if (kind === "already-projected") {
    const page = String(property(property(f.base.json.get(native.ackKey)).response).id)
    property(
      property(f.files.get(page)!.properties)[library.files.property_ids.Projection!],
    ).rich_text = [{ plain_text: "changed projection" }]
  }
  if (kind === "already-enabled")
    property(
      property(f.skills.get(selection.target)!.properties)[library.skills.property_ids.Enabled!],
    ).checkbox = true
  if (kind === "initial-event-present")
    await f.run(
      appendSharedRecord(library, {
        mode: "create",
        recordId: plan.files[0]!.event.event_id,
        operationId: plan.files[0]!.event.event_id,
        skillPageId: selection.target,
        entityId: plan.files[0]!.file_id,
        kind: "file_event",
        payload: plan.files[0]!.event,
      }),
    )
  f.clear()
  const before = structuredClone([...f.base.json])
  const result = await f.run(Effect.result(reviewSharedCreateContinuation(selection)))
  expect(result._tag).toBe("Failure")
  expect(f.writes()).toHaveLength(0)
  expect([...f.base.json]).toEqual(before)
})

test.each(["body", "owner", "path", "projection"] as const)(
  "a reviewed continuation rejects changed %s before its first write",
  async (kind) => {
    const { f, plan, selection } = await acknowledgedRecoveryFailure()
    const review = await f.run(reviewSharedCreateContinuation(selection)),
      binding = review.bindings[1]!
    if (kind === "body")
      f.base.bodies.set(
        binding.page_id,
        f.base.bodies.get(binding.page_id)! + "\nHuman change after review",
      )
    else {
      const props = property(f.files.get(binding.page_id)!.properties),
        key =
          library.files.property_ids[
            kind === "owner" ? "Skill" : kind === "path" ? "Path" : "Projection"
          ]!
      if (kind === "owner")
        property(props[key]).relation = [{ id: "00000000-0000-4000-8000-000000009999" }]
      else property(props[key]).rich_text = [{ plain_text: "changed" }]
    }
    f.clear()
    const result = await f.run(
      Effect.result(
        applySharedCreateContinuation({ plan, review, reviewId: review.continuation_id }),
      ),
    )
    expect(result._tag).toBe("Failure")
    expect(f.writes()).toHaveLength(0)
  },
)

test.each([false, true])(
  "an acknowledged continuation unknown PATCH is never resent (visible=%s)",
  async (visible) => {
    const { f, plan, selection } = await acknowledgedRecoveryFailure()
    const review = await f.run(reviewSharedCreateContinuation(selection))
    let attempts = 0
    const action = Effect.gen(function* () {
      const api = yield* Notion
      return yield* applySharedCreateContinuation({
        plan,
        review,
        reviewId: review.continuation_id,
      }).pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) =>
            options?.method === "PATCH"
              ? Effect.gen(function* () {
                  attempts++
                  if (visible) yield* api.request(path, body, options)
                  return yield* Effect.fail(
                    fail("WRITE_OUTCOME_UNKNOWN", "Lost original continuation metadata response"),
                  )
                })
              : api.request(path, body, options),
        }),
      )
    })
    expect((await f.run(Effect.result(action)))._tag).toBe("Failure")
    expect(attempts).toBe(1)
    expect(f.nativeCreates()).toHaveLength(0)
    f.clear()
    expect(
      (
        await f.run(
          Effect.result(
            applySharedCreateContinuation({ plan, review, reviewId: review.continuation_id }),
          ),
        )
      )._tag,
    ).toBe("Failure")
    expect(f.writes()).toHaveLength(0)
    expect(f.currentBodies()).toHaveLength(0)
  },
)

function record(f: FailureFixture["f"], id: string) {
  const raw = [...f.base.records.values()].find(
    (row) =>
      text(
        property(property(row.properties)[library.records.property_ids["Record ID"]!]).rich_text,
      ) === id,
  )
  if (!raw) throw new Error("Missing controlled Record " + id)
  const fields = property(raw.properties),
    kind = Schema.decodeUnknownSync(SharedRecordKindSchema)(
      property(property(fields[library.records.property_ids.Kind!]).select).name,
    )
  const envelope = property(
    JSON.parse(
      canonicalSharedRecordEnvelope(
        kind,
        text(property(fields[library.records.property_ids.Payload!]).rich_text),
      ),
    ),
  )
  return { raw, fields, envelope }
}
function rewriteRecord(
  f: FailureFixture["f"],
  id: string,
  rewrite: (payload: Record<string, unknown>, envelope: Record<string, unknown>) => void,
) {
  const found = record(f, id)
  rewrite(property(found.envelope.payload), found.envelope)
  const canonical = canonicalSharedJson(found.envelope),
    hash = digest(found.envelope),
    encoded = encodeSharedRecordStorage(canonical)
  const rich = (value: string) =>
    Array.from({ length: Math.ceil(value.length / 1900) }, (_, index) => ({
      type: "text",
      text: { content: value.slice(index * 1900, (index + 1) * 1900) },
    }))
  property(found.fields[library.records.property_ids.Payload!]).rich_text = rich(encoded)
  property(found.fields[library.records.property_ids.Hash!]).rich_text = rich(hash)
  return { ...found, hash, rich }
}

test.each(["known", "continuation"] as const)(
  "cold %s completion requires every complete immutable native ACK proof",
  async (kind) => {
    const state = kind === "known" ? await originalFailure(10) : await acknowledgedRecoveryFailure()
    const { f, plan, selection, target } = state
    if (kind === "known") {
      const review = await f.run(reviewSharedCreateRecovery(selection))
      await f.run(applySharedCreateRecovery({ plan, review, reviewId: review.review_id }))
    } else {
      const review = await f.run(reviewSharedCreateContinuation(selection))
      await f.run(applySharedCreateContinuation({ plan, review, reviewId: review.continuation_id }))
    }
    const events = (
      await f.run(querySharedRecords(library, { skillPageId: target, kind: "file_event" }))
    ).map((row) => Schema.decodeUnknownSync(FileEventSchema)(row.payload))
    const directoryId =
      kind === "known"
        ? sharedCreateRecoveryReviewId(plan.operation_id)
        : sharedCreateContinuationReviewId(plan.operation_id)
    const directory = property(record(f, directoryId).envelope.payload),
      allocations =
        kind === "known" ? property(directory.bootstrap).allocations : directory.allocations
    if (!Array.isArray(allocations)) throw new Error("Expected immutable allocation directory")
    const proofId = String(property(allocations[0]).record_id)
    const saved = structuredClone([...f.base.records])
    f.credential("cold-v11-complete-proof-test")
    for (const variant of [
      "missing-proof",
      "changed-request",
      "changed-response",
      "changed-commitment",
    ] as const) {
      f.base.records.clear()
      for (const [key, value] of structuredClone(saved)) f.base.records.set(key, value)
      f.base.json.clear()
      f.base.objects.clear()
      f.clear()
      if (variant === "missing-proof") f.base.records.delete(String(record(f, proofId).raw.id))
      else {
        let nextReference: Record<string, unknown> | undefined
        if (variant !== "changed-commitment") {
          const result = rewriteRecord(f, proofId, (payload, envelope) => {
            const ack = property(payload.acknowledgement)
            if (variant === "changed-request") {
              const dispatch = property(payload.dispatch)
              property(dispatch.body).markdown = "Changed immutable original request"
              const request = {
                identity:
                  payload.allocation_operation_id +
                  ":" +
                  digest(["v1/pages", "POST", dispatch.body]),
                path: "v1/pages",
                method: "POST",
                body: dispatch.body,
              }
              payload.dispatch = {
                version: 1,
                operation: "source-op-" + digest(request),
                ...request,
              }
              ack.operation_id = property(payload.dispatch).operation
              ack.request_hash = digest(payload.dispatch)
            } else {
              property(ack.response).id = "00000000-0000-4000-8000-000000009999"
              ack.response_hash = digest(ack.response)
            }
            envelope.operation_id = "retain-native-ack-" + digest(payload)
          })
          const nextId = "native-ack-" + digest(result.envelope.payload)
          property(result.fields[library.records.property_ids["Record ID"]!]).rich_text =
            result.rich(nextId)
          property(result.fields[library.records.property_ids["Entity ID"]!]).rich_text =
            result.rich(nextId)
          property(result.fields[library.records.property_ids["Operation ID"]!]).rich_text =
            result.rich(String(result.envelope.operation_id))
          nextReference = { ...property(allocations[0]), record_id: nextId, hash: result.hash }
        }
        let nextId = "",
          bootstrap: unknown
        const changed = rewriteRecord(f, directoryId, (payload, envelope) => {
          const items =
            kind === "known" ? property(payload.bootstrap).allocations : payload.allocations
          if (!Array.isArray(items) || !Array.isArray(payload.files))
            throw new Error("Incomplete review")
          if (nextReference) items[0] = nextReference
          else property(payload.files[0]).input_sha256 = "f".repeat(64)
          const idKey = kind === "known" ? "review_id" : "continuation_id"
          const fields = Object.fromEntries(
            Object.entries(payload).filter(([key]) => key !== idKey),
          )
          nextId = (kind === "known" ? "create-recovery-" : "create-continuation-") + digest(fields)
          payload[idKey] = nextId
          envelope.operation_id = nextId
          bootstrap = payload.bootstrap
        })
        property(changed.fields[library.records.property_ids["Operation ID"]!]).rich_text =
          changed.rich(nextId)
        const completion = rewriteRecord(
          f,
          sharedCreateRecoveryOutcomeId(plan.operation_id),
          (payload, envelope) => {
            if (kind === "known") {
              payload.recovery_id = nextId
              payload.review_record_hash = changed.hash
              payload.bootstrap_sha256 = digest(bootstrap)
            } else {
              payload.continuation_id = nextId
              payload.continuation_review_record_hash = changed.hash
            }
            envelope.operation_id = nextId
          },
        )
        property(completion.fields[library.records.property_ids["Operation ID"]!]).rich_text =
          completion.rich(nextId)
      }
      const result = await f.run(
        Effect.result(loadPendingSharedCreates(library, { skillPageId: target, events })),
      )
      expect(result._tag, variant).toBe("Failure")
      expect(f.currentBodies(), variant).toHaveLength(0)
      expect(f.writes(), variant).toHaveLength(0)
      expect(f.base.json.size, variant).toBe(0)
    }
  },
)
