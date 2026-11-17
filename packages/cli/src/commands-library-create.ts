import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { fail, property } from "../../core/src/model.ts"
import {
  reviewSharedCreateCurrentTree,
  applySharedCreateCurrentTree,
  reconcileSharedCreateCurrentTree,
} from "../../core/src/shared-create-current-tree.ts"
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
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"
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
    acceptCurrentTree: switchFlag(
      "accept-current-tree",
      "Freeze an independent acceptance of the complete disabled ordinary policy-13 tree; preserve its known failed create and do not infer old ACKs",
    ),
    acceptedObservedSha256: singleton(
      "accept-observed-sha256",
      "Exact normalized UTF-8 main readback SHA-256 explicitly accepted for an original complete v15 sole-main create; text, code and authored links must be preserved",
    ),
    repairLocalLinks: switchFlag(
      "repair-local-links",
      "Review exact original same-owner local links, retain their current preimages and repair their acknowledged native pages after the complete tree is allocated",
    ),
    repairTablePlus: singleton(
      "repair-table-plus",
      "Exact original supporting-file path with known ordinary table + to bullet corruption; preserve its complete preimage and repair before the unattempted suffix",
    ),
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const original = yield* readSourceJson(args.plan, 192 * 1024 * 1024)
      if (
        args.acceptCurrentTree &&
        (Option.isSome(args.acceptedObservedSha256) ||
          args.repairLocalLinks ||
          Option.isSome(args.repairTablePlus))
      )
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            "Current-tree acceptance cannot be combined with original-ACK restoration or body repair.",
          ),
        )
      const { result, budget } = yield* withSourceCommandBudget(
        Effect.gen(function* () {
          if (args.acceptCurrentTree)
            return yield* reviewSharedCreateCurrentTree({
              entry: args.entry,
              plan: original,
              target: args.target,
            })
          return yield* reviewSharedCreateRestoration({
            entry: args.entry,
            plan: original,
            target: args.target,
            acceptedObservedSha256: Option.getOrUndefined(args.acceptedObservedSha256),
            repairLocalLinks: args.repairLocalLinks,
            repairTablePlus: Option.getOrUndefined(args.repairTablePlus),
          })
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
        review: result,
        output: args.output,
        remote_writes: 0,
        budget,
        request_metrics: (yield* Notion).requestMetrics?.(),
      })
    }).pipe(withReadOnlyNotion),
).pipe(
  Command.withDescription(
    "Review an original acknowledged create with unchanged metadata and relations. Legacy restoration requires its exact body. A complete ordinary v15 sole-main create may accept --accept-observed-sha256 after text, code and link verification. --repair-local-links instead reviews a complete ordinary multi-file create whose original local file links were treated as hostnames: preserve every original input, page and raw resource, allocate only the original suffix, then repair exact same-owner destinations with guarded body PATCHes. --repair-table-plus PATH instead reviews only the original last acknowledged supporting file of a disabled complete policy-14 ordinary create. Its full body must differ solely at proven ordinary table plus literals; other text, code and destinations remain exact. These review modes are mutually exclusive. Review never writes or starts a replacement create. --accept-current-tree is a separate read-only decision for a complete disabled ordinary policy-13 native tree with a retained known mismatch. It requires exact authored predictions and every raw resource; it preserves the failed create and does not infer original ACKs.",
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
            Effect.gen(function* () {
              const input = {
                entry: args.entry,
                plan: original,
                review: property(saved).review ?? saved,
                reviewId: args.reviewId,
                dryRun: args.dryRun,
              }
              if (property(input.review).kind === "skill_create_current_tree_review")
                return yield* applySharedCreateCurrentTree(input)
              return yield* applySharedCreateRestoration(input)
            }),
          )
        }),
        yield* parseSourceBudget(args),
      )
      yield* emit({ ...result, budget, request_metrics: (yield* Notion).requestMetrics?.() })
    }),
).pipe(
  Command.withDescription(
    "Continue the exact reviewed original native create. Preserve its ACKs and original outcome, create only the original unattempted file or raw-resource suffix, verify the complete tree and retain a separate restoration completion. Version 3 local-link reviews authorize only exact-preimage PATCHes to same-owner pages after all files are allocated; version 4 table-plus reviews repair their one exact acknowledged supporting page first and require the independent PATCH ACK and strict readback before the original unattempted suffix. Older reviews never patch a body. No unknown request is replayed. Dry-run revalidates without remote writes; repeated completion is read-only. A saved current-tree review instead appends only independent review, adopted ownership and completion Records. It never allocates or patches native pages and leaves the original create needs_review and unproven.",
  ),
)
const reconcile = defineCommand(
  "reconcile",
  {
    plan,
    entry,
    target,
    acceptCurrentTree: switchFlag(
      "accept-current-tree",
      "Read the independent complete current-tree acceptance without changing the original failed create",
    ),
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const original = yield* readSourceJson(args.plan, 192 * 1024 * 1024)
      const { result, budget } = yield* withSourceCommandBudget(
        Effect.gen(function* () {
          const input = {
            entry: args.entry,
            plan: original,
            target: args.target,
          }
          if (args.acceptCurrentTree) return yield* reconcileSharedCreateCurrentTree(input)
          return yield* reconcileSharedCreateRestoration(input)
        }),
        yield* parseSourceBudget(args),
      )
      yield* emit({ ...result, budget, request_metrics: (yield* Notion).requestMetrics?.() })
    }).pipe(withReadOnlyNotion),
).pipe(
  Command.withDescription(
    "Read the separate original restoration completion, full main ACK, original failure and complete initial file facts. This proves historical completion and requires a fresh read for current content. Missing or unknown outcomes remain unresolved; reconciliation never dispatches. With --accept-current-tree, verify the separate current-tree acceptance and its distinct ownership facts; the old create remains needs_review. This command never publishes a missing independent fact.",
  ),
)
export const libraryCreateCommand = defineCommand("create").pipe(
  Command.withSubcommands([
    defineCommand("recovery").pipe(Command.withSubcommands([review, apply, reconcile])),
  ]),
)
