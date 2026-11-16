import { Schema } from "effect"
import { ContentKindSchema } from "./model.ts"
import {
  FileEventSchema,
  RetainedContentSchema,
  NativeFileMetadataFields,
} from "./shared-file-state.ts"
import { SharedLibrarySchema } from "./shared-library-model.ts"
import {
  SharedNotionMarkdownPolicySchema,
  SharedNotionMarkdownProjectionSchema,
} from "./shared-notion-projection.ts"
import {
  SharedCreateResourceSchema,
  SharedCreateResourceManifestSchema,
} from "./shared-create-resources.ts"
import {
  SharedSourceProjectionSchema,
  SharedSourceProjectionManifestSchema,
} from "./shared-source-projection-model.ts"
import {
  SharedMigrationCreateOriginSchema,
  SharedMigrationOriginManifestSchema,
} from "./shared-migration-create-origin-model.ts"

// Wire schemas do not import creation, migration or recovery workflows. Parent
// plans can embed them before any of those execution modules have initialized.
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
/** A plan-only draft. FileEventSchema rejects it, so it cannot become a remote
 * ownership fact until the original Skill allocation supplies its real identity. */
const CreateProjectionDraftSchema = Schema.Struct({
  kind: Schema.Literal("source_projection_pending"),
  event_id: Identity,
  file_id: Identity,
  parents: Schema.Array(Identity),
  projection: Schema.Struct({ normalization_version: Schema.Literal(1), sha256: Hash }),
  ...NativeFileMetadataFields,
})
const CreateEventSchema = Schema.Union([FileEventSchema, CreateProjectionDraftSchema])
export const RelationBindingsSchema = Schema.Array(
  Schema.Struct({ page_id: Schema.String, skill_id: Identity }),
)
const PortableProjectionSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  body: Schema.String,
  references: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  materialization: Schema.optional(
    Schema.Struct({ authored: Schema.String, generated: Schema.String }),
  ),
})
const CreatePlanFields = {
  kind: Schema.Literal("skill_create"),
  operation_id: Schema.String.check(Schema.isPattern(/^skill-create-[a-f0-9]{64}$/u)),
  library: SharedLibrarySchema,
  skill_id: Identity,
  content_kind: ContentKindSchema,
  name: Schema.String,
  description: Schema.String,
  default_context: Schema.Boolean,
  enabled: Schema.optional(Schema.Boolean),
  complete_resources: Schema.optional(Schema.Literal(1)),
  resources: Schema.optional(Schema.Array(SharedCreateResourceSchema)),
  original_main_path: Schema.String,
  entrypoint: Schema.String,
  members: Schema.Array(Schema.String),
  requires: Schema.optional(Schema.Array(Schema.String)),
  relation_bindings: Schema.optional(RelationBindingsSchema),
  input_projection: Schema.optional(PortableProjectionSchema),
  source_projection: Schema.optional(SharedSourceProjectionSchema),
  reference_check: Schema.Struct({ checked_files: Schema.Number, local_references: Schema.Number }),
  files: Schema.Array(
    Schema.Struct({
      file_id: Identity,
      path: Schema.String,
      input_path: Schema.String,
      input: Schema.Struct({
        object_id: Identity,
        text: Schema.String,
        sha256: Hash,
        bytes: Schema.Number,
        mode: Schema.optional(Schema.Literals(["100644", "100755"])),
      }),
      projection: SharedNotionMarkdownProjectionSchema,
      content: RetainedContentSchema,
      event: CreateEventSchema,
      ancestors: Schema.optional(Schema.Array(FileEventSchema)),
      baseline_body: Schema.optional(
        Schema.Struct({ markdown: Schema.String, content: RetainedContentSchema }),
      ),
    }),
  ),
}
export const SharedCreatePlanSchema = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), ...CreatePlanFields }),
  Schema.Struct({
    version: Schema.Literal(2),
    ...CreatePlanFields,
    files: Schema.Array(
      Schema.Struct({ ...CreatePlanFields.files.value.fields, event: FileEventSchema }),
    ),
    source_projection: Schema.optionalKey(Schema.Never),
    origin: SharedMigrationCreateOriginSchema,
  }),
])
export type SharedCreatePlan = typeof SharedCreatePlanSchema.Type
const CreateManifestFields = {
  kind: Schema.Literal("skill_create_manifest"),
  operation_id: Schema.String.check(Schema.isPattern(/^skill-create-[a-f0-9]{64}$/u)),
  library: SharedLibrarySchema,
  skill_id: Identity,
  content_kind: ContentKindSchema,
  name: Schema.String,
  description: Schema.String,
  default_context: Schema.Boolean,
  enabled: Schema.optional(Schema.Boolean),
  complete_resources: Schema.optional(Schema.Literal(1)),
  resources: Schema.optional(Schema.Array(SharedCreateResourceManifestSchema)),
  original_main_path: Schema.String,
  entrypoint: Schema.String,
  members: Schema.Array(Schema.String),
  requires: Schema.optional(Schema.Array(Schema.String)),
  relation_bindings: Schema.optional(RelationBindingsSchema),
  input_projection: Schema.optional(PortableProjectionSchema),
  source_projection: Schema.optional(SharedSourceProjectionManifestSchema),
  reference_check: Schema.Struct({ checked_files: Schema.Number, local_references: Schema.Number }),
  files: Schema.Array(
    Schema.Struct({
      file_id: Identity,
      path: Schema.String,
      input_path: Schema.String,
      input: Schema.Struct({
        object_id: Identity,
        sha256: Hash,
        bytes: Schema.Number,
        mode: Schema.optional(Schema.Literals(["100644", "100755"])),
      }),
      projection: SharedNotionMarkdownPolicySchema,
      content: RetainedContentSchema,
      event: CreateEventSchema,
      ancestors: Schema.optional(Schema.Array(FileEventSchema)),
      baseline_body: Schema.optional(Schema.Struct({ content: RetainedContentSchema })),
    }),
  ),
}
export const SharedCreateManifestSchema = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), ...CreateManifestFields }),
  Schema.Struct({
    version: Schema.Literal(2),
    ...CreateManifestFields,
    files: Schema.Array(
      Schema.Struct({ ...CreateManifestFields.files.value.fields, event: FileEventSchema }),
    ),
    source_projection: Schema.optionalKey(Schema.Never),
    origin: SharedMigrationOriginManifestSchema,
  }),
])
export const SharedCreateJournalSchema = Schema.Struct({
  version: Schema.Literal(1),
  scope: Hash,
  library_id: Identity,
  plan: SharedCreatePlanSchema,
  ownership_receipt_version: Schema.optional(Schema.Literal(1)),
  dispatch_receipt_version: Schema.optional(Schema.Literal(1)),
})
