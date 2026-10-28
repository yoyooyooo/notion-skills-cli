import { Effect, Schema } from "effect"
import { fail, property, SkillsError } from "./model.ts"
import type { PlatformError } from "effect/PlatformError"
import { configuration } from "./store.ts"
import { SyncLocal } from "./sync-local.ts"
import {
  applySync,
  AppliedSyncBindingSchema,
  bindSync,
  type BindSyncOptions,
  BindingSchema,
  planSync,
  ReceiptSchema,
  reconcileSync,
  syncStatus,
  type SyncBinding,
} from "./sync.ts"

export interface RunLocalSyncOptions {
  readonly all?: boolean
  readonly from?: "local" | "notion"
}

const NullableString = Schema.NullOr(Schema.String)
const NullableNumber = Schema.NullOr(Schema.Number)
export const LocalSyncCheckSchema = Schema.Struct({
  mode: Schema.Literal("check"),
  online: Schema.Literal(true),
  baseline_advanced: Schema.Literal(false),
  bindings: Schema.Array(
    Schema.Struct({
      binding: BindingSchema,
      logical_path: Schema.String,
      resolved_path: Schema.String,
      baseline_initialized: Schema.Boolean,
      baseline_generation: Schema.Number,
      common_content_id: NullableString,
      local_content_id: NullableString,
      remote_content_id: NullableString,
      remote_snapshot_id: NullableString,
      remote_version: NullableString,
      remote_validated_at: NullableNumber,
      remote_age_ms: NullableNumber,
      remote_stale: Schema.NullOr(Schema.Boolean),
      remote_freshness: Schema.Literal("validated"),
      equality_mode: Schema.Literals(["exact", "page_only", "unknown"]),
      authoritative: Schema.Literal(true),
      provisional: Schema.Literal(false),
      status: Schema.Literals([
        "needs_initialization",
        "unknown",
        "push",
        "pull",
        "unchanged",
        "advance_baseline",
        "conflict",
      ]),
      pending_receipts: Schema.Array(
        Schema.Struct({
          operation_id: Schema.String,
          receipt_path: Schema.String,
        }),
      ),
    }),
  ),
})

const FailureSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
})
export const LocalSyncRunTargetSchema = Schema.Struct({
  page_id: Schema.String,
  binding_ids: Schema.Array(Schema.String),
  phase: Schema.Literals(["reconcile", "plan", "apply", "verified"]),
  verified: Schema.Boolean,
  completed_binding_ids: Schema.Array(Schema.String),
  reconciled_operation_ids: Schema.Array(Schema.String),
  plan_id: Schema.optional(Schema.String),
  operation_id: Schema.optional(Schema.String),
  receipt_path: Schema.optional(Schema.String),
  receipt: Schema.optional(ReceiptSchema),
  bindings: Schema.optional(Schema.Array(AppliedSyncBindingSchema)),
  failure: Schema.optional(FailureSchema),
})
export type LocalSyncRunTarget = typeof LocalSyncRunTargetSchema.Type
export const LocalSyncRunSchema = Schema.Struct({
  mode: Schema.Literal("run"),
  outcome: Schema.Literals(["complete", "partial", "failed"]),
  verified: Schema.Boolean,
  targets: Schema.Array(LocalSyncRunTargetSchema),
})
export type LocalSyncRunResult = typeof LocalSyncRunSchema.Type

/** Current online observation only. Cache population does not publish a common baseline. */
export function checkLocalSync(binding?: string) {
  return Effect.gen(function* () {
    if (binding !== undefined && !binding.trim())
      return yield* Effect.fail(fail("INVALID_ARGUMENT", "Provide a nonempty binding ID or label."))
    const observed = yield* syncStatus(binding, { refresh: true })
    return {
      mode: "check" as const,
      online: true as const,
      baseline_advanced: false as const,
      bindings: observed.bindings,
    }
  })
}

export interface ConnectLocalSyncOptions extends BindSyncOptions {
  readonly from?: "local" | "notion"
}

/** Register one edge and complete its first synchronization through the ordinary run path. */
export function connectLocalSync(target: string, options: ConnectLocalSyncOptions) {
  return Effect.gen(function* () {
    if (options.from !== undefined && options.from !== "local" && options.from !== "notion")
      return yield* Effect.fail(fail("INVALID_ARGUMENT", "Initial source must be local or notion."))
    const registered = yield* bindSync(target, options)
    if (options.dryRun) return { ...registered, verified: false as const }
    let from = options.from
    if (!registered.baseline_initialized && from === undefined) {
      const inspected = yield* (yield* SyncLocal).inspect(registered.logical_path, {
        allowMissing: true,
      })
      if (!inspected.exists) from = "notion"
    }
    const result = yield* runLocalSync(registered.binding.id, { from })
    return { ...registered, ...result }
  })
}
function selectBindings(binding: string | undefined, options: RunLocalSyncOptions) {
  return Effect.gen(function* () {
    if (
      Boolean(binding) === Boolean(options.all) ||
      (binding !== undefined && !binding.trim()) ||
      (options.all && options.from !== undefined) ||
      (options.from !== undefined && options.from !== "local" && options.from !== "notion")
    )
      return yield* Effect.fail(
        fail(
          "INVALID_ARGUMENT",
          "Choose exactly one binding or --all; --from local|notion is single-binding only.",
        ),
      )
    const active = ((yield* configuration).sync_bindings ?? []).filter((item) => item.active)
    const selected = options.all
      ? active
      : active.filter((item) => item.id === binding || item.label === binding)
    if (!selected.length)
      return yield* Effect.fail(
        fail("SYNC_BINDING_MISSING", "No active sync binding matched.", { binding }),
      )
    if (!options.all && selected.length > 1)
      return yield* Effect.fail(
        fail("SYNC_BINDING_AMBIGUOUS", "Use an unambiguous binding ID.", { binding }),
      )
    return selected.sort((a, b) => a.id.localeCompare(b.id))
  })
}

