import { Effect } from "effect"
import { Argument, Command } from "effect/cli"
import { databaseId } from "../../core/src/catalog.ts"
import { defineCommand } from "../../core/src/command-schema.ts"
import { fail, property } from "../../core/src/model.ts"
import { Notion, withNotionRequestAttribution } from "../../core/src/notion.ts"
import { withReadOnlyNotion } from "../../core/src/notion-readonly.ts"
import { pageId } from "../../core/src/ref.ts"
import {
  reviewSharedFileAddAcceptance,
  applySharedFileAddAcceptance,
  reconcileSharedFileAddAcceptance,
} from "../../core/src/shared-file-add-acceptance.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { withSourceCommandBudget } from "../../core/src/shared-source-budget.ts"
import { withSourceUpdateLock } from "../../core/src/shared-source-policy.ts"
import { Store } from "../../core/src/store.ts"
import { emit, requiredSingleton, switchFlag } from "./command-options.ts"
import { readSourceJson } from "./command-source-input.ts"
import { parseSourceBudget, sourceRequestBudgets } from "./commands-library-source-run.ts"

const target = Argument.String("target")
const originalOperation = Argument.String("original-operation")
const entry = requiredSingleton("entry", "Exact original shared library")
const selected = (value: string) =>
  Effect.gen(function* () {
    const page = pageId(value)
    if (!page)
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Select the exact original shared Skill page."),
      )
    return page
  })
const review = defineCommand(
  "review",
  {
    target,
    originalOperation,
    entry,
    acceptedObservedSha256: requiredSingleton(
      "accept-observed-sha256",
      "SHA-256 of the exact complete currently observed target Markdown being independently accepted",
    ),
    output: requiredSingleton("output", "Save the complete independent review for inspection"),
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const skillPageId = yield* selected(args.target)
      const { result, budget } = yield* withSourceCommandBudget(
        withNotionRequestAttribution(
          Effect.gen(function* () {
            const library = yield* loadSharedLibrary(yield* databaseId(args.entry))
            return yield* reviewSharedFileAddAcceptance({
              library,
              skillPageId,
              originalOperationId: args.originalOperation,
              acceptedObservedSha256: args.acceptedObservedSha256,
            })
          }),
          {
            phase: "author_preflight",
            skill_page_id: skillPageId,
            operation_id: args.originalOperation,
          },
        ),
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
    "Review an independent current-file acceptance for one ordinary native add retained as needs_review after a complete-body mismatch. Requires the original full plan, known exact page reference, original Store/snapshot and unchanged complete native tree/frontier. The author must first repair the same page to the exact frozen candidate and explicitly select its full observed hash. No writes occur. The old add has no retained complete request/ACK and remains needs_review; this is not its completion or a create retry.",
  ),
)

const apply = defineCommand(
  "apply",
  {
    review: Argument.String("review"),
    entry,
    reviewId: requiredSingleton("review-id", "Exact independently inspected review digest"),
    dryRun: switchFlag("dry-run", "Revalidate the complete independent decision without writes"),
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const saved = yield* readSourceJson(args.review, 192 * 1024 * 1024)
      const proof = property(saved).review ?? saved
      const owner = property(proof).skill_page_id,
        operation = property(proof).operation_id
      const { result, budget } = yield* withSourceCommandBudget(
        withNotionRequestAttribution(
          Effect.gen(function* () {
            const library = yield* loadSharedLibrary(yield* databaseId(args.entry))
            return yield* withSourceUpdateLock(
              library,
              applySharedFileAddAcceptance({
                library,
                review: proof,
                reviewId: args.reviewId,
                dryRun: args.dryRun,
              }),
            )
          }),
          {
            phase: "author_preflight",
            skill_page_id: typeof owner === "string" ? owner : null,
            operation_id: typeof operation === "string" ? operation : null,
          },
        ),
        yield* parseSourceBudget(args),
      )
      yield* emit({ ...result, budget, request_metrics: (yield* Notion).requestMetrics?.() })
    }),
).pipe(
  Command.withDescription(
    "Apply only the inspected independent current-file decision in the original credential and Store. Revalidate exact owner/File/page, all native bytes, relations and prior frontier before each new immutable Record. Retain a separate review, new adopted event and independent acceptance; never create a File, PATCH a body/property, dispatch the original add event or change the original needs_review outcome. Unknown Record writes are never replayed. Repeated completed decisions are read-only; obtain a fresh current read afterward.",
  ),
)

const reconcile = defineCommand(
  "reconcile",
  { target, originalOperation, entry, ...sourceRequestBudgets },
  (args) =>
    Effect.gen(function* () {
      const skillPageId = yield* selected(args.target)
      const { result, budget } = yield* withSourceCommandBudget(
        withNotionRequestAttribution(
          Effect.gen(function* () {
            const library = yield* loadSharedLibrary(yield* databaseId(args.entry))
            return yield* reconcileSharedFileAddAcceptance({
              library,
              skillPageId,
              originalOperationId: args.originalOperation,
            })
          }),
          { phase: "reconcile", skill_page_id: skillPageId, operation_id: args.originalOperation },
        ),
        yield* parseSourceBudget(args),
      )
      yield* emit({ ...result, budget, request_metrics: (yield* Notion).requestMetrics?.() })
    }).pipe(withReadOnlyNotion),
).pipe(
  Command.withDescription(
    "Read the complete shared independent review, original plan/failure, exact new adopted event and acceptance. The original add still has needs_review and unproven completion. Missing or changed evidence remains unresolved; no page, body or Record is written and no current equality supplies an original ACK.",
  ),
)

export const libraryFileAcceptAddCommand = defineCommand("accept-add").pipe(
  Command.withDescription(
    "Explicit independent acceptance of one repaired existing native File after its known original add mismatch. This does not ignore arbitrary pending work or recover an unknown create.",
  ),
  Command.withSubcommands([review, apply, reconcile]),
)
