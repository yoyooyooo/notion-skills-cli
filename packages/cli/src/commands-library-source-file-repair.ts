import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { fail, property } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { Store } from "../../core/src/store.ts"
import { withSourceCommandBudget } from "../../core/src/shared-source-budget.ts"
import {
  reviewSharedSourceFileRepair,
  applySharedSourceFileRepair,
  reconcileSharedSourceFileRepair,
} from "../../core/src/shared-source-file-repair.ts"
import { readSourceJson } from "./command-source-input.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"
import { parseSourceBudget, sourceRequestBudgets } from "./commands-library-source-run.ts"

const common = {
  plan: Argument.String("plan"),
  entry: requiredSingleton("entry", "Exact original registered library"),
  operation: singleton(
    "operation",
    "Exact creation operation selected from the unchanged onboarding parent",
  ),
  ...sourceRequestBudgets,
}
type Route = {
  plan: string
  entry: string
  operation: Option.Option<string>
  review: string
  reviewId: string
}
const argv = (mode: "apply" | "reconcile", args: Route, dryRun = false) => [
  "ntn-skills",
  "ctl",
  "library",
  "sources",
  "recovery",
  "repair-file",
  mode,
  args.plan,
  ...(Option.isSome(args.operation) ? ["--operation", args.operation.value] : []),
  "--entry",
  args.entry,
  "--review",
  args.review,
  "--review-id",
  args.reviewId,
  ...(dryRun ? ["--dry-run"] : []),
]
const review = defineCommand(
  "review",
  {
    ...common,
    target: requiredSingleton(
      "target",
      "Original Skill page, not a replacement or supporting page",
    ),
    path: requiredSingleton("path", "Exact already allocated supporting Markdown path"),
    output: requiredSingleton("output", "Private complete original file-repair plan"),
  },
  (args) =>
    Effect.gen(function* () {
      const plan = yield* readSourceJson(args.plan, 192 * 1024 * 1024)
      const { result, budget } = yield* withSourceCommandBudget(
        reviewSharedSourceFileRepair({
          entry: args.entry,
          plan,
          operationId: Option.getOrUndefined(args.operation),
          target: args.target,
          path: args.path,
        }),
        yield* parseSourceBudget(args),
      )
      yield* (yield* Store).output(
        args.output,
        new TextEncoder().encode(JSON.stringify(result, null, 2) + "\n"),
      )
      yield* emit({
        status: "reviewed",
        review_id: result.review.review_id,
        operation_id: result.review.operation_id,
        page_id: result.review.skill_page_id,
        file_id: result.review.file_id,
        file_page_id: result.review.file_page_id,
        path: result.review.path,
        before_body: result.review.before_body,
        candidate_body: result.review.candidate_body,
        output: args.output,
        remote_writes: 0,
        budget,
        request_metrics: (yield* Notion).requestMetrics?.(),
        next: {
          argv: argv(
            "apply",
            { ...args, review: args.output, reviewId: result.review.review_id },
            true,
          ),
          read_only: true,
          reason:
            "Preview the exact original file and physical row repair. Keep the complete private plan, native ACKs and preimage unchanged.",
        },
      })
    }),
).pipe(
  Command.withDescription(
    "Read the original retained import failure, complete manifest and true native allocation ACK prefix. Review exactly one physical table code marker padded by native import. Preserve all other code, text, destinations and rows. Never trim general code, patch the whole Markdown page, create a replacement File, or grant permission to an unknown/rejected request.",
  ),
)

function execution(mode: "apply" | "reconcile") {
  return defineCommand(
    mode,
    {
      ...common,
      review: requiredSingleton("review", "Complete saved file-repair plan"),
      reviewId: requiredSingleton("review-id", "Exact independently inspected repair digest"),
      dryRun: switchFlag(
        "dry-run",
        "Preview exact original body, row and prefix without writes; apply only",
      ),
    },
    (args) =>
      Effect.gen(function* () {
        if (mode === "reconcile" && args.dryRun)
          return yield* Effect.fail(
            fail("INVALID_ARGUMENT", "Reconcile is already read-only; omit --dry-run."),
          )
        const plan = yield* readSourceJson(args.plan, 192 * 1024 * 1024),
          repair = yield* readSourceJson(args.review, 192 * 1024 * 1024)
        const input = {
          entry: args.entry,
          plan,
          operationId: Option.getOrUndefined(args.operation),
          repair,
          reviewId: args.reviewId,
          dryRun: args.dryRun,
        }
        const next = {
          argv: argv("reconcile", args),
          read_only: true,
          reason:
            "Read the original file-repair proof; no current equality permits a repeated row PATCH.",
        }
        const action = Effect.gen(function* () {
          if (mode === "apply") return yield* applySharedSourceFileRepair(input)
          return yield* reconcileSharedSourceFileRepair(input)
        })
        const { result, budget } = yield* withSourceCommandBudget(
          action,
          yield* parseSourceBudget(args),
        ).pipe(
          Effect.mapError((error) =>
            fail(error.code, error.message, { ...property(error.details), next }),
          ),
        )
        yield* emit({
          ...result,
          budget,
          request_metrics: (yield* Notion).requestMetrics?.(),
          next:
            result.status === "completion_pending"
              ? {
                  argv: argv("apply", args, true),
                  read_only: true,
                  reason:
                    "The exact original row ACK and full readback are verified. Preview only completion of its missing immutable proof; no row PATCH is needed.",
                }
              : mode === "apply" && args.dryRun
                ? {
                    argv: argv("apply", args),
                    read_only: false,
                    reason:
                      "table_row_patches" in result && result.table_row_patches === 0
                        ? "Complete the missing immutable proof from the actual original row ACK; the row update is not dispatched again."
                        : "Authorize only this one original table-row correction. Original file/page identity and failed create stay retained.",
                  }
                : next,
          original_recovery: {
            argv: [
              "ntn-skills",
              "ctl",
              "library",
              "sources",
              "recovery",
              "review",
              args.plan,
              ...(Option.isSome(args.operation) ? ["--operation", args.operation.value] : []),
              "--entry",
              args.entry,
              "--target",
              result.page_id,
              "--output",
              args.review + ".original-recovery.json",
            ],
            read_only: true,
            reason:
              "A repaired file is not a completed import. Prepare a separate original-operation recovery review only after the exact repair completes.",
          },
        })
      }),
  ).pipe(
    Command.withDescription(
      mode === "apply"
        ? "Apply one reviewed original table-row patch through the existing durable source mutation guard. Preserve the complete preimage, exact original allocation proofs and actual row ACK; verify the full original file afterwards. Unknown outcomes remain pending and block original recovery; no whole-page update or replacement creation."
        : "Read the full retained file-repair review, original failure/allocation ACKs, exact row response and complete before/after bodies. This is historical repair proof, separate from current eligibility and whole-Skill completion.",
    ),
  )
}
export const sourceFileRepairCommand = defineCommand("repair-file").pipe(
  Command.withSubcommands([review, execution("apply"), execution("reconcile")]),
)
