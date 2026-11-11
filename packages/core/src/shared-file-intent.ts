import { Effect } from "effect"
import { authScope } from "./catalog.ts"
import { decode, fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { normalizePath, pageId } from "./ref.ts"
import {
  FileEventSchema,
  resolveFileState,
  resourceContentForOwnership,
} from "./shared-file-state.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { loadPendingSharedBodyWrites } from "./shared-body-write.ts"
import { loadPendingSharedObservationPlans } from "./shared-observation-operation.ts"
import { querySharedOperationIndex } from "./shared-operation-index.ts"
import {
  pendingFileOperations,
  sharedPendingObservationPrefix,
} from "./shared-pending-file-operations.ts"
import { querySharedRecords } from "./shared-records.ts"
import { querySharedSkillIndex } from "./shared-skill-index.ts"
import { readSharedFileSourceContext } from "./shared-file-source-context.ts"

export const fileIntentChecked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_FILE_INTENT_INVALID", "The exact file request could not be validated."),
  })

/** Exact existing main/supporting identity. Status labels never determine ownership. */
export function readSharedFileIntentContext(input: {
  readonly library: SharedLibrary
  readonly skillPageId: string
  readonly path: string
}) {
  return Effect.gen(function* () {
    if (
      pageId(input.skillPageId) !== input.skillPageId ||
      normalizePath(input.path) !== input.path ||
      !input.path ||
      input.path === "."
    )
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Select an exact Skill page and canonical file path."),
      )
    const raw = yield* (yield* Notion).request(`v1/pages/${input.skillPageId}`)
    const index = yield* querySharedSkillIndex(input.library, input.skillPageId, raw)
    const sourceContext = yield* readSharedFileSourceContext(input.library, input.skillPageId, raw)
    if (!index.enabled)
      return yield* Effect.fail(
        fail("CONTENT_DISABLED", "Enable the selected Skill before managing its files."),
      )
    const matching = [index.main, ...index.files].filter((file) => file.path === input.path)
    const binding = matching[0]
    if (matching.length !== 1 || binding === undefined)
      return yield* Effect.fail(
        fail("SHARED_FILE_NOT_BOUND", "The exact path must identify one existing File ID."),
      )
    const facts = yield* querySharedRecords(input.library, {
      skillPageId: input.skillPageId,
      kind: "file_event",
      entityId: binding.file_id,
    })
    const events = yield* fileIntentChecked(() =>
      facts.map((fact) => {
        const event = decode(FileEventSchema, fact.payload)
        if (
          fact.entity_id !== binding.file_id ||
          event.file_id !== binding.file_id ||
          fact.record_id !== event.event_id
        )
          throw fail("SHARED_STATE_SCOPE", "The file event belongs to another exact identity.")
        return event
      }),
    )
    const state = yield* fileIntentChecked(() =>
      events.length === 0 ? undefined : resolveFileState(binding.file_id, events),
    )
    if (state?.placement !== undefined && state.placement.path !== binding.path)
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_INTENT_STALE",
          "The native path and accepted logical placement disagree.",
        ),
      )
    if (state !== undefined && resourceContentForOwnership(state.ownership) !== undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_INTENT_UNSUPPORTED",
          "Raw resources use their retained byte lifecycle; the management page body is not file content.",
        ),
      )
    return { index, binding, events, state, sourceContext }
  })
}

export type SharedFileIntentContext = Effect.Success<ReturnType<typeof readSharedFileIntentContext>>

export function sharedFileIntentJournal(library: SharedLibrary, context: SharedFileIntentContext) {
  return Effect.gen(function* () {
    const scope = yield* authScope
    return {
      prefix: yield* sharedPendingObservationPrefix(
        scope,
        library.library_id,
        context.index.skill_id,
      ),
      scope,
      library_id: library.library_id,
      skill_id: context.index.skill_id,
      skill_page_id: context.index.page_id,
    }
  })
}

/** Pending original writes remain a barrier; preparation never reconciles or starts a replacement. */
export function assertSharedFileIntentReady(
  library: SharedLibrary,
  context: SharedFileIntentContext,
) {
  return Effect.gen(function* () {
    const headers = (yield* querySharedOperationIndex(library, context.index.page_id)).filter(
      (header) =>
        header.entity_id === context.binding.file_id ||
        header.entity_id === "body-write-outcomes-v1",
    )
    const input = { skillPageId: context.index.page_id, events: context.events, headers }
    const observations = yield* loadPendingSharedObservationPlans(library, input)
    const writes = yield* loadPendingSharedBodyWrites(library, input)
    const local = yield* pendingFileOperations(yield* sharedFileIntentJournal(library, context))
    const pending = [...observations, ...writes, ...local.map((entry) => entry.plan)].filter(
      (plan) => plan.file_id === context.binding.file_id,
    )
    if (pending.length > 0)
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_INTENT_PENDING",
          "The original file operation must be inspected before preparing another request.",
          {
            pending: [...new Set(pending.map((plan) => plan.operation_id))],
            file_id: context.binding.file_id,
          },
        ),
      )
  })
}
