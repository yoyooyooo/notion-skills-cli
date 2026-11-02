import { Effect, Schema } from "effect"
import { fail, property } from "./model.ts"
import { pageId } from "./ref.ts"
import {
  SharedCreateRecoveryBindingSchema,
  SharedCreateRecoveryObservationSchema,
  validateSharedCreateRecoveryReview,
  type SharedCreateRecoveryBinding,
  type SharedCreateRecoveryObservation,
  type SharedCreateRecoveryReview,
} from "./shared-create-recovery-model.ts"
import { normalizeObservedBody } from "./shared-file-state.ts"
import { SharedLibrarySchema } from "./shared-library-model.ts"
import { canonicalSharedJson, validateSharedRecordEnvelope } from "./shared-records.ts"
import { sha256 } from "./store.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const OriginalId = Schema.String.check(Schema.isPattern(/^skill-create-[a-f0-9]{64}$/u))
const RecoveryId = Schema.String.check(Schema.isPattern(/^create-recovery-[a-f0-9]{64}$/u))
const ContinuationId = Schema.String.check(Schema.isPattern(/^create-continuation-[a-f0-9]{64}$/u))
const AttemptId = Schema.String.check(
  Schema.isPattern(/^create-(?:recovery|continuation)-[a-f0-9]{64}$/u),
)
const invalid = (message: string) => fail("SHARED_CREATE_CONTINUATION_INVALID", message)
const checked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (cause) =>
      invalid(cause instanceof Error ? cause.message : "Invalid continuation input."),
  })
const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const bytes = (text: string) => new TextEncoder().encode(text).length

export const sharedCreateRecoveryTerminalsEntity = "skill-create-recovery-terminals-v1"
export const sharedCreateRecoveryTerminalId = (attemptId: string) => `terminal-${attemptId}`
export const sharedCreateContinuationReviewEntity = "skill-create-continuation-reviews-v1"
export const sharedCreateContinuationReviewId = (originalOperationId: string) =>
  `continuation-${originalOperationId}`

export const SharedCreateRecoveryTerminalSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("skill_create_recovery_terminal"),
  outcome: Schema.Literal("write_outcome_unknown"),
  execution_policy: Schema.Literal("serial_create_stop_on_error_v1"),
  evidence_kind: Schema.Literal("native_dispatch_stopped"),
  original_operation_id: OriginalId,
  recovery_id: RecoveryId,
  attempt_id: AttemptId,
  review_record_hash: Hash,
  skill_page_id: Schema.String,
  failed_file_id: Identity,
  bindings: Schema.Array(SharedCreateRecoveryBindingSchema),
  unattempted_file_ids: Schema.Array(Identity),
  error_json: Schema.String,
  error_sha256: Hash,
})
export type SharedCreateRecoveryTerminal = typeof SharedCreateRecoveryTerminalSchema.Type

export const SharedCreateContinuationResponseRecordSchema = Schema.Struct({
  file_id: Identity,
  page_id: Schema.String,
  record_id: Schema.String.check(Schema.isPattern(/^create-recovery-receipt-[a-f0-9]{64}$/u)),
  hash: Hash,
})
export type SharedCreateContinuationResponseRecord =
  typeof SharedCreateContinuationResponseRecordSchema.Type

export const SharedCreateContinuationReviewSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("skill_create_continuation_review"),
  continuation_id: ContinuationId,
  original_operation_id: OriginalId,
  recovery_id: RecoveryId,
  recovery_review_record_hash: Hash,
  terminal_record_hash: Hash,
  library: SharedLibrarySchema,
  library_id: Identity,
  skill_id: Identity,
  skill_page_id: Schema.String,
  decision: Schema.Literal("accept_current_allocation"),
  original_write_outcome: Schema.Literal("unknown"),
  observation_kind: Schema.Literal("post_failure_current_read"),
  bindings: Schema.Array(SharedCreateRecoveryBindingSchema),
  observations: Schema.Array(SharedCreateRecoveryObservationSchema),
  remaining_file_ids: Schema.Array(Identity),
  successful_response_records: Schema.Array(SharedCreateContinuationResponseRecordSchema),
})
export type SharedCreateContinuationReview = typeof SharedCreateContinuationReviewSchema.Type

