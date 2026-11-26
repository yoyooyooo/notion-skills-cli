import { Clock, Context, Crypto, Effect } from "effect"
import { fail, property, SkillsError } from "./model.ts"
import { libraryId } from "./catalog.ts"
import { withLocalLocks } from "./local-locks.ts"
import { Notion } from "./notion.ts"
import { RequestBudget } from "./request-budget.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import { preservesSharedLibraryBindings, type SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256, Store } from "./store.ts"
import { withCurrentInvocationBudget } from "./shared-current-invocation.ts"
import { readCurrentOperationIntent } from "./shared-current-operation.ts"
import { projectCurrentSkill } from "./shared-current-projection-write.ts"
import { currentWriteIdentity } from "./shared-current-write-input.ts"
import { queryCurrentFilesForSkills, readCurrentSkillMetadata } from "./shared-current-index.ts"
import {
  prepareCurrentSource,
  type PreparedCurrentSourceInput,
} from "./shared-current-source-input.ts"
import {
  checkCurrentSource,
  currentSourceConfigurationFingerprint,
  makeCurrentSourceCheckBatch,
  type CurrentSourceCheckBatch,
} from "./shared-current-source-check.ts"
import {
  queryCurrentSourceManagement,
  queryCurrentSourceManagementBatch,
  queryCurrentSourceTargetPages,
  type CurrentSourceManagement,
} from "./shared-current-source-management.ts"
import { writePreparedCurrentSource } from "./shared-current-source-write.ts"
import { validateCurrentSourceId } from "./shared-current-source.ts"
import {
  CurrentSourceSyncBatchSchema,
  isCurrentSourceSyncBatchTerminal,
  preservesCurrentSourceSyncBatch,
  type CurrentSourceSyncBatch,
  type CurrentSourceSyncBatchReference,
} from "./shared-current-source-sync-batch-model.ts"
import {
  appendCurrentSourceSyncBatchResult,
  currentSourceSyncBatchKey,
  currentSourceSyncBatchReference,
  makeCurrentSourceSyncBatch,
  matchesCurrentSourceSyncBatch,
} from "./shared-current-source-sync-batch-helper.ts"
import {
  CurrentSourceSyncObservationSchema,
  CurrentSourceSyncPendingSchema,
  type CurrentSourceCheckRequest,
  type CurrentSourceSyncCommand,
  type CurrentSourceSyncItem,
  type CurrentSourceSyncPending,
  type CurrentSourceSyncRequest,
  type CurrentSourceSyncResult,
} from "./shared-current-source-sync-model.ts"

export * from "./shared-current-source-sync-model.ts"

/** Only the Git provider boundary is replaceable in controlled kernel tests. */
export const CurrentSourceSyncProvider = Context.Reference<{
  readonly prepare: typeof prepareCurrentSource
  readonly check: typeof checkCurrentSource
}>("ntn-skills/CurrentSourceSyncProvider", {
  defaultValue: () => ({ prepare: prepareCurrentSource, check: checkCurrentSource }),
})

const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError ? error : fail("INVALID_ARGUMENT", "Invalid Source sync input."),
  })
const pendingKey = (scope: string) => `operations/current-source-sync/${scope}/pending.json`
const observationKey = (scope: string) => `cache/current-source-sync/${scope}/latest.json`
const sourceId = (current: CurrentSourceManagement) => current.declaration.definition.source_id
const conflict = (message: string, details?: unknown) =>
  fail("CURRENT_SOURCE_SYNC_CONFLICT", message, details)
const projectionOperation = (operation: string, skill: string) =>
  sha256(canonicalSharedJson([operation, skill])).pipe(
    Effect.map((hash) => `source-projection-${hash}`),
  )

