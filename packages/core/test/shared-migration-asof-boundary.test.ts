import { expect, test } from "bun:test"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import { executeSharedCreate, prepareSharedMigrationCreate } from "../src/shared-create.ts"
import {
  makeSharedMigrationConversion,
  retainedMigrationConversionInput,
  validateRetainedMigrationConversion,
  type MigrationConversionInput,
} from "../src/shared-migration-conversion.ts"
import { planSharedMigration, type SharedMigrationInput } from "../src/shared-migration-plan.ts"
import {
  applySharedMigration,
  reconcileSharedMigration,
  reviewSharedMigration,
  validateSharedMigrationReview,
} from "../src/shared-migration-review.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { sharedCreateFixture } from "./shared-create-fixture.ts"
import {
  first,
  migrationConversionFixture,
  migrationHash,
} from "./shared-migration-conversion-fixture.ts"
import { legacyCommittedPublicationFixture } from "./shared-migration-legacy-publication-fixture.ts"

type Entry = SharedMigrationInput["catalog"]["entries"][number]
type Operation = SharedMigrationInput["preservation"]["operations"]["items"][number]
const historyId = "original-asof-review-operation"

function pageOf(entry: Entry): string {
  const page = property(property(entry.record).locator).page_id
  if (typeof page !== "string") throw new Error("The controlled original page is missing")
  return page
}

/** A retained original, including a target-page effect, remains unknown. Empty
 * references are deliberate; they must never become evidence of no effects. */
function historicalOperation(page: string): Operation {
  const raw = {
    operation_id: historyId,
    plan_id: "retained-asof-plan",
    subscription_id: "retained-asof-subscription",
    state: "unknown",
    items: [{ member_key: "retained-asof-member", status: "unknown", page_id: page }],
  }
  const payload = JSON.stringify(raw)
  return {
    legacy_id: historyId,
    raw,
    complete: true,
    references: [],
    retention_verified: true,
    retention_ref: "backup:controlled/asof/original",
    terminal_verified: false,
    operation_origin: {
      version: 1,
      table: "upstream_operations",
      row_key: historyId,
      database_sha256: "a".repeat(64),
      payload_sha256: migrationHash(payload),
      payload_bytes: new TextEncoder().encode(payload).length,
      row_metadata: { operation_id: historyId, plan_id: raw.plan_id, state: raw.state },
      verified: true,
      receipt_ref: "backup:controlled/asof/sql-origin",
    },
  }
}

function withHistory(input: SharedMigrationInput, page: string): SharedMigrationInput {
  return {
    ...input,
    preservation: {
      ...input.preservation,
      operations: { complete: true, items: [historicalOperation(page)] },
    },
  }
}

async function asOfFixture() {
  const original = await legacyCommittedPublicationFixture()
  const base = migrationConversionFixture(),
    entry = original.derived.entry
  const dataSource = property(property(entry.record).locator).data_source_id
  if (typeof dataSource !== "string") throw new Error("Missing selected original data source")
  const history = withHistory(
    {
      ...base.migrationInput,
      scope: original.derived.scope,
      approved_legacy_ids: [entry.legacy_id],
      catalog: {
        coverage: {
          ...base.migrationInput.catalog.coverage,
          exhaustive: false,
          queried_data_sources: [dataSource],
          failed_sources: [
            {
              id: "controlled-unrelated-source",
              code: "INVALID_UPSTREAM",
              database_id: "controlled-unrelated-database",
              alias: "controlled-unrelated",
              title: "Unresolved unrelated source",
            },
          ],
        },
        entries: [entry],
      },
      preservation: {
        ...base.migrationInput.preservation,
        sources: { complete: false, items: [original.derived.source] },
      },
    },
    pageOf(entry),
  )
  // The original payload is retained, but its old effect/reference closure was
  // never fully interpreted. The new copy must not manufacture that conclusion.
  const migrationInput: SharedMigrationInput = {
    ...history,
    preservation: {
      ...history.preservation,
      operations: {
        ...history.preservation.operations,
        items: history.preservation.operations.items.map((item) => ({ ...item, complete: false })),
      },
    },
  }
  const input: MigrationConversionInput = {
    migration_input: migrationInput,
    library: base.input.library,
    legacy_id: entry.legacy_id,
    execution_policy: "copy_to_new_native_v2",
    files: entry.files.map((file) => {
      const native = original.proof.native_preimages.find((item) => item.path === file.path)
      const retained = original.native_files.find((item) => item.path === file.path)
      if (!native || !retained || retained.retention_ref !== file.body?.retention_ref)
        throw new Error("Missing controlled publication preimage or retained body")
      const {
        path: _path,
        body_retention_ref: _bodyRef,
        response_sha256: _responseSha,
        response_bytes: _responseBytes,
        body_sha256: _bodySha,
        ...preimage
      } = native
      return {
        legacy_id: file.legacy_id,
        bytes: retained.bytes,
        retention_ref: retained.retention_ref,
        native_preimage: preimage,
      }
    }),
    source_files: original.source_files.map((file) => ({
      ...file,
      retention_ref: `${original.proof.source_archive.retention_ref}#file=${file.path}`,
    })),
  }
  return {
    original,
    entry,
    migrationInput,
    input,
    frozen: { ...migrationInput, approved_legacy_ids: [] },
  }
}

