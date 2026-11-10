import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { withReadOnlyNotion } from "../../core/src/notion-readonly.ts"
import { property } from "../../core/src/model.ts"
import {
  decodeInventoryBatchInput,
  executeInventoryBatch,
  prepareInventoryBatch,
  validateInventoryBatch,
  interruptedInventoryBatch,
  type InventoryImportBatch,
  type InventoryBatchProgress,
} from "../../core/src/shared-inventory-batch.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { withSourceCommandBudget } from "../../core/src/shared-source-budget.ts"
import { withSourceUpdateLock } from "../../core/src/shared-source-policy.ts"
import { Store } from "../../core/src/store.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"
import { readSourceJson } from "./command-source-input.ts"
import { parseSourceBudget, sourceRequestBudgets } from "./commands-library-source-run.ts"

const entry = requiredSingleton("entry", "Exact reviewed shared library entry")
const output = singleton("output", "Optional complete report in a new or identical JSON file")
const maximumBytes = 192 * 1024 * 1024
const saveReport = (value: object, destination: Option.Option<string>) =>
  Effect.gen(function* () {
    const path = Option.getOrUndefined(destination)
    if (path !== undefined)
      yield* (yield* Store).output(
        path,
        new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n"),
      )
    yield* emit(value)
  })

function boundedBatch(
  batch: InventoryImportBatch,
  entry: string,
  limits: Parameters<typeof withSourceCommandBudget>[1],
  options: { readonly dryRun?: boolean; readonly reconcile?: boolean },
) {
  return Effect.suspend(() => {
    let progress: InventoryBatchProgress | undefined
    return withSourceCommandBudget(
      Effect.gen(function* () {
        const library = yield* loadSharedLibrary(entry)
        const work = executeInventoryBatch(library, batch, {
          ...options,
          onProgress: (value) => {
            progress = value
          },
        })
        return yield* options.reconcile ? work : withSourceUpdateLock(library, work)
      }),
      limits,
    ).pipe(
      Effect.catchIf(
        (error) => error.code === "REQUEST_BUDGET_EXHAUSTED",
        (error) =>
          progress === undefined
            ? Effect.fail(error)
            : Effect.succeed({
                result: interruptedInventoryBatch(progress, error),
                budget: property(error.details).budget,
              }),
      ),
    )
  })
}

const prepare = defineCommand(
  "prepare-imports",
  {
    entry,
    input: requiredSingleton(
      "input",
      "Reviewed batch JSON with exact entity manifests and decisions",
    ),
    output: requiredSingleton(
      "output",
      "Save the complete immutable batch, including preparation failures",
    ),
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const input = yield* decodeInventoryBatchInput(
        yield* readSourceJson(args.input, maximumBytes),
      )
      const limits = yield* parseSourceBudget(args)
      const { result: batch, budget } = yield* withSourceCommandBudget(
        Effect.gen(function* () {
          return yield* prepareInventoryBatch(yield* loadSharedLibrary(args.entry), input)
        }),
        limits,
      )
      yield* (yield* Store).output(
        args.output,
        new TextEncoder().encode(JSON.stringify(batch, null, 2) + "\n"),
      )
      const prepared = batch.items.filter((item) => item.status === "prepared").length
      yield* emit({
        batch_id: batch.batch_id,
        output: args.output,
        counts: {
          total: batch.items.length,
          prepared,
          preparation_failed: batch.items.length - prepared,
        },
        items: batch.items.map((item) =>
          item.status === "prepared"
            ? { entity_id: item.request.entity_id, status: item.status, plan_id: item.plan.plan_id }
            : { entity_id: item.request.entity_id, status: item.status, error: item.error },
        ),
        remote_writes: 0,
        budget,
      })
      if (prepared !== batch.items.length) process.exitCode = 4
    }).pipe(withReadOnlyNotion),
).pipe(
  Command.withDescription(
    "Prepare every approved entity serially through the existing import kernel. Retain all preparation failures in the same batch; never drop a file or infer sharing authority. No remote writes occur. Partial preparation saves the complete batch and exits 4.",
  ),
)

const apply = defineCommand(
  "apply-imports",
  {
    batch: Argument.String("batch"),
    entry,
    dryRun: switchFlag(
      "dry-run",
      "Validate original child plans and complete input trees without remote writes",
    ),
    output,
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const batch = yield* validateInventoryBatch(yield* readSourceJson(args.batch, maximumBytes))
      const limits = yield* parseSourceBudget(args)
      const { result, budget } = yield* boundedBatch(batch, args.entry, limits, {
        dryRun: args.dryRun,
      })
      yield* saveReport({ ...result, budget }, args.output)
      if (result.interruption !== null) process.exitCode = 75
      else if (
        args.dryRun ? result.counts.validated !== result.counts.total : !result.all_confirmed
      )
        process.exitCode = 4
    }),
).pipe(
  Command.withDescription(
    "Apply an original locally prepared batch serially using the existing child journals. Known content failures stay item-local; unknown writes or other execution failures halt new dispatches. Budget interruption retains completed item results and marks the active item interrupted, exits 75, and never grants replay authority. Run the same batch again to continue original work, never create replacement identities. No atomic batch or distributed lock is promised.",
  ),
)

const reconcile = defineCommand(
  "reconcile-imports",
  { batch: Argument.String("batch"), entry, output, ...sourceRequestBudgets },
  (args) =>
    Effect.gen(function* () {
      const batch = yield* validateInventoryBatch(yield* readSourceJson(args.batch, maximumBytes))
      const limits = yield* parseSourceBudget(args)
      const { result, budget } = yield* boundedBatch(batch, args.entry, limits, { reconcile: true })
      yield* saveReport({ ...result, budget }, args.output)
      if (result.interruption !== null) process.exitCode = 75
      else if (!result.all_confirmed) process.exitCode = 4
    }).pipe(withReadOnlyNotion),
).pipe(
  Command.withDescription(
    "Read every original child outcome without local source access, provider discovery or remote writes. Preserve preparation failures and unresolved outcomes. This observation does not authorize retrying an unknown write.",
  ),
)

export const inventoryBatchCommands = [prepare, apply, reconcile]
