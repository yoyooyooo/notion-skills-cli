import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import type { PlatformError } from "effect/PlatformError"
import { defineCommand } from "../../core/src/command-schema.ts"
import { fail, property, type SkillsError } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { retainedNotionRejectionDiagnostics } from "../../core/src/notion-validation-diagnostic.ts"
import { withReadOnlyNotion } from "../../core/src/notion-readonly.ts"
import { Store } from "../../core/src/store.ts"
import { withSourceCommandBudget } from "../../core/src/shared-source-budget.ts"
import {
  reviewSharedSourceFileResubmission,
  applySharedSourceFileResubmission,
  reconcileSharedSourceFileResubmission,
} from "../../core/src/shared-source-file-resubmission.ts"
import { readSourceJson } from "./command-source-input.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"
import { parseSourceBudget, sourceRequestBudgets } from "./commands-library-source-run.ts"

const common = {
  plan: Argument.String("plan"),
  entry: requiredSingleton("entry", "Exact original registered library"),
  operation: singleton("operation", "Exact original creation selected from the frozen parent"),
  ...sourceRequestBudgets,
}
type Route = {
  readonly plan: string
  readonly entry: string
  readonly operationId?: string
  readonly review: string
  readonly reviewId: string
}

export function sourceFileResubmissionNext(
  input: Route & { readonly action: "preview" | "apply" | "reconcile" },
) {
  return {
    argv: [
      "ntn-skills",
      "ctl",
      "library",
      "sources",
      "recovery",
      "resubmit-file",
      input.action === "reconcile" ? "reconcile" : "apply",
      input.plan,
      ...(input.operationId === undefined ? [] : ["--operation", input.operationId]),
      "--entry",
      input.entry,
      "--review",
      input.review,
      "--review-id",
      input.reviewId,
      ...(input.action === "preview" ? ["--dry-run"] : []),
    ],
    read_only: input.action !== "apply",
    reason:
      input.action === "preview"
        ? "Preview the independently reviewed new request. Preserve the original rejected POST and its negative receipt."
        : input.action === "apply"
          ? "Authorize only this independently identified file submission. The original rejected POST is never replayed."
          : "Inspect the exact new request and retained original rejection. Unknown outcomes never authorize another POST.",
  }
}

export function sourceFileResubmissionOriginalNext(
  input: Pick<Route, "plan" | "entry" | "operationId"> & { readonly target: string },
) {
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
      "Inspect the unchanged original creation and its retained recovery review before continuing its remaining work. A completed file does not complete the Skill.",
  }
}

type ResubmissionResult =
  | Effect.Success<ReturnType<typeof applySharedSourceFileResubmission>>
  | Effect.Success<ReturnType<typeof reconcileSharedSourceFileResubmission>>

export function sourceFileResubmissionResultNext(
  input: Route & { readonly preview: boolean; readonly result: ResubmissionResult },
) {
  if (input.result.status === "completion_pending")
    return {
      ...sourceFileResubmissionNext({ ...input, action: "preview" }),
      reason:
        "Preview completion of the independently acknowledged file. Verify its exact ACK and full readback before retaining the missing completion proof; no native POST is repeated.",
    }
  const next = sourceFileResubmissionNext({
    ...input,
    action: input.preview && input.result.status === "reviewed" ? "apply" : "reconcile",
  })
  return input.preview &&
    input.result.status === "reviewed" &&
    input.result.native_pages_to_create === 0
    ? {
        ...next,
        reason:
          "Complete only the missing immutable proof from the independently acknowledged file and full readback. The native POST is not dispatched again.",
      }
    : next
}

