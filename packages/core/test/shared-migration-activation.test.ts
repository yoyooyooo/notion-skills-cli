import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Crypto, Effect } from "effect"
import { aliasFor, property } from "../src/model.ts"
import {
  makeSharedMigrationConversion,
  validateRetainedMigrationConversion,
  validateSharedMigrationConversion,
} from "../src/shared-migration-conversion.ts"
import { applySharedMigration, reviewSharedMigration } from "../src/shared-migration-review.ts"
import { sharedCreateFixture } from "./shared-create-fixture.ts"
import { migrationConversionFixture, migrationHash } from "./shared-migration-conversion-fixture.ts"
import { id } from "./shared-snapshot-fixture.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))
const retained = (value: unknown, name: string) => {
  const json = JSON.stringify(value, null, 2) + "\n"
  return {
    json,
    sha256: migrationHash(json),
    bytes: new TextEncoder().encode(json).length,
    retention_ref: `backup:activity/${name}.json`,
  }
}
function activeFixture(kind: "skill" | "prompt" = "skill") {
  const original = migrationConversionFixture({ kind, main: "Retained active page" })
  const { enabled: _enabled, ...old } = property(original.entry.record)
  const locator = {
    type: "notion_page",
    page_id: String(property(old.locator).page_id),
    database_id: id(900),
    data_source_id: id(901),
  }
  const record: Record<string, unknown> = {
    ...old,
    locator,
    alias: aliasFor(String(old.name)),
    ref: `skill://${locator.page_id}/${old.entrypoint}`,
  }
  const rich = (key: string, value: unknown) => ({
    id: key,
    type: "rich_text",
    rich_text: [{ plain_text: String(value), type: "text", text: { content: String(value) } }],
  })
  const row = {
    object: "page",
    id: locator.page_id,
    archived: false,
    in_trash: false,
    parent: {
      type: "data_source_id",
      database_id: locator.database_id,
      data_source_id: locator.data_source_id,
    },
    properties: {
      Name: { id: "title", type: "title", title: [{ plain_text: String(record.name) }] },
      Description: rich("description", record.description),
      Kind: { id: "kind", type: "select", select: { name: record.kind } },
      "Default Context": { id: "default", type: "checkbox", checkbox: record.default_context },
    },
  }
  const schema = {
    object: "data_source",
    id: locator.data_source_id,
    parent: { type: "database_id", database_id: locator.database_id },
    properties: Object.fromEntries(
      Object.entries(row.properties).map(([name, field]) => [
        name,
        { name, id: field.id, type: field.type },
      ]),
    ),
  }
  const activity = {
    version: 1 as const,
    policy: "legacy_catalog_active_page_v1" as const,
    catalog_row: retained(row, "row"),
    data_source_schema: retained(schema, "schema"),
  }
  const entry = {
    ...original.entry,
    record,
    metadata: { ...property(original.entry.metadata), legacy_catalog_activity: activity },
  }
  const migrationInput = {
    ...original.migrationInput,
    catalog: { ...original.migrationInput.catalog, entries: [entry] },
  }
  return {
    ...original,
    row,
    schema,
    activity,
    entry,
    migrationInput,
    input: { ...original.input, migration_input: migrationInput },
  }
}
function changedEvidence(
  fixture: ReturnType<typeof activeFixture>,
  row: unknown,
  schema: unknown = fixture.schema,
) {
  const activity = {
    ...fixture.activity,
    catalog_row: retained(row, "row"),
    data_source_schema: retained(schema, "schema"),
  }
  const entry = {
    ...fixture.entry,
    metadata: { ...fixture.entry.metadata, legacy_catalog_activity: activity },
  }
  return {
    ...fixture.input,
    migration_input: {
      ...fixture.migrationInput,
      catalog: { ...fixture.migrationInput.catalog, entries: [entry] },
    },
  }
}

