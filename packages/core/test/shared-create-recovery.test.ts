import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { property, text } from "../src/model.ts"
import {
  applySharedCreateRecovery,
  reconcileSharedCreateRecovery,
  reviewSharedCreateRecovery,
  reviewSharedCreateContinuation,
} from "../src/shared-create-recovery.ts"
import { makeSharedCreateRecoveryFiles } from "../src/shared-create-recovery-model.ts"
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

const authored = "Introduction\n- Retained item"
const observed = "Introduction\n\n- Retained item"

async function partial() {
  const retained = migrationConversionFixture({ main: authored, following: true })
  const provider = HttpClient.make((request, url) =>
    Effect.sync(() => {
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
    readback: (wire) => (wire === authored ? observed : wire),
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
  const failure = await fixture.run(
    Effect.flip(
      executeSharedCreate(createLibrary, {
        plan,
        mode: "create",
        migrationInput: retained.migrationInput,
      }),
    ),
  )
  expect(failure.code).toBe("SHARED_CREATE_BODY_MISMATCH")
  const target = property(failure.details).skill_page_id
  if (typeof target !== "string") throw new Error("Missing actual partial-create page receipt")
  const selection = {
    entry: createLibrary.skills.database_id,
    operationId: plan.operation_id,
    target,
  }
  fixture.clear()
  return { fixture, retained, plan, target, selection }
}

test("review and dry-run retain the exact later observation and perform no writes", async () => {
  const { fixture: f, retained, plan, target, selection } = await partial()
  const localBefore = structuredClone([...f.base.json])
  const review = await f.run(reviewSharedCreateRecovery(selection))
  expect(review.original_operation_id).toBe(plan.operation_id)
  expect(review.observation_kind).toBe("post_failure_current_read")
  expect(review.bindings).toHaveLength(1)
  expect(review.bindings[0]?.page_id).toBe(target)
  expect(JSON.parse(review.observations[0]!.response_json).markdown).toBe(observed)
  expect(review.files.every((file) => file.projection.version === 5)).toBe(true)
  expect(f.writes()).toHaveLength(0)
  const dry = await f.run(
    applySharedCreateRecovery({
      review,
      reviewId: review.review_id,
      migrationInput: retained.migrationInput,
      dryRun: true,
    }),
  )
  expect(dry.status).toBe("planned")
  expect(property(dry).remaining_pages).toBe(1)
  expect(f.writes()).toHaveLength(0)
  expect([...f.base.json]).toEqual(localBefore)
})

test("recovery preserves the existing page and original failure, then enables a complete independently consumable tree", async () => {
  const { fixture: f, retained, plan, target, selection } = await partial()
  const originalRows = structuredClone([...f.base.records])
  const review = await f.run(reviewSharedCreateRecovery(selection))
  f.clear()
  const result = await f.run(
    applySharedCreateRecovery({
      review,
      reviewId: review.review_id,
      migrationInput: retained.migrationInput,
    }),
  )
  expect(result.status).toBe("recovered")
  expect(result.original_status).toBe("needs_review")
  expect(property(result).verified).toBe(true)
  expect(property(result).skill_page_id).toBe(target)
  expect(f.nativeCreates()).toHaveLength(1)
  expect(
    f.calls.filter((call) => call.method === "PATCH" && call.path.includes("/markdown")),
  ).toHaveLength(0)
  expect(f.base.bodies.get(target)).toBe(observed)
  for (const [id, row] of originalRows) expect(f.base.records.get(id)).toEqual(row)
  const index = await f.run(querySharedSkillIndex(createLibrary, target))
  expect(index.enabled).toBe(true)
  expect(index.files).toHaveLength(1)
  expect(index.main.page_id).toBe(target)
  const files = await f.run(makeSharedCreateRecoveryFiles(plan))
  expect(index.main.baseline?.sha256).toBe(
    files.find((file) => file.path === "SKILL.md")!.content.sha256,
  )
  expect(f.pending()).toHaveLength(0)
  const events = await f.run(
    querySharedRecords(createLibrary, { skillPageId: target, kind: "file_event" }),
  )
  f.credential("independent-recovery-reader")
  f.clear()
  expect(
    await f.run(
      loadPendingSharedCreates(createLibrary, {
        skillPageId: target,
        events: events.map((row) => Schema.decodeUnknownSync(FileEventSchema)(row.payload)),
      }),
    ),
  ).toEqual([])
  expect(f.currentBodies()).toHaveLength(0)
  expect(f.writes()).toHaveLength(0)
  const recovered = await f.run(reconcileSharedCreateRecovery(selection))
  expect(recovered.verification).toBe("original_recovery_outcome")
  expect(recovered.current_snapshot_verified).toBe(false)
  expect(f.currentBodies()).toHaveLength(0)
  expect(f.writes()).toHaveLength(0)
  const original = await f.run(Effect.flip(reconcileSharedCreate(createLibrary, plan)))
  expect(original.code).toBe("SHARED_CREATE_REVIEW_REQUIRED")
  expect(f.writes()).toHaveLength(0)
})

test("changed current body after review fails before a recovery journal or write", async () => {
  const { fixture: f, retained, target, selection } = await partial()
  const review = await f.run(reviewSharedCreateRecovery(selection))
  const before = structuredClone([...f.base.json])
  f.base.bodies.set(target, observed + "\nUser edit")
  f.clear()
  const error = await f.run(
    Effect.flip(
      applySharedCreateRecovery({
        review,
        reviewId: review.review_id,
        migrationInput: retained.migrationInput,
      }),
    ),
  )
  expect(error.code).toBe("SHARED_CREATE_RECOVERY_REQUIRED")
  expect(f.writes()).toHaveLength(0)
  expect([...f.base.json]).toEqual(before)
})

test("the original approved input is still required for recovery writes", async () => {
  const { fixture: f, retained, selection } = await partial()
  const review = await f.run(reviewSharedCreateRecovery(selection))
  f.clear()
  const error = await f.run(
    Effect.flip(
      applySharedCreateRecovery({
        review,
        reviewId: review.review_id,
        migrationInput: { ...retained.migrationInput, approved_legacy_ids: [] },
      }),
    ),
  )
  expect(error.code).toBe("SHARED_MIGRATION_CREATE_NOT_APPROVED")
  expect(f.writes()).toHaveLength(0)
})

test("review cannot carry an arbitrary changed name or body across its independent digest", async () => {
  const { fixture: f, retained, selection } = await partial()
  const review = await f.run(reviewSharedCreateRecovery(selection))
  const changed = { ...review, skill_id: "another-skill" }
  f.clear()
  const error = await f.run(
    Effect.flip(
      applySharedCreateRecovery({
        review: changed,
        reviewId: review.review_id,
        migrationInput: retained.migrationInput,
      }),
    ),
  )
  expect(error.code).toMatch(/RECOVERY/)
  expect(f.writes()).toHaveLength(0)
})

test("a lost successful-response publication cannot be mislabeled as an unknown page POST terminal", async () => {
  const { fixture: f, retained, selection } = await partial()
  const review = await f.run(reviewSharedCreateRecovery(selection))
  f.unknown("recovery_receipt", false)
  const error = await f.run(
    Effect.flip(
      applySharedCreateRecovery({
        review,
        reviewId: review.review_id,
        migrationInput: retained.migrationInput,
      }),
    ),
  )
  expect(error.code).toBe("WRITE_OUTCOME_UNKNOWN")
  expect(f.nativeCreates()).toHaveLength(1)
  f.clear()
  const continuation = await f.run(Effect.flip(reviewSharedCreateContinuation(selection)))
  expect(continuation.code).toBe("SHARED_CREATE_CONTINUATION_EVIDENCE_REQUIRED")
  expect(f.writes()).toHaveLength(0)
  expect(f.currentBodies()).toHaveLength(0)
})

for (const visible of [false, true]) {
  test(`an unknown remaining-page create is never replayed (visible=${visible})`, async () => {
    const { fixture: f, retained, selection } = await partial()
    const review = await f.run(reviewSharedCreateRecovery(selection))
    f.unknown("file", visible)
    const first = await f.run(
      Effect.flip(
        applySharedCreateRecovery({
          review,
          reviewId: review.review_id,
          migrationInput: retained.migrationInput,
        }),
      ),
    )
    expect(first.code).toBe("WRITE_OUTCOME_UNKNOWN")
    f.clear()
    const second = await f.run(
      Effect.flip(
        applySharedCreateRecovery({
          review,
          reviewId: review.review_id,
          migrationInput: retained.migrationInput,
        }),
      ),
    )
    expect(second.code).toBe("SHARED_CREATE_RECOVERY_REQUIRED")
    expect(f.writes()).toHaveLength(0)
    expect(f.currentBodies()).toHaveLength(0)
  })

  test(`a lost recovery completion reconciles only its exact visible receipt (visible=${visible})`, async () => {
    const { fixture: f, retained, selection } = await partial()
    const review = await f.run(reviewSharedCreateRecovery(selection))
    f.unknown("recovery_outcome", visible)
    const first = await f.run(
      Effect.flip(
        applySharedCreateRecovery({
          review,
          reviewId: review.review_id,
          migrationInput: retained.migrationInput,
        }),
      ),
    )
    expect(first.code).toBe("WRITE_OUTCOME_UNKNOWN")
    f.clear()
    if (visible) {
      const result = await f.run(reconcileSharedCreateRecovery(selection))
      expect(result.status).toBe("recovered")
    } else {
      const error = await f.run(Effect.flip(reconcileSharedCreateRecovery(selection)))
      expect(error.code).toBe("SHARED_CREATE_RECOVERY_REQUIRED")
    }
    expect(f.writes()).toHaveLength(0)
    expect(f.currentBodies()).toHaveLength(0)
  })
}

test("a late edit is preserved and prevents enable without modifying the original failed operation", async () => {
  const { fixture: f, retained, target, selection } = await partial()
  const review = await f.run(reviewSharedCreateRecovery(selection))
  f.onCreate((_page, kind) => {
    if (kind === "file") f.base.bodies.set(target, "Later user content")
  })
  f.clear()
  const error = await f.run(
    Effect.flip(
      applySharedCreateRecovery({
        review,
        reviewId: review.review_id,
        migrationInput: retained.migrationInput,
      }),
    ),
  )
  expect(error.code).toBe("SHARED_CREATE_RECOVERY_REQUIRED")
  expect(f.base.bodies.get(target)).toBe("Later user content")
  expect((await f.run(querySharedSkillIndex(createLibrary, target))).enabled).toBe(false)
  expect(
    f.calls.some(
      (call) =>
        call.method === "PATCH" &&
        property(
          property(property(call.body).properties)[createLibrary.skills.property_ids.Enabled!],
        ).checkbox === true,
    ),
  ).toBe(false)
})

test("a forged recovery completion cannot release the original pending create", async () => {
  const { fixture: f, retained, target, selection } = await partial()
  const review = await f.run(reviewSharedCreateRecovery(selection))
  await f.run(
    applySharedCreateRecovery({
      review,
      reviewId: review.review_id,
      migrationInput: retained.migrationInput,
    }),
  )
  const records = [...f.base.records.values()]
  const completed = records.find((row) =>
    text(property(property(row.properties).record).rich_text).startsWith("recovered-"),
  )
  expect(completed).toBeDefined()
  if (completed === undefined) throw new Error("Missing actual recovery completion")
  const payload = property(property(completed.properties).payload)
  const envelope = JSON.parse(text(payload.rich_text))
  envelope.payload.original_outcome_sha256 = "0".repeat(64)
  payload.rich_text = [{ plain_text: canonicalSharedJson(envelope) }]
  property(property(completed.properties).hash).rich_text = [
    { plain_text: migrationHash(canonicalSharedJson(envelope)) },
  ]
  const events = await f.run(
    querySharedRecords(createLibrary, { skillPageId: target, kind: "file_event" }),
  )
  f.clear()
  await expect(
    f.run(
      loadPendingSharedCreates(createLibrary, {
        skillPageId: target,
        events: events.map((row) => Schema.decodeUnknownSync(FileEventSchema)(row.payload)),
      }),
    ),
  ).rejects.toThrow()
  expect(f.writes()).toHaveLength(0)
})
