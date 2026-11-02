import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { property, text } from "../src/model.ts"
import {
  SharedCreateRecoveryTerminalSchema,
  sharedCreateContinuationReviewId,
  sharedCreateRecoveryTerminalId,
} from "../src/shared-create-continuation-model.ts"
import {
  SharedCreateRecoveryOutcomeSchema,
  sharedCreateRecoveryOutcomeId,
} from "../src/shared-create-recovery-completion.ts"
import {
  applySharedCreateContinuation,
  applySharedCreateRecovery,
  reconcileSharedCreateRecovery,
  reviewSharedCreateContinuation,
  reviewSharedCreateRecovery,
} from "../src/shared-create-recovery.ts"
import {
  executeSharedCreate,
  loadPendingSharedCreates,
  prepareSharedMigrationCreate,
  reconcileSharedCreate,
} from "../src/shared-create.ts"
import { FileEventSchema } from "../src/shared-file-state.ts"
import { makeSharedMigrationConversion } from "../src/shared-migration-conversion.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import { querySharedSkillIndex } from "../src/shared-skill-index.ts"
import { createLibrary, sharedCreateFixture } from "./shared-create-fixture.ts"
import { migrationConversionFixture, migrationHash } from "./shared-migration-conversion-fixture.ts"
import { id, rich } from "./shared-snapshot-fixture.ts"

type Fixture = ReturnType<typeof sharedCreateFixture>
const authoredNotes = "Introduction\n- Retained item"
const observedNotes = "Introduction\n\n- Retained item"

function recordId(row: Record<string, unknown>) {
  return text(property(property(row.properties).record).rich_text)
}

function record(fixture: Fixture, selected: string) {
  const matches = [...fixture.base.records.entries()].filter(
    ([, row]) => recordId(row) === selected,
  )
  if (matches.length !== 1 || matches[0] === undefined)
    throw new Error(`Expected one retained shared record: ${selected}`)
  return { key: matches[0][0], row: matches[0][1] }
}

function payload(fixture: Fixture, selected: string) {
  const raw: unknown = JSON.parse(
    text(property(property(record(fixture, selected).row.properties).payload).rich_text),
  )
  return property(raw).payload
}

/** Rehash the outer envelope too, so tamper cases reach semantic binding checks. */
function rewriteRecord(
  fixture: Fixture,
  selected: string,
  change: (envelope: Record<string, unknown>, body: Record<string, unknown>) => void,
) {
  const row = record(fixture, selected).row
  const raw: unknown = JSON.parse(text(property(property(row.properties).payload).rich_text))
  const envelope = property(raw)
  change(envelope, property(envelope.payload))
  const encoded = canonicalSharedJson(envelope)
  property(row.properties).payload = rich("payload", encoded)
  property(row.properties).hash = rich("hash", migrationHash(encoded))
}

function assertNoBodyWrites(fixture: Fixture) {
  expect(
    fixture.calls.filter((call) => call.method !== "GET" && call.path.includes("/markdown")),
  ).toHaveLength(0)
  expect(
    fixture.calls.filter(
      (call) =>
        call.method === "PATCH" &&
        (Object.hasOwn(property(call.body), "markdown") ||
          Object.hasOwn(property(call.body), "content")),
    ),
  ).toHaveLength(0)
}

/** Real controlled dispatch: two original pages, then one successful recovery
 * POST, one unknown POST, and two later files that were never attempted. */
