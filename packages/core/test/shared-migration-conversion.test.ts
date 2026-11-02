import { expect, test } from "bun:test"
import { Crypto, Effect } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { property } from "../src/model.ts"
import { makeSharedMigrationCreateCandidate } from "../src/shared-migration-create-binding.ts"
import {
  makeSharedMigrationConversion,
  retainedMigrationConversionInput,
  validateRetainedMigrationConversion,
  validateSharedMigrationConversion,
} from "../src/shared-migration-conversion.ts"
import {
  makeSharedMigrationCreatePlan,
  sharedCreateManifest,
  validateSharedCreatePlan,
} from "../src/shared-create-model.ts"
import {
  restoreSharedMigrationCreateOrigin,
  sharedMigrationOriginObjects,
} from "../src/shared-migration-create-origin.ts"
import { canonicalSharedJson, validateSharedRecordEnvelope } from "../src/shared-records.ts"
import {
  first,
  migrationConversionFixture,
  migrationEncode,
  migrationHash,
} from "./shared-migration-conversion-fixture.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

test("v2 retains exact legacy bytes and native response while freezing the distinct known Markdown conversion", async () => {
  const fixture = migrationConversionFixture(),
    before = structuredClone(fixture.input)
  const candidate = await run(makeSharedMigrationConversion(fixture.input))
  const main = first(candidate.files)
  expect(candidate).toMatchObject({
    version: 2,
    conversion_policy: "legacy_page_to_native_v1",
    execution: { apply_allowed: false },
  })
  expect(main.original.text).toBe("# Migration heading\n\nUse `code`.")
  expect(main.native_preimage.response_json).toBe(
    first(fixture.input.files).native_preimage.response_json,
  )
  expect(main.projection).toMatchObject({
    version: 6,
    purpose: "data_source_create",
    input_markdown: "# Migration heading\n\nUse `code`.",
    wire_markdown: "<h1>Migration heading</h1>\n\nUse `code`.",
    markdown: "# Migration heading\n\nUse <code>code</code>.",
  })
  expect(main.content.sha256).toBe(migrationHash("# Migration heading\n\nUse <code>code</code>."))
  expect(main.initial_event.kind).toBe("adopted")
  expect(await run(validateSharedMigrationConversion(fixture.migrationInput, candidate))).toEqual(
    candidate,
  )
  expect(fixture.input).toEqual(before)
  expect((await run(Effect.flip(makeSharedMigrationCreateCandidate(fixture.input)))).code).toBe(
    "SHARED_MIGRATION_CREATE_PROJECTION_CHANGED",
  )
})

test("following uses the exact fixed Source and new native baseline without reclassifying custom files or materializing assets", async () => {
  const source =
    "---\nname: Migrated fixture\ndescription: Preserved description\nmetadata:\n  original: keep\n---\n\n# Migration heading\n\nUse `code`."
  const fixture = migrationConversionFixture({ following: true, sourceMain: source })
  const candidate = await run(makeSharedMigrationConversion(fixture.input))
  const main = first(candidate.files),
    notes = candidate.files.find((file) => file.path === "notes.md")
  expect(candidate.source_files).toHaveLength(3)
  expect(candidate.files).toHaveLength(2)
  expect(main.input.text).toBe(source)
  expect(main.input.sha256).not.toBe(main.content.sha256)
  expect(main.initial_event).toMatchObject({
    kind: "projected",
    source_revision: "1".repeat(40),
    projection: {
      normalization_version: 1,
      sha256: migrationHash("# Migration heading\n\nUse <code>code</code>."),
    },
  })
  expect(notes?.selection).toBe("current")
  expect(notes?.input.text).toBe("Retained notes")
  expect(notes?.initial_event.kind).toBe("adopted")
  expect(candidate.files.some((file) => file.path === "assets/original.bin")).toBe(false)
  expect(await run(validateSharedMigrationConversion(fixture.migrationInput, candidate))).toEqual(
    candidate,
  )
})

