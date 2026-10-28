import { Schema } from "effect"
import { aliasFor, ContentKindSchema } from "./model.ts"
import { ForkBaselineSchema } from "./upstream-model.ts"
import { BodyCompletionJournalSchema } from "./publication-body-completion-model.ts"

export const ListStartRepairSchema = Schema.Struct({
  version: Schema.Literal(1),
  source_intent_index: Schema.Number,
  source_sha256: Schema.String,
  intended_hash: Schema.String,
  page_id: Schema.String,
  block_id: Schema.String,
  list_ordinal: Schema.Number,
  list_start_index: Schema.Literal(0),
  before_roots: Schema.Array(Schema.Unknown),
  original_fence: Schema.optional(
    Schema.Struct({
      state: Schema.String,
      stages: Schema.Array(Schema.String),
      failure: Schema.optional(Schema.Unknown),
      intent_count: Schema.Number,
    }),
  ),
})
export type ListStartRepair = typeof ListStartRepairSchema.Type

export const ZeroListRepairSchema = Schema.Struct({
  version: Schema.Literal(1),
  codec: Schema.Literal("zero-start-paragraphs-v1"),
  original_fence: Schema.Struct({
    state: Schema.String,
    stages: Schema.Array(Schema.String),
    failure: Schema.optional(Schema.Unknown),
    intent_count: Schema.Number,
  }),
  original: ListStartRepairSchema,
  original_intent_count: Schema.Number,
  original_journal_sha256: Schema.String,
  original_guard_paths: Schema.Array(Schema.String),
  original_guards_sha256: Schema.String,
  wire_sha256: Schema.String,
  rejected_field_intent_index: Schema.optional(Schema.Number),
})
export type ZeroListRepair = typeof ZeroListRepairSchema.Type

export const CanonicalCodeLanguageCheckpointSchema = Schema.Struct({
  version: Schema.Literal(1),
  operation_id: Schema.String,
  page_id: Schema.String,
  data_source_id: Schema.String,
  intended_hash: Schema.String,
  intent_index: Schema.Number,
  acknowledged_body_intent_index: Schema.Number,
  path: Schema.String,
  owner_path: Schema.String,
  body_path: Schema.String,
  language: Schema.String,
  canonical_language: Schema.String,
  original_intent_count: Schema.Number,
  original_journal_sha256: Schema.String,
  original_guard_paths: Schema.Array(Schema.String),
  original_guards_sha256: Schema.String,
  original_intent_guards_sha256: Schema.String,
})

export const CompletedCodeLanguageCheckpointSchema = Schema.Struct({
  version: Schema.Literal(1),
  operation_id: Schema.String,
  page_id: Schema.String,
  block_id: Schema.String,
  intent_index: Schema.Literal(3),
  acknowledged_body_intent_index: Schema.Literal(2),
  receipt_sha256: Schema.String,
  journal_sha256: Schema.String,
  intended_hash: Schema.String,
  integrity_sha256: Schema.String,
  guards_sha256: Schema.String,
  intent_guards_sha256: Schema.String,
  source_sha256: Schema.String,
  target_sha256: Schema.String,
  checkpoint: Schema.Struct({ path: Schema.String, before: Schema.String, after: Schema.String }),
  inventory_sha256: Schema.String,
  references_sha256: Schema.String,
  block_before_sha256: Schema.String,
  block_after_sha256: Schema.String,
  metadata_before_sha256: Schema.String,
  metadata_after_sha256: Schema.String,
})
export type CompletedCodeLanguageCheckpoint = typeof CompletedCodeLanguageCheckpointSchema.Type

