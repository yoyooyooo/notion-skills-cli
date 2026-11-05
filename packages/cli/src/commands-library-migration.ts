import { Effect, FileSystem, Option, Path } from "effect"
import { Command } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { fail, property } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { planSharedMigration } from "../../core/src/shared-migration-plan.ts"
import {
  applySharedMigration,
  reconcileSharedMigration,
  reviewSharedMigration,
} from "../../core/src/shared-migration-review.ts"
import { dryRunFlag, emit, requiredSingleton, singleton } from "./command-options.ts"
import { readMigrationJson, readMigrationRetained } from "./commands-library-migration-input.ts"
import { libraryMigrationRecoveryCommand } from "./commands-library-migration-recovery.ts"

const plan = defineCommand(
  "plan",
  {
    input: requiredSingleton(
      "input",
      "Exact frozen migration evidence JSON file; no live discovery or production changes",
    ),
  },
  ({ input }) =>
    Effect.gen(function* () {
      if (input === "")
        return yield* Effect.fail(
          fail("MIGRATION_INPUT_INVALID", "--input requires a nonempty frozen JSON file path."),
        )
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const location = path.resolve(input)
      const info = yield* fs
        .stat(location)
        .pipe(
          Effect.mapError(() =>
            fail(
              "MIGRATION_INPUT_READ_FAILED",
              "Could not inspect the frozen migration input file.",
              { input: location },
            ),
          ),
        )
      if (info.type !== "File")
        return yield* Effect.fail(
          fail("MIGRATION_INPUT_NOT_FILE", "--input must identify one regular JSON file.", {
            input: location,
          }),
        )
      const bytes = yield* fs.readFile(location).pipe(
        Effect.mapError(() =>
          fail("MIGRATION_INPUT_READ_FAILED", "Could not read the frozen migration input file.", {
            input: location,
          }),
        ),
      )
      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () =>
          fail(
            "MIGRATION_INPUT_INVALID_UTF8",
            "The frozen migration input must contain valid UTF-8; invalid original bytes were not replaced.",
            { input: location },
          ),
      })
      const evidence = yield* Effect.try({
        try: (): unknown => JSON.parse(text),
        catch: () =>
          fail("MIGRATION_INPUT_INVALID_JSON", "The frozen migration input is not valid JSON.", {
            input: location,
          }),
      })
      yield* emit(yield* planSharedMigration(evidence))
    }),
).pipe(
  Command.withShortDescription("Plan a migration from an exact frozen evidence file"),
  Command.withDescription(
    "Read one complete frozen JSON input and emit its deterministic migration plan, including original evidence and every item-level mapping or blocker. blocker_summary groups the unchanged blockers by exact code and required work: read-only observation, scope, legacy interpretation, provenance review, original-operation reconciliation or inventory correction. reviewable means the supplied evidence has no unresolved blockers; blocked lists what remains incomplete. Both return apply_allowed:false: neither executes or authorizes production migration. Approved scope must already be explicitly frozen in the input. This command does not discover Notion content, contact source providers, change configuration or write migration state. Output is complete and is not truncated.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills ctl library migration plan --input FROZEN_JSON",
      description:
        "Review an exact frozen evidence file; redirect the complete JSON result to a plan file if needed",
    },
  ]),
)

const review = defineCommand(
  "review",
  {
    input: requiredSingleton(
      "input",
      "Exact frozen migration evidence JSON; an empty approved scope remains empty",
    ),
    legacyId: requiredSingleton(
      "legacy-id",
      "One exact observed legacy identity from the frozen input",
    ),
    entry: requiredSingleton("entry", "Exact registered target shared-library database entry"),
    files: requiredSingleton(
      "files",
      "Retained directory or ZIP holding all declared managed file paths",
    ),
    preimages: requiredSingleton(
      "preimages",
      "Directory of exact native response files PAGE_UUID.default.json or PAGE_UUID.v2.json, matching each frozen raw.native_preimage descriptor",
    ),
    sourceFiles: singleton(
      "source-files",
      "Complete exact retained fixed Source directory or ZIP; required only when that Source is selected",
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const evidence = yield* readMigrationJson(config.input)
      const library = yield* loadSharedLibrary(config.entry)
      const retained = yield* readMigrationRetained({
        migrationInput: evidence,
        legacyId: config.legacyId,
        library,
        files: config.files,
        preimages: config.preimages,
        sourceFiles: Option.getOrUndefined(config.sourceFiles),
      })
      const review = yield* reviewSharedMigration(retained.input)
      yield* emit({
        status: "reviewed",
        dry_run: true,
        apply_allowed: false,
        review_id: review.review_id,
        review,
        unselected_input_paths: retained.unselected_input_paths,
        unselected_source_input_paths: retained.unselected_source_input_paths,
        request_metrics: (yield* Notion).requestMetrics?.(),
      })
    }),
).pipe(
  Command.withShortDescription("Prepare one concrete read-only migration review before approval"),
  Command.withDescription(
    "Read the exact frozen logical files, original native responses and selected fixed Source bytes; verify their hashes and complete mapping without changing approvals or writing Notion. Current target-library metadata and Router member bindings are checked online. Extra paths in --files are explicitly reported as unselected; --source-files must match the complete fixed tree exactly, with only a valid portable export manifest reported separately as container metadata. Native preimages must already be frozen by raw response hash/page/version in the input; materialized snapshots cannot substitute. Ordinary proposals use copy policy v1. A validated retained-publication descriptor selects v2, which copies an exact historical observation while retaining original unknown operations and catalog gaps. Target content, Source and dependent aliases must be complete under either policy. Save the complete JSON and its review_id for review. Nothing is applied.",
  ),
  Command.withExamples([
    {
      command:
        "ntn-skills ctl library migration review --input FROZEN_JSON --legacy-id LEGACY_ID --entry LIBRARY_ENTRY --files RETAINED_FILES --preimages RAW_RESPONSES",
      description:
        "Produce a concrete proposal without adding the target to the approval set; add --source-files EXACT_SOURCE_ZIP when the frozen target selects a fixed Source",
    },
  ]),
)