function failure(
  received: SkillsError | PlatformError,
  next: object,
  identity: Readonly<Record<string, unknown>>,
) {
  const error =
    received._tag === "SkillsError"
      ? received
      : fail(
          "IO_ERROR",
          "Cannot complete the independent file review or output. Preserve the saved original evidence.",
        )
  const details = property(error.details)
  const original = property(details.original_details)
  const observed = { ...details, ...original }
  const bounded: Record<string, string> = {}
  for (const key of [
    "operation_id",
    "original_operation_id",
    "native_create_operation_id",
    "skill_page_id",
    "page_id",
    "file_page_id",
    "file_id",
    "path",
    "review_id",
  ]) {
    const value = identity[key] ?? original[key] ?? details[key]
    if (typeof value === "string" && value.length <= 256) bounded[key] = value
  }
  return fail(
    error.code,
    error.message.length <= 512
      ? error.message
      : "The independent file request could not be verified. Inspect the exact operation through read-only reconciliation.",
    {
      ...bounded,
      ...retainedNotionRejectionDiagnostics(observed),
      ...(typeof observed.http_status === "number" &&
      Number.isInteger(observed.http_status) &&
      observed.http_status >= 100 &&
      observed.http_status <= 599
        ? { http_status: observed.http_status }
        : {}),
      ...(typeof observed.response_bytes === "number" &&
      Number.isSafeInteger(observed.response_bytes) &&
      observed.response_bytes >= 0
        ? { response_bytes: observed.response_bytes }
        : {}),
      ...(["invalid_json", "response_limit", "network"].some((reason) => observed.reason === reason)
        ? { reason: observed.reason }
        : {}),
      ...(observed.notion_code === "validation_error" ? { notion_code: "validation_error" } : {}),
      ...(observed.phase === "definitive_rejection" ? { phase: "definitive_rejection" } : {}),
      ...(observed.native_retry_allowed === false ? { native_retry_allowed: false } : {}),
      next,
    },
  )
}

export function sourceFileResubmissionFailure(error: SkillsError | PlatformError, route: Route) {
  return failure(error, sourceFileResubmissionNext({ ...route, action: "reconcile" }), {
    original_operation_id: route.operationId,
    review_id: route.reviewId,
  })
}

const review = defineCommand(
  "review",
  {
    ...common,
    target: requiredSingleton("target", "Original Skill page with the confirmed allocation prefix"),
    path: requiredSingleton(
      "path",
      "Exact supporting Markdown file whose original POST was rejected",
    ),
    output: requiredSingleton(
      "output",
      "Private complete resubmission review and original evidence",
    ),
    wirePolicy: singleton(
      "wire-policy",
      "native_image_blocks_v1 (default), or native_linked_images_v2 after a proven rejection of the first independent request",
    ),
  },
  (args) =>
    Effect.gen(function* () {
      const plan = yield* readSourceJson(args.plan, 192 * 1024 * 1024)
      const operationId = Option.getOrUndefined(args.operation)
      const wirePolicy = Option.getOrElse(args.wirePolicy, () => "native_image_blocks_v1")
      if (wirePolicy !== "native_image_blocks_v1" && wirePolicy !== "native_linked_images_v2")
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Select native_image_blocks_v1 or native_linked_images_v2."),
        )
      const { result, budget } = yield* withSourceCommandBudget(
        reviewSharedSourceFileResubmission({
          entry: args.entry,
          plan,
          operationId,
          target: args.target,
          path: args.path,
          wirePolicy,
        }),
        yield* parseSourceBudget(args),
      )
      yield* (yield* Store).output(
        args.output,
        new TextEncoder().encode(JSON.stringify(result, null, 2) + "\n"),
      )
      const reviewed = result.review
      yield* emit({
        status: "reviewed",
        review_id: reviewed.review_id,
        original_operation_id: reviewed.original_operation_id,
        skill_page_id: reviewed.skill_page_id,
        file_id: reviewed.file_id,
        path: reviewed.path,
        wire_policy: reviewed.wire_policy,
        changes: reviewed.changes,
        original_request_sha256: reviewed.original_request_sha256,
        candidate_body_sha256: reviewed.candidate_body_sha256,
        output: args.output,
        remote_writes: 0,
        budget,
        request_metrics: (yield* Notion).requestMetrics?.(),
        next: sourceFileResubmissionNext({
          plan: args.plan,
          entry: args.entry,
          operationId,
          review: args.output,
          reviewId: reviewed.review_id,
          action: "preview",
        }),
      })
    }).pipe(
      withReadOnlyNotion,
      Effect.mapError((error) =>
        failure(
          error,
          sourceFileResubmissionOriginalNext({
            plan: args.plan,
            entry: args.entry,
            operationId: Option.getOrUndefined(args.operation),
            target: args.target,
          }),
          {
            original_operation_id: Option.getOrUndefined(args.operation),
            skill_page_id: args.target,
            path: args.path,
          },
        ),
      ),
    ),
).pipe(
  Command.withDescription(
    "Review one independent new request after a complete original 400 validation rejection with no allocation ACK. Preserve the frozen input, original wire, failure and confirmed prefix. native_image_blocks_v1 separates adjacent image-only paragraphs. Explicit --wire-policy native_linked_images_v2 requires the first independent request's complete negative receipt, retains its immutable review and makes each linked image a standalone original image plus an explicit text link. Unknown or incomplete predecessors cannot qualify; old requests are never repeated. Save complete evidence privately. A dry-run checks eligibility, not the provider's Markdown parser.",
  ),
)