export const CompletedTableRowCheckpointSchema = Schema.Struct({
  version: Schema.Literal(1),
  operation_id: Schema.String,
  page_id: Schema.String,
  owner_page_id: Schema.String,
  table_id: Schema.String,
  block_id: Schema.String,
  intent_index: Schema.Number,
  acknowledged_body_intent_index: Schema.Number,
  table_ordinal: Schema.Number,
  row_ordinal: Schema.Number,
  receipt_sha256: Schema.String,
  journal_sha256: Schema.String,
  intended_hash: Schema.String,
  integrity_sha256: Schema.String,
  guards_sha256: Schema.String,
  intent_guards_sha256: Schema.String,
  source_sha256: Schema.String,
  target_sha256: Schema.String,
  checkpoints: Schema.Array(
    Schema.Struct({ path: Schema.String, before: Schema.Unknown, after: Schema.Unknown }),
  ),
  root_inventory_sha256: Schema.String,
  table_inventories_sha256: Schema.String,
  sampled_guards_sha256: Schema.String,
  metadata_brackets: Schema.Array(
    Schema.Struct({
      page_id: Schema.String,
      before_sha256: Schema.String,
      after_sha256: Schema.String,
    }),
  ),
})
export type CompletedTableRowCheckpoint = typeof CompletedTableRowCheckpointSchema.Type

export const ObservedMarkdownCorrectionCheckpointSchema = Schema.Struct({
  version: Schema.Literal(1),
  operation_id: Schema.String,
  page_id: Schema.String,
  scope: Schema.String,
  database_id: Schema.String,
  data_source_id: Schema.String,
  intended_hash: Schema.String,
  original_intent_count: Schema.Literal(3),
  original_journal_sha256: Schema.String,
  original_guards: Schema.Record(Schema.String, Schema.Unknown),
  original_guards_sha256: Schema.String,
  original_portable_sha256: Schema.String,
  original_context_sha256: Schema.String,
  original_receipt_sha256: Schema.String,
  integrity_sha256: Schema.String,
  source_sha256: Schema.String,
  target_sha256: Schema.String,
  metadata_before_sha256: Schema.String,
  metadata_after_sha256: Schema.String,
  inventory_sha256: Schema.String,
  references_sha256: Schema.String,
})
export type ObservedMarkdownCorrectionCheckpoint =
  typeof ObservedMarkdownCorrectionCheckpointSchema.Type

export const ContentAdoptionDownloadCheckpointSchema = Schema.Struct({
  version: Schema.Literal(1),
  operation_id: Schema.String,
  page_id: Schema.String,
  plan_id: Schema.String,
  plan_hash: Schema.String,
  intended_hash: Schema.String,
  original_intent_count: Schema.Literal(4),
  original_receipt_sha256: Schema.String,
  original_journal_sha256: Schema.String,
  original_guards_sha256: Schema.String,
  original_plan_sha256: Schema.String,
  original_portable_sha256: Schema.String,
  integrity_sha256: Schema.String,
  native_inputs_sha256: Schema.String,
  content_proof_sha256: Schema.String,
  root_acknowledged_revision: Schema.String,
  root_acknowledged_sha256: Schema.String,
  root_fresh_sha256: Schema.String,
  archive_sha256: Schema.String,
  archive_bytes: Schema.Number,
})

export const ContentAdoptionEditTimeCheckpointSchema = Schema.Struct({
  version: Schema.Literal(1),
  operation_id: Schema.String,
  page_id: Schema.String,
  plan_id: Schema.String,
  plan_hash: Schema.String,
  intended_hash: Schema.String,
  original_intent_count: Schema.Literal(1),
  original_receipt_sha256: Schema.String,
  original_journal_sha256: Schema.String,
  original_guards_sha256: Schema.String,
  original_plan_sha256: Schema.String,
  original_portable_sha256: Schema.String,
  integrity_sha256: Schema.String,
  native_inputs_sha256: Schema.String,
  content_proof_sha256: Schema.String,
  root_before_revision: Schema.String,
  root_acknowledged_revision: Schema.String,
  root_before_sha256: Schema.String,
  root_acknowledged_sha256: Schema.String,
  root_fresh_sha256: Schema.String,
  fields: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      id: Schema.String,
      definition_sha256: Schema.String,
    }),
  ),
})