function recordHash(operationId: string, payload: unknown) {
  return sha256(canonicalSharedJson({ version: 1, operation_id: operationId, payload }))
}

function continuationId(fields: Omit<SharedCreateContinuationReview, "continuation_id">) {
  return sha256(canonicalSharedJson(fields)).pipe(
    Effect.map((hash) => `create-continuation-${hash}`),
  )
}

/** Error properties such as message, stack and cause may be non-enumerable. */
function capturedErrorValue(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint")
      throw invalid("The dispatch error contains a value that cannot be retained as JSON.")
    return value
  }
  if (ancestors.has(value)) throw invalid("A cyclic dispatch error cannot be retained completely.")
  ancestors.add(value)
  try {
    if (Array.isArray(value))
      return value.map((entry: unknown) => capturedErrorValue(entry, ancestors))
    if (value instanceof Error) {
      const fields: Record<string, unknown> = { name: value.name, message: value.message }
      for (const key of Object.getOwnPropertyNames(value)) {
        const field: unknown = Reflect.get(value, key)
        fields[key] = capturedErrorValue(field, ancestors)
      }
      return fields
    }
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      throw invalid("The dispatch error contains an unsupported non-JSON object.")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]: [string, unknown]) => [
        key,
        capturedErrorValue(entry, ancestors),
      ]),
    )
  } finally {
    ancestors.delete(value)
  }
}

function errorJson(error: unknown) {
  return checked(() => {
    const captured = capturedErrorValue(error)
    if (property(captured).code !== "WRITE_OUTCOME_UNKNOWN")
      throw invalid("Only an actual unknown page-create outcome can produce a recovery terminal.")
    const json = canonicalSharedJson(captured)
    if (property(JSON.parse(json)).code !== "WRITE_OUTCOME_UNKNOWN")
      throw invalid("The retained dispatch error lost its original unknown-outcome code.")
    return json
  })
}

function originalBindingsWithRecoveryEvents(review: SharedCreateRecoveryReview) {
  return review.bindings.map((binding) => {
    const file = review.files.find((entry) => entry.file_id === binding.file_id)
    if (!file) throw invalid("The original binding has no recovery file.")
    return { ...binding, event_id: file.event.event_id }
  })
}

function remainingCreationFiles(review: SharedCreateRecoveryReview) {
  const originalIds = new Set(review.bindings.map((binding) => binding.file_id))
  return review.files.filter((file) => !originalIds.has(file.file_id))
}

function validateBindings(
  bindings: readonly SharedCreateRecoveryBinding[],
  review: SharedCreateRecoveryReview,
) {
  if (
    bindings.length === 0 ||
    bindings.length > review.files.length ||
    new Set(bindings.map((binding) => binding.file_id)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.path)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.page_id)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.event_id)).size !== bindings.length ||
    bindings[0]?.page_id !== review.skill_page_id
  )
    throw invalid(
      "Continuation requires unique file, path, page and event bindings with the retained main page.",
    )
  for (const binding of bindings) {
    const file = review.files.find((entry) => entry.file_id === binding.file_id)
    if (
      !file ||
      file.path !== binding.path ||
      file.event.event_id !== binding.event_id ||
      pageId(binding.page_id) !== binding.page_id
    )
      throw invalid(
        "A continuation binding changed its exact recovery file, event or canonical page identity.",
      )
  }
}

