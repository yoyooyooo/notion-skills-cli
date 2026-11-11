import { Schema } from "effect"

/** The original native response is durable dispatch evidence, independent of execution. */
export const SourceMutationAcknowledgementSchema = Schema.Struct({
  version: Schema.Literal(1),
  operation_id: Schema.String,
  request_hash: Schema.String,
  response_hash: Schema.String,
  acknowledged_at: Schema.Number,
  response: Schema.Unknown,
})

/** Mutable discovery configuration is separate from an immutable file Source pin. */
export const SourceAdapterSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("git"), url: Schema.String, ref: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("registry"),
    base_url: Schema.String,
    owner: Schema.String,
    slug: Schema.String,
    version: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("github-market"),
    url: Schema.String,
    ref: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("linear"),
    resources: Schema.Array(
      Schema.Struct({
        kind: Schema.Literals(["issue", "document"]),
        id: Schema.String,
        path: Schema.String,
      }),
    ),
  }),
])
export const SourceDefinitionInputSchema = Schema.Struct({
  version: Schema.Literal(1),
  source_id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  enabled: Schema.Boolean,
  policy: Schema.Literals(["manual", "pinned", "auto"]),
  adapter: SourceAdapterSchema,
  selection: Schema.Struct({
    roots: Schema.Array(Schema.String),
    include: Schema.Array(Schema.String),
    exclude: Schema.Array(Schema.String),
    mapping: Schema.Record(Schema.String, Schema.String),
  }),
  /** Provider-independent options, including retained explicit transformations.
   * Unknown executable options are refused by the adapter, never ignored. */
  options: Schema.Record(Schema.String, Schema.Unknown),
})
export type SourceDefinitionInput = typeof SourceDefinitionInputSchema.Type
export type SourceAdapter = typeof SourceAdapterSchema.Type
export type SourceDefinition = SourceDefinitionInput & {
  readonly page_id: string
  readonly fingerprint: string
  readonly status: string
  readonly last_revision: string
  readonly last_checked: number | null
  readonly last_result: string
}

export const sourceDefinitionProperties = {
  Name: { title: {} },
  "Source ID": { rich_text: {} },
  Description: { rich_text: {} },
  Provider: {
    select: { options: ["git", "linear", "registry", "github-market"].map((name) => ({ name })) },
  },
  Location: { rich_text: {} },
  Ref: { rich_text: {} },
  Selection: { rich_text: {} },
  Options: { rich_text: {} },
  Enabled: { checkbox: {} },
  Policy: { select: { options: ["manual", "pinned", "auto"].map((name) => ({ name })) } },
  Status: {
    select: {
      options: ["ready", "checking", "checked", "applied", "blocked", "failed"].map((name) => ({
        name,
      })),
    },
  },
  "Last Checked": { date: {} },
  "Last Revision": { rich_text: {} },
  "Last Result": { rich_text: {} },
} as const

export function sourceDefinitionLayout(skills: string, records: string) {
  return {
    ...sourceDefinitionProperties,
    Skills: {
      relation: { data_source_id: skills, dual_property: { synced_property_name: "Origin" } },
    },
    Records: {
      relation: { data_source_id: records, dual_property: { synced_property_name: "Origin" } },
    },
  }
}
