import { Schema } from "effect"
import { fail, property, type Snapshot } from "./model.ts"
import { SharedAuthoringEvidenceSchema } from "./shared-authoring.ts"
import type { SharedCreateExpectations } from "./shared-create-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"

/** A completed create is historical. A later read may preserve another user's
 * newer edit, but cannot claim those bytes or properties were this candidate. */
export function verifySharedCreatedSnapshot(
  snapshot: Snapshot,
  input: SharedCreateExpectations & {
    readonly operation_id: string
    readonly skill_page_id: string
    readonly skill_id: string
    readonly entrypoint: string
  },
): void {
  const evidence = Schema.decodeUnknownSync(SharedAuthoringEvidenceSchema)(
    property(snapshot).shared_authoring,
  )
  const locator = snapshot.record.locator
  const files = evidence.files
    .map((file) => ({
      file_id: file.file_id,
      path: file.path,
      page_id: file.page_id,
      sha256: file.body_sha256,
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const expected = [...input.expected_files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )
  const migration = input.expected_migration ?? input.expected_source_projection
  const expectedPaths = migration?.consumed_paths ?? expected.map((file) => file.path)
  const exactInitialEvents =
    migration === undefined ||
    canonicalSharedJson(
      evidence.files
        .map((file) => ({ file_id: file.file_id, heads: file.heads }))
        .sort((a, b) => (a.file_id < b.file_id ? -1 : a.file_id > b.file_id ? 1 : 0)),
    ) ===
      canonicalSharedJson(
        migration.events
          .map((file) => ({ file_id: file.file_id, heads: [file.event_id] }))
          .sort((a, b) => (a.file_id < b.file_id ? -1 : a.file_id > b.file_id ? 1 : 0)),
      )
  const metadata = {
    name: snapshot.record.name,
    description: snapshot.record.description,
    kind: snapshot.record.kind,
    enabled: snapshot.record.enabled,
    default_context: snapshot.record.default_context,
    ...(input.expected_metadata.members !== undefined
      ? {
          members: (snapshot.members ?? snapshot.router_members)
            ?.map((member) => property(member.metadata).page_id)
            .sort(),
        }
      : {}),
    ...(input.expected_metadata.requires === undefined
      ? {}
      : { requires: snapshot.required?.map((member) => property(member.metadata).page_id).sort() }),
  }
  if (
    evidence.snapshot_id !== snapshot.snapshot_id ||
    locator.type !== "shared_skill" ||
    locator.page_id !== input.skill_page_id ||
    locator.skill_id !== input.skill_id ||
    evidence.library_id !== locator.library_id ||
    evidence.skill_page_id !== input.skill_page_id ||
    evidence.skill_id !== input.skill_id ||
    evidence.source_id !== (migration?.source_id ?? "") ||
    evidence.source_revision !== (migration?.source_revision ?? "") ||
    !exactInitialEvents ||
    snapshot.entrypoint !== input.entrypoint ||
    canonicalSharedJson(snapshot.files.map((file) => file.path).sort()) !==
      canonicalSharedJson(expectedPaths) ||
    canonicalSharedJson(files) !== canonicalSharedJson(expected) ||
    canonicalSharedJson(metadata) !== canonicalSharedJson(input.expected_metadata)
  )
    throw fail(
      "WRITE_VERIFICATION_FAILED",
      "The original create completed, but a later current read differs from its frozen files, page bindings or metadata. Preserve that later edit and read the current Skill.",
      { create_operation_id: input.operation_id, requires_fresh_read: true },
    )
}
