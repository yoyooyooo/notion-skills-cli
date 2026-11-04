import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { locallySelectedScope, recordScope, type ObservedSnapshot } from "./cache.ts"
import { fail, SkillsError, SnapshotSchema, type Snapshot } from "./model.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import { SharedLibrarySchema, type SharedLibrary } from "./shared-library-model.ts"
import {
  assertSharedHistoryIdentity,
  cacheSharedHistoricalSnapshot,
  currentSharedHistorySkill,
  sharedHistoricalSnapshotManifest,
  sharedSnapshotFrozenTree,
} from "./shared-history-workflow.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import {
  materializeSharedSnapshotFiles,
  SharedSnapshotManifestSchema,
  validateSharedSnapshotManifest,
  type SharedSnapshotManifest,
} from "./shared-snapshot-history.ts"
import { sha256, Store } from "./store.ts"

const RetainedManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("retained_snapshot_manifest"),
  scope: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  pin_id: Schema.String.check(Schema.isPattern(/^snapshot-[a-f0-9]{64}$/u)),
  library: SharedLibrarySchema,
  manifest: SharedSnapshotManifestSchema,
  snapshot: SnapshotSchema,
})
type RetainedManifest = typeof RetainedManifestSchema.Type
const keyFor = (scope: string, snapshotId: string) =>
  `cache/shared-history-manifests/${scope}/${snapshotId}.json`
const checked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("STATE_CORRUPT", "Invalid retained snapshot manifest."),
  })
const libraryIdentity = (library: SharedLibrary) => [
  library.library_id,
  library.skills.database_id,
  library.skills.data_source_id,
  library.records.database_id,
  library.records.data_source_id,
]

function validateRetained(retained: RetainedManifest, scope: string, snapshotId: string) {
  return Effect.gen(function* () {
    yield* validateSharedSnapshotManifest(
      retained.library,
      retained.manifest,
      retained.pin_id,
      retained.manifest.skill_page_id,
    )
    if (
      retained.scope !== scope ||
      retained.snapshot.scope !== scope ||
      retained.snapshot.snapshot_id !== snapshotId ||
      snapshotId !==
        `s_${yield* sha256(JSON.stringify([scope, retained.manifest.record.id, retained.manifest.version_id]))}` ||
      retained.snapshot.historical_snapshot_id !== undefined ||
      sharedSnapshotFrozenTree(retained.snapshot) !== sharedSnapshotFrozenTree(retained.manifest)
    )
      return yield* Effect.fail(
        fail(
          "STATE_CORRUPT",
          "A retained manifest does not match its exact scoped snapshot identity.",
        ),
      )
    return retained
  })
}

/** Call only after current library/Skill access and the remote pin have been verified. This
 * stores complete metadata separately from snapshots/, whose contract remains all bytes ready. */
export function registerRetainedSnapshot(
  scope: string,
  library: SharedLibrary,
  pinId: string,
  manifest: SharedSnapshotManifest,
) {
  return Effect.gen(function* () {
    const store = yield* Store
    const snapshot = yield* sharedHistoricalSnapshotManifest(scope, manifest)
    const key = keyFor(scope, snapshot.snapshot_id)
    const saved = yield* store.readJson(key, RetainedManifestSchema)
    if (saved !== undefined) {
      yield* validateRetained(saved, scope, snapshot.snapshot_id)
      if (
        saved.pin_id !== pinId ||
        canonicalSharedJson(saved.manifest) !== canonicalSharedJson(manifest) ||
        canonicalSharedJson(libraryIdentity(saved.library)) !==
          canonicalSharedJson(libraryIdentity(library))
      )
        return yield* Effect.fail(
          fail(
            "STATE_CORRUPT",
            "An immutable retained manifest cannot be replaced by another history.",
          ),
        )
      return saved
    }
    const retained: RetainedManifest = {
      version: 1,
      kind: "retained_snapshot_manifest",
      scope,
      library,
      pin_id: pinId,
      manifest,
      snapshot,
    }
    yield* validateRetained(retained, scope, snapshot.snapshot_id)
    yield* store.writeJson(key, retained)
    yield* recordScope(scope)
    return retained
  })
}

