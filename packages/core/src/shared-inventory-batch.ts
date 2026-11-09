import { Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import {
  executeInventoryImport,
  InventoryImportPlanSchema,
  prepareInventoryImport,
  validateInventoryImport,
} from "./shared-inventory-import.ts"
import {
  SharedLibrarySchema,
  preservesSharedLibraryBindings,
  type SharedLibrary,
} from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256, Store } from "./store.ts"

const ItemSchema = Schema.Struct({
  entity_id: Schema.String,
  approved_manifest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  decision: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("native") }),
    Schema.Struct({ kind: Schema.Literal("verify_existing") }),
    Schema.Struct({
      kind: Schema.Literal("source"),
      source: Schema.String,
      member: Schema.String,
      baselineCommit: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u))),
    }),
  ]),
  enabled: Schema.optional(Schema.Boolean),
})
const ErrorSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
})
export const InventoryBatchInputSchema = Schema.Struct({
  version: Schema.Literal(1),
  reconciliation_id: Schema.String,
  items: Schema.Array(ItemSchema),
})
const PreparedItemSchema = Schema.Union([
  Schema.Struct({
    request: ItemSchema,
    status: Schema.Literal("prepared"),
    plan: InventoryImportPlanSchema,
  }),
  Schema.Struct({
    request: ItemSchema,
    status: Schema.Literal("preparation_failed"),
    error: ErrorSchema,
  }),
])
export const InventoryImportBatchSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("inventory_import_batch"),
  batch_id: Schema.String,
  library: SharedLibrarySchema,
  reconciliation_id: Schema.String,
  items: Schema.Array(PreparedItemSchema),
})
export type InventoryImportBatch = typeof InventoryImportBatchSchema.Type
const batchKey = (id: string) => `plans/shared-inventory-batches/${id}.json`
const errorInfo = (error: SkillsError) => ({
  code: error.code,
  message: error.message,
  ...(error.details === undefined ? {} : { details: error.details }),
})
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("INVENTORY_BATCH_INVALID", "Use a complete bounded inventory batch input."),
  })

export function decodeInventoryBatchInput(input: unknown) {
  return checked(() => {
    const value = Schema.decodeUnknownSync(InventoryBatchInputSchema)(input, {
      onExcessProperty: "error",
    })
    if (
      value.items.length === 0 ||
      value.items.length > 1000 ||
      new Set(value.items.map((item) => item.entity_id)).size !== value.items.length ||
      value.items.some((item) => item.decision.kind === "verify_existing" && item.enabled)
    )
      throw fail(
        "INVENTORY_BATCH_INVALID",
        "Use 1–1000 unique reviewed entities. Existing verification cannot request enablement.",
      )
    return value
  })
}

export function prepareInventoryBatch(library: SharedLibrary, input: unknown) {
  return Effect.gen(function* () {
    const request = yield* decodeInventoryBatchInput(input)
    const items: InventoryImportBatch["items"][number][] = []
    for (const item of request.items) {
      const result = yield* prepareInventoryImport({
        library,
        reconciliationId: request.reconciliation_id,
        entityId: item.entity_id,
        approvedManifest: item.approved_manifest,
        decision: item.decision,
        enabled: item.enabled ?? false,
      }).pipe(Effect.result)
      items.push(
        result._tag === "Success"
          ? { request: item, status: "prepared", plan: result.success }
          : { request: item, status: "preparation_failed", error: errorInfo(result.failure) },
      )
    }
    const contents = {
      version: 1,
      kind: "inventory_import_batch",
      library,
      reconciliation_id: request.reconciliation_id,
      items,
    } satisfies Omit<InventoryImportBatch, "batch_id">
    const batch = {
      ...contents,
      batch_id: `import-batch-${yield* sha256(canonicalSharedJson(contents))}`,
    }
    yield* (yield* Store).writeJson(batchKey(batch.batch_id), batch)
    return batch
  }).pipe(withReadOnlyNotion)
}

export function validateInventoryBatch(input: unknown) {
  return Effect.gen(function* () {
    const batch = yield* checked(() =>
      Schema.decodeUnknownSync(InventoryImportBatchSchema)(input, { onExcessProperty: "error" }),
    )
    yield* decodeInventoryBatchInput({
      version: 1,
      reconciliation_id: batch.reconciliation_id,
      items: batch.items.map((item) => item.request),
    })
    const { batch_id, ...contents } = batch
    if (batch_id !== `import-batch-${yield* sha256(canonicalSharedJson(contents))}`)
      return yield* Effect.fail(fail("INVENTORY_BATCH_INVALID", "The batch digest differs."))
    for (const item of batch.items) {
      if (item.status !== "prepared") continue
      const plan = yield* validateInventoryImport(item.plan)
      if (
        !preservesSharedLibraryBindings(plan.library, batch.library) ||
        plan.reconciliation_id !== batch.reconciliation_id ||
        plan.local_entity.entity_id !== item.request.entity_id ||
        plan.approved_manifest !== item.request.approved_manifest
      )
        return yield* Effect.fail(
          fail("INVENTORY_BATCH_INVALID", "A child plan differs from its reviewed batch scope."),
        )
    }
    return batch
  })
}

