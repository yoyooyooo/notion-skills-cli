import { Effect, Schema } from "effect"
import { fail, property, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { BodyFingerprintSchema, isResourceFollowing } from "./shared-file-state.ts"
import {
  assertSharedFileIntentReady,
  fileIntentChecked,
  readSharedFileIntentContext,
} from "./shared-file-intent.ts"
import {
  fileRequestProperty,
  fileRequestResultProperty,
  fileRequestReceiptProperty,
} from "./shared-file-request-schema.ts"
import {
  reconcileSelectedSharedFileRestore,
  restoreSelectedSharedFile,
} from "./shared-file-restore.ts"
import { SharedFileSourceContextSchema } from "./shared-file-source-context-model.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { observeSharedBody } from "./shared-page-body.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { guardedSourceMutation, sourceField, sourceRich } from "./shared-source-definitions.ts"
import { sha256 } from "./store.ts"
export { listSharedFileRequests, type SharedFileRequestTarget } from "./shared-file-request-list.ts"

const RequestContextSchema = Schema.Struct({
  library_id: Schema.String,
  skill_page_id: Schema.String,
  skill_id: Schema.String,
  file_id: Schema.String,
  page_id: Schema.String,
  path: Schema.String,
  intent: Schema.Literals(["none", "restore-follow"]),
  source: SharedFileSourceContextSchema,
  heads: Schema.Array(Schema.String),
  body: BodyFingerprintSchema,
  bytes: Schema.Number,
})
type RequestContext = typeof RequestContextSchema.Type
const FeedbackSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("file_request_result"),
  request_id: Schema.String,
  before: RequestContextSchema,
  status: Schema.Literals([
    "submitted",
    "processing",
    "verified_applied",
    "blocked",
    "unknown",
    "needs_review",
  ]),
  code: Schema.String,
  message: Schema.String,
  source: Schema.Unknown,
  original_operation_id: Schema.NullOr(Schema.String),
  after: Schema.optional(RequestContextSchema),
  submitted: Schema.optional(RequestContextSchema),
})
type Feedback = typeof FeedbackSchema.Type
type RequestInput = {
  readonly library: SharedLibrary
  readonly skillPageId: string
  readonly path: string
}

