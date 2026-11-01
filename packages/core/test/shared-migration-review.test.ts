import { expect, test } from "bun:test"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import {
  applySharedMigration,
  reconcileSharedMigration,
  reviewSharedMigration,
  validateSharedMigrationReview,
} from "../src/shared-migration-review.ts"
import { createLibrary, sharedCreateFixture } from "./shared-create-fixture.ts"
import {
  first,
  migrationConversionFixture,
  migrationHash,
} from "./shared-migration-conversion-fixture.ts"
import { reviewSharedMigrationConversion } from "../src/shared-migration-conversion.ts"
import { id } from "./shared-snapshot-fixture.ts"

function unapproved(following = false) {
  const fixture = migrationConversionFixture({ main: "Retained main", following })
  const frozen = { ...fixture.migrationInput, approved_legacy_ids: [] }
  return {
    ...fixture,
    frozen,
    input: { ...fixture.input, migration_input: frozen },
    approved: { ...frozen, approved_legacy_ids: [fixture.entry.legacy_id] },
  }
}

test("an unapproved native or following target gets a concrete review without changing approval, state or Notion", async () => {
  for (const following of [false, true]) {
    const f = sharedCreateFixture(),
      fixture = unapproved(following),
      before = structuredClone(fixture.frozen)
    const review = await f.run(reviewSharedMigration(fixture.input))
    expect(review.originally_approved_legacy_ids).toEqual([])
    expect(
      review.origin.candidate.files.find((file) => file.path === "SKILL.md")?.initial_event.kind,
    ).toBe(following ? "projected" : "adopted")
    expect(review.execution).toEqual({ read_only: true, apply_allowed: false })
    expect(await f.run(validateSharedMigrationReview(review, review.review_id))).toEqual(review)
    expect(fixture.frozen).toEqual(before)
    expect(f.writes()).toHaveLength(0)
    expect(f.pending()).toHaveLength(0)
    expect(f.currentBodies()).toHaveLength(0)
    expect(
      (
        await f.run(
          Effect.flip(
            applySharedMigration({
              migrationInput: fixture.frozen,
              review,
              reviewId: review.review_id,
              dryRun: true,
            }),
          ),
        )
      ).code,
    ).toBe("SHARED_MIGRATION_CREATE_NOT_APPROVED")
    expect(f.writes()).toHaveLength(0)
  }
})

test("approval-only changes permit a dry-run but never alter the reviewed bytes or allocate a journal", async () => {
  const f = sharedCreateFixture(),
    fixture = unapproved()
  const frozen = {
    ...fixture.frozen,
    readiness_evidence: {
      version: 1 as const,
      basis_sha256: migrationHash(canonicalSharedJson(fixture.frozen)),
      operations: [],
    },
  }
  const approved = {
    ...fixture.approved,
    readiness_evidence: {
      ...frozen.readiness_evidence,
      basis_sha256: migrationHash(canonicalSharedJson(fixture.approved)),
    },
  }
  const review = await f.run(reviewSharedMigration({ ...fixture.input, migration_input: frozen }))
  f.clear()
  const result = await f.run(
    applySharedMigration({
      migrationInput: approved,
      review,
      reviewId: review.review_id,
      dryRun: true,
    }),
  )
  if (result.status !== "planned" || result.plan.version !== 2)
    throw new Error("Expected controlled dry-run plan")
  expect(result.plan.origin.candidate.files).toEqual(review.origin.candidate.files)
  expect(result.plan.origin.member_bindings).toEqual(review.origin.member_bindings)
  expect(result.plan.origin.candidate.migration_input_sha256).not.toBe(
    review.origin.candidate.migration_input_sha256,
  )
  expect(result.verified).toBe(false)
  expect(f.writes()).toHaveLength(0)
  expect(f.currentBodies()).toHaveLength(0)
  expect(f.pending()).toHaveLength(0)
})

