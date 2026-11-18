import { Effect } from "effect"
import { authScope } from "./catalog.ts"
import { fail, SkillsError, type Snapshot, type Source } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { sharedRecordFromPage } from "./shared-content.ts"
import { gitBlobOid } from "./shared-github-source.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { readFixedResourceBytes } from "./shared-fixed-resource-read.ts"
import { planSelectedSharedSource } from "./shared-selected-source.ts"
import { sha256, Store } from "./store.ts"

/** Fetch missing selected files from their declared current locations. Recheck
 * the current owner once, then require the selected source and exact bytes. */
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
          "SHARED_ACQUISITION_SCOPE",
          "The selected acquisition belongs to another authenticated scope.",
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
          "SHARED_ACQUISITION_SCOPE",
          "The selected locations belong to another shared library.",
        ),
      )
    const page = snapshot.record.locator.page_id
    if (pageId(page) !== page)
      return yield* Effect.fail(
        fail("SHARED_ACQUISITION_SCOPE", "Acquisition requires an exact canonical Skill page."),
      )
    const raw = yield* (yield* Notion).request(`v1/pages/${page}`)
    const source: Source = {
      alias: library.library_id,
      title: "",
      role: "content",
      database_id: library.skills.database_id,
      data_source_ids: [library.skills.data_source_id],
      shared_library: library,
    }
    yield* Effect.try({
      try: () => {
        const current = sharedRecordFromPage(raw, source, library.skills.data_source_id)
        if (
          current.id !== snapshot.record.id ||
          canonicalSharedJson(current.locator) !== canonicalSharedJson(snapshot.record.locator)
        )
          throw fail("SHARED_ACQUISITION_SCOPE", "The current owner differs from this selection.")
        if (current.enabled === false)
          throw fail(
            "SKILL_DISABLED",
            "The selected Skill is disabled. Read an enabled Skill instead.",
          )
      },
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("SHARED_ACQUISITION_SCOPE", "The current acquisition owner is unavailable."),
    })
    const store = yield* Store
    const result: Array<{ readonly path: string; readonly bytes: Uint8Array }> = []
    const sourceRoutes = routes.filter((route) => route.kind === "source")
    if (sourceRoutes.length !== 0) {
      const frozen = acquisition.source
      if (frozen === null)
        return yield* Effect.fail(fail("STATE_CORRUPT", "The selected path has no exact source."))
      const source = yield* planSelectedSharedSource(library, page, frozen.source_id)
      if (source.revision !== frozen.revision)
        return yield* Effect.fail(
          fail(
            "SHARED_SOURCE_CONFLICT",
            "The selected source revision is no longer current. Read the current Skill again.",
            { next: "reselect_current", target: snapshot.record.id },
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
              "The selected source path does not match this exact file identity.",
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
            "Acquisition returned an incomplete or duplicate file set.",
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
              "Acquired bytes failed the selected path/hash/mode identity.",
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
        // Another authorized consumer can finish while this caller checks current
        // owner eligibility. Recheck the exact immutable object before networking.
        const local = yield* store.readBytes(`objects/${expected.sha256}`).pipe(Effect.result)
        if (local._tag === "Success") bytes = local.success
        else if (local.failure.code !== "SNAPSHOT_MISSING") return yield* Effect.fail(local.failure)
      }
      if (bytes === undefined) {
        bytes = yield* readFixedResourceBytes(library, {
          skillPageId: page,
          snapshotId: snapshot.snapshot_id,
          content: {
            kind: "resource",
            object_id: route.object_id,
            sha256: expected.sha256,
            bytes: expected.bytes,
            mode: expected.mode ?? null,
          },
        })
        resources.set(route.object_id, bytes)
      }
      if (bytes.length !== expected.bytes || (yield* sha256(bytes)) !== expected.sha256)
        return yield* Effect.fail(
          fail(
            "SHARED_RESOURCE_CONTENT_INVALID",
            "The current resource differs from the selected bytes.",
          ),
        )
      yield* store.writeBytes(`objects/${expected.sha256}`, bytes)
      result.push({ path: route.path, bytes })
    }
    return result
  })
}
