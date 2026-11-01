import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { authScope } from "../src/catalog.ts"
import { property } from "../src/model.ts"
import { SharedAuthoringEvidenceSchema } from "../src/shared-authoring.ts"
import { makeSharedMigrationConversion } from "../src/shared-migration-conversion.ts"
import { makeSharedMigrationCreatePlan } from "../src/shared-create-model.ts"
import {
  createSharedMigrationNative,
  executeSharedCreate,
  loadPendingSharedCreates,
  loadSharedCreatePlan,
  prepareSharedMigrationCreate,
  reconcileSharedCreate,
} from "../src/shared-create.ts"
import { verifySharedCreatedSnapshot } from "../src/shared-create-verification.ts"
import { querySharedOperationIndex } from "../src/shared-operation-index.ts"
import { querySharedSkillIndex } from "../src/shared-skill-index.ts"
import { openSharedSnapshot } from "../src/shared-snapshot.ts"
import { createLibrary, sharedCreateFixture } from "./shared-create-fixture.ts"
import { id } from "./shared-snapshot-fixture.ts"
import { first, migrationConversionFixture } from "./shared-migration-conversion-fixture.ts"

test("migration origin shares the native create sequence, keeps stable IDs, and reconstructs without write authority", async () => {
  const f = sharedCreateFixture({
    readback: (wire) => {
      if (wire === "<h1>Migration heading</h1>\n\nUse `code`.")
        return "# Migration heading\n\nUse <code>code</code>."
      if (wire === "Retained notes") return wire
      throw new Error("Unexpected controlled native conversion wire")
    },
  })
  const fixture = migrationConversionFixture()
  const candidate = await f.run(makeSharedMigrationConversion(fixture.input))
  const plan = await f.run(
    prepareSharedMigrationCreate(createLibrary, {
      candidate,
      migrationInput: fixture.migrationInput,
    }),
  )
  const created = await f.run(
    executeSharedCreate(createLibrary, {
      plan,
      mode: "create",
      migrationInput: fixture.migrationInput,
    }),
  )
  expect(created.record.id).toBe(candidate.record_id)
  expect(created.skill_id).toBe(candidate.skill_id)
  expect(created.expected_files.map((file) => file.file_id)).toEqual(
    candidate.files.map((file) => file.file_id),
  )
  expect(f.nativeCreates()).toHaveLength(2)
  expect(f.enablePatches()).toHaveLength(1)
  expect(f.enablePatches()[0]?.path).toBe(`v1/pages/${created.skill_page_id}`)
  expect(
    f.calls.some(
      (call) =>
        call.path.includes("00000000-0000-4000-8000-000000000100") ||
        call.path.includes("00000000-0000-4000-8000-000000000101"),
    ),
  ).toBe(false)
  f.credential("another-authorized-migration-reader")
  f.clear()
  const loaded = await f.run(
    loadSharedCreatePlan(createLibrary, {
      skillPageId: created.skill_page_id,
      operationId: plan.operation_id,
    }),
  )
  expect(loaded).toEqual(plan)
  const reused = await f.run(reconcileSharedCreate(createLibrary, loaded))
  expect(reused.reused).toBe(true)
  expect(f.writes()).toHaveLength(0)
  expect(f.currentBodies()).toHaveLength(0)
  expect(
    (await f.run(Effect.flip(executeSharedCreate(createLibrary, { plan: loaded, mode: "create" }))))
      .code,
  ).toBe("SHARED_MIGRATION_INPUT_REQUIRED")
  expect(f.writes()).toHaveLength(0)
})

