import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Crypto, Effect } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { property } from "../src/model.ts"
import { planSharedMigration, type SharedMigrationInput } from "../src/shared-migration-plan.ts"
import {
  makeSharedMigrationCreateCandidate,
  validateSharedMigrationCreateCandidate,
  type MigrationRetainedFile,
} from "../src/shared-migration-create-binding.ts"
import { makeSharedCreatePlan, validateSharedCreatePlan } from "../src/shared-create-model.ts"
import { readProjectionBaseline } from "../src/skill-file-index.ts"
import { library as baseLibrary } from "./shared-snapshot-fixture.ts"

type Entry = SharedMigrationInput["catalog"]["entries"][number]
type File = Entry["files"][number]
const encode = (value: string) => new TextEncoder().encode(value)
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const legacy = "notion_page:00000000-0000-4000-8000-000000000100"
const library = {
  ...baseLibrary,
  skills: {
    ...baseLibrary.skills,
    property_ids: { ...baseLibrary.skills.property_ids, Members: "members" },
  },
}
function first<T>(items: readonly T[]): T {
  const item = items[0]
  if (item === undefined) throw new Error("Missing controlled fixture")
  return item
}
function file(id: string, path: string, text: string): File {
  return {
    legacy_id: id,
    path,
    ownership: "native",
    body: {
      complete: true,
      sha256: hash(text),
      bytes: encode(text).byteLength,
      retention_ref: `backup:fixture/${id}`,
      retention_verified: true,
      normalization_version: 1,
    },
    raw: { retained_original_field: id },
  }
}
function entry(
  id = legacy,
  files: readonly File[] = [
    file("old-main", "SKILL.md", "Retained main"),
    file("old-support", "notes.md", "Retained notes"),
  ],
): Entry {
  return {
    legacy_id: id,
    record: {
      id,
      kind: "skill",
      name: "Retained name",
      description: "Retained description",
      default_context: false,
      entrypoint: "SKILL.md",
      locator: {
        type: "notion_page",
        page_id: "00000000-0000-4000-8000-000000000100",
        database_id: "old-database",
      },
      extra_catalog: "retained",
    },
    metadata: { original_native_fields: { unknown_metadata: ["keep"] } },
    metadata_complete: true,
    files_complete: true,
    legacy_mode: "native",
    legacy_layout: "ordinary_page",
    files,
  }
}
function input(entries: readonly Entry[] = [entry()]): SharedMigrationInput {
  const empty = { complete: true, items: [] }
  return {
    version: 1,
    scope: "fixture-observation",
    target_library_id: library.library_id,
    approved_legacy_ids: entries.map((item) => item.legacy_id),
    backup: { verified: true, reference: "backup:fixture" },
    catalog: {
      coverage: {
        method: "explicit_database",
        exhaustive: true,
        queried_data_sources: ["fixture-ds"],
        failed_sources: [],
        search_index_limited: false,
      },
      entries,
    },
    preservation: { sources: empty, views: empty, routers: empty, pins: empty, operations: empty },
  }
}
const bodies = (): MigrationRetainedFile[] => [
  {
    legacy_id: "old-main",
    retention_ref: "backup:fixture/old-main",
    bytes: encode("Retained main"),
  },
  {
    legacy_id: "old-support",
    retention_ref: "backup:fixture/old-support",
    bytes: encode("Retained notes"),
  },
]
// There are no Notion, Store or provider services in these pure conversion tests.
const run = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))
const make = (
  frozen: SharedMigrationInput = input(),
  retained: readonly MigrationRetainedFile[] = bodies(),
  id = legacy,
) =>
  makeSharedMigrationCreateCandidate({
    migration_input: frozen,
    library,
    legacy_id: id,
    files: retained,
  })