/** Missing objects are normal partial readiness; corrupt objects remain explicit failures. */
function availableFiles(snapshot: Snapshot) {
  return Effect.gen(function* () {
    const store = yield* Store
    const files: { path: string; bytes: Uint8Array }[] = []
    for (const file of snapshot.files) {
      const value = yield* store.readBytes(`objects/${file.sha256}`).pipe(Effect.result)
      if (value._tag === "Failure") {
        if (value.failure.code !== "SNAPSHOT_MISSING") return yield* Effect.fail(value.failure)
        continue
      }
      if (value.success.length !== file.bytes || (yield* sha256(value.success)) !== file.sha256)
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "A materialized historical file failed its exact checksum.", {
            path: file.path,
          }),
        )
      files.push({ path: file.path, bytes: value.success })
    }
    return files
  })
}

export function materializeRetainedSnapshot(
  retained: RetainedManifest,
  paths: readonly string[],
  options: { readonly offline?: boolean; readonly library?: SharedLibrary } = {},
) {
  return Effect.gen(function* () {
    yield* validateRetained(retained, retained.scope, retained.snapshot.snapshot_id)
    yield* materializeSharedSnapshotFiles(options.library ?? retained.library, {
      skillPageId: retained.manifest.skill_page_id,
      pinId: retained.pin_id,
      manifest: retained.manifest,
      paths,
      offline: options.offline,
    })
    const files = yield* availableFiles(retained.snapshot)
    const complete = files.length === retained.snapshot.files.length
    const snapshot = complete
      ? yield* cacheSharedHistoricalSnapshot(retained.scope, { manifest: retained.manifest, files })
      : retained.snapshot
    return {
      ...snapshot,
      source: "local_snapshot" as const,
      freshness: { policy: "pinned" as const },
      materialization: {
        manifest_complete: true as const,
        local_files_ready: complete,
        materialized_paths: files.map((file) => file.path),
        loaded: false as const,
      },
    } satisfies ObservedSnapshot
  })
}

/** A lazy pin is usable only in its selected authenticated scope. Remote byte acquisition
 * revalidates current access, then uses the exact immutable pin; current bodies are never read. */
function resolveRetainedSnapshot(snapshotId: string, options: { readonly offline?: boolean } = {}) {
  return Effect.gen(function* () {
    const store = yield* Store
    const keys = yield* store.listKeys("cache/shared-history-manifests")
    if (!keys.some((key) => key.endsWith(`/${snapshotId}.json`))) return undefined
    const scope = options.offline ? yield* locallySelectedScope(true) : yield* authScope
    if (scope === undefined) return undefined
    const retained = yield* store.readJson(keyFor(scope, snapshotId), RetainedManifestSchema)
    if (retained === undefined) return undefined
    yield* validateRetained(retained, scope, snapshotId)
    let library = retained.library
    if (!options.offline) {
      library = yield* loadSharedLibrary(retained.library.skills.database_id)
      if (
        canonicalSharedJson(libraryIdentity(library)) !==
        canonicalSharedJson(libraryIdentity(retained.library))
      )
        return yield* Effect.fail(
          fail(
            "SHARED_HISTORY_SCOPE",
            "The retained pin belongs to another library or Records table.",
          ),
        )
      const current = yield* currentSharedHistorySkill(library, retained.manifest.skill_page_id)
      yield* checked(() => assertSharedHistoryIdentity(current, retained.manifest.record))
    }
    return { retained, library }
  })
}

export function openRetainedSnapshot(
  snapshotId: string,
  select: (snapshot: Snapshot) => readonly string[],
  options: { readonly offline?: boolean } = {},
) {
  return Effect.gen(function* () {
    const opened = yield* resolveRetainedSnapshot(snapshotId, options)
    if (opened === undefined) return undefined
    const paths = yield* checked(() => select(opened.retained.snapshot))
    return yield* materializeRetainedSnapshot(opened.retained, paths, {
      offline: options.offline,
      library: opened.library,
    })
  })
}

/** One admitted immutable owner and one selected object set. Unselected objects are not read. */
export function openRetainedSnapshotFiles(
  snapshotId: string,
  select: (snapshot: Snapshot) => readonly string[],
  options: { readonly offline?: boolean } = {},
) {
  return Effect.gen(function* () {
    const opened = yield* resolveRetainedSnapshot(snapshotId, options)
    if (opened === undefined) return undefined
    const { retained, library } = opened
    const paths = yield* checked(() => select(retained.snapshot))
    const files = yield* materializeSharedSnapshotFiles(library, {
      skillPageId: retained.manifest.skill_page_id,
      pinId: retained.pin_id,
      manifest: retained.manifest,
      paths,
      offline: options.offline,
    })
    return { snapshot: retained.snapshot, files }
  })
}
