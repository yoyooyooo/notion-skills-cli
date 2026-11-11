import { Schema } from "effect"
import { FileEventSchema, RetainedContentSchema } from "./shared-file-state.ts"
import { SharedNotionMarkdownPolicySchema } from "./shared-notion-projection.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))

export const SharedCreateRecoveryBindingSchema = Schema.Struct({
  file_id: Identity,
  path: Schema.String,
  page_id: Schema.String,
  event_id: Identity,
})
export const SharedCreateRecoveryObservationSchema = Schema.Struct({
  file_id: Identity,
  page_id: Schema.String,
  response_json: Schema.String,
  response_sha256: Hash,
  body_sha256: Hash,
  body_bytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
})
export const SharedCreateRecoveryFileSchema = Schema.Struct({
  file_id: Identity,
  path: Schema.String,
  input_sha256: Hash,
  projection: SharedNotionMarkdownPolicySchema,
  content: RetainedContentSchema,
  event: FileEventSchema,
})

/** A complete v2 response was checked before retaining this compact observation. */
export const SharedCreateKnownRecoveryObservationSchema = Schema.Struct({
  file_id: Identity,
  page_id: Schema.String,
  format: Schema.Literal("notion_markdown_v2"),
  normalization_version: Schema.Literal(1),
  response_sha256: Hash,
  body_sha256: Hash,
  body_bytes: SharedCreateRecoveryObservationSchema.fields.body_bytes,
  truncated: Schema.Literal(false),
  unknown_block_count: Schema.Literal(0),
  warning_count: Schema.Literal(0),
  has_more: Schema.Literal(false),
  next_cursor: Schema.Null,
})
export type SharedCreateKnownRecoveryObservation =
  typeof SharedCreateKnownRecoveryObservationSchema.Type

/** The original plan and fixed projection reconstruct metadata and the full event.
 * This commitment saves repeated fields, not bytes from the declared file set. */
export const SharedCreateRecoveryFileCommitmentSchema = Schema.Struct({
  file_id: Identity,
  path: Schema.String,
  input_sha256: Hash,
  body_sha256: Hash,
  body_bytes: SharedCreateRecoveryObservationSchema.fields.body_bytes,
  event_id: Schema.String.check(Schema.isPattern(/^recovery-file-[a-f0-9]{64}$/u)),
})
export type SharedCreateRecoveryObservation = typeof SharedCreateRecoveryObservationSchema.Type
export type SharedCreateRecoveryBinding = typeof SharedCreateRecoveryBindingSchema.Type
export type SharedCreateRecoveryFile = typeof SharedCreateRecoveryFileSchema.Type