function followingInput(): SharedMigrationInput {
  const original = entry(legacy, [file("old-main", "SKILL.md", "Retained main")])
  const main = first(original.files)
  const base = input([
    {
      ...original,
      legacy_mode: "tracked",
      legacy_layout: "literal_file",
      files: [
        {
          ...main,
          ownership: "following",
          source_id: "old-fixed-source",
          projection_sha256: hash("Retained main"),
        },
      ],
    },
  ])
  return {
    ...base,
    preservation: {
      ...base.preservation,
      sources: {
        complete: true,
        items: [
          {
            legacy_id: "old-fixed-source",
            complete: true,
            references: [legacy],
            raw: { exact_old_source_options: "retained" },
            source_semantics: "fixed_git_v1",
            fixed_source: {
              url: "https://github.com/example/skills",
              commit: "1".repeat(40),
              root: "skills/example",
              tree: "2".repeat(40),
              files: [
                {
                  path: "SKILL.md",
                  source_path: "skills/example/SKILL.md",
                  git_oid: "3".repeat(40),
                  bytes: 13,
                },
                {
                  path: "assets/original.png",
                  source_path: "skills/example/assets/original.png",
                  git_oid: "4".repeat(40),
                  bytes: 1024,
                },
              ],
            },
          },
        ],
      },
    },
  }
}

test("custom conversion retains stable migration IDs, exact bytes and metadata with only unbound physical slots", async () => {
  const frozen = input(),
    retained = bodies(),
    before = structuredClone(frozen),
    retainedBefore = structuredClone(retained)
  const mapping = await run(planSharedMigration(frozen)),
    candidate = await run(make(frozen, retained))
  expect(candidate.skill_id).toBe(first(mapping.records).skill_id)
  expect(candidate.files.map((item) => item.file_id)).toEqual(
    first(mapping.records).files.map((item) => item.file_id),
  )
  expect(candidate.legacy_entry).toEqual(first(frozen.catalog.entries))
  expect(candidate.files.map((item) => item.input.text)).toEqual([
    "Retained main",
    "Retained notes",
  ])
  for (const file of candidate.files)
    expect(file.projection).toMatchObject({ version: 3, purpose: "data_source_create" })
  expect(
    candidate.files.every(
      (item) =>
        item.initial_event.kind === "adopted" &&
        item.ownership.kind === "custom" &&
        item.binding.page_id === null,
    ),
  ).toBe(true)
  expect(candidate.binding.page_id).toBe(null)
  expect(candidate.binding.enabled_until_verified).toBe(false)
  expect(candidate.execution).toEqual({
    state: "not_implemented",
    apply_allowed: false,
    receipt_content_verified: false,
    physical_bindings_verified: false,
    required_binding_reader: "querySharedSkillIndex_and_querySkillFiles",
    legacy_relations: "retained_not_translated",
  })
  expect(await run(validateSharedMigrationCreateCandidate(frozen, candidate))).toEqual(candidate)
  expect(await run(make(frozen, retained))).toEqual(candidate)
  expect(frozen).toEqual(before)
  expect(retained).toEqual(retainedBefore)
  expect((await run(Effect.flip(validateSharedCreatePlan(candidate)))).code).toBe(
    "SHARED_CREATE_INVALID",
  )
})

test("following keeps exact Source commit, projection and ownership without creating pages for additional Git resources", async () => {
  const frozen = followingInput(),
    candidate = await run(make(frozen, bodies().slice(0, 1)))
  if (candidate.source === null) throw new Error("Following must retain its fixed Source")
  expect(candidate.source.files).toHaveLength(2)
  expect(candidate.source.files.some((item) => item.path === "assets/original.png")).toBe(true)
  expect(candidate.files).toHaveLength(1)
  expect(candidate.binding.source_reference).toBe(candidate.source.source_id)
  const main = first(candidate.files)
  expect(main.initial_event.kind).toBe("projected")
  expect(main.ownership).toEqual({
    kind: "following",
    source_revision: "1".repeat(40),
    projection: { normalization_version: 1, sha256: hash("Retained main") },
  })
  expect(main.binding.display_status).toBe("following")
  if (main.binding.projection_baseline === null)
    throw new Error("Following must retain its projection baseline")
  expect(readProjectionBaseline(JSON.stringify(main.binding.projection_baseline))).toEqual(
    main.binding.projection_baseline,
  )
  expect(candidate.legacy_source).toEqual(first(frozen.preservation.sources.items))
  expect(await run(validateSharedMigrationCreateCandidate(frozen, candidate))).toEqual(candidate)
})

