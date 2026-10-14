import { Data, Schema } from "effect"

export class SkillsError extends Data.TaggedError("SkillsError")<{
  readonly code: string
  readonly message: string
  readonly details?: unknown
}> {}

export const fail = (code: string, message: string, details?: unknown) =>
  new SkillsError({ code, message, ...(details === undefined ? {} : { details }) })

const RichText = Schema.Struct({ plain_text: Schema.String })
export const ApiErrorSchema = Schema.Struct({
  object: Schema.Literal("error"),
  code: Schema.String,
})
export const DataSourceSchema = Schema.Struct({
  id: Schema.String,
  parent: Schema.Struct({ database_id: Schema.String }),
  database_type: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.Array(RichText),
  in_trash: Schema.optional(Schema.Boolean),
  properties: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export const PageSchema = Schema.Struct({
  id: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Unknown),
  in_trash: Schema.optional(Schema.Boolean),
})
export const DatabaseSchema = Schema.Struct({
  id: Schema.String,
  database_type: Schema.NullOr(Schema.String),
  title: Schema.Array(RichText),
  data_sources: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  in_trash: Schema.optional(Schema.Boolean),
})
export const listSchema = <S extends Schema.ConstraintDecoder<unknown>>(item: S) =>
  Schema.Struct({
    results: Schema.Array(item),
    has_more: Schema.Boolean,
    next_cursor: Schema.NullOr(Schema.String),
  })
export const ExportSchema = Schema.Struct({
  id: Schema.String,
  version_id: Schema.String,
  url: Schema.String,
})
export const UserSchema = Schema.Struct({ id: Schema.String, object: Schema.String })

export const SourceSchema = Schema.Struct({
  alias: Schema.String,
  database_id: Schema.String,
  title: Schema.String,
  data_source_ids: Schema.Array(Schema.String),
})
export type Source = typeof SourceSchema.Type
export const SkillSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  alias: Schema.String,
  description: Schema.String,
  database_id: Schema.String,
  data_source_id: Schema.String,
  ref: Schema.String,
})
export type Skill = typeof SkillSchema.Type
export const SourceFailureSchema = Schema.Struct({
  id: Schema.String,
  code: Schema.String,
  database_id: Schema.String,
  alias: Schema.String,
  title: Schema.String,
  data_source_id: Schema.optional(Schema.String),
})
export type SourceFailure = typeof SourceFailureSchema.Type
export const CoverageSchema = Schema.Struct({
  method: Schema.String,
  exhaustive: Schema.Boolean,
  queried_data_sources: Schema.Array(Schema.String),
  failed_sources: Schema.Array(SourceFailureSchema),
  search_index_limited: Schema.Boolean,
})
export const CatalogSchema = Schema.Struct({
  scope: Schema.String,
  fetched_at: Schema.Number,
  databases: Schema.Array(SourceSchema),
  skills: Schema.Array(SkillSchema),
  coverage: CoverageSchema,
})
export type Catalog = typeof CatalogSchema.Type
export const FileEntrySchema = Schema.Struct({
  path: Schema.String,
  bytes: Schema.Number,
  sha256: Schema.String,
})
export const SnapshotSchema = Schema.Struct({
  snapshot_id: Schema.String,
  scope: Schema.String,
  skill: SkillSchema,
  skill_name: Schema.String,
  version_id: Schema.String,
  created_at: Schema.Number,
  files: Schema.Array(FileEntrySchema),
  references: Schema.optional(
    Schema.Array(
      Schema.Struct({ id: Schema.String, path: Schema.String, markdown: Schema.String }),
    ),
  ),
})
export type Snapshot = typeof SnapshotSchema.Type
export const ConfigSchema = Schema.Struct({
  sources: Schema.optional(Schema.Array(SourceSchema)),
  default_database: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
  cache_policy: Schema.optional(
    Schema.Struct({
      read_max_age_ms: Schema.Number,
      catalog_max_age_ms: Schema.Number,
    }),
  ),
  sync_bindings: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        label: Schema.String,
        page_id: Schema.String,
        database_id: Schema.String,
        data_source_id: Schema.String,
        scope: Schema.String,
        logical_path: Schema.String,
        active: Schema.Boolean,
        revision: Schema.Number,
      }),
    ),
  ),
})

export function decode<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema)(input)
  } catch {
    throw fail("INVALID_RESPONSE", "The response does not match the expected schema.")
  }
}

export function text(value: unknown): string {
  if (!Array.isArray(value)) return ""
  return value
    .map(
      (item: { plain_text?: string; text?: { content?: string } }) =>
        item?.plain_text ?? item?.text?.content ?? "",
    )
    .join("")
}
export function property(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
export function aliasFor(name: string): string {
  if (!/^[A-Za-z]+(?: [A-Za-z]+)*$/.test(name) || name.trim() !== name || name.length > 64) {
    throw fail(
      "INVALID_SKILL_NAME",
      "Notion Name must contain only English letters with single spaces between words, and be at most 64 characters.",
      { name },
    )
  }
  return name.toLowerCase().replaceAll(" ", "-")
}
export function skillFromPage(
  row: typeof PageSchema.Type,
  source: Source,
  dataSourceId: string,
): Skill {
  const properties = Object.values(row.properties).map(property)
  const title = properties.find((p) => p.type === "title")
  const description =
    properties.find((p) => p.id === "notion%3A%2F%2Fskills%2Fdescription_property") ??
    property(row.properties.Description)
  const name = text(title?.title)
  let alias: string
  try {
    alias = aliasFor(name)
  } catch (error) {
    if (!(error instanceof SkillsError)) throw error
    throw fail(error.code, error.message, { page_id: row.id, name })
  }
  return {
    id: row.id,
    name,
    alias,
    description: text(description.rich_text),
    database_id: source.database_id,
    data_source_id: dataSourceId,
    ref: `skill://${encodeURIComponent(row.id)}/SKILL.md`,
  }
}

export function resolveSkill(selector: string, catalog: Catalog, databaseId?: string): Skill {
  if (catalog.coverage.failed_sources.length) {
    throw fail(
      "CATALOG_INCOMPLETE",
      "Some skill sources could not be queried; uniqueness cannot be established.",
      catalog.coverage,
    )
  }
  const items = catalog.skills.filter((s) => !databaseId || s.database_id === databaseId)
  const matches = [
    ...new Map(
      items
        .filter((s) => s.name === selector || s.alias === selector || s.id === selector)
        .map((s) => [s.id, s]),
    ).values(),
  ]
  if (!matches.length)
    throw fail("SKILL_NOT_FOUND", "No skill matched in the discovered scope.", {
      selector,
      candidates: [],
      coverage: catalog.coverage,
    })
  if (matches.length > 1)
    throw fail("SKILL_AMBIGUOUS", "Multiple skills match; use a page ID or --database.", {
      selector,
      candidates: matches,
      databases: catalog.databases.filter((database) =>
        matches.some((skill) => skill.database_id === database.database_id),
      ),
    })
  return matches[0]!
}