function expectOriginalHistory(input: SharedMigrationInput, before: string) {
  expect(canonicalSharedJson(input)).toBe(before)
  expect(first(input.preservation.operations.items).terminal_verified).toBe(false)
  expect(first(input.preservation.operations.items).references).toEqual([])
  expect(property(first(input.preservation.operations.items).raw).state).toBe("unknown")
}

test("saved unmarked and v1 copy candidates retain their exact policy and cannot inherit v2 by relabelling", async () => {
  const fixture = migrationConversionFixture({ main: "Frozen original candidate" })
  for (const policy of [undefined, "copy_to_new_native_v1"] as const) {
    const f = sharedCreateFixture()
    const input = {
      ...fixture.input,
      ...(policy === undefined ? {} : { execution_policy: policy }),
    }
    const candidate = await f.run(makeSharedMigrationConversion(input))
    const original = canonicalSharedJson(candidate)
    expect(await f.run(validateRetainedMigrationConversion(candidate))).toEqual(candidate)
    const reconstructed = retainedMigrationConversionInput(fixture.migrationInput, candidate)
    expect(property(reconstructed).execution_policy).toBe(policy)
    expect(Object.hasOwn(reconstructed, "execution_policy")).toBe(policy !== undefined)
    const changed = { ...candidate, execution_policy: "copy_to_new_native_v2" }
    const failure = await f.run(Effect.flip(validateRetainedMigrationConversion(changed)))
    expect(candidate.legacy_source).toBeNull()
    expect(failure.code).toBe("INVALID_SHARED_RECORD")
    expect(failure.message).toBe("Shared record payload must contain only JSON values.")
    expect(canonicalSharedJson(candidate)).toBe(original)
    expect(f.calls).toHaveLength(0)
    expect(f.pending()).toHaveLength(0)
  }
})

test("old unmarked and v1 execution still reject an original unknown operation affecting their own target", async () => {
  const fixture = migrationConversionFixture({ main: "Frozen historical target" })
  const migrationInput = withHistory(fixture.migrationInput, pageOf(fixture.entry))
  const before = canonicalSharedJson(migrationInput)
  for (const policy of [undefined, "copy_to_new_native_v1"] as const) {
    const f = sharedCreateFixture()
    const input = {
      ...fixture.input,
      migration_input: migrationInput,
      ...(policy === undefined ? {} : { execution_policy: policy }),
    }
    expect((await f.run(Effect.flip(makeSharedMigrationConversion(input)))).code).toBe(
      "SHARED_MIGRATION_CREATE_BLOCKED",
    )
    expect(f.calls).toHaveLength(0)
    expect(f.pending()).toHaveLength(0)
  }
  expect(canonicalSharedJson(migrationInput)).toBe(before)
})

test("full migration readiness continues to expose target history unknown without treating empty references as isolation", async () => {
  const fixture = migrationConversionFixture({ main: "Frozen as-of baseline" })
  const migrationInput = withHistory(fixture.migrationInput, pageOf(fixture.entry))
  const f = sharedCreateFixture(),
    before = canonicalSharedJson(migrationInput)
  const plan = await f.run(planSharedMigration(migrationInput))
  expect(plan.status).toBe("blocked")
  expect(plan.apply_allowed).toBe(false)
  expect(
    plan.blockers.some(
      (blocker) =>
        blocker.subject === `operations:${historyId}` && blocker.code === "UNSETTLED_OPERATION",
    ),
  ).toBe(true)
  expect(first(plan.readiness.operations).impact_scope).toBe("unknown")
  expect(first(plan.readiness.operations).known_legacy_ids).toContain(fixture.entry.legacy_id)
  expect(first(plan.evidence.preservation.operations.items).terminal_verified).toBe(false)
  expect(first(plan.evidence.preservation.operations.items).references).toEqual([])
  expect(canonicalSharedJson(migrationInput)).toBe(before)
  expect(f.calls).toHaveLength(0)
})