test("a selected fixed Source does not reclassify a custom supporting file as following", async () => {
  const original = followingInput(),
    current = first(original.catalog.entries)
  const frozen = {
    ...original,
    catalog: {
      ...original.catalog,
      entries: [
        {
          ...current,
          files: [...current.files, file("old-support", "notes.md", "Retained notes")],
        },
      ],
    },
  }
  const candidate = await run(make(frozen))
  expect(candidate.source).not.toBe(null)
  expect(candidate.files.find((item) => item.legacy_id === "old-main")?.ownership.kind).toBe(
    "following",
  )
  expect(candidate.files.find((item) => item.legacy_id === "old-support")?.ownership.kind).toBe(
    "custom",
  )
})

test("name and supporting path changes cannot regenerate migration business identities", async () => {
  const original = input(),
    oldEntry = first(original.catalog.entries),
    before = await run(make(original))
  const renamed = {
    ...oldEntry,
    record: { ...property(oldEntry.record), name: "Renamed explicitly" },
    files: oldEntry.files.map((item) =>
      item.legacy_id === "old-support" ? { ...item, path: "renamed-notes.md" } : item,
    ),
  }
  const after = await run(make(input([renamed])))
  expect(after.skill_id).toBe(before.skill_id)
  expect(after.files.map((item) => item.file_id)).toEqual(before.files.map((item) => item.file_id))
  expect(after.candidate_id).not.toBe(before.candidate_id)
})

test("a true retention declaration cannot substitute for exact complete supplied bytes and references", async () => {
  const variants: readonly MigrationRetainedFile[][] = [
    [first(bodies())],
    [...bodies(), first(bodies())],
    [{ ...first(bodies()), bytes: encode("Different main") }, bodies()[1]].filter(
      (item): item is MigrationRetainedFile => item !== undefined,
    ),
    bodies().map((item) => ({ ...item, retention_ref: "backup:another-object" })),
  ]
  for (const retained of variants)
    expect((await run(Effect.flip(make(input(), retained)))).code).toMatch(
      /^SHARED_MIGRATION_CREATE_(?:FILES|BODY_MISMATCH)$/u,
    )
})

