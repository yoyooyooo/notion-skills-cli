import { Context, Effect, Schema } from "effect"
import { DisplayNameSchema, fail, SkillsError } from "./model.ts"
import type { PortableSkill } from "./portable.ts"
import {
  SourceSpecSchema,
  SourcePatchSchema,
  GitMaterializationSchema,
} from "./upstream-source-model.ts"
import { SourceMemberManifestSchema } from "./upstream-member-model.ts"

export const UpstreamSourceSchema = Schema.Struct({
  provider: SourceSpecSchema,
  patch: Schema.optional(SourcePatchSchema),
  member_patches: Schema.optional(Schema.Record(Schema.String, SourcePatchSchema)),
  shared_target_set: Schema.optional(Schema.String),
  publisher_subscription_id: Schema.optional(Schema.String),
  accepted_ref: Schema.optional(Schema.String),
  strip_prefix: Schema.optional(Schema.String),
  target_prefix: Schema.optional(Schema.String),
  target_mode: Schema.optional(Schema.String),
  require_all_included: Schema.optional(Schema.Boolean),
})
export const PublishedMembersSchema = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.String,
  plan_hash: Schema.String,
  publisher_subscription_id: Schema.String,
  source_manifest: Schema.optional(SourceMemberManifestSchema),
  members: Schema.Array(
    Schema.Struct({
      member_key: Schema.String,
      page_id: Schema.String,
      content_hash: Schema.String,
      revision: Schema.optional(Schema.String),
    }),
  ),
})
export type PublishedMembers = typeof PublishedMembersSchema.Type
export const ProjectionOperationSchema = Schema.Struct({
  operation_id: Schema.String,
  entries: Schema.Array(
    Schema.Struct({
      subscription_id: Schema.String,
      expected_version: Schema.String,
      before: PublishedMembersSchema,
      after: PublishedMembersSchema,
      status: Schema.Literals(["pending", "verified", "conflict", "unknown"]),
    }),
  ),
})
export type ProjectionOperation = typeof ProjectionOperationSchema.Type
export const SubscriptionSyncSchema = Schema.Struct({
  status: Schema.NullOr(Schema.Literals(["running", "succeeded", "partial", "failed"])),
  attempted_at: Schema.NullOr(Schema.String),
  succeeded_at: Schema.NullOr(Schema.String),
  summary: Schema.String,
})
export type SubscriptionSync = typeof SubscriptionSyncSchema.Type
export const SubscriptionSchema = Schema.Struct({
  subscription_id: Schema.String,
  database_id: Schema.String,
  data_source_id: Schema.String,
  target_database_id: Schema.String,
  name: DisplayNameSchema,
  description: Schema.String,
  default_context: Schema.Boolean,
  enabled: Schema.Boolean,
  removed: Schema.Boolean,
  status: Schema.String,
  sync: Schema.optional(SubscriptionSyncSchema),
  source: UpstreamSourceSchema,
  source_url: Schema.optional(Schema.NullOr(Schema.String)),
  roots: Schema.Array(Schema.String),
  include: Schema.Array(Schema.String),
  exclude: Schema.Array(Schema.String),
  mapping: Schema.Record(Schema.String, Schema.String),
  published: Schema.NullOr(PublishedMembersSchema),
  version: Schema.String,
})
export type Subscription = typeof SubscriptionSchema.Type
export type SubscriptionInput = Omit<
  Subscription,
  | "subscription_id"
  | "database_id"
  | "data_source_id"
  | "version"
  | "status"
  | "published"
  | "removed"
  | "sync"
  | "source_url"
