import { Effect } from "effect"
import { Argument, Command } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { property } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { withReadOnlyNotion } from "../../core/src/notion-readonly.ts"
import { validateSharedCreatePlan } from "../../core/src/shared-create-model.ts"
import {
  applySharedCreateContinuation,
  reviewSharedCreateContinuation,
} from "../../core/src/shared-create-recovery.ts"
import { withSourceCommandBudget } from "../../core/src/shared-source-budget.ts"
import { withSourceUpdateLock } from "../../core/src/shared-source-policy.ts"
import { Store } from "../../core/src/store.ts"
import { emit, requiredSingleton, switchFlag } from "./command-options.ts"
import { readSourceJson } from "./command-source-input.ts"
import { parseSourceBudget, sourceRequestBudgets } from "./commands-library-source-run.ts"

const plan = Argument.String("plan")
const entry = requiredSingleton("entry", "Exact original shared library")
const review = defineCommand(
  "review",
  {
    plan,
    entry,
    target: requiredSingleton("target", "Original acknowledged Skill page"),
    output: requiredSingleton("output", "New or identical continuation review JSON"),
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const original = yield* validateSharedCreatePlan(
        yield* readSourceJson(args.plan, 192 * 1024 * 1024),
      )
      const { result, budget } = yield* withSourceCommandBudget(
        reviewSharedCreateContinuation({
          entry: args.entry,
          operationId: original.operation_id,
          target: args.target,
          plan: original,
        }),
        yield* parseSourceBudget(args),
      )
      yield* (yield* Store).output(
        args.output,
        new TextEncoder().encode(JSON.stringify(result, null, 2) + "\n"),
      )
      yield* emit({
        status: "reviewed",
        continuation_id: result.continuation_id,
        review: result,
        output: args.output,
        remote_writes: 0,
        budget,
        request_metrics: (yield* Notion).requestMetrics?.(),
      })
    }).pipe(withReadOnlyNotion),
).pipe(
  Command.withDescription(
    "Review the exact original v3/v10 Source recovery after every native page was durably acknowledged and before metadata, initial events or enablement. Verify all original requests and complete v11 bodies. Save a separate explicit decision; no page is created, replaced or inferred from current equality.",
  ),
)

const apply = defineCommand(
  "apply",
  {
    plan,
    entry,
    review: requiredSingleton("review", "Saved complete continuation review"),
    reviewId: requiredSingleton("review-id", "Independently inspected continuation digest"),
    dryRun: switchFlag(
      "dry-run",
      "Verify the complete original ACK set and exact write set without mutation",
    ),
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const original = yield* validateSharedCreatePlan(
        yield* readSourceJson(args.plan, 192 * 1024 * 1024),
      )
      const saved = yield* readSourceJson(args.review, 192 * 1024 * 1024)
      const operation = applySharedCreateContinuation({
        entry: args.entry,
        plan: original,
        review: property(saved).review ?? saved,
        reviewId: args.reviewId,
        dryRun: args.dryRun,
      })
      const { result, budget } = yield* withSourceCommandBudget(
        withSourceUpdateLock(
          original.library,
          args.dryRun ? operation.pipe(withReadOnlyNotion) : operation,
        ),
        yield* parseSourceBudget(args),
      )
      yield* emit({ ...result, budget, request_metrics: (yield* Notion).requestMetrics?.() })
    }),
).pipe(
  Command.withDescription(
    "Apply the separately reviewed correction on existing acknowledged pages. Retain full original ACK proofs, corrected immutable body facts and complete initial events, update only exact Projection metadata, then enable and record completion. No native page POST or body PATCH is allowed. Repeated or unknown attempts only use original recovery reconciliation.",
  ),
)

export const sourceContinuationCommand = defineCommand("continuation").pipe(
  Command.withDescription(
    "Explicit correction of a fully acknowledged Source recovery before initial ownership",
  ),
  Command.withSubcommands([review, apply]),
)
