import { expect, test } from "bun:test"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import { makeSharedMigrationCreatePlan } from "../src/shared-create-model.ts"
import { executeSharedCreate, prepareSharedMigrationCreate } from "../src/shared-create.ts"
import {
  makeSharedMigrationConversion,
  retainedMigrationConversionInput,
  reviewSharedMigrationConversion,
  validateRetainedMigrationConversion,
  type MigrationConversionInput,
} from "../src/shared-migration-conversion.ts"
import { planSharedMigration, type SharedMigrationInput } from "../src/shared-migration-plan.ts"
import {
  applySharedMigration,
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

const policy = "copy_to_new_native_v1"
const operationId = "original-copy-boundary-operation"
type Entry = SharedMigrationInput["catalog"]["entries"][number]
type Operation = SharedMigrationInput["preservation"]["operations"]["items"][number]
function copy(
  input: MigrationConversionInput,
): MigrationConversionInput & { readonly execution_policy: typeof policy } {
  return { ...input, execution_policy: policy }
}
function pair() {
  const selected = migrationConversionFixture({ main: "Frozen selected main" })
  const other = migrationConversionFixture({ kind: "prompt", main: "Frozen unrelated main" })
  const frozen: SharedMigrationInput = {
    ...selected.migrationInput,
    approved_legacy_ids: [],
    catalog: {
      ...selected.migrationInput.catalog,
      entries: [
        selected.entry,
        { ...other.entry, metadata_complete: false, files_complete: false, files: [] },
      ],
    },
  }
  return {
    selected,
    other,
    frozen,
    approved: { ...frozen, approved_legacy_ids: [selected.entry.legacy_id] },
  }
}
function originalPage(entry: Entry): string {
  const page = property(property(entry.record).locator).page_id
  if (typeof page !== "string") throw new Error("Expected exact original fixture page")
  return page
}
function operation(page: string): Operation {
  const raw = {
    operation_id: operationId,
    plan_id: "retained-plan",
    subscription_id: "retained-subscription",
    state: "unknown",
    items: [{ member_key: "retained-member", status: "unknown", page_id: page }],
  }
  const payload = JSON.stringify(raw)
  return {
    legacy_id: operationId,
    raw,
    complete: true,
    references: [],
    retention_verified: true,
    retention_ref: "backup:controlled/copy-boundary/original",
    terminal_verified: false,
    operation_origin: {
      version: 1,
      table: "upstream_operations",
      row_key: operationId,
      database_sha256: "a".repeat(64),
      payload_sha256: migrationHash(payload),
      payload_bytes: new TextEncoder().encode(payload).length,
      row_metadata: { operation_id: operationId, plan_id: raw.plan_id, state: raw.state },
      verified: true,
      receipt_ref: "backup:controlled/copy-boundary/sql-origin",
    },
  }
}
function withOperation(input: SharedMigrationInput, value: Operation): SharedMigrationInput {
  return {
    ...input,
    preservation: { ...input.preservation, operations: { complete: true, items: [value] } },
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
          impact: {
            complete: true,
            legacy_ids: affected,
            receipt_ref: "evidence:controlled/impact",
          },
          isolation: {
            verified: true,
            receipt_ref: "evidence:controlled/isolation",
            recovery: { action: "inspect_original", reference: "backup:controlled/original" },
          },
        },
      ],
    },
  }
}

test("new public review binds the explicit copy policy and cannot inherit a digest after its removal", async () => {
  const f = sharedCreateFixture(),
    fixture = pair()
  const review = await f.run(
    reviewSharedMigration({ ...fixture.selected.input, migration_input: fixture.frozen }),
  )
  expect(property(review.origin.candidate).execution_policy).toBe(policy)
  expect(await f.run(validateSharedMigrationReview(review, review.review_id))).toEqual(review)
  const candidate = { ...property(review.origin.candidate) }
  delete candidate.execution_policy
  const removed = { ...review, origin: { ...review.origin, candidate } }
  expect(
    (await f.run(Effect.flip(validateSharedMigrationReview(removed, review.review_id)))).code,
  ).toBe("SHARED_MIGRATION_REVIEW_CHANGED")
  expect(f.writes()).toHaveLength(0)
})