export function validateCurrentSourceSyncCommand(
  input: CurrentSourceSyncCommand,
): CurrentSourceSyncCommand {
  if (input.action !== "check" && input.action !== "sync")
    throw fail("INVALID_ARGUMENT", "Use check or sync.")
  if (
    !Array.isArray(input.source_ids) ||
    input.source_ids.length === 0 ||
    input.source_ids.length > 256
  )
    throw fail("INVALID_ARGUMENT", "Select 1 to 256 explicit Source IDs.")
  let source_ids: string[]
  try {
    source_ids = [...new Set(input.source_ids.map(validateCurrentSourceId))].sort()
  } catch {
    throw fail("INVALID_ARGUMENT", "Select bounded stable current Source IDs.")
  }
  if (
    input.limits !== undefined &&
    (input.limits === null ||
      typeof input.limits !== "object" ||
      Object.entries(input.limits).some(
        ([key, value]) =>
          !["requests", "bytes", "duration_ms"].includes(key) ||
          !Number.isSafeInteger(value) ||
          value <= 0,
      ))
  )
    throw fail(
      "INVALID_ARGUMENT",
      "Request budgets must contain positive safe integers for requests, bytes or duration_ms.",
    )
  const limits = input.limits === undefined ? undefined : { ...input.limits }
  if (input.action === "check") return { action: "check", source_ids, limits }
  const manager_id = currentWriteIdentity(input.manager_id, "Sync manager ID")
  const execution_id = currentWriteIdentity(input.execution_id, "Sync execution ID")
  if (input.mode !== undefined && input.mode !== "changed" && input.mode !== "full")
    throw fail("INVALID_ARGUMENT", "Source sync mode must be changed or full.")
  if (
    input.projection !== undefined &&
    input.projection !== "none" &&
    input.projection !== "markdown"
  )
    throw fail("INVALID_ARGUMENT", "Source sync projection must be none or markdown.")
  return {
    action: "sync",
    source_ids,
    limits,
    manager_id,
    execution_id,
    mode: input.mode ?? "changed",
    projection: input.projection ?? "none",
  }
}

function pendingOwners(
  library: SharedLibrary,
  current: CurrentSourceManagement,
  own?: CurrentSourceSyncPending,
) {
  return Effect.gen(function* () {
    const id = sourceId(current)
    const parent = yield* readCurrentOperationIntent(library, { kind: "source", id })
    if (
      parent !== undefined &&
      (own?.phase !== "content" ||
        !("source_input" in parent.intent) ||
        parent.intent.source_input.kind !== "declaration" ||
        parent.intent.operation_id !== own.input.operation_id ||
        parent.intent.source_input.configuration_sha256 !== own.input.configuration_sha256 ||
        parent.intent.source_input.resolved_commit !== own.input.resolved_commit ||
        canonicalSharedJson(parent.intent.source_input.affected_skill_ids) !==
          canonicalSharedJson(own.input.affected_skill_ids))
    )
      return yield* Effect.fail(
        conflict("An unfinished Source belongs to another exact input.", {
          source_id: id,
          operation_id: parent.intent.operation_id,
        }),
      )
    if (parent === undefined && current.state.state !== "ready")
      return yield* Effect.fail(
        conflict("The Source is not ready and has no recoverable owned intent.", { source_id: id }),
      )
    const pages = yield* queryCurrentSourceTargetPages(library, {
      skillIds: [
        ...current.declaration.contributions.map((entry) => entry.skill_id),
        ...(own?.input.affected_skill_ids ?? []),
      ],
      sourcePageId: current.page_id,
      sourceId: id,
    })
    const affected = [
      ...new Set([
        ...pages.keys(),
        ...current.declaration.contributions.map((entry) => entry.skill_id),
        ...(own?.input.affected_skill_ids ?? []),
      ]),
    ].sort()
    for (const skill_id of affected) {
      const pending = yield* readCurrentOperationIntent(library, { kind: "skill", id: skill_id })
      if (pending === undefined) {
        const page = pages.get(skill_id)
        if (
          page !== undefined &&
          (yield* readCurrentSkillMetadata(library, page.page_id, page.page)).state.state !==
            "ready"
        )
          return yield* Effect.fail(
            conflict("An affected Skill is not ready and has no recoverable original intent.", {
              skill_id,
            }),
          )
        continue
      }
      if (
        own?.phase === "projection" &&
        own.targets.slice(0, own.next_index).some((target) => target.skill_id === skill_id)
      )
        return yield* Effect.fail(
          conflict("A completed projection prefix gained an unfinished intent.", {
            skill_id,
            operation_id: pending.intent.operation_id,
          }),
        )
      if (
        own?.phase === "projection" &&
        own.targets.some((target) => target.skill_id === skill_id) &&
        "projection" in pending.intent &&
        pending.intent.projection === true &&
        pending.intent.operation_id ===
          (yield* projectionOperation(own.input.operation_id, skill_id))
      )
        continue
      if (
        own?.phase === "content" &&
        parent !== undefined &&
        "source" in pending.intent &&
        pending.intent.source?.source_id === id &&
        pending.intent.source.operation_id === own.input.operation_id &&
        pending.intent.source.input_sha256 === parent.intent.input_sha256 &&
        pending.intent.operation_id ===
          `source-target-${yield* sha256(canonicalSharedJson([own.input.operation_id, skill_id]))}`
      )
        continue
      return yield* Effect.fail(
        fail(
          "CURRENT_SOURCE_TARGET_PENDING",
          "Finish the target's original intent before checking or advancing its Source.",
          { source_id: id, skill_id, operation_id: pending.intent.operation_id },
        ),
      )
    }
    return { parent, pages, affected }
  })
}

