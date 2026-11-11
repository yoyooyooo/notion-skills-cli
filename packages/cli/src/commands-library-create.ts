import { Effect } from "effect"
import { Argument, Command } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { property } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { Store } from "../../core/src/store.ts"
import { withReadOnlyNotion } from "../../core/src/notion-readonly.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { withSourceUpdateLock } from "../../core/src/shared-source-policy.ts"
import { withSourceCommandBudget } from "../../core/src/shared-source-budget.ts"
import {
  reviewSharedCreateRestoration,
  applySharedCreateRestoration,
  reconcileSharedCreateRestoration,
} from "../../core/src/shared-create-restoration.ts"
import { emit, requiredSingleton, switchFlag } from "./command-options.ts"
import { readSourceJson } from "./command-source-input.ts"
import { parseSourceBudget, sourceRequestBudgets } from "./commands-library-source-run.ts"

const plan = Argument.String("plan")
const entry = requiredSingleton("entry", "Exact original shared library")
const target = requiredSingleton("target", "Exact original acknowledged main page")
const review = defineCommand(
  "review",
  {
    plan,
    entry,
    target,
    output: requiredSingleton("output", "Complete saved restoration review"),
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const original = yield* readSourceJson(args.plan, 192 * 1024 * 1024)
      const { result, budget } = yield* withSourceCommandBudget(
        reviewSharedCreateRestoration({ entry: args.entry, plan: original, target: args.target }),
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
    "Review an ordinary native create whose acknowledged main was explicitly restored to its exact original frozen candidate after a known body mismatch. Keep the original needs_review, complete input, main POST/ACK and same page. Only the original one-main prefix with unchanged metadata and relations is eligible. Reads current complete Markdown; never patches a body or starts a new create.",
  ),
)
const apply = defineCommand(
  "apply",
  {
    plan,
    entry,
    review: requiredSingleton("review", "Saved complete original restoration review"),
    reviewId: requiredSingleton("review-id", "Exact independently inspected restoration digest"),
    dryRun: switchFlag(
      "dry-run",
      "Recheck the original failure, ACK and current body without writes",
    ),
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const original = yield* readSourceJson(args.plan, 192 * 1024 * 1024)
      const saved = yield* readSourceJson(args.review, 192 * 1024 * 1024)
      const { result, budget } = yield* withSourceCommandBudget(
        Effect.gen(function* () {
          const library = yield* loadSharedLibrary(args.entry)
          return yield* withSourceUpdateLock(
            library,
            applySharedCreateRestoration({
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
    "Continue the exact reviewed original native create. Preserve its original main and needs_review outcome, create only the original unattempted file suffix, verify the complete original tree and retain a separate restoration completion. No existing body is patched and no unknown native request is replayed. Dry-run revalidates without remote writes; repeated completion is read-only.",
  ),
)
const reconcile = defineCommand(
  "reconcile",
  { plan, entry, target, ...sourceRequestBudgets },
  (args) =>
    Effect.gen(function* () {
      const original = yield* readSourceJson(args.plan, 192 * 1024 * 1024)
      const { result, budget } = yield* withSourceCommandBudget(
        reconcileSharedCreateRestoration({
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
    "Read the separate original restoration completion, full main ACK, original failure and complete initial file facts. This proves historical completion and requires a fresh read for current content. Missing or unknown outcomes remain unresolved; reconciliation never dispatches.",
  ),
)
export const libraryCreateCommand = defineCommand("create").pipe(
  Command.withSubcommands([
    defineCommand("recovery").pipe(Command.withSubcommands([review, apply, reconcile])),
  ]),
)
