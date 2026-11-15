import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { defineCommand, withConstraints } from "../../core/src/command-schema.ts"
import { fail, property } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { Store } from "../../core/src/store.ts"
import { withSourceCommandBudget } from "../../core/src/shared-source-budget.ts"
import {
  reviewSourceStorage,
  prepareSourceStorageAlignment,
  applySourceStorageAlignment,
  reconcileSourceStorageAlignment,
} from "../../core/src/shared-source-storage.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"
import { readSourceJson } from "./command-source-input.ts"
import { sourceRequestBudgets, parseSourceBudget } from "./commands-library-source-run.ts"

const entry = requiredSingleton("entry", "Exact registered shared library")
const review = defineCommand(
  "review",
  {
    entry,
    source: singleton("source", "Exact Source to inspect; exclusive with --all"),
    all: switchFlag("all", "Explicitly inspect all registered Source memberships"),
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const source = Option.getOrUndefined(args.source)
      if ((source === undefined) === !args.all)
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Choose exactly one of --source or --all."),
        )
      const { result, budget } = yield* withSourceCommandBudget(
        reviewSourceStorage({
          entry: args.entry,
          scope: source === undefined ? { kind: "all" } : { kind: "source", source },
        }),
        yield* parseSourceBudget(args),
      )
      yield* emit({ ...result, budget, request_metrics: (yield* Notion).requestMetrics?.() })
    }),
).pipe(
  Command.withDescription(
    "Inspect the complete forward Source-member storage roster including disabled Skills, without provider requests or file bodies. Fixed Git, retained bundles, composition, native/uncompleted and Router rows remain distinct. This is metadata classification, not proof that an unfinished import completed.",
  ),
  withConstraints([{ kind: "exactly_one", flags: ["source", "all"] }]),
)

const prepare = defineCommand(
  "prepare",
  {
    entry,
    source: requiredSingleton("source", "Exact bound Source"),
    target: requiredSingleton("target", "Exact original Skill page"),
    output: requiredSingleton("output", "Private frozen same-revision storage alignment plan"),
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const { result, budget } = yield* withSourceCommandBudget(
        prepareSourceStorageAlignment({
          entry: args.entry,
          source: args.source,
          target: args.target,
        }),
        yield* parseSourceBudget(args),
      )
      if (result.status === "unchanged") {
        yield* emit({ ...result, budget })
        return
      }
      yield* (yield* Store).output(
        args.output,
        new TextEncoder().encode(JSON.stringify(result.plan, null, 2) + "\n"),
      )
      yield* emit({
        status: result.status,
        plan_id: result.plan.plan_id,
        target: args.target,
        output: args.output,
        from: result.plan.original_source_id,
        to: result.plan.refresh.version === 4 ? result.plan.refresh.source_pin : null,
        revision: result.plan.original_revision,
        files: result.plan.original_files.length,
        bytes: result.plan.original_files.reduce((n, file) => n + file.bytes, 0),
        custom_files_preserved: result.plan.refresh.custom_files_preserved,
        decision: result.decision,
        new_archive_bytes: 0,
        new_binary_objects: 0,
        remote_writes: 0,
        budget,
        request_metrics: (yield* Notion).requestMetrics?.(),
        next: {
          argv: [
            "ntn-skills",
            "ctl",
            "library",
            "sources",
            "storage",
            "apply",
            args.output,
            "--dry-run",
          ],
          read_only: true,
          reason:
            "Preview this same-content original-page selection; no old blobs or pins are deleted and no upstream version is advanced.",
        },
      })
    }),
).pipe(
  Command.withDescription(
    "Freeze a same-content retained-to-fixed-Git alignment. Recover the exact original revision from immutable provenance, verify every path/hash/length/mode and preserve custom files, relations and Enabled. No HEAD update, no new Skill, no archive upload. Unfinished original imports or unproven transformed inputs are blocked.",
  ),
)

function execution(mode: "apply" | "reconcile") {
  return defineCommand(
    mode,
    {
      plan: Argument.String("plan"),
      dryRun: switchFlag(
        "dry-run",
        "Validate the frozen selection without remote writes; apply only",
      ),
      ...sourceRequestBudgets,
    },
    (args) =>
      Effect.gen(function* () {
        if (mode === "reconcile" && args.dryRun)
          return yield* Effect.fail(
            fail("INVALID_ARGUMENT", "Reconcile is already read-only; omit --dry-run."),
          )
        const plan = yield* readSourceJson(args.plan, 192 * 1024 * 1024)
        const action = Effect.gen(function* () {
          if (mode === "apply")
            return yield* applySourceStorageAlignment({ plan, dryRun: args.dryRun })
          return yield* reconcileSourceStorageAlignment({ plan })
        })
        const reconcile = {
          argv: ["ntn-skills", "ctl", "library", "sources", "storage", "reconcile", args.plan],
          read_only: true,
          reason:
            "Inspect the original metadata-selection journal. Current source equality never authorizes replay.",
        }
        const { result, budget } = yield* withSourceCommandBudget(
          action,
          yield* parseSourceBudget(args),
        ).pipe(
          Effect.mapError((error) =>
            fail(error.code, error.message, { ...property(error.details), next: reconcile }),
          ),
        )
        yield* emit({
          ...result,
          budget,
          request_metrics: (yield* Notion).requestMetrics?.(),
          next:
            mode === "apply" && args.dryRun
              ? {
                  argv: ["ntn-skills", "ctl", "library", "sources", "storage", "apply", args.plan],
                  read_only: false,
                  reason:
                    "Select only the exact equivalent fixed source. Preserve original pages, custom content, Enabled and historical retained versions.",
                }
              : reconcile,
        })
      }),
  ).pipe(
    Command.withDescription(
      mode === "apply"
        ? "Apply the reviewed same-version storage selection through the existing source refresh and metadata journal. No body updates, binary/ZIP uploads, record deletion, implicit enabling or replacement pages."
        : "Reconcile the exact original source-selection outcome without repeating any write. A fresh cold read is a separate proof.",
    ),
  )
}
export const sourceStorageCommand = defineCommand("storage").pipe(
  Command.withDescription(
    "External-first storage inspection and exact existing-library alignment; history remains intact.",
  ),
  Command.withSubcommands([review, prepare, execution("apply"), execution("reconcile")]),
)
