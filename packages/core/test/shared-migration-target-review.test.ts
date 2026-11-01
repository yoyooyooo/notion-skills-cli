import { expect, test } from "bun:test"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import { executeSharedCreate, prepareSharedMigrationReview } from "../src/shared-create.ts"
import { reviewSharedMigrationConversion } from "../src/shared-migration-conversion.ts"
import { planSharedMigration, type SharedMigrationInput } from "../src/shared-migration-plan.ts"
import { applySharedMigration, reviewSharedMigration } from "../src/shared-migration-review.ts"
import { migrationTargetReviewBlockers } from "../src/shared-migration-target-review.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { sharedCreateFixture } from "./shared-create-fixture.ts"
import {
  first,
  migrationConversionFixture,
  migrationHash,
} from "./shared-migration-conversion-fixture.ts"
import { id } from "./shared-snapshot-fixture.ts"

type Entry = SharedMigrationInput["catalog"]["entries"][number]
type Operation = SharedMigrationInput["preservation"]["operations"]["items"][number]
const operationId = "original-unknown-batch"
const impactRef = "evidence:controlled/original-batch/impact"
const isolationRef = "evidence:controlled/original-batch/isolation"

function pair() {
  const selected = migrationConversionFixture({ main: "Frozen selected main" })
  const other = migrationConversionFixture({ kind: "prompt", main: "Frozen other main" })
  const frozen: SharedMigrationInput = {
    ...selected.migrationInput,
    approved_legacy_ids: [],
    catalog: { ...selected.migrationInput.catalog, entries: [selected.entry, other.entry] },
  }
  return { selected, other, frozen }
}
function originalOperation(page: string): Operation {
  const raw = {
    operation_id: operationId,
    plan_id: "original-plan",
    subscription_id: "original-subscription",
    state: "unknown",
    items: [{ member_key: "original-member", status: "unknown", page_id: page }],
  }
  const payload = JSON.stringify(raw)
  return {
    legacy_id: operationId,
    raw,
    complete: true,
    references: [],
    retention_verified: true,
    retention_ref: "backup:controlled/original-batch",
    terminal_verified: false,
    operation_origin: {
      version: 1,
      table: "upstream_operations",
      row_key: operationId,
      database_sha256: "a".repeat(64),
      payload_sha256: migrationHash(payload),
      payload_bytes: new TextEncoder().encode(payload).length,
      verified: true,
      receipt_ref: "backup:controlled/original-batch/sql-origin",
      row_metadata: { operation_id: operationId, plan_id: raw.plan_id, state: raw.state },
    },
  }
}
function withOperation(input: SharedMigrationInput, operation: Operation): SharedMigrationInput {
  return {
    ...input,
    preservation: { ...input.preservation, operations: { complete: true, items: [operation] } },
  }
}
function withReceipt(
  input: SharedMigrationInput,
  affected: readonly string[],
): SharedMigrationInput {
  const { readiness_evidence: _old, ...facts } = input
  return {
    ...facts,
    readiness_evidence: {
      version: 1,
      basis_sha256: migrationHash(canonicalSharedJson(facts)),
      operations: [
        {
          legacy_id: operationId,
          impact: { complete: true, legacy_ids: affected, receipt_ref: impactRef },
          isolation: {
            verified: true,
            receipt_ref: isolationRef,
            recovery: { action: "inspect_original", reference: "audit:controlled/original-batch" },
          },
        },
      ],
    },
  }
}
function originalPage(entry: Entry): string {
  const page = property(property(entry.record).locator).page_id
  if (typeof page !== "string") throw new Error("Expected original fixture page")
  return page
}

test("a complete target can be reviewed beside another incomplete file tree without changing the full blocked plan", async () => {
  const f = sharedCreateFixture(),
    fixture = pair()
  const frozen: SharedMigrationInput = {
    ...fixture.frozen,
    catalog: {
      ...fixture.frozen.catalog,
      entries: [
        fixture.selected.entry,
        { ...fixture.other.entry, files_complete: false, files: [] },
      ],
    },
  }
  const before = structuredClone(frozen),
    plan = await f.run(planSharedMigration(frozen))
  expect(plan.status).toBe("blocked")
  expect(plan.readiness.global_blocker_indexes.length).toBeGreaterThan(0)
  expect(
    plan.blockers.some(
      (blocker) =>
        blocker.subject === fixture.other.entry.legacy_id &&
        blocker.code === "FILE_INVENTORY_INCOMPLETE",
    ),
  ).toBe(true)
  const review = await f.run(
    reviewSharedMigration({ ...fixture.selected.input, migration_input: frozen }),
  )
  expect(review.origin.candidate.legacy_entry).toEqual(fixture.selected.entry)
  expect(review.origin.candidate.migration_input_sha256).toBe(plan.input_sha256)
  expect(review.originally_approved_legacy_ids).toEqual([])
  expect(review.execution).toEqual({ read_only: true, apply_allowed: false })
  expect(frozen).toEqual(before)
  expect(await f.run(planSharedMigration(frozen))).toEqual(plan)
  expect(plan.evidence.catalog.entries).toHaveLength(2)
  expect(plan.readiness.approved_batch.ready_legacy_ids).toEqual([])
  expect(plan.apply_allowed).toBe(false)
  expect(f.writes()).toHaveLength(0)
  expect(f.pending()).toHaveLength(0)
  expect(f.currentBodies()).toHaveLength(0)
})