type Progress = {
  operation_id: string | null
  content: CurrentSourceSyncItem["content"]
  projection: CurrentSourceSyncItem["projection"]
}
const selection = (input: CurrentSourceSyncPending["input"]) => ({
  configuration_sha256: input.configuration_sha256,
  resolved_commit: input.resolved_commit,
  revision: input.revision,
})

function owningBatch(
  library: SharedLibrary,
  pending: CurrentSourceSyncPending,
  batch: CurrentSourceSyncBatch | undefined,
) {
  if (
    batch === undefined ||
    pending.full_batch?.scope !== batch.scope ||
    pending.full_batch.batch_id !== batch.batch_id
  )
    return undefined
  const index = batch.source_ids.indexOf(pending.input.declaration.definition.source_id)
  if (
    batch.library_id !== library.library_id ||
    batch.sources_data_source_id !== library.sources.data_source_id ||
    batch.manager_id !== pending.manager_id ||
    batch.execution_id !== pending.execution_id ||
    index < 0
  )
    throw conflict("The unfinished Source does not belong to its exact full batch.")
  return { batch, index }
}

/** A protected parent completion can acknowledge its child after a lost local
 * cleanup. A disposable observation is never authority for this transition. */
function completedBatchChild(
  library: SharedLibrary,
  pending: CurrentSourceSyncPending,
  batch: CurrentSourceSyncBatch | undefined,
) {
  const owned = owningBatch(library, pending, batch)
  const item = owned?.batch.results[owned.index]
  if (item === undefined || item.error !== null) return undefined
  const projectionMatches =
    pending.phase === "projection" &&
    (pending.input.projection === "none"
      ? pending.next_index === 0 && item.projection.status === "not_requested"
      : pending.next_index === pending.targets.length &&
        item.projection.status === "complete" &&
        canonicalSharedJson(item.projection.skill_ids) ===
          canonicalSharedJson(pending.targets.map((target) => target.skill_id)))
  if (
    (item.status !== "applied" && item.status !== "reconciled") ||
    item.operation_id !== pending.input.operation_id ||
    item.content.status !== "published" ||
    item.content.configuration_sha256 !== pending.input.configuration_sha256 ||
    item.content.resolved_commit !== pending.input.resolved_commit ||
    item.content.revision !== pending.input.revision ||
    !projectionMatches
  )
    throw conflict(
      "The full batch does not prove completion of this exact Source input and projection.",
    )
  return item
}

function checkpointSourceCompletion(
  library: SharedLibrary,
  pending: CurrentSourceSyncPending,
  item: CurrentSourceSyncItem,
) {
  return Effect.gen(function* () {
    if (pending.full_batch === undefined) return
    const store = yield* Store
    const batch = yield* store.readJson(
      currentSourceSyncBatchKey(pending.full_batch.scope),
      CurrentSourceSyncBatchSchema,
    )
    const owned = yield* checked(() => owningBatch(library, pending, batch))
    if (owned === undefined) return
    if (owned.index > owned.batch.results.length)
      return yield* Effect.fail(
        conflict("A Source completion cannot skip the full batch's unfinished prefix."),
      )
    if (owned.index < owned.batch.results.length) {
      // Preserve historical hard failures as well as earlier exact completions.
      yield* checked(() => completedBatchChild(library, pending, owned.batch))
      return
    }
    const next = yield* checked(() => appendCurrentSourceSyncBatchResult(owned.batch, item))
    yield* store.writeJson(currentSourceSyncBatchKey(next.scope), next)
  })
}

function verifyRetirements(library: SharedLibrary, pending: CurrentSourceSyncPending) {
  return Effect.gen(function* () {
    const api = yield* Notion
    for (const target of pending.input.retirements) {
      const page = property(yield* api.request(`v1/pages/${target.page_id}`))
      if (page.in_trash !== true && page.archived !== true)
        return yield* Effect.fail(conflict("A frozen removed member is still live.", target))
      const files = yield* queryCurrentFilesForSkills({
        dataSourceId: library.files.data_source_id,
        skillPageIds: [target.page_id],
        propertyIds: library.files.property_ids,
      })
      if ((files.get(target.page_id)?.length ?? 0) !== 0)
        return yield* Effect.fail(
          conflict("A frozen removed member still owns live Files.", target),
        )
    }
  })
}

