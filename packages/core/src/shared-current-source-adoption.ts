import { Crypto, Effect, Schema } from "effect"
import { fail, property, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { sharedSkillProperty, sharedSkillTextProperty } from "./shared-content.ts"
import { currentFileRecord, type CurrentFileBinding } from "./shared-current-index.ts"
import { parseCurrentFileContent, CurrentFileContentSchema } from "./shared-current-file.ts"
import type { CurrentOperationSession } from "./shared-current-operation.ts"
import type { PreparedCurrentSourceTarget } from "./shared-current-source-input.ts"
import { currentRecordText } from "./shared-current-records.ts"
import {
  materializationChecked,
  materializationRecord,
  queryMaterializationPages,
} from "./shared-source-materialization-registration.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"
import {
  LegacySourceRegistrationSchema,
  type LegacySourceRegistration,
} from "./shared-current-source-legacy-registration.ts"
import type { SharedLibrary } from "./shared-library-model.ts"

export type SourceSkillAdoption = {
  readonly skill_id: string
  readonly page_id: string
  readonly main_file_id: string
  readonly metadata_sha256: string
  readonly files: readonly CurrentFileBinding[]
}
export type SourceMaterializationWriteScope = {
  readonly source_page_id: string
  readonly registration_digest: string
  readonly legacy_registration?: LegacySourceRegistration
  readonly skill_ids: readonly string[]
  readonly adoptions: readonly SourceSkillAdoption[]
}
const FileBinding = Schema.Struct({
  file_id: Schema.String,
  page_id: Schema.String,
  skill_page_id: Schema.String,
  path: Schema.String,
  last_edited_time: Schema.String,
  content: CurrentFileContentSchema,
})
export const SourceMaterializationWriteScopeSchema = Schema.Struct({
  source_page_id: Schema.String,
  registration_digest: Schema.String,
  legacy_registration: Schema.optional(LegacySourceRegistrationSchema),
  skill_ids: Schema.Array(Schema.String),
  adoptions: Schema.Array(
    Schema.Struct({
      skill_id: Schema.String,
      page_id: Schema.String,
      main_file_id: Schema.String,
      metadata_sha256: Schema.String,
      files: Schema.Array(FileBinding),
    }),
  ),
})
function optionalField(library: SharedLibrary, raw: unknown, name: string) {
  const id = library.skills.property_ids[name]
  const values = Object.entries(property(property(raw).properties)).flatMap(([key, value]) =>
    key === id || property(value).id === id ? [property(value)] : [],
  )
  if (values.length > 1)
    throw fail("SOURCE_MEMBER_IDENTITY_AMBIGUOUS", "A member has repeated current fields.")
  return values[0]
}
export function uninitializedSourceSkill(library: SharedLibrary, raw: unknown): boolean {
  const content = optionalField(library, raw, "Content")
  const state = optionalField(library, raw, "Current State")
  const operation = optionalField(library, raw, "Operation")
  const body = content === undefined ? "" : text(content.rich_text)
  if (body) return false
  if ((state?.select !== undefined && state.select !== null) || text(operation?.rich_text))
    throw fail(
      "CURRENT_OPERATION_PENDING",
      "An uninitialized member already has a current operation.",
    )
  return true
}
function adoptionMetadata(library: SharedLibrary, raw: unknown) {
  const record = materializationRecord(library, raw)
  if (record.kind !== "skill")
    throw fail(
      "SOURCE_MATERIALIZATION_UNSUPPORTED",
      "A Git Skill member cannot change another content kind.",
    )
  const main_file_id = sharedSkillTextProperty(raw, library, "Main File ID")
  if (!/^[a-z0-9][a-z0-9._-]{0,199}$/u.test(main_file_id))
    throw fail(
      "SOURCE_MEMBER_IDENTITY_AMBIGUOUS",
      "Legacy adoption must preserve one valid Main File ID.",
    )
  return {
    record,
    main_file_id,
    edited_at: property(raw).last_edited_time,
    origin: sharedSkillProperty(raw, library, "Origin"),
    requires: optionalField(library, raw, "Requires"),
  }
}
export function inspectSourceSkillAdoption(library: SharedLibrary, raw: unknown) {
  return Effect.gen(function* () {
    const metadata = yield* materializationChecked(() => {
      if (!uninitializedSourceSkill(library, raw))
        throw fail("SOURCE_MEMBER_ALREADY_CURRENT", "The member already has current authority.")
      return adoptionMetadata(library, raw)
    })
    const locator = metadata.record.locator
    if (locator.type !== "shared_skill")
      return yield* Effect.fail(
        fail("SOURCE_MEMBER_IDENTITY_AMBIGUOUS", "Use a registered Skill owner."),
      )
    const rows = yield* queryMaterializationPages(library, "files", {
      property: library.files.property_ids.Skill,
      relation: { contains: locator.page_id },
    })
    const files = yield* materializationChecked(() =>
      rows.map((row) =>
        currentFileRecord(
          row,
          locator.page_id,
          library.files.data_source_id,
          library.files.property_ids,
        ),
      ),
    )
    // A legacy supporting page with no authority cannot silently become Git or
    // native. Existing current native/resource pages keep their exact bindings.
    return {
      skill_id: locator.skill_id,
      page_id: locator.page_id,
      main_file_id: metadata.main_file_id,
      metadata_sha256: yield* sha256(canonicalSharedJson(metadata)),
      files,
    } satisfies SourceSkillAdoption
  })
}
export function adoptSourceSkill(
  library: SharedLibrary,
  session: CurrentOperationSession,
  adoption: SourceSkillAdoption,
  target: PreparedCurrentSourceTarget,
) {
  return Effect.gen(function* () {
    const main = target.files.find((file) => file.path === "SKILL.md")
    if (main === undefined)
      return yield* Effect.fail(
        fail(
          "SOURCE_MATERIALIZATION_INVALID",
          "A materialized Skill requires its original main file.",
        ),
      )
    const content = {
      ...main.authority,
      sha256: yield* sha256(main.bytes),
      bytes: main.bytes.byteLength,
      mode: main.mode,
    }
    const api = yield* Notion
    const same = (raw: unknown) => {
      const record = materializationRecord(library, raw)
      return (
        record.locator.type === "shared_skill" &&
        record.locator.page_id === adoption.page_id &&
        record.locator.skill_id === adoption.skill_id &&
        sharedSkillTextProperty(raw, library, "Main File ID") === adoption.main_file_id
      )
    }
    yield* session.dispatch<void, Notion | Crypto.Crypto>({
      key: `source:adopt:${adoption.skill_id}`,
      replay: "idempotent",
      request: {
        path: `v1/pages/${adoption.page_id}`,
        options: { method: "PATCH" },
        body: {
          properties: {
            [library.skills.property_ids.Content!]: {
              rich_text: currentRecordText(canonicalSharedJson(content)),
            },
            [library.skills.property_ids["Current State"]!]: { select: { name: "ready" } },
            [library.skills.property_ids.Operation!]: { rich_text: [] },
          },
        },
      },
      observe: () =>
        Effect.gen(function* () {
          const raw = yield* api.request(`v1/pages/${adoption.page_id}`)
          if (!same(raw))
            return yield* Effect.fail(
              fail("SOURCE_MEMBER_IDENTITY_CHANGED", "The legacy physical identity changed."),
            )
          if (!uninitializedSourceSkill(library, raw)) {
            if (
              canonicalSharedJson(
                parseCurrentFileContent(sharedSkillTextProperty(raw, library, "Content")),
              ) === canonicalSharedJson(content)
            )
              return { status: "complete", value: undefined } as const
            return yield* Effect.fail(
              fail(
                "SOURCE_MEMBER_AUTHORITY_CHANGED",
                "The legacy member acquired another authority.",
              ),
            )
          }
          if (
            (yield* sha256(canonicalSharedJson(adoptionMetadata(library, raw)))) !==
            adoption.metadata_sha256
          )
            return yield* Effect.fail(
              fail(
                "SOURCE_MEMBER_IDENTITY_CHANGED",
                "The legacy member changed after materialization admission.",
              ),
            )
          return { status: "missing" } as const
        }),
      acknowledge: (raw) =>
        materializationChecked(() => {
          if (
            !same(raw) ||
            canonicalSharedJson(
              parseCurrentFileContent(sharedSkillTextProperty(raw, library, "Content")),
            ) !== canonicalSharedJson(content)
          )
            throw fail("WRITE_OUTCOME_UNKNOWN", "The exact adopted member was not acknowledged.")
        }),
    })
  })
}
