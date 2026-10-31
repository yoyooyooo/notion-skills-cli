import { Clock, Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { validateSnapshot } from "./cache.ts"
import { localContentRestrictedHashes } from "./content-restrictions.ts"
import {
  decode,
  fail,
  property,
  SkillsError,
  SnapshotSchema,
  type ContentRecord,
  type Snapshot,
  type Source,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { sharedRecordFromPage, validateSharedRecordIdentity } from "./shared-content.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import { SharedLibrarySchema, type SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import {
  prepareSharedSnapshotHistory,
  retainSharedSnapshotHistory,
  restoreSharedSnapshotHistory,
  SharedSnapshotHistoryPlanSchema,
  validateSharedSnapshotHistoryPlan,
  type SharedSnapshotHistoryPlan,
  type SharedSnapshotManifest,
  type SharedSnapshotRetention,
} from "./shared-snapshot-history.ts"
import { snapshotInfo } from "./snapshot.ts"
import { sha256, Store } from "./store.ts"

const PendingHistorySchema = Schema.Struct({
  version: Schema.Literal(1),
  scope: Schema.String,
  library_id: Schema.String,
  skill_page_id: Schema.String,
  snapshot_id: Schema.String,
  plan: SharedSnapshotHistoryPlanSchema,
})
type PendingHistory = typeof PendingHistorySchema.Type
type HistoryMode = "create" | "reconcile"

function checked<A>(action: () => A): Effect.Effect<A, SkillsError> {
  return Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_HISTORY_INVALID", "The selected shared history is invalid."),
  })
}

function assertSharedIdentity(current: ContentRecord, frozen: ContentRecord): void {
  validateSharedRecordIdentity(frozen)
  if (
    current.locator.type !== "shared_skill" ||
    frozen.locator.type !== "shared_skill" ||
    current.id !== frozen.id ||
    canonicalSharedJson(current.locator) !== canonicalSharedJson(frozen.locator)
  )
    throw fail(
      "SHARED_HISTORY_SCOPE",
      "The frozen history does not belong to the current exact Skill and library binding.",
    )
}

function currentSharedSkill(library: SharedLibrary, skillPageId: string) {
  return Effect.gen(function* () {
    if (pageId(skillPageId) !== skillPageId)
      return yield* Effect.fail(
        fail("SHARED_HISTORY_SCOPE", "History requires a canonical exact Skill page ID."),
      )
    const registered = yield* loadSharedLibrary(library.skills.database_id)
    if (canonicalSharedJson(registered) !== canonicalSharedJson(library))
      return yield* Effect.fail(
        fail(
          "SHARED_HISTORY_SCOPE",
          "The current registered library differs from the selected descriptor.",
        ),
      )
    const raw = yield* (yield* Notion).request(`v1/pages/${skillPageId}`)
    const source: Source = {
      alias: library.library_id,
      title: "",
      role: "content",
      database_id: library.skills.database_id,
      data_source_ids: [library.skills.data_source_id],
      shared_library: library,
    }
    const record = yield* checked(() =>
      sharedRecordFromPage(raw, source, library.skills.data_source_id),
    )
    if (record.locator.page_id !== skillPageId)
      return yield* Effect.fail(
        fail("SHARED_HISTORY_SCOPE", "The returned Skill differs from the requested exact page."),
      )
    // Enabled governs current consumption; explicit history remains readable
    // while the authenticated caller can still access this exact binding.
    return record
  })
}

function frozenTree(value: Snapshot | SharedSnapshotManifest) {
  return canonicalSharedJson({
    record: value.record,
    entrypoint: value.entrypoint,
    version_id: value.version_id,
    files: [...value.files]
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      .map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
  })
}

const journalPrefix = (scope: string) => `operations/shared-snapshot-history/${scope}/`
const journalKey = (scope: string, pinId: string) => `${journalPrefix(scope)}${pinId}.json`