type BatchOutcome = {
  readonly entity_id: string
  readonly plan_id: string | null
  readonly status: "preparation_failed" | "not_started" | "failed" | "confirmed" | "validated"
  readonly reused: boolean
  readonly result?: unknown
  readonly error?: typeof ErrorSchema.Type
}
const isolatedContentErrors = new Set([
  "SHARED_CREATE_BODY_MISMATCH",
  "SHARED_CREATE_REVIEW_REQUIRED",
  "BODY_INCOMPLETE",
])

export function executeInventoryBatch(
  library: SharedLibrary,
  input: unknown,
  options: { readonly dryRun?: boolean; readonly reconcile?: boolean } = {},
) {
  const work = Effect.gen(function* () {
    const batch = yield* validateInventoryBatch(input)
    if (!preservesSharedLibraryBindings(batch.library, library))
      return yield* Effect.fail(fail("INVENTORY_IMPORT_SCOPE", "The batch library differs."))
    if (!options.reconcile) {
      const store = yield* Store
      const saved = yield* store.readJson(batchKey(batch.batch_id), InventoryImportBatchSchema)
      if (saved === undefined || canonicalSharedJson(saved) !== canonicalSharedJson(batch))
        return yield* Effect.fail(
          fail("INVENTORY_BATCH_NOT_PREPARED", "Apply requires the exact locally prepared batch."),
        )
      for (const item of batch.items) {
        if (item.status !== "prepared") continue
        const savedPlan = yield* store.readJson(
          `plans/shared-inventory-imports/${item.plan.plan_id}.json`,
          InventoryImportPlanSchema,
        )
        if (
          savedPlan === undefined ||
          canonicalSharedJson(savedPlan) !== canonicalSharedJson(item.plan)
        )
          return yield* Effect.fail(
            fail("INVENTORY_IMPORT_NOT_PREPARED", "Every child needs its original prepared plan."),
          )
      }
    }
    const items: BatchOutcome[] = []
    let halted = false
    for (const item of batch.items) {
      const identity = { entity_id: item.request.entity_id, reused: false }
      if (item.status === "preparation_failed") {
        items.push({ ...identity, plan_id: null, status: item.status, error: item.error })
        continue
      }
      const plan_id = item.plan.plan_id
      if (halted) {
        items.push({ ...identity, plan_id, status: "not_started" })
        continue
      }
      const result = yield* executeInventoryImport(library, item.plan, options).pipe(Effect.result)
      if (result._tag === "Failure") {
        items.push({ ...identity, plan_id, status: "failed", error: errorInfo(result.failure) })
        halted =
          !options.dryRun && !options.reconcile && !isolatedContentErrors.has(result.failure.code)
      } else {
        const verified = "verified" in result.success && result.success.verified === true
        items.push({
          ...identity,
          plan_id,
          status: options.dryRun ? "validated" : verified ? "confirmed" : "failed",
          reused: "reused" in result.success && result.success.reused === true,
          result: result.success,
        })
        halted = !options.dryRun && !options.reconcile && !verified
      }
    }
    const count = (status: BatchOutcome["status"]) =>
      items.filter((item) => item.status === status).length
    return {
      batch_id: batch.batch_id,
      mode: options.reconcile ? "reconcile" : options.dryRun ? "dry_run" : "apply",
      execution_complete: count("not_started") === 0,
      all_confirmed: count("confirmed") === items.length,
      halted,
      atomic: false,
      counts: {
        total: items.length,
        confirmed: count("confirmed"),
        reused: items.filter((item) => item.status === "confirmed" && item.reused).length,
        validated: count("validated"),
        preparation_failed: count("preparation_failed"),
        failed: count("failed"),
        not_started: count("not_started"),
      },
      items,
      measurement: "invocation_outcomes_not_first_pass_success_rate",
      recovery: "reuse_original_batch_and_child_journals; unknown_writes_are_not_replayed",
      ...(options.dryRun || options.reconcile ? { remote_writes: 0 } : {}),
    }
  })
  return options.dryRun || options.reconcile ? work.pipe(withReadOnlyNotion) : work
}