function execution(mode: "apply" | "reconcile") {
  return defineCommand(
    mode,
    {
      ...common,
      review: requiredSingleton("review", "Complete saved independent resubmission review"),
      reviewId: requiredSingleton("review-id", "Exact independently inspected review digest"),
      dryRun: switchFlag("dry-run", "Preview the exact new request without writes; apply only"),
    },
    (args) => {
      const route = {
        plan: args.plan,
        entry: args.entry,
        operationId: Option.getOrUndefined(args.operation),
        review: args.review,
        reviewId: args.reviewId,
      }
      return Effect.gen(function* () {
        if (mode === "reconcile" && args.dryRun)
          return yield* Effect.fail(
            fail("INVALID_ARGUMENT", "Reconcile is read-only; omit --dry-run."),
          )
        const plan = yield* readSourceJson(args.plan, 192 * 1024 * 1024)
        const saved = yield* readSourceJson(args.review, 192 * 1024 * 1024)
        const input = {
          entry: args.entry,
          plan,
          operationId: route.operationId,
          review: saved,
          reviewId: args.reviewId,
          dryRun: args.dryRun,
        }
        const action = Effect.gen(function* () {
          if (mode === "apply") return yield* applySharedSourceFileResubmission(input)
          return yield* reconcileSharedSourceFileResubmission(input)
        })
        const { result, budget } = yield* withSourceCommandBudget(
          mode === "reconcile" || args.dryRun ? action.pipe(withReadOnlyNotion) : action,
          yield* parseSourceBudget(args),
        )
        yield* emit({
          ...result,
          budget,
          request_metrics: (yield* Notion).requestMetrics?.(),
          next: sourceFileResubmissionResultNext({
            ...route,
            preview: mode === "apply" && args.dryRun,
            result,
          }),
          ...(result.status !== "completed" || !result.verified
            ? {}
            : {
                original_recovery: sourceFileResubmissionOriginalNext({
                  ...route,
                  target: result.skill_page_id,
                }),
              }),
        })
      }).pipe(Effect.mapError((error) => sourceFileResubmissionFailure(error, route)))
    },
  ).pipe(
    Command.withDescription(
      mode === "apply"
        ? "Apply only the independently reviewed new native-image request through the existing durable dispatcher. Keep the original negative receipt and failed create unchanged; require a separate real ACK and full semantic readback. Repeated or unknown results cannot authorize another POST. --dry-run performs the same eligibility review without writes."
        : "Read the complete independent submission review, original negative receipt, separate new request ACK and full readback proof. This verifies the single file, not whole-Skill completion; it never dispatches another request.",
    ),
  )
}

export const sourceFileResubmissionCommand = defineCommand("resubmit-file").pipe(
  Command.withDescription(
    "Review, apply and reconcile one independent file request after a proven original rejection",
  ),
  Command.withSubcommands([review, execution("apply"), execution("reconcile")]),
)