function observeRequest(input: RequestInput) {
  return Effect.gen(function* () {
    const file = yield* readSharedFileIntentContext(input)
    const table =
      file.binding.file_id === file.index.main.file_id ? input.library.skills : input.library.files
    const requestId = table.property_ids[fileRequestProperty],
      resultId = table.property_ids[fileRequestResultProperty],
      receiptId = table.property_ids[fileRequestReceiptProperty]
    if (
      !requestId ||
      !resultId ||
      !receiptId ||
      new Set([requestId, resultId, receiptId]).size !== 3
    )
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_REQUEST_NOT_CONFIGURED",
          "Register the independent request, readable result and original receipt fields with ctl library file request-schema.",
        ),
      )
    const raw = yield* (yield* Notion).request(`v1/pages/${file.binding.page_id}`)
    const native = yield* fileIntentChecked(() => {
      const row = property(raw)
      if (
        row.id !== file.binding.page_id ||
        row.object !== "page" ||
        row.in_trash === true ||
        row.archived === true ||
        property(row.parent).data_source_id !== table.data_source_id
      )
        throw fail(
          "SHARED_FILE_REQUEST_SCOPE",
          "The request belongs to another File page or library table.",
        )
      const request = sourceField(raw, requestId),
        result = sourceField(raw, resultId),
        receipt = sourceField(raw, receiptId)
      if (
        request.type !== "select" ||
        result.type !== "rich_text" ||
        receipt.type !== "rich_text" ||
        !Array.isArray(result.rich_text) ||
        !Array.isArray(receipt.rich_text) ||
        result.has_more === true ||
        receipt.has_more === true ||
        result.rich_text.length >= 25 ||
        receipt.rich_text.length >= 25
      )
        throw fail(
          "SHARED_FILE_REQUEST_INVALID",
          "The registered request/result properties are incomplete or have changed types.",
        )
      const intent = request.select === null ? "none" : property(request.select).name
      if (intent !== "none" && intent !== "restore-follow")
        throw fail(
          "SHARED_FILE_REQUEST_INVALID",
          "Only the declared restore-follow request is executable; Status is not a request.",
        )
      const value = text(receipt.rich_text)
      const feedback =
        value === ""
          ? undefined
          : Schema.decodeUnknownSync(FeedbackSchema)(JSON.parse(value), {
              onExcessProperty: "error",
            })
      return {
        intent: intent === "restore-follow" ? ("restore-follow" as const) : ("none" as const),
        feedback,
        summary: text(result.rich_text),
      }
    })
    const body = yield* observeSharedBody(file.binding.page_id)
    const context: RequestContext = {
      library_id: input.library.library_id,
      skill_page_id: input.skillPageId,
      skill_id: file.index.skill_id,
      file_id: file.binding.file_id,
      page_id: file.binding.page_id,
      path: file.binding.path,
      intent: native.intent,
      source: file.sourceContext,
      heads: file.state?.heads ?? [],
      body: body.fingerprint,
      bytes: body.bytes,
    }
    const submitted = native.feedback?.submitted
    if (
      submitted !== undefined &&
      native.feedback?.request_id !==
        "file-request-" + (yield* sha256(canonicalSharedJson(submitted)))
    )
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_REQUEST_INVALID",
          "The submitted request identity differs from its receipt.",
        ),
      )
    return {
      context,
      request_id:
        submitted === undefined
          ? "file-request-" + (yield* sha256(canonicalSharedJson(context)))
          : native.feedback!.request_id,
      feedback: native.feedback,
      intentId: requestId,
      resultId,
      receiptId,
      summary: native.summary,
      file,
      observedBody: body,
    }
  }).pipe(withReadOnlyNotion)
}
type RequestObservation = Effect.Success<ReturnType<typeof observeRequest>>
const sameContext = (a: RequestContext, b: RequestContext) =>
  canonicalSharedJson(a) === canonicalSharedJson(b)

/** A verified selection may advance within the same Source definition and member. */
function matchesSubmission(submitted: RequestContext, current: RequestContext) {
  return sameContext(
    submitted.source.definition === null
      ? submitted
      : {
          ...submitted,
          source: { ...submitted.source, selected_version: current.source.selected_version },
        },
    current,
  )
}

function verifiedFeedback(input: RequestInput, observed: RequestObservation) {
  return Effect.gen(function* () {
    const result = observed.feedback
    if (
      result?.status !== "verified_applied" ||
      result.after === undefined ||
      !sameContext(result.after, observed.context) ||
      observed.file.state?.ownership.kind !== "following" ||
      isResourceFollowing(observed.file.state.ownership) ||
      observed.file.state.ownership.projection?.sha256 !== observed.context.body.sha256
    )
      return false
    if (result.original_operation_id !== null) {
      const original = yield* reconcileSelectedSharedFileRestore({
        ...input,
        operationId: result.original_operation_id,
      })
      if (
        original.status !== "applied" ||
        original.selected_version !== observed.context.source.selected_version ||
        original.source?.revision !== observed.file.state.ownership.source_revision
      )
        return false
    } else {
      const preview = yield* restoreSelectedSharedFile({ ...input, dryRun: true })
      if (
        preview.before_sha256 !== preview.candidate_sha256 ||
        preview.source_revision !== observed.file.state.ownership.source_revision
      )
        return false
    }
    return true
  }).pipe(withReadOnlyNotion)
}