test("approved complete A can prepare, dry-run and directly create beside unrelated incomplete B while the full plan stays blocked", async () => {
  const f = sharedCreateFixture(),
    fixture = pair(),
    before = structuredClone(fixture.approved)
  const full = await f.run(planSharedMigration(fixture.approved))
  expect(full.status).toBe("blocked")
  expect(
    full.readiness.items.find((item) => item.legacy_id === fixture.selected.entry.legacy_id)
      ?.evidence_ready,
  ).toBe(false)
  const review = await f.run(
    reviewSharedMigration({ ...fixture.selected.input, migration_input: fixture.frozen }),
  )
  const dry = await f.run(
    applySharedMigration({
      migrationInput: fixture.approved,
      review,
      reviewId: review.review_id,
      dryRun: true,
    }),
  )
  expect(dry.status).toBe("planned")
  expect(f.writes()).toHaveLength(0)
  const candidate = await f.run(
    makeSharedMigrationConversion(
      retainedMigrationConversionInput(fixture.approved, review.origin.candidate),
    ),
  )
  expect(property(candidate).execution_policy).toBe(policy)
  const plan = await f.run(
    prepareSharedMigrationCreate(fixture.selected.input.library, {
      candidate,
      migrationInput: fixture.approved,
    }),
  )
  const created = await f.run(
    executeSharedCreate(fixture.selected.input.library, {
      plan,
      mode: "create",
      migrationInput: fixture.approved,
    }),
  )
  expect(created.record.id).toBe(candidate.record_id)
  expect(f.nativeCreates()).toHaveLength(2)
  expect(f.enablePatches()).toHaveLength(1)
  expect(first(f.enablePatches()).path).toBe(`v1/pages/${created.skill_page_id}`)
  const originals = fixture.approved.catalog.entries.flatMap((entry) => [
    originalPage(entry),
    ...entry.files
      .map((file) => property(property(file.raw).native_preimage).page_id)
      .filter((value): value is string => typeof value === "string"),
  ])
  expect(f.calls.some((call) => originals.some((page) => call.path.includes(page)))).toBe(false)
  expect(fixture.approved).toEqual(before)
  expect(await f.run(planSharedMigration(fixture.approved))).toEqual(full)
  expect(full.evidence.catalog.entries).toHaveLength(2)
  expect(full.apply_allowed).toBe(false)
})