test.each([3, 4, 5] as const)(
  "saved projection-v%s migration candidates keep their policy after new reviews select v6",
  async (projectionVersion) => {
    const fixture = migrationConversionFixture({
      main: "Notes:\n1. First\n\n2. [`notes`](notes.md)\n\nWrapped\nparagraph.",
    })
    const retained = await run(
      makeSharedMigrationConversion({
        ...fixture.input,
        projection_version: projectionVersion,
      }),
    )
    const current = await run(makeSharedMigrationConversion(fixture.input))
    expect(first(retained.files).projection.version).toBe(projectionVersion)
    expect(first(current.files).projection.version).toBe(6)
    expect(first(retained.files).content.sha256).not.toBe(first(current.files).content.sha256)
    expect(
      retainedMigrationConversionInput(fixture.migrationInput, retained).projection_version,
    ).toBe(projectionVersion)
    expect(await run(validateRetainedMigrationConversion(retained))).toEqual(retained)
    expect(await run(validateSharedMigrationConversion(fixture.migrationInput, retained))).toEqual(
      retained,
    )
    expect(await run(validateSharedMigrationConversion(fixture.migrationInput, current))).toEqual(
      current,
    )
    const savedPlan = await run(makeSharedMigrationCreatePlan(retained, []))
    expect(savedPlan.files.every((file) => file.projection.version === projectionVersion)).toBe(
      true,
    )
    expect(first(savedPlan.files).projection).toEqual(first(retained.files).projection)
    expect(await run(validateSharedCreatePlan(savedPlan))).toEqual(savedPlan)
  },
)

test("source bytes require the complete selected tree and exact Git object bytes", async () => {
  const fixture = migrationConversionFixture({ following: true })
  const source = fixture.input.source_files ?? []
  const bad = [
    source.slice(0, 1),
    source.map((file) =>
      file.path === "assets/original.bin" ? { ...file, bytes: new Uint8Array([0, 254, 1]) } : file,
    ),
  ]
  for (const source_files of bad)
    expect(
      (await run(Effect.flip(makeSharedMigrationConversion({ ...fixture.input, source_files }))))
        .code,
    ).toBe("SHARED_MIGRATION_CONVERSION_SOURCE")
})

