import { expect, test } from "bun:test"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import {
  resolveLegacyCommittedPublication,
  validateLegacyCommittedPublicationSource,
} from "../src/shared-migration-legacy-publication.ts"
import {
  legacyCommittedPublicationFixture,
  publicationRun,
  retainPublicationJson,
} from "./shared-migration-legacy-publication-fixture.ts"

const fixture = () => legacyCommittedPublicationFixture({ sourceOnlyResources: true })
const rejected = (proof: unknown) =>
  publicationRun(Effect.flip(resolveLegacyCommittedPublication(proof)))

test("versioned source-bundle evidence retains native ownership and every non-page byte without inventing editable pages", async () => {
  const f = await fixture()
  const before = structuredClone(f.proof)
  expect(
    await publicationRun(
      validateLegacyCommittedPublicationSource(f.derived.source, f.derived.entry),
    ),
  ).toEqual(f.derived)
  expect(f.derived.source_binding.files.map((file) => file.path).sort()).toEqual([
    "SKILL.md",
    "assets/data.bin",
    "references/guide.md",
    "scripts/check.py",
  ])
  expect(f.derived.native_files.map((file) => file.path)).toEqual([
    "SKILL.md",
    "references/guide.md",
  ])
  expect(f.derived.entry.files.every((file) => file.ownership === "following")).toBe(true)
  expect(property(property(f.derived.entry.metadata).legacy_committed_publication)).toMatchObject({
    version: 2,
    policy: "legacy_committed_source_bundle_v2",
    current_terminal_verified: false,
    human_edit_intent_inferred: false,
  })
  expect(f.proof).toEqual(before)
})

test("saved version-one publication evidence does not acquire source-only semantics", async () => {
  const f = await fixture()
  const failure = await rejected({
    ...f.proof,
    version: 1,
    policy: "legacy_committed_publication_v1",
  })
  expect(failure.code).toBe("SHARED_MIGRATION_PUBLICATION_INVALID")
  expect(failure.message).toContain("complete ordinary member")
})

test("version and policy must be paired explicitly", async () => {
  const f = await fixture()
  expect((await rejected({ ...f.proof, policy: "legacy_committed_publication_v1" })).code).toBe(
    "SHARED_MIGRATION_PUBLICATION_INVALID",
  )
  expect((await rejected({ ...f.proof, version: 1 })).code).toBe(
    "SHARED_MIGRATION_PUBLICATION_INVALID",
  )
})

for (const field of ["bytes", "sha256"] as const) {
  test(`archive-only ${field} must match the committed snapshot, not merely a filename`, async () => {
    const f = await fixture()
    const snapshot = {
      ...f.snapshot,
      files: f.snapshot.files.map((file) =>
        file.path === "assets/data.bin"
          ? { ...file, [field]: field === "bytes" ? file.bytes + 1 : "0".repeat(64) }
          : file,
      ),
    }
    const failure = await rejected({ ...f.proof, snapshot: retainPublicationJson(snapshot) })
    expect(failure.code).toBe("SHARED_MIGRATION_PUBLICATION_INVALID")
    expect(failure.message).toContain("archive-only resource")
  })
}

test("a former native support cannot be relabeled as archive-only to hide a missing preimage", async () => {
  const f = await fixture()
  const snapshot = { ...f.snapshot, references: f.snapshot.references?.slice(0, 1) }
  const row = structuredClone(f.row)
  property(row.properties.References).rich_text = []
  const metadata = property(f.proof.entry_before.metadata)
  const activity = property(metadata.legacy_catalog_activity)
  const proof = {
    ...f.proof,
    snapshot: retainPublicationJson(snapshot),
    entry_before: {
      ...f.proof.entry_before,
      files: f.proof.entry_before.files.slice(0, 1),
      metadata: {
        ...metadata,
        legacy_catalog_activity: { ...activity, catalog_row: retainPublicationJson(row) },
      },
    },
    native_preimages: f.proof.native_preimages.slice(0, 1),
  }
  const failure = await rejected(proof)
  expect(failure.code).toBe("SHARED_MIGRATION_PUBLICATION_INVALID")
  expect(failure.message).toContain("formerly editable native reference")
})

test("source-only paths remain part of complete export, Git and source manifest verification", async () => {
  const f = await fixture()
  const proof = {
    ...f.proof,
    authored_export: {
      ...f.proof.authored_export,
      files: f.proof.authored_export.files.filter((file) => file.path !== "assets/data.bin"),
    },
  }
  expect((await rejected(proof)).code).toBe("SHARED_MIGRATION_PUBLICATION_INVALID")
  const inspection = property(JSON.parse(f.proof.fixed_source_inspection.json))
  const source = property(inspection.source)
  expect(
    (
      await rejected({
        ...f.proof,
        fixed_source_inspection: retainPublicationJson({
          ...inspection,
          source: {
            ...source,
            files: (source.files as { path: string }[]).filter(
              (file) => file.path !== "assets/data.bin",
            ),
          },
        }),
      })
    ).code,
  ).toBe("SHARED_MIGRATION_PUBLICATION_INVALID")
})

test("source-bundle interpretation cannot borrow derived link projections as native baseline evidence", async () => {
  const f = await fixture()
  const snapshot = { ...f.snapshot, source_files: f.snapshot.files }
  expect((await rejected({ ...f.proof, snapshot: retainPublicationJson(snapshot) })).code).toBe(
    "SHARED_MIGRATION_PUBLICATION_INVALID",
  )
})

test("current source options and edited originals cannot be hidden by archive completeness", async () => {
  const f = await fixture()
  const changed = {
    ...f.proof,
    entry_before: {
      ...f.proof.entry_before,
      files: f.proof.entry_before.files.map((file, index) =>
        index === 0 ? { ...file, body: { ...file.body, sha256: "0".repeat(64) } } : file,
      ),
    },
  }
  expect((await rejected(changed)).message).toContain("differing authored file")
  const parent = structuredClone(f.parentRow)
  const original = parent.properties.Source.rich_text[0]!
  const raw = JSON.parse(original.plain_text)
  raw.patch = { version: 1, files: [] }
  parent.properties.Source = {
    ...parent.properties.Source,
    rich_text: [
      {
        ...original,
        text: { ...original.text, content: JSON.stringify(raw) },
        plain_text: JSON.stringify(raw),
      },
    ],
  }
  expect(
    (
      await rejected({
        ...f.proof,
        parent_rows: [retainPublicationJson(parent), retainPublicationJson(parent)],
      })
    ).message,
  ).toContain("does not reinterpret")
})
