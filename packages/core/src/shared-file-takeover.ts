import { Effect, Schema } from "effect"
import { fail, property } from "./model.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import {
  FileEventSchema,
  resolveFileState,
  nativeMetadataForOwnership,
} from "./shared-file-state.ts"
import {
  assertSharedFileIntentReady,
  fileIntentChecked,
  readSharedFileIntentContext,
  sharedFileIntentJournal,
} from "./shared-file-intent.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { nativeObservedObjectIdentity } from "./shared-native-body-completion.ts"
import {
  commitSharedObservationPlan,
  makeSharedObservationPlan,
  reconcileSharedObservation,
  SharedObservationPlanSchema,
  validateSharedObservationPlan,
} from "./shared-observation-operation.ts"
import { querySharedOperationIndex } from "./shared-operation-index.ts"
import { observeSharedBody } from "./shared-page-body.ts"
import {
  pendingFileOperationKey,
  pendingFileOperations,
  retainPendingFileOperation,
} from "./shared-pending-file-operations.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256, Store } from "./store.ts"
import { SharedFileSourceContextSchema } from "./shared-file-source-context-model.ts"

export const SharedFileTakeoverPlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("file_takeover"),
  plan_id: Schema.String.check(Schema.isPattern(/^takeover-[a-f0-9]{64}$/u)),
  library_id: Schema.String,
  skill_id: Schema.String,
  source_id: Schema.String,
  source_context: SharedFileSourceContextSchema,
  path: Schema.String,
  observation: SharedObservationPlanSchema,
})
export type SharedFileTakeoverPlan = typeof SharedFileTakeoverPlanSchema.Type

export function validateSharedFileTakeoverPlan(library: SharedLibrary, input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* fileIntentChecked(() =>
      Schema.decodeUnknownSync(SharedFileTakeoverPlanSchema)(structuredClone(input), {
        onExcessProperty: "error",
      }),
    )
    yield* validateSharedObservationPlan(plan.observation)
    const { plan_id, ...contents } = plan
    if (
      plan.library_id !== library.library_id ||
      plan_id !== "takeover-" + (yield* sha256(canonicalSharedJson(contents)))
    )
      return yield* Effect.fail(
        fail("SHARED_FILE_INTENT_INVALID", "The takeover plan digest or library identity differs."),
      )
    return plan
  })
}

/** Explicit consent can adopt unchanged following bytes; Status and timestamps cannot. */
export function prepareSharedFileTakeover(input: {
  readonly library: SharedLibrary
  readonly skillPageId: string
  readonly path: string
}) {
  return Effect.gen(function* () {
    const context = yield* readSharedFileIntentContext(input)
    if (context.state?.ownership.kind === "tombstone")
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_INTENT_BLOCKED",
          "A tombstone requires its separate explicit restoration lifecycle.",
        ),
      )
    yield* assertSharedFileIntentReady(input.library, context)
    const body = yield* observeSharedBody(context.binding.page_id)
    const retained = yield* nativeObservedObjectIdentity(
      body.fingerprint.sha256,
      body.native_body_completion,
    )
    const content = {
      object_id: retained.object_id,
      sha256: body.fingerprint.sha256,
      bytes: body.bytes,
      ...nativeMetadataForOwnership(context.state?.ownership),
    }
    const parents = [...(context.state?.heads ?? [])].sort()
    const eventDescription = { version: 1, file_id: context.binding.file_id, parents, content }
    const event = yield* fileIntentChecked(() =>
      Schema.decodeUnknownSync(FileEventSchema)({
        kind: "adopted",
        file_id: context.binding.file_id,
        parents,
        content,
        event_id: "pending",
      }),
    )
    if (event.kind !== "adopted")
      return yield* Effect.fail(
        fail("SHARED_FILE_INTENT_INVALID", "A takeover must produce an adopted event."),
      )
    const observation = yield* makeSharedObservationPlan({
      skillPageId: context.index.page_id,
      fileId: context.binding.file_id,
      pageId: context.binding.page_id,
      body,
      event: {
        ...event,
        event_id: "adopt-" + (yield* sha256(canonicalSharedJson(eventDescription))),
      },
    })
    const contents = {
      version: 1 as const,
      kind: "file_takeover" as const,
      library_id: input.library.library_id,
      skill_id: context.index.skill_id,
      source_id: context.index.source_reference,
      source_context: context.sourceContext,
      path: context.binding.path,
      observation,
    }
    const plan = yield* validateSharedFileTakeoverPlan(input.library, {
      ...contents,
      plan_id: "takeover-" + (yield* sha256(canonicalSharedJson(contents))),
    })
    return {
      status: "planned" as const,
      dry_run: true as const,
      body_writes: 0 as const,
      unchanged:
        context.state?.ownership.kind === "custom" &&
        context.state.ownership.content.sha256 === body.fingerprint.sha256,
      plan,
    }
  }).pipe(withReadOnlyNotion)
}

