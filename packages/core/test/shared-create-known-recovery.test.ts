import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { authScope } from "../src/catalog.ts"
import { fail, property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import { makeSharedCreatePlan } from "../src/shared-create-model.ts"
import { sharedCreateOutcomeId } from "../src/shared-create-outcome.ts"
import {
  applySharedCreateRecovery,
  reconcileSharedCreateRecovery,
  reviewSharedCreateRecovery,
} from "../src/shared-create-recovery.ts"
import { executeSharedCreate, loadPendingSharedCreates } from "../src/shared-create.ts"
import { FileEventSchema } from "../src/shared-file-state.ts"
import type { SharedLibrary } from "../src/shared-library-model.ts"
import {
  canonicalSharedJson,
  canonicalSharedRecordEnvelope,
  querySharedRecords,
  SharedRecordKindSchema,
} from "../src/shared-records.ts"
import { encodeSharedRecordStorage } from "../src/shared-record-codec.ts"
import {
  sharedCreateRecoveryOutcomeId,
  sharedCreateRecoveryReviewId,
} from "../src/shared-create-recovery-completion.ts"
import { sharedCreateDispatch } from "../src/shared-create-dispatch.ts"
import {
  fixture,
  library as sourceLibrary,
  fixedProjection,
  ids as sourceIds,
} from "./shared-source-projection-fixture.ts"

const library: SharedLibrary = sourceLibrary
const encode = (text: string) => new TextEncoder().encode(text)
const counterPath = "scripts/test/corpus/Counter/report.md"
// Independent full input and actual v2 response from the original Counter failure.
const counterInput =
  "# Counter\n\nTLC reached 4 states and 3 steps. The chart draws 4 states and 3 arrows.\n\n## Rules that hold\nLow, StaysSmall\nTLC checked Low only in the initial states, because it has no [], <>, or ~>. List it as an INVARIANT to check every state.\n"
const counterWire =
  "<h1>Counter</h1>\n\nTLC reached 4 states and 3 steps. The chart draws 4 states and 3 arrows.\n\n## Rules that hold\nLow, StaysSmall\nTLC checked Low only in the initial states, because it has no [], <>, or ~>. List it as an INVARIANT to check every state."
const counterActual =
  "# Counter\n\nTLC reached 4 states and 3 steps. The chart draws 4 states and 3 arrows.\n\n## Rules that hold\n\nLow, StaysSmall<br />TLC checked Low only in the initial states, because it has no \\[\\], \\<>, or \\~>. List it as an INVARIANT to check every state."
const header =
  "---\nname: initial-source\ndescription: Initial complete member\nlicense: MIT\n---\n\n"

async function originalFailure(onlyMain = false, zeroSuffix = false, earlyCounter = false) {
  const extra = onlyMain
    ? zeroSuffix
      ? Array.from({ length: 3 }, (_, i) => ({
          path: `scripts/executable-${i}.js`,
          bytes: encode(`#!/usr/bin/env node\nconsole.log(${i})\n`),
          mode: "100755" as const,
        }))
      : []
    : [
        {
          path: earlyCounter ? "A.md" : counterPath,
          bytes: encode(counterInput),
          mode: "100644" as const,
        },
        ...Array.from({ length: 32 }, (_, i) => ({
          path: `scripts/test/corpus/Next${String(i).padStart(2, "0")}/report.md`,
          bytes: encode(`# Next ${i}\n\nStable reference ${i}.\n`),
          mode: "100644" as const,
        })),
        ...Array.from({ length: 369 }, (_, i) => ({
          path: `assets/fixed-${String(i).padStart(3, "0")}.bin`,
          bytes: new Uint8Array([0, 255, i % 256, Math.floor(i / 256)]),
          mode: "100644" as const,
        })),
      ]
  const f = fixture(extra, {
    main: header + (onlyMain ? counterInput : "# Initial\n\nComplete fixed source.\n"),
    recovery: true,
    readback: (wire) =>
      wire === counterWire ? counterActual : wire.replace(/^<h1>([^\n]*)<\/h1>(?=\n|$)/u, "# $1"),
  })
  if (zeroSuffix) {
    const original = f.snapshot.members[0]!
    if (!original.git_manifest) throw new Error("Expected complete original Git manifest")
    const member = {
      ...original,
      portable: {
        ...original.portable,
        files: original.portable.files.filter((file) => file.path !== "references/a.md"),
      },
      git_manifest: {
        ...original.git_manifest,
        files: original.git_manifest.files.filter((file) => file.path !== "references/a.md"),
      },
    }
    Object.assign(f.snapshot, { members: [member] })
    f.registerSnapshot(f.snapshot)
  }
  const current = await f.prepare(true),
    member = f.snapshot.members[0]!
  const plan = await f.run(
    makeSharedCreatePlan(
      library,
      {
        portable: {
          ...member.portable,
          files: member.portable.files.filter((file) => file.path.endsWith(".md")),
        },
        sourceProjection: current.source_projection,
        enabled: true,
      },
      9,
    ),
  )
  expect(fixedProjection(plan).binding.files).toHaveLength(onlyMain ? (zeroSuffix ? 7 : 5) : 407)
  const failure = await f.run(Effect.flip(executeSharedCreate(library, { plan, mode: "create" })))
  expect(failure.code).toBe("SHARED_CREATE_BODY_MISMATCH")
  const target = property(failure.details).skill_page_id
  if (typeof target !== "string") throw new Error("Missing exact original main")
  expect(f.nativeCreates()).toHaveLength(onlyMain ? 1 : earlyCounter ? 2 : 3)
  const originalRows = await f.run(
    querySharedRecords(library, { skillPageId: target, kind: "operation" }),
  )
  const originalOutcome = originalRows.find(
    (row) => row.record_id === sharedCreateOutcomeId(plan.operation_id),
  )
  expect(originalOutcome === undefined).toBe(onlyMain)
  if (originalOutcome) expect(property(originalOutcome.payload).status).toBe("needs_review")
  const prefix = [...f.base.bodies].filter(([page]) => f.skills.has(page) || f.files.has(page))
  const selection = {
    entry: library.skills.database_id,
    operationId: plan.operation_id,
    target,
    plan,
  }
  f.clear()
  return { f, plan, target, originalRows, originalOutcome, prefix, selection }
}

test("known v9 failure reviews the exact acknowledged 3-page prefix without mutating original facts", async () => {
  const { f, plan, selection, originalOutcome } = await originalFailure()
  const before = structuredClone([...f.base.json])
  const review = await f.run(reviewSharedCreateRecovery(selection))
  expect(review.version).toBe(3)
  expect(review.projection_version).toBe(10)
  expect(review.original_outcome_sha256).toBe(originalOutcome!.hash)
  expect(review.bindings).toHaveLength(3)
  expect(review.observations).toHaveLength(3)
  expect(review.files).toHaveLength(35)
  expect(new TextEncoder().encode(canonicalSharedJson(review)).length).toBeLessThanOrEqual(65_536)
  const dry = await f.run(
    applySharedCreateRecovery({ plan, review, reviewId: review.review_id, dryRun: true }),
  )
  expect(property(dry).existing_pages).toBe(3)
  expect(property(dry).remaining_pages).toBe(32)
  expect(f.writes()).toHaveLength(0)
  expect([...f.base.json]).toEqual(before)
})

test("known v9 recovery preserves 3 original pages, creates only 32 suffix pages and opens the complete 407-file cold tree", async () => {
  const { f, plan, selection, target, originalOutcome, prefix } = await originalFailure()
  const originalPlan = structuredClone(plan)
  const review = await f.run(reviewSharedCreateRecovery(selection))
  const result = await f.run(
    applySharedCreateRecovery({ plan, review, reviewId: review.review_id }),
  )
  expect(result.status).toBe("recovered")
  expect(property(result).existing_pages_preserved).toBe(3)
  expect(property(result).created_pages).toBe(32)
  expect(f.nativeCreates()).toHaveLength(32)
  expect(
    f.calls.filter((call) => call.method === "PATCH" && call.path.includes("/markdown")),
  ).toHaveLength(0)
  for (const [page, body] of prefix) expect(f.base.bodies.get(page)).toBe(body)
  expect(plan).toEqual(originalPlan)
  const rows = await f.run(querySharedRecords(library, { skillPageId: target, kind: "operation" }))
  expect(rows.find((row) => row.record_id === sharedCreateOutcomeId(plan.operation_id))).toEqual(
    originalOutcome,
  )
  const events = (
    await f.run(querySharedRecords(library, { skillPageId: target, kind: "file_event" }))
  ).map((row) => Schema.decodeUnknownSync(FileEventSchema)(row.payload))
  expect(events).toHaveLength(35)
  f.credential("independent-known-recovery-reader")
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  expect(await f.run(loadPendingSharedCreates(library, { skillPageId: target, events }))).toEqual(
    [],
  )
  expect(f.currentBodies()).toHaveLength(0)
  const reconciled = await f.run(reconcileSharedCreateRecovery(selection))
  expect(property(reconciled).verified).toBe(true)
  expect(property(reconciled).current_snapshot_verified).toBe(false)
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

test("v9 sole main ACK without manifest uses its explicit no-outcome recovery branch", async () => {
  const { f, plan, selection, target } = await originalFailure(true)
  const review = await f.run(reviewSharedCreateRecovery(selection))
  expect(review.version).toBe(3)
  expect(review.original_outcome_sha256).toBeNull()
  expect(review.bindings).toHaveLength(1)
  f.clear()
  const result = await f.run(
    applySharedCreateRecovery({ plan, review, reviewId: review.review_id }),
  )
  expect(result.status).toBe("recovered")
  expect(property(result).existing_pages_preserved).toBe(1)
  expect(property(result).created_pages).toBe(1)
  expect(f.nativeCreates()).toHaveLength(1)
  expect(f.base.bodies.get(target)).toBe(counterActual)
  expect(
    f.calls.filter((call) => call.method === "PATCH" && call.path.includes("/markdown")),
  ).toHaveLength(0)
})

test("v9 sole-main recovery creates zero native pages and retains all six raw files and four executable modes", async () => {
  const { f, plan, selection, target } = await originalFailure(true, true)
  expect(plan.files).toHaveLength(1)
  const review = await f.run(reviewSharedCreateRecovery(selection))
  if (review.version !== 3) throw new Error("Expected the immutable v9 to v10 review")
  expect(property(review.files[0]?.content).frontmatter).toContain("license: MIT")
  const dry = await f.run(
    applySharedCreateRecovery({ plan, review, reviewId: review.review_id, dryRun: true }),
  )
  expect(property(dry).remaining_pages).toBe(0)
  const result = await f.run(
    applySharedCreateRecovery({ plan, review, reviewId: review.review_id }),
  )
  expect(property(result).created_pages).toBe(0)
  expect(f.nativeCreates()).toHaveLength(0)
  f.credential("independent-zero-suffix-reader")
  f.base.json.clear()
  f.base.objects.clear()
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
  expect(consumed.files).toHaveLength(7)
  expect(consumed.files.filter((file) => file.mode === "100755")).toHaveLength(4)
  expect(f.base.bodies.get(target)).toBe(counterActual)
  expect(f.writes()).toHaveLength(0)
})

type FailureFixture = Awaited<ReturnType<typeof originalFailure>>
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalSharedJson(value)).digest("hex")
function originalDispatches(f: FailureFixture["f"], operation: string) {
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

test.each([
  "missing-record-ack",
  "missing-reference-ack",
  "changed-record-ack",
  "archived-reference-ack",
  "missing-record-dispatch",
  "extra-unknown-request",
  "extra-acknowledged-request",
  "changed-journal",
  "missing-retained-object",
] as const)(
  "the complete original request set rejects %s without a recovery write",
  async (kind) => {
    const { f, plan, selection } = await originalFailure()
    const all = originalDispatches(f, plan.operation_id)
    expect(all).toHaveLength(76)
    const record = all.find(
      (item) =>
        property(property(item.value.body).parent).data_source_id ===
        library.records.data_source_id,
    )!
    const reference = all.find(
      (item) =>
        property(property(item.value.body).parent).data_source_id === library.files.data_source_id,
    )!
    if (kind === "missing-record-ack") f.base.json.delete(record.ackKey)
    if (kind === "missing-reference-ack") f.base.json.delete(reference.ackKey)
    if (kind === "missing-record-dispatch") f.base.json.delete(record.key)
    if (kind === "archived-reference-ack") {
      const ack = structuredClone(property(f.base.json.get(reference.ackKey)))
      property(ack.response).is_archived = true
      ack.response_hash = digest(ack.response)
      f.base.json.set(reference.ackKey, ack)
    }
    if (kind === "changed-record-ack") {
      const ack = structuredClone(property(f.base.json.get(record.ackKey)))
      property(
        property(property(ack.response).properties)[library.records.property_ids.Hash!],
      ).rich_text = [{ plain_text: "0".repeat(64) }]
      ack.response_hash = digest(ack.response)
      f.base.json.set(record.ackKey, ack)
    }
    if (kind === "extra-unknown-request" || kind === "extra-acknowledged-request") {
      const body = { ...property(reference.value.body), markdown: "Another unapproved body" }
      const request = {
        identity: plan.operation_id + ":" + digest(["v1/pages", "POST", body]),
        path: "v1/pages",
        method: "POST",
        body,
      }
      const dispatch = { version: 1, operation: "source-op-" + digest(request), ...request }
      const key = reference.key.replace(/source-op-[a-f0-9]{64}/u, dispatch.operation)
      f.base.json.set(key, dispatch)
      if (kind === "extra-acknowledged-request") {
        const ack = structuredClone(property(f.base.json.get(reference.ackKey)))
        ack.operation_id = dispatch.operation
        ack.request_hash = digest(dispatch)
        property(ack.response).id = "00000000-0000-4000-8000-000000009999"
        ack.response_hash = digest(ack.response)
        f.base.json.set(key.replace("/source-op-", "/source-ack-"), ack)
      }
    }
    if (kind === "changed-journal") {
      const key = [...f.base.json.keys()].find((key) =>
        key.startsWith("operations/shared-native-create/"),
      )!
      const value = structuredClone(property(f.base.json.get(key)))
      property(value.plan).description = "Another original input"
      f.base.json.set(key, value)
    }
    if (kind === "missing-retained-object") {
      const row = [...f.base.records].find(
        ([, value]) =>
          property(property(property(value.properties)[library.records.property_ids.Kind!]).select)
            .name === "object",
      )!
      f.base.records.delete(row[0])
    }
    const before = structuredClone([...f.base.json])
    const result = await f.run(Effect.result(reviewSharedCreateRecovery(selection)))
    expect(result._tag).toBe("Failure")
    expect(f.writes()).toHaveLength(0)
    expect([...f.base.json]).toEqual(before)
  },
)

test.each(["body", "owner", "path", "file-id", "source"] as const)(
  "a %s change in the reviewed original prefix stops all recovery writes",
  async (kind) => {
    const { f, plan, selection } = await originalFailure()
    const review = await f.run(reviewSharedCreateRecovery(selection)),
      reference = review.bindings[1]!
    if (kind === "body")
      f.base.bodies.set(reference.page_id, f.base.bodies.get(reference.page_id)! + "\nHuman edit")
    if (kind === "source")
      property(f.source.properties[sourceIds.Description!]).rich_text = [
        { plain_text: "Source edited after review" },
      ]
    if (kind === "owner" || kind === "path" || kind === "file-id") {
      const props = property(f.files.get(reference.page_id)!.properties)
      const key =
        library.files.property_ids[
          kind === "owner" ? "Skill" : kind === "path" ? "Path" : "File ID"
        ]!
      if (kind === "owner")
        property(props[key]).relation = [{ id: "00000000-0000-4000-8000-000000009999" }]
      else property(props[key]).rich_text = [{ plain_text: "changed-identity" }]
    }
    f.clear()
    const result = await f.run(
      Effect.result(applySharedCreateRecovery({ plan, review, reviewId: review.review_id })),
    )
    expect(result._tag).toBe("Failure")
    expect(f.writes()).toHaveLength(0)
  },
)

test.each([false, true])(
  "a known-prefix suffix POST unknown never replays (visible=%s)",
  async (visible) => {
    const { f, plan, selection } = await originalFailure()
    const review = await f.run(reviewSharedCreateRecovery(selection))
    f.unknown("file", visible)
    const result = await f.run(
      Effect.result(applySharedCreateRecovery({ plan, review, reviewId: review.review_id })),
    )
    expect(result._tag).toBe("Failure")
    expect(f.nativeCreates()).toHaveLength(1)
    f.clear()
    expect(
      (
        await f.run(
          Effect.result(applySharedCreateRecovery({ plan, review, reviewId: review.review_id })),
        )
      )._tag,
    ).toBe("Failure")
    expect(f.writes()).toHaveLength(0)
    expect(f.currentBodies()).toHaveLength(0)
  },
)

test.each([false, true])(
  "an original reference Projection PATCH unknown never replays (visible=%s)",
  async (visible) => {
    const { f, plan, selection } = await originalFailure()
    const review = await f.run(reviewSharedCreateRecovery(selection)),
      counter = review.bindings[2]!
    let attempts = 0
    const action = Effect.gen(function* () {
      const api = yield* Notion
      return yield* applySharedCreateRecovery({ plan, review, reviewId: review.review_id }).pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) =>
            path === "v1/pages/" + counter.page_id && options?.method === "PATCH"
              ? Effect.gen(function* () {
                  attempts++
                  if (visible) yield* api.request(path, body, options)
                  return yield* Effect.fail(
                    fail("WRITE_OUTCOME_UNKNOWN", "Lost exact original reference metadata ACK"),
                  )
                })
              : api.request(path, body, options),
        }),
      )
    })
    expect((await f.run(Effect.result(action)))._tag).toBe("Failure")
    expect(attempts).toBe(1)
    expect(f.nativeCreates()).toHaveLength(32)
    f.clear()
    expect(
      (
        await f.run(
          Effect.result(applySharedCreateRecovery({ plan, review, reviewId: review.review_id })),
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
  if (!raw) throw new Error("Missing fixture Record " + id)
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
  return hash
}
function rewriteDecision(
  f: FailureFixture["f"],
  operation: string,
  rewrite: (review: Record<string, unknown>) => void,
) {
  let newId = ""
  const reviewHash = rewriteRecord(
    f,
    sharedCreateRecoveryReviewId(operation),
    (payload, envelope) => {
      rewrite(payload)
      const { review_id: _prior, ...fields } = payload
      newId = "create-recovery-" + digest(fields)
      payload.review_id = newId
      envelope.operation_id = newId
    },
  )
  rewriteRecord(f, sharedCreateRecoveryOutcomeId(operation), (payload, envelope) => {
    payload.recovery_id = newId
    payload.review_record_hash = reviewHash
    envelope.operation_id = newId
    const review = property(record(f, sharedCreateRecoveryReviewId(operation)).envelope.payload)
    payload.original_outcome_sha256 = review.original_outcome_sha256
  })
}

test("cold completion rejects missing or coherently changed original facts without current-body reads or a local journal", async () => {
  const { f, plan, selection, target } = await originalFailure()
  const review = await f.run(reviewSharedCreateRecovery(selection))
  await f.run(applySharedCreateRecovery({ plan, review, reviewId: review.review_id }))
  const events = (
    await f.run(querySharedRecords(library, { skillPageId: target, kind: "file_event" }))
  ).map((row) => Schema.decodeUnknownSync(FileEventSchema)(row.payload))
  const saved = structuredClone([...f.base.records])
  f.credential("independent-cold-negative-reader")
  f.base.json.clear()
  f.base.objects.clear()
  const variants = [
    "missing-original-outcome",
    "original-outcome-hash",
    "original-outcome-reason",
    "original-outcome-bindings",
    "missing-event",
    "changed-existing-page",
    "changed-existing-path",
    "changed-input-sha",
    "changed-mode",
    "changed-frontmatter",
    "changed-source-revision",
  ] as const
  for (const kind of variants) {
    f.base.records.clear()
    for (const [key, value] of structuredClone(saved)) f.base.records.set(key, value)
    f.base.json.clear()
    f.base.objects.clear()
    f.clear()
    if (kind === "missing-original-outcome")
      f.base.records.delete(String(record(f, sharedCreateOutcomeId(plan.operation_id)).raw.id))
    if (kind === "original-outcome-hash")
      property(
        record(f, sharedCreateOutcomeId(plan.operation_id)).fields[
          library.records.property_ids.Hash!
        ],
      ).rich_text = [{ plain_text: "0".repeat(64) }]
    if (kind === "original-outcome-reason" || kind === "original-outcome-bindings") {
      const hash = rewriteRecord(f, sharedCreateOutcomeId(plan.operation_id), (payload) => {
        if (kind === "original-outcome-reason") payload.reason_code = "ANOTHER_FAILURE"
        else if (Array.isArray(payload.bindings))
          property(payload.bindings[1]).path = "another/path.md"
      })
      rewriteDecision(f, plan.operation_id, (payload) => {
        payload.original_outcome_sha256 = hash
      })
    }
    if (kind === "changed-existing-page" || kind === "changed-existing-path")
      rewriteRecord(f, sharedCreateRecoveryOutcomeId(plan.operation_id), (payload) => {
        if (!Array.isArray(payload.bindings)) throw new Error("Missing final bindings")
        property(payload.bindings[1])[kind === "changed-existing-page" ? "page_id" : "path"] =
          kind === "changed-existing-page"
            ? "00000000-0000-4000-8000-000000009999"
            : "changed/path.md"
      })
    if (
      kind === "changed-input-sha" ||
      kind === "changed-mode" ||
      kind === "changed-frontmatter" ||
      kind === "changed-source-revision"
    )
      rewriteDecision(f, plan.operation_id, (payload) => {
        if (!Array.isArray(payload.files)) throw new Error("Missing full recovery file manifest")
        const file = property(payload.files[0]),
          event = property(file.event),
          content = property(file.content)
        if (kind === "changed-input-sha") file.input_sha256 = "f".repeat(64)
        if (kind === "changed-mode") {
          event.mode = "100755"
          content.mode = "100755"
        }
        if (kind === "changed-frontmatter") {
          event.frontmatter = "---\nlicense: changed\n---\n"
          content.frontmatter = event.frontmatter
        }
        if (kind === "changed-source-revision") event.source_revision = "c".repeat(40)
        const { event_id: _prior, ...fields } = event
        event.event_id =
          "recovery-file-" +
          digest({
            version: 3,
            original_operation_id: plan.operation_id,
            projection_version: 10,
            event: fields,
          })
      })
    const selected = kind === "missing-event" ? events.slice(1) : events
    const result = await f.run(
      Effect.result(loadPendingSharedCreates(library, { skillPageId: target, events: selected })),
    )
    expect(result._tag, kind).toBe("Failure")
    expect(f.currentBodies(), kind).toHaveLength(0)
    expect(f.writes(), kind).toHaveLength(0)
    expect(f.base.json.size, kind).toBe(0)
  }
}, 60_000)

test("a sole-main completion cannot acquire a fabricated original terminal", async () => {
  const { f, plan, selection, target } = await originalFailure(true, true)
  const review = await f.run(reviewSharedCreateRecovery(selection))
  await f.run(applySharedCreateRecovery({ plan, review, reviewId: review.review_id }))
  const source = record(f, sharedCreateRecoveryOutcomeId(plan.operation_id))
  const extra = structuredClone(source.raw),
    page = "00000000-0000-4000-8000-000000009999",
    fields = property(extra.properties)
  extra.id = page
  property(fields[library.records.property_ids["Record ID"]!]).rich_text = [
    { plain_text: sharedCreateOutcomeId(plan.operation_id) },
  ]
  property(fields[library.records.property_ids["Entity ID"]!]).rich_text = [
    { plain_text: "skill-create-outcomes-v1" },
  ]
  f.base.records.set(page, extra)
  rewriteRecord(f, sharedCreateOutcomeId(plan.operation_id), (payload, envelope) => {
    for (const key of Object.keys(payload)) delete payload[key]
    Object.assign(payload, {
      version: 1,
      kind: "skill_create_outcome",
      operation_id: plan.operation_id,
      skill_id: plan.skill_id,
      skill_page_id: target,
      status: "needs_review",
      reason_code: "SHARED_CREATE_BODY_MISMATCH",
      bindings: review.bindings,
    })
    envelope.operation_id = plan.operation_id
  })
  const events = (
    await f.run(querySharedRecords(library, { skillPageId: target, kind: "file_event" }))
  ).map((row) => Schema.decodeUnknownSync(FileEventSchema)(row.payload))
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  f.credential("independent-sole-main-reader")
  expect(
    (await f.run(Effect.result(loadPendingSharedCreates(library, { skillPageId: target, events }))))
      ._tag,
  ).toBe("Failure")
  expect(f.currentBodies()).toHaveLength(0)
  expect(f.writes()).toHaveLength(0)
})

test.each([
  "owner",
  "file-id",
  "path",
  "projection-value",
  "extra-property",
  "markdown-key",
  "missing-allowlist",
] as const)(
  "reference metadata dispatcher rejects %s outside the exact reviewed allowance",
  async (kind) => {
    const { f, plan, selection, target } = await originalFailure()
    const review = await f.run(reviewSharedCreateRecovery(selection)),
      reference = review.bindings[2]!
    if (review.version !== 3) throw new Error("Expected the immutable v9 to v10 review")
    const next = review.files.find((file) => file.file_id === reference.file_id)!
    if (next.event.kind !== "projected") throw new Error("Expected projected recovery")
    const projection = canonicalSharedJson({
      ...next.event.projection,
      source_revision: next.event.source_revision,
    })
    const ids = library.files.property_ids,
      requested: Record<string, unknown> = {
        properties: {
          [ids.Projection!]: { rich_text: [{ type: "text", text: { content: projection } }] },
        },
      }
    if (kind === "owner" || kind === "file-id" || kind === "path") {
      const props = property(f.files.get(reference.page_id)!.properties)
      if (kind === "owner")
        property(props[ids.Skill!]).relation = [{ id: "00000000-0000-4000-8000-000000009999" }]
      else
        property(props[ids[kind === "file-id" ? "File ID" : "Path"]!]).rich_text = [
          { plain_text: "changed" },
        ]
    }
    if (kind === "projection-value")
      property(requested.properties)[ids.Projection!] = {
        rich_text: [{ type: "text", text: { content: "different projection" } }],
      }
    if (kind === "extra-property") property(requested.properties)[ids.Path!] = { rich_text: [] }
    if (kind === "markdown-key") requested.markdown = counterActual
    f.clear()
    const action = Effect.gen(function* () {
      const dispatch = yield* sharedCreateDispatch(library, {
        operation_id: review.review_id,
        skill_id: plan.skill_id,
        ...(kind === "missing-allowlist"
          ? {}
          : {
              recovery_file_projections: [
                {
                  page_id: reference.page_id,
                  file_id: reference.file_id,
                  path: reference.path,
                  skill_page_id: target,
                  projection,
                },
              ],
            }),
      })
      return yield* dispatch.api.request("v1/pages/" + reference.page_id, requested, {
        method: "PATCH",
      })
    })
    const result = await f.run(Effect.result(action))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.code).toBe("SHARED_CREATE_SCOPE")
    expect(f.writes()).toHaveLength(0)
  },
)

test("known recovery uses main-first allocation even when the complete file manifest sorts another path first", async () => {
  const { f, plan, selection } = await originalFailure(false, false, true)
  expect(plan.files[0]?.path).toBe("A.md")
  expect(plan.entrypoint).toBe("SKILL.md")
  const review = await f.run(reviewSharedCreateRecovery(selection))
  expect(review.files[0]?.path).toBe("A.md")
  expect(review.bindings.map((binding) => binding.path)).toEqual(["SKILL.md", "A.md"])
  const dry = await f.run(
    applySharedCreateRecovery({ plan, review, reviewId: review.review_id, dryRun: true }),
  )
  expect(property(dry).existing_pages).toBe(2)
  expect(property(dry).remaining_pages).toBe(33)
  expect(f.writes()).toHaveLength(0)
})