function continueOwned(
  library: SharedLibrary,
  initial: CurrentSourceManagement,
  saved: CurrentSourceSyncPending,
  progress: Progress,
  preparedInput?: PreparedCurrentSourceInput,
) {
  return Effect.gen(function* () {
    const store = yield* Store,
      api = yield* Notion,
      provider = yield* CurrentSourceSyncProvider
    let pending = saved
    if (pending.phase === "projection" && pending.next_index > pending.targets.length)
      return yield* Effect.fail(
        fail("STATE_CORRUPT", "The projection cursor exceeds its frozen target scope."),
      )
    progress.operation_id = pending.input.operation_id
    progress.content = {
      status: pending.phase === "projection" ? "published" : "observed",
      ...selection(pending.input),
    }
    progress.projection =
      pending.input.projection === "none" ? { status: "not_requested" } : { status: "not_started" }
    const owners = yield* pendingOwners(library, initial, pending)
    if (initial.page_id !== pending.input.source_page_id)
      return yield* Effect.fail(conflict("The frozen Source changed physical identity."))
    const liveConfiguration = yield* currentSourceConfigurationFingerprint(initial.declaration)
    const atBaseline =
      initial.revision === pending.input.baseline_revision &&
      liveConfiguration === pending.input.baseline_configuration_sha256
    const atSelected =
      initial.revision === pending.input.revision &&
      liveConfiguration === pending.input.configuration_sha256
    if (!atBaseline && !atSelected)
      return yield* Effect.fail(
        conflict("Current Source configuration changed during its unfinished synchronization."),
      )
    if (pending.phase === "content") {
      const prepared =
        preparedInput ??
        (yield* provider.prepare(pending.input.declaration, {
          exactCommit: pending.input.resolved_commit,
          metrics: api.metrics,
        }))
      if (
        prepared.configuration_sha256 !== pending.input.configuration_sha256 ||
        prepared.resolved_commit !== pending.input.resolved_commit ||
        prepared.prepared_source.revision !== pending.input.revision
      )
        return yield* Effect.fail(conflict("Recovery did not reproduce the frozen Source input."))
      const verifyOnly = preparedInput === undefined && owners.parent === undefined && atSelected
      if (verifyOnly) yield* verifyRetirements(library, pending)
      const written = yield* writePreparedCurrentSource(library, {
        operation_id: pending.input.operation_id,
        prepared,
        mode: owners.parent === undefined ? "apply" : "resume",
        verify_only: verifyOnly,
      })
      if (written.status === "inspected" || written.source_page_id !== pending.input.source_page_id)
        return yield* Effect.fail(
          conflict("Synchronization did not publish its exact Source page."),
        )
      const targets = written.targets.flatMap((target) =>
        target.status === "removed" ? [] : [{ skill_id: target.skill_id, page_id: target.page_id }],
      )
      pending = { ...pending, phase: "projection", targets, next_index: 0 }
      progress.content = { status: "published", ...selection(pending.input) }
      yield* store.writeJson(pendingKey(pending.scope), pending)
    }
    const latest = yield* queryCurrentSourceManagement(library, sourceId(initial))
    if (
      latest === undefined ||
      latest.page_id !== pending.input.source_page_id ||
      latest.revision !== pending.input.revision ||
      (yield* currentSourceConfigurationFingerprint(latest.declaration)) !==
        pending.input.configuration_sha256
    )
      return yield* Effect.fail(conflict("Published Source changed before reading projection."))
    const checkedOwners = yield* pendingOwners(library, latest, pending)
    if (
      pending.targets.some(
        (target) => checkedOwners.pages.get(target.skill_id)?.page_id !== target.page_id,
      )
    )
      return yield* Effect.fail(
        conflict("A published target changed physical identity before projection."),
      )
    if (pending.input.projection === "markdown") {
      const skill_ids = pending.targets.map((target) => target.skill_id)
      const complete = pending.targets.slice(0, pending.next_index).map((target) => target.skill_id)
      progress.projection = { status: "pending", skill_ids, completed_skill_ids: complete }
      for (let index = pending.next_index; index < pending.targets.length; index++) {
        const target = pending.targets[index]!
        const operation_id = yield* projectionOperation(pending.input.operation_id, target.skill_id)
        const active = yield* readCurrentOperationIntent(library, {
          kind: "skill",
          id: target.skill_id,
        })
        if (
          active !== undefined &&
          (!("projection" in active.intent) || active.intent.operation_id !== operation_id)
        )
          return yield* Effect.fail(
            conflict("A different intent owns the selected projection.", {
              skill_id: target.skill_id,
            }),
          )
        yield* projectCurrentSkill(library, {
          target: target.page_id,
          operation_id,
          mode: active === undefined ? "apply" : "resume",
        })
        const next: Extract<CurrentSourceSyncPending, { phase: "projection" }> = {
          ...pending,
          next_index: index + 1,
        }
        yield* store.writeJson(pendingKey(next.scope), next)
        pending = next
        complete.push(target.skill_id)
      }
      progress.projection = { status: "complete", skill_ids }
    }
    const item = {
      source_id: sourceId(initial),
      ...progress,
      status: preparedInput === undefined ? "reconciled" : "applied",
      retryable: false,
      error: null,
    } satisfies CurrentSourceSyncItem
    yield* store.writeJson(observationKey(pending.scope), {
      version: 1,
      scope: pending.scope,
      source_id: sourceId(initial),
      source_page_id: pending.input.source_page_id,
      ...selection(pending.input),
      completed_at: yield* Clock.currentTimeMillis,
      projection: pending.input.projection,
    })
    yield* checkpointSourceCompletion(library, pending, item)
    yield* store.retireKeys([pendingKey(pending.scope)])
    return item
  })
}