function originalPendingHistory(library: SharedLibrary, snapshot: Snapshot) {
  return Effect.gen(function* () {
    const store = yield* Store
    let selected: { readonly key: string; readonly value: PendingHistory } | undefined
    for (const key of yield* store.listKeys(journalPrefix(snapshot.scope))) {
      if (!key.endsWith(".json")) continue
      const entry = yield* store.readJson(key, PendingHistorySchema)
      if (entry === undefined) continue
      if (entry.scope !== snapshot.scope || key !== journalKey(entry.scope, entry.plan.pin_id))
        return yield* Effect.fail(
          fail(
            "STATE_CORRUPT",
            "The frozen history journal has a different scope or pin identity.",
          ),
        )
      if (entry.snapshot_id !== snapshot.snapshot_id) continue
      const plan = yield* validateSharedSnapshotHistoryPlan(library, entry.plan)
      if (
        entry.library_id !== library.library_id ||
        entry.skill_page_id !== plan.manifest.skill_page_id ||
        frozenTree(snapshot) !== frozenTree(plan.manifest)
      )
        return yield* Effect.fail(
          fail(
            "SHARED_HISTORY_SCOPE",
            "The requested snapshot differs from its original pending history plan; preserve the original plan.",
          ),
        )
      if (selected !== undefined)
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "One local snapshot has multiple pending history identities."),
        )
      selected = { key, value: { ...entry, plan } }
    }
    return selected
  })
}

function historyResult(snapshot: Snapshot, retained: SharedSnapshotRetention, mode: HistoryMode) {
  return {
    ...snapshotInfo(snapshot),
    shared_pin: retained.pin_id,
    verification: retained.verification,
    mode: retained.verification === "manifest" ? ("reconcile" as const) : mode,
  }
}

function recoveryError(
  error: SkillsError,
  snapshot: Snapshot,
  plan: SharedSnapshotHistoryPlan,
  key?: string,
) {
  return fail(error.code, error.message, {
    ...property(error.details),
    shared_pin: plan.pin_id,
    snapshot_id: snapshot.snapshot_id,
    next_mode: "reconcile",
    ...(key === undefined ? {} : { pending_journal: key }),
  })
}

/** Archive exact local bytes once. A saved dispatch plan always overrides a new create request. */
export function archiveSharedHistory(
  libraryInput: SharedLibrary,
  snapshotInput: Snapshot,
  options: {
    readonly mode?: HistoryMode
    /** Authorizes this exact archive only; durable object restrictions remain in place. */
    readonly allowLocalArchive?: boolean
  } = {},
) {
  return Effect.gen(function* () {
    const library = yield* checked(() => decode(SharedLibrarySchema, structuredClone(libraryInput)))
    const snapshot = yield* checked(() => decode(SnapshotSchema, structuredClone(snapshotInput)))
    const mode = options.mode ?? "create"
    if (mode !== "create" && mode !== "reconcile")
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "History mode must be create or reconcile."),
      )
    const scope = yield* authScope
    const locator = snapshot.record.locator
    if (
      snapshot.scope !== scope ||
      locator.type !== "shared_skill" ||
      snapshot.historical_snapshot_id !== undefined ||
      !Number.isFinite(snapshot.created_at) ||
      snapshot.created_at < 0 ||
      !/^[a-f0-9]{64}$/u.test(snapshot.version_id) ||
      snapshot.snapshot_id !==
        `s_${yield* sha256(JSON.stringify([scope, snapshot.record.id, snapshot.version_id]))}`
    )
      return yield* Effect.fail(
        fail(
          "SHARED_HISTORY_SCOPE",
          "Archive requires a complete shared snapshot belonging to the currently authenticated scope.",
        ),
      )
    const current = yield* currentSharedSkill(library, locator.page_id)
    yield* checked(() => assertSharedIdentity(current, snapshot.record))
    const store = yield* Store
    const pending = yield* originalPendingHistory(library, snapshot)
    if (pending !== undefined) {
      const retained = yield* retainSharedSnapshotHistory(library, {
        plan: pending.value.plan,
        mode: "reconcile",
      }).pipe(
        Effect.mapError((error) => recoveryError(error, snapshot, pending.value.plan, pending.key)),
      )
      yield* store.retireKeys([pending.key])
      return historyResult(snapshot, retained, "reconcile")
    }
    // Preparation uses immutable local objects. It never reads current bodies.
    const plan = yield* prepareSharedSnapshotHistory(library, snapshot)
    const completed = yield* retainSharedSnapshotHistory(library, { plan, mode: "reconcile" }).pipe(
      Effect.result,
    )
    if (completed._tag === "Success") return historyResult(snapshot, completed.success, "reconcile")
    if (completed.failure.code !== "SHARED_RECORD_UNRESOLVED" || mode === "reconcile")
      return yield* Effect.fail(recoveryError(completed.failure, snapshot, plan))

    const restricted = new Set(
      yield* localContentRestrictedHashes(snapshot.files.map((file) => file.sha256)),
    )
    if (restricted.size > 0 && options.allowLocalArchive !== true)
      return yield* Effect.fail(
        fail(
          "LOCAL_RESOURCE_ARCHIVE_REQUIRED",
          "This snapshot includes local resource bytes. Review the exact paths and use --allow-local-archive to authorize this one shared archive.",
          {
            snapshot_id: snapshot.snapshot_id,
            paths: snapshot.files
              .filter((file) => restricted.has(file.sha256))
              .map((file) => file.path),
          },
        ),
      )

    const key = journalKey(scope, plan.pin_id)
    const journal: PendingHistory = {
      version: 1,
      scope,
      library_id: library.library_id,
      skill_page_id: locator.page_id,
      snapshot_id: snapshot.snapshot_id,
      plan,
    }
    const previous = yield* store.readJson(key, PendingHistorySchema)
    if (previous !== undefined && canonicalSharedJson(previous) !== canonicalSharedJson(journal))
      return yield* Effect.fail(
        fail("STATE_CORRUPT", "The original history dispatch journal cannot be replaced."),
      )
    // This precedes every possible POST, and remains outside ordinary cache clearing.
    yield* store
      .writeJson(key, journal)
      .pipe(Effect.mapError((error) => recoveryError(error, snapshot, plan, key)))
    const retained = yield* retainSharedSnapshotHistory(library, { plan, mode: "create" }).pipe(
      Effect.mapError((error) => recoveryError(error, snapshot, plan, key)),
    )
    yield* store.retireKeys([key])
    return historyResult(snapshot, retained, "create")
  })
}