function failed(
  target: LocalSyncRunTarget,
  failure: SkillsError | PlatformError,
): LocalSyncRunTarget {
  const error =
    failure instanceof SkillsError
      ? failure
      : fail("LOCAL_IO_ERROR", failure.message, { platform_error: failure })
  const details = property(error.details)
  const receipt =
    details.receipt === undefined
      ? undefined
      : Schema.decodeUnknownOption(ReceiptSchema)(details.receipt)
  return {
    ...target,
    verified: false,
    ...(typeof details.plan_id === "string" ? { plan_id: details.plan_id } : {}),
    ...(typeof details.operation_id === "string" ? { operation_id: details.operation_id } : {}),
    ...(typeof details.receipt_path === "string" ? { receipt_path: details.receipt_path } : {}),
    ...(receipt && receipt._tag === "Some"
      ? {
          receipt: receipt.value,
          completed_binding_ids: receipt.value.bindings
            .filter((entry) => entry.stage === "complete")
            .map((entry) => entry.binding_id),
        }
      : {}),
    failure: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  }
}

/** Plan each independent page once, then apply those exact saved IDs without retry or replanning. */
export function runLocalSync(binding?: string, options: RunLocalSyncOptions = {}) {
  return Effect.gen(function* () {
    const selected = yield* selectBindings(binding, options)
    const groups = new Map<string, SyncBinding[]>()
    for (const item of selected) {
      const group = groups.get(item.page_id)
      if (group) group.push(item)
      else groups.set(item.page_id, [item])
    }
    const targets: LocalSyncRunTarget[] = []
    for (const [page, participants] of groups) {
      let target: LocalSyncRunTarget = {
        page_id: page,
        binding_ids: participants.map((item) => item.id),
        phase: "reconcile",
        verified: false,
        completed_binding_ids: [],
        reconciled_operation_ids: [],
      }
      const preparation = yield* Effect.gen(function* () {
        const reconciled = new Set<string>()
        for (const item of participants) {
          const observed = yield* syncStatus(item.id)
          const pending = observed.bindings.flatMap((entry) => entry.pending_receipts)
          if (!pending.some((entry) => !reconciled.has(entry.operation_id))) continue
          const recovered = yield* reconcileSync(item.id)
          for (const receipt of recovered.receipts) reconciled.add(receipt.operation_id)
          target = { ...target, reconciled_operation_ids: [...reconciled] }
        }
        target = { ...target, phase: "plan" }
        const plan =
          participants.length === 1
            ? yield* planSync(participants[0]!.id, { from: options.from })
            : yield* planSync(undefined, { bindingIds: participants.map((item) => item.id) })
        target = { ...target, plan_id: plan.plan_id }
      }).pipe(Effect.result)
      if (preparation._tag === "Failure") target = failed(target, preparation.failure)
      targets.push(target)
    }
    // All plans are frozen before the first apply. A later preflight sees drift and rejects it.
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index]!
      if (target.failure || !target.plan_id) continue
      const applying = { ...target, phase: "apply" as const }
      const result = yield* applySync(target.plan_id).pipe(Effect.result)
      targets[index] =
        result._tag === "Failure"
          ? failed(applying, result.failure)
          : {
              ...applying,
              phase: "verified",
              verified: true,
              operation_id: result.success.operation_id,
              receipt_path: result.success.receipt_path,
              receipt: result.success.receipt,
              bindings: result.success.bindings,
              completed_binding_ids: result.success.bindings.map((entry) => entry.binding_id),
            }
    }
    const verified = targets.every((target) => target.verified)
    const partial = targets.some((target) => target.completed_binding_ids.length > 0)
    const result: LocalSyncRunResult = {
      mode: "run",
      outcome: verified ? "complete" : partial ? "partial" : "failed",
      verified,
      targets,
    }
    if (!verified) {
      const first = targets.find((target) => target.failure)!.failure!
      return yield* Effect.fail(
        fail(
          targets.length === 1 ? first.code : partial ? "SYNC_RUN_PARTIAL" : "SYNC_RUN_FAILED",
          "Local sync did not verify every selected target. Retained plans and operations describe each outcome.",
          result,
        ),
      )
    }
    return result
  })
}
