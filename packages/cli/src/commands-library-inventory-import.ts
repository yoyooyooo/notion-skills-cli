import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { defineCommand, withConstraints } from "../../core/src/command-schema.ts"
import { fail } from "../../core/src/model.ts"
import { withReadOnlyNotion } from "../../core/src/notion-readonly.ts"
import {
  executeInventoryImport,
  prepareInventoryImport,
  type InventoryImportDecision,
} from "../../core/src/shared-inventory-import.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { withSourceCommandBudget } from "../../core/src/shared-source-budget.ts"
import { withSourceUpdateLock } from "../../core/src/shared-source-policy.ts"
import { Store } from "../../core/src/store.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"
import { readSourceJson } from "./command-source-input.ts"
import { parseSourceBudget, sourceRequestBudgets } from "./commands-library-source-run.ts"
import { inventoryBatchCommands } from "./commands-library-inventory-batch.ts"

const entry = requiredSingleton("entry", "Exact reviewed shared library entry")
const maximumPlanBytes = 192 * 1024 * 1024
const prepare = defineCommand(
  "prepare-import",
  {
    entry,
    review: requiredSingleton("review", "Exact inventory reconciliation artifact ID"),
    entity: requiredSingleton("entity", "Exact reviewed local entity ID"),
    approvedManifest: requiredSingleton(
      "approve-manifest",
      "Explicitly approved complete entity manifest SHA-256; approval includes every listed path and mode",
    ),
    native: switchFlag("native", "Create a wholly owned native Skill with no upstream provenance"),
    source: singleton("source", "Exact registered Source for this upstream member"),
    member: singleton("member", "Exact member of --source"),
    baseline: singleton(
      "baseline-commit",
      "Select one exact fixed commit already proven by inventory provenance",
    ),
    verifyExisting: switchFlag(
      "verify-existing",
      "Only verify an exact already-managed equal entity; never replace it",
    ),
    enable: switchFlag(
      "enable",
      "Explicitly enable the new Skill after its complete creation verifies; default disabled",
    ),
    output: requiredSingleton(
      "output",
      "Save the complete frozen import plan to a new or identical file",
    ),
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const source = Option.getOrUndefined(args.source),
        member = Option.getOrUndefined(args.member),
        baselineCommit = Option.getOrUndefined(args.baseline)
      if (
        Number(args.native) + Number(args.verifyExisting) + Number(source !== undefined) !== 1 ||
        (source !== undefined && member === undefined) ||
        (source === undefined && (member !== undefined || baselineCommit !== undefined)) ||
        (args.verifyExisting && args.enable)
      )
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            "Choose exactly one of --native, --source with --member, or --verify-existing. Existing verification cannot request enablement.",
          ),
        )
      if (baselineCommit !== undefined && !/^[a-f0-9]{40}$/u.test(baselineCommit))
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            "--baseline-commit must be the complete lowercase commit already recorded by inventory provenance.",
          ),
        )
      const decision: InventoryImportDecision = args.native
        ? { kind: "native" }
        : args.verifyExisting
          ? { kind: "verify_existing" }
          : {
              kind: "source",
              source: source!,
              member: member!,
              ...(baselineCommit === undefined ? {} : { baselineCommit }),
            }
      const limits = yield* parseSourceBudget(args)
      const { result: plan, budget } = yield* withSourceCommandBudget(
        Effect.gen(function* () {
          const library = yield* loadSharedLibrary(args.entry)
          return yield* prepareInventoryImport({
            library,
            reconciliationId: args.review,
            entityId: args.entity,
            approvedManifest: args.approvedManifest,
            decision,
            enabled: args.enable,
          })
        }),
        limits,
      )
      yield* (yield* Store).output(
        args.output,
        new TextEncoder().encode(JSON.stringify(plan, null, 2) + "\n"),
      )
      yield* emit({
        plan_id: plan.plan_id,
        output: args.output,
        entity_id: plan.local_entity.entity_id,
        approved_manifest: plan.approved_manifest,
        action: plan.action.kind,
        ...(plan.action.kind === "create"
          ? {
              operation_id: plan.action.creation.operation_id,
              input_class: plan.action.input_class,
              baseline_revision: plan.action.baseline_revision,
              selected_revision: plan.action.selected_revision,
              custom_paths: plan.action.custom_paths,
              enabled: plan.action.creation.enabled ?? true,
            }
          : { page_id: plan.action.page_id }),
        local_writes_to_source: 0,
        remote_writes: 0,
        budget,
      })
    }).pipe(withReadOnlyNotion),
).pipe(
  withConstraints([{ kind: "exactly_one", flags: ["native", "source", "verifyExisting"] }]),
  Command.withDescription(
    "Prepare one complete reviewed inventory entity through the existing author/Source create kernel. Exact manifests, scope, provenance and native metadata are frozen; no remote write occurs. An existing or ambiguous identity never becomes a same-name replacement. No script or dependency is executed.",
  ),
)

const apply = defineCommand(
  "apply-import",
  {
    plan: Argument.String("plan"),
    entry,
    ...sourceRequestBudgets,
    dryRun: switchFlag(
      "dry-run",
      "Revalidate original input and target scope without remote writes",
    ),
  },
  (args) =>
    Effect.gen(function* () {
      const plan = yield* readSourceJson(args.plan, maximumPlanBytes)
      const limits = yield* parseSourceBudget(args)
      const { result, budget } = yield* withSourceCommandBudget(
        Effect.gen(function* () {
          const library = yield* loadSharedLibrary(args.entry)
          return yield* withSourceUpdateLock(
            library,
            executeInventoryImport(library, plan, { dryRun: args.dryRun }),
          )
        }),
        limits,
      )
      yield* emit({ ...result, budget })
      if (!args.dryRun && "verified" in result && !result.verified) process.exitCode = 4
    }),
).pipe(
  Command.withDescription(
    "Apply the exact original prepared import using its existing creation journal. Changed paths/bytes/modes/identity invalidate undispatched work. Incomplete creation stays disabled; unknown requests are never blindly replayed. Local trees and links are unchanged.",
  ),
)

const reconcile = defineCommand(
  "reconcile-import",
  {
    plan: Argument.String("plan"),
    entry,
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const plan = yield* readSourceJson(args.plan, maximumPlanBytes)
      const limits = yield* parseSourceBudget(args)
      const { result, budget } = yield* withSourceCommandBudget(
        Effect.gen(function* () {
          const library = yield* loadSharedLibrary(args.entry)
          return yield* executeInventoryImport(library, plan, { reconcile: true })
        }),
        limits,
      )
      yield* emit({ ...result, budget })
      if ("verified" in result && !result.verified) process.exitCode = 4
    }).pipe(withReadOnlyNotion),
).pipe(
  Command.withDescription(
    "Read the original frozen import outcome without local source access, another provider check, or any remote write. A copied plan grants reconciliation only and cannot authorize another create.",
  ),
)

export const inventoryImportCommands = [prepare, apply, reconcile, ...inventoryBatchCommands]