async function stoppedRecovery(visible = true) {
  const retained = migrationConversionFixture({
    main: "Fixed source main",
    notes: authoredNotes,
    following: true,
    extraFiles: [
      { path: "references/01.md", body: "First recovery file" },
      { path: "references/02.md", body: "Unknown recovery file" },
      { path: "references/03.md", body: "First unattempted file" },
      { path: "references/04.md", body: "Second unattempted file" },
    ],
  })
  const providerRequests: string[] = []
  const provider = HttpClient.make((request, url) =>
    Effect.sync(() => {
      providerRequests.push(url.href)
      const prefix =
        "https://raw.githubusercontent.com/example/skills/" + "1".repeat(40) + "/skills/example/"
      const selected = retained.input.source_files?.find((file) => url.href === prefix + file.path)
      if (!selected) throw new Error("Unexpected provider request: " + url.href)
      return HttpClientResponse.fromWeb(request, new Response(new Uint8Array(selected.bytes)))
    }),
  )
  const fixture = sharedCreateFixture({
    recovery: true,
    httpClient: provider,
    readback: (wire) => (wire === authoredNotes ? observedNotes : wire),
  })
  const candidate = await fixture.run(
    makeSharedMigrationConversion({ ...retained.input, projection_version: 4 }),
  )
  const plan = await fixture.run(
    prepareSharedMigrationCreate(createLibrary, {
      candidate,
      migrationInput: retained.migrationInput,
    }),
  )
  if (plan.version !== 2) throw new Error("Expected the retained migration-origin create plan")
  const originalFailure = await fixture.run(
    Effect.flip(
      executeSharedCreate(createLibrary, {
        plan,
        mode: "create",
        migrationInput: retained.migrationInput,
      }),
    ),
  )
  expect(originalFailure.code).toBe("SHARED_CREATE_BODY_MISMATCH")
  const target = property(originalFailure.details).skill_page_id
  if (typeof target !== "string") throw new Error("Missing actual original page receipt")
  const selection = {
    entry: createLibrary.skills.database_id,
    operationId: plan.operation_id,
    target,
  }
  const originalRows = structuredClone([...fixture.base.records])
  const recovery = await fixture.run(reviewSharedCreateRecovery(selection))
  expect(recovery.bindings).toHaveLength(2)
  expect(recovery.files).toHaveLength(6)
  let recoveredCreates = 0
  fixture.onCreate((_page, kind) => {
    if (kind === "file" && ++recoveredCreates === 1) fixture.unknown("file", visible)
  })
  fixture.clear()
  const failure = await fixture.run(
    Effect.flip(
      applySharedCreateRecovery({
        review: recovery,
        reviewId: recovery.review_id,
        migrationInput: retained.migrationInput,
      }),
    ),
  )
  expect(failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
  expect(fixture.nativeCreates()).toHaveLength(2)
  const terminal = Schema.decodeUnknownSync(SharedCreateRecoveryTerminalSchema)(
    payload(fixture, sharedCreateRecoveryTerminalId(recovery.review_id)),
  )
  expect(terminal.evidence_kind).toBe("native_dispatch_stopped")
  expect(terminal.bindings).toHaveLength(3)
  expect(terminal.unattempted_file_ids).toHaveLength(2)
  expect(property(JSON.parse(terminal.error_json)).code).toBe("WRITE_OUTCOME_UNKNOWN")
  expect(terminal.error_sha256).toBe(migrationHash(terminal.error_json))
  expect(property(failure.details).stage).toBe(`create_file:${terminal.failed_file_id}`)
  fixture.onCreate(() => undefined)
  fixture.clear()
  return {
    fixture,
    retained,
    plan,
    target,
    selection,
    recovery,
    terminal,
    originalRows,
    providerRequests,
  }
}

async function completedContinuation() {
  const stopped = await stoppedRecovery()
  const continuation = await stopped.fixture.run(reviewSharedCreateContinuation(stopped.selection))
  const result = await stopped.fixture.run(
    applySharedCreateContinuation({
      review: continuation,
      reviewId: continuation.continuation_id,
      migrationInput: stopped.retained.migrationInput,
    }),
  )
  expect(result.status).toBe("recovered")
  return { ...stopped, continuation, result }
}

async function coldGate(fixture: Fixture, target: string, credential: string) {
  fixture.credential(credential)
  fixture.base.json.clear()
  fixture.base.objects.clear()
  fixture.clear()
  const events = await fixture.run(
    querySharedRecords(createLibrary, { skillPageId: target, kind: "file_event" }),
  )
  return fixture.run(
    loadPendingSharedCreates(createLibrary, {
      skillPageId: target,
      events: events.map((row) => Schema.decodeUnknownSync(FileEventSchema)(row.payload)),
    }),
  )
}

test("visible unknown allocation continues only unattempted files and publishes independently checked completion v2", async () => {
  const {
    fixture: f,
    retained,
    plan,
    target,
    selection,
    recovery,
    terminal,
    originalRows,
    providerRequests,
  } = await stoppedRecovery()
  const terminalBefore = structuredClone(
    record(f, sharedCreateRecoveryTerminalId(recovery.review_id)).row,
  )
  const continuation = await f.run(reviewSharedCreateContinuation(selection))
  expect(continuation.observation_kind).toBe("post_failure_current_read")
  expect(continuation.original_write_outcome).toBe("unknown")
  expect(continuation.bindings).toHaveLength(4)
  expect(continuation.remaining_file_ids).toEqual(terminal.unattempted_file_ids)
  expect(continuation.successful_response_records).toHaveLength(1)
  expect(continuation.successful_response_records[0]?.file_id).not.toBe(terminal.failed_file_id)
  const unknownReceiptId = `create-recovery-receipt-${migrationHash(
    canonicalSharedJson([recovery.review_id, `create:${terminal.failed_file_id}`]),
  )}`
  expect([...f.base.records.values()].some((row) => recordId(row) === unknownReceiptId)).toBe(false)
  expect(f.writes()).toHaveLength(0)
  const existingBodies = continuation.bindings.map((binding) => ({
    page: binding.page_id,
    body: f.base.bodies.get(binding.page_id),
  }))
  const dry = await f.run(
    applySharedCreateContinuation({
      review: continuation,
      reviewId: continuation.continuation_id,
      migrationInput: retained.migrationInput,
      dryRun: true,
    }),
  )
  expect(dry.status).toBe("planned")
  expect(property(dry).existing_pages).toBe(4)
  expect(property(dry).remaining_pages).toBe(2)
  expect(f.writes()).toHaveLength(0)
  f.clear()
  const result = await f.run(
    applySharedCreateContinuation({
      review: continuation,
      reviewId: continuation.continuation_id,
      migrationInput: retained.migrationInput,
    }),
  )
  expect(result.status).toBe("recovered")
  expect(result.original_status).toBe("needs_review")
  expect(property(result).verified).toBe(true)
  expect(property(result).original_write_outcome).toBe("unknown")
  expect(property(result).existing_pages_preserved).toBe(4)
  expect(property(result).created_pages).toBe(2)
  expect(
    f
      .nativeCreates()
      .map((call) => text(property(property(property(call.body).properties).file_id).rich_text)),
  ).toEqual([...terminal.unattempted_file_ids])
  assertNoBodyWrites(f)
  for (const existing of existingBodies)
    expect(f.base.bodies.get(existing.page)).toBe(existing.body)
  for (const [key, row] of originalRows) expect(f.base.records.get(key)).toEqual(row)
  expect(record(f, sharedCreateRecoveryTerminalId(recovery.review_id)).row).toEqual(terminalBefore)
  const index = await f.run(querySharedSkillIndex(createLibrary, target))
  expect(index.enabled).toBe(true)
  expect(index.main.page_id).toBe(target)
  expect(index.files).toHaveLength(5)
  const sourceId = plan.origin.candidate.source?.source_id
  if (sourceId === undefined) throw new Error("Missing fixed Source in the controlled migration")
  expect(index.source_reference).toBe(sourceId)
  expect(
    [...f.base.json.keys()].filter((key) =>
      /^operations\/shared-native-(?:create|recovery|continuation)\//u.test(key),
    ),
  ).toEqual([])
  const completion = Schema.decodeUnknownSync(SharedCreateRecoveryOutcomeSchema)(
    payload(f, sharedCreateRecoveryOutcomeId(plan.operation_id)),
  )
  expect(completion.version).toBe(2)
  if (completion.version !== 2) throw new Error("Missing actual continuation v2 outcome")
  expect(completion.continuation_id).toBe(continuation.continuation_id)
  expect(completion.bindings).toHaveLength(6)
  expect(completion.original_operation_id).toBe(plan.operation_id)
  expect(completion.recovery_id).toBe(recovery.review_id)
  const continuationRow = record(f, sharedCreateContinuationReviewId(plan.operation_id)).row
  expect(completion.continuation_review_record_hash).toBe(
    text(property(property(continuationRow.properties).hash).rich_text),
  )
  const originIds = plan.origin.archive.chunks.map((chunk) => chunk.object_id)
  expect(originIds.length).toBeGreaterThan(0)
  providerRequests.length = 0
  expect(await coldGate(f, target, "independent-continuation-reader")).toEqual([])
  expect(f.currentBodies()).toHaveLength(0)
  expect(f.writes()).toHaveLength(0)
  expect(providerRequests).toEqual([])
  expect(
    f.calls.some((call) =>
      originIds.some((origin) => canonicalSharedJson(call.body ?? null).includes(origin)),
    ),
  ).toBe(false)
  const reconciled = await f.run(reconcileSharedCreateRecovery(selection))
  expect(reconciled.verification).toBe("reviewed_continuation_outcome")
  expect(reconciled.current_snapshot_verified).toBe(false)
  expect(property(reconciled).original_write_outcome).toBe("unknown")
  expect(f.currentBodies()).toHaveLength(0)
  expect(f.writes()).toHaveLength(0)
  const repeated = await f.run(
    applySharedCreateContinuation({
      review: continuation,
      reviewId: continuation.continuation_id,
      migrationInput: retained.migrationInput,
    }),
  )
  expect(repeated.status).toBe("recovered")
  expect(f.currentBodies()).toHaveLength(0)
  expect(f.writes()).toHaveLength(0)
  const original = await f.run(Effect.flip(reconcileSharedCreate(createLibrary, plan)))
  expect(original.code).toBe("SHARED_CREATE_REVIEW_REQUIRED")
  expect(f.writes()).toHaveLength(0)
})

test("invisible unknown allocation blocks continuation without replaying its POST or later files", async () => {
  const { fixture: f, selection } = await stoppedRecovery(false)
  const error = await f.run(Effect.flip(reviewSharedCreateContinuation(selection)))
  expect(error.code).toBe("SHARED_CREATE_RECOVERY_REQUIRED")
  expect(f.writes()).toHaveLength(0)
})

for (const drift of ["body", "extra-page"]) {
  test(`changed current allocation (${drift}) rejects reviewed continuation before writes`, async () => {
    const { fixture: f, retained, selection, terminal } = await stoppedRecovery()
    const review = await f.run(reviewSharedCreateContinuation(selection))
    const observed = review.bindings.find((binding) => binding.file_id === terminal.failed_file_id)
    if (!observed) throw new Error("Missing accepted current allocation")
    if (drift === "body") f.base.bodies.set(observed.page_id, "A later user edit")
    else {
      const existing = f.files.get(observed.page_id)
      if (!existing) throw new Error("Missing real controlled file page")
      const unexpected = structuredClone(existing)
      unexpected.id = id(90_000)
      property(unexpected.properties).file_id = rich("file_id", "unexpected-file")
      property(unexpected.properties).path = rich("path", "unexpected.md")
      f.files.set(id(90_000), unexpected)
      f.base.bodies.set(id(90_000), "Unreviewed content")
    }
    f.clear()
    const error = await f.run(
      Effect.flip(
        applySharedCreateContinuation({
          review,
          reviewId: review.continuation_id,
          migrationInput: retained.migrationInput,
        }),
      ),
    )
    expect(error.code).toMatch(/SHARED_CREATE/)
    expect(f.writes()).toHaveLength(0)
    if (drift === "body") expect(f.base.bodies.get(observed.page_id)).toBe("A later user edit")
  })
}

for (const approval of ["missing", "unapproved"]) {
  test(`${approval} original input cannot inherit approval from a continuation review`, async () => {
    const { fixture: f, retained, selection } = await stoppedRecovery()
    const review = await f.run(reviewSharedCreateContinuation(selection))
    f.clear()
    const error = await f.run(
      Effect.flip(
        applySharedCreateContinuation({
          review,
          reviewId: review.continuation_id,
          migrationInput:
            approval === "missing"
              ? undefined
              : { ...retained.migrationInput, approved_legacy_ids: [] },
        }),
      ),
    )
    if (approval === "unapproved") expect(error.code).toBe("SHARED_MIGRATION_CREATE_NOT_APPROVED")
    expect(f.writes()).toHaveLength(0)
  })
}

for (const when of ["before-review", "after-review"]) {
  test(`missing contemporaneous terminal ${when} cannot be replaced by visible pages or local errors`, async () => {
    const { fixture: f, retained, selection, recovery } = await stoppedRecovery()
    const review =
      when === "after-review" ? await f.run(reviewSharedCreateContinuation(selection)) : undefined
    const terminal = record(f, sharedCreateRecoveryTerminalId(recovery.review_id))
    f.base.records.delete(terminal.key)
    f.clear()
    const error =
      review === undefined
        ? await f.run(Effect.flip(reviewSharedCreateContinuation(selection)))
        : await f.run(
            Effect.flip(
              applySharedCreateContinuation({
                review,
                reviewId: review.continuation_id,
                migrationInput: retained.migrationInput,
              }),
            ),
          )
    expect(error.code).toBe("SHARED_CREATE_CONTINUATION_EVIDENCE_REQUIRED")
    expect(f.writes()).toHaveLength(0)
    expect(f.currentBodies()).toHaveLength(0)
  })
}

test("a continuation unknown stops the serial loop and cannot authorize another continuation or replay", async () => {
  const { fixture: f, retained, selection, recovery } = await stoppedRecovery()
  const review = await f.run(reviewSharedCreateContinuation(selection))
  f.unknown("file", true)
  f.clear()
  const first = await f.run(
    Effect.flip(
      applySharedCreateContinuation({
        review,
        reviewId: review.continuation_id,
        migrationInput: retained.migrationInput,
      }),
    ),
  )
  expect(first.code).toBe("WRITE_OUTCOME_UNKNOWN")
  expect(f.nativeCreates()).toHaveLength(1)
  const stopped = Schema.decodeUnknownSync(SharedCreateRecoveryTerminalSchema)(
    payload(f, sharedCreateRecoveryTerminalId(review.continuation_id)),
  )
  expect(stopped.attempt_id).toBe(review.continuation_id)
  expect(stopped.recovery_id).toBe(recovery.review_id)
  const firstRemaining = review.remaining_file_ids[0]
  if (firstRemaining === undefined) throw new Error("Missing unattempted continuation file")
  expect(stopped.failed_file_id).toBe(firstRemaining)
  expect(stopped.unattempted_file_ids).toEqual(review.remaining_file_ids.slice(1))
  f.clear()
  const second = await f.run(
    Effect.flip(
      applySharedCreateContinuation({
        review,
        reviewId: review.continuation_id,
        migrationInput: retained.migrationInput,
      }),
    ),
  )
  expect(second.code).toBe("SHARED_CREATE_RECOVERY_REQUIRED")
  expect(f.writes()).toHaveLength(0)
  expect(f.currentBodies()).toHaveLength(0)
  await expect(f.run(reviewSharedCreateContinuation(selection))).rejects.toThrow()
  expect(f.writes()).toHaveLength(0)
})

for (const tamper of ["continuation", "terminal", "hash", "downgrade-v1"]) {
  test(`independent cold gate rejects ${tamper} in the completion v2 proof`, async () => {
    const { fixture: f, plan, target, recovery } = await completedContinuation()
    if (tamper === "continuation") {
      rewriteRecord(f, sharedCreateContinuationReviewId(plan.operation_id), (_envelope, body) => {
        body.decision = "assume_original_post_succeeded"
      })
    } else if (tamper === "terminal") {
      rewriteRecord(f, sharedCreateRecoveryTerminalId(recovery.review_id), (_envelope, body) => {
        body.error_sha256 = "0".repeat(64)
      })
    } else if (tamper === "hash") {
      rewriteRecord(f, sharedCreateRecoveryOutcomeId(plan.operation_id), (_envelope, body) => {
        body.continuation_review_record_hash = "0".repeat(64)
      })
    } else {
      rewriteRecord(f, sharedCreateRecoveryOutcomeId(plan.operation_id), (envelope, body) => {
        body.version = 1
        delete body.continuation_id
        delete body.continuation_review_record_hash
        envelope.operation_id = recovery.review_id
      })
    }
    await expect(coldGate(f, target, `independent-tamper-reader-${tamper}`)).rejects.toThrow()
    expect(f.currentBodies()).toHaveLength(0)
    expect(f.writes()).toHaveLength(0)
  })
}