/** This reads the current request; a select value is not a unique request revision or a lock. */
export function readSharedFileRequest(input: RequestInput) {
  return Effect.gen(function* () {
    const observed = yield* observeRequest(input)
    const current = observed.feedback
    const complete =
      observed.context.intent === "restore-follow" && (yield* verifiedFeedback(input, observed))
    const matching =
      current !== undefined &&
      (current.submitted === undefined
        ? sameContext(current.before, observed.context)
        : matchesSubmission(current.submitted, observed.context))
    return {
      status:
        observed.context.intent === "none"
          ? ("no_request" as const)
          : complete
            ? ("verified_applied" as const)
            : current?.status === "unknown" && current.original_operation_id !== null
              ? ("unknown" as const)
              : current?.submitted !== undefined && !matching
                ? ("needs_review" as const)
                : matching && current.status !== "verified_applied"
                  ? current.status
                  : ("pending" as const),
      request_id: observed.request_id,
      request: observed.context,
      ownership: observed.file.state?.ownership ?? { kind: "unobserved" as const },
      feedback: current ?? null,
      remote_writes: 0 as const,
      request_is_authority: false as const,
    }
  }).pipe(withReadOnlyNotion)
}

function writeFeedback(
  input: RequestInput,
  result: Feedback,
  expected: RequestContext,
  submit = false,
) {
  return Effect.gen(function* () {
    const before = yield* observeRequest(input)
    if (!sameContext(before.context, expected))
      return {
        status: "needs_review" as const,
        code: "SHARED_FILE_REQUEST_CHANGED",
        body_writes: 0 as const,
        message:
          "The current intent or complete file context changed; the earlier feedback was not published.",
      }
    const serialized = canonicalSharedJson(result)
    const after = submit ? { ...expected, intent: "restore-follow" as const } : expected
    const summary = `${result.status}: ${result.message}\n${result.code}${result.original_operation_id === null ? "" : `\nOriginal operation: ${result.original_operation_id}`}`
    const mutation = yield* guardedSourceMutation(
      input.library,
      {
        identity: `file-request-${submit ? "submit" : "result"}:${before.context.file_id}`,
        path: `v1/pages/${before.context.page_id}`,
        method: "PATCH",
        body: {
          properties: {
            ...(submit ? { [before.intentId]: { select: { name: "restore-follow" } } } : {}),
            [before.resultId]: { rich_text: sourceRich(summary) },
            [before.receiptId]: { rich_text: sourceRich(serialized) },
          },
        },
      },
      Effect.gen(function* () {
        const observed = yield* observeRequest(input)
        return sameContext(observed.context, after) &&
          observed.summary === summary &&
          canonicalSharedJson(observed.feedback ?? null) === serialized
          ? observed.context
          : undefined
      }),
    )
    return {
      status:
        "original_outcome" in mutation && mutation.original_outcome === "unknown"
          ? ("unknown" as const)
          : result.status,
      feedback: result,
      feedback_operation_id: mutation.operation_id,
      body_writes: 0 as const,
    }
  })
}

function feedback(
  observed: RequestObservation,
  status: Feedback["status"],
  code: string,
  message: string,
  source: unknown,
  operation: string | null,
  after?: RequestContext,
): Feedback {
  return {
    version: 1,
    kind: "file_request_result",
    request_id: observed.request_id,
    before: observed.context,
    status,
    code,
    message,
    source,
    original_operation_id: operation,
    ...(observed.feedback?.submitted === undefined
      ? {}
      : { submitted: observed.feedback.submitted }),
    ...(after === undefined ? {} : { after }),
  }
}
function verifyRequest(
  input: RequestInput,
  frozen: RequestObservation,
  body?: { readonly sha256: string; readonly bytes: number },
) {
  return Effect.gen(function* () {
    const current = yield* observeRequest(input)
    const expected =
      body === undefined
        ? frozen.context
        : {
            ...frozen.context,
            body: { ...frozen.context.body, sha256: body.sha256 },
            bytes: body.bytes,
          }
    if (
      !sameContext(current.context, expected) ||
      current.request_id !== frozen.request_id ||
      canonicalSharedJson(current.feedback?.submitted ?? null) !==
        canonicalSharedJson(frozen.feedback?.submitted ?? null) ||
      current.context.intent !== "restore-follow"
    )
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_REQUEST_CHANGED",
          "The request was canceled, edited, moved or rebound after preparation; preserve the original custom content.",
        ),
      )
  }).pipe(withReadOnlyNotion)
}

