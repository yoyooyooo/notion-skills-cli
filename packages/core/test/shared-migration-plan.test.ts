import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { property } from "../src/model.ts"
import { planSharedMigration, type SharedMigrationInput } from "../src/shared-migration-plan.ts"

const bodyHash = "a".repeat(64)
const otherHash = "b".repeat(64)
type Entry = SharedMigrationInput["catalog"]["entries"][number]
type File = Entry["files"][number]
type Inventory = SharedMigrationInput["preservation"]["sources"]

function first<A>(values: readonly A[]): A {
  const value = values[0]
  if (value === undefined) throw new Error("Expected a fixture item")
  return value
}
function entry(id = "notion-page:legacy-a"): Entry {
  return {
    legacy_id: id,
    record: {
      id,
      kind: "skill",
      name: "Original name",
      description: "Catalog summary",
      locator: { type: "notion_page", page_id: "legacy-page-a", database_id: "legacy-database" },
      ref: "notion://legacy-page-a",
      entrypoint: "SKILL.md",
      default_context: ["original-context"],
      old_extra: { relation: ["unported-value"], editable: true },
    },
    metadata: {
      name: "Original name",
      description: "Actual metadata",
      labels: ["keep"],
      unknown_field: { original: true },
    },
    metadata_complete: true,
    files_complete: true,
    legacy_mode: "native",
    legacy_layout: "ordinary_page",
    files: [
      {
        legacy_id: "old-main-file",
        path: "SKILL.md",
        ownership: "native",
        body: {
          complete: true,
          sha256: bodyHash,
          bytes: 19,
          retention_ref: "backup:fixture/objects/a",
          retention_verified: true,
          normalization_version: 1,
        },
        raw: {
          old_page_id: "legacy-page-a",
          references_path: "References/SKILL.md",
          extra: [1, 2],
        },
      },
    ],
  }
}
function input(entries: readonly Entry[] = [entry()]): SharedMigrationInput {
  const empty = (): Inventory => ({ complete: true, items: [] })
  return {
    version: 1,
    scope: "observed-auth-scope",
    target_library_id: "migration-library",
    approved_legacy_ids: entries.map((item) => item.legacy_id),
    backup: { verified: true, reference: "backup:fixture/verified-manifest" },
    catalog: {
      coverage: {
        method: "explicit_database",
        exhaustive: true,
        queried_data_sources: ["old-data-source"],
        failed_sources: [],
        search_index_limited: false,
      },
      entries,
    },
    preservation: {
      sources: empty(),
      views: empty(),
      routers: empty(),
      pins: empty(),
      operations: empty(),
    },
  }
}
const withFile = (original: Entry, file: File): Entry => ({ ...original, files: [file] })
const withInventory = (
  original: SharedMigrationInput,
  domain: keyof SharedMigrationInput["preservation"],
  inventory: Inventory,
): SharedMigrationInput => ({
  ...original,
  preservation: { ...original.preservation, [domain]: inventory },
})
// There are deliberately no Notion, Store or HTTP services in this test runner.
const plan = (value: unknown) =>
  Effect.runPromise(planSharedMigration(value).pipe(Effect.provide(NodeServices.layer)))
const codes = (value: Awaited<ReturnType<typeof plan>>) =>
  value.blockers.map((blocker) => blocker.code)

function followingInput(): SharedMigrationInput {
  const original = entry()
  const native = first(original.files)
  const base = input([
    withFile(
      { ...original, legacy_mode: "tracked", legacy_layout: "literal_file" },
      {
        ...native,
        ownership: "following",
        source_id: "old-source",
        projection_sha256: bodyHash,
      },
    ),
  ])
  return withInventory(base, "sources", {
    complete: true,
    items: [
      {
        legacy_id: "old-source",
        complete: true,
        references: [original.legacy_id],
        raw: {
          provider: { type: "github", url: "https://github.com/example/skills", ref: "main" },
          frozen_commit: "1".repeat(40),
        },
        source_semantics: "fixed_git_v1",
        fixed_source: {
          url: "https://github.com/example/skills",
          commit: "1".repeat(40),
          root: "skills/demo",
          tree: "2".repeat(40),
          files: [
            {
              path: "SKILL.md",
              source_path: "skills/demo/SKILL.md",
              git_oid: "3".repeat(40),
              bytes: 19,
            },
          ],
        },
      },
    ],
  })
}