export function validateSharedCreateRecoveryTerminal(
  input: unknown,
  reviewInput: SharedCreateRecoveryReview,
  reviewRecordHash: string,
  requireOriginalAttempt = true,
) {
  return Effect.gen(function* () {
    const review = yield* validateSharedCreateRecoveryReview(reviewInput)
    const terminal = yield* checked(() =>
      Schema.decodeUnknownSync(SharedCreateRecoveryTerminalSchema)(input, {
        onExcessProperty: "error",
      }),
    )
    if ((yield* recordHash(review.review_id, review)) !== reviewRecordHash)
      return yield* Effect.fail(
        invalid("The recovery review record hash does not match its immutable envelope."),
      )
    yield* checked(() => {
      if (
        terminal.original_operation_id !== review.original_operation_id ||
        terminal.recovery_id !== review.review_id ||
        terminal.review_record_hash !== reviewRecordHash ||
        terminal.skill_page_id !== review.skill_page_id ||
        (requireOriginalAttempt && terminal.attempt_id !== review.review_id) ||
        (terminal.attempt_id.startsWith("create-recovery-") &&
          terminal.attempt_id !== review.review_id)
      )
        throw invalid("The terminal does not belong to the selected recovery execution and review.")
      const error = property(JSON.parse(terminal.error_json))
      if (
        canonicalSharedJson(error) !== terminal.error_json ||
        error.code !== "WRITE_OUTCOME_UNKNOWN"
      )
        throw invalid("A terminal must retain the complete canonical unknown-outcome error.")
      validateBindings(terminal.bindings, review)
      const original = originalBindingsWithRecoveryEvents(review)
      if (
        terminal.bindings.length < original.length ||
        !same(terminal.bindings.slice(0, original.length), original)
      )
        throw invalid(
          "A terminal cannot replace any original page or change its recovery event binding.",
        )
      const remaining = remainingCreationFiles(review)
      const successfulCount = terminal.bindings.length - original.length
      if (successfulCount >= remaining.length)
        throw invalid("The terminal has no next unbound file creation that could have failed.")
      for (const [index, binding] of terminal.bindings.slice(original.length).entries()) {
        const file = remaining[index]
        if (!file || file.file_id !== binding.file_id || file.path !== binding.path)
          throw invalid("The terminal bindings are not the serial successful creation prefix.")
      }
      if (
        remaining[successfulCount]?.file_id !== terminal.failed_file_id ||
        !same(
          terminal.unattempted_file_ids,
          remaining.slice(successfulCount + 1).map((file) => file.file_id),
        )
      )
        throw invalid(
          "The unknown file and unattempted files do not match the stopped serial dispatch order.",
        )
      validateSharedRecordEnvelope(terminal.attempt_id, terminal)
    })
    if ((yield* sha256(terminal.error_json)) !== terminal.error_sha256)
      return yield* Effect.fail(
        invalid("The terminal dispatch error failed its retained checksum."),
      )
    return terminal
  })
}

/** Call only from the actual page POST failure handler, after serial dispatch stops.
 * Current GETs, user reports and reconstructed historical errors are not inputs to
 * a public terminal-creation command. A continuation may record its own terminal,
 * but that terminal cannot authorize a second continuation. */
export function makeSharedCreateRecoveryTerminal(input: {
  readonly review: SharedCreateRecoveryReview
  readonly reviewRecordHash: string
  readonly attemptId: string
  readonly failedFileId: string
  readonly bindings: readonly SharedCreateRecoveryBinding[]
  readonly error: unknown
}) {
  return Effect.gen(function* () {
    const review = yield* validateSharedCreateRecoveryReview(input.review)
    const json = yield* errorJson(input.error)
    const bound = new Set(input.bindings.map((binding) => binding.file_id))
    const terminal = {
      version: 1 as const,
      kind: "skill_create_recovery_terminal" as const,
      outcome: "write_outcome_unknown" as const,
      execution_policy: "serial_create_stop_on_error_v1" as const,
      evidence_kind: "native_dispatch_stopped" as const,
      original_operation_id: review.original_operation_id,
      recovery_id: review.review_id,
      attempt_id: input.attemptId,
      review_record_hash: input.reviewRecordHash,
      skill_page_id: review.skill_page_id,
      failed_file_id: input.failedFileId,
      bindings: input.bindings,
      unattempted_file_ids: review.files
        .filter((file) => !bound.has(file.file_id) && file.file_id !== input.failedFileId)
        .map((file) => file.file_id),
      error_json: json,
      error_sha256: yield* sha256(json),
    }
    return yield* validateSharedCreateRecoveryTerminal(
      terminal,
      review,
      input.reviewRecordHash,
      false,
    )
  })
}

