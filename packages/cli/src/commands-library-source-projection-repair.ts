import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { fail, property } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { Store } from "../../core/src/store.ts"
import { withSourceCommandBudget } from "../../core/src/shared-source-budget.ts"
import {
  reviewSharedSourceProjectionRepair,
  applySharedSourceProjectionRepair,
  reconcileSharedSourceProjectionRepair,
} from "../../core/src/shared-source-projection-repair.ts"
import { readSourceJson } from "./command-source-input.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"
import { parseSourceBudget, sourceRequestBudgets } from "./commands-library-source-run.ts"

const common = {
  plan: Argument.String("plan"),
  entry: requiredSingleton("entry", "Exact original shared library entry"),
  operation: singleton("operation", "Exact child operation for a saved onboarding parent"),
  ...sourceRequestBudgets,
}
function argv(
  mode: "apply" | "reconcile",
  input: {
    plan: string
    entry: string
    operation: Option.Option<string>
    review: string
    reviewId: string
  },
  dryRun = false,
) {
  return [
    "ntn-skills",
    "ctl",
    "library",
    "sources",
    "recovery",
    "repair",
    mode,
    input.plan,
    ...(Option.isSome(input.operation) ? ["--operation", input.operation.value] : []),
    "--entry",
    input.entry,
    "--review",
    input.review,
    "--review-id",
    input.reviewId,
    ...(dryRun ? ["--dry-run"] : []),
  ]
}
const review = defineCommand(
  "review",
  {
    ...common,
    target: requiredSingleton("target", "The exact original allocated main page"),
    output: requiredSingleton(
      "output",
      "Private complete repair review; retain it for apply/reconcile",
    ),
  },
  (args) =>
    Effect.gen(function* () {
      const plan = yield* readSourceJson(args.plan, 192 * 1024 * 1024)
      const { result, budget } = yield* withSourceCommandBudget(
        reviewSharedSourceProjectionRepair({
          entry: args.entry,
          plan,
          target: args.target,
          operationId: Option.getOrUndefined(args.operation),
        }),
        yield* parseSourceBudget(args),
      )
      yield* (yield* Store).output(
        args.output,
        new TextEncoder().encode(JSON.stringify(result, null, 2) + "\n"),
      )
      yield* emit({
        status: "reviewed",
        review_id: result.review_id,
        operation_id: result.operation_id,
        page_id: result.skill_page_id,
        file_id: result.file_id,
        path: result.path,
        output: args.output,
        candidate: result.candidate,
        previous_attempt:
          result.previous.kind === "none"
            ? { kind: "none" }
            : {
                kind: result.previous.kind,
                review_id: result.previous.review_id,
                review_record_hash: result.previous.review_record_hash,
                body_operation_id: result.previous.body_ack.operation_id,
              },
        preimage_sha256: result.before.sha256,
        remote_writes: 0,
        budget,
        request_metrics: (yield* Notion).requestMetrics?.(),
        next: {
          argv: argv("apply", { ...args, review: args.output, reviewId: result.review_id }, true),
          read_only: true,
          reason:
            "Preview the same original-page repair; the private review retains the exact complete preimage and original ACK.",
        },
      })
    }),
).pipe(
  Command.withDescription(
    "Review one acknowledged, disabled retained-source main before its original manifest. Permit only known ordinary table + to bullet corruption with every other text/code/destination unchanged. Freeze an explicitly protected v17 wire, original page/input/ACK and full observed preimage. A previous v16 attempt is eligible only when its exact durable body ACK proves the complete unchanged preimage; retain its full original review separately. No writes or new Skill. Never supersede an unknown response, changed body or rejected file POST.",
  ),
)

function execution(mode: "apply" | "reconcile") {
  return defineCommand(
    mode,
    {
      ...common,
      review: requiredSingleton("review", "Saved complete original-page repair review"),
      reviewId: requiredSingleton("review-id", "Exact independently inspected repair digest"),
      dryRun: switchFlag(
        "dry-run",
        "Preview exact preimage and original ACK guards without writes; apply only",
      ),
    },
    (args) =>
      Effect.gen(function* () {
        if (mode === "reconcile" && args.dryRun)
          return yield* Effect.fail(
            fail("INVALID_ARGUMENT", "Reconcile is already read-only; omit --dry-run."),
          )
        const plan = yield* readSourceJson(args.plan, 192 * 1024 * 1024)
        const saved = yield* readSourceJson(args.review, 192 * 1024 * 1024)
        const input = {
          entry: args.entry,
          plan,
          operationId: Option.getOrUndefined(args.operation),
          review: property(saved).review ?? saved,
          reviewId: args.reviewId,
          dryRun: args.dryRun,
        }
        const action = Effect.gen(function* () {
          if (mode === "apply") return yield* applySharedSourceProjectionRepair(input)
          return yield* reconcileSharedSourceProjectionRepair(input)
        })
        const next = {
          argv: argv("reconcile", args),
          read_only: true,
          reason:
            "Read the original repair proof. Do not repeat unknown body writes or replace the original creation plan.",
        }
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
            mode === "apply" && args.dryRun
              ? {
                  argv: argv("apply", args),
                  read_only: false,
                  reason:
                    "Explicitly authorize one guarded whole-body replacement on the original page; no property or enabled state is changed.",
                }
              : next,
          after_verified_repair: {
            argv: [
              "ntn-skills",
              "ctl",
              "library",
              "sources",
              property(plan).kind === "source_onboarding" ? "onboard-apply" : "admit-apply",
              args.plan,
              "--entry",
              args.entry,
              "--dry-run",
            ],
            read_only: true,
            reason:
              "A repaired main does not complete its original import. Revalidate the unchanged onboarding parent before explicitly continuing.",
          },
        })
      }),
  ).pipe(
    Command.withDescription(
      mode === "apply"
        ? "Apply one frozen original-main repair through the existing durable mutation guard and whole-preimage update. Retain the complete before image and original allocation proof; never rewrite input, enable a Skill or create a replacement page. Unknown or rejected PATCH stays unreplayed."
        : "Read the separate original projection repair review, main allocation proof and actual body ACK. Historical repair completion is separate from original creation completion and current content health.",
    ),
  )
}
export const sourceProjectionRepairCommand = defineCommand("repair").pipe(
  Command.withDescription(
    "Explicit original-page repair of a known pre-manifest table-literal import corruption; not a retry of rejected or unknown creation",
  ),
  Command.withSubcommands([review, execution("apply"), execution("reconcile")]),
)