function currentForPlan(library: SharedLibrary, plan: SharedFileTakeoverPlan) {
  return Effect.gen(function* () {
    const context = yield* readSharedFileIntentContext({
      library,
      skillPageId: plan.observation.skill_page_id,
      path: plan.path,
    })
    if (
      context.index.skill_id !== plan.skill_id ||
      context.index.source_reference !== plan.source_id ||
      canonicalSharedJson(context.sourceContext) !== canonicalSharedJson(plan.source_context) ||
      context.binding.file_id !== plan.observation.file_id ||
      context.binding.page_id !== plan.observation.page_id ||
      context.state?.ownership.kind === "tombstone" ||
      canonicalSharedJson(context.state?.heads ?? []) !==
        canonicalSharedJson(plan.observation.event.parents)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_INTENT_STALE",
          "The file identity, selected source or original frontier changed.",
        ),
      )
    const body = yield* observeSharedBody(context.binding.page_id)
    if (
      body.fingerprint.sha256 !== plan.observation.body.fingerprint.sha256 ||
      body.bytes !== plan.observation.body.bytes ||
      canonicalSharedJson(body.native_body_completion ?? null) !==
        canonicalSharedJson(plan.observation.body.native_body_completion ?? null)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_INTENT_STALE",
          "The complete observed body changed after takeover was prepared.",
        ),
      )
    return context
  })
}

/** Reuse the existing observation journal; no content update, selection or relation PATCH exists here. */
export function executeSharedFileTakeover(input: {
  readonly library: SharedLibrary
  readonly plan: unknown
  readonly mode: "create" | "reconcile"
}) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedFileTakeoverPlan(input.library, input.plan)
    const observation = plan.observation
    const operationId = observation.operation_id
    return yield* Effect.gen(function* () {
      const context = yield* readSharedFileIntentContext({
        library: input.library,
        skillPageId: observation.skill_page_id,
        path: plan.path,
      })
      if (
        context.index.skill_id !== plan.skill_id ||
        context.binding.file_id !== observation.file_id ||
        context.binding.page_id !== observation.page_id
      )
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_INTENT_STALE",
            "The original takeover belongs to another file identity.",
          ),
        )
      const journal = yield* sharedFileIntentJournal(input.library, context)
      const headers = yield* querySharedOperationIndex(input.library, observation.skill_page_id)
      const local = yield* pendingFileOperations(journal)
      const originalExists =
        headers.some((header) => header.record_id === operationId) ||
        local.some((entry) => entry.plan.operation_id === operationId)
      if (input.mode === "reconcile" || originalExists) {
        yield* reconcileSharedObservation(input.library, observation).pipe(withReadOnlyNotion)
      } else {
        const current = yield* currentForPlan(input.library, plan)
        yield* assertSharedFileIntentReady(input.library, current)
        if (
          current.state?.ownership.kind === "custom" &&
          current.state.ownership.content.sha256 === observation.body.fingerprint.sha256
        )
          return {
            status: "unchanged" as const,
            file_id: observation.file_id,
            body_writes: 0 as const,
            remote_writes: 0 as const,
            state: current.state,
          }
        yield* retainPendingFileOperation(journal, observation)
        yield* commitSharedObservationPlan(input.library, {
          mode: "create",
          plan: observation,
          beforeEventWrite: currentForPlan(input.library, plan).pipe(
            Effect.asVoid,
            withReadOnlyNotion,
          ),
        })
      }
      yield* (yield* Store).retireKeys([
        yield* pendingFileOperationKey(journal.prefix, observation),
      ])
      const verified = yield* readSharedFileIntentContext({
        library: input.library,
        skillPageId: observation.skill_page_id,
        path: plan.path,
      })
      const state = yield* fileIntentChecked(() =>
        resolveFileState(observation.file_id, verified.events),
      )
      if (!verified.events.some((event) => event.event_id === observation.event.event_id))
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_INTENT_UNKNOWN",
            "The original adoption event is not visible in the complete file history.",
          ),
        )
      return {
        status: "verified_applied" as const,
        plan_id: plan.plan_id,
        operation_id: operationId,
        file_id: observation.file_id,
        body_writes: 0 as const,
        state,
        original_observation: observation.body.fingerprint,
        requires_fresh_read: true as const,
      }
    }).pipe(
      Effect.mapError((error) =>
        fail(error.code, error.message, {
          ...property(error.details),
          status:
            error.code === "WRITE_OUTCOME_UNKNOWN" || error.code === "SHARED_RECORD_UNRESOLVED"
              ? "unknown"
              : "blocked",
          plan_id: plan.plan_id,
          observation_operation_id: operationId,
          takeover_plan: plan,
          body_writes: 0,
        }),
      ),
    )
  })
}