function observedBody(observation: SharedCreateRecoveryObservation) {
  return checked(() => {
    const parsed: unknown = JSON.parse(observation.response_json)
    const response = property(parsed)
    if (
      !same(parsed, response) ||
      canonicalSharedJson(response) !== observation.response_json ||
      (response.object !== undefined && response.object !== "page_markdown") ||
      response.id !== observation.page_id ||
      typeof response.markdown !== "string" ||
      response.truncated !== false ||
      !Array.isArray(response.unknown_block_ids) ||
      response.unknown_block_ids.length !== 0 ||
      (response.warnings !== undefined &&
        (!Array.isArray(response.warnings) || response.warnings.length !== 0)) ||
      (response.has_more !== undefined && response.has_more !== false) ||
      (response.next_cursor !== undefined && response.next_cursor !== null)
    )
      throw invalid(
        "A continuation observation must retain the canonical complete current Markdown response for its exact page.",
      )
    return normalizeObservedBody(response.markdown)
  })
}

export function validateSharedCreateContinuationReview(
  input: unknown,
  reviewInput: SharedCreateRecoveryReview,
  reviewRecordHash: string,
  terminalInput: SharedCreateRecoveryTerminal,
  terminalRecordHash: string,
  expectedId?: string,
) {
  return Effect.gen(function* () {
    const review = yield* validateSharedCreateRecoveryReview(reviewInput)
    const terminal = yield* validateSharedCreateRecoveryTerminal(
      terminalInput,
      review,
      reviewRecordHash,
      true,
    )
    if ((yield* recordHash(terminal.attempt_id, terminal)) !== terminalRecordHash)
      return yield* Effect.fail(
        invalid("The native terminal record hash does not match its immutable envelope."),
      )
    const continuation = yield* checked(() =>
      Schema.decodeUnknownSync(SharedCreateContinuationReviewSchema)(input, {
        onExcessProperty: "error",
      }),
    )
    yield* checked(() => {
      if (
        continuation.original_operation_id !== review.original_operation_id ||
        continuation.recovery_id !== review.review_id ||
        continuation.recovery_review_record_hash !== reviewRecordHash ||
        continuation.terminal_record_hash !== terminalRecordHash ||
        !same(continuation.library, review.library) ||
        continuation.library_id !== review.library_id ||
        continuation.library.library_id !== continuation.library_id ||
        continuation.skill_id !== review.skill_id ||
        continuation.skill_page_id !== review.skill_page_id
      )
        throw invalid(
          "The continuation must bind the exact original recovery, terminal, library and skill.",
        )
      validateBindings(continuation.bindings, review)
      const accepted = continuation.bindings[terminal.bindings.length]
      if (
        continuation.bindings.length !== terminal.bindings.length + 1 ||
        !same(continuation.bindings.slice(0, terminal.bindings.length), terminal.bindings) ||
        accepted?.file_id !== terminal.failed_file_id ||
        !same(continuation.remaining_file_ids, terminal.unattempted_file_ids)
      )
        throw invalid(
          "Only the failed file's current page may be appended to the retained successful prefix.",
        )
      if (
        continuation.observations.length !== continuation.bindings.length ||
        new Set(continuation.observations.map((observation) => observation.file_id)).size !==
          continuation.observations.length ||
        new Set(continuation.observations.map((observation) => observation.page_id)).size !==
          continuation.observations.length
      )
        throw invalid(
          "Every accepted page must have exactly one independent current-body observation.",
        )
      for (const observation of continuation.observations) {
        const binding = continuation.bindings.find((entry) => entry.file_id === observation.file_id)
        const file = review.files.find((entry) => entry.file_id === observation.file_id)
        if (
          !binding ||
          !file ||
          observation.page_id !== binding.page_id ||
          observation.body_sha256 !== file.content.sha256 ||
          observation.body_bytes !== file.content.bytes
        )
          throw invalid(
            "A current observation does not match its accepted page and unchanged v5 recovery content.",
          )
      }
      const originalIds = new Set(review.bindings.map((binding) => binding.file_id))
      const successful = terminal.bindings.filter((binding) => !originalIds.has(binding.file_id))
      const receipts = continuation.successful_response_records
      if (
        receipts.length !== successful.length ||
        new Set(receipts.map((receipt) => receipt.file_id)).size !== receipts.length ||
        new Set(receipts.map((receipt) => receipt.page_id)).size !== receipts.length ||
        new Set(receipts.map((receipt) => receipt.record_id)).size !== receipts.length
      )
        throw invalid(
          "Only successful non-original creations require one original response record each.",
        )
      for (const receipt of receipts) {
        const binding = successful.find((entry) => entry.file_id === receipt.file_id)
        if (!binding || receipt.page_id !== binding.page_id)
          throw invalid(
            "A successful response record cannot stand in for the unknown write or an original page.",
          )
      }
    })
    for (const observation of continuation.observations) {
      const body = yield* observedBody(observation)
      if (
        (yield* sha256(observation.response_json)) !== observation.response_sha256 ||
        (yield* sha256(body)) !== observation.body_sha256 ||
        bytes(body) !== observation.body_bytes
      )
        return yield* Effect.fail(
          invalid("A continuation response or normalized body failed its exact checksum."),
        )
    }
    for (const receipt of continuation.successful_response_records) {
      const digest = yield* sha256(
        canonicalSharedJson([review.review_id, `create:${receipt.file_id}`]),
      )
      if (receipt.record_id !== `create-recovery-receipt-${digest}`)
        return yield* Effect.fail(
          invalid("A successful response uses another dispatch receipt identity."),
        )
    }
    const { continuation_id: actual, ...fields } = continuation
    if (
      actual !== (yield* continuationId(fields)) ||
      (expectedId !== undefined && expectedId !== actual)
    )
      return yield* Effect.fail(
        invalid(
          "The continuation differs from its complete immutable contents or selected digest.",
        ),
      )
    yield* checked(() => validateSharedRecordEnvelope(continuation.continuation_id, continuation))
    return continuation
  })
}