/** Explicitly freeze authorization before any later Source update or body edit. */
export function submitSharedFileRequest(input: RequestInput & { readonly dryRun?: boolean }) {
  return Effect.gen(function* () {
    const observed = yield* observeRequest(input)
    if (observed.feedback?.status === "unknown" && observed.feedback.original_operation_id !== null)
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_REQUEST_PENDING",
          "Reconcile the original restore before submitting new intent.",
        ),
      )
    yield* assertSharedFileIntentReady(input.library, observed.file)
    const submitted: RequestContext = { ...observed.context, intent: "restore-follow" }
    const requestId = "file-request-" + (yield* sha256(canonicalSharedJson(submitted)))
    if (
      observed.context.intent === "restore-follow" &&
      observed.feedback?.submitted !== undefined &&
      sameContext(observed.feedback.submitted, submitted)
    )
      return {
        status: observed.feedback.status,
        unchanged: true as const,
        request_id: observed.feedback.request_id,
        feedback: observed.feedback,
        remote_writes: 0 as const,
      }
    const result: Feedback = {
      ...feedback(
        observed,
        "submitted",
        "REQUEST_SUBMITTED",
        "This explicit request freezes the complete body and frontier. Later edits require a new submission.",
        submitted.source,
        null,
      ),
      request_id: requestId,
      before: submitted,
      submitted,
    }
    if (input.dryRun)
      return {
        status: "planned" as const,
        dry_run: true as const,
        request_id: requestId,
        feedback: result,
        original_body: observed.observedBody,
        remote_writes: 0 as const,
      }
    return yield* writeFeedback(input, result, observed.context, true)
  })
}

