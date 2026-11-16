import { Schema } from "effect"
import { SharedLibrarySchema } from "./shared-library-model.ts"
import { SharedCreatePlanSchema } from "./shared-create-schema.ts"
import { SharedGitSourceBindingSchema } from "./shared-source-binding-model.ts"

export const SourceOnboardingScopeSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("source"),
    source: Schema.String,
    members: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  Schema.Struct({ kind: Schema.Literal("sources"), sources: Schema.Array(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("all") }),
])
export type SourceOnboardingScope = typeof SourceOnboardingScopeSchema.Type

export const SourceOnboardingBindingSchema = Schema.Struct({
  page_id: Schema.String,
  skill_id: Schema.String,
  main_file_id: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  enabled: Schema.Boolean,
  origin: Schema.String,
  member: Schema.String,
  selected_version: Schema.String,
})
export type SourceOnboardingBinding = typeof SourceOnboardingBindingSchema.Type
export const SourceOnboardingBindingDecisionSchema = Schema.Struct({
  member: Schema.String,
  target: Schema.String,
})
export type SourceOnboardingBindingDecision = typeof SourceOnboardingBindingDecisionSchema.Type
const BindingProofSchema = Schema.Literals(["selected_git_source", "explicit_binding_decision"])
const Member = { member_key: Schema.String, name: Schema.String }
export const SourceOnboardingErrorSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  details: Schema.optionalKey(Schema.Unknown),
})
export const SourceOnboardingMemberSchema = Schema.Union([
  Schema.Struct({ ...Member, kind: Schema.Literal("admit") }),
  Schema.Struct({
    ...Member,
    kind: Schema.Literal("registered"),
    target: SourceOnboardingBindingSchema,
    content_verification: Schema.Literal("unobserved"),
  }),
  Schema.Struct({
    ...Member,
    kind: Schema.Literal("bind"),
    before: SourceOnboardingBindingSchema,
    proof: BindingProofSchema,
  }),
  Schema.Struct({
    ...Member,
    kind: Schema.Literal("blocked"),
    reason: Schema.String,
    candidates: Schema.Array(Schema.String),
    original_operations: Schema.Array(Schema.String),
    error: Schema.optionalKey(SourceOnboardingErrorSchema),
  }),
])
export type SourceOnboardingMember = typeof SourceOnboardingMemberSchema.Type
export const SourceOnboardingReportSchema = Schema.Struct({
  version: Schema.Literal(1),
  library_id: Schema.String,
  entry: Schema.String,
  scope: SourceOnboardingScopeSchema,
  observed_at: Schema.Number,
  coverage: Schema.Literals(["complete", "partial"]),
  inventory_count: Schema.Number,
  inventory_issues: Schema.Array(Schema.Struct({ page_id: Schema.String, reason: Schema.String })),
  sources: Schema.Array(
    Schema.Struct({
      source_id: Schema.String,
      page_id: Schema.String,
      fingerprint: Schema.NullOr(Schema.String),
      provider_revision: Schema.NullOr(Schema.String),
      status: Schema.Literals(["reviewed", "disabled", "unavailable"]),
      members: Schema.Array(SourceOnboardingMemberSchema),
      source_routers: Schema.optionalKey(Schema.Array(SourceOnboardingBindingSchema)),
      unresolved_bindings: Schema.Array(
        Schema.Struct({
          page_id: Schema.String,
          member: Schema.String,
          reason: Schema.String,
        }),
      ),
      error: Schema.NullOr(SourceOnboardingErrorSchema),
    }),
  ),
  remote_writes: Schema.Literal(0),
})
export type SourceOnboardingReport = typeof SourceOnboardingReportSchema.Type
const Source = Schema.Struct({
  page_id: Schema.String,
  source_id: Schema.String,
  fingerprint: Schema.String,
})
export const SourceOnboardingActionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("create"),
    source: Source,
    member: Schema.String,
    plan: SharedCreatePlanSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("create_git"),
    source: Source,
    member: Schema.String,
    skill_id: Schema.String,
    main_file_id: Schema.String,
    name: Schema.String,
    description: Schema.String,
    binding: SharedGitSourceBindingSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("bind"),
    source: Source,
    member: Schema.String,
    before: SourceOnboardingBindingSchema,
    proof: BindingProofSchema,
  }),
])
export type SourceOnboardingAction = typeof SourceOnboardingActionSchema.Type
export const SourceOnboardingPlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("source_onboarding"),
  plan_id: Schema.String,
  permission_scope: Schema.String,
  library: SharedLibrarySchema,
  report: SourceOnboardingReportSchema,
  actions: Schema.Array(SourceOnboardingActionSchema),
})
export type SourceOnboardingPlan = typeof SourceOnboardingPlanSchema.Type