export const PublicationSourceSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("manual") }),
  Schema.Struct({ type: Schema.Literal("upstream") }),
  Schema.Struct({
    type: Schema.Literal("builtin"),
    builtinId: Schema.String.check(
      Schema.makeFilter((id: string) => {
        try {
          return id.startsWith("notion/") &&
            id === `notion/${aliasFor(decodeURIComponent(id.slice(7)))}`
            ? undefined
            : "Builtin ID must be a canonical notion/<frontmatter-name> alias."
        } catch {
          return "Builtin ID must be a canonical notion/<frontmatter-name> alias."
        }
      }),
    ),
  }),
])
export type PublicationSource = typeof PublicationSourceSchema.Type
export const PublicationSourceIntentSchema = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("preserve") }),
  Schema.Struct({ mode: Schema.Literal("manual_when_supported") }),
  Schema.Struct({ mode: Schema.Literal("set"), value: PublicationSourceSchema }),
])
export type PublicationSourceIntent = typeof PublicationSourceIntentSchema.Type
export const PublicationSourceBindingSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unavailable"), data_source_id: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("bound"),
    data_source_id: Schema.String,
    source_type_id: Schema.String,
    builtin_id_id: Schema.String,
  }),
])
export type PublicationSourceBinding = typeof PublicationSourceBindingSchema.Type

