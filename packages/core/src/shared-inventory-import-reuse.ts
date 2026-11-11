import { Effect, Schema } from "effect"
import { decode, fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { sharedRecordFromPage } from "./shared-content.ts"
import { SharedCreateManifestSchema, sharedCreateManifestEntity } from "./shared-create-model.ts"
import { decodeSharedCreateOutcome, sharedCreateOutcomeId } from "./shared-create-outcome.ts"
import { fingerprintSkillInput } from "./shared-input-fingerprint.ts"
import { preservesSharedLibraryBindings, type SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson, querySharedRecords } from "./shared-records.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
export const InventoryImportReuseSchema = Schema.Struct({
  kind: Schema.Literal("reuse_import"),
  page_id: Schema.String,
  skill_id: Schema.String,
  operation_id: Schema.String,
  input_content_sha256: Hash,
  manifest_sha256: Hash,
  outcome_sha256: Hash,
})
export type InventoryImportReuse = typeof InventoryImportReuseSchema.Type
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("INVENTORY_IMPORT_RECEIPT_INVALID", "The retained import receipt is invalid."),
  })

/** A matching input plus a completed original import permits only a read-only
 * skip. It does not claim today's Notion content is unchanged or grant adoption. */
export function inspectReusableNativeImport(input: {
  readonly library: SharedLibrary
  readonly pageId: string
  readonly skillId: string
  readonly inputContentSha256: string
}) {
  return Effect.gen(function* () {
    const { library } = input
    const raw = yield* (yield* Notion).request(`v1/pages/${input.pageId}`)
    const record = yield* checked(() =>
      sharedRecordFromPage(
        raw,
        {
          alias: library.library_id,
          database_id: library.skills.database_id,
          title: "",
          data_source_ids: [library.skills.data_source_id],
          shared_library: library,
          role: "content",
        },
        library.skills.data_source_id,
      ),
    )
    if (
      record.locator.page_id !== input.pageId ||
      record.locator.skill_id !== input.skillId ||
      property(raw).archived === true ||
      property(raw).in_trash === true ||
      property(raw).is_archived === true
    )
      return yield* Effect.fail(
        fail(
          "INVENTORY_IMPORT_SCOPE",
          "The prior import target is no longer the same accessible Skill.",
        ),
      )
    const manifests = yield* querySharedRecords(library, {
      skillPageId: input.pageId,
      kind: "operation",
      entityId: sharedCreateManifestEntity,
    })
    const matches: InventoryImportReuse[] = []
    for (const row of manifests) {
      const manifest = yield* checked(() => decode(SharedCreateManifestSchema, row.payload))
      if (
        manifest.version !== 1 ||
        manifest.source_projection !== undefined ||
        manifest.complete_resources !== 1
      )
        continue
      if (
        manifest.skill_id !== input.skillId ||
        manifest.operation_id !== row.record_id ||
        manifest.operation_id !== row.operation_id ||
        !preservesSharedLibraryBindings(manifest.library, library)
      )
        return yield* Effect.fail(
          fail(
            "INVENTORY_IMPORT_SCOPE",
            "The retained manifest belongs to another import or library.",
          ),
        )
      const fingerprint = yield* fingerprintSkillInput({
        main: manifest.original_main_path,
        files: [
          ...manifest.files.map((file) => ({
            path: file.input_path,
            sha256: file.input.sha256,
            bytes: file.input.bytes,
            mode: file.input.mode ?? null,
          })),
          ...(manifest.resources ?? []).map((file) => ({
            path: file.input_path,
            sha256: file.content.sha256,
            bytes: file.content.bytes,
            mode: file.content.mode,
          })),
        ],
      })
      if (fingerprint !== input.inputContentSha256) continue
      const outcomes = yield* querySharedRecords(library, {
        skillPageId: input.pageId,
        kind: "operation",
        recordId: sharedCreateOutcomeId(manifest.operation_id),
      })
      const outcomeRow = outcomes[0]
      if (outcomes.length !== 1 || outcomeRow === undefined)
        return yield* Effect.fail(
          fail(
            "INVENTORY_PREVIOUS_IMPORT_INCOMPLETE",
            "The same input has an original import without one confirmed completion; resume that operation instead of reimporting.",
            {
              page_id: input.pageId,
              operation_id: manifest.operation_id,
            },
          ),
        )
      const outcome = yield* checked(() => decodeSharedCreateOutcome(outcomeRow))
      if (outcome.status !== "applied")
        return yield* Effect.fail(
          fail(
            "INVENTORY_PREVIOUS_IMPORT_INCOMPLETE",
            "The original import still requires recovery; identical input is not a success receipt.",
            {
              page_id: input.pageId,
              operation_id: manifest.operation_id,
            },
          ),
        )
      const expectedFiles = [...manifest.files, ...(manifest.resources ?? [])]
        .map((file) => [file.file_id, file.path])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      const actualFiles = outcome.bindings
        .map((file) => [file.file_id, file.path])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      if (
        outcome.version !== 1 ||
        outcome.source_projection !== undefined ||
        outcome.skill_id !== input.skillId ||
        outcome.skill_page_id !== input.pageId ||
        outcome.operation_id !== manifest.operation_id ||
        canonicalSharedJson(expectedFiles) !== canonicalSharedJson(actualFiles) ||
        outcome.bindings.find((file) => file.path === manifest.entrypoint)?.page_id !== input.pageId
      )
        return yield* Effect.fail(
          fail(
            "INVENTORY_IMPORT_RECEIPT_INVALID",
            "The original completion does not bind this exact complete imported tree.",
          ),
        )
      matches.push({
        kind: "reuse_import",
        page_id: input.pageId,
        skill_id: input.skillId,
        operation_id: manifest.operation_id,
        input_content_sha256: fingerprint,
        manifest_sha256: row.hash,
        outcome_sha256: outcomeRow.hash,
      })
    }
    if (matches.length > 1)
      return yield* Effect.fail(
        fail(
          "INVENTORY_IMPORT_AMBIGUOUS",
          "Multiple completed imports claim this input; do not choose by hash alone.",
        ),
      )
    return matches[0]
  }).pipe(withReadOnlyNotion)
}
