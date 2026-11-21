import { Effect } from "effect"
import { fail, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { resolveCurrentSkillConsumption } from "./shared-current-consumption.ts"
import {
  queryCurrentSkillIndex,
  type CurrentFileBinding,
  type CurrentSkillIndex,
} from "./shared-current-index.ts"
import { withCurrentInvocationBudget } from "./shared-current-invocation.ts"
import {
  cancelCurrentProjectionOperation,
  currentOperationFailure,
  readCurrentOperationIntent,
} from "./shared-current-operation.ts"
import {
  currentProjectionArchiveFileAction,
  currentProjectionCreateFileAction,
  currentProjectionUpdateFileAction,
  readCurrentProjectionFile,
} from "./shared-current-projection-files.ts"
import {
  currentProjectionPendingAction,
  renderCurrentProjection,
} from "./shared-current-projection.ts"
import {
  currentProjectionLinkRewriter,
  prepareCurrentProjectionFiles,
} from "./shared-current-projection-write.ts"
import { currentWriteIdentity } from "./shared-current-write-input.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import type { SharedSourcePlanOptions } from "./shared-source-plan.ts"

export type CurrentSkillProjectionCancellationOptions = {
  readonly target: string
  readonly operation_id: string
  readonly sourceOptions?: SharedSourcePlanOptions
}
export type CurrentSkillProjectionCancellationResult = {
  readonly version: 1
  readonly contract: "current"
  readonly library: { readonly library_id: string; readonly entry: string }
  readonly skill_id: string
  readonly page_id: string
  readonly operation_id: string
  readonly status: "cancelled" | "not_found"
  readonly input_sha256?: string
}
const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_PROJECTION_CONFLICT", message, details)
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : invalid("The selected projection cancellation is invalid."),
  })
const fileBinding = ({ file_id, page_id, skill_page_id, path, content }: CurrentFileBinding) => ({
  file_id,
  page_id,
  skill_page_id,
  path,
  content,
})
const directory = (index: CurrentSkillIndex) =>
  canonicalSharedJson({
    skill_id: index.skill_id,
    page_id: index.page_id,
    files: [index.main, ...index.files]
      .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map(fileBinding),
  })