// Retain the observed 2026 page shape (21 complete properties, no archived or
// Enabled, ordinary data-source parent) without production IDs or content.
function versionedPageFixture() {
  const fixture = activeFixture()
  const { archived: _archived, properties: before, ...page } = fixture.row
  const { Name, ...properties } = before
  const rich = (id: string, value = "") => ({
    id,
    type: "rich_text",
    rich_text: [{ plain_text: value }],
  })
  const extra = {
    "Builtin ID": rich("builtin"),
    "Created by": {
      id: "created",
      type: "created_by",
      created_by: { object: "user", id: id(902) },
    },
    Files: { id: "files", type: "files", files: [] },
    "Fork Baseline": rich("fork"),
    Members: { id: "members", type: "relation", relation: [], has_more: false },
    Publication: rich("publication", JSON.stringify({ version: 2, state: "committed" })),
    "Published Hash": rich("hash"),
    References: rich("references"),
    Scope: rich("scope"),
    "Source Type": { id: "source", type: "select", select: null },
    Status: { id: "status", type: "select", select: null },
    "Sync Mode": { id: "sync", type: "select", select: { name: "tracked" } },
    Tags: { id: "tags", type: "multi_select", multi_select: [] },
    Updated: {
      id: "updated",
      type: "last_edited_time",
      last_edited_time: "2026-10-27T08:26:00.000Z",
    },
    Upstream: { id: "upstream", type: "relation", relation: [{ id: id(903) }], has_more: false },
    "Upstream Key": rich("key", "example"),
    "Upstream Revision": rich("revision", "a".repeat(40)),
  }
  const row = {
    ...page,
    is_archived: false,
    properties: { ...properties, "Skill name": Name, ...extra },
  }
  const schema = {
    ...fixture.schema,
    properties: Object.fromEntries(
      Object.entries(row.properties).map(([name, field]) => [
        name,
        { name, id: field.id, type: field.type },
      ]),
    ),
  }
  const activity = {
    version: 2 as const,
    policy: "legacy_catalog_active_page_v2" as const,
    api_version: "2026-03-11" as const,
    catalog_row: retained(row, "row-2026"),
    data_source_schema: retained(schema, "schema-2026"),
  }
  const entry = {
    ...fixture.entry,
    metadata: { ...fixture.entry.metadata, legacy_catalog_activity: activity },
  }
  const migrationInput = {
    ...fixture.migrationInput,
    catalog: { ...fixture.migrationInput.catalog, entries: [entry] },
  }
  return {
    ...fixture,
    row,
    schema,
    activity,
    entry,
    migrationInput,
    input: { ...fixture.input, migration_input: migrationInput },
  }
}

function withVersionedRow(
  fixture: ReturnType<typeof versionedPageFixture>,
  row: unknown,
  fields: Record<string, unknown> = {},
) {
  const activity = { ...fixture.activity, ...fields, catalog_row: retained(row, "row-2026") }
  const entry = {
    ...fixture.entry,
    metadata: { ...fixture.entry.metadata, legacy_catalog_activity: activity },
  }
  return {
    ...fixture.input,
    migration_input: {
      ...fixture.migrationInput,
      catalog: { ...fixture.migrationInput.catalog, entries: [entry] },
    },
  }
}

test("legacy ordinary Skill and Prompt activity is explicit in the new policy while the original Enabled absence remains intact", async () => {
  for (const kind of ["skill", "prompt"] as const) {
    const fixture = activeFixture(kind),
      before = structuredClone(fixture.input)
    const candidate = await run(makeSharedMigrationConversion(fixture.input))
    expect(candidate.conversion_policy).toBe("legacy_page_to_native_v2")
    expect(candidate.activation).toMatchObject({
      policy: "legacy_catalog_active_page_v1",
      enabled: true,
      original_enabled: "absent",
      page_id: fixture.row.id,
    })
    expect(candidate.metadata.enabled).toBe(true)
    expect(Object.hasOwn(property(property(candidate.legacy_entry).record), "enabled")).toBe(false)
    expect(Object.hasOwn(fixture.row.properties, "Enabled")).toBe(false)
    expect(Object.hasOwn(fixture.schema.properties, "Enabled")).toBe(false)
    expect(await run(validateSharedMigrationConversion(fixture.migrationInput, candidate))).toEqual(
      candidate,
    )
    expect(await run(validateRetainedMigrationConversion(candidate))).toEqual(candidate)
    expect(fixture.input).toEqual(before)
  }
})

