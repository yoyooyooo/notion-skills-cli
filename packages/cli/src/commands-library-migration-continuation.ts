import { Effect } from "effect"
import { Command } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { property } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import {
  applySharedCreateContinuation,
  reviewSharedCreateContinuation,
} from "../../core/src/shared-create-recovery.ts"
import { dryRunFlag, emit, requiredSingleton } from "./command-options.ts"
import { readMigrationJson } from "./commands-library-migration-input.ts"

const review = defineCommand(
  "review",
  {
    entry: requiredSingleton("entry", "Exact registered shared-library entry"),
    operation: requiredSingleton("operation", "Original failed skill-create operation ID"),
    target: requiredSingleton("target", "Existing disabled Skill page"),
  },
  (config) =>
    Effect.gen(function* () {
      const result = yield* reviewSharedCreateContinuation({
        entry: config.entry,
        operationId: config.operation,
        target: config.target,
      })
      yield* emit({
        status: "reviewed",
        dry_run: true,
        apply_allowed: false,
        review_id: result.continuation_id,
        review: result,
        request_metrics: (yield* Notion).requestMetrics?.(),
      })
    }),
).pipe(
  Command.withShortDescription("Review current allocations after one unknown recovery create"),
  Command.withDescription(
    "Require the original recovery's retained serial-dispatch terminal, exact successful responses, a complete disabled inventory and unchanged current bodies. Accept the visible allocation through a new decision while the original POST remains unknown. Current GETs and retrospective summaries cannot replace a missing terminal. No writes occur. Inspect the full review and its continuation digest before apply.",
  ),
)

const apply = defineCommand(
  "apply",
  {
    input: requiredSingleton("input", "Complete original approved migration input JSON"),
    review: requiredSingleton("review", "Saved continuation review or complete review output"),
    reviewId: requiredSingleton("review-id", "Exact inspected continuation digest"),
    dryRun: dryRunFlag,
  },
  (config) =>
    Effect.gen(function* () {
      const migrationInput = yield* readMigrationJson(config.input)
      const rawReview = yield* readMigrationJson(config.review)
      const result = yield* applySharedCreateContinuation({
        migrationInput,
        review: property(rawReview).review ?? rawReview,
        reviewId: config.reviewId,
        dryRun: config.dryRun,
      })
      yield* emit({ ...result, request_metrics: (yield* Notion).requestMetrics?.() })
    }),
).pipe(
  Command.withShortDescription("Create only the reviewed, proven unattempted remaining files"),
  Command.withDescription(
    "Revalidate the complete original approved input, retained execution evidence and current accepted allocations. Dry-run performs zero writes. One real dispatch skips every accepted page and creates only the original terminal's unattempted suffix. Completion v2 binds this separate decision and preserves the original unknown. A repeated or interrupted continuation only reconciles; it never resends a POST or PATCH. Use recovery reconcile for its historical outcome.",
  ),
)

export const libraryMigrationContinuationCommand = defineCommand("continuation").pipe(
  Command.withShortDescription("Review a bounded continuation without replaying unknown writes"),
  Command.withSubcommands([review, apply]),
)