test("following migration registers exact Source and projected facts while custom files retain independent ownership", async () => {
  const f = sharedCreateFixture(),
    fixture = migrationConversionFixture({
      main: "Retained main",
      following: true,
      sourceMain:
        "---\nname: Migrated fixture\ndescription: Preserved description\nmetadata:\n  original: keep\n---\n\nRetained main",
    })
  const candidate = await f.run(makeSharedMigrationConversion(fixture.input))
  const plan = await f.run(
    prepareSharedMigrationCreate(createLibrary, {
      candidate,
      migrationInput: fixture.migrationInput,
    }),
  )
  const created = await f.run(
    executeSharedCreate(createLibrary, {
      plan,
      mode: "create",
      migrationInput: fixture.migrationInput,
    }),
  )
  const index = await f.run(querySharedSkillIndex(createLibrary, created.skill_page_id))
  if (!candidate.source) throw new Error("Expected the controlled following Source")
  expect(index.source_reference).toBe(candidate.source.source_id)
  expect(first(candidate.source_files.filter((file) => file.path === "SKILL.md")).sha256).not.toBe(
    first(candidate.files).content.sha256,
  )
  expect(index.main.baseline).toEqual({
    normalization_version: 1,
    sha256: first(candidate.files).content.sha256,
    source_revision: "1".repeat(40),
  })
  expect(first(index.files).display_status).toBe("custom")
  expect(first(index.files).baseline).toBeUndefined()
  expect(f.nativeCreates()).toHaveLength(2)
  f.clear()
  const events = plan.files.map((file) => file.event)
  expect(
    await f.run(
      loadPendingSharedCreates(createLibrary, { skillPageId: created.skill_page_id, events }),
    ),
  ).toEqual([])
  expect(f.calls.some((call) => call.content === "body")).toBe(false)
  expect(f.writes()).toHaveLength(0)
  const headers = await f.run(querySharedOperationIndex(createLibrary, created.skill_page_id))
  expect(
    (
      await f.run(
        Effect.flip(
          loadPendingSharedCreates(createLibrary, {
            skillPageId: created.skill_page_id,
            events,
            headers: headers.map((header) =>
              header.record_id === plan.operation_id ? { ...header, hash: "0".repeat(64) } : header,
            ),
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_CREATE_INVALID")
  const source = candidate.source
  if (source === null) throw new Error("Missing controlled selected Source")
  const snapshot = await f.run(
    openSharedSnapshot({
      library: createLibrary,
      target: created.skill_page_id,
      scope: await f.run(authScope),
      startedAt: Date.now(),
      fixedSource: {
        source_id: source.source_id,
        revision: source.commit,
        files: fixture.input.source_files ?? [],
      },
    }),
  )
  expect(snapshot.files.map((file) => file.path).sort()).toEqual([
    "SKILL.md",
    "assets/original.bin",
    "notes.md",
  ])
  expect(() => verifySharedCreatedSnapshot(snapshot, created)).not.toThrow()
  const evidence = Schema.decodeUnknownSync(SharedAuthoringEvidenceSchema)(
    property(snapshot).shared_authoring,
  )
  const changedSource = {
    ...snapshot,
    shared_authoring: { ...evidence, source_id: "source-foreign" },
  }
  const changedRevision = {
    ...snapshot,
    shared_authoring: { ...evidence, source_revision: "9".repeat(40) },
  }
  const changedHeads = {
    ...snapshot,
    shared_authoring: {
      ...evidence,
      files: evidence.files.map((file) => ({ ...file, heads: ["later-equal-body-event"] })),
    },
  }
  expect(() => verifySharedCreatedSnapshot(changedSource, created)).toThrow()
  expect(() => verifySharedCreatedSnapshot(changedRevision, created)).toThrow()
  expect(() => verifySharedCreatedSnapshot(changedHeads, created)).toThrow()
})

test("retained or unapproved candidates fail before any new native mutation", async () => {
  const f = sharedCreateFixture(),
    fixture = migrationConversionFixture({ main: "Retained main" })
  const candidate = await f.run(makeSharedMigrationConversion(fixture.input)),
    plan = await f.run(makeSharedMigrationCreatePlan(candidate))
  expect(
    (await f.run(Effect.flip(executeSharedCreate(createLibrary, { plan, mode: "create" })))).code,
  ).toBe("SHARED_MIGRATION_INPUT_REQUIRED")
  expect(
    (
      await f.run(
        Effect.flip(
          createSharedMigrationNative(createLibrary, {
            candidate,
            migrationInput: { ...fixture.migrationInput, approved_legacy_ids: [] },
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_CREATE_NOT_APPROVED")
  expect(f.calls).toHaveLength(0)
  expect(f.writes()).toHaveLength(0)
  expect(f.pending()).toHaveLength(0)
  const dry = await f.run(
    createSharedMigrationNative(createLibrary, {
      candidate,
      migrationInput: fixture.migrationInput,
      dryRun: true,
    }),
  )
  expect(dry.status).toBe("planned")
  expect(f.writes()).toHaveLength(0)
})

test("an uncertain first create is never dispatched again for the migration origin", async () => {
  for (const visible of [false, true]) {
    const f = sharedCreateFixture(),
      fixture = migrationConversionFixture({ main: "Retained main" })
    const candidate = await f.run(makeSharedMigrationConversion(fixture.input))
    const plan = await f.run(
      prepareSharedMigrationCreate(createLibrary, {
        candidate,
        migrationInput: fixture.migrationInput,
      }),
    )
    f.unknown("skill", visible)
    expect(
      (
        await f.run(
          Effect.flip(
            executeSharedCreate(createLibrary, {
              plan,
              mode: "create",
              migrationInput: fixture.migrationInput,
            }),
          ),
        )
      ).code,
    ).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(f.nativeCreates()).toHaveLength(1)
    expect(f.pending()).toHaveLength(1)
    f.clear()
    const failure = await f.run(
      Effect.flip(
        executeSharedCreate(createLibrary, {
          plan,
          mode: "create",
          migrationInput: fixture.migrationInput,
        }),
      ),
    )
    expect(failure.code).toMatch(/^SHARED_(?:CREATE|RECORD)_UNRESOLVED$/u)
    expect(f.writes()).toHaveLength(0)
    expect(f.currentBodies()).toHaveLength(0)
  }
})

test("a visible original migration outcome can be reconciled without repeating Source or page writes", async () => {
  const f = sharedCreateFixture(),
    fixture = migrationConversionFixture({ main: "Retained main", following: true })
  const candidate = await f.run(makeSharedMigrationConversion(fixture.input))
  const plan = await f.run(
    prepareSharedMigrationCreate(createLibrary, {
      candidate,
      migrationInput: fixture.migrationInput,
    }),
  )
  f.unknown("outcome", true)
  expect(
    (
      await f.run(
        Effect.flip(
          executeSharedCreate(createLibrary, {
            plan,
            mode: "create",
            migrationInput: fixture.migrationInput,
          }),
        ),
      )
    ).code,
  ).toBe("WRITE_OUTCOME_UNKNOWN")
  f.clear()
  const reused = await f.run(reconcileSharedCreate(createLibrary, plan))
  expect(reused.reused).toBe(true)
  expect(f.writes()).toHaveLength(0)
  expect(f.currentBodies()).toHaveLength(0)
})

test("renaming the same legacy object cannot bypass its invisible original create journal", async () => {
  const f = sharedCreateFixture(),
    fixture = migrationConversionFixture({ main: "Retained main" })
  const candidate = await f.run(makeSharedMigrationConversion(fixture.input))
  const plan = await f.run(
    prepareSharedMigrationCreate(createLibrary, {
      candidate,
      migrationInput: fixture.migrationInput,
    }),
  )
  f.unknown("skill", false)
  expect(
    (
      await f.run(
        Effect.flip(
          executeSharedCreate(createLibrary, {
            plan,
            mode: "create",
            migrationInput: fixture.migrationInput,
          }),
        ),
      )
    ).code,
  ).toBe("WRITE_OUTCOME_UNKNOWN")
  expect(f.nativeCreates()).toHaveLength(1)
  const renamedInput = {
    ...fixture.migrationInput,
    catalog: {
      ...fixture.migrationInput.catalog,
      entries: [
        {
          ...fixture.entry,
          record: { ...property(fixture.entry.record), name: "Renamed migration fixture" },
        },
      ],
    },
  }
  const renamed = await f.run(
    makeSharedMigrationConversion({ ...fixture.input, migration_input: renamedInput }),
  )
  expect(renamed.skill_id).toBe(candidate.skill_id)
  expect(renamed.candidate_id).not.toBe(candidate.candidate_id)
  expect(
    (
      await f.run(
        Effect.flip(
          createSharedMigrationNative(createLibrary, {
            candidate: renamed,
            migrationInput: renamedInput,
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_CREATE_PENDING")
  expect(f.nativeCreates()).toHaveLength(1)
  expect(f.pending()).toHaveLength(1)
})

test("Router migration requires exact actual migrated member pages and never substitutes old relation UUIDs", async () => {
  const f = sharedCreateFixture(),
    member = migrationConversionFixture({ main: "Member body" }),
    router = migrationConversionFixture({ kind: "router", main: "Router body" })
  const migrationInput = {
    ...router.migrationInput,
    approved_legacy_ids: [member.entry.legacy_id, router.entry.legacy_id],
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
  const candidate = await f.run(
    makeSharedMigrationConversion({ ...router.input, migration_input: migrationInput }),
  )
  expect(
    (
      await f.run(
        Effect.flip(prepareSharedMigrationCreate(createLibrary, { candidate, migrationInput })),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_MEMBERS_UNBOUND")
  expect(f.writes()).toHaveLength(0)
  const mapping = first(candidate.member_bindings),
    newMemberPage = id(700)
  f.seedSkill(newMemberPage, mapping.skill_id, "Exact migrated member")
  const plan = await f.run(
    prepareSharedMigrationCreate(createLibrary, { candidate, migrationInput }),
  )
  expect(plan.members).toEqual([newMemberPage])
  expect(plan.members).not.toContain(property(property(member.entry.record).locator).page_id)
  const created = await f.run(
    executeSharedCreate(createLibrary, { plan, mode: "create", migrationInput }),
  )
  expect(created.record.kind).toBe("router")
  expect(created.expected_metadata.members).toEqual([newMemberPage])
  expect(f.nativeCreates()).toHaveLength(2)
})