export const PublicationReceiptSchema = Schema.Struct({
  format: Schema.Literal(1),
  operation_id: Schema.String,
  operation: Schema.Literals(["create", "replace", "write"]),
  context: Schema.optional(
    Schema.Struct({
      source_intent: Schema.optional(PublicationSourceIntentSchema),
      content_adoption: Schema.optional(
        Schema.Struct({ plan_id: Schema.String, plan_hash: Schema.String }),
      ),
      markdown_files: Schema.optional(Schema.Boolean),
      write_path: Schema.optional(Schema.String),
      ownership: Schema.optional(
        Schema.Struct({
          subscription_id: Schema.String,
          member_key: Schema.String,
          mode: Schema.Literals(["tracked", "fork"]),
          published_hash: Schema.String,
          revision: Schema.String,
          fork_baseline: Schema.optional(ForkBaselineSchema),
        }),
      ),
      previous_version_id: Schema.optional(Schema.String),
      input_type: Schema.optional(Schema.Literals(["directory", "zip", "markdown"])),
      members: Schema.optional(Schema.Array(Schema.String)),
      allow_same_name: Schema.optional(Schema.Boolean),
      default_context: Schema.optional(Schema.Boolean),
      main_path: Schema.optional(Schema.String),
    }),
  ),
  scope: Schema.mutableKey(Schema.optional(Schema.String)),
  database_id: Schema.mutableKey(Schema.optional(Schema.String)),
  data_source_id: Schema.mutableKey(Schema.optional(Schema.String)),
  page_id: Schema.mutableKey(Schema.optional(Schema.String)),
  source_binding: Schema.mutableKey(Schema.optional(PublicationSourceBindingSchema)),
  state: Schema.mutableKey(
    Schema.Literals(["prepared", "running", "completed", "failed", "unknown"]),
  ),
  portable: Schema.Struct({
    kind: ContentKindSchema,
    name: Schema.String,
    description: Schema.String,
    main: Schema.String,
    files: Schema.mutable(
      Schema.Array(Schema.Struct({ path: Schema.String, sha256: Schema.String })),
    ),
  }),
  guards: Schema.mutableKey(Schema.Record(Schema.String, Schema.mutableKey(Schema.Unknown))),
  intents: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        body: Schema.optional(Schema.Unknown),
        method: Schema.Literals(["GET", "POST", "PATCH"]),
        status: Schema.mutableKey(Schema.Literals(["pending", "completed", "failed", "unknown"])),
        guards: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        response: Schema.mutableKey(Schema.optional(Schema.Unknown)),
        list_start_repair: Schema.optional(ListStartRepairSchema),
        zero_list_repair: Schema.optional(ZeroListRepairSchema),
        typed_links: Schema.mutableKey(
          Schema.optional(
            Schema.Struct({
              page_id: Schema.String,
              markdown: Schema.String,
              state: Schema.mutableKey(Schema.Literals(["pending", "completed"])),
            }),
          ),
        ),
        artifact: Schema.optional(
          Schema.Struct({
            suboperation_id: Schema.String,
            filename: Schema.String,
            sha256: Schema.String,
            byte_length: Schema.Number,
          }),
        ),
        recovery: Schema.mutableKey(
          Schema.optional(
            Schema.Union([
              Schema.Struct({
                kind: Schema.Literal("idempotent_metadata"),
                replacement_suboperation_id: Schema.String,
              }),
              Schema.Struct({
                kind: Schema.Literal("remote_orphan"),
                replacement_suboperation_id: Schema.String,
              }),
              Schema.Struct({
                kind: Schema.Literal("retained_unusable"),
                version: Schema.Literal(1),
                replacement_suboperation_id: Schema.String,
                operation_id: Schema.String,
                intended_hash: Schema.String,
                original_intent_count: Schema.Number,
                allocation_index: Schema.Number,
                send_index: Schema.Number,
                files_intent_index: Schema.optional(Schema.Number),
                upload_id: Schema.String,
                files_property_id: Schema.String,
                files_property_name: Schema.String,
                artifact: Schema.Struct({
                  suboperation_id: Schema.String,
                  filename: Schema.String,
                  sha256: Schema.String,
                  byte_length: Schema.Number,
                }),
                publication_identity_sha256: Schema.String,
                original_journal_sha256: Schema.String,
                original_guards_sha256: Schema.String,
                original_root: Schema.Unknown,
              }),
            ]),
          ),
        ),
      }),
    ),
  ),
  creation_discovery: Schema.mutableKey(Schema.optional(Schema.Array(Schema.Unknown))),
  body_completion: Schema.mutableKey(Schema.optional(BodyCompletionJournalSchema)),
  stages: Schema.mutable(Schema.Array(Schema.String)),
  result: Schema.mutableKey(Schema.optional(Schema.Record(Schema.String, Schema.Unknown))),
  failure: Schema.mutableKey(
    Schema.optional(
      Schema.Struct({
        code: Schema.String,
        message: Schema.String,
        details: Schema.optional(Schema.Unknown),
      }),
    ),
  ),
  conflict: Schema.mutableKey(Schema.optional(Schema.Boolean)),
  conflict_history: Schema.mutableKey(
    Schema.optional(
      Schema.Array(
        Schema.Struct({
          observed_at_ms: Schema.Number,
          conflict: Schema.Literal(true),
          state: Schema.Literals(["prepared", "running", "completed", "failed", "unknown"]),
          stages: Schema.Array(Schema.String),
          failure: Schema.optional(
            Schema.Struct({
              code: Schema.String,
              message: Schema.String,
              details: Schema.optional(Schema.Unknown),
            }),
          ),
          guard_paths: Schema.Array(Schema.String),
          intent_count: Schema.Number,
          intended_hash: Schema.String,
          content_adoption_edit_time_checkpoint: Schema.optional(
            ContentAdoptionEditTimeCheckpointSchema,
          ),
          content_adoption_download_checkpoint: Schema.optional(
            ContentAdoptionDownloadCheckpointSchema,
          ),
          observed_markdown_correction: Schema.optional(ObservedMarkdownCorrectionCheckpointSchema),
          canonical_code_language_checkpoint: Schema.optional(
            CanonicalCodeLanguageCheckpointSchema,
          ),
          completed_code_language_checkpoint: Schema.optional(
            CompletedCodeLanguageCheckpointSchema,
          ),
          completed_table_row_checkpoint: Schema.optional(CompletedTableRowCheckpointSchema),
          body_completion_plan_id: Schema.optional(Schema.String),
          completed_child_checkpoint: Schema.optional(
            Schema.Struct({
              version: Schema.Literal(1),
              operation_id: Schema.String,
              page_id: Schema.String,
              child_id: Schema.String,
              intent_index: Schema.Number,
              intent_sha256: Schema.String,
              receipt_sha256: Schema.String,
              intended_hash: Schema.String,
              integrity_sha256: Schema.String,
              guard_paths: Schema.Array(Schema.String),
              guards_sha256: Schema.String,
              checkpoint: Schema.Struct({
                path: Schema.String,
                before: Schema.String,
                after: Schema.String,
              }),
              inventory_sha256: Schema.String,
              references_sha256: Schema.String,
              metadata_brackets: Schema.Array(
                Schema.Struct({
                  page_id: Schema.String,
                  before_sha256: Schema.String,
                  after_sha256: Schema.String,
                }),
              ),
            }),
          ),
        }),
      ),
    ),
  ),
  owner: Schema.mutableKey(
    Schema.optional(Schema.Struct({ pid: Schema.Number, host: Schema.String })),
  ),
})
const ReceiptSchema = PublicationReceiptSchema
export type Receipt = typeof ReceiptSchema.Type
