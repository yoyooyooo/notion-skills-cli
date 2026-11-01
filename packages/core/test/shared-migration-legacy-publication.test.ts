import { expect, test } from "bun:test"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import {
  resolveLegacyCommittedPublication,
  validateLegacyCommittedPublicationSource,
} from "../src/shared-migration-legacy-publication.ts"
import {
  legacyCommittedPublicationFixture,
  publicationHash,
  publicationRun,
  retainPublicationJson,
} from "./shared-migration-legacy-publication-fixture.ts"

test("retained committed publication derives following in the native comparison domain without claiming parent completeness or a terminal operation", async () => {
  const f = await legacyCommittedPublicationFixture(),
    before = structuredClone(f.proof)
  expect(
    await publicationRun(
      validateLegacyCommittedPublicationSource(f.derived.source, f.derived.entry),
    ),
  ).toEqual(f.derived)
  expect(f.derived.entry.files_complete).toBe(true)
  expect(f.derived.entry.metadata_complete).toBe(true)
  expect(f.derived.entry.record).toEqual(f.before_entry.record)
  expect(f.derived.entry.files.every((file) => file.ownership === "following")).toBe(true)
  for (const file of f.derived.entry.files) {
    const original = f.before_entry.files.find((item) => item.path === file.path)
    expect(file.body?.sha256).toBe(file.projection_sha256)
    expect(file.body?.sha256 === original?.body.sha256).toBe(false)
    expect(
      property(property(file.raw).legacy_committed_publication).original_authored_body,
    ).toEqual(original?.body)
  }
  expect(property(f.derived.source.raw).parent_publication_completeness).toBe("not_established")
  expect(property(property(f.derived.entry.metadata).legacy_committed_publication)).toMatchObject({
    retained_observation: true,
    current_terminal_verified: false,
    human_edit_intent_inferred: false,
  })
  expect(f.proof).toEqual(before)
  expect(f.before_entry.files_complete).toBe(false)
  expect(f.before_entry.files.every((file) => file.ownership === "unknown")).toBe(true)
})

test("changing native and snapshot reference together cannot borrow unchanged committed file hashes", async () => {
  const f = await legacyCommittedPublicationFixture(),
    first = f.proof.native_preimages[0]
  if (!first) throw new Error("Missing controlled native preimage")
  const changed = "A later native edit that was not committed."
  const response = retainPublicationJson({
    object: "page_markdown",
    id: first.page_id,
    markdown: changed,
    truncated: false,
    unknown_block_ids: [],
  })
  const native = {
    ...first,
    response_json: response.json,
    response_sha256: response.sha256,
    response_bytes: response.bytes,
    body_sha256: publicationHash(changed),
  }
  const snapshot = {
    ...f.snapshot,
    references: f.snapshot.references?.map((page) =>
      page.path === first.path ? { ...page, markdown: changed } : page,
    ),
  }
  const result = await publicationRun(
    Effect.flip(
      resolveLegacyCommittedPublication({
        ...f.proof,
        snapshot: retainPublicationJson(snapshot),
        native_preimages: [native, ...f.proof.native_preimages.slice(1)],
      }),
    ),
  )
  expect(result.code).toBe("SHARED_MIGRATION_PUBLICATION_INVALID")
  expect(result.message).toContain("materialized file hashes")
})

test("selected member revisions and nonempty transformations cannot be reinterpreted as a fixed Source", async () => {
  const f = await legacyCommittedPublicationFixture()
  const source = {
    provider: { type: "git", url: "https://github.com/example/skills.git", ref: "main" },
    strip_prefix: "skills",
    target_mode: "manual",
    patch: { version: 1, files: [] },
  }
  const parent = {
    ...f.parentRow,
    properties: {
      ...f.parentRow.properties,
      Source: {
        ...f.parentRow.properties.Source,
        rich_text: [{ plain_text: JSON.stringify(source) }],
      },
    },
  }
  const patched = {
    ...f.proof,
    parent_rows: [retainPublicationJson(parent), retainPublicationJson(parent)],
  }
  expect((await publicationRun(Effect.flip(resolveLegacyCommittedPublication(patched)))).code).toBe(
    "SHARED_MIGRATION_PUBLICATION_INVALID",
  )
  const inspected = property(JSON.parse(f.proof.fixed_source_inspection.json))
  const wrongRevision = {
    ...inspected,
    source: { ...property(inspected.source), commit: "b".repeat(40) },
  }
  expect(
    (
      await publicationRun(
        Effect.flip(
          resolveLegacyCommittedPublication({
            ...f.proof,
            fixed_source_inspection: retainPublicationJson(wrongRevision),
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_PUBLICATION_INVALID")
})

test("authored export must bind the exact record, snapshot, full inventory and retained source bytes", async () => {
  const f = await legacyCommittedPublicationFixture(),
    original = property(JSON.parse(f.proof.authored_export.receipt.json))
  for (const change of [
    { ref: "skill://another/SKILL.md?snapshot=" + f.snapshot.snapshot_id },
    { snapshot_id: "s_" + "c".repeat(64) },
    { content_id: "d".repeat(64) },
  ]) {
    const proof = {
      ...f.proof,
      authored_export: {
        ...f.proof.authored_export,
        receipt: retainPublicationJson({ ...original, ...change }),
      },
    }
    expect((await publicationRun(Effect.flip(resolveLegacyCommittedPublication(proof)))).code).toBe(
      "SHARED_MIGRATION_PUBLICATION_INVALID",
    )
  }
  const missing = {
    ...f.proof,
    authored_export: { ...f.proof.authored_export, files: f.proof.authored_export.files.slice(1) },
  }
  expect((await publicationRun(Effect.flip(resolveLegacyCommittedPublication(missing)))).code).toBe(
    "SHARED_MIGRATION_PUBLICATION_INVALID",
  )
})

test("truncation, missing native files and a changed derived following descriptor remain hard failures", async () => {
  const f = await legacyCommittedPublicationFixture(),
    first = f.proof.native_preimages[0]
  if (!first) throw new Error("Missing controlled native response")
  const raw = property(JSON.parse(first.response_json)),
    response = retainPublicationJson({ ...raw, truncated: true })
  const truncated = {
    ...first,
    response_json: response.json,
    response_sha256: response.sha256,
    response_bytes: response.bytes,
  }
  expect(
    (
      await publicationRun(
        Effect.flip(
          resolveLegacyCommittedPublication({
            ...f.proof,
            native_preimages: [truncated, ...f.proof.native_preimages.slice(1)],
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_PUBLICATION_INVALID")
  expect(
    (
      await publicationRun(
        Effect.flip(
          resolveLegacyCommittedPublication({
            ...f.proof,
            native_preimages: f.proof.native_preimages.slice(1),
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_PUBLICATION_INVALID")
  const changed = {
    ...f.derived.entry,
    files: f.derived.entry.files.map((file) => ({ ...file, source_id: "different-source" })),
  }
  expect(
    (
      await publicationRun(
        Effect.flip(validateLegacyCommittedPublicationSource(f.derived.source, changed)),
      )
    ).code,
  ).toBe("SHARED_MIGRATION_PUBLICATION_INVALID")
})