test("archive, trash and missing activity facts cannot inherit old catalog eligibility", async () => {
  const fixture = activeFixture()
  const { archived: _archived, ...withoutArchive } = fixture.row
  for (const row of [
    { ...fixture.row, archived: true },
    { ...fixture.row, in_trash: true },
    { ...fixture.row, is_archived: true },
    withoutArchive,
  ])
    expect(
      (await run(Effect.flip(makeSharedMigrationConversion(changedEvidence(fixture, row))))).code,
    ).toBe("SHARED_MIGRATION_ACTIVATION_INVALID")
})

test("a filtered schema, explicit switch or changed original record cannot prove the absent-switch protocol", async () => {
  const fixture = activeFixture()
  const { Description: _description, ...filtered } = fixture.schema.properties
  const enabled = { id: "enabled", type: "checkbox", checkbox: false }
  const withSwitch = {
    ...fixture.schema,
    properties: {
      ...fixture.schema.properties,
      Enabled: { name: "Enabled", id: "enabled", type: "checkbox" },
    },
  }
  for (const input of [
    changedEvidence(fixture, fixture.row, { ...fixture.schema, properties: filtered }),
    changedEvidence(
      fixture,
      { ...fixture.row, properties: { ...fixture.row.properties, Enabled: enabled } },
      withSwitch,
    ),
    changedEvidence(fixture, {
      ...fixture.row,
      properties: {
        ...fixture.row.properties,
        Name: { ...fixture.row.properties.Name, title: [{ plain_text: "Different row" }] },
      },
    }),
  ])
    expect((await run(Effect.flip(makeSharedMigrationConversion(input)))).code).toBe(
      "SHARED_MIGRATION_ACTIVATION_INVALID",
    )
})