const apply = defineCommand(
  "apply",
  {
    input: requiredSingleton(
      "input",
      "Frozen evidence JSON whose approved_legacy_ids explicitly includes the reviewed target",
    ),
    review: requiredSingleton("review", "Saved complete migration review JSON"),
    reviewId: requiredSingleton(
      "review-id",
      "Exact migration-review digest that was reviewed and approved",
    ),
    dryRun: dryRunFlag,
  },
  (config) =>
    Effect.gen(function* () {
      const raw = yield* readMigrationJson(config.review)
      const result = yield* applySharedMigration({
        migrationInput: yield* readMigrationJson(config.input),
        review: property(raw).review ?? raw,
        reviewId: config.reviewId,
        dryRun: config.dryRun,
      })
      yield* emit({ ...result, request_metrics: (yield* Notion).requestMetrics?.() })
    }),
).pipe(
  Command.withShortDescription("Apply one exact reviewed and explicitly approved migration"),
  Command.withDescription(
    "Require the saved review and its independent digest plus original frozen evidence with explicit target approval. Only the approved ID set and its derived readiness-basis hash may differ from review; content, Source, target, preimages, isolation receipts and exact member pages cannot change. --dry-run performs current metadata/member checks and emits the frozen native plan without a create journal, body read or write. Execution reuses native create: disabled until complete, exact readback, immutable original outcomes and no automatic retry. Success includes a verified current pinned snapshot after a read-only final check. Keep the original operation ID after any error and use migration reconcile; this command does not bypass unsupported layouts, edit old pages, translate unknown relations or execute a batch.",
  ),
  Command.withExamples([
    {
      command:
        "ntn-skills ctl library migration apply --input APPROVED_JSON --review REVIEW_JSON --review-id MIGRATION_REVIEW_ID --dry-run",
      description: "Check the exact approved proposal and inspect its actual native operation plan",
    },
    {
      command:
        "ntn-skills ctl library migration apply --input APPROVED_JSON --review REVIEW_JSON --review-id MIGRATION_REVIEW_ID",
      description: "Execute the reviewed one-target migration after explicit approval",
    },
  ]),
)

const reconcile = defineCommand(
  "reconcile",
  {
    entry: requiredSingleton("entry", "Exact registered shared-library database entry"),
    operation: requiredSingleton(
      "operation",
      "Exact original skill-create operation ID; never a replacement plan",
    ),
    target: singleton(
      "target",
      "Exact new native page UUID; required on another machine when no original local journal exists",
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const result = yield* reconcileSharedMigration({
        entry: config.entry,
        operationId: config.operation,
        target: Option.getOrUndefined(config.target),
      })
      yield* emit({ ...result, request_metrics: (yield* Notion).requestMetrics?.() })
    }),
).pipe(
  Command.withShortDescription("Read the exact original migration outcome without replay"),
  Command.withDescription(
    "Use the same local original journal. On another machine, add --target to reconstruct the exact shared manifest and retained origin. This reads original facts only: it never repeats POST/PATCH, re-inspects a provider, adopts a current body or resumes a partial tree. A successful result verifies the historical create outcome, not a latest snapshot; requires_fresh_read remains true. Missing original outcomes, partial archives and unavailable first-create pages remain unresolved. Do not use generic ctl operation resume for this migration family.",
  ),
  Command.withExamples([
    {
      command:
        "ntn-skills ctl library migration reconcile --entry LIBRARY_ENTRY --operation SKILL_CREATE_OPERATION_ID",
      description:
        "Inspect the original local migration intent without replay; add --target NEW_PAGE_ID for cross-machine shared-origin recovery",
    },
  ]),
)

export const libraryMigrationCommand = defineCommand("migration").pipe(
  Command.withShortDescription(
    "Plan, review and execute an explicitly approved one-target migration",
  ),
  Command.withDescription(
    "plan retains original evidence and readiness blockers; review freezes concrete files, Source, native preimages and target/member bindings without approval changes. apply requires that exact review digest and explicit frozen target approval. reconcile only observes the original operation. Unsupported or unknown data is never reclassified to make execution pass.",
  ),
  Command.withSubcommands([plan, review, apply, reconcile, libraryMigrationRecoveryCommand]),
)
