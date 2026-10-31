import { Effect, Schema } from "effect"
import { decode, fail, SkillsError } from "./model.ts"
import type { SharedLibrary } from "./shared-library.ts"
import {
  decideObservedBody,
  FileEventSchema,
  normalizeObservedBody,
  resolveFileState,
  RetainedContentSchema,
  type BodyFingerprint,
  type FileEvent,
  type ResolvedFileState,
  type RetainedContent,
} from "./shared-file-state.ts"
import { observeSharedBody } from "./shared-page-body.ts"
import {
  commitSharedObservationPlan,
  makeSharedObservationPlan,
  reconcileSharedObservation,
  validateSharedObservationPlan,
  type SharedObservationPlan,
} from "./shared-observation-operation.ts"
import { canonicalSharedJson, querySharedRecords } from "./shared-records.ts"
import { sha256 } from "./store.ts"
import { bodyWriteOutcomesEntity } from "./shared-body-write-model.ts"
import {
  loadPendingSharedBodyWrites,
  reconcileSharedBodyWrite,
  type SharedBodyWritePlan,
} from "./shared-body-write.ts"
import { querySharedOperationIndex } from "./shared-operation-index.ts"

type EffectValue<T> = T extends Effect.Effect<infer A, infer _E, infer _R> ? A : never
type ObservedBody = EffectValue<ReturnType<typeof observeSharedBody>>

export type SharedFileObservation =
  | { readonly body: ObservedBody; readonly state: ResolvedFileState; readonly changed: false }
  | {
      readonly body: ObservedBody
      readonly state: ResolvedFileState
      readonly changed: true
      readonly event: FileEvent
      readonly operation: SharedObservationPlan
    }

export type ObserveSharedFileInput<R = never> = {
  readonly library: SharedLibrary
  readonly skillPageId: string
  readonly fileId: string
  readonly pageId: string
  readonly events: readonly FileEvent[]
  readonly initialNative?: boolean
  /** Batch-discovered unresolved plans plus local recovery receipts, never current-body substitutes. */
  readonly plans?: readonly SharedObservationPlan[]
  /** Batch-checked body writes. Omission performs standalone shared discovery. */
  readonly bodyWrites?: readonly SharedBodyWritePlan[]
  /** Authoring dry runs may validate existing state but cannot adopt a new body. */
  readonly readOnly?: boolean
  /** Save a derived local dispatch receipt before any remote write; shared facts alone decide completion. */
  readonly beforePlanWrite?: (plan: SharedObservationPlan) => Effect.Effect<void, SkillsError, R>
}

const RetainedMarkdownSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("normalized_markdown"),
  normalization_version: Schema.Literal(1),
  markdown: Schema.String,
})

function checked<A>(action: () => A): Effect.Effect<A, SkillsError> {
  return Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_STATE_INVALID", "Shared file observation could not be validated."),
  })
}

/**
 * A pending original plan is reconciled before any current-body read. Otherwise
 * freeze the observation, then append its plan, retained object and adoption
 * event. Recovery never supplies a current snapshot: the caller must read again
 * after SHARED_OBSERVATION_RECONCILED so old bytes cannot inherit a new mtime.
 */
