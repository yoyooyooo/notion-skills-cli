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

async function changedDefault() {
  const fixture = await legacyCommittedPublicationFixture({ sourceOnlyResources: true })
  const proof = structuredClone(fixture.proof)
  const entry = proof.entry_before
  const metadata = property(entry.metadata)
  const activity = property(metadata.legacy_catalog_activity)
  const retained = property(activity.catalog_row)
  const row = JSON.parse(String(retained.json))
  row.properties["Default Context"].checkbox = true
  const currentMetadata = {
    ...metadata,
    legacy_catalog_activity: {
      ...activity,
      catalog_row: retainPublicationJson(row, String(retained.retention_ref)),
    },
  }
  const snapshot = JSON.parse(proof.snapshot.json)
  snapshot.record.default_context = true
  const receipt = JSON.parse(proof.authored_export.receipt.json)
  receipt.record.default_context = true
  return {
    ...proof,
    version: 3,
    policy: "legacy_committed_current_metadata_v3",
    entry_before: {
      ...entry,
      record: { ...property(entry.record), default_context: true },
      metadata: currentMetadata,
    },
    snapshot: retainPublicationJson(snapshot, proof.snapshot.retention_ref),
    authored_export: {
      ...proof.authored_export,
      receipt: retainPublicationJson(receipt, proof.authored_export.receipt.retention_ref),
    },
  }
}

test("a checkbox-only metadata change preserves current supply and exact published body ownership", async () => {
  const proof = await changedDefault()
  const original = structuredClone(proof)
  const result = await publicationRun(resolveLegacyCommittedPublication(proof))
  expect(property(result.entry.record).default_context).toBe(true)
  expect(result.entry.files.every((file) => file.ownership === "following")).toBe(true)
  expect(result.source_binding.files.length).toBe(4)
  expect(property(property(result.entry.metadata).legacy_committed_publication)).toMatchObject({
    version: 3,
    current_terminal_verified: false,
    metadata_transition: { default_context: { published: false, current: true } },
  })
  expect(
    await publicationRun(validateLegacyCommittedPublicationSource(result.source, result.entry)),
  ).toEqual(result)
  expect(proof).toEqual(original)
})

test("saved v2 proofs retain their original strict metadata guard", async () => {
  const proof = await changedDefault()
  const failure = await publicationRun(
    Effect.flip(
      resolveLegacyCommittedPublication({
        ...proof,
        version: 2,
        policy: "legacy_committed_source_bundle_v2",
      }),
    ),
  )
  expect(failure.code).toBe("SHARED_MIGRATION_PUBLICATION_INVALID")
  expect(failure.message).toContain("tracked ownership guard")
})

for (const field of ["Upstream Key", "Upstream Revision", "Published Hash"] as const) {
  test(`checkbox tolerance cannot authorize changed ${field}`, async () => {
    const proof = await changedDefault()
    const metadata = property(proof.entry_before.metadata)
    const activity = property(metadata.legacy_catalog_activity)
    const retained = property(activity.catalog_row)
    const row = JSON.parse(String(retained.json))
    row.properties[field].rich_text = [{ plain_text: "different-owned-value" }]
    const changed = {
      ...proof,
      entry_before: {
        ...proof.entry_before,
        metadata: {
          ...metadata,
          legacy_catalog_activity: {
            ...activity,
            catalog_row: retainPublicationJson(row, String(retained.retention_ref)),
          },
        },
      },
    }
    const failure = await publicationRun(Effect.flip(resolveLegacyCommittedPublication(changed)))
    expect(failure.code).toBe("SHARED_MIGRATION_PUBLICATION_INVALID")
  })
}

test("new metadata policy still rejects changed native content or missing resources", async () => {
  const proof = await changedDefault()
  const snapshot = JSON.parse(proof.snapshot.json)
  snapshot.references[0].markdown += "\nA later uncommitted content edit."
  const failure = await publicationRun(
    Effect.flip(
      resolveLegacyCommittedPublication({ ...proof, snapshot: retainPublicationJson(snapshot) }),
    ),
  )
  expect(failure.code).toBe("SHARED_MIGRATION_PUBLICATION_INVALID")
  const missing = {
    ...proof,
    authored_export: {
      ...proof.authored_export,
      files: proof.authored_export.files.slice(1),
    },
  }
  expect((await publicationRun(Effect.flip(resolveLegacyCommittedPublication(missing)))).code).toBe(
    "SHARED_MIGRATION_PUBLICATION_INVALID",
  )
})

test("an unchanged metadata guard is explicitly recorded without inventing an edit", async () => {
  const fixture = await legacyCommittedPublicationFixture({ sourceOnlyResources: true })
  const result = await publicationRun(
    resolveLegacyCommittedPublication({
      ...fixture.proof,
      version: 3,
      policy: "legacy_committed_current_metadata_v3",
    }),
  )
  expect(property(property(result.entry.metadata).legacy_committed_publication)).toMatchObject({
    metadata_transition: { default_context: { published: false, current: false } },
  })
})

test("an uninterpreted target-mode label does not replace exact source selection or imply a patch", async () => {
  const proof = await changedDefault()
  proof.parent_rows = proof.parent_rows.map((retained) => {
    const row = JSON.parse(retained.json)
    const source = JSON.parse(row.properties.Source.rich_text[0].plain_text)
    source.target_mode = "pstack"
    row.properties.Source.rich_text = [{ plain_text: JSON.stringify(source) }]
    return retainPublicationJson(row, retained.retention_ref)
  })
  const result = await publicationRun(resolveLegacyCommittedPublication(proof))
  expect(property(property(result.source.raw).source).target_mode).toBe("pstack")
  expect(result.source_binding.files.length).toBe(4)
  const patched = {
    ...proof,
    parent_rows: proof.parent_rows.map((retained) => {
      const row = JSON.parse(retained.json)
      const source = JSON.parse(row.properties.Source.rich_text[0].plain_text)
      source.patch = { version: 1, files: [] }
      row.properties.Source.rich_text = [{ plain_text: JSON.stringify(source) }]
      return retainPublicationJson(row, retained.retention_ref)
    }),
  }
  expect((await publicationRun(Effect.flip(resolveLegacyCommittedPublication(patched)))).code).toBe(
    "SHARED_MIGRATION_PUBLICATION_INVALID",
  )
})