>
export const SubscriptionInputSchema = Schema.Struct({
  target_database_id: Schema.String,
  name: DisplayNameSchema,
  description: Schema.String,
  default_context: Schema.Boolean,
  enabled: Schema.Boolean,
  source: UpstreamSourceSchema,
  roots: Schema.Array(Schema.String),
  include: Schema.Array(Schema.String),
  exclude: Schema.Array(Schema.String),
  mapping: Schema.Record(Schema.String, Schema.String),
})
export const FrozenPortableSchema = Schema.Struct({
  kind: Schema.Literal("skill"),
  name: Schema.String,
  description: Schema.String,
  main: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String, hash: Schema.String })),
})
export type FrozenPortable = typeof FrozenPortableSchema.Type
export const ForkBaselineSchema = Schema.Struct({
  version: Schema.Literal(1),
  original_ref: Schema.String,
  revision: Schema.String,
  content_hash: Schema.String,
  portable_ref: Schema.String,
})
export type ForkBaseline = typeof ForkBaselineSchema.Type
export const BindingSchema = Schema.Struct({
  subscription_id: Schema.String,
  member_key: Schema.String,
  target_key: Schema.String,
  page_id: Schema.String,
  generation: Schema.Number,
  mode: Schema.Literals(["tracked", "fork"]),
  active: Schema.Boolean,
  revision: Schema.String,
  published_hash: Schema.String,
  accepted: FrozenPortableSchema,
  materialized: FrozenPortableSchema,
  fork_baseline: Schema.optional(ForkBaselineSchema),
})
export type UpstreamBinding = typeof BindingSchema.Type
export const PlanItemSchema = Schema.Struct({
  member_key: Schema.String,
  target_key: Schema.String,
  action: Schema.Literals(["create", "update", "unchanged", "retain", "fork", "conflict"]),
  reason: Schema.String,
  generation: Schema.Number,
  page_id: Schema.optional(Schema.String),
  expected_version: Schema.optional(Schema.String),
  expected_hash: Schema.optional(Schema.String),
  upstream_hash: Schema.optional(Schema.String),
  git_materialization: Schema.optional(GitMaterializationSchema),
  content_hash: Schema.optional(Schema.String),
  patch_hash: Schema.optional(Schema.String),
  candidate: Schema.optional(FrozenPortableSchema),
  accepted: Schema.optional(FrozenPortableSchema),
  deltas: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      before: Schema.NullOr(Schema.String),
      after: Schema.NullOr(Schema.String),
    }),
  ),
})
export type PlanItem = typeof PlanItemSchema.Type
export const UpstreamPlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  plan_id: Schema.String,
  plan_hash: Schema.String,
  created_at: Schema.Number,
  subscription_id: Schema.String,
  subscription_version: Schema.String,
  scope: Schema.optional(Schema.String),
  database_id: Schema.optional(Schema.String),
  config_hash: Schema.String,
  revision: Schema.String,
  source_manifest: Schema.optional(SourceMemberManifestSchema),
  provenance: Schema.Record(Schema.String, Schema.String),
  publisher_subscription_id: Schema.String,
  target_database_id: Schema.String,
  items: Schema.Array(PlanItemSchema),
})
export type UpstreamPlan = typeof UpstreamPlanSchema.Type
export const OperationItemSchema = Schema.Struct({
  member_key: Schema.String,
  status: Schema.Literals([
    "pending",
    "running",
    "verified",
    "retained",
    "fork",
    "conflict",
    "failed",
    "unknown",
  ]),
  page_id: Schema.optional(Schema.String),
  publication_operation_id: Schema.optional(Schema.String),
  error_code: Schema.optional(Schema.String),
})
export const UpstreamOperationSchema = Schema.Struct({
  operation_id: Schema.String,
  plan_id: Schema.String,
  subscription_id: Schema.String,
  scope: Schema.optional(Schema.String),
  database_id: Schema.optional(Schema.String),
  target_database_id: Schema.optional(Schema.String),
  state: Schema.Literals(["running", "partial", "verified", "unknown"]),
  items: Schema.Array(OperationItemSchema),
  projections: Schema.optional(ProjectionOperationSchema),
})
export type UpstreamOperation = typeof UpstreamOperationSchema.Type
export const SubscriptionIntentSchema = Schema.Struct({
  method: Schema.Literals(["POST", "PATCH"]),
  path: Schema.String,
  payload: Schema.Unknown,
  data_source_id: Schema.String,
  target_database_id: Schema.String,
  source_config_hash: Schema.String,
  correlation: Schema.String,
  origin: Schema.Struct({ database_id: Schema.String, scope: Schema.String }),
  before_version: Schema.optional(Schema.String),
})
export const SubscriptionAdoptionEvidenceSchema = Schema.Struct({
  operation_id: Schema.String,
  scope: Schema.String,
  database_id: Schema.String,
  data_source_id: Schema.String,
  target_database_id: Schema.String,
  source_config_hash: Schema.String,
  page_id: Schema.String,
  created_time: Schema.String,
  creation_evidence: Schema.String,
})
export type SubscriptionAdoptionEvidence = typeof SubscriptionAdoptionEvidenceSchema.Type
const CommandFields = {
  operation_id: Schema.String,
  scope: Schema.String,
  database_id: Schema.String,
  state: Schema.Literals(["running", "unknown", "failed", "verified"]),
  error_code: Schema.optional(Schema.String),
  recovery_generation: Schema.optional(Schema.Number),
  phase: Schema.optional(Schema.Literals(["preparing", "mutation_intended", "response_received"])),
  intent: Schema.optional(SubscriptionIntentSchema),
  preparation_recovery: Schema.optional(Schema.Unknown),
  observation: Schema.optional(
    Schema.Struct({
      coverage: Schema.Literals(["complete", "blocked"]),
      matches: Schema.Array(Schema.String),
      reason: Schema.String,
    }),
  ),
  adoption: Schema.optional(
    Schema.Struct({
      evidence: SubscriptionAdoptionEvidenceSchema,
      plan_hash: Schema.String,
      observed_version: Schema.String,
      applied: Schema.Boolean,
    }),
  ),
}
export const UpstreamCommandOperationSchema = Schema.Union([
  Schema.Struct({
    ...CommandFields,
    domain: Schema.Literal("subscription_add"),
    input_hash: Schema.String,
    input: SubscriptionInputSchema,
    page_id: Schema.optional(Schema.String),
    version: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...CommandFields,
    domain: Schema.Literal("subscription_update"),
    page_id: Schema.String,
    expected_version: Schema.String,
    input: SubscriptionInputSchema,
  }),
  Schema.Struct({
    ...CommandFields,
    domain: Schema.Literal("subscription_remove"),
    page_id: Schema.String,
    expected_version: Schema.String,
  }),
  Schema.Struct({
    ...CommandFields,
    domain: Schema.Literal("upstream_fork"),
    page_id: Schema.String,
    subscription_id: Schema.String,
    member_key: Schema.String,
    expected_version: Schema.String,
    publication_required: Schema.Boolean,
    baseline: Schema.optional(ForkBaselineSchema),
    baseline_operation_ids: Schema.Array(Schema.String),
    baseline_before_ids: Schema.Array(Schema.String),
    publisher_subscription_id: Schema.String,
  }),
  Schema.Struct({
    ...CommandFields,
    domain: Schema.Literal("upstream_track"),
    page_id: Schema.String,
    subscription_id: Schema.String,
    member_key: Schema.String,
    expected_version: Schema.String,
    publication_required: Schema.Boolean,
    baseline_operation_ids: Schema.Array(Schema.String),
    content_hash: Schema.String,
    revision: Schema.String,
  }),
])
export type UpstreamCommandOperation = typeof UpstreamCommandOperationSchema.Type
const PublicOperationFields = {
  operation_id: Schema.String,
  state: Schema.String,
  verified: Schema.Boolean,
  next: Schema.Struct({ argv: Schema.Array(Schema.String), reason: Schema.String }),
  resume_supported: Schema.Boolean,
  outcome: Schema.optional(
    Schema.Literals(["not_observed", "unknown", "needs_safe_resume", "conflict", "verified"]),
  ),
}
const SubscriptionEvidenceSchema = Schema.Struct({
  scope: Schema.String,
  database_id: Schema.String,
  source_config_hash: Schema.optional(Schema.String),
  target_database_id: Schema.optional(Schema.String),
  phase: Schema.optional(Schema.String),
  intent: Schema.optional(SubscriptionIntentSchema),
  preparation_recovery: Schema.optional(Schema.Unknown),
  observation: Schema.optional(
    Schema.Struct({
      coverage: Schema.String,
      matches: Schema.Array(Schema.String),
      reason: Schema.String,
    }),
  ),
  adoption: Schema.optional(
    Schema.Struct({
      evidence: SubscriptionAdoptionEvidenceSchema,
      plan_hash: Schema.String,
      observed_version: Schema.String,
      applied: Schema.Boolean,
    }),
  ),
})
export const UpstreamOperationChildSchema = Schema.Struct({
  domain: Schema.Literals(["publication", "baseline"]),
  operation_id: Schema.String,
  state: Schema.String,
  intended_hash: Schema.optional(Schema.String),
  refs: Schema.Struct({
    page_id: Schema.optional(Schema.String),
    parent_page_id: Schema.optional(Schema.String),
  }),
  next: Schema.Struct({ argv: Schema.Array(Schema.String), reason: Schema.String }),
})
export const UpstreamPublicOperationSchema = Schema.Union([
  Schema.Struct({
    ...PublicOperationFields,
    domain: Schema.Literal("sync_upstream"),
    result: Schema.NullOr(
      Schema.Struct({
        plan_id: Schema.String,
        subscription_id: Schema.String,
        database_id: Schema.optional(Schema.String),
        target_database_id: Schema.optional(Schema.String),
        items: Schema.Array(OperationItemSchema),
        projections: Schema.Array(
          Schema.Struct({
            subscription_id: Schema.String,
            status: Schema.Literals(["pending", "verified", "conflict", "unknown"]),
          }),
        ),
      }),
    ),
  }),
  Schema.Struct({
    ...PublicOperationFields,
    domain: Schema.Literal("subscription_add"),
    result: Schema.NullOr(
      Schema.Struct({
        database_id: Schema.String,
        subscription_id: Schema.optional(Schema.String),
        page_id: Schema.optional(Schema.String),
        input_hash: Schema.String,
        target_database_id: Schema.String,
        name: Schema.String,
        version: Schema.optional(Schema.String),
        evidence: SubscriptionEvidenceSchema,
      }),
    ),
  }),
  Schema.Struct({
    ...PublicOperationFields,
    domain: Schema.Literals(["subscription_update", "subscription_remove"]),
    result: Schema.NullOr(
      Schema.Struct({
        database_id: Schema.String,
        subscription_id: Schema.String,
        page_id: Schema.String,
        evidence: SubscriptionEvidenceSchema,
      }),
    ),
  }),
  Schema.Struct({
    ...PublicOperationFields,
    domain: Schema.Literals(["upstream_fork", "upstream_track"]),
    result: Schema.NullOr(
      Schema.Struct({
        database_id: Schema.String,
        subscription_id: Schema.String,
        page_id: Schema.String,
        member_key: Schema.String,
        mode: Schema.Literals(["fork", "tracked"]),
        expected_version: Schema.String,
        content_hash: Schema.optional(Schema.String),
        revision: Schema.optional(Schema.String),
        error_code: Schema.optional(Schema.String),
        children: Schema.Array(UpstreamOperationChildSchema),
      }),
    ),
  }),
])
export type UpstreamPublicOperation = typeof UpstreamPublicOperationSchema.Type
export interface ManagedContent {
  readonly page_id: string
  readonly version: string
  readonly content_hash: string
  readonly portable: PortableSkill
  readonly ownership?: {
    readonly subscription_id: string
    readonly member_key: string
    readonly mode: "tracked" | "fork"
    readonly published_hash: string
    readonly revision: string
    readonly fork_baseline?: ForkBaseline
  }
}
export interface PublishRequest {
  readonly operation_id: string
  readonly resume_only?: boolean
  readonly portable: PortableSkill
  readonly target_database_id: string
  readonly expected?: { readonly page_id: string; readonly version: string; readonly hash: string }
  readonly ownership: NonNullable<ManagedContent["ownership"]>
  /** Exact member rebuild/restore only. Ordinary apply omits this and keeps name uniqueness. */
  readonly allow_same_name?: boolean
  /** Exact member page checkbox. Ordinary apply omits it; subscription Default Context stays separate. */
  readonly default_context?: boolean
}
export interface VerifiedPublication {
  readonly page_id: string
  readonly version: string
  readonly content_hash: string
  readonly publication_operation_id: string
  readonly verified: true
}
/** Implemented by the content owner through guarded publication, never direct HTTP content writes. */
export class UpstreamPublisher extends Context.Service<
  UpstreamPublisher,
  {
    readonly inspect: (pageId: string) => Effect.Effect<ManagedContent, SkillsError>
    readonly publish: (request: PublishRequest) => Effect.Effect<VerifiedPublication, SkillsError>
    readonly reconcile: (
      operationId: string,
    ) => Effect.Effect<VerifiedPublication | undefined, SkillsError>
    readonly setMode: (request: {
      readonly operation_id?: string
      readonly page_id: string
      readonly expected_version: string
      readonly mode: "tracked" | "fork"
      readonly fork_baseline?: ForkBaseline
      readonly published_hash?: string
      readonly revision?: string
    }) => Effect.Effect<void, SkillsError>
    readonly recoverableBaseline: (
      pageId: string,
      expectedVersion: string,
      accepted?: {
        readonly portable: PortableSkill
        readonly content_hash: string
        readonly revision: string
      },
    ) => Effect.Effect<string, SkillsError>
    readonly readBaseline: (ref: string) => Effect.Effect<PortableSkill, SkillsError>
  }
>()("ntn-skills/UpstreamPublisher") {}

export function strictDecode<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" })
  } catch {
    throw fail("INVALID_UPSTREAM", "Upstream data does not match its strict schema.")
  }
}
export const strictJson = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: string,
): S["Type"] => strictDecode(Schema.fromJsonString(schema), input)
