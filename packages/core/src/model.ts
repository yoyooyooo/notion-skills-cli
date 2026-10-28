import { Data, Effect, Schema } from "effect"
import { SourceProjectionSchema } from "./upstream-member-model.ts"

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
  role: Schema.optional(Schema.Literal("content")),
})
export type Source = typeof SourceSchema.Type
export const CatalogSourceSchema = Schema.Struct({
  alias: Schema.String,
  database_id: Schema.String,
  title: Schema.String,
  data_source_ids: Schema.Array(Schema.String),
  role: Schema.optional(Schema.Literals(["content", "upstream"])),
})
export type CatalogSource = typeof CatalogSourceSchema.Type
export const ContentKindSchema = Schema.Literals(["skill", "router", "prompt"])
export type ContentKind = typeof ContentKindSchema.Type
export const ContentLocatorSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("notion_page"),
    page_id: Schema.String,
    database_id: Schema.String,
    data_source_id: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("notion_subscription"),
    subscription_id: Schema.String,
    database_id: Schema.String,
    data_source_id: Schema.String,
    target_database_id: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("local"), id: Schema.String, entry: Schema.String }),
])
export const ContentRecordSchema = Schema.Struct({
  id: Schema.String,
  kind: ContentKindSchema,
  locator: ContentLocatorSchema,
  name: Schema.String,
  alias: Schema.String,
  description: Schema.String,
  default_context: Schema.Boolean,
  entrypoint: Schema.String,
  ref: Schema.String,
  upstream: Schema.optional(Schema.Struct({ repo: Schema.String })),
})
export type ContentRecord = typeof ContentRecordSchema.Type
export type NotionPageRecord = ContentRecord & {
  readonly locator: Extract<ContentRecord["locator"], { type: "notion_page" }>
}
export function notionPage(record: ContentRecord): NotionPageRecord {
  if (record.locator.type !== "notion_page")
    throw fail("CONTENT_NOT_MUTABLE", "This operation requires a Notion content page.", {
      id: record.id,
      locator: record.locator,
    })
  return record as NotionPageRecord
}
export const entrypointFor = (kind: ContentKind): string =>
  ({ skill: "SKILL.md", router: "ROUTER.md", prompt: "PROMPT.md" })[kind]
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
  databases: Schema.Array(CatalogSourceSchema),
  records: Schema.Array(ContentRecordSchema),
  coverage: CoverageSchema,
})
export type Catalog = typeof CatalogSchema.Type
export const FileEntrySchema = Schema.Struct({
  path: Schema.String,
  bytes: Schema.Number,
  sha256: Schema.String,
})
const NotionBlockNodeSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  has_children: Schema.Boolean,
  text: Schema.optional(Schema.String),
  code: Schema.optional(Schema.Struct({ text: Schema.String, language: Schema.String })),
  numbered_list: Schema.optional(Schema.Struct({ start: Schema.NullOr(Schema.Number) })),
  to_do: Schema.optional(Schema.Struct({ checked: Schema.Boolean })),
  rich_text: Schema.optional(
    Schema.Array(
      Schema.Struct({
        text: Schema.String,
        link: Schema.NullOr(Schema.String),
        bold: Schema.Boolean,
        code: Schema.Boolean,
      }),
    ),
  ),
})
const NotionContainerNodeSchema = Schema.Struct({
  ...NotionBlockNodeSchema.fields,
  parent_id: Schema.String,
  table: Schema.optional(
    Schema.Struct({
      width: Schema.Number,
      header_row: Schema.Boolean,
      header_column: Schema.Boolean,
    }),
  ),
  table_row: Schema.optional(
    Schema.Struct({
      cells: Schema.Array(
        Schema.Array(
          Schema.Struct({
            text: Schema.String,
            link: Schema.NullOr(Schema.String),
            bold: Schema.Boolean,
            code: Schema.Boolean,
          }),
        ),
      ),
    }),
  ),
})
export const NotionBlockBoundarySchema = Schema.Struct({
  ...NotionBlockNodeSchema.fields,
  descendants: Schema.optional(
    Schema.Array(
      Schema.Struct({
        ...NotionBlockNodeSchema.fields,
        parent_id: Schema.String,
      }),
    ),
  ),
  quote_descendants: Schema.optional(Schema.Array(NotionContainerNodeSchema)),
  list_table_descendants: Schema.optional(Schema.Array(NotionContainerNodeSchema)),
  table_evidence: Schema.optional(
    Schema.Struct({
      width: Schema.Number,
      header_row: Schema.Boolean,
      header_column: Schema.Boolean,
      rows: Schema.Array(NotionContainerNodeSchema),
    }),
  ),
})
export const SnapshotSchema = Schema.Struct({
  snapshot_id: Schema.String,
  historical_snapshot_id: Schema.optional(Schema.String),
  scope: Schema.String,
  record: ContentRecordSchema,
  entrypoint: Schema.String,
  version_id: Schema.String,
  created_at: Schema.Number,
  files: Schema.Array(FileEntrySchema),
  source_files: Schema.optional(Schema.Array(FileEntrySchema)),
  source_projection: Schema.optional(SourceProjectionSchema),
  markdown_files: Schema.optional(Schema.Struct({ main: Schema.String })),
  router_members: Schema.optional(
    Schema.Array(
      Schema.Struct({ id: Schema.String, ref: Schema.String, metadata: Schema.Unknown }),
    ),
  ),
  references: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        path: Schema.String,
        markdown: Schema.String,
        blocks: Schema.optional(Schema.Array(NotionBlockBoundarySchema)),
      }),
    ),
  ),
})
export type Snapshot = typeof SnapshotSchema.Type
export const ConfigSchema = Schema.Struct({
  sources: Schema.optional(Schema.Array(SourceSchema)),
  default_database: Schema.optional(Schema.String),
  upstream_database: Schema.optional(Schema.String),
  builtin_database: Schema.optional(Schema.String),
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
export const DisplayNameSchema = Schema.String.check(
  Schema.isPattern(/\S/u),
  Schema.isPattern(/^[^\p{Cc}\p{Cf}\p{Cs}]*$/u),
)

export function validateDisplayName(name: string): string {
  if (!Schema.is(DisplayNameSchema)(name))
    throw fail(
      "INVALID_SKILL_NAME",
      "A Skill name must be nonempty and contain no control characters.",
      {
        name,
      },
    )
  return name
}

export const DESCRIPTION_MAX_CHARACTERS = 2000
export const DescriptionSchema = Schema.String.check(
  Schema.isPattern(/\S/u),
  Schema.isBetweenCodePoints(1, DESCRIPTION_MAX_CHARACTERS),
)
export function validateDescription(description: unknown): string {
  if (!Schema.is(DescriptionSchema)(description))
    throw fail("INVALID_SKILL", "Description must contain 1–2000 Unicode characters.")
  return description
}

export function aliasFor(name: string): string {
  const normalized = validateDisplayName(name)
    .normalize("NFC")
    .toLowerCase()
    .trim()
    .replace(/\s+/gu, "-")
  return Array.from(normalized, (character, index) =>
    /^[\p{L}\p{M}\p{N}_-]$/u.test(character) && !(index === 0 && character === "-")
      ? character
      : encodeURIComponent(character).replace(
          /[!'()*-]/g,
          (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
        ),
  ).join("")
}
export function recordFromPage(
  row: typeof PageSchema.Type,
  source: Source,
  dataSourceId: string,
): NotionPageRecord {
  const properties = Object.values(row.properties).map(property)
  const title = properties.find((p) => p.type === "title")
  const description =
    properties.find((p) => p.id === "notion%3A%2F%2Fskills%2Fdescription_property") ??
    property(row.properties.Description)
  const defaultContext = row.properties["Default Context"]
  const checkbox = property(defaultContext)
  if (
    defaultContext !== undefined &&
    (checkbox.type !== "checkbox" || typeof checkbox.checkbox !== "boolean")
  )
    throw fail("INVALID_RESPONSE", "Default Context must be a checkbox property.", {
      page_id: row.id,
      property: "Default Context",
    })
  const rawKind = row.properties.Kind
  const kindProperty = property(rawKind)
  if (rawKind !== undefined && kindProperty.type !== "select")
    throw fail("INVALID_RESPONSE", "Kind must be a select property.", { page_id: row.id })
  const selectedKind = kindProperty.select
  const kind =
    selectedKind === null || rawKind === undefined
      ? "skill"
      : decode(ContentKindSchema, property(selectedKind).name)
  const upstream = row.properties.Upstream
  if (upstream !== undefined) {
    const relation = property(upstream)
    if (
      relation.type !== "relation" ||
      !Array.isArray(relation.relation) ||
      relation.relation.length > 1 ||
      relation.has_more === true
    )
      throw fail("INVALID_RESPONSE", "Upstream must contain at most one subscription relation.", {
        page_id: row.id,
      })
  }
  const compact = row.id.replaceAll("-", "").toLowerCase()
  if (!/^[a-f0-9]{32}$/.test(compact)) throw fail("INVALID_RESPONSE", "Invalid content page UUID.")
  const page = `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`
  const name = text(title?.title)
  let alias: string
  try {
    alias = aliasFor(name)
  } catch (error) {
    if (!(error instanceof SkillsError)) throw error
    throw fail(error.code, error.message, { page_id: row.id, name })
  }
  return {
    id: `notion_page:${page}`,
    kind,
    locator: {
      type: "notion_page",
      page_id: page,
      database_id: source.database_id,
      data_source_id: dataSourceId,
    },
    name,
    alias,
    description: validateDescription(text(description.rich_text)),
    default_context: defaultContext === undefined ? false : checkbox.checkbox === true,
    entrypoint: entrypointFor(kind),
    ref: `skill://${encodeURIComponent(page)}/${entrypointFor(kind)}`,
  }
}

export function resolveRecord(
  selector: string,
  catalog: Catalog,
  databaseId?: string,
): ContentRecord {
  if (catalog.coverage.failed_sources.length) {
    throw fail(
      "CATALOG_INCOMPLETE",
      "Some skill sources could not be queried; uniqueness cannot be established.",
      catalog.coverage,
    )
  }
  const items = catalog.records.filter(
    (s) => !databaseId || (s.locator.type !== "local" && s.locator.database_id === databaseId),
  )
  const exact = items.find(
    (record) =>
      record.id === selector ||
      (record.locator.type === "notion_page" && record.locator.page_id === selector),
  )
  if (exact) return exact
  const matches = [
    ...new Map(
      items
        .filter(
          (s) =>
            s.name === selector ||
            s.alias === selector ||
            s.id === selector ||
            (s.locator.type === "notion_page" && s.locator.page_id === selector),
        )
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
    throw fail(
      "SKILL_AMBIGUOUS",
      "Multiple skills match; select an exact record ID or pinned ref.",
      {
        selector,
        candidates: matches,
        exact_selectors: matches.map((record) => ({ id: record.id, ref: record.ref })),
        databases: catalog.databases.filter((database) =>
          matches.some(
            (record) =>
              record.locator.type !== "local" &&
              record.locator.database_id === database.database_id,
          ),
        ),
      },
    )
  return matches[0]!
}