function processSource(
  library: SharedLibrary,
  current: CurrentSourceManagement,
  command: CurrentSourceSyncCommand,
  scope: string,
  accessScope: string,
  batch: CurrentSourceCheckBatch,
  otherPending: readonly CurrentSourceSyncPending[],
  progress: Progress,
  fullBatch?: CurrentSourceSyncBatchReference,
) {
  return Effect.gen(function* () {
    const store = yield* Store,
      provider = yield* CurrentSourceSyncProvider
    const pending = yield* store.readJson(pendingKey(scope), CurrentSourceSyncPendingSchema)
    if (
      otherPending.some(
        (record) => record.scope !== scope && record.input.source_page_id === current.page_id,
      )
    )
      return yield* Effect.fail(
        conflict("Another credential scope has unfinished synchronization for this Source."),
      )
    if (pending !== undefined) {
      if (!preservesSharedLibraryBindings(pending.library, library))
        return yield* Effect.fail(
          conflict("The Source synchronization retains different physical Library bindings."),
        )
      progress.operation_id = pending.input.operation_id
      progress.content = {
        status: pending.phase === "projection" ? "published" : "observed",
        ...selection(pending.input),
      }
      if (command.action === "check")
        return yield* Effect.fail(
          conflict("A read-only check cannot recover an unfinished synchronization.", {
            operation_id: pending.input.operation_id,
          }),
        )
      if (
        pending.manager_id !== command.manager_id ||
        pending.execution_id !== command.execution_id
      )
        return yield* Effect.fail(
          conflict(
            "Resume with the original manager and execution generation before changing the workflow.",
            {
              manager_id: pending.manager_id,
              execution_id: pending.execution_id,
              operation_id: pending.input.operation_id,
            },
          ),
        )
      if (pending.input.declaration.definition.source_id !== sourceId(current))
        return yield* Effect.fail(
          conflict("Frozen Source identity differs from the selected scope."),
        )
      if (pending.full_batch !== undefined) {
        const parent = yield* store.readJson(
          currentSourceSyncBatchKey(pending.full_batch.scope),
          CurrentSourceSyncBatchSchema,
        )
        const completed = yield* checked(() => completedBatchChild(library, pending, parent))
        if (completed !== undefined) {
          progress.content = completed.content
          progress.projection = completed.projection
          yield* store.retireKeys([pendingKey(pending.scope)])
          return { ...completed, status: "reconciled" } satisfies CurrentSourceSyncItem
        }
      }
      return yield* continueOwned(library, current, pending, progress)
    }
    yield* pendingOwners(library, current)
    const observed = yield* provider.check(library, { current, scope: accessScope, batch })
    if (observed.status === "skipped")
      return {
        source_id: sourceId(current),
        ...progress,
        status: "skipped",
        reason: observed.reason,
        retryable: false,
        error: null,
      } satisfies CurrentSourceSyncItem
    progress.content = {
      status: "observed",
      configuration_sha256: observed.configuration_sha256,
      resolved_commit: observed.observation.resolved_commit,
      revision: null,
    }
    if (command.action === "check")
      return {
        source_id: sourceId(current),
        ...progress,
        status: observed.status,
        retryable: false,
        error: null,
      } satisfies CurrentSourceSyncItem
    const previous = yield* store.readJson(
      observationKey(scope),
      CurrentSourceSyncObservationSchema,
    )
    if (
      command.mode === "changed" &&
      observed.status === "upstream_unchanged" &&
      previous?.scope === scope &&
      previous.source_page_id === current.page_id &&
      previous.source_id === sourceId(current) &&
      previous.configuration_sha256 === observed.configuration_sha256 &&
      previous.resolved_commit === observed.observation.resolved_commit &&
      previous.revision === current.revision &&
      (command.projection === "none" || previous.projection === "markdown")
    ) {
      yield* pendingOwners(library, current)
      return {
        source_id: sourceId(current),
        ...progress,
        status: "upstream_unchanged",
        retryable: false,
        error: null,
      } satisfies CurrentSourceSyncItem
    }
    const prepared = yield* provider.prepare(current.declaration, {
      exactCommit: observed.observation.resolved_commit,
      metrics: (yield* Notion).metrics,
    })
    const operation_id = `source-sync-${yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(Effect.mapError(() => fail("CRYPTO_ERROR", "Cannot identify Source synchronization.")))}`
    const preview = yield* writePreparedCurrentSource(library, {
      prepared,
      operation_id,
      dry_run: true,
    })
    if (preview.status !== "inspected" || preview.source_page_id !== current.page_id)
      return yield* Effect.fail(
        conflict("Source sync inspection changed the selected physical identity."),
      )
    const live = yield* queryCurrentSourceManagement(library, sourceId(current))
    if (
      live === undefined ||
      live.page_id !== current.page_id ||
      live.revision !== current.revision ||
      (yield* currentSourceConfigurationFingerprint(live.declaration)) !==
        observed.current_configuration_sha256
    )
      return yield* Effect.fail(
        conflict("Source configuration changed after the upstream observation."),
      )
    yield* pendingOwners(library, live)
    const frozen: CurrentSourceSyncPending = {
      version: 2,
      library: structuredClone(library),
      kind: "current_source_sync",
      scope,
      manager_id: command.manager_id,
      execution_id: command.execution_id,
      ...(fullBatch === undefined ? {} : { full_batch: fullBatch }),
      phase: "content",
      input: {
        operation_id,
        declaration: prepared.declaration,
        configuration_sha256: prepared.configuration_sha256,
        resolved_commit: prepared.resolved_commit,
        revision: prepared.prepared_source.revision,
        source_page_id: current.page_id,
        baseline_revision: current.revision,
        baseline_configuration_sha256: observed.current_configuration_sha256,
        affected_skill_ids: preview.affected_skill_ids,
        retirements: preview.targets.flatMap((target) =>
          "action" in target && target.action === "retire" && target.page_id !== null
            ? [{ skill_id: target.skill_id, page_id: target.page_id }]
            : [],
        ),
        projection: command.projection ?? "none",
      },
    }
    yield* store.writeJson(pendingKey(scope), frozen)
    return yield* continueOwned(library, live, frozen, progress, prepared)
  })
}