/** Restore an explicit shared pin under current access, without publishing a current-cache observation. */
export function restoreSharedHistory(
  libraryInput: SharedLibrary,
  input: {
    readonly skillPageId: string
    readonly pinId: string
  },
) {
  return Effect.gen(function* () {
    const library = yield* checked(() => decode(SharedLibrarySchema, structuredClone(libraryInput)))
    const selected = { skillPageId: input.skillPageId, pinId: input.pinId }
    if (
      pageId(selected.skillPageId) !== selected.skillPageId ||
      !/^snapshot-[a-f0-9]{64}$/u.test(selected.pinId)
    )
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Restore requires an exact Skill page and complete shared pin."),
      )
    const scope = yield* authScope
    const current = yield* currentSharedSkill(library, selected.skillPageId)
    const restored = yield* restoreSharedSnapshotHistory(library, {
      ...selected,
      expectedSkillId: current.locator.skill_id,
    })
    yield* checked(() => assertSharedIdentity(current, restored.manifest.record))
    const snapshotId = `s_${yield* sha256(JSON.stringify([scope, restored.manifest.record.id, restored.manifest.version_id]))}`
    const store = yield* Store
    const key = `snapshots/${snapshotId}.json`
    const saved = yield* store.readJson(key, SnapshotSchema)
    if (
      saved !== undefined &&
      (saved.snapshot_id !== snapshotId ||
        saved.scope !== scope ||
        saved.historical_snapshot_id !== undefined ||
        !Number.isFinite(saved.created_at) ||
        saved.created_at < 0 ||
        frozenTree(saved) !== frozenTree(restored.manifest))
    )
      return yield* Effect.fail(
        fail(
          "STATE_CORRUPT",
          "An existing immutable snapshot disagrees with the exact shared pin.",
        ),
      )
    const createdAt = saved?.created_at ?? (yield* Clock.currentTimeMillis)
    const snapshot =
      saved ??
      (yield* checked(() =>
        decode(SnapshotSchema, {
          snapshot_id: snapshotId,
          scope,
          record: restored.manifest.record,
          entrypoint: restored.manifest.entrypoint,
          version_id: restored.manifest.version_id,
          created_at: createdAt,
          files: restored.manifest.files.map((file) => ({
            path: file.path,
            sha256: file.sha256,
            bytes: file.bytes,
          })),
        }),
      ))
    const files = new Map(restored.files.map((file) => [file.path, file.bytes]))
    for (const file of snapshot.files) {
      const bytes = files.get(file.path)
      if (
        bytes === undefined ||
        bytes.byteLength !== file.bytes ||
        (yield* sha256(bytes)) !== file.sha256
      )
        return yield* Effect.fail(
          fail(
            "SHARED_HISTORY_INVALID",
            "Restored bytes do not cover the complete fixed snapshot.",
          ),
        )
      yield* store.writeBytes(`objects/${file.sha256}`, bytes)
    }
    yield* validateSnapshot(snapshot)
    if (saved === undefined) yield* store.writeJson(key, snapshot)
    return {
      ...snapshotInfo({ ...snapshot, source: "local_snapshot", freshness: { policy: "pinned" } }),
      shared_pin: restored.pin_id,
    }
  })
}