test("empty approval, wrong library and unresolved target cannot become creation candidates", async () => {
  const frozen = input()
  expect((await run(Effect.flip(make({ ...frozen, approved_legacy_ids: [] })))).code).toBe(
    "SHARED_MIGRATION_CREATE_NOT_APPROVED",
  )
  expect(
    (
      await run(
        Effect.flip(
          makeSharedMigrationCreateCandidate({
            migration_input: frozen,
            legacy_id: legacy,
            library: { ...library, library_id: "another-library" },
            files: bodies(),
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_CREATE_SCOPE")
  expect(
    (
      await run(
        Effect.flip(make({ ...frozen, backup: { verified: false, reference: "backup:fixture" } })),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_CREATE_BLOCKED")
})

test("a tombstone stays unsupported without inventing an adopted predecessor, including the protected main file", async () => {
  for (const selected of ["old-main", "old-support"]) {
    const original = entry(),
      tombstoned: Entry = {
        ...original,
        files: original.files.map((item) =>
          item.legacy_id === selected ? { ...item, ownership: "tombstone" } : item,
        ),
      }
    const frozen = input([tombstoned]),
      before = structuredClone(frozen)
    expect((await run(Effect.flip(make(frozen)))).code).toBe(
      "SHARED_MIGRATION_CREATE_TOMBSTONE_UNSUPPORTED",
    )
    expect(frozen).toEqual(before)
  }
})

test("tracked content cannot silently lose its Source or combine incompatible selected sources", async () => {
  const native = entry()
  expect((await run(Effect.flip(make(input([{ ...native, legacy_mode: "tracked" }]))))).code).toBe(
    "SHARED_MIGRATION_CREATE_SOURCE_UNRESOLVED",
  )
  const frozen = followingInput(),
    current = first(frozen.catalog.entries),
    source = first(frozen.preservation.sources.items)
  const other: typeof source = {
    ...source,
    legacy_id: "other-source",
    fixed_source: {
      ...property(source.fixed_source),
      commit: "5".repeat(40),
      files: [
        {
          path: "notes.md",
          source_path: "skills/example/notes.md",
          git_oid: "6".repeat(40),
          bytes: 14,
        },
      ],
    },
  }
  const mixed = {
    ...frozen,
    catalog: {
      ...frozen.catalog,
      entries: [
        {
          ...current,
          files: [
            ...current.files,
            {
              ...file("old-support", "notes.md", "Retained notes"),
              ownership: "following" as const,
              source_id: "other-source",
              projection_sha256: hash("Retained notes"),
            },
          ],
        },
      ],
    },
    preservation: { ...frozen.preservation, sources: { complete: true, items: [source, other] } },
  }
  expect((await run(Effect.flip(make(mixed)))).code).toBe(
    "SHARED_MIGRATION_CREATE_SOURCE_UNRESOLVED",
  )
})

test("historical custom source references never become the selected consumption Source", async () => {
  const original = followingInput(),
    current = first(original.catalog.entries),
    main = first(current.files)
  for (const legacy_mode of ["native", "fork", "local", "tracked"] as const) {
    const frozen: SharedMigrationInput = {
      ...original,
      catalog: {
        ...original.catalog,
        entries: [{ ...current, legacy_mode, files: [{ ...main, ownership: "custom" }] }],
      },
    }
    expect((await run(Effect.flip(make(frozen, bodies().slice(0, 1))))).code).toBe(
      "SHARED_MIGRATION_CREATE_SOURCE_UNRESOLVED",
    )
    expect(first(first(frozen.catalog.entries).files).source_id).toBe("old-fixed-source")
  }
})

test("binary bodies and projection changes are typed blockers while original bytes remain retained", async () => {
  const bytes = new Uint8Array([0, 255, 1]),
    original = entry(legacy, [file("old-main", "SKILL.md", "placeholder")])
  const main = first(original.files),
    body = main.body
  if (body === undefined) throw new Error("Missing body fixture")
  const binary = input([
    {
      ...original,
      files: [{ ...main, body: { ...body, sha256: hash(bytes), bytes: bytes.length } }],
    },
  ])
  expect(
    (
      await run(
        Effect.flip(
          make(binary, [{ legacy_id: "old-main", retention_ref: body.retention_ref, bytes }]),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_CREATE_BINARY_UNSUPPORTED")
  expect(bytes).toEqual(new Uint8Array([0, 255, 1]))
  const text = "Retained main\n",
    changed = input([entry(legacy, [file("old-main", "SKILL.md", text)])])
  expect(
    (
      await run(
        Effect.flip(
          make(changed, [
            { legacy_id: "old-main", retention_ref: body.retention_ref, bytes: encode(text) },
          ]),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_CREATE_PROJECTION_CHANGED")
})

test("new migration intents reject policy-3 inline boundaries without changing frozen legacy bytes", async () => {
  for (const text of [
    "Native <code>a`b</code>.\n\nFollowing paragraph.",
    "Markdown ``a`b``.\n\nFollowing paragraph.",
  ]) {
    const frozen = input([entry(legacy, [file("old-main", "SKILL.md", text)])])
    const retained = [
      { legacy_id: "old-main", retention_ref: "backup:fixture/old-main", bytes: encode(text) },
    ]
    const before = structuredClone(frozen),
      bytesBefore = new Uint8Array(first(retained).bytes)
    expect((await run(Effect.flip(make(frozen, retained)))).code).toBe(
      "SHARED_MARKDOWN_PROJECTION_UNSUPPORTED",
    )
    expect(frozen).toEqual(before)
    expect(first(retained).bytes).toEqual(bytesBefore)
  }
})

test("migration policy 3 retains exact fenced literal backticks without materializing extra resources", async () => {
  const text = "```txt\nNative literal example: [example](missing.md) and a`b.\n```"
  const frozen = input([entry(legacy, [file("old-main", "SKILL.md", text)])])
  const candidate = await run(
    make(frozen, [
      { legacy_id: "old-main", retention_ref: "backup:fixture/old-main", bytes: encode(text) },
    ]),
  )
  const main = first(candidate.files)
  expect(main.projection).toMatchObject({
    version: 3,
    purpose: "data_source_create",
    input_markdown: text,
    markdown: text,
  })
  expect(main.input.sha256).toBe(hash(text))
  expect(main.content.sha256).toBe(hash(text))
  expect(candidate.files).toHaveLength(1)
  expect(candidate.execution.apply_allowed).toBe(false)
  expect(await run(validateSharedMigrationCreateCandidate(frozen, candidate))).toEqual(candidate)
})

test("new migration policy does not reinterpret retained v1/v2 native create plans", async () => {
  const text = "Native <code>a`b</code>.\n\nFollowing paragraph."
  for (const version of [1, 2] as const) {
    const historical = await run(
      makeSharedCreatePlan(
        library,
        {
          portable: {
            kind: "skill",
            name: "Retained name",
            description: "Retained description",
            main: "SKILL.md",
            files: [{ path: "SKILL.md", bytes: encode(text) }],
          },
        },
        version,
      ),
    )
    const before = structuredClone(historical)
    expect(first(historical.files).projection.version).toBe(version)
    expect(await run(validateSharedCreatePlan(historical))).toEqual(before)
    expect(historical).toEqual(before)
  }
})

test("the validator rejects replaced stable IDs, bytes, ownership, physical UUIDs and asserted receipt verification", async () => {
  const frozen = followingInput(),
    candidate = await run(make(frozen, bodies().slice(0, 1))),
    main = first(candidate.files)
  const variants = [
    { ...candidate, skill_id: "caller-replaced-id" },
    { ...candidate, files: [{ ...main, file_id: "caller-replaced-file" }] },
    { ...candidate, files: [{ ...main, input: { ...main.input, text: "Replacement" } }] },
    { ...candidate, files: [{ ...main, ownership: { kind: "custom", content: main.content } }] },
    {
      ...candidate,
      binding: { ...candidate.binding, page_id: "00000000-0000-4000-8000-000000000999" },
    },
    { ...candidate, execution: { ...candidate.execution, receipt_content_verified: true } },
  ]
  for (const changed of variants)
    expect(
      (await run(Effect.flip(validateSharedMigrationCreateCandidate(frozen, changed)))).code,
    ).toMatch(/^SHARED_MIGRATION_CREATE_/u)
})

test("Router members remain exact logical requirements with no reused legacy or synthetic new page IDs", async () => {
  const routerId = "legacy-router",
    routerEntry = entry(routerId, [file("router-main", "ROUTER.md", "Retained Router")])
  const router: Entry = {
    ...routerEntry,
    record: { ...property(routerEntry.record), kind: "router", entrypoint: "ROUTER.md" },
  }
  const original = input([entry(), router])
  const frozen = {
    ...original,
    preservation: {
      ...original.preservation,
      routers: {
        complete: true,
        items: [
          {
            legacy_id: routerId,
            complete: true,
            references: [legacy],
            raw: { original_members: [legacy], extra_relation: "preserved" },
          },
        ],
      },
    },
  }
  const candidate = await run(
    make(
      frozen,
      [
        {
          legacy_id: "router-main",
          retention_ref: "backup:fixture/router-main",
          bytes: encode("Retained Router"),
        },
      ],
      routerId,
    ),
  )
  expect(candidate.member_bindings).toHaveLength(1)
  expect(first(candidate.member_bindings).legacy_id).toBe(legacy)
  expect(first(candidate.member_bindings).skill_id).toMatch(/^migration-skill-/u)
  expect(first(candidate.member_bindings).page_id).toBe(null)
  expect(candidate.legacy_router).toEqual(first(frozen.preservation.routers.items))
  expect(candidate.execution.legacy_relations).toBe("retained_not_translated")
})