describe("readonly shared migration planning", () => {
  test("complete explicitly approved evidence is data-ready while production writes remain unauthorized", async () => {
    const frozen = input()
    const before = structuredClone(frozen)
    const actual = await plan(frozen)
    expect(actual).toEqual(await plan(frozen))
    expect(frozen).toEqual(before)
    expect(actual.data_ready).toBe(true)
    expect(actual.status).toBe("reviewable")
    expect(actual.apply_allowed).toBe(false)
    expect(actual.production_authorization).toBe("not_requested_by_this_planner")
    expect(actual.blockers).toEqual([])
    expect(actual.plan_id).toMatch(/^migration-[a-f0-9]{64}$/u)
    expect(first(actual.records).approved).toBe(true)
    expect(first(first(actual.records).files).state).toBe("custom")
    expect(actual.evidence).toEqual(before)
    expect(actual.active_hosts).toEqual(["pro", "mini"])
    expect(actual.other_hosts).toBe("deferred")
    expect(actual.safeguards).toEqual({
      cleanup_allowed: false,
      unresolved_operation_replay: false,
      prior_pass_inherits_acceptance: false,
    })
  })

  test("business identities survive credential scope, name and path changes while all original fields remain in evidence", async () => {
    const original = input()
    const before = await plan(original)
    const oldEntry = first(original.catalog.entries)
    const renamed: Entry = {
      ...oldEntry,
      record: { ...property(oldEntry.record), name: "Renamed", entrypoint: "RENAMED.md" },
      metadata: { ...property(oldEntry.metadata), name: "Renamed" },
      files: [{ ...first(oldEntry.files), path: "RENAMED.md" }],
    }
    const after = await plan({ ...input([renamed]), scope: "another-credential-scope" })
    expect(after.data_ready).toBe(true)
    expect(first(after.records).skill_id).toBe(first(before.records).skill_id)
    expect(first(after.records).record_id).toBe(first(before.records).record_id)
    expect(first(first(after.records).files).file_id).toBe(
      first(first(before.records).files).file_id,
    )
    expect(after.plan_id).not.toBe(before.plan_id)
    expect(first(before.evidence.catalog.entries).record).toEqual(oldEntry.record)
    expect(first(before.evidence.catalog.entries).metadata).toEqual(oldEntry.metadata)
    expect(first(first(before.evidence.catalog.entries).files).raw).toEqual(
      first(oldEntry.files).raw,
    )
  })

  test("300 observed records do not override actual incomplete source coverage", async () => {
    const base = input(Array.from({ length: 300 }, (_, index) => entry(`legacy-${index}`)))
    const observed = {
      ...base,
      catalog: {
        ...base.catalog,
        coverage: {
          method: "explicit_database",
          exhaustive: false,
          queried_data_sources: [
            "b817f726-0d83-47dd-aec6-868d72fbdd09",
            "f68fc4c1-507e-4a64-be11-550748f4666a",
          ],
          failed_sources: [
            {
              id: "00000000-0000-4000-8000-000000000216",
              code: "INVALID_UPSTREAM",
              database_id: "845f8807-4a36-431b-ae9b-5bea2be1ff77",
              data_source_id: "f68fc4c1-507e-4a64-be11-550748f4666a",
              alias: "845f8807-4a36-431b-ae9b-5bea2be1ff77",
              title: "Guizang PPT",
            },
          ],
          search_index_limited: false,
        },
      },
    }
    const actual = await plan(observed)
    expect(actual.records).toHaveLength(300)
    expect(new Set(actual.records.map((record) => record.skill_id)).size).toBe(300)
    expect(
      new Set(actual.records.flatMap((record) => record.files.map((file) => file.file_id))).size,
    ).toBe(300)
    expect(actual.data_ready).toBe(false)
    expect(codes(actual)).toContain("CATALOG_INCOMPLETE")
    expect(actual.evidence.catalog.coverage).toEqual(observed.catalog.coverage)
  })

  test("discovery does not approve a batch and unobserved approved identities are not deletions", async () => {
    const emptyApproval = await plan({ ...input(), approved_legacy_ids: [] })
    expect(first(emptyApproval.records).approved).toBe(false)
    expect(codes(emptyApproval)).toContain("SCOPE_NOT_FROZEN")
    const unobserved = await plan({
      ...input(),
      approved_legacy_ids: [first(input().catalog.entries).legacy_id, "not-observed"],
    })
    expect(codes(unobserved)).toContain("APPROVED_ID_UNOBSERVED")
    expect(unobserved.records).toHaveLength(1)
    expect(unobserved.apply_allowed).toBe(false)
  })

  test("verified backup cannot substitute for unread bodies or incomplete metadata and membership", async () => {
    const original = entry()
    const body = first(original.files).body
    if (body === undefined) throw new Error("Missing fixture body")
    const partial = input([
      {
        ...original,
        metadata_complete: false,
        files_complete: false,
        files: [{ ...first(original.files), body: { ...body, complete: false } }],
      },
    ])
    const actual = await plan(partial)
    expect(codes(actual)).toContain("METADATA_INCOMPLETE")
    expect(codes(actual)).toContain("FILE_INVENTORY_INCOMPLETE")
    expect(codes(actual)).toContain("BODY_UNVERIFIED")
    expect(first(first(actual.records).files).state).toBe("unresolved")
    expect(first(first(actual.records).files).preserve_as_user_candidate).toBe(true)
    expect(actual.evidence.backup.verified).toBe(true)
    expect(actual.data_ready).toBe(false)
  })

  test("unenumerated preservation inventories stay explicitly incomplete and receive no invented mappings", async () => {
    const original = input()
    const incomplete = { complete: false, items: [] }
    const actual = await plan({
      ...original,
      preservation: {
        sources: incomplete,
        views: incomplete,
        routers: incomplete,
        pins: incomplete,
        operations: incomplete,
      },
    })
    expect(actual.preservation).toEqual([])
    expect(
      actual.blockers.filter((blocker) => blocker.code === "INVENTORY_INCOMPLETE"),
    ).toHaveLength(5)
    expect(actual.evidence.preservation.pins.complete).toBe(false)
    expect(actual.data_ready).toBe(false)
  })

  test("following requires supported exact fixed-source semantics and a verified matching prior projection", async () => {
    const actual = await plan(followingInput())
    expect(actual.data_ready).toBe(true)
    const file = first(first(actual.records).files)
    expect(file.state).toBe("following")
    expect(file.source_id).toMatch(/^source-[a-f0-9]{64}$/u)
    expect(file.preserve_as_user_candidate).toBe(false)
    expect(first(actual.preservation).disposition).toBe("mapped_source")
    expect(first(actual.preservation).source_id).toBe(file.source_id)
  })

  test("unsupported legacy source options are kept verbatim and never converted to following", async () => {
    for (const options of [
      { external_assets: false },
      { external_assets: true, external_markdown: ["README.md", "References/intro.md"] },
      {
        include: ["**/*.md"],
        exclude: ["private/**"],
        patch: [{ path: "SKILL.md", content: "keep" }],
        sharedTargetSet: ["pro", "mini"],
      },
    ]) {
      const base = followingInput()
      const source = first(base.preservation.sources.items)
      const raw = { ...property(source.raw), ...options }
      const actual = await plan(
        withInventory(base, "sources", { complete: true, items: [{ ...source, raw }] }),
      )
      expect(first(actual.evidence.preservation.sources.items).raw).toEqual(raw)
      expect(codes(actual)).toContain("LEGACY_SOURCE_OPTIONS_UNSUPPORTED")
      expect(codes(actual)).toContain("FOLLOWING_SOURCE_UNRESOLVED")
      expect(first(first(actual.records).files).state).toBe("unresolved")
      expect(first(first(actual.records).files).preserve_as_user_candidate).toBe(true)
    }
    const base = followingInput()
    const source = first(base.preservation.sources.items)
    const expanded = { ...property(source.fixed_source), external_assets: false }
    const actual = await plan(
      withInventory(base, "sources", {
        complete: true,
        items: [{ ...source, fixed_source: expanded }],
      }),
    )
    expect(codes(actual)).toContain("LEGACY_SOURCE_OPTIONS_UNSUPPORTED")
    expect(first(actual.evidence.preservation.sources.items).fixed_source).toEqual(expanded)
  })

  test("a current/projection difference and an unknown baseline remain protected review candidates", async () => {
    const base = followingInput()
    const original = first(base.catalog.entries)
    for (const projection of [otherHash, ""]) {
      const actual = await plan({
        ...base,
        catalog: {
          ...base.catalog,
          entries: [
            withFile(original, { ...first(original.files), projection_sha256: projection }),
          ],
        },
      })
      expect(first(first(actual.records).files).state).toBe("unresolved")
      expect(first(first(actual.records).files).preserve_as_user_candidate).toBe(true)
      expect(codes(actual)).toContain(
        projection === "" ? "PROJECTION_BASELINE_UNKNOWN" : "USER_EDIT_CANDIDATE",
      )
      expect(actual.data_ready).toBe(false)
    }
    const unknown = await plan(
      input([withFile(entry(), { ...first(entry().files), ownership: "unknown" })]),
    )
    expect(codes(unknown)).toContain("USER_EDIT_CANDIDATE")
    expect(first(first(unknown.records).files).state).toBe("unresolved")
  })

  test("fork, local, native and unknown objects cannot silently become following even when bytes equal the prior projection", async () => {
    const base = followingInput()
    for (const legacy_mode of ["fork", "local", "native", "unknown"] as const) {
      const actual = await plan({
        ...base,
        catalog: { ...base.catalog, entries: [{ ...first(base.catalog.entries), legacy_mode }] },
      })
      expect(codes(actual)).toContain("OWNERSHIP_CLASSIFICATION_CONFLICT")
      expect(first(first(actual.records).files).state).toBe("unresolved")
      expect(first(first(actual.records).files).preserve_as_user_candidate).toBe(true)
    }
  })

  test("a discovered tracked object outside the frozen approval scope remains a candidate, never following", async () => {
    const actual = await plan({ ...followingInput(), approved_legacy_ids: [] })
    expect(codes(actual)).toContain("SCOPE_NOT_FROZEN")
    expect(first(actual.records).approved).toBe(false)
    expect(first(first(actual.records).files).state).toBe("unresolved")
    expect(first(first(actual.records).files).preserve_as_user_candidate).toBe(true)
  })

  test("an otherwise valid fixed source cannot confer following through an unverified legacy member binding", async () => {
    const base = followingInput()
    const source = first(base.preservation.sources.items)
    const actual = await plan(
      withInventory(base, "sources", { complete: true, items: [{ ...source, references: [] }] }),
    )
    expect(codes(actual)).toContain("FOLLOWING_BINDING_UNVERIFIED")
    expect(first(first(actual.records).files).state).toBe("unresolved")
    expect(first(first(actual.records).files).preserve_as_user_candidate).toBe(true)
    expect(first(actual.evidence.preservation.sources.items).references).toEqual([])
  })

  test("unfinished operations retain state, phase, scope, external assets and the exact intent without automatic replay", async () => {
    const base = input()
    const commands = ["subscription_add", "subscription_update"].map((domain, index) => ({
      operation_id: `old-command-${index}`,
      domain,
      scope: "original-command-scope",
      database_id: "original-database",
      input: {
        target_database_id: "target-db",
        roots: ["skills/demo"],
        include: ["**/*.md"],
        exclude: ["private/**"],
        mapping: { old: "new" },
        source: {
          provider: { type: "github", url: "https://github.com/example/skills", ref: "main" },
          external_assets: false,
          ...(index === 1 ? { external_markdown: ["References/a.md"] } : {}),
        },
      },
      state: "pending",
      phase: "awaiting_verification",
      status: "completed",
      intent: {
        method: "POST",
        path: "v1/pages",
        payload: { properties: { Name: { title: [] } }, children: [{ preserved: true }] },
        origin: { database_id: "original-database", scope: "original-command-scope" },
        correlation: { command: `old-command-${index}` },
      },
      input_hash: otherHash,
      unknown_future_field: { preserve: ["everything"] },
    }))
    const actual = await plan(
      withInventory(base, "operations", {
        complete: true,
        items: commands.map((raw) => ({
          legacy_id: raw.operation_id,
          raw,
          complete: true,
          references: [first(base.catalog.entries).legacy_id],
        })),
      }),
    )
    expect(actual.evidence.preservation.operations.items.map((item) => item.raw)).toEqual(commands)
    expect(
      actual.blockers.filter((blocker) => blocker.code === "UNSETTLED_OPERATION"),
    ).toHaveLength(2)
    expect(
      actual.blockers.filter((blocker) => blocker.code === "LEGACY_SOURCE_OPTIONS_UNSUPPORTED"),
    ).toHaveLength(2)
    expect(actual.preservation.map((item) => item.disposition)).toEqual([
      "retain_and_reconcile",
      "retain_and_reconcile",
    ])
    expect(first(actual.preservation).operation).toEqual({
      operation_id: "old-command-0",
      scope: "original-command-scope",
      database_id: "original-database",
      state: "pending",
      phase: "awaiting_verification",
      automatic_replay: false,
    })
    expect(actual.data_ready).toBe(false)
  })

  test("views, routers and pins retain their original relations and explicitly block missing destinations or bytes", async () => {
    const base = input()
    const legacy = first(base.catalog.entries).legacy_id
    const actual = await plan({
      ...base,
      preservation: {
        ...base.preservation,
        views: {
          complete: true,
          items: [
            {
              legacy_id: "old-view",
              raw: { layout: "custom", relations: [legacy] },
              complete: true,
              references: [legacy],
            },
          ],
        },
        routers: {
          complete: true,
          items: [
            {
              legacy_id: "old-router",
              raw: { members: [legacy, "not-observed"], stable_member_keys: ["a", "b"] },
              complete: true,
              references: [legacy, "not-observed"],
            },
          ],
        },
        pins: {
          complete: true,
          items: [
            {
              legacy_id: "old-pin",
              raw: {
                snapshot_id: "frozen-old-pin",
                files: [{ path: "SKILL.md", sha256: bodyHash }],
              },
              complete: true,
              references: [legacy],
              retention_verified: false,
            },
          ],
        },
      },
    })
    expect(codes(actual)).toContain("REFERENCE_UNRESOLVED")
    expect(codes(actual)).toContain("PIN_RETENTION_UNVERIFIED")
    const view = actual.preservation.find((item) => item.domain === "views")
    expect(view?.references).toEqual([
      { legacy_id: legacy, record_id: first(actual.records).record_id },
    ])
    const router = actual.preservation.find((item) => item.domain === "routers")
    expect(router?.references).toContainEqual({ legacy_id: "not-observed", record_id: null })
    expect(actual.evidence.preservation.routers.items).toHaveLength(1)
    expect(actual.apply_allowed).toBe(false)
  })

  test("duplicate identities and unsafe or colliding paths preserve every row and block a complete plan", async () => {
    const original = entry()
    const main = first(original.files)
    const unsafe = {
      ...original,
      files: [
        main,
        { ...main, path: "../outside" },
        { ...main, legacy_id: "other-id", path: "skill.md" },
      ],
    }
    const actual = await plan(input([unsafe, original]))
    expect(actual.records).toHaveLength(2)
    expect(actual.evidence.catalog.entries).toHaveLength(2)
    expect(codes(actual)).toContain("DUPLICATE_LEGACY_ID")
    expect(codes(actual)).toContain("FILE_IDENTITY_UNCERTAIN")
    expect(codes(actual)).toContain("FILE_TREE_INVALID")
    expect(actual.data_ready).toBe(false)
    const collision = await plan(
      input([
        {
          ...original,
          files: [main, { ...main, legacy_id: "case-distinct-file", path: "skill.md" }],
        },
      ]),
    )
    expect(codes(collision)).toContain("FILE_TREE_INVALID")
  })

  test("unknown wrapper fields fail explicitly while opaque legacy extra fields remain supported", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        planSharedMigration({ ...input(), unexpected_wrapper: { do_not_strip: true } }),
      ).pipe(Effect.provide(NodeServices.layer)),
    )
    expect(error.code).toBe("MIGRATION_INPUT_INVALID")
    const actual = await plan(input())
    expect(property(first(actual.evidence.catalog.entries).record).old_extra).toEqual({
      relation: ["unported-value"],
      editable: true,
    })
  })
})