test("unmarked saved candidates retain their original full-plan gate and exact reconstruction", async () => {
  const f = sharedCreateFixture(),
    fixture = pair()
  const old = await f.run(
    reviewSharedMigrationConversion({
      ...fixture.selected.input,
      migration_input: fixture.approved,
    }),
  )
  expect(Object.hasOwn(old, "execution_policy")).toBe(false)
  expect(await f.run(validateRetainedMigrationConversion(old))).toEqual(old)
  const oldPlan = await f.run(makeSharedMigrationCreatePlan(old))
  expect(
    (
      await f.run(
        Effect.flip(
          prepareSharedMigrationCreate(fixture.selected.input.library, {
            candidate: old,
            migrationInput: fixture.approved,
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_CREATE_BLOCKED")
  expect(
    (
      await f.run(
        Effect.flip(
          executeSharedCreate(fixture.selected.input.library, {
            plan: oldPlan,
            mode: "create",
            migrationInput: fixture.approved,
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_CREATE_BLOCKED")
  const clean = await f.run(makeSharedMigrationConversion(fixture.selected.input))
  expect(Object.hasOwn(clean, "execution_policy")).toBe(false)
  expect(await f.run(validateRetainedMigrationConversion(clean))).toEqual(clean)
  expect(f.calls).toHaveLength(0)
  expect(f.pending()).toHaveLength(0)
})

test("copy policy cannot turn an unapproved review into either preparation or direct execution", async () => {
  const f = sharedCreateFixture(),
    fixture = pair()
  const candidate = await f.run(
    reviewSharedMigrationConversion(
      copy({ ...fixture.selected.input, migration_input: fixture.frozen }),
    ),
  )
  const plan = await f.run(makeSharedMigrationCreatePlan(candidate))
  expect(
    (
      await f.run(
        Effect.flip(
          prepareSharedMigrationCreate(fixture.selected.input.library, {
            candidate,
            migrationInput: fixture.frozen,
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_CREATE_NOT_APPROVED")
  expect(
    (
      await f.run(
        Effect.flip(
          executeSharedCreate(fixture.selected.input.library, {
            plan,
            mode: "create",
            migrationInput: fixture.frozen,
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_CREATE_NOT_APPROVED")
  expect(f.calls).toHaveLength(0)
  expect(f.pending()).toHaveLength(0)
})

test("selected bytes, same-page aliases, actual Source and Router members remain hard copy dependencies", async () => {
  const fixture = pair(),
    following = migrationConversionFixture({ main: "Frozen following main", following: true })
  const router = migrationConversionFixture({ kind: "router", main: "Frozen Router" })
  const cases: readonly MigrationConversionInput[] = [
    {
      ...fixture.selected.input,
      migration_input: {
        ...fixture.approved,
        catalog: {
          ...fixture.approved.catalog,
          entries: [
            {
              ...fixture.selected.entry,
              files: fixture.selected.entry.files.map((file) => ({
                ...file,
                ownership: "unknown",
              })),
            },
            fixture.other.entry,
          ],
        },
      },
    },
    {
      ...fixture.selected.input,
      migration_input: {
        ...fixture.approved,
        catalog: {
          ...fixture.approved.catalog,
          entries: [
            {
              ...fixture.selected.entry,
              files: fixture.selected.entry.files.map(({ body: _body, ...file }) => file),
            },
            fixture.other.entry,
          ],
        },
      },
    },
    {
      ...fixture.selected.input,
      migration_input: {
        ...fixture.approved,
        catalog: {
          ...fixture.approved.catalog,
          entries: [
            fixture.selected.entry,
            {
              ...fixture.other.entry,
              files_complete: false,
              record: {
                ...property(fixture.other.entry.record),
                locator: {
                  type: "notion_page",
                  page_id: originalPage(fixture.selected.entry),
                  database_id: "old-database",
                },
              },
            },
          ],
        },
      },
    },
    {
      ...following.input,
      migration_input: {
        ...following.migrationInput,
        preservation: {
          ...following.migrationInput.preservation,
          sources: { ...following.migrationInput.preservation.sources, complete: false },
        },
      },
    },
    {
      ...router.input,
      migration_input: {
        ...router.migrationInput,
        catalog: {
          ...router.migrationInput.catalog,
          entries: [router.entry, { ...fixture.selected.entry, files_complete: false }],
        },
        preservation: {
          ...router.migrationInput.preservation,
          routers: {
            complete: true,
            items: [
              {
                legacy_id: router.entry.legacy_id,
                complete: true,
                references: [fixture.selected.entry.legacy_id],
                raw: { original: "retained member relation" },
              },
            ],
          },
        },
      },
    },
    {
      ...router.input,
      migration_input: {
        ...router.migrationInput,
        preservation: {
          ...router.migrationInput.preservation,
          routers: {
            complete: true,
            items: [
              {
                legacy_id: router.entry.legacy_id,
                complete: false,
                references: [],
                raw: { published_count: 27, source_count: 28, status: "partial" },
              },
            ],
          },
        },
      },
    },
  ]
  for (const input of cases) {
    const f = sharedCreateFixture()
    expect((await f.run(Effect.flip(makeSharedMigrationConversion(copy(input))))).code).toBe(
      "SHARED_MIGRATION_CREATE_BLOCKED",
    )
    expect(f.calls).toHaveLength(0)
    expect(f.pending()).toHaveLength(0)
  }
})

test("unknown operations and declared disjoint boolean receipts cannot unlock either copy entry point", async () => {
  const fixture = pair(),
    raw = withOperation(fixture.approved, operation(originalPage(fixture.other.entry)))
  const approved = withReceipt(raw, [fixture.other.entry.legacy_id]),
    f = sharedCreateFixture()
  const candidate = await f.run(
    reviewSharedMigrationConversion(copy({ ...fixture.selected.input, migration_input: approved })),
  )
  const plan = await f.run(makeSharedMigrationCreatePlan(candidate))
  for (const migrationInput of [raw, approved]) {
    const expected =
      migrationInput === raw
        ? "SHARED_MIGRATION_CREATE_BLOCKED"
        : "SHARED_MIGRATION_RECEIPT_UNVERIFIED"
    expect(
      (
        await f.run(
          Effect.flip(
            prepareSharedMigrationCreate(fixture.selected.input.library, {
              candidate,
              migrationInput,
            }),
          ),
        )
      ).code,
    ).toBe(expected)
    expect(
      (
        await f.run(
          Effect.flip(
            executeSharedCreate(fixture.selected.input.library, {
              plan,
              mode: "create",
              migrationInput,
            }),
          ),
        )
      ).code,
    ).toBe(expected)
  }
  const frozen = withReceipt({ ...raw, approved_legacy_ids: [] }, [fixture.other.entry.legacy_id])
  const review = await f.run(
    reviewSharedMigration({ ...fixture.selected.input, migration_input: frozen }),
  )
  f.clear()
  for (const dryRun of [true, false])
    expect(
      (
        await f.run(
          Effect.flip(
            applySharedMigration({
              migrationInput: approved,
              review,
              reviewId: review.review_id,
              dryRun,
            }),
          ),
        )
      ).code,
    ).toBe("SHARED_MIGRATION_RECEIPT_UNVERIFIED")
  expect(f.calls).toHaveLength(0)
  expect(f.writes()).toHaveLength(0)
  expect(f.pending()).toHaveLength(0)
  expect(first(approved.preservation.operations.items).raw).toEqual(
    first(raw.preservation.operations.items).raw,
  )
  expect(first(approved.preservation.operations.items).terminal_verified).toBe(false)
})

test("nested integrity creation parent and subscription are known impact even when top-level page and references are absent", async () => {
  const selected = migrationConversionFixture({ kind: "router", main: "Original Router" })
  const other = migrationConversionFixture({ kind: "prompt", main: "Other main" })
  const input: SharedMigrationInput = {
    ...selected.migrationInput,
    catalog: { ...selected.migrationInput.catalog, entries: [selected.entry, other.entry] },
  }
  for (const edge of ["subscription_id", "parent_id"]) {
    const creation = {
      version: 1,
      operation_id: operationId,
      intent_index: 0,
      operation_token: "00000000-0000-4000-8000-000000000901",
      scope: "controlled-original-scope",
      database_id: "00000000-0000-4000-8000-000000000902",
      data_source_id: "00000000-0000-4000-8000-000000000903",
      role: "content_root",
      path: "SKILL.md",
      parent_type: "data_source_id",
      parent_id: "00000000-0000-4000-8000-000000000903",
      intended_hash: "b".repeat(64),
      source_sha256: "c".repeat(64),
      member_key: "original-member",
      [edge]: originalPage(selected.entry),
    }
    const raw = {
      version: 1,
      operation_id: operationId,
      intended_hash: "b".repeat(64),
      marker: {
        version: 2,
        operation_id: operationId,
        intended_hash: "b".repeat(64),
        state: "writing",
        creation,
      },
    }
    const payload = JSON.stringify(raw),
      original: Operation = {
        legacy_id: operationId,
        raw,
        complete: true,
        references: [],
        retention_verified: true,
        retention_ref: "backup:controlled/integrity",
        terminal_verified: false,
        operation_origin: {
          version: 1,
          table: "integrity_operations",
          row_key: operationId,
          database_sha256: "a".repeat(64),
          payload_sha256: migrationHash(payload),
          payload_bytes: new TextEncoder().encode(payload).length,
          verified: true,
          receipt_ref: "backup:controlled/integrity-origin",
          row_metadata: {
            operation_id: operationId,
            publication_operation_id: operationId,
            intended_hash: "b".repeat(64),
            state: "writing",
            page_id: null,
          },
        },
      }
    const frozen = withReceipt(withOperation(input, original), [other.entry.legacy_id])
    const f = sharedCreateFixture(),
      full = await f.run(planSharedMigration(frozen))
    expect(first(full.readiness.operations).known_legacy_ids).toContain(selected.entry.legacy_id)
    expect(first(full.readiness.operations).impact_scope).toBe("unknown")
    expect(first(full.readiness.operations).issues).toContain(
      "OPERATION_IMPACT_CONTRADICTS_ORIGINAL",
    )
    expect(first(full.evidence.preservation.operations.items).raw).toEqual(raw)
    expect(
      (
        await f.run(
          Effect.flip(
            makeSharedMigrationConversion(copy({ ...selected.input, migration_input: frozen })),
          ),
        )
      ).code,
    ).toBe("SHARED_MIGRATION_CREATE_BLOCKED")
    expect(f.calls).toHaveLength(0)
  }
})
