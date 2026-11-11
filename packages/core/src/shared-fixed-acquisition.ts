import { Effect } from "effect"
import { authScope } from "./catalog.ts"
import { fail, type Snapshot } from "./model.ts"
import { gitBlobOid } from "./shared-github-source.ts"
import {
  currentSharedHistorySkill,
  assertSharedHistoryIdentity,
} from "./shared-history-workflow.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import { loadSharedResourceContent } from "./shared-resource-content.ts"
import { planSelectedSharedSource } from "./shared-selected-source.ts"
import { sha256, Store } from "./store.ts"

/** Recover only missing exact files from their frozen acquisition identity. Current
 * Source selection, page prose and similar paths cannot substitute for the pin. */
export function materializeSharedFixedAcquisition(
  snapshot: Snapshot,
  paths: readonly string[],
  options: { readonly offline?: boolean } = {},
) {
  return Effect.gen(function* () {
    const acquisition = snapshot.shared_acquisition
    if (acquisition === undefined || paths.length === 0) return []
    const routes = acquisition.files.filter((route) => paths.includes(route.path))
    if (routes.length === 0) return []
    if (options.offline)
      return yield* Effect.fail(
        fail(
          "SNAPSHOT_MISSING",
          "The selected fixed bytes are not local; offline reads cannot acquire them.",
          { paths: routes.map((route) => route.path) },
        ),
      )
    if ((yield* authScope) !== snapshot.scope || snapshot.record.locator.type !== "shared_skill")
      return yield* Effect.fail(
        fail(
          "SHARED_HISTORY_SCOPE",
          "Frozen resource acquisition belongs to another authenticated scope.",
        ),
      )
    const library = yield* loadSharedLibrary(acquisition.library.skills.database_id)
    const previous = acquisition.library
    if (
      library.library_id !== previous.library_id ||
      library.skills.data_source_id !== previous.skills.data_source_id ||
      library.files.database_id !== previous.files.database_id ||
      library.files.data_source_id !== previous.files.data_source_id ||
      library.records.database_id !== previous.records.database_id ||
      library.records.data_source_id !== previous.records.data_source_id
    )
      return yield* Effect.fail(
        fail(
          "SHARED_HISTORY_SCOPE",
          "The frozen resource locations belong to another shared library.",
        ),
      )
    const page = snapshot.record.locator.page_id
    const current = yield* currentSharedHistorySkill(library, page)
    yield* Effect.try({
      try: () => assertSharedHistoryIdentity(current, snapshot.record),
      catch: (error) => error as import("./model.ts").SkillsError,
    })
    const store = yield* Store
    const result: Array<{ readonly path: string; readonly bytes: Uint8Array }> = []
    const sourceRoutes = routes.filter((route) => route.kind === "source")
    if (sourceRoutes.length !== 0) {
      const frozen = acquisition.source
      if (frozen === null)
        return yield* Effect.fail(fail("STATE_CORRUPT", "The fixed path has no frozen source."))
      const source = yield* planSelectedSharedSource(library, page, frozen.source_id)
      if (source.revision !== frozen.revision)
        return yield* Effect.fail(
          fail(
            "SHARED_SOURCE_CONFLICT",
            "The original fixed source revision differs from this snapshot.",
          ),
        )
      for (const route of sourceRoutes) {
        const expected = snapshot.files.find((file) => file.path === route.path)!
        const descriptor = source.manifest.find((file) => file.path === route.source_path)
        if (
          descriptor === undefined ||
          descriptor.bytes !== expected.bytes ||
          descriptor.mode !== expected.mode ||
          (descriptor.identity.sha256 !== undefined &&
            descriptor.identity.sha256 !== expected.sha256)
        )
          return yield* Effect.fail(
            fail(
              "SHARED_SOURCE_CONFLICT",
              "The frozen source path does not match this exact file identity.",
              { path: route.path, source_path: route.source_path },
            ),
          )
      }
      const selected = [...new Set(sourceRoutes.map((route) => route.source_path))].sort()
      const materialized = yield* source.materialize(selected)
      if (
        materialized.files.length !== selected.length ||
        new Set(materialized.files.map((file) => file.path)).size !== selected.length
      )
        return yield* Effect.fail(
          fail(
            "SOURCE_MATERIALIZATION_INCOMPLETE",
            "Frozen acquisition returned an incomplete or duplicate file set.",
          ),
        )
      for (const route of sourceRoutes) {
        const expected = snapshot.files.find((file) => file.path === route.path)!
        const actual = materialized.files.find((file) => file.path === route.source_path)
        const descriptor = source.manifest.find((file) => file.path === route.source_path)!
        if (
          actual === undefined ||
          actual.bytes.length !== expected.bytes ||
          actual.mode !== expected.mode ||
          (yield* sha256(actual.bytes)) !== expected.sha256 ||
          (descriptor.identity.kind === "git" &&
            (yield* gitBlobOid(actual.bytes)) !== descriptor.identity.git_oid)
        )
          return yield* Effect.fail(
            fail(
              "SHARED_SOURCE_CONFLICT",
              "Frozen acquisition bytes failed the original path/hash/mode identity.",
              { path: route.path },
            ),
          )
        yield* store.writeBytes(`objects/${expected.sha256}`, actual.bytes)
        result.push({ path: route.path, bytes: actual.bytes })
      }
    }
    const resources = new Map<string, Uint8Array>()
    for (const route of routes) {
      if (route.kind !== "resource") continue
      const expected = snapshot.files.find((file) => file.path === route.path)!
      let bytes = resources.get(route.object_id)
      if (bytes === undefined) {
        const loaded = yield* loadSharedResourceContent(library, {
          skillPageId: page,
          content: {
            kind: "resource",
            object_id: route.object_id,
            sha256: expected.sha256,
            bytes: expected.bytes,
            mode: expected.mode ?? null,
          },
        })
        bytes = loaded.bytes
        resources.set(route.object_id, bytes)
      }
      if (bytes.length !== expected.bytes || (yield* sha256(bytes)) !== expected.sha256)
        return yield* Effect.fail(
          fail(
            "SHARED_RESOURCE_CONTENT_INVALID",
            "The retained resource differs from the original pinned bytes.",
          ),
        )
      yield* store.writeBytes(`objects/${expected.sha256}`, bytes)
      result.push({ path: route.path, bytes })
    }
    return result
  })
}