test("unknown ownership, missing approval and disabled originals do not gain an executable migration origin", async () => {
  const fixture = migrationConversionFixture()
  const unapproved = { ...fixture.migrationInput, approved_legacy_ids: [] }
  expect(
    (
      await run(
        Effect.flip(
          makeSharedMigrationConversion({ ...fixture.input, migration_input: unapproved }),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_CREATE_NOT_APPROVED")
  const disabled = {
    ...fixture.migrationInput,
    catalog: {
      ...fixture.migrationInput.catalog,
      entries: [
        { ...fixture.entry, record: { ...property(fixture.entry.record), enabled: false } },
      ],
    },
  }
  expect(
    (
      await run(
        Effect.flip(makeSharedMigrationConversion({ ...fixture.input, migration_input: disabled })),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_CONVERSION_ENABLED_UNSUPPORTED")
  const unknown = {
    ...fixture.migrationInput,
    catalog: {
      ...fixture.migrationInput.catalog,
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
      await run(
        Effect.flip(makeSharedMigrationConversion({ ...fixture.input, migration_input: unknown })),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_CREATE_BLOCKED")
})

test("frozen preimages reject foreign pages, incomplete bodies and altered original response bytes", async () => {
  const fixture = migrationConversionFixture(),
    original = first(fixture.input.files)
  const raw = property(JSON.parse(original.native_preimage.response_json))
  for (const response_json of [
    JSON.stringify({ ...raw, truncated: true }),
    JSON.stringify({ ...raw, id: "00000000-0000-4000-8000-000000000999" }),
    original.native_preimage.response_json + "\n",
  ]) {
    const files = fixture.input.files.map((file) =>
      file.legacy_id === original.legacy_id
        ? { ...file, native_preimage: { ...file.native_preimage, response_json } }
        : file,
    )
    expect(
      (await run(Effect.flip(makeSharedMigrationConversion({ ...fixture.input, files })))).code,
    ).toBe("SHARED_MIGRATION_CONVERSION_PREIMAGE")
  }
})

test("new conversion preserves complete-tree reference checks and unsupported native Markdown boundaries", async () => {
  const missing = migrationConversionFixture({ main: "Read [absent](absent.md)." })
  expect((await run(Effect.flip(makeSharedMigrationConversion(missing.input)))).code).toBe(
    "SHARED_REFERENCE_BROKEN",
  )
  const unsupported = migrationConversionFixture({
    notes: "---\ncustom: retained\n---\n\nSupport body",
  })
  expect((await run(Effect.flip(makeSharedMigrationConversion(unsupported.input)))).code).toBe(
    "SHARED_MARKDOWN_PROJECTION_UNSUPPORTED",
  )
  expect(
    first(unsupported.input.files.filter((file) => file.legacy_id === "old-support")).bytes,
  ).toEqual(migrationEncode("---\ncustom: retained\n---\n\nSupport body"))
  const extraOnly = migrationConversionFixture({
    following: true,
    sourceMain: "---\nmetadata:\n  retained: true\n---\n\nSource body",
  })
  expect((await run(Effect.flip(makeSharedMigrationConversion(extraOnly.input)))).code).toBe(
    "SHARED_FRONTMATTER_UNSUPPORTED",
  )
})

test("large original evidence uses existing bounded immutable input objects and restores only the same frozen plan", async () => {
  const fixture = migrationConversionFixture({
    following: true,
    sourceAsset: new Uint8Array(90_000).fill(255),
  })
  const candidate = await run(makeSharedMigrationConversion(fixture.input))
  const plan = await run(makeSharedMigrationCreatePlan(candidate)),
    manifest = sharedCreateManifest(plan)
  if (plan.version !== 2 || manifest.version !== 2 || !manifest.origin)
    throw new Error("Expected controlled migration origin")
  const retained = await run(sharedMigrationOriginObjects(candidate))
  expect(retained.objects.length).toBeGreaterThan(2)
  for (const object of retained.objects) {
    expect(
      migrationEncode(
        canonicalSharedJson({
          version: 1,
          operation_id: `retain-input-${object.sha256}`,
          payload: { version: 1, kind: "utf8_input", text: object.text },
        }),
      ).length,
    ).toBeLessThan(64 * 1024)
    validateSharedRecordEnvelope(`retain-input-${object.sha256}`, {
      version: 1,
      kind: "utf8_input",
      text: object.text,
    })
  }
  const restored = await run(restoreSharedMigrationCreateOrigin(manifest.origin, retained.objects))
  expect(plan.origin).toEqual(restored)
  expect(await run(validateSharedCreatePlan(plan))).toEqual(plan)
  const parts = retained.objects.map((object, index) =>
    index === 0 ? { ...object, text: object.text + " " } : object,
  )
  expect(
    (await run(Effect.flip(restoreSharedMigrationCreateOrigin(manifest.origin, parts)))).code,
  ).toBe("SHARED_MIGRATION_ORIGIN_INVALID")
})

test("retained origin integrity never substitutes for the original migration approval input", async () => {
  const fixture = migrationConversionFixture(),
    candidate = await run(makeSharedMigrationConversion(fixture.input))
  expect(await run(validateRetainedMigrationConversion(candidate))).toEqual(candidate)
  expect(
    (
      await run(
        Effect.flip(
          validateSharedMigrationConversion(
            { ...fixture.migrationInput, approved_legacy_ids: [] },
            candidate,
          ),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_CREATE_NOT_APPROVED")
  const main = first(candidate.files)
  expect(
    (
      await run(
        Effect.flip(
          validateRetainedMigrationConversion({
            ...candidate,
            files: [
              { ...main, input: { ...main.input, text: "Replaced body" } },
              ...candidate.files.slice(1),
            ],
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_CONVERSION_INVALID")
})
