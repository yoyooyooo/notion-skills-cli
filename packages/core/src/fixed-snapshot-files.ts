import { Effect } from "effect"
import { assertKnownSnapshotAccess, validateSnapshot, validateSnapshotManifest } from "./cache.ts"
import { fail, SkillsError, SnapshotSchema, type Snapshot } from "./model.ts"
import { openRetainedSnapshotFiles } from "./shared-history-materialization.ts"
import { sharedSnapshotFrozenTree } from "./shared-history-workflow.ts"
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
    const snapshot = yield* store.readJson(`snapshots/${id}.json`, SnapshotSchema)
    if (!snapshot)
      return yield* Effect.fail(
        fail("SNAPSHOT_MISSING", "This snapshot has not been cached on this machine.", {
          snapshot_id: id,
        }),
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

/** Admit metadata first, then verify only the selected fixed bytes. Missing bytes may be
 * restored from the same retained pin; corruption and other histories never trigger a fallback. */
export function openFixedSnapshotFiles(
  fixed: string | Snapshot,
  select: (snapshot: Snapshot) => readonly string[],
  options: { readonly offline?: boolean } = {},
) {
  return Effect.gen(function* () {
    const complete = yield* (
      typeof fixed === "string" ? loadSnapshotManifest(fixed) : validateSnapshotManifest(fixed)
    ).pipe(Effect.result)
    if (complete._tag === "Failure") {
      if (complete.failure.code !== "SNAPSHOT_MISSING" || typeof fixed !== "string")
        return yield* Effect.fail(complete.failure)
      let paths: readonly string[] = []
      const retained = yield* openRetainedSnapshotFiles(
        fixed,
        (snapshot) => (paths = selectedPaths(snapshot, select)),
        options,
      )
      if (retained === undefined) return yield* Effect.fail(complete.failure)
      const byPath = new Map(retained.files.map((file) => [file.path, file.bytes]))
      const files = yield* checked(() =>
        paths.map((path) => {
          const bytes = byPath.get(path)
          if (bytes === undefined)
            throw fail("STATE_CORRUPT", "A selected fixed file was not materialized.", { path })
          return { path, bytes }
        }),
      )
      return { snapshot: retained.snapshot, files, access_denied: retained.access_denied }
    }

    const snapshot = complete.success
    const accessDenied = yield* assertKnownSnapshotAccess(snapshot, options.offline)
    const paths = yield* checked(() => selectedPaths(snapshot, select))
    const store = yield* Store
    const objects = new Map<string, Uint8Array>()
    const missingObjects = new Set<string>()
    const bytesByPath = new Map<string, Uint8Array>()
    const missing: string[] = []
    let missingError: SkillsError | undefined
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
          missingError ??= cached.failure
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
    if (missing.length) {
      const retained = yield* openRetainedSnapshotFiles(
        snapshot.snapshot_id,
        (manifest) => {
          if (
            manifest.scope !== snapshot.scope ||
            manifest.snapshot_id !== snapshot.snapshot_id ||
            manifest.historical_snapshot_id !== snapshot.historical_snapshot_id ||
            sharedSnapshotFrozenTree(manifest) !== sharedSnapshotFrozenTree(snapshot)
          )
            throw fail(
              "STATE_CORRUPT",
              "The retained manifest conflicts with the immutable local snapshot.",
            )
          return missing
        },
        options,
      )
      if (retained === undefined)
        return yield* Effect.fail(
          missingError ?? fail("SNAPSHOT_MISSING", "Selected fixed file bytes are unavailable."),
        )
      for (const file of retained.files) bytesByPath.set(file.path, file.bytes)
    }
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
