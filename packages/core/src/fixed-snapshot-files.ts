import { Effect, Schema } from "effect"
import {
  assertKnownSnapshotAccess,
  invalidateScopeCache,
  invalidateSnapshotCache,
  validateSnapshot,
  validateSnapshotManifest,
} from "./cache.ts"
import {
  fail,
  property,
  SHARED_ACQUISITION_VERSION,
  SkillsError,
  SnapshotSchema,
  type Snapshot,
} from "./model.ts"
import { materializeSharedFixedAcquisition } from "./shared-fixed-acquisition.ts"
import { sha256, Store } from "./store.ts"

const checked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("STATE_CORRUPT", "Invalid fixed snapshot selection."),
  })

function readSnapshotManifest(id: string) {
  return Effect.gen(function* () {
    if (!/^s_[a-f0-9]{64}$/.test(id))
      return yield* Effect.fail(fail("INVALID_SNAPSHOT", "Invalid snapshot ID."))
    const store = yield* Store
    const stored = yield* store.readJson(`snapshots/${id}.json`, Schema.Unknown)
    if (stored === undefined)
      return yield* Effect.fail(
        fail(
          "SNAPSHOT_MISSING",
          "This selection is no longer cached. Read the current Skill again.",
          {
            snapshot_id: id,
            next: "reselect_current",
          },
        ),
      )
    const acquisition = property(property(stored).shared_acquisition)
    if (Number.isInteger(acquisition.version) && acquisition.version !== SHARED_ACQUISITION_VERSION)
      return yield* Effect.fail(
        fail(
          "SNAPSHOT_MISSING",
          "This selection uses an obsolete acquisition contract. Read the current Skill again.",
          {
            snapshot_id: id,
            reason: "incompatible_acquisition",
            next: "reselect_current",
          },
        ),
      )
    const snapshot = yield* checked(() =>
      Schema.decodeUnknownSync(SnapshotSchema)(stored, { onExcessProperty: "error" }),
    )
    if (snapshot.snapshot_id !== id || snapshot.files.some((f) => !/^[a-f0-9]{64}$/.test(f.sha256)))
      return yield* Effect.fail(fail("STATE_CORRUPT", "The snapshot manifest is invalid."))
    return snapshot
  })
}

/** Read the complete fixed directory without implying every object is local. */
export function loadSnapshotManifest(id: string) {
  return readSnapshotManifest(id).pipe(Effect.flatMap(validateSnapshotManifest))
}

export function loadSnapshot(id: string) {
  return readSnapshotManifest(id).pipe(Effect.flatMap(validateSnapshot))
}

function selectedPaths(snapshot: Snapshot, select: (snapshot: Snapshot) => readonly string[]) {
  const paths = [...select(snapshot)]
  if (
    new Set(paths).size !== paths.length ||
    paths.some((path) => !snapshot.files.some((file) => file.path === path))
  )
    throw fail("FILE_NOT_FOUND", "The fixed snapshot does not contain the selected file set.")
  return paths
}

/** Admit the current local selection, then verify only its requested bytes.
 * Only declared current acquisition routes may fetch missing bytes. There is no
 * remote history recovery when a selection or an authored object is gone. */
export function openFixedSnapshotFiles(
  fixed: string | Snapshot,
  select: (snapshot: Snapshot) => readonly string[],
  options: { readonly offline?: boolean } = {},
) {
  return Effect.gen(function* () {
    const snapshot = yield* typeof fixed === "string"
      ? loadSnapshotManifest(fixed)
      : validateSnapshotManifest(fixed)
    const accessDenied = yield* assertKnownSnapshotAccess(snapshot, options.offline)
    const paths = yield* checked(() => selectedPaths(snapshot, select))
    const store = yield* Store
    const objects = new Map<string, Uint8Array>()
    const missingObjects = new Set<string>()
    const bytesByPath = new Map<string, Uint8Array>()
    const missing: string[] = []
    for (const path of paths) {
      const file = snapshot.files.find((entry) => entry.path === path)!
      if (missingObjects.has(file.sha256)) {
        missing.push(path)
        continue
      }
      let bytes = objects.get(file.sha256)
      if (bytes === undefined) {
        const cached = yield* store.readBytes(`objects/${file.sha256}`).pipe(Effect.result)
        if (cached._tag === "Failure") {
          if (cached.failure.code !== "SNAPSHOT_MISSING") return yield* Effect.fail(cached.failure)
          missingObjects.add(file.sha256)
          missing.push(path)
          continue
        }
        bytes = cached.success
        if ((yield* sha256(bytes)) !== file.sha256)
          return yield* Effect.fail(
            fail("STATE_CORRUPT", "A selected fixed file failed its checksum.", { path }),
          )
        objects.set(file.sha256, bytes)
      }
      if (bytes.length !== file.bytes)
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "A selected fixed file has an incorrect byte length.", { path }),
        )
      bytesByPath.set(path, bytes)
    }
    if (missing.length && snapshot.shared_acquisition !== undefined) {
      const acquired = yield* materializeSharedFixedAcquisition(snapshot, missing, options).pipe(
        Effect.tapError((error) => {
          if (error.code === "AUTH_REQUIRED") return invalidateScopeCache(snapshot.scope)
          if (
            ![
              "ACCESS_DENIED",
              "NOT_FOUND",
              "CONTENT_DISABLED",
              "SKILL_DISABLED",
              "SOURCE_DISABLED",
              "CURRENT_OPERATION_PENDING",
              "CURRENT_SKILL_NOT_READY",
              "CURRENT_SCHEMA_REQUIRED",
              "CURRENT_INDEX_INVALID",
              "CURRENT_SOURCE_NOT_READY",
              "SHARED_ACQUISITION_CHANGED",
              "SHARED_SOURCE_CONFLICT",
              "SHARED_SOURCE_MISSING",
              "SHARED_RESOURCE_CHANGED",
              "SHARED_RESOURCE_UNAVAILABLE",
            ].includes(error.code)
          )
            return Effect.void
          // A failed lazy read is also a current observation. Do not allow a
          // later TTL hit to forget a known removal, pending writer or denial.
          return invalidateSnapshotCache(snapshot.record.id, snapshot.scope, {
            retainForOffline: true,
            ...(error.code === "ACCESS_DENIED" ? { accessDenied: error.code } : {}),
          })
        }),
      )
      for (const file of acquired) bytesByPath.set(file.path, file.bytes)
    }
    const stillMissing = missing.filter((path) => !bytesByPath.has(path))
    if (stillMissing.length)
      return yield* Effect.fail(
        fail(
          "SNAPSHOT_MISSING",
          "Selected content is no longer available. Read the current Skill again.",
          {
            snapshot_id: snapshot.snapshot_id,
            paths: stillMissing,
            target: snapshot.record.id,
            next: "reselect_current",
          },
        ),
      )
    const files = yield* checked(() =>
      paths.map((path) => {
        const bytes = bytesByPath.get(path)
        if (bytes === undefined)
          throw fail("STATE_CORRUPT", "A selected fixed file was not materialized.", { path })
        return { path, bytes }
      }),
    )
    return { snapshot, files, access_denied: accessDenied }
  })
}
