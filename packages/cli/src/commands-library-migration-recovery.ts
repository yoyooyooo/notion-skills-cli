import { Effect } from "effect"
import { Command } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { property } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import {
  applySharedCreateRecovery,
  reconcileSharedCreateRecovery,
  reviewSharedCreateRecovery,
} from "../../core/src/shared-create-recovery.ts"
import { dryRunFlag, emit, requiredSingleton } from "./command-options.ts"
import { readMigrationJson } from "./commands-library-migration-input.ts"

const review = defineCommand(
  "review",
  {
    entry: requiredSingleton("entry", "Exact registered shared-library entry"),
    operation: requiredSingleton("operation", "Original failed skill-create operation ID"),
    target: requiredSingleton("target", "Existing disabled Skill page from that original create"),
  },
  (config) =>
    Effect.gen(function* () {
      const result = yield* reviewSharedCreateRecovery({
        entry: config.entry,
        operationId: config.operation,
        target: config.target,
      })
      yield* emit({
        status: "reviewed",
        dry_run: true,
        apply_allowed: false,
        review_id: result.review_id,
        review: result,
        request_metrics: (yield* Notion).requestMetrics?.(),
      })
    }),
).pipe(
  Command.withShortDescription("Review recovery of one original partial migration create"),
  Command.withDescription(
    "Read the original create evidence and existing disabled target without writing Notion. This recovery supports the bounded projection v4-to-v5 interpretation with unchanged submitted wire content. Current reads are explicitly labeled post_failure_current_read. The digest binds the original operation, existing page IDs and current observations. The original needs_review failure stays unchanged. Save the complete output and inspected review_id for recovery apply.",
  ),
  Command.withExamples([
    {
      command:
        "ntn-skills ctl library migration recovery review --entry ENTRY --operation ORIGINAL_OPERATION_ID --target EXISTING_SKILL_PAGE_ID",
      description: "Inspect an original partial create and retain the complete recovery review",
    },
  ]),
)

const apply = defineCommand(
  "apply",
  {
    input: requiredSingleton("input", "Approved migration input JSON bound to the original create"),
    review: requiredSingleton(
      "review",
      "Saved recovery review JSON or complete review command output",
    ),
    reviewId: requiredSingleton(
      "review-id",
      "Exact recovery review digest independently inspected",
    ),
    dryRun: dryRunFlag,
  },
  (config) =>
    Effect.gen(function* () {
      const migrationInput = yield* readMigrationJson(config.input)
      const rawReview = yield* readMigrationJson(config.review)
      const result = yield* applySharedCreateRecovery({
        migrationInput,
        review: property(rawReview).review ?? rawReview,
        reviewId: config.reviewId,
        dryRun: config.dryRun,
      })
      yield* emit({ ...result, request_metrics: (yield* Notion).requestMetrics?.() })
    }),
).pipe(
  Command.withShortDescription("Apply one reviewed recovery of the original partial create"),
  Command.withDescription(
    "Require the exact saved review, its digest and the original approved migration input. Dry-run checks without Notion writes. Real apply preserves the original failure and page IDs, creates missing pages and management facts, then records recovery completion separately. Existing page bodies and the fixed Source are preserved. Each recovery has one dispatch; unknown outcomes require recovery reconcile and never authorize resending a POST/PATCH or starting another create.",
  ),
  Command.withExamples([
    {
      command:
        "ntn-skills ctl library migration recovery apply --input APPROVED_INPUT.json --review RECOVERY_REVIEW.json --review-id RECOVERY_REVIEW_ID --dry-run",
      description: "Check the reviewed continuation without remote writes",
    },
    {
      command:
        "ntn-skills ctl library migration recovery apply --input APPROVED_INPUT.json --review RECOVERY_REVIEW.json --review-id RECOVERY_REVIEW_ID",
      description: "Continue the original partial create once",
    },
  ]),
)

const reconcile = defineCommand(
  "reconcile",
  {
    entry: requiredSingleton("entry", "Exact registered shared-library entry"),
    operation: requiredSingleton("operation", "Original failed skill-create operation ID"),
    target: requiredSingleton("target", "Existing Skill page belonging to that original operation"),
  },
  (config) =>
    Effect.gen(function* () {
      const result = yield* reconcileSharedCreateRecovery({
        entry: config.entry,
        operationId: config.operation,
        target: config.target,
      })
      yield* emit({ ...result, request_metrics: (yield* Notion).requestMetrics?.() })
    }),
).pipe(
  Command.withShortDescription("Read the exact recovery outcome without replay"),
  Command.withDescription(
    "Read retained recovery evidence and verify its separate historical completion. The original needs_review failure stays unchanged. Unknown or incomplete outcomes remain unresolved. This command performs zero POST/PATCH and does not adopt current bodies; requires_fresh_read remains true and no current snapshot is returned.",
  ),
  Command.withExamples([
    {
      command:
        "ntn-skills ctl library migration recovery reconcile --entry ENTRY --operation ORIGINAL_OPERATION_ID --target EXISTING_SKILL_PAGE_ID",
      description: "Inspect the recovery receipt after completion or an uncertain response",
    },
  ]),
)

export const libraryMigrationRecoveryCommand = defineCommand("recovery").pipe(
  Command.withShortDescription("Review and recover a bounded partial migration create"),
  Command.withDescription(
    "Recover an existing v4 partial create through a fixed v5 review with unchanged submitted wire content. Preserve original failures and page identities; unknown writes remain unreplayed.",
  ),
  Command.withSubcommands([review, apply, reconcile]),
)
