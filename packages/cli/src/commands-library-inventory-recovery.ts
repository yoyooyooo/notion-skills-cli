import { Effect } from "effect"
import { Argument, Command } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { property } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { withReadOnlyNotion } from "../../core/src/notion-readonly.ts"
import {
  reviewInventoryNativeRecovery,
  applyInventoryNativeRecovery,
  reconcileInventoryNativeRecovery,
} from "../../core/src/shared-inventory-recovery.ts"
import { withSourceCommandBudget } from "../../core/src/shared-source-budget.ts"
import { Store } from "../../core/src/store.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { withSourceUpdateLock } from "../../core/src/shared-source-policy.ts"
import { emit, requiredSingleton, switchFlag } from "./command-options.ts"
import { readSourceJson } from "./command-source-input.ts"
import { parseSourceBudget, sourceRequestBudgets } from "./commands-library-source-run.ts"

const plan = Argument.String("plan")
const entry = requiredSingleton("entry", "Exact original inventory library")
const target = requiredSingleton(
  "target",
  "Existing sole main page with its original durable POST acknowledgement",
)
const review = defineCommand(
  "review",
  {
    plan,
    entry,
    target,
    output: requiredSingleton("output", "New or identical complete native recovery review"),
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const original = yield* readSourceJson(args.plan, 192 * 1024 * 1024)
      const { result, budget } = yield* withSourceCommandBudget(
        reviewInventoryNativeRecovery({ entry: args.entry, plan: original, target: args.target }),
        yield* parseSourceBudget(args),
      )
      yield* (yield* Store).output(
        args.output,
        new TextEncoder().encode(JSON.stringify(result, null, 2) + "\n"),
      )
      yield* emit({
        status: "reviewed",
        review_id: result.review_id,
        review: result,
        output: args.output,
        remote_writes: 0,
        budget,
        request_metrics: (yield* Notion).requestMetrics?.(),
      })
    }).pipe(withReadOnlyNotion),
).pipe(
  Command.withDescription(
    "Review the original disabled one-main native inventory import after its sole acknowledged v11 create, before any Records. Require the original local prepared and executed inventory plans, exact credential-scoped create journal and only the complete original POST/ACK. The unchanged wire must have a complete current body equal to the fixed v12 prediction. Save the explicit review; no remote write occurs.",
  ),
)
const apply = defineCommand(
  "apply",
  {
    plan,
    entry,
    review: requiredSingleton("review", "Saved complete native recovery review"),
    reviewId: requiredSingleton("review-id", "Independently inspected exact review digest"),
    dryRun: switchFlag(
      "dry-run",
      "Revalidate the original authority, exact ACK and current body without writes",
    ),
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const original = yield* readSourceJson(args.plan, 192 * 1024 * 1024),
        saved = yield* readSourceJson(args.review, 192 * 1024 * 1024)
      const { result, budget } = yield* withSourceCommandBudget(
        Effect.gen(function* () {
          const library = yield* loadSharedLibrary(args.entry)
          return yield* withSourceUpdateLock(
            library,
            applyInventoryNativeRecovery({
              entry: args.entry,
              plan: original,
              review: property(saved).review ?? saved,
              reviewId: args.reviewId,
              dryRun: args.dryRun,
            }),
          )
        }),
        yield* parseSourceBudget(args),
      )
      yield* emit({ ...result, budget, request_metrics: (yield* Notion).requestMetrics?.() })
    }),
).pipe(
  Command.withDescription(
    "Apply one inspected native recovery decision in the original credential and Store. Preserve the same disabled main page, original input, wire, full frontmatter and mode. Append only the exact immutable Record union; no new native page, body PATCH, metadata PATCH, Source write or enablement is allowed. Repeated or uncertain recovery attempts only reconcile and never replay any suffix.",
  ),
)
const reconcile = defineCommand(
  "reconcile",
  { plan, entry, target, ...sourceRequestBudgets },
  (args) =>
    Effect.gen(function* () {
      const original = yield* readSourceJson(args.plan, 192 * 1024 * 1024)
      const { result, budget } = yield* withSourceCommandBudget(
        reconcileInventoryNativeRecovery({
          entry: args.entry,
          plan: original,
          target: args.target,
        }),
        yield* parseSourceBudget(args),
      )
      yield* emit({ ...result, budget, request_metrics: (yield* Notion).requestMetrics?.() })
    }).pipe(withReadOnlyNotion),
).pipe(
  Command.withDescription(
    "Read the original native recovery completion from immutable shared manifest, original input, full allocation ACK, fixed v12 body and ownership facts. The original missing create outcome is not invented. Missing or unknown recovery remains unresolved; no current body or copied local plan authorizes writing.",
  ),
)
export const inventoryRecoveryCommand = defineCommand("recovery").pipe(
  Command.withDescription(
    "Review, apply or reconcile one original acknowledged native inventory main",
  ),
  Command.withSubcommands([review, apply, reconcile]),
)
