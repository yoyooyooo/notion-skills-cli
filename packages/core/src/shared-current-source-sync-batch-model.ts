import { Schema } from "effect"
import { CurrentSourceIdSchema } from "./shared-current-file.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import type { CurrentSourceSyncItem } from "./shared-current-source-sync-model.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Commit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u))
const Identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
const BatchId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u),
)
const Identities = Schema.Array(Identity).check(
  Schema.makeFilter((ids) => new Set(ids).size === ids.length || "Identities must be unique."),
)
const Selection = {
  resolved_commit: Commit,
  revision: Hash,
  configuration_sha256: Hash,
}
const Content = Schema.Union([
  Schema.Struct({ status: Schema.Literal("not_started") }),
  Schema.Struct({ status: Schema.Literal("published"), ...Selection }),
  Schema.Struct({
    status: Schema.Literal("observed"),
    ...Selection,
    revision: Schema.NullOr(Hash),
  }),
])
const Projection = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["not_requested", "not_started"]) }),
  Schema.Struct({ status: Schema.Literal("complete"), skill_ids: Identities }),
  Schema.Struct({
    status: Schema.Literal("pending"),
    skill_ids: Identities,
    completed_skill_ids: Identities,
  }).check(
    Schema.makeFilter(
      (value) =>
        value.completed_skill_ids.every((id, index) => id === value.skill_ids[index]) ||
        "Completed projections must be an exact target prefix.",
    ),
  ),
])
const Error = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
})
const Item = {
  source_id: CurrentSourceIdSchema,
  operation_id: Schema.NullOr(Identity),
  content: Content,
  projection: Projection,
}

/** The persisted prefix carries the public item, including earlier hard failures. */
export const CurrentSourceSyncItemSchema = Schema.Union([
  Schema.Struct({
    ...Item,
    status: Schema.Literals(["upstream_unchanged", "update_available", "applied", "reconciled"]),
    retryable: Schema.Literal(false),
    error: Schema.Null,
  }),
  Schema.Struct({
    ...Item,
    status: Schema.Literal("skipped"),
    reason: Schema.Literals(["disabled", "pinned", "fixed_ref"]),
    retryable: Schema.Literal(false),
    error: Schema.Null,
  }),
  Schema.Struct({
    ...Item,
    status: Schema.Literals(["pending", "not_started"]),
    retryable: Schema.Literal(true),
    error: Error,
  }),
  Schema.Struct({
    ...Item,
    status: Schema.Literals(["blocked", "failed", "not_started"]),
    retryable: Schema.Literal(false),
    error: Error,
  }),
])

export const CurrentSourceSyncBatchReferenceSchema = Schema.Struct({
  scope: Hash,
  batch_id: BatchId,
})
export type CurrentSourceSyncBatchReference = typeof CurrentSourceSyncBatchReferenceSchema.Type

export function isCurrentSourceSyncBatchTerminal(item: CurrentSourceSyncItem): boolean {
  return !item.retryable && item.status !== "not_started" && item.status !== "update_available"
}

const Batch = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("current_source_sync_batch"),
  scope: Hash,
  batch_id: BatchId,
  library_id: Identity,
  sources_data_source_id: Identity,
  manager_id: Identity,
  execution_id: Identity,
  source_ids: Schema.Array(CurrentSourceIdSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
  ),
  projection: Schema.Literals(["none", "markdown"]),
  started_at: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  results: Schema.Array(CurrentSourceSyncItemSchema).check(Schema.isMaxLength(256)),
})

function validPrefix(value: typeof Batch.Type): boolean {
  return (
    value.source_ids.every((id, index) => index === 0 || value.source_ids[index - 1]! < id) &&
    value.results.length <= value.source_ids.length &&
    value.results.every(
      (item, index) =>
        item.source_id === value.source_ids[index] && isCurrentSourceSyncBatchTerminal(item),
    )
  )
}

/** One unfinished full traversal. It is not a permanent schedule or tick history. */
export const CurrentSourceSyncBatchSchema = Batch.check(
  Schema.makeFilter(
    (value) => validPrefix(value) || "A full batch must retain an exact completed Source prefix.",
  ),
)
export type CurrentSourceSyncBatch = typeof CurrentSourceSyncBatchSchema.Type
export type CurrentSourceSyncBatchIdentity = Pick<
  CurrentSourceSyncBatch,
  | "scope"
  | "library_id"
  | "sources_data_source_id"
  | "manager_id"
  | "execution_id"
  | "source_ids"
  | "projection"
>

export function matchesCurrentSourceSyncBatch(
  batch: CurrentSourceSyncBatch,
  selected: CurrentSourceSyncBatchIdentity,
): boolean {
  return (
    batch.scope === selected.scope &&
    batch.library_id === selected.library_id &&
    batch.sources_data_source_id === selected.sources_data_source_id &&
    batch.manager_id === selected.manager_id &&
    batch.execution_id === selected.execution_id &&
    batch.projection === selected.projection &&
    batch.source_ids.length === selected.source_ids.length &&
    batch.source_ids.every((id, index) => id === selected.source_ids[index])
  )
}

/** SQLite uses this after strict decoding. Equal writes are idempotent; only one
 * terminal result for the exact next Source may advance an existing record. */
export function preservesCurrentSourceSyncBatch(
  before: CurrentSourceSyncBatch,
  after: CurrentSourceSyncBatch,
): boolean {
  return (
    before.version === after.version &&
    before.kind === after.kind &&
    matchesCurrentSourceSyncBatch(before, after) &&
    before.batch_id === after.batch_id &&
    before.started_at === after.started_at &&
    validPrefix(before) &&
    validPrefix(after) &&
    (after.results.length === before.results.length ||
      after.results.length === before.results.length + 1) &&
    before.results.every(
      (item, index) => canonicalSharedJson(item) === canonicalSharedJson(after.results[index]),
    )
  )
}
