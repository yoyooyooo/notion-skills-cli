import { Effect } from "effect"
import { Argument, Command } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { property } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { withReadOnlyNotion } from "../../core/src/notion-readonly.ts"
import { validateSharedCreatePlan } from "../../core/src/shared-create-model.ts"
import {
  applySharedCreateRecovery,
  reconcileSharedCreateRecovery,
  reviewSharedCreateRecovery,
} from "../../core/src/shared-create-recovery.ts"
import { withSourceCommandBudget } from "../../core/src/shared-source-budget.ts"
import { withSourceUpdateLock } from "../../core/src/shared-source-policy.ts"
import { Store } from "../../core/src/store.ts"
import { emit, requiredSingleton, switchFlag } from "./command-options.ts"
import { readSourceJson } from "./command-source-input.ts"
import { parseSourceBudget, sourceRequestBudgets } from "./commands-library-source-run.ts"
import { sourceContinuationCommand } from "./commands-library-source-continuation.ts"

const planArg = Argument.String("plan")
const entry = requiredSingleton("entry", "Exact original shared library")
const target = requiredSingleton(
  "target",
  "Existing main page with the original durable create ACK",
)

const review = defineCommand(
  "review",
  {
    plan: planArg,
    entry,
    target,
    output: requiredSingleton("output", "New or identical recovery review JSON"),
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const plan = yield* validateSharedCreatePlan(
        yield* readSourceJson(args.plan, 192 * 1024 * 1024),
      )
      const limits = yield* parseSourceBudget(args)
      const { result, budget } = yield* withSourceCommandBudget(
        reviewSharedCreateRecovery({
          entry: args.entry,
          operationId: plan.operation_id,
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
      })
    }).pipe(withReadOnlyNotion),
).pipe(
  Command.withDescription(
    "Review an exact original v1 fixed Git admission: an acknowledged main before its manifest (v8 to v9, v9 to v10, or v10 to v11), or a known v9/v10 body-mismatch failure with an acknowledged page prefix. Each saved version retains its fixed projection meaning. Require the original local journal, exact dispatches and ACKs, disabled ownership, complete bodies matching the fixed new projection and unchanged Source. Save and inspect the explicit recovery digest.",
  ),
)

const apply = defineCommand(
  "apply",
  {
    plan: planArg,
    entry,
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
      const plan = yield* validateSharedCreatePlan(
        yield* readSourceJson(args.plan, 192 * 1024 * 1024),
      )
      const saved = yield* readSourceJson(args.review, 192 * 1024 * 1024)
      const limits = yield* parseSourceBudget(args)
      const operation = applySharedCreateRecovery({
        entry: args.entry,
        plan,
        review: property(saved).review ?? saved,
        reviewId: args.reviewId,
        dryRun: args.dryRun,
      })
      const { result, budget } = yield* withSourceCommandBudget(
        withSourceUpdateLock(
          plan.library,
          args.dryRun ? operation.pipe(withReadOnlyNotion) : operation,
        ),
        limits,
      )
      yield* emit({ ...result, budget, request_metrics: (yield* Notion).requestMetrics?.() })
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
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const plan = yield* validateSharedCreatePlan(
        yield* readSourceJson(args.plan, 192 * 1024 * 1024),
      )
      const limits = yield* parseSourceBudget(args)
      const { result, budget } = yield* withSourceCommandBudget(
        reconcileSharedCreateRecovery({
          entry: args.entry,
          operationId: plan.operation_id,
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
  Command.withSubcommands([review, apply, reconcile, sourceContinuationCommand]),
)
