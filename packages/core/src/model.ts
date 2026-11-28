import { Data, Schema } from "effect"
import { SharedLibrarySchema } from "./shared-library-model.ts"
import {
  NativeFileBindingSchema,
  NativeReferenceIndexSchema,
} from "./shared-native-reference-model.ts"
import { SourceResourceConfigurationSchema } from "./shared-source-config-model.ts"

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
    request_status: Schema.optional(
      Schema.Struct({
        type: Schema.Literals(["complete", "incomplete"]),
        incomplete_reason: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  }).check(
    Schema.makeFilter((page) =>
      page.request_status?.type !== "incomplete" && page.request_status?.incomplete_reason == null
        ? true
        : "Notion returned an incomplete query result; has_more does not establish completeness.",
    ),
  )
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
  shared_library: Schema.optional(SharedLibrarySchema),
})
export type Source = typeof SourceSchema.Type
export const CatalogSourceSchema = Schema.Struct({
  alias: Schema.String,
  database_id: Schema.String,
  title: Schema.String,
  data_source_ids: Schema.Array(Schema.String),
  role: Schema.optional(Schema.Literal("content")),
  shared_library: Schema.optional(SharedLibrarySchema),
})
export type CatalogSource = typeof CatalogSourceSchema.Type
export const ContentKindSchema = Schema.Literals(["skill", "router", "prompt"])
export type ContentKind = typeof ContentKindSchema.Type
export const ContentLocatorSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("shared_skill"),
    page_id: Schema.String,
    database_id: Schema.String,
    data_source_id: Schema.String,
    library_id: Schema.String,
    skill_id: Schema.String,
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
  enabled: Schema.optional(Schema.Boolean),
  entrypoint: Schema.String,
  ref: Schema.String,
})
export type ContentRecord = typeof ContentRecordSchema.Type
export type SharedSkillRecord = ContentRecord & {
  readonly locator: Extract<ContentRecord["locator"], { type: "shared_skill" }>
  readonly enabled: boolean
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
  library_id: Schema.optional(Schema.String),
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
  mode: Schema.optional(Schema.Literals(["100644", "100755"])),
})
/** Acquisition locations for the one authoritative Snapshot.files directory.
 * These contain no credentials and never replace its byte/hash/mode identities. */
/** One current acquisition contract. Every source route names its own current
 * Source, so a Skill can use several Sources without an implicit default. */
export const SHARED_ACQUISITION_VERSION = 5
export const SharedSnapshotAcquisitionSchema = Schema.Struct({
  version: Schema.Literal(SHARED_ACQUISITION_VERSION),
  library: SharedLibrarySchema,
  files: Schema.Array(
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("source"),
        path: Schema.String,
        source_id: Schema.String,
        revision: Schema.String,
        source_path: Schema.String,
      }),
      Schema.Struct({
        kind: Schema.Literal("resource"),
        path: Schema.String,
        object_id: Schema.String,
      }),
    ]),
  ),
})
export const SnapshotSchema = Schema.Struct({
  snapshot_id: Schema.String,
  scope: Schema.String,
  record: ContentRecordSchema,
  entrypoint: Schema.String,
  version_id: Schema.String,
  created_at: Schema.Number,
  files: Schema.Array(FileEntrySchema),
  shared_acquisition: Schema.optional(SharedSnapshotAcquisitionSchema),
  file_bindings: Schema.optional(Schema.Array(NativeFileBindingSchema)),
  native_references: Schema.optional(NativeReferenceIndexSchema),
  members: Schema.optional(
    Schema.Array(
      Schema.Struct({ id: Schema.String, ref: Schema.String, metadata: Schema.Unknown }),
    ),
  ),
  required: Schema.optional(
    Schema.Array(
      Schema.Struct({ id: Schema.String, ref: Schema.String, metadata: Schema.Unknown }),
    ),
  ),
  router_members: Schema.optional(
    Schema.Array(
      Schema.Struct({ id: Schema.String, ref: Schema.String, metadata: Schema.Unknown }),
    ),
  ),
})
export type Snapshot = typeof SnapshotSchema.Type
/** Skill and Router selections expose their complete current member bindings. */
export function snapshotMembers(snapshot: Pick<Snapshot, "members" | "router_members">) {
  return snapshot.members ?? snapshot.router_members
}
/** Machine preference contains identities only; the shared Profile owns its rules. */
export const SharedProfileBindingSchema = Schema.Struct({
  library_id: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
  ),
  profile_id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u)),
})
export type SharedProfileBinding = typeof SharedProfileBindingSchema.Type
export const CacheCapacitySchema = Schema.Struct({
  max_bytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  retention_ms: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
})
export const ConfigSchema = Schema.Struct({
  cache_capacity: Schema.optional(CacheCapacitySchema),
  source_resources: Schema.optional(SourceResourceConfigurationSchema),
  sources: Schema.optional(Schema.Array(SourceSchema)),
  shared_profile: Schema.optional(SharedProfileBindingSchema),
  default_library: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
  cache_policy: Schema.optional(
    Schema.Struct({
      read_max_age_ms: Schema.Number,
      catalog_max_age_ms: Schema.Number,
    }),
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