const safeRetryCodes = new Set([
  "SYNC_LOCKED",
  "STATE_BUSY",
  "REQUEST_BUDGET_EXHAUSTED",
  "NOTION_UNAVAILABLE",
  "RATE_LIMITED",
])
function failureItem(
  source_id: string,
  error: SkillsError,
  progress: Progress,
  notStarted = false,
): CurrentSourceSyncItem {
  const retryable = safeRetryCodes.has(error.code)
  const detail = {
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
  }
  if (retryable)
    return {
      source_id,
      ...progress,
      status: notStarted ? "not_started" : "pending",
      retryable: true,
      error: detail,
    }
  const blocked = /PENDING|CONFLICT|UNKNOWN|UNRESOLVED|AUTH|ACCESS|STATE_CORRUPT/u.test(error.code)
  return {
    source_id,
    ...progress,
    status: notStarted ? "not_started" : blocked ? "blocked" : "failed",
    retryable: false,
    error: detail,
  }
}
const initialProgress = (): Progress => ({
  operation_id: null,
  content: { status: "not_started" },
  projection: { status: "not_started" },
})
function overall(results: readonly CurrentSourceSyncItem[]): CurrentSourceSyncResult["status"] {
  const failed = results.filter((item) => item.error !== null)
  if (failed.length === 0) return "complete"
  if (failed.every((item) => item.retryable)) return "retryable"
  if (failed.length < results.length) return "partial"
  return failed.some((item) => item.status === "blocked") ? "blocked" : "failed"
}