/** Cancel only an observed finite projection prefix. No body or File request is dispatched. */
export function cancelCurrentSkillProjection(
  library: SharedLibrary,
  input: CurrentSkillProjectionCancellationOptions,
) {
  return Effect.gen(function* () {
    yield* checked(() => currentWriteIdentity(input.operation_id, "Operation ID"))
    const index = yield* queryCurrentSkillIndex(library, input.target)
    const current = yield* readCurrentOperationIntent(library, {
      kind: "skill",
      id: index.skill_id,
    })
    const result = (
      status: "cancelled" | "not_found",
      input_sha256?: string,
    ): CurrentSkillProjectionCancellationResult => ({
      version: 1,
      contract: "current",
      library: { library_id: library.library_id, entry: library.skills.database_id },
      skill_id: index.skill_id,
      page_id: index.page_id,
      operation_id: input.operation_id,
      status,
      ...(input_sha256 === undefined ? {} : { input_sha256 }),
    })
    if (current === undefined) return result("not_found")
    const intent = current.intent
    if (
      !("projection" in intent) ||
      intent.projection !== true ||
      intent.operation_id !== input.operation_id ||
      current.owner_page_id !== index.page_id
    )
      return yield* Effect.fail(
        currentOperationFailure(
          fail(
            "CURRENT_OPERATION_CONFLICT",
            "Cancel only the exact current reading projection for this Skill.",
          ),
          intent,
          null,
          index.page_id,
        ),
      )
    if (index.state.state !== "ready")
      return yield* Effect.fail(
        currentOperationFailure(
          invalid("The current Skill owner is not ready for reading projection cancellation."),
          intent,
          null,
          index.page_id,
        ),
      )
    const originalDirectory = directory(index)
    const assertScope = Effect.gen(function* () {
      const observed = yield* queryCurrentSkillIndex(library, index.page_id)
      if (observed.state.state !== "ready" || directory(observed) !== originalDirectory)
        return yield* Effect.fail(
          invalid("The current Skill or File authority changed during projection cancellation."),
        )
    })
    const files = [index.main, ...index.files]
    const cancelled = yield* cancelCurrentProjectionOperation<
      Effect.Services<ReturnType<typeof prepareCurrentProjectionFiles>>
    >(library, {
      intent,
      ownerPageId: index.page_id,
      assertScope,
      reconcile: (session) =>
        Effect.gen(function* () {
          const key = session.pendingActionKey
          if (key === undefined) return
          const body = /^projection:([a-f0-9-]{36}):(?:clear|append:(?:0|[1-9][0-9]*))$/u.exec(key)
          if (body !== null) {
            const file = files.find((file) => file.page_id === body[1])
            if (file === undefined || file.content.kind === "native")
              return yield* Effect.fail(
                invalid("The pending generated body has no current non-native owner.", {
                  pending_action: key,
                }),
              )
            const consumption = yield* resolveCurrentSkillConsumption(library, index, {
              sourceOptions: input.sourceOptions,
            })
            const selected = consumption.files.find((entry) => entry.path === file.path)
            if (
              selected === undefined ||
              canonicalSharedJson(selected.content) !== canonicalSharedJson(file.content)
            )
              return yield* Effect.fail(
                invalid("The pending body no longer has its exact current original descriptor."),
              )
            const prepared = (yield* prepareCurrentProjectionFiles(
              library,
              index,
              [file],
              consumption,
            ))[0]
            if (prepared === undefined || prepared.kind !== "text")
              return yield* Effect.fail(invalid("The pending body has no complete text original."))
            const plan = yield* checked(() =>
              renderCurrentProjection({
                path: file.path,
                bytes: prepared.bytes,
                rewriteLink: currentProjectionLinkRewriter(
                  file.path,
                  new Map(files.map((entry) => [entry.path, entry.page_id])),
                  consumption,
                ),
              }),
            )
            const action = yield* currentProjectionPendingAction({
              pageId: file.page_id,
              key,
              plan,
            })
            yield* session.reconcilePendingAction({
              ...action,
              observe: (options) =>
                Effect.gen(function* () {
                  yield* assertScope
                  const admitted = yield* resolveCurrentSkillConsumption(library, index, {
                    sourceOptions: input.sourceOptions,
                  })
                  if (admitted.source_fingerprint !== consumption.source_fingerprint)
                    return yield* Effect.fail(
                      invalid("The current Source changed while reading the pending projection."),
                    )
                  return yield* action.observe(options)
                }),
            })
            return
          }
          const create = /^projection-file:(.+):create$/u.exec(key)
          if (create !== null) {
            const file = index.files.find((file) => file.file_id === create[1])
            if (file === undefined)
              return yield* Effect.fail(
                fail(
                  "CURRENT_OPERATION_UNRESOLVED",
                  "The pending File creation is not observable; cancellation cannot replay it.",
                  { pending_action: key },
                ),
              )
            if (file.content.kind !== "source")
              return yield* Effect.fail(invalid("The pending created File is now Notion-owned."))
            const action = yield* currentProjectionCreateFileAction(library, index.page_id, {
              ...file,
              content: file.content,
            })
            yield* assertScope
            yield* session.reconcilePendingAction(action)
            return
          }
          const metadata = /^projection-file:([a-f0-9-]{36}):(content|archive)$/u.exec(key)
          if (metadata !== null) {
            const file = yield* readCurrentProjectionFile(
              library,
              index.page_id,
              yield* (yield* Notion).request("v1/pages/" + metadata[1]),
              metadata[2] === "archive",
            )
            if (file.content.kind !== "source")
              return yield* Effect.fail(invalid("The pending File is now Notion-owned."))
            yield* assertScope
            if (metadata[2] === "archive")
              yield* session.reconcilePendingAction(
                yield* currentProjectionArchiveFileAction(library, index.page_id, file),
              )
            else
              yield* session.reconcilePendingAction(
                yield* currentProjectionUpdateFileAction(
                  library,
                  index.page_id,
                  file,
                  file.content,
                ),
              )
            return
          }
          return yield* Effect.fail(
            invalid("This pending action has no exact read-only projection observer.", {
              pending_action: key,
            }),
          )
        }),
    }).pipe(Effect.mapError((error) => currentOperationFailure(error, intent, null, index.page_id)))
    return result(cancelled.status, cancelled.input_sha256)
  }).pipe(
    (effect) => withCurrentInvocationBudget(effect),
    Effect.map(({ result }) => result),
  )
}