test("target bytes and ownership plus unresolved Source preservation remain hard review gates", async () => {
  const fixture = pair()
  const targets: readonly Entry[] = [
    { ...fixture.selected.entry, files_complete: false },
    {
      ...fixture.selected.entry,
      files: fixture.selected.entry.files.map((file) => ({ ...file, ownership: "unknown" })),
    },
    {
      ...fixture.selected.entry,
      files: fixture.selected.entry.files.map(({ body: _body, ...file }) => file),
    },
  ]
  for (const selected of targets) {
    const f = sharedCreateFixture(),
      frozen = {
        ...fixture.frozen,
        catalog: { ...fixture.frozen.catalog, entries: [selected, fixture.other.entry] },
      }
    expect(
      (
        await f.run(
          Effect.flip(
            reviewSharedMigration({ ...fixture.selected.input, migration_input: frozen }),
          ),
        )
      ).code,
    ).toBe("SHARED_MIGRATION_CREATE_BLOCKED")
    expect(f.calls).toHaveLength(0)
    expect(f.pending()).toHaveLength(0)
  }
  const following = migrationConversionFixture({ main: "Retained following main", following: true })
  const sourceGap: SharedMigrationInput = {
    ...following.migrationInput,
    approved_legacy_ids: [],
    preservation: {
      ...following.migrationInput.preservation,
      sources: {
        ...following.migrationInput.preservation.sources,
        items: following.migrationInput.preservation.sources.items.map((source) => ({
          ...source,
          complete: false,
        })),
      },
    },
  }
  const f = sharedCreateFixture()
  expect(
    (
      await f.run(
        Effect.flip(reviewSharedMigration({ ...following.input, migration_input: sourceGap })),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_CREATE_BLOCKED")
  expect(f.calls).toHaveLength(0)
})

test("empty references cannot hide a nested batch write to the selected target behind a disjoint receipt", async () => {
  const fixture = pair(),
    raw = withOperation(fixture.frozen, originalOperation(originalPage(fixture.selected.entry)))
  for (const frozen of [raw, withReceipt(raw, [fixture.other.entry.legacy_id])]) {
    const f = sharedCreateFixture(),
      plan = await f.run(planSharedMigration(frozen))
    expect(first(plan.readiness.operations).impact_scope).toBe("unknown")
    expect(first(plan.readiness.operations).known_legacy_ids).toContain(
      fixture.selected.entry.legacy_id,
    )
    const relevant = migrationTargetReviewBlockers(plan, fixture.selected.entry.legacy_id)
    expect(
      relevant.blocking_indexes.some(
        (index) => plan.blockers[index]?.code === "UNSETTLED_OPERATION",
      ),
    ).toBe(true)
    expect(
      (
        await f.run(
          Effect.flip(
            reviewSharedMigration({ ...fixture.selected.input, migration_input: frozen }),
          ),
        )
      ).code,
    ).toBe("SHARED_MIGRATION_CREATE_BLOCKED")
    expect(first(frozen.preservation.operations.items).raw).toEqual(
      first(raw.preservation.operations.items).raw,
    )
    expect(f.calls).toHaveLength(0)
  }
})

test("Router review propagates a declared member operation blocker instead of treating that member as unrelated", async () => {
  const f = sharedCreateFixture(),
    member = migrationConversionFixture({ main: "Original member" })
  const router = migrationConversionFixture({ kind: "router", main: "Original Router" })
  const frozen = withReceipt(
    withOperation(
      {
        ...router.migrationInput,
        approved_legacy_ids: [],
        catalog: { ...router.migrationInput.catalog, entries: [router.entry, member.entry] },
        preservation: {
          ...router.migrationInput.preservation,
          routers: {
            complete: true,
            items: [
              {
                legacy_id: router.entry.legacy_id,
                complete: true,
                references: [member.entry.legacy_id],
                raw: { original: "retained" },
              },
            ],
          },
        },
      },
      originalOperation(originalPage(member.entry)),
    ),
    [member.entry.legacy_id],
  )
  const plan = await f.run(planSharedMigration(frozen))
  expect(plan.readiness.global_blocker_indexes).toEqual([])
  const relevant = migrationTargetReviewBlockers(plan, router.entry.legacy_id)
  expect(relevant.dependency_legacy_ids).toContain(member.entry.legacy_id)
  expect(
    relevant.blocking_indexes.some((index) => plan.blockers[index]?.code === "UNSETTLED_OPERATION"),
  ).toBe(true)
  expect(
    (await f.run(Effect.flip(reviewSharedMigration({ ...router.input, migration_input: frozen }))))
      .code,
  ).toBe("SHARED_MIGRATION_CREATE_BLOCKED")
  expect(f.calls).toHaveLength(0)
})

test("27 observed Router members with a partial 28-member Source remain incomplete and cannot be converted", async () => {
  const f = sharedCreateFixture(),
    router = migrationConversionFixture({ kind: "router", main: "Retained Router" })
  const member = migrationConversionFixture({ main: "Retained member" })
  const members = Array.from({ length: 27 }, (_, index): Entry => {
    const page = id(800 + index),
      legacy = `notion_page:${page}`
    return {
      ...member.entry,
      legacy_id: legacy,
      record: {
        ...property(member.entry.record),
        id: legacy,
        name: `Retained member ${index}`,
        locator: { type: "notion_page", page_id: page, database_id: "old-database" },
      },
    }
  })
  const relation = {
    legacy_id: router.entry.legacy_id,
    complete: false,
    references: members.map((entry) => entry.legacy_id),
    raw: {
      published_members: members.map(originalPage),
      source_manifest: [...members.map(originalPage), id(899)],
      state: "partial",
    },
  }
  const frozen: SharedMigrationInput = {
    ...router.migrationInput,
    approved_legacy_ids: [],
    catalog: { ...router.migrationInput.catalog, entries: [router.entry, ...members] },
    preservation: {
      ...router.migrationInput.preservation,
      routers: { complete: true, items: [relation] },
    },
  }
  const plan = await f.run(planSharedMigration(frozen))
  expect(
    plan.blockers.some(
      (blocker) =>
        blocker.subject === `routers:${router.entry.legacy_id}` &&
        blocker.code === "PRESERVATION_INCOMPLETE",
    ),
  ).toBe(true)
  expect(
    (await f.run(Effect.flip(reviewSharedMigration({ ...router.input, migration_input: frozen }))))
      .code,
  ).toBe("SHARED_MIGRATION_CREATE_BLOCKED")
  expect(first(frozen.preservation.routers.items)).toEqual(relation)
  expect(f.calls).toHaveLength(0)
})

test("a declared disjoint isolation receipt permits structural review but neither apply nor direct create execution", async () => {
  const f = sharedCreateFixture(),
    fixture = pair()
  const raw = withOperation(fixture.frozen, originalOperation(originalPage(fixture.other.entry)))
  const frozen = withReceipt(raw, [fixture.other.entry.legacy_id])
  const approved = withReceipt(
    { ...raw, approved_legacy_ids: [fixture.selected.entry.legacy_id] },
    [fixture.other.entry.legacy_id],
  )
  const structure = await f.run(planSharedMigration(approved))
  expect(
    structure.readiness.items.find((item) => item.legacy_id === fixture.selected.entry.legacy_id)
      ?.evidence_ready,
  ).toBe(true)
  expect(structure.readiness.receipt_content_verified).toBe(false)
  const review = await f.run(
    reviewSharedMigration({ ...fixture.selected.input, migration_input: frozen }),
  )
  const candidate = await f.run(
    reviewSharedMigrationConversion({ ...fixture.selected.input, migration_input: approved }),
  )
  const plan = await f.run(prepareSharedMigrationReview(fixture.selected.input.library, candidate))
  f.clear()
  for (const dryRun of [true, false]) {
    const failure = await f.run(
      Effect.flip(
        applySharedMigration({
          migrationInput: approved,
          review,
          reviewId: review.review_id,
          dryRun,
        }),
      ),
    )
    expect(failure.code).toBe("SHARED_MIGRATION_RECEIPT_UNVERIFIED")
    expect(property(failure.details).receipt_content_verified).toBe(false)
    expect(property(failure.details).receipts).toEqual([
      {
        operation_id: operationId,
        blocker_indexes: structure.blockers.flatMap((blocker, index) =>
          blocker.subject === `operations:${operationId}` && blocker.code === "UNSETTLED_OPERATION"
            ? [index]
            : [],
        ),
        impact_receipt_ref: impactRef,
        isolation_receipt_ref: isolationRef,
        recovery: { action: "inspect_original", reference: "audit:controlled/original-batch" },
      },
    ])
  }
  expect(
    (
      await f.run(
        Effect.flip(
          executeSharedCreate(fixture.selected.input.library, {
            plan,
            mode: "create",
            migrationInput: approved,
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_RECEIPT_UNVERIFIED")
  expect(f.calls).toHaveLength(0)
  expect(f.writes()).toHaveLength(0)
  expect(f.pending()).toHaveLength(0)
  expect(first(approved.preservation.operations.items).terminal_verified).toBe(false)
  expect(property(first(approved.preservation.operations.items).raw).state).toBe("unknown")
})