test("activity evidence binds the exact original page, parent, schema property IDs and retained bytes", async () => {
  const fixture = activeFixture()
  for (const input of [
    changedEvidence(fixture, { ...fixture.row, id: id(999) }),
    changedEvidence(fixture, {
      ...fixture.row,
      parent: { ...fixture.row.parent, data_source_id: id(999) },
    }),
    changedEvidence(fixture, fixture.row, { ...fixture.schema, id: id(999) }),
    changedEvidence(fixture, fixture.row, {
      ...fixture.schema,
      parent: { ...fixture.schema.parent, type: "page_id" },
    }),
    changedEvidence(fixture, fixture.row, {
      ...fixture.schema,
      properties: {
        ...fixture.schema.properties,
        Name: { name: "Name", id: "foreign-title", type: "title" },
      },
    }),
  ])
    expect((await run(Effect.flip(makeSharedMigrationConversion(input)))).code).toBe(
      "SHARED_MIGRATION_ACTIVATION_INVALID",
    )
  const entry = {
    ...fixture.entry,
    metadata: {
      ...fixture.entry.metadata,
      legacy_catalog_activity: {
        ...fixture.activity,
        catalog_row: {
          ...fixture.activity.catalog_row,
          json: fixture.activity.catalog_row.json + " ",
        },
      },
    },
  }
  expect(
    (
      await run(
        Effect.flip(
          makeSharedMigrationConversion({
            ...fixture.input,
            migration_input: {
              ...fixture.migrationInput,
              catalog: { ...fixture.migrationInput.catalog, entries: [entry] },
            },
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_ACTIVATION_INVALID")
})

test("the absent-switch mapping cannot enable an explicit false value or reinterpret a Router", async () => {
  const fixture = activeFixture()
  for (const enabled of [false, null, "true"]) {
    const entry = { ...fixture.entry, record: { ...fixture.entry.record, enabled } }
    const input = {
      ...fixture.input,
      migration_input: {
        ...fixture.migrationInput,
        catalog: { ...fixture.migrationInput.catalog, entries: [entry] },
      },
    }
    expect((await run(Effect.flip(makeSharedMigrationConversion(input)))).code).toBe(
      "SHARED_MIGRATION_CONVERSION_ENABLED_UNSUPPORTED",
    )
  }
  const router = migrationConversionFixture({ kind: "router", main: "Router body" })
  const { enabled: _enabled, ...record } = property(router.entry.record)
  const entry = {
    ...router.entry,
    record,
    metadata: { ...property(router.entry.metadata), legacy_catalog_activity: fixture.activity },
  }
  const input = {
    ...router.input,
    migration_input: {
      ...router.migrationInput,
      catalog: { ...router.migrationInput.catalog, entries: [entry] },
      preservation: {
        ...router.migrationInput.preservation,
        routers: {
          complete: true,
          items: [{ legacy_id: entry.legacy_id, raw: {}, complete: true, references: [] }],
        },
      },
    },
  }
  expect((await run(Effect.flip(makeSharedMigrationConversion(input)))).code).toBe(
    "SHARED_MIGRATION_ACTIVATION_INVALID",
  )
})

test("saved v1 conversion rules remain strict and the new derived activity cannot be tampered with", async () => {
  const original = migrationConversionFixture({ main: "Explicitly enabled before migration" })
  const old = await run(makeSharedMigrationConversion(original.input))
  expect(old.conversion_policy).toBe("legacy_page_to_native_v1")
  expect(Object.hasOwn(old, "activation")).toBe(false)
  expect(await run(validateRetainedMigrationConversion(old))).toEqual(old)
  const fixture = activeFixture(),
    candidate = await run(makeSharedMigrationConversion(fixture.input))
  const { activation: _activation, ...fields } = candidate
  expect(
    (
      await run(
        Effect.flip(
          validateRetainedMigrationConversion({
            ...fields,
            conversion_policy: "legacy_page_to_native_v1",
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_CONVERSION_ENABLED_UNSUPPORTED")
  expect(
    (
      await run(
        Effect.flip(
          validateRetainedMigrationConversion({
            ...candidate,
            activation: { ...candidate.activation, data_source_id: id(999) },
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_ACTIVATION_INVALID")
})

test("public review shows the new activity policy and its complete original evidence remains approval-bound", async () => {
  const f = sharedCreateFixture(),
    fixture = activeFixture()
  const frozen = { ...fixture.migrationInput, approved_legacy_ids: [] }
  const review = await f.run(reviewSharedMigration({ ...fixture.input, migration_input: frozen }))
  expect(review.origin.candidate.activation?.original_enabled).toBe("absent")
  expect(review.origin.candidate.conversion_policy).toBe("legacy_page_to_native_v2")
  expect(
    Object.hasOwn(property(property(review.origin.candidate.legacy_entry).record), "enabled"),
  ).toBe(false)
  f.clear()
  const changed = changedEvidence(fixture, {
    ...fixture.row,
    last_edited_time: "2030-01-01T00:00:00.000Z",
  })
  expect(
    (
      await f.run(
        Effect.flip(
          applySharedMigration({
            migrationInput: changed.migration_input,
            review,
            reviewId: review.review_id,
            dryRun: true,
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_REVIEW_CHANGED")
  expect(f.calls).toHaveLength(0)
  expect(f.writes()).toHaveLength(0)
  const result = await f.run(
    applySharedMigration({
      migrationInput: fixture.migrationInput,
      review,
      reviewId: review.review_id,
    }),
  )
  expect(result.status).toBe("created")
  expect(result.verified).toBe(true)
  expect(f.nativeCreates()).toHaveLength(2)
})

test("activity v2 preserves the actual 2026 complete row shape and freezes its API interpretation", async () => {
  const fixture = versionedPageFixture(),
    before = structuredClone(fixture.input)
  expect(Object.keys(fixture.row.properties)).toHaveLength(21)
  expect(Object.hasOwn(fixture.row, "archived")).toBe(false)
  const candidate = await run(makeSharedMigrationConversion(fixture.input))
  expect(candidate.activation).toMatchObject({
    policy: "legacy_catalog_active_page_v2",
    api_version: "2026-03-11",
    original_enabled: "absent",
    enabled: true,
  })
  expect(await run(validateRetainedMigrationConversion(candidate))).toEqual(candidate)
  expect(fixture.input).toEqual(before)
  expect(property(property(candidate.legacy_entry).metadata).legacy_catalog_activity).toEqual(
    fixture.activity,
  )
  // The version-specific public contract needs in_trash. is_archived is retained
  // and checked when supplied; it is not a substitute for the documented field.
  const { is_archived: _isArchived, ...documentedRow } = fixture.row
  expect(
    (await run(makeSharedMigrationConversion(withVersionedRow(fixture, documentedRow)))).activation,
  ).toMatchObject({ policy: "legacy_catalog_active_page_v2" })
})

test("activity v2 rejects missing trash facts, conflicting aliases and a changed API contract", async () => {
  const fixture = versionedPageFixture()
  const { in_trash: _inTrash, ...withoutTrash } = fixture.row
  for (const row of [
    withoutTrash,
    { ...fixture.row, in_trash: true },
    { ...fixture.row, archived: true },
    { ...fixture.row, is_archived: true },
    { ...fixture.row, is_archived: null },
  ])
    expect(
      (await run(Effect.flip(makeSharedMigrationConversion(withVersionedRow(fixture, row))))).code,
    ).toBe("SHARED_MIGRATION_ACTIVATION_INVALID")
  expect(
    (
      await run(
        Effect.flip(
          makeSharedMigrationConversion(
            withVersionedRow(fixture, fixture.row, { api_version: "2025-09-03" }),
          ),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_ACTIVATION_INVALID")
  const { api_version: _apiVersion, ...missingApiActivity } = fixture.activity
  const missingApiEntry = {
    ...fixture.entry,
    metadata: { ...fixture.entry.metadata, legacy_catalog_activity: missingApiActivity },
  }
  const missingApiInput = {
    ...fixture.input,
    migration_input: {
      ...fixture.migrationInput,
      catalog: { ...fixture.migrationInput.catalog, entries: [missingApiEntry] },
    },
  }
  expect((await run(Effect.flip(makeSharedMigrationConversion(missingApiInput)))).code).toBe(
    "SHARED_MIGRATION_ACTIVATION_INVALID",
  )
  expect(
    (
      await run(
        Effect.flip(
          makeSharedMigrationConversion(
            withVersionedRow(fixture, fixture.row, { api_version: undefined }),
          ),
        ),
      )
    ).code,
  ).toBe("INVALID_SHARED_RECORD")
})

test("saved activity v1 is not reinterpreted as v2 and v2 review binds the original API evidence", async () => {
  const fixture = versionedPageFixture()
  const oldActivity = {
    version: 1 as const,
    policy: "legacy_catalog_active_page_v1" as const,
    catalog_row: fixture.activity.catalog_row,
    data_source_schema: fixture.activity.data_source_schema,
  }
  const oldEntry = {
    ...fixture.entry,
    metadata: { ...fixture.entry.metadata, legacy_catalog_activity: oldActivity },
  }
  const oldInput = {
    ...fixture.input,
    migration_input: {
      ...fixture.migrationInput,
      catalog: { ...fixture.migrationInput.catalog, entries: [oldEntry] },
    },
  }
  expect((await run(Effect.flip(makeSharedMigrationConversion(oldInput)))).code).toBe(
    "SHARED_MIGRATION_ACTIVATION_INVALID",
  )
  const f = sharedCreateFixture()
  const review = await f.run(
    reviewSharedMigration({
      ...fixture.input,
      migration_input: { ...fixture.migrationInput, approved_legacy_ids: [] },
    }),
  )
  expect(review.origin.candidate.activation).toMatchObject({
    policy: "legacy_catalog_active_page_v2",
    api_version: "2026-03-11",
  })
  f.clear()
  const altered = withVersionedRow(fixture, { ...fixture.row, archived: false })
  expect(
    (
      await f.run(
        Effect.flip(
          applySharedMigration({
            migrationInput: altered.migration_input,
            review,
            reviewId: review.review_id,
            dryRun: true,
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_REVIEW_CHANGED")
  expect(f.calls).toHaveLength(0)
  expect(f.writes()).toHaveLength(0)
})