export function observeSharedFile<R = never>(input: ObserveSharedFileInput<R>) {
  return Effect.gen(function* () {
    // Baseline/graph validation is pure. A supplied original plan is reconciled
    // independently; otherwise invalid state requires no discovery or body I/O.
    const suppliedRecovery =
      input.plans?.some((plan) => plan.file_id === input.fileId) ||
      input.bodyWrites?.some((plan) => plan.file_id === input.fileId)
    const previous = suppliedRecovery
      ? undefined
      : yield* checked(() => {
          if (input.events.length > 0) return resolveFileState(input.fileId, input.events)
          if (input.initialNative !== true)
            throw fail(
              "BASELINE_MISSING",
              "No shared file baseline exists; preserve the current body.",
              { file_id: input.fileId, page_id: input.pageId },
            )
          return undefined
        })
    const bodyWrites =
      input.bodyWrites ??
      (yield* loadPendingSharedBodyWrites(input.library, {
        skillPageId: input.skillPageId,
        events: input.events,
        headers: (yield* querySharedOperationIndex(input.library, input.skillPageId)).filter(
          (header) =>
            header.entity_id === input.fileId || header.entity_id === bodyWriteOutcomesEntity,
        ),
      }))
    const write = bodyWrites.find((plan) => plan.file_id === input.fileId)
    if (write !== undefined) {
      if (write.skill_page_id !== input.skillPageId || write.page_id !== input.pageId)
        return yield* Effect.fail(
          fail(
            "SHARED_BODY_WRITE_SCOPE",
            "The original body write no longer belongs to this exact editable page.",
          ),
        )
      const result = yield* reconcileSharedBodyWrite(input.library, write)
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_WRITE_RECONCILED",
          "The original body write is verified. Read the current page again before observing another edit.",
          {
            body_write_operation_id: write.operation_id,
            status: result.status,
            original_downloaded_at: write.before.downloaded_at,
            read_again: true,
          },
        ),
      )
    }
    const pending = (input.plans ?? [])
      .filter((plan) => plan.file_id === input.fileId)
      .sort(
        (left, right) =>
          left.body.downloaded_at - right.body.downloaded_at ||
          (left.operation_id < right.operation_id
            ? -1
            : left.operation_id > right.operation_id
              ? 1
              : 0),
      )[0]
    if (pending !== undefined) {
      const plan = yield* validateSharedObservationPlan(pending)
      if (plan.skill_page_id !== input.skillPageId || plan.page_id !== input.pageId)
        return yield* Effect.fail(
          fail(
            "SHARED_OBSERVATION_SCOPE",
            "The original observation plan belongs to another Skill or body page; preserve it for explicit reconciliation.",
            {
              observation_operation_id: plan.operation_id,
            },
          ),
        )
      yield* reconcileSharedObservation(input.library, plan)
      return yield* Effect.fail(
        fail(
          "SHARED_OBSERVATION_RECONCILED",
          "The original observation is verified in shared records. Read the current page in a new operation before publishing a snapshot.",
          {
            observation_operation_id: plan.operation_id,
            recovery: { version: 1, mode: "reconcile", plan },
            original_downloaded_at: plan.body.downloaded_at,
            read_again: true,
          },
        ),
      )
    }
    const body = yield* observeSharedBody(input.pageId)
    if (previous !== undefined) {
      const decision = yield* checked(() =>
        decideObservedBody(previous.ownership, body.fingerprint),
      )
      if (decision.kind === "unchanged" || decision.kind === "deleted")
        return { body, state: previous, changed: false } satisfies SharedFileObservation
    }
    if (input.readOnly)
      return yield* Effect.fail(
        fail(
          "SHARED_OBSERVATION_REQUIRED",
          "This body requires a retained shared observation. Run a normal current read before planning a write; this dry run sent no Notion writes.",
          { file_id: input.fileId, page_id: input.pageId },
        ),
      )

    const content: RetainedContent = {
      object_id: `body-${body.fingerprint.sha256}`,
      sha256: body.fingerprint.sha256,
      bytes: body.bytes,
    }
    const parents = [...(previous?.heads ?? [])].sort()
    const eventDigest = yield* sha256(
      canonicalSharedJson({
        version: 1,
        file_id: input.fileId,
        parents,
        content,
      }),
    )
    const eventId = `adopt-${eventDigest}`
    // Validate the proposed transition before retaining or writing any fact.
    const { event, state } = yield* checked(() => {
      const event = decode(FileEventSchema, {
        event_id: eventId,
        file_id: input.fileId,
        parents,
        kind: "adopted",
        content,
      })
      if (event.kind !== "adopted")
        throw fail("SHARED_STATE_INVALID", "The proposed observation must be an adoption event.")
      return { event, state: resolveFileState(input.fileId, [...input.events, event]) }
    })
    const operation = yield* makeSharedObservationPlan({
      skillPageId: input.skillPageId,
      fileId: input.fileId,
      pageId: input.pageId,
      body,
      event,
    })
    if (input.beforePlanWrite !== undefined) yield* input.beforePlanWrite(operation)
    yield* commitSharedObservationPlan(input.library, { mode: "create", plan: operation })
    // No success is returned until all three original shared facts are verified.
    return { body, state, changed: true, event, operation } satisfies SharedFileObservation
  })
}

/** Read a retained immutable object. Current body pages are never used as history. */
export function loadRetainedBody(
  library: SharedLibrary,
  skillPageId: string,
  input: RetainedContent,
) {
  return Effect.gen(function* () {
    const content = yield* checked(() => decode(RetainedContentSchema, input))
    const records = yield* querySharedRecords(library, {
      skillPageId,
      kind: "object",
      entityId: content.object_id,
      payloadContainsBody: true,
    })
    if (records.length === 0)
      return yield* Effect.fail(
        fail(
          "RETAINED_BODY_MISSING",
          "The exact retained body is unavailable; current Notion content cannot replace it.",
          { object_id: content.object_id },
        ),
      )
    const record = records[0]
    if (records.length !== 1 || record === undefined || record.record_id !== content.object_id)
      return yield* Effect.fail(
        fail(
          "RETAINED_BODY_CONFLICT",
          "The retained object does not have one exact record identity.",
          { object_id: content.object_id },
        ),
      )
    const payload = yield* checked(() => decode(RetainedMarkdownSchema, record.payload))
    const markdown = yield* checked(() =>
      normalizeObservedBody(payload.markdown, payload.normalization_version),
    )
    if (markdown !== payload.markdown)
      return yield* Effect.fail(
        fail(
          "RETAINED_BODY_INVALID",
          "Retained Markdown does not use its declared normalization.",
          { object_id: content.object_id },
        ),
      )
    const encoded = new TextEncoder().encode(markdown)
    const hash = yield* sha256(encoded)
    if (hash !== content.sha256 || encoded.byteLength !== content.bytes)
      return yield* Effect.fail(
        fail(
          "RETAINED_BODY_INVALID",
          "Retained body bytes do not match the fixed content reference.",
          {
            object_id: content.object_id,
            expected_sha256: content.sha256,
            expected_bytes: content.bytes,
          },
        ),
      )
    if (content.object_id !== `body-${hash}` || record.operation_id !== `retain-${hash}`)
      return yield* Effect.fail(
        fail("RETAINED_BODY_INVALID", "Retained body identity does not match its content hash.", {
          object_id: content.object_id,
        }),
      )
    const fingerprint: BodyFingerprint = { normalization_version: 1, sha256: hash }
    return {
      markdown,
      fingerprint,
      bytes: encoded.byteLength,
      content,
    }
  })
}
