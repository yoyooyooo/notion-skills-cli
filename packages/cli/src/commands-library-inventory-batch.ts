import { Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { withReadOnlyNotion } from "../../core/src/notion-readonly.ts"
import { fail, property } from "../../core/src/model.ts"
import { pageId } from "../../core/src/ref.ts"
import {
  runSharedAudit,
  resumeSharedAudit,
  reportSharedAudit,
} from "../../core/src/shared-audit.ts"
import {
  scanLocalSkillInventory,
  reconcileSkillInventories,
  prepareSharedBaselineInventory,
} from "../../core/src/shared-inventory.ts"
import type { RequestBudgetLimits } from "../../core/src/request-budget.ts"
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

function directoryInput(input: {
  readonly entry: string
  readonly roots: readonly string[]
  readonly targets: readonly string[]
  readonly provenance: readonly string[]
  readonly auditRun?: string
  readonly limits: RequestBudgetLimits
}) {
  return Effect.gen(function* () {
    const started = performance.now()
    const entryId = pageId(input.entry)
    if (entryId === undefined)
      return yield* Effect.fail(fail("INVALID_ARGUMENT", "Use an exact shared library entry."))
    const prior =
      input.auditRun === undefined ? undefined : yield* reportSharedAudit(input.auditRun, entryId)
    if (prior !== undefined && (prior.selector.kind !== "census" || prior.depth !== "metadata"))
      return yield* Effect.fail(
        fail(
          "INVALID_ARGUMENT",
          "Directory preparation resumes only an exact metadata census for this library.",
        ),
      )
    const local = yield* scanLocalSkillInventory({
      roots: input.roots,
      allow_targets: input.targets,
      provenance_files: input.provenance,
      budget: { duration_ms: input.limits.duration_ms },
    })
    if (local.coverage !== "full")
      return yield* Effect.fail(
        fail(
          "INVENTORY_DIRECTORY_INCOMPLETE",
          "The directory scan is incomplete; no target census or import was started.",
          {
            local_inventory_id: local.inventory_id,
            findings: local.findings,
          },
        ),
      )
    if (local.entities.length === 0 || local.entities.length > 1000)
      return yield* Effect.fail(
        fail("INVENTORY_DIRECTORY_EMPTY", "Select directories containing 1–1000 complete Skills.", {
          local_inventory_id: local.inventory_id,
          entities: local.entities.length,
        }),
      )
    const duration = Math.floor(input.limits.duration_ms - (performance.now() - started))
    if (duration <= 0)
      return yield* Effect.fail(
        fail(
          "REQUEST_BUDGET_EXHAUSTED",
          "The directory scan exhausted the preparation deadline before any remote work.",
          { local_inventory_id: local.inventory_id },
        ),
      )
    const auditLimits = { ...input.limits, duration_ms: duration }
    const census =
      prior?.execution === "completed"
        ? prior
        : prior !== undefined
          ? yield* resumeSharedAudit(prior.run_id, { budget: auditLimits })
          : yield* runSharedAudit({
              entry: entryId,
              selector: { kind: "census" },
              budget: auditLimits,
            })
    const censusBudget = {
      attempts: census.request_totals.attempts - (prior?.request_totals.attempts ?? 0),
      request_bytes:
        census.request_totals.request_bytes - (prior?.request_totals.request_bytes ?? 0),
      response_bytes:
        census.request_totals.response_bytes - (prior?.request_totals.response_bytes ?? 0),
    }
    const preparation = {
      kind: "native_directories" as const,
      local_inventory_id: local.inventory_id,
      audit_run_id: census.run_id,
      skill_states: "unobserved" as const,
      unassigned_files: local.unassigned_files.length,
      census_budget: censusBudget,
    }
    const remaining = {
      requests: input.limits.requests - censusBudget.attempts,
      bytes: input.limits.bytes - censusBudget.request_bytes - censusBudget.response_bytes,
      duration_ms: Math.floor(input.limits.duration_ms - (performance.now() - started)),
    }
    if (census.execution !== "completed" || Object.values(remaining).some((value) => value <= 0))
      return {
        kind: "stopped" as const,
        exitCode: census.execution === "paused" || census.execution === "completed" ? 75 : 4,
        report: {
          status:
            census.execution === "paused" || census.execution === "completed"
              ? "paused"
              : "incomplete",
          phase: census.execution === "completed" ? "preparation" : "census",
          preparation,
          remote_writes: 0,
          batch_saved: false,
          recovery: {
            command: "prepare-imports",
            audit_run: census.run_id,
          },
        },
      }
    const remote = yield* prepareSharedBaselineInventory(census.run_id)
    if (remote.visible_registered_census?.coverage !== "full")
      return yield* Effect.fail(
        fail(
          "INVENTORY_IMPORT_SCOPE",
          "The directory import needs a complete stable census; current content remains unobserved.",
          {
            audit_run_id: census.run_id,
            remote_inventory_id: remote.inventory_id,
          },
        ),
      )
    const review = yield* reconcileSkillInventories({
      remote_inventory_id: remote.inventory_id,
      local_inventory_id: local.inventory_id,
    })
    const request = yield* decodeInventoryBatchInput({
      version: 1,
      reconciliation_id: review.inventory_id,
      items: local.entities.map((entity) => ({
        entity_id: entity.entity_id,
        approved_manifest: entity.manifest_sha256,
        decision: { kind: "native" },
        enabled: false,
      })),
    })
    return {
      kind: "ready" as const,
      request,
      remaining,
      preparation: {
        ...preparation,
        remote_inventory_id: remote.inventory_id,
        reconciliation_id: review.inventory_id,
      },
    }
  })
}

const prepare = defineCommand(
  "prepare-imports",
  {
    entry,
    input: singleton("input", "Reviewed batch JSON with exact entity manifests and decisions"),
    roots: Flag.String("root").pipe(
      Flag.atLeast(0),
      Flag.withDescription(
        "Explicit absolute Skill or collection directory; repeat as needed. Requires --native and excludes --input",
      ),
    ),
    native: switchFlag(
      "native",
      "Prepare every discovered owned Skill in --root directories as native content; preserve all existing scope/provenance guards and keep new Skills disabled",
    ),
    targets: Flag.String("allow-target").pipe(
      Flag.atLeast(0),
      Flag.withDescription("Explicit real symlink target allowed during directory scanning"),
    ),
    provenance: Flag.String("provenance").pipe(
      Flag.atLeast(0),
      Flag.withDescription(
        "Exact local provenance registry used during directory scanning; cannot override Source ownership",
      ),
    ),
    auditRun: singleton(
      "audit-run",
      "Resume or reuse an exact metadata census for these directory inputs; only with --root --native",
    ),
    output: requiredSingleton(
      "output",
      "Save the complete immutable batch, including preparation failures",
    ),
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const inputPath = Option.getOrUndefined(args.input)
      const auditRun = Option.getOrUndefined(args.auditRun)
      if (
        (inputPath === undefined) === (args.roots.length === 0) ||
        (inputPath !== undefined &&
          (args.native ||
            args.targets.length > 0 ||
            args.provenance.length > 0 ||
            auditRun !== undefined)) ||
        (args.roots.length > 0 && !args.native)
      )
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            "Choose --input REVIEWED_JSON or explicit --root directories with --native. Directory options cannot accompany --input.",
          ),
        )
      const limits = yield* parseSourceBudget(args)
      const source =
        inputPath !== undefined
          ? {
              kind: "ready" as const,
              request: yield* decodeInventoryBatchInput(
                yield* readSourceJson(inputPath, maximumBytes),
              ),
              remaining: limits,
              preparation: undefined,
            }
          : yield* directoryInput({
              entry: args.entry,
              roots: args.roots,
              targets: args.targets,
              provenance: args.provenance,
              auditRun,
              limits,
            })
      if (source.kind === "stopped") {
        yield* emit(source.report)
        process.exitCode = source.exitCode
        return
      }
      const { result: batch, budget } = yield* withSourceCommandBudget(
        Effect.gen(function* () {
          return yield* prepareInventoryBatch(yield* loadSharedLibrary(args.entry), source.request)
        }),
        source.remaining,
      )
      yield* (yield* Store).output(
        args.output,
        new TextEncoder().encode(JSON.stringify(batch, null, 2) + "\n"),
      )
      const prepared = batch.items.filter((item) => item.status === "prepared").length
      yield* emit({
        batch_id: batch.batch_id,
        output: args.output,
        ...(source.preparation === undefined ? {} : { preparation: source.preparation }),
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
    "Prepare a reviewed JSON set, or scan explicit --root directories with --native, take a stable metadata census and build the original batch automatically. No remote writes occur. Directory census pauses return --audit-run for continuation and exit 75. Census and preparation share the total HTTP budget. Known provenance and sensitive/incomplete inputs keep their existing guards; new Skills stay disabled. Partial preparation retains every entity and error, saves the complete batch and exits 4.",
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
    "Apply an original locally prepared batch serially using the existing child journals. After exhausted transient read retries, continue that original create once under the same budget and preserve its first error. Known content failures stay item-local; unknown writes or remaining execution failures halt new dispatches. Budget interruption retains completed item results and marks the active item interrupted, exits 75, and never grants replay authority. Run the same batch again to continue original work, never create replacement identities. No atomic batch or distributed lock is promised.",
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