function executeBatch(library: SharedLibrary, command: CurrentSourceSyncCommand) {
  return Effect.gen(function* () {
    const api = yield* Notion,
      store = yield* Store
    const accessScope = yield* sha256(
      canonicalSharedJson([
        api.apiOrigin ?? "https://api.notion.com",
        yield* api.credentialIdentity,
        library.library_id,
      ]),
    )
    const batch = yield* makeCurrentSourceCheckBatch()
    let durablePrefix: readonly CurrentSourceSyncItem[] = []
    let interruptedSource: string | undefined
    const body = Effect.gen(function* () {
      let fullBatch: CurrentSourceSyncBatch | undefined
      if (command.action === "sync") {
        const scope = yield* sha256(canonicalSharedJson([accessScope, command.manager_id]))
        for (const key of yield* store.listKeys("operations/current-source-sync-batch/")) {
          const record = yield* store.readJson(key, CurrentSourceSyncBatchSchema)
          if (
            record !== undefined &&
            record.library_id === library.library_id &&
            record.manager_id === command.manager_id &&
            (record.scope !== scope ||
              record.execution_id !== command.execution_id ||
              !preservesSharedLibraryBindings(record.library, library))
          )
            return yield* Effect.fail(
              conflict(
                "Finish the full Source batch with its original credential scope and execution generation.",
              ),
            )
        }
        if (command.mode === "full") {
          const identity = {
            scope,
            library: structuredClone(library),
            library_id: library.library_id,
            sources_data_source_id: library.sources.data_source_id,
            manager_id: command.manager_id,
            execution_id: command.execution_id,
            source_ids: command.source_ids,
            projection: command.projection ?? "none",
          }
          fullBatch = yield* store.readJson(
            currentSourceSyncBatchKey(scope),
            CurrentSourceSyncBatchSchema,
          )
          if (fullBatch !== undefined && !matchesCurrentSourceSyncBatch(fullBatch, identity))
            return yield* Effect.fail(
              conflict(
                "Resume the unfinished full Source batch with its original selection and projection.",
              ),
            )
          if (fullBatch === undefined) {
            const batch_id = yield* (yield* Crypto.Crypto)
              .randomUUIDv4()
              .pipe(
                Effect.mapError(() =>
                  fail("CRYPTO_ERROR", "Cannot identify the full Source batch."),
                ),
              )
            const started_at = yield* Clock.currentTimeMillis
            fullBatch = yield* checked(() =>
              makeCurrentSourceSyncBatch({ ...identity, batch_id, started_at }),
            )
            yield* store.writeJson(currentSourceSyncBatchKey(scope), fullBatch)
          }
          durablePrefix = fullBatch.results
        }
      }
      const otherPending: CurrentSourceSyncPending[] = []
      for (const key of yield* store.listKeys("operations/current-source-sync/")) {
        const record = yield* store.readJson(key, CurrentSourceSyncPendingSchema)
        if (record === undefined) continue
        if (fullBatch !== undefined) {
          interruptedSource = record.input.declaration.definition.source_id
          const completed = yield* checked(() => completedBatchChild(library, record, fullBatch))
          if (completed !== undefined) {
            const expectedScope = yield* sha256(
              canonicalSharedJson([accessScope, completed.source_id]),
            )
            if (record.scope !== expectedScope)
              return yield* Effect.fail(
                conflict("A completed Source child changed its credential scope."),
              )
            yield* store.retireKeys([key])
            interruptedSource = undefined
            continue
          }
          interruptedSource = undefined
        }
        otherPending.push(record)
      }
      if (fullBatch !== undefined && fullBatch.results.length === command.source_ids.length) {
        yield* store.retireKeys([currentSourceSyncBatchKey(fullBatch.scope)])
        return [...durablePrefix]
      }
      const remaining = command.source_ids.slice(durablePrefix.length)
      const sources = yield* queryCurrentSourceManagementBatch(library, remaining)
      const results: CurrentSourceSyncItem[] = [...durablePrefix]
      let stopped: SkillsError | undefined
      let keepBatch = false
      for (const id of remaining) {
        const progress = initialProgress()
        if (stopped !== undefined) {
          results.push(failureItem(id, stopped, progress, true))
          continue
        }
        const source = sources.get(id)
        const outcome = yield* (
          source === undefined
            ? Effect.fail(
                fail("CURRENT_SOURCE_NOT_FOUND", "The explicitly selected Source does not exist.", {
                  source_id: id,
                }),
              )
            : Effect.gen(function* () {
                yield* (yield* RequestBudget).check
                return yield* processSource(
                  library,
                  source,
                  command,
                  yield* sha256(canonicalSharedJson([accessScope, id])),
                  accessScope,
                  batch,
                  otherPending,
                  progress,
                  fullBatch === undefined ? undefined : currentSourceSyncBatchReference(fullBatch),
                )
              })
        ).pipe(Effect.result)
        let item =
          outcome._tag === "Success" ? outcome.success : failureItem(id, outcome.failure, progress)
        if (fullBatch !== undefined) {
          const before = fullBatch
          const refreshed = yield* Effect.gen(function* () {
            const saved = yield* store.readJson(
              currentSourceSyncBatchKey(before.scope),
              CurrentSourceSyncBatchSchema,
            )
            if (saved === undefined || !preservesCurrentSourceSyncBatch(before, saved))
              return yield* Effect.fail(
                conflict("The active full batch changed during Source processing."),
              )
            return saved
          }).pipe(Effect.result)
          if (refreshed._tag === "Failure") {
            results.push(failureItem(id, refreshed.failure, progress))
            stopped = refreshed.failure
            keepBatch = true
            continue
          }
          const saved = refreshed.success
          const advancedByChild = saved.results.length === fullBatch.results.length + 1
          fullBatch = saved
          durablePrefix = saved.results
          if (advancedByChild) {
            if (outcome._tag === "Success") item = saved.results[saved.results.length - 1]!
            else {
              // Remote work is complete, but its local child still needs cleanup.
              // Keep that error visible and retain the batch until a later retry.
              stopped = outcome.failure
              keepBatch = true
            }
          } else if (isCurrentSourceSyncBatchTerminal(item)) {
            const currentBatch = fullBatch
            const checkpoint = yield* Effect.gen(function* () {
              const next = yield* checked(() =>
                appendCurrentSourceSyncBatchResult(currentBatch, item),
              )
              yield* store.writeJson(currentSourceSyncBatchKey(next.scope), next)
              return next
            }).pipe(Effect.result)
            if (checkpoint._tag === "Failure") {
              results.push(failureItem(id, checkpoint.failure, progress))
              stopped = checkpoint.failure
              continue
            }
            fullBatch = checkpoint.success
            durablePrefix = fullBatch.results
          } else {
            stopped =
              outcome._tag === "Failure"
                ? outcome.failure
                : fail("STATE_CORRUPT", "A full Source batch returned a nonterminal success.")
          }
        }
        results.push(item)
        if (outcome._tag === "Failure") {
          if (
            [
              "REQUEST_BUDGET_EXHAUSTED",
              "AUTH_REQUIRED",
              "ACCESS_DENIED",
              "NOTION_UNAVAILABLE",
              "RATE_LIMITED",
            ].includes(outcome.failure.code)
          )
            stopped = outcome.failure
        }
      }
      if (
        fullBatch !== undefined &&
        !keepBatch &&
        fullBatch.results.length === command.source_ids.length
      )
        yield* store.retireKeys([currentSourceSyncBatchKey(fullBatch.scope)])
      return results
    })
    const outcome = yield* (
      command.action === "sync"
        ? withLocalLocks(
            store.root,
            [
              `current-source-sync:${api.apiOrigin ?? "https://api.notion.com"}:${library.sources.data_source_id}`,
            ],
            body,
          )
        : body
    ).pipe(Effect.result)
    if (outcome._tag === "Success") return outcome.success
    const results = [
      ...durablePrefix,
      ...command.source_ids
        .slice(durablePrefix.length)
        .map((id) => failureItem(id, outcome.failure, initialProgress(), true)),
    ]
    const interruptedIndex = durablePrefix.findIndex((item) => item.source_id === interruptedSource)
    const index =
      interruptedIndex >= 0
        ? interruptedIndex
        : durablePrefix.length === command.source_ids.length
          ? durablePrefix.findLastIndex((item) => item.error === null)
          : -1
    if (index >= 0 && results[index]!.error === null) {
      const completed = results[index]!
      results[index] = failureItem(completed.source_id, outcome.failure, {
        operation_id: completed.operation_id,
        content: completed.content,
        projection: completed.projection,
      })
    }
    return results
  })
}