export function makeSharedCreateContinuationReview(input: {
  readonly review: SharedCreateRecoveryReview
  readonly reviewRecordHash: string
  readonly terminal: SharedCreateRecoveryTerminal
  readonly terminalRecordHash: string
  readonly bindings: readonly SharedCreateRecoveryBinding[]
  readonly observations: readonly SharedCreateRecoveryObservation[]
  readonly successfulResponseRecords: readonly SharedCreateContinuationResponseRecord[]
}) {
  return Effect.gen(function* () {
    const review = yield* validateSharedCreateRecoveryReview(input.review)
    const terminal = yield* validateSharedCreateRecoveryTerminal(
      input.terminal,
      review,
      input.reviewRecordHash,
      true,
    )
    const fields = {
      version: 1 as const,
      kind: "skill_create_continuation_review" as const,
      original_operation_id: review.original_operation_id,
      recovery_id: review.review_id,
      recovery_review_record_hash: input.reviewRecordHash,
      terminal_record_hash: input.terminalRecordHash,
      library: review.library,
      library_id: review.library_id,
      skill_id: review.skill_id,
      skill_page_id: review.skill_page_id,
      decision: "accept_current_allocation" as const,
      original_write_outcome: "unknown" as const,
      observation_kind: "post_failure_current_read" as const,
      bindings: input.bindings,
      observations: input.observations,
      remaining_file_ids: terminal.unattempted_file_ids,
      successful_response_records: input.successfulResponseRecords,
    }
    return yield* validateSharedCreateContinuationReview(
      { ...fields, continuation_id: yield* continuationId(fields) },
      review,
      input.reviewRecordHash,
      terminal,
      input.terminalRecordHash,
    )
  })
}