/** One invocation: freeze, protect, execute the existing restore, and independently read back feedback. */
export function processSharedFileRequest(
  input: RequestInput & {
    readonly dryRun?: boolean
    readonly allowLocalArchive?: boolean
    readonly reconcile?: boolean
  },
) {
  return Effect.gen(function* () {
    const frozen = yield* observeRequest(input)
    if (frozen.context.intent === "none")
      return { status: "no_request" as const, remote_writes: 0 as const }
    if (yield* verifiedFeedback(input, frozen))
      return {
        status: "verified_applied" as const,
        unchanged: true as const,
        remote_writes: 0 as const,
        feedback: frozen.feedback,
      }
    const previous = frozen.feedback
    if (input.reconcile) {
      if (!previous?.original_operation_id)
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_REQUEST_NO_ORIGINAL",
            "This request has no original restore operation to reconcile.",
          ),
        )
      const result = yield* reconcileSelectedSharedFileRestore({
        ...input,
        operationId: previous.original_operation_id,
      })
      const after = yield* observeRequest(input)
      if (result.status !== "applied")
        return {
          status: "blocked" as const,
          original: result,
          remote_writes: 0 as const,
          message:
            "The original restore is verified as not applied or separately reviewed. Read the current request before preparing new intent.",
        }
      if (
        after.context.intent !== "restore-follow" ||
        after.file.state?.ownership.kind !== "following" ||
        isResourceFollowing(after.file.state.ownership) ||
        after.file.state.ownership.projection.sha256 !== after.context.body.sha256 ||
        after.context.source.selected_version !== result.selected_version ||
        after.file.state.ownership.source_revision !== result.source?.revision
      )
        return {
          status: "needs_review" as const,
          original: result,
          remote_writes: 0 as const,
          message:
            "The original operation is verified, but the current request, body, selection or ownership differs.",
        }
      const completed: Feedback = {
        ...previous,
        status: "verified_applied",
        code: "ORIGINAL_VERIFIED",
        message: "The exact original restore facts were verified without repeating a body write.",
        after: after.context,
      }
      if (input.dryRun)
        return {
          status: "planned" as const,
          dry_run: true as const,
          feedback: completed,
          remote_writes: 0 as const,
        }
      return yield* writeFeedback(input, completed, after.context)
    }
    if (previous?.status === "unknown" && previous.original_operation_id !== null)
      return {
        status: "unknown" as const,
        feedback: previous,
        remote_writes: 0 as const,
        message:
          "Reconcile the exact original restore; processing cannot replace an unknown operation.",
      }
    if (
      previous?.submitted === undefined ||
      !matchesSubmission(previous.submitted, frozen.context)
    ) {
      const missing = previous?.submitted === undefined
      const result = feedback(
        frozen,
        "blocked",
        missing ? "SHARED_FILE_REQUEST_NOT_SUBMITTED" : "SHARED_FILE_REQUEST_CHANGED",
        missing
          ? "Management Request is intent only. Submit the complete current file with file request --submit before processing."
          : "The submitted body, frontier, identity or Source definition changed. Preserve the later edit and submit new intent explicitly.",
        frozen.context.source,
        null,
      )
      if (input.dryRun)
        return {
          status: "blocked" as const,
          dry_run: true as const,
          feedback: result,
          remote_writes: 0 as const,
        }
      return yield* writeFeedback(input, result, frozen.context)
    }
    const preparation = yield* Effect.gen(function* () {
      yield* assertSharedFileIntentReady(input.library, frozen.file)
      const plan = yield* restoreSelectedSharedFile({ ...input, dryRun: true }).pipe(
        withReadOnlyNotion,
      )
      yield* verifyRequest(input, frozen)
      return plan
    }).pipe(Effect.result)
    if (preparation._tag === "Failure") {
      const error = preparation.failure
      const blocked = feedback(frozen, "blocked", error.code, error.message, null, null)
      if (input.dryRun)
        return {
          status: "blocked" as const,
          dry_run: true as const,
          feedback: blocked,
          remote_writes: 0 as const,
        }
      return yield* writeFeedback(input, blocked, frozen.context)
    }
    const plan = preparation.success
    const source = {
      source_id: plan.source_id,
      revision: plan.source_revision,
      path: plan.source_path,
      sha256: plan.source_sha256,
      selected_version: frozen.context.source.selected_version,
    }
    if (input.dryRun)
      return {
        status: "planned" as const,
        dry_run: true as const,
        request_id: frozen.request_id,
        request: frozen.context,
        original_body: frozen.observedBody,
        restore_preview: plan,
        body_writes: 0 as const,
        remote_writes: 0 as const,
      }
    const progress = yield* writeFeedback(
      input,
      feedback(
        frozen,
        "processing",
        "SUBMITTED_REQUEST_REVALIDATION",
        "Revalidating the submitted body and fixed source before the explicit restore.",
        source,
        null,
      ),
      frozen.context,
    )
    if (progress.status !== "processing") return progress
    const restored = yield* restoreSelectedSharedFile({
      ...input,
      dryRun: false,
      beforeRestoreDispatch: verifyRequest(input, frozen),
      afterRestoreBodyWrite: (sha256, bytes) => verifyRequest(input, frozen, { sha256, bytes }),
    }).pipe(Effect.result)
    if (restored._tag === "Failure") {
      const error = restored.failure,
        details = property(error.details)
      const operation =
        typeof details.body_write_operation_id === "string" ? details.body_write_operation_id : null
      const unknown = /UNKNOWN|UNRESOLVED|PENDING|REVIEW_REQUIRED/u.test(error.code)
      const result = feedback(
        frozen,
        unknown ? "unknown" : "blocked",
        error.code,
        error.message,
        source,
        operation,
      )
      const current = yield* observeRequest(input)
      return yield* writeFeedback(input, result, current.context)
    }
    const after = yield* observeRequest(input),
      result = restored.success
    if (
      after.context.intent !== "restore-follow" ||
      after.file.state?.ownership.kind !== "following" ||
      after.file.state.ownership.source_revision !== result.source_revision ||
      after.context.body.sha256 !== result.candidate_sha256
    )
      return {
        status: "needs_review" as const,
        original_operation_id: result.operation_id,
        message:
          "The restore completed, but the current request or body changed before feedback; no request was cleared.",
      }
    return yield* writeFeedback(
      input,
      feedback(
        frozen,
        "verified_applied",
        "RESTORE_VERIFIED",
        "The complete selected body and following ownership were read back. The user-owned request remains available for explicit cancellation.",
        source,
        result.unchanged ? null : result.operation_id,
        after.context,
      ),
      after.context,
    )
  })
}