function report<R>(
  library: Effect.Effect<SharedLibrary, SkillsError, R>,
  input: CurrentSourceSyncCommand,
) {
  return Effect.gen(function* () {
    const command = yield* checked(() => validateCurrentSourceSyncCommand(input))
    const value = yield* withCurrentInvocationBudget(
      Effect.gen(function* () {
        const selected = yield* library
        const results = yield* executeBatch(selected, command)
        return {
          library_id: selected.library_id,
          results,
          request_metrics: (yield* Notion).requestMetrics?.() ?? null,
        }
      }),
      command.limits,
    )
    return {
      version: 1,
      kind: "current_source_sync",
      action: command.action,
      status: overall(value.result.results),
      ...value.result,
      budget: value.budget,
    } satisfies CurrentSourceSyncResult
  })
}

/** One library discovery, one budget and one cooperative Store lock for the batch. */
export function runCurrentSourceSync(entry: string, command: CurrentSourceSyncCommand) {
  return report(libraryId(entry).pipe(Effect.flatMap(loadSharedLibrary)), command)
}
export function checkCurrentSources(library: SharedLibrary, input: CurrentSourceCheckRequest) {
  return report(Effect.succeed(library), { ...input, action: "check" })
}
export function syncCurrentSources(library: SharedLibrary, input: CurrentSourceSyncRequest) {
  return report(Effect.succeed(library), { ...input, action: "sync" })
}