test("explicit as-of copy can create a new complete target while its own original operation stays unknown and full migration remains blocked", async () => {
  const fixture = await asOfFixture(),
    f = sharedCreateFixture()
  const before = canonicalSharedJson(fixture.migrationInput)
  const full = await f.run(planSharedMigration(fixture.migrationInput))
  expect(full.status).toBe("blocked")
  expect(
    full.blockers.some(
      (blocker) => blocker.subject === "catalog" && blocker.code === "CATALOG_INCOMPLETE",
    ),
  ).toBe(true)
  expect(
    full.blockers.some(
      (blocker) =>
        blocker.subject === `operations:${historyId}` && blocker.code === "PRESERVATION_INCOMPLETE",
    ),
  ).toBe(true)
  const { execution_policy: _explicitPolicy, ...publicInput } = fixture.input
  const review = await f.run(
    reviewSharedMigration({ ...publicInput, migration_input: fixture.frozen }),
  )
  expect(property(review.origin.candidate).execution_policy).toBe("copy_to_new_native_v2")
  expect(property(review).retained_operations).toEqual(fixture.frozen.preservation.operations)
  expect(property(review).retained_catalog_coverage).toEqual(fixture.frozen.catalog.coverage)
  expect(await f.run(validateSharedMigrationReview(review, review.review_id))).toEqual(review)
  const dry = await f.run(
    applySharedMigration({
      migrationInput: fixture.migrationInput,
      review,
      reviewId: review.review_id,
      dryRun: true,
    }),
  )
  expect(dry.status).toBe("planned")
  expect(f.writes()).toHaveLength(0)
  const candidate = await f.run(
    makeSharedMigrationConversion(
      retainedMigrationConversionInput(fixture.migrationInput, review.origin.candidate),
    ),
  )
  const plan = await f.run(
    prepareSharedMigrationCreate(fixture.input.library, {
      candidate,
      migrationInput: fixture.migrationInput,
    }),
  )
  const created = await f.run(
    executeSharedCreate(fixture.input.library, {
      plan,
      mode: "create",
      migrationInput: fixture.migrationInput,
    }),
  )
  expect(created.record.id).toBe(candidate.record_id)
  expect(f.nativeCreates()).toHaveLength(fixture.entry.files.length)
  expect(f.enablePatches()).toHaveLength(1)
  expect(first(f.enablePatches()).path).toBe(`v1/pages/${created.skill_page_id}`)
  const originalPages = fixture.original.proof.native_preimages.map((item) => item.page_id)
  expect(originalPages).not.toContain(created.skill_page_id)
  expect(f.calls.some((call) => originalPages.some((page) => call.path.includes(page)))).toBe(false)
  expectOriginalHistory(fixture.migrationInput, before)
  expect(await f.run(planSharedMigration(fixture.migrationInput))).toEqual(full)
  expect(full.apply_allowed).toBe(false)
})

