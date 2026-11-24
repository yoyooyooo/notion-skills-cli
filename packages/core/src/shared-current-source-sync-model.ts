import { SharedLibrarySchema } from "./shared-library-model.ts"
import { Schema } from "effect"
import type { RequestBudgetLimits, RequestBudgetSnapshot } from "./request-budget.ts"
import type { RequestMetricsSnapshot } from "./request-metrics.ts"
import { CurrentSourceInputSchema } from "./shared-current-source-input.ts"
import { CurrentSourceSyncBatchReferenceSchema } from "./shared-current-source-sync-batch-model.ts"

export const CURRENT_SOURCE_SYNC_VERSION = 1
export type CurrentSourceCheckRequest = {
  readonly source_ids: readonly string[]
  readonly limits?: Partial<RequestBudgetLimits>
}
export type CurrentSourceSyncRequest = CurrentSourceCheckRequest & {
  readonly manager_id: string
  readonly execution_id: string
  readonly mode?: "changed" | "full"
  readonly projection?: "none" | "markdown"
}
export type CurrentSourceSyncCommand =
  | ({ readonly action: "check" } & CurrentSourceCheckRequest)
  | ({ readonly action: "sync" } & CurrentSourceSyncRequest)

export type CurrentSourceSyncSelection = {
  readonly resolved_commit: string
  readonly revision: string
  readonly configuration_sha256: string
}
export type CurrentSourceSyncContent =
  | { readonly status: "not_started" }
  | ({ readonly status: "published" } & CurrentSourceSyncSelection)
  | {
      readonly status: "observed"
      readonly resolved_commit: string
      readonly configuration_sha256: string
      /** Ref observation alone does not construct a Source manifest revision. */
      readonly revision: string | null
    }
export type CurrentSourceSyncProjection =
  | { readonly status: "not_requested" | "not_started" }
  | { readonly status: "complete"; readonly skill_ids: readonly string[] }
  | {
      readonly status: "pending"
      readonly skill_ids: readonly string[]
      readonly completed_skill_ids: readonly string[]
    }
type CurrentSourceSyncItemBase = {
  readonly source_id: string
  readonly operation_id: string | null
  readonly content: CurrentSourceSyncContent
  readonly projection: CurrentSourceSyncProjection
}
export type CurrentSourceSyncItem = CurrentSourceSyncItemBase &
  (
    | {
        readonly status: "upstream_unchanged" | "update_available" | "applied" | "reconciled"
        readonly retryable: false
        readonly error: null
      }
    | {
        readonly status: "skipped"
        readonly reason: "disabled" | "pinned" | "fixed_ref"
        readonly retryable: false
        readonly error: null
      }
    | {
        readonly status: "pending" | "not_started"
        readonly retryable: true
        readonly error: {
          readonly code: string
          readonly message: string
          readonly details?: unknown
        }
      }
    | {
        readonly status: "blocked" | "failed" | "not_started"
        readonly retryable: false
        readonly error: {
          readonly code: string
          readonly message: string
          readonly details?: unknown
        }
      }
  )
export type CurrentSourceSyncResult = {
  readonly version: 1
  readonly kind: "current_source_sync"
  readonly action: "check" | "sync"
  readonly status: "complete" | "partial" | "blocked" | "retryable" | "failed"
  readonly library_id: string | null
  readonly results: readonly CurrentSourceSyncItem[]
  readonly budget: RequestBudgetSnapshot
  readonly request_metrics: RequestMetricsSnapshot | null
}

export function currentSourceSyncExitCode(result: CurrentSourceSyncResult): 0 | 1 | 75 {
  return result.status === "complete" ? 0 : result.status === "retryable" ? 75 : 1
}

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Commit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u))
const Identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
const Target = Schema.Struct({ skill_id: Identity, page_id: Schema.String })
const Input = Schema.Struct({
  operation_id: Identity,
  declaration: CurrentSourceInputSchema,
  configuration_sha256: Hash,
  resolved_commit: Commit,
  revision: Hash,
  source_page_id: Schema.String,
  baseline_revision: Hash,
  baseline_configuration_sha256: Hash,
  affected_skill_ids: Schema.Array(Identity),
  retirements: Schema.Array(Target),
  projection: Schema.Literals(["none", "markdown"]),
})
const PendingBase = {
  version: Schema.Literal(2),
  library: SharedLibrarySchema,
  kind: Schema.Literal("current_source_sync"),
  scope: Hash,
  manager_id: Identity,
  execution_id: Identity,
  full_batch: Schema.optional(CurrentSourceSyncBatchReferenceSchema),
  input: Input,
}
/** One finite input, tied to the existing Source operation. No tick history. */
export const CurrentSourceSyncPendingSchema = Schema.Union([
  Schema.Struct({ ...PendingBase, phase: Schema.Literal("content") }),
  Schema.Struct({
    ...PendingBase,
    phase: Schema.Literal("projection"),
    targets: Schema.Array(Target),
    next_index: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  }).check(
    Schema.makeFilter((value) => {
      const expected = new Set(value.input.declaration.contributions.map((entry) => entry.skill_id))
      return (
        (value.next_index <= value.targets.length &&
          expected.size === value.targets.length &&
          new Set(value.targets.map((target) => target.skill_id)).size === value.targets.length &&
          value.targets.every((target) => expected.has(target.skill_id))) ||
        "A projection cursor requires the exact frozen target scope."
      )
    }),
  ),
])
export type CurrentSourceSyncPending = typeof CurrentSourceSyncPendingSchema.Type
export const CurrentSourceSyncObservationSchema = Schema.Struct({
  version: Schema.Literal(1),
  scope: Hash,
  source_id: Identity,
  source_page_id: Schema.String,
  configuration_sha256: Hash,
  resolved_commit: Commit,
  revision: Hash,
  completed_at: Schema.Number,
  projection: Schema.Literals(["none", "markdown"]),
})
export type CurrentSourceSyncObservation = typeof CurrentSourceSyncObservationSchema.Type
