import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { fail, property } from "../../core/src/model.ts"
import { pageId } from "../../core/src/ref.ts"
import { Notion } from "../../core/src/notion.ts"
import { withReadOnlyNotion } from "../../core/src/notion-readonly.ts"
import {
  applySharedSourceRecovery,
  reconcileSharedSourceRecovery,
  reviewSharedSourceRecovery,
} from "../../core/src/shared-source-recovery.ts"
import { withSourceCommandBudget } from "../../core/src/shared-source-budget.ts"
import { Store } from "../../core/src/store.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"
import { readSourceJson } from "./command-source-input.ts"
import { parseSourceBudget, sourceRequestBudgets } from "./commands-library-source-run.ts"
import { sourceContinuationCommand } from "./commands-library-source-continuation.ts"
import { sourceProjectionRepairCommand } from "./commands-library-source-projection-repair.ts"

const planArg = Argument.String("plan")
const entry = requiredSingleton("entry", "Exact original shared library")
const operation = singleton(
  "operation",
  "Exact original child operation ID; required when plan is a saved onboarding parent",
)
const target = requiredSingleton(
  "target",
  "Existing main page with the original durable create ACK",
)

export function sourceRecoveryReconcileNext(input: {
  readonly plan: string
  readonly entry: string
  readonly operationId?: string
  readonly target: unknown
}) {
  if (typeof input.target !== "string" || pageId(input.target) !== input.target) return undefined
  return {
    argv: [
      "ntn-skills",
      "ctl",
      "library",
      "sources",
      "recovery",
      "reconcile",
      input.plan,
      ...(input.operationId === undefined ? [] : ["--operation", input.operationId]),
      "--entry",
      input.entry,
      "--target",
      input.target,
    ],
    read_only: true,
    reason:
      "Inspect this exact original recovery. A refused or unknown suffix is not permission to repeat a native write.",
  }
}

const review = defineCommand(
  "review",
  {
    plan: planArg,
    entry,
    target,
    operation,
    output: requiredSingleton("output", "New or identical recovery review JSON"),
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const plan = yield* readSourceJson(args.plan, 192 * 1024 * 1024)
      const limits = yield* parseSourceBudget(args)
      const { result, budget } = yield* withSourceCommandBudget(
        reviewSharedSourceRecovery({
          entry: args.entry,
          operationId: Option.getOrUndefined(args.operation),
          target: args.target,
          plan,
        }),
        limits,
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
        next: {
          argv: [
            "ntn-skills",
            "ctl",
            "library",
            "sources",
            "recovery",
            "apply",
            args.plan,
            ...(Option.isSome(args.operation) ? ["--operation", args.operation.value] : []),
            "--entry",
            args.entry,
            "--review",
            args.output,
            "--review-id",
            result.review_id,
            "--dry-run",
          ],
          read_only: true,
          reason:
            "Preview only this saved independently reviewed original recovery before authorizing its unissued suffix.",
        },
      })
    }).pipe(withReadOnlyNotion),
).pipe(
  Command.withDescription(
    "Review an exact original fixed Git admission under its existing versioned recovery rules, or a known retained-source native-import failure whose complete current prefix is semantically unchanged. Retained import keeps policy 14 and never patches a body. A saved onboarding parent requires --operation to select its exact original child, without editing or regenerating the plan. Require original local journal, native POST/ACKs, complete retained input, disabled ownership and unchanged Source; inspect the explicit recovery digest.",
  ),
)

const apply = defineCommand(
  "apply",
  {
    plan: planArg,
    entry,
    operation,
    review: requiredSingleton("review", "Saved complete recovery review"),
    reviewId: requiredSingleton("review-id", "Independently inspected recovery digest"),
    dryRun: switchFlag(
      "dry-run",
      "Check the original intent, ACK and current guards without writing",
    ),
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const plan = yield* readSourceJson(args.plan, 192 * 1024 * 1024)
      const saved = yield* readSourceJson(args.review, 192 * 1024 * 1024)
      const savedReview = property(saved).review ?? saved
      const reconcileNext = sourceRecoveryReconcileNext({
        plan: args.plan,
        entry: args.entry,
        operationId: Option.getOrUndefined(args.operation),
        target: property(savedReview).skill_page_id,
      })
      const limits = yield* parseSourceBudget(args)
      const action = applySharedSourceRecovery({
        entry: args.entry,
        plan,
        operationId: Option.getOrUndefined(args.operation),
        review: savedReview,
        reviewId: args.reviewId,
        dryRun: args.dryRun,
      })
      const { result, budget } = yield* withSourceCommandBudget(action, limits).pipe(
        Effect.mapError((error) =>
          reconcileNext === undefined
            ? error
            : fail(error.code, error.message, { ...property(error.details), next: reconcileNext }),
        ),
      )
      yield* emit({
        ...result,
        budget,
        request_metrics: (yield* Notion).requestMetrics?.(),
        next: args.dryRun
          ? {
              argv: [
                "ntn-skills",
                "ctl",
                "library",
                "sources",
                "recovery",
                "apply",
                args.plan,
                ...(Option.isSome(args.operation) ? ["--operation", args.operation.value] : []),
                "--entry",
                args.entry,
                "--review",
                args.review,
                "--review-id",
                args.reviewId,
              ],
              read_only: false,
              reason:
                "Explicitly apply only this unchanged reviewed recovery. The original dispatcher still enforces every native ACK and unsent suffix.",
            }
          : reconcileNext,
      })
    }),
).pipe(
  Command.withDescription(
    "Apply one reviewed recovery in the original credential and Store. Preserve every acknowledged page, original input, wire, fixed Source and original terminal state; create only the original undispatched suffix. Publish the fixed-version recovery evidence separately. No existing body is patched. A repeated or unknown attempt only reconciles and never resends page writes.",
  ),
)

const reconcile = defineCommand(
  "reconcile",
  {
    plan: planArg,
    entry,
    target,
    operation,
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const plan = yield* readSourceJson(args.plan, 192 * 1024 * 1024)
      const limits = yield* parseSourceBudget(args)
      const { result, budget } = yield* withSourceCommandBudget(
        reconcileSharedSourceRecovery({
          entry: args.entry,
          operationId: Option.getOrUndefined(args.operation),
          target: args.target,
          plan,
        }),
        limits,
      )
      yield* emit({ ...result, budget, request_metrics: (yield* Notion).requestMetrics?.() })
    }).pipe(withReadOnlyNotion),
).pipe(
  Command.withDescription(
    "Verify the retained original plan and explicit recovery completion without current-body adoption or remote writes. Missing or unknown completion remains unresolved; current equality cannot authorize replay.",
  ),
)

export const sourceRecoveryCommand = defineCommand("recovery").pipe(
  Command.withDescription(
    "Review, apply or reconcile an exact acknowledged Source-admission prefix or known failure",
  ),
  Command.withSubcommands([
    review,
    apply,
    reconcile,
    sourceContinuationCommand,
    sourceProjectionRepairCommand,
  ]),
)
