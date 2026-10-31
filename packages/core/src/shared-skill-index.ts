import { Effect } from "effect"
import {
  decode,
  ContentKindSchema,
  entrypointFor,
  fail,
  property,
  text,
  validateDescription,
  validateDisplayName,
  SkillsError,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import type { SharedLibrary } from "./shared-library.ts"
import {
  querySkillFiles,
  readProjectionBaseline,
  type FileRecord,
  type FileBaseline,
} from "./skill-file-index.ts"

export interface SharedBodyBinding {
  readonly file_id: string
  readonly page_id: string
  readonly skill_page_id: string
  readonly path: string
  readonly last_edited_time: string
  readonly baseline?: FileBaseline
}
export interface SharedSkillIndex {
  readonly skill_id: string
  readonly page_id: string
  readonly kind: "skill" | "router" | "prompt"
  readonly name: string
  readonly description: string
  readonly enabled: boolean
  readonly default_context: boolean
  readonly source_reference: string
  readonly main: SharedBodyBinding
  readonly files: readonly FileRecord[]
}

function identity(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value))
    throw fail("SHARED_FILE_IDENTITY_MISSING", `${name} must be a stable identity.`)
  return value
}

/** Metadata only. The actual Files rows remain the editable body pages. */
export function querySharedSkillIndex(
  library: SharedLibrary,
  target: string,
  suppliedPage?: unknown,
) {
  return Effect.gen(function* () {
    const id = pageId(target)
    if (!id) return yield* Effect.fail(fail("INVALID_ARGUMENT", "Select an exact Skill page ID."))
    const raw =
      suppliedPage === undefined ? yield* (yield* Notion).request(`v1/pages/${id}`) : suppliedPage
    const metadata = yield* Effect.try({
      try: () => {
        const row = property(raw),
          parent = property(row.parent)
        if (
          row.object !== "page" ||
          row.id !== id ||
          row.in_trash === true ||
          row.archived === true ||
          parent.type !== "data_source_id" ||
          parent.data_source_id !== library.skills.data_source_id
        )
          throw fail(
            "SHARED_FILE_SCOPE",
            "The selected Skill is unavailable in this exact library.",
          )
        const fields = Object.values(property(row.properties)).map(property)
        const field = (name: string, type: string) => {
          const matches = fields.filter((value) => value.id === library.skills.property_ids[name])
          const value = matches[0]
          if (matches.length !== 1 || !value || value.type !== type)
            throw fail(
              "SHARED_METADATA_INVALID",
              "A registered Skill property is missing or has the wrong type.",
              { property: name },
            )
          return value
        }
        const rich = (name: string) => {
          const value = field(name, "rich_text").rich_text
          if (!Array.isArray(value))
            throw fail("SHARED_METADATA_INVALID", "A Skill property is incomplete.", {
              property: name,
            })
          return text(value)
        }
        const checkbox = (name: string) => {
          const value = field(name, "checkbox").checkbox
          if (typeof value !== "boolean")
            throw fail("SHARED_METADATA_INVALID", "A Skill checkbox is invalid.", {
              property: name,
            })
          return value
        }
        const kind = decode(ContentKindSchema, property(field("Kind", "select").select).name)
        if (
          typeof row.last_edited_time !== "string" ||
          !Number.isFinite(Date.parse(row.last_edited_time))
        )
          throw fail("SHARED_METADATA_INVALID", "The main body has no valid observation timestamp.")
        const projection = readProjectionBaseline(rich("Projection"))
        return {
          skill_id: identity(rich("Skill ID"), "Skill ID"),
          page_id: id,
          kind,
          name: validateDisplayName(text(field("Name", "title").title)),
          description: validateDescription(rich("Description")),
          enabled: checkbox("Enabled"),
          default_context: checkbox("Default Context"),
          source_reference: rich("Source"),
          main: {
            file_id: identity(rich("Main File ID"), "Main File ID"),
            page_id: id,
            skill_page_id: id,
            path: entrypointFor(kind),
            last_edited_time: row.last_edited_time,
            ...(projection ? { baseline: projection } : {}),
          },
        }
      },
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("SHARED_METADATA_INVALID", "The Skill metadata could not be decoded."),
    })
    const files = yield* querySkillFiles({
      dataSourceId: library.files.data_source_id,
      skillPageId: id,
      propertyIds: library.files.property_ids,
    })
    if (
      files.some(
        (file) =>
          file.file_id === metadata.main.file_id ||
          file.page_id === id ||
          file.path === metadata.main.path,
      )
    )
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_CONFLICT",
          "A supporting file collides with the main body identity or entrypoint.",
        ),
      )
    return { ...metadata, files } satisfies SharedSkillIndex
  })
}
