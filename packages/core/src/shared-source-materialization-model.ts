import { Schema } from "effect"
import { ContentRecordSchema, fail, SkillsError } from "./model.ts"

export const SOURCE_MATERIALIZATION_VERSION = 1 as const
const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const SkillId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,199}$/u))
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Readiness = Schema.Literals(["ready", "materializable", "preparing", "blocked", "unknown"])
export const SourceMaterializationTargetSchema = Schema.Struct({
  source_id: Id,
  member_key: Schema.String,
  expected_skill_id: SkillId,
  registration_digest: Hash,
  expected_source_revision: Schema.optional(Hash),
  expected_source_commit: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u))),
})
export type SourceMaterializationTarget = typeof SourceMaterializationTargetSchema.Type
export const SourceMemberCandidateSchema = Schema.Struct({
  type: Schema.Literal("source_member"),
  library_id: Schema.String,
  scope: Schema.String,
  ...SourceMaterializationTargetSchema.fields,
  name: Schema.String,
  alias: Schema.String,
  description: Schema.String,
  enabled: Schema.Boolean,
  readiness: Readiness,
  record: Schema.optional(ContentRecordSchema),
  reason: Schema.optional(Schema.String),
})
export type SourceMemberCandidate = typeof SourceMemberCandidateSchema.Type
export const SourceMaterializationAuthorizationRootSchema = Schema.Struct({
  skill_id: SkillId,
  page_id: Schema.String,
  requires_digest: Hash,
})
export type SourceMaterializationAuthorizationRoot =
  typeof SourceMaterializationAuthorizationRootSchema.Type
export const SourceMemberDiscoverySchema = Schema.Struct({
  version: Schema.Literal(1),
  library_id: Schema.String,
  scope: Schema.String,
  coverage: Schema.Literals(["complete", "partial"]),
  authorization_root: Schema.optional(SourceMaterializationAuthorizationRootSchema),
  root: Schema.optional(ContentRecordSchema),
  candidates: Schema.Array(SourceMemberCandidateSchema),
  failures: Schema.Array(Schema.Struct({ source_id: Schema.String, code: Schema.String })),
  effects: Schema.Struct({ remote_writes: Schema.Literal("none") }),
})
export type SourceMemberDiscovery = typeof SourceMemberDiscoverySchema.Type
export const SourceMaterializationRequestSchema = Schema.Struct({
  version: Schema.Literal(1),
  library: Schema.String,
  request_id: Id,
  purpose: Schema.Literals(["inspect", "use"]),
  target: SourceMaterializationTargetSchema,
  authorization_root: Schema.optional(SourceMaterializationAuthorizationRootSchema),
})
export type SourceMaterializationRequest = typeof SourceMaterializationRequestSchema.Type
export const SourceMaterializationReceiptSchema = Schema.Struct({
  version: Schema.Literal(1),
  request_id: Id,
  library_id: Schema.String,
  scope: Schema.String,
  manager_scope: Schema.optional(Schema.String),
  target: SourceMaterializationTargetSchema,
  authorization_root: Schema.optional(SourceMaterializationAuthorizationRootSchema),
  status: Schema.Literals(["ready", "already_ready", "pending", "blocked"]),
  operation_id: Schema.optional(Id),
  records: Schema.Array(ContentRecordSchema),
  affected_skill_ids: Schema.Array(SkillId),
  source_revisions: Schema.Array(Schema.Struct({ source_id: Id, revision: Hash })),
  effects: Schema.Struct({
    remote_writes: Schema.Literals(["none", "management", "unknown"]),
    projection: Schema.Literal("none"),
  }),
  reason: Schema.optional(Schema.String),
})
export type SourceMaterializationReceipt = typeof SourceMaterializationReceiptSchema.Type
export function decodeSourceMaterializationRequest(input: unknown): SourceMaterializationRequest {
  try {
    const value = Schema.decodeUnknownSync(SourceMaterializationRequestSchema)(input, {
      onExcessProperty: "error",
    })
    const path = value.target.member_key
    if (
      path !== "." &&
      (!path ||
        path.length > 4096 ||
        path.startsWith("/") ||
        /[\\\u0000-\u001f\u007f]/u.test(path) ||
        path
          .split("/")
          .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git"))
    )
      throw fail("SOURCE_MATERIALIZATION_INPUT_INVALID", "Select one exact safe Source member.")
    if (!value.library.trim())
      throw fail("SOURCE_MATERIALIZATION_INPUT_INVALID", "Select one explicit Library.")
    return value
  } catch (error) {
    if (error instanceof SkillsError) throw error
    throw fail(
      "SOURCE_MATERIALIZATION_INPUT_INVALID",
      "Use one bounded exact Source materialization request.",
    )
  }
}
export function decodeSourceMaterializationReceipt(input: unknown): SourceMaterializationReceipt {
  try {
    const value = Schema.decodeUnknownSync(SourceMaterializationReceiptSchema)(input, {
      onExcessProperty: "error",
    })
    const ready = value.status === "ready" || value.status === "already_ready"
    if (value.manager_scope !== undefined && !value.manager_scope.trim())
      throw new Error("Manager scope cannot be empty.")
    if (!ready && value.records.length !== 0)
      throw new Error("Pending records cannot authorize consumption.")
    if (
      ready &&
      !value.records.some(
        (record) =>
          record.locator.type === "shared_skill" &&
          record.locator.library_id === value.library_id &&
          record.locator.skill_id === value.target.expected_skill_id,
      )
    )
      throw new Error("Ready receipt must identify the exact physical root.")
    if (
      value.records.some(
        (record) =>
          record.locator.type !== "shared_skill" || record.locator.library_id !== value.library_id,
      )
    )
      throw new Error("Receipt contains a foreign record.")
    return value
  } catch {
    throw fail(
      "SOURCE_MATERIALIZATION_RECEIPT_INVALID",
      "The manager receipt does not prove the selected Library and root.",
    )
  }
}
