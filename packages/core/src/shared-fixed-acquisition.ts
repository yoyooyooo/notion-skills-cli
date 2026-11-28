import { Effect } from "effect"
import { authScope } from "./catalog.ts"
import { fail, property, SkillsError, type Snapshot, type Source } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { sharedRecordFromPage } from "./shared-content.ts"
import { validateSnapshotAcquisition } from "./shared-acquisition-model.ts"
import { requireCurrentSkillReady } from "./shared-current-file.ts"
import { queryCurrentSkillIndex } from "./shared-current-index.ts"
import { resolveCurrentSkillConsumption } from "./shared-current-consumption.ts"
import { readCurrentSharedResourceBytes } from "./shared-current-resource.ts"
import { gitBlobOid } from "./shared-github-source.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import { canonicalSharedJson } from "./shared-records.ts"
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
    yield* Effect.try({
      try: () => validateSnapshotAcquisition(snapshot),
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("STATE_CORRUPT", "The selected acquisition is invalid."),
    })
    const routes = acquisition.files.filter((route) => paths.includes(route.path))
    if (routes.length === 0) return []
    if (options.offline)
      return yield* Effect.fail(
        fail(
          "SNAPSHOT_MISSING",
          "The selected fixed bytes are not local; offline reads cannot acquire them.",
          { paths: routes.map((route) => route.path), reason: "offline", next: "retry_online" },
        ),
      )
    if ((yield* authScope) !== snapshot.scope || snapshot.record.locator.type !== "shared_skill")
      return yield* Effect.fail(
        fail(
          "SHARED_ACQUISITION_SCOPE",
          "The selected acquisition belongs to another authenticated scope.",
        ),
      )
    const library = yield* loadSharedLibrary(acquisition.library.library_id)
    const previous = acquisition.library
    if (
      library.library_id !== previous.library_id ||
      library.skills.database_id !== previous.skills.database_id ||
      library.skills.data_source_id !== previous.skills.data_source_id ||
      library.files.database_id !== previous.files.database_id ||
      library.files.data_source_id !== previous.files.data_source_id ||
      library.records.database_id !== previous.records.database_id ||
      library.records.data_source_id !== previous.records.data_source_id ||
      (routes.some((route) => route.kind === "source") &&
        (library.sources === undefined ||
          previous.sources === undefined ||
          library.sources.database_id !== previous.sources.database_id ||
          library.sources.data_source_id !== previous.sources.data_source_id))
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
    const index = yield* queryCurrentSkillIndex(library, page, raw)
    yield* Effect.try({
      try: () => requireCurrentSkillReady(index.state, page),
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("CURRENT_SKILL_NOT_READY", "The current Skill requires management attention."),
    })
    const bindings = [index.main, ...index.files]
    const consumption = yield* resolveCurrentSkillConsumption(library, index)
    const currentFiles = consumption.files
    // A local selection may keep its already materialized bytes. Missing bytes
    // can only come from a still-current exact file descriptor, not a former
    // resource pointer or a Source that merely remains remotely available.
    const descriptors = yield* Effect.try({
      try: () =>
        new Map(
          routes.map((route) => {
            const expected = snapshot.files.find((file) => file.path === route.path)
            const selectedBinding = snapshot.file_bindings?.find((file) => file.path === route.path)
            const currentBinding = bindings.find((file) => file.path === route.path)
            const current = currentFiles.find((file) => file.path === route.path)
            const content = current?.content
            if (
              expected === undefined ||
              current === undefined ||
              content === undefined ||
              content.kind === "native" ||
              content.sha256 !== expected.sha256 ||
              content.bytes !== expected.bytes ||
              content.mode !== (expected.mode ?? "100644") ||
              (route.kind === "source"
                ? content.kind !== "source" ||
                  content.source_id !== route.source_id ||
                  content.revision !== route.revision ||
                  content.source_path !== route.source_path
                : content.kind !== "resource" ||
                  content.object_id !== route.object_id ||
                  selectedBinding === undefined ||
                  currentBinding?.file_id !== selectedBinding.file_id ||
                  currentBinding.page_id !== selectedBinding.page_id)
            )
              throw fail(
                "SHARED_ACQUISITION_CHANGED",
                "The selected file is no longer current. Read the current Skill again.",
                { path: route.path, next: "reselect_current", target: snapshot.record.id },
              )
            return [route.path, content] as const
          }),
        ),
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("SHARED_ACQUISITION_SCOPE", "The current file bindings are invalid."),
    })
    const result: Array<{ readonly path: string; readonly bytes: Uint8Array }> = []
    // The complete current descriptors admit this fixed acquisition here. Later
    // management changes do not turn it into a latest read: only bytes matching
    // the admitted revision/path/hash/mode may finish. A new acquisition checks
    // current eligibility again.
    const sourceRoutes = routes.filter((route) => route.kind === "source")
    const sources = consumption.sources
    for (const source of sources.values()) {
      const selectedRoutes = sourceRoutes.filter((route) => route.source_id === source.source_id)
      if (selectedRoutes.length === 0) continue
      for (const route of selectedRoutes) {
        const expected = snapshot.files.find((file) => file.path === route.path)!
        const descriptor = source.manifest.find((file) => file.path === route.source_path)
        if (
          descriptor === undefined ||
          descriptor.bytes !== expected.bytes ||
          descriptor.mode !== (expected.mode ?? "100644") ||
          descriptor.sha256 !== expected.sha256
        )
          return yield* Effect.fail(
            fail(
              "SHARED_SOURCE_CONFLICT",
              "The selected source path does not match this exact file identity.",
              { path: route.path, source_path: route.source_path },
            ),
          )
      }
      const selected = [...new Set(selectedRoutes.map((route) => route.source_path))].sort()
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
      for (const route of selectedRoutes) {
        const expected = snapshot.files.find((file) => file.path === route.path)!
        const actual = materialized.files.find((file) => file.path === route.source_path)
        const descriptor = source.manifest.find((file) => file.path === route.source_path)!
        if (
          actual === undefined ||
          actual.bytes.length !== expected.bytes ||
          actual.mode !== (expected.mode ?? "100644") ||
          (yield* sha256(actual.bytes)) !== expected.sha256 ||
          (descriptor.git_oid !== undefined &&
            (yield* gitBlobOid(actual.bytes)) !== descriptor.git_oid)
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
        const content = descriptors.get(route.path)
        if (content?.kind !== "resource")
          return yield* Effect.fail(fail("STATE_CORRUPT", "The current resource binding was lost."))
        bytes = yield* readCurrentSharedResourceBytes(library, {
          owner: { kind: "skill", page_id: page },
          content,
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
  }).pipe(
    Effect.mapError((error) =>
      fail(error.code, error.message, {
        phase: "fixed_acquisition",
        snapshot_id: snapshot.snapshot_id,
        scope: snapshot.scope,
        target: snapshot.record.id,
        paths,
        ...property(error.details),
      }),
    ),
  )
}