test("the independent review digest and all original evidence remain mandatory at apply", async () => {
  const f = sharedCreateFixture(),
    fixture = unapproved(),
    review = await f.run(reviewSharedMigration(fixture.input))
  f.clear()
  expect(
    (
      await f.run(
        Effect.flip(
          applySharedMigration({
            migrationInput: fixture.approved,
            review,
            reviewId: `migration-review-${"0".repeat(64)}`,
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_REVIEW_CHANGED")
  for (const migrationInput of [
    { ...fixture.approved, backup: { ...fixture.approved.backup, reference: "backup:changed" } },
    {
      ...fixture.approved,
      catalog: {
        ...fixture.approved.catalog,
        entries: [
          {
            ...fixture.entry,
            record: { ...property(fixture.entry.record), name: "Changed after review" },
          },
        ],
      },
    },
  ])
    expect(
      (
        await f.run(
          Effect.flip(applySharedMigration({ migrationInput, review, reviewId: review.review_id })),
        )
      ).code,
    ).toBe("SHARED_MIGRATION_REVIEW_CHANGED")
  const changed = {
    ...review,
    origin: {
      ...review.origin,
      member_bindings: [
        {
          legacy_id: "foreign",
          skill_id: "foreign",
          record_id: "foreign",
          page_id: "00000000-0000-4000-8000-000000000999",
        },
      ],
    },
  }
  expect(
    (
      await f.run(
        Effect.flip(
          applySharedMigration({
            migrationInput: fixture.approved,
            review: changed,
            reviewId: review.review_id,
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_REVIEW_CHANGED")
  expect(f.calls).toHaveLength(0)
  expect(f.pending()).toHaveLength(0)
})

test("unapproved review does not waive unknown ownership or unsupported source options", async () => {
  const f = sharedCreateFixture(),
    fixture = unapproved(true)
  const unknown = {
    ...fixture.frozen,
    catalog: {
      ...fixture.frozen.catalog,
      entries: [
        {
          ...fixture.entry,
          files: fixture.entry.files.map((file) => ({ ...file, ownership: "unknown" as const })),
        },
      ],
    },
  }
  expect(
    (
      await f.run(
        Effect.flip(reviewSharedMigration({ ...fixture.input, migration_input: unknown })),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_CREATE_BLOCKED")
  const unsupported = {
    ...fixture.frozen,
    preservation: {
      ...fixture.frozen.preservation,
      sources: {
        ...fixture.frozen.preservation.sources,
        items: fixture.frozen.preservation.sources.items.map((source) => ({
          ...source,
          raw: { include: ["*.md"] },
        })),
      },
    },
  }
  expect(
    (
      await f.run(
        Effect.flip(reviewSharedMigration({ ...fixture.input, migration_input: unsupported })),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_CREATE_BLOCKED")
  expect(f.writes()).toHaveLength(0)
  expect(f.calls).toHaveLength(0)
})

test("approval cannot silently replace an exact Router member page frozen in the review", async () => {
  const f = sharedCreateFixture(),
    member = migrationConversionFixture({ main: "Member body" })
  const router = migrationConversionFixture({ kind: "router", main: "Router body" })
  const frozen = {
    ...router.migrationInput,
    approved_legacy_ids: [],
    catalog: { ...router.migrationInput.catalog, entries: [member.entry, router.entry] },
    preservation: {
      ...router.migrationInput.preservation,
      routers: {
        complete: true,
        items: [
          {
            legacy_id: router.entry.legacy_id,
            complete: true,
            references: [member.entry.legacy_id],
            raw: { original_relation: [property(property(member.entry.record).locator).page_id] },
          },
        ],
      },
    },
  }
  const input = { ...router.input, migration_input: frozen }
  const candidate = await f.run(reviewSharedMigrationConversion(input)),
    mapping = first(candidate.member_bindings)
  const originalPage = id(700),
    replacementPage = id(701)
  f.seedSkill(originalPage, mapping.skill_id, "Exact migrated member")
  const review = await f.run(reviewSharedMigration(input))
  expect(review.origin.member_bindings.map((binding) => binding.page_id)).toEqual([originalPage])
  f.skills.delete(originalPage)
  f.seedSkill(replacementPage, mapping.skill_id, "Exact migrated member")
  const approved = { ...frozen, approved_legacy_ids: [router.entry.legacy_id] }
  const error = await f.run(
    Effect.flip(
      applySharedMigration({
        migrationInput: approved,
        review,
        reviewId: review.review_id,
        dryRun: true,
      }),
    ),
  )
  expect(error.code).toBe("SHARED_MIGRATION_REVIEW_STALE")
  expect(f.writes()).toHaveLength(0)
  expect(f.pending()).toHaveLength(0)
})

test("approved public migration reuses native create and verifies a complete current fixed snapshot", async () => {
  const f = sharedCreateFixture(),
    fixture = unapproved(),
    before = structuredClone(fixture.input)
  const review = await f.run(reviewSharedMigration(fixture.input))
  const result = await f.run(
    applySharedMigration({ migrationInput: fixture.approved, review, reviewId: review.review_id }),
  )
  if (result.status !== "created") throw new Error("Expected controlled creation")
  expect(result.verified).toBe(true)
  expect(result.snapshot_id).toMatch(/^s_[a-f0-9]{64}$/u)
  expect(result.ref).toContain(`snapshot=${result.snapshot_id}`)
  expect(result.operation_id).toBe(result.create_operation_id)
  expect(result.files.map((file) => file.path).sort()).toEqual(["SKILL.md", "notes.md"])
  expect(f.nativeCreates()).toHaveLength(2)
  expect(f.pending()).toHaveLength(0)
  expect(fixture.input).toEqual(before)
  f.credential("another-authorized-migration-reader")
  f.clear()
  const locator = property(property(result.record).locator)
  if (typeof locator.page_id !== "string") throw new Error("Missing exact created page")
  const historical = await f.run(
    reconcileSharedMigration({
      entry: createLibrary.skills.database_id,
      operationId: result.operation_id,
      target: locator.page_id,
    }),
  )
  expect(historical.reused).toBe(true)
  expect(historical.current_snapshot_verified).toBe(false)
  expect(property(historical).snapshot_id).toBeUndefined()
  expect(f.writes()).toHaveLength(0)
  expect(f.currentBodies()).toHaveLength(0)
})

test("unknown migration execution remains one dispatch and public reconcile only reads the original journal", async () => {
  const f = sharedCreateFixture(),
    fixture = unapproved(),
    review = await f.run(reviewSharedMigration(fixture.input))
  f.unknown("skill", false)
  const failed = await f.run(
    Effect.flip(
      applySharedMigration({
        migrationInput: fixture.approved,
        review,
        reviewId: review.review_id,
      }),
    ),
  )
  expect(failed.code).toBe("WRITE_OUTCOME_UNKNOWN")
  const operation = property(failed.details).native_create_operation_id
  if (typeof operation !== "string") throw new Error("Missing original unknown operation")
  expect(f.nativeCreates()).toHaveLength(1)
  expect(
    (
      await f.run(
        Effect.flip(
          reconcileSharedMigration({
            entry: createLibrary.skills.database_id,
            operationId: operation,
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_CREATE_UNRESOLVED")
  expect(
    (
      await f.run(
        Effect.flip(
          applySharedMigration({
            migrationInput: fixture.approved,
            review,
            reviewId: review.review_id,
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_CREATE_UNRESOLVED")
  expect(f.nativeCreates()).toHaveLength(1)
  expect(f.pending()).toHaveLength(1)
})

test("a changed final body fails verification without adopting it as a migration side effect", async () => {
  const f = sharedCreateFixture(),
    fixture = unapproved(),
    review = await f.run(reviewSharedMigration(fixture.input))
  let page = ""
  f.onCreate((created, kind) => {
    if (kind === "skill") page = String(created.id)
  })
  f.afterOutcome(() => {
    f.base.bodies.set(page, "A later user edit")
    const row = f.skills.get(page)
    if (row) row.last_edited_time = "2030-01-01T00:00:00.000Z"
  })
  const failure = await f.run(
    Effect.flip(
      applySharedMigration({
        migrationInput: fixture.approved,
        review,
        reviewId: review.review_id,
      }),
    ),
  )
  expect(failure.code).toBe("WRITE_VERIFICATION_FAILED")
  expect(property(failure.details).native_create_completed).toBe(true)
  expect(property(failure.details).verification_error_code).toBe("SHARED_SNAPSHOT_INVALID")
  expect(f.base.bodies.get(page)).toBe("A later user edit")
  const facts = await f.run(
    querySharedRecords(createLibrary, { skillPageId: page, kind: "file_event" }),
  )
  expect(facts).toHaveLength(2)
  expect(facts.every((fact) => fact.record_id.startsWith("migration-event-"))).toBe(true)
})