test("as-of copy still rejects target gaps, selected Source changes and incomplete aliases of its physical pages", async () => {
  const fixture = await asOfFixture()
  const unrelated = migrationConversionFixture({ kind: "prompt", main: "Retained other object" })
  const router = migrationConversionFixture({ kind: "router", main: "Retained Router" })
  const source = first(fixture.migrationInput.preservation.sources.items)
  const selectedLocator = property(property(fixture.entry.record).locator)
  const withOther = (alias: Entry, physicalPage?: string): SharedMigrationInput => ({
    ...fixture.migrationInput,
    catalog: {
      ...fixture.migrationInput.catalog,
      entries: [
        fixture.entry,
        {
          ...alias,
          files_complete: false,
          record: {
            ...property(alias.record),
            locator: {
              ...property(property(alias.record).locator),
              database_id: selectedLocator.database_id,
              data_source_id: selectedLocator.data_source_id,
              ...(physicalPage === undefined ? {} : { page_id: physicalPage }),
            },
          },
        },
      ],
    },
    preservation: {
      ...fixture.migrationInput.preservation,
      ...(property(alias.record).kind !== "router"
        ? {}
        : {
            routers: {
              complete: true,
              items: [
                {
                  legacy_id: alias.legacy_id,
                  complete: true,
                  references: [],
                  raw: { original_members: [] },
                },
              ],
            },
          }),
    },
  })
  // Same DB/DS is a positive control: only the physical-page alias below changes
  // this result. A missing Router preservation row must not mask the alias test.
  for (const other of [unrelated.entry, router.entry]) {
    const f = sharedCreateFixture()
    const candidate = await f.run(
      makeSharedMigrationConversion({ ...fixture.input, migration_input: withOther(other) }),
    )
    expect(candidate.legacy_id).toBe(fixture.entry.legacy_id)
    expect(f.calls).toHaveLength(0)
  }
  const supporting = fixture.original.proof.native_preimages.find(
    (item) => item.path !== "SKILL.md",
  )
  if (!supporting) throw new Error("Missing controlled supporting-page identity")
  const cases: readonly { input: SharedMigrationInput; error: string }[] = [
    {
      input: { ...fixture.migrationInput, scope: "another-retained-observation-scope" },
      error: "SHARED_MIGRATION_CREATE_SCOPE",
    },
    {
      input: {
        ...fixture.migrationInput,
        catalog: {
          ...fixture.migrationInput.catalog,
          entries: [{ ...fixture.entry, files_complete: false }],
        },
      },
      error: "SHARED_MIGRATION_PUBLICATION_INVALID",
    },
    {
      input: {
        ...fixture.migrationInput,
        catalog: {
          ...fixture.migrationInput.catalog,
          entries: [
            {
              ...fixture.entry,
              files: fixture.entry.files.map((file) => ({ ...file, ownership: "unknown" })),
            },
          ],
        },
      },
      error: "SHARED_MIGRATION_PUBLICATION_INVALID",
    },
    {
      input: {
        ...fixture.migrationInput,
        preservation: {
          ...fixture.migrationInput.preservation,
          sources: { complete: true, items: [{ ...source, complete: false }] },
        },
      },
      error: "SHARED_MIGRATION_PUBLICATION_INVALID",
    },
    {
      input: {
        ...fixture.migrationInput,
        preservation: {
          ...fixture.migrationInput.preservation,
          sources: {
            complete: true,
            items: [{ ...source, references: [unrelated.entry.legacy_id] }],
          },
        },
      },
      error: "SHARED_MIGRATION_PUBLICATION_INVALID",
    },
    {
      input: withOther(unrelated.entry, pageOf(fixture.entry)),
      error: "SHARED_MIGRATION_CREATE_BLOCKED",
    },
    {
      input: withOther(router.entry, pageOf(fixture.entry)),
      error: "SHARED_MIGRATION_CREATE_BLOCKED",
    },
    {
      input: withOther(unrelated.entry, supporting.page_id),
      error: "SHARED_MIGRATION_CREATE_BLOCKED",
    },
  ]
  for (const { input: migrationInput, error } of cases) {
    const f = sharedCreateFixture(),
      before = canonicalSharedJson(migrationInput)
    const failure = await f.run(
      Effect.flip(
        makeSharedMigrationConversion({ ...fixture.input, migration_input: migrationInput }),
      ),
    )
    expect(failure.code).toBe(error)
    expect(f.calls).toHaveLength(0)
    expect(f.pending()).toHaveLength(0)
    expectOriginalHistory(migrationInput, before)
  }
})

test("v2 review cannot carry approval across removing or settling the original unknown history", async () => {
  const fixture = await asOfFixture(),
    f = sharedCreateFixture()
  const review = await f.run(
    reviewSharedMigration({ ...fixture.input, migration_input: fixture.frozen }),
  )
  expect(property(review).retained_operations).toEqual(fixture.frozen.preservation.operations)
  expect(property(review).retained_catalog_coverage).toEqual(fixture.frozen.catalog.coverage)
  const withoutHistory = Object.fromEntries(
    Object.entries(review).filter(([key]) => key !== "retained_operations"),
  )
  expect(
    (await f.run(Effect.flip(validateSharedMigrationReview(withoutHistory, review.review_id))))
      .code,
  ).toBe("SHARED_MIGRATION_REVIEW_CHANGED")
  const original = first(fixture.migrationInput.preservation.operations.items)
  for (const operations of [
    { complete: true, items: [] },
    {
      complete: true,
      items: [
        {
          ...original,
          terminal_verified: true,
          terminal_evidence: "unverified:replacement",
          raw: { ...property(original.raw), state: "committed" },
        },
      ],
    },
  ]) {
    const changed = {
      ...fixture.migrationInput,
      preservation: { ...fixture.migrationInput.preservation, operations },
    }
    const failure = await f.run(
      Effect.flip(
        applySharedMigration({
          migrationInput: changed,
          review,
          reviewId: review.review_id,
          dryRun: true,
        }),
      ),
    )
    expect(failure.code).toBe("SHARED_MIGRATION_REVIEW_CHANGED")
  }
  const inventedCoverage = {
    ...fixture.migrationInput.catalog.coverage,
    exhaustive: true,
    failed_sources: [],
  }
  expect(
    (
      await f.run(
        Effect.flip(
          applySharedMigration({
            migrationInput: {
              ...fixture.migrationInput,
              catalog: { ...fixture.migrationInput.catalog, coverage: inventedCoverage },
            },
            review,
            reviewId: review.review_id,
            dryRun: true,
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_REVIEW_CHANGED")
  // A fresh self-consistent digest still cannot claim to review a different
  // operation inventory from the exact input it says was approved.
  const { review_id: _oldDigest, ...fields } = review
  for (const replacement of [
    { retained_operations: { complete: true, items: [] } },
    { retained_catalog_coverage: inventedCoverage },
  ]) {
    const changedFields = { ...fields, ...replacement }
    const changedReview = {
      ...changedFields,
      review_id: `migration-review-${migrationHash(canonicalSharedJson(changedFields))}`,
    }
    expect(
      await f.run(validateSharedMigrationReview(changedReview, changedReview.review_id)),
    ).toEqual(changedReview)
    f.clear()
    expect(
      (
        await f.run(
          Effect.flip(
            applySharedMigration({
              migrationInput: fixture.migrationInput,
              review: changedReview,
              reviewId: changedReview.review_id,
              dryRun: true,
            }),
          ),
        )
      ).code,
    ).toBe("SHARED_MIGRATION_REVIEW_CHANGED")
  }
  expect(f.calls).toHaveLength(0)
  expect(f.writes()).toHaveLength(0)
  expect(f.pending()).toHaveLength(0)
})

test("a new as-of create with an unknown first POST is not replayed by repeated apply or public reconcile", async () => {
  for (const visible of [false, true]) {
    const fixture = await asOfFixture(),
      f = sharedCreateFixture()
    const before = canonicalSharedJson(fixture.migrationInput)
    const review = await f.run(
      reviewSharedMigration({ ...fixture.input, migration_input: fixture.frozen }),
    )
    f.unknown("skill", visible)
    const firstFailure = await f.run(
      Effect.flip(
        applySharedMigration({
          migrationInput: fixture.migrationInput,
          review,
          reviewId: review.review_id,
        }),
      ),
    )
    expect(firstFailure.code).toBe("WRITE_OUTCOME_UNKNOWN")
    const operationId = property(firstFailure.details).native_create_operation_id
    if (typeof operationId !== "string")
      throw new Error("Missing exact original native create operation")
    expect(f.nativeCreates()).toHaveLength(1)
    expect(f.enablePatches()).toHaveLength(0)
    expect(f.pending()).toHaveLength(1)
    f.clear()
    const repeated = await f.run(
      Effect.flip(
        applySharedMigration({
          migrationInput: fixture.migrationInput,
          review,
          reviewId: review.review_id,
        }),
      ),
    )
    expect(repeated.code).toMatch(/^SHARED_(?:CREATE|RECORD)_(?:PENDING|UNRESOLVED)$/u)
    expect(f.writes()).toHaveLength(0)
    const reconciled = await f.run(
      Effect.flip(
        reconcileSharedMigration({ entry: fixture.input.library.skills.database_id, operationId }),
      ),
    )
    expect(reconciled.code).toMatch(/^SHARED_(?:CREATE|RECORD)_UNRESOLVED$/u)
    expect(f.writes()).toHaveLength(0)
    expect(f.nativeCreates()).toHaveLength(0)
    expectOriginalHistory(fixture.migrationInput, before)
  }
})

test("a later visible new-create receipt reconciles only that new operation and does not settle retained legacy history", async () => {
  const fixture = await asOfFixture(),
    f = sharedCreateFixture()
  const before = canonicalSharedJson(fixture.migrationInput)
  const candidate = await f.run(makeSharedMigrationConversion(fixture.input))
  const plan = await f.run(
    prepareSharedMigrationCreate(fixture.input.library, {
      candidate,
      migrationInput: fixture.migrationInput,
    }),
  )
  f.unknown("outcome", true)
  expect(
    (
      await f.run(
        Effect.flip(
          executeSharedCreate(fixture.input.library, {
            plan,
            mode: "create",
            migrationInput: fixture.migrationInput,
          }),
        ),
      )
    ).code,
  ).toBe("WRITE_OUTCOME_UNKNOWN")
  f.clear()
  const reconciled = await f.run(
    reconcileSharedMigration({
      entry: fixture.input.library.skills.database_id,
      operationId: plan.operation_id,
    }),
  )
  expect(reconciled.reused).toBe(true)
  expect(reconciled.verification).toBe("original_create_outcome")
  expect(reconciled.current_snapshot_verified).toBe(false)
  expect(f.writes()).toHaveLength(0)
  expect(f.currentBodies()).toHaveLength(0)
  expectOriginalHistory(fixture.migrationInput, before)
})
