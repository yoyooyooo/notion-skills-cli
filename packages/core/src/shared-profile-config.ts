import { Effect, Schema } from "effect"
import { catalog, databaseId } from "./catalog.ts"
import type { ReadPolicyOptions } from "./cache.ts"
import {
  ConfigSchema,
  fail,
  SharedProfileBindingSchema,
  SkillsError,
  type SharedProfileBinding,
} from "./model.ts"
import { loadSharedProfileEntryCached, selectProfileView } from "./shared-profile.ts"
import { configuration, Store } from "./store.ts"
import { viewCatalog } from "./views.ts"

function checked<A>(run: () => A) {
  return Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("CONFIG_ERROR", "Invalid shared Profile preference."),
  })
}

/** Preserve opaque configuration fields without ever returning them to the caller. */
function rawConfiguration() {
  return Effect.gen(function* () {
    const raw = (yield* (yield* Store).readJson("config.json", Schema.Unknown)) ?? { sources: [] }
    return yield* checked(() => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        throw fail("CONFIG_ERROR", "Configuration must be an object.")
      Schema.decodeUnknownSync(ConfigSchema)(raw)
      return raw as Record<string, unknown>
    })
  })
}

/** Validate shared metadata, then persist only the selected library and Profile IDs. */
export function bindSharedProfile(input: {
  readonly libraryEntry: string
  readonly profileId: string
}) {
  return Effect.gen(function* () {
    const entry = yield* databaseId(input.libraryEntry)
    const selected = yield* loadSharedProfileEntryCached(entry, input.profileId, { refresh: true })
    yield* checked(() => selectProfileView(selected.profile))
    const binding = yield* checked(() =>
      Schema.decodeUnknownSync(SharedProfileBindingSchema)(
        {
          library_entry: selected.library.skills.database_id,
          profile_id: selected.profile.profile_id,
        },
        { onExcessProperty: "error" },
      ),
    )
    const current = yield* rawConfiguration()
    yield* (yield* Store).writeJson("config.json", { ...current, shared_profile: binding })
    return {
      shared_profile: binding,
      profile_revision_id: selected.profile.revision_id,
      metadata_only: true as const,
    }
  })
}

/** Removing a machine preference performs no Notion or provider requests. */
export function unbindSharedProfile() {
  return Effect.gen(function* () {
    const current = yield* rawConfiguration()
    const { shared_profile: previous, ...next } = current
    if (previous !== undefined) yield* (yield* Store).writeJson("config.json", next)
    return { shared_profile: null, removed: previous !== undefined }
  })
}

export interface ProfileCatalogOptions extends ReadPolicyOptions {
  readonly database?: string
  readonly view?: string
  readonly defaultView?: boolean
  readonly profile?: string
}

/**
 * Explicit discovery and session Views retain their original behavior. Only a
 * requested default directory consults a shared Profile or a machine binding.
 */
export function catalogWithProfile(options: ProfileCatalogOptions = {}) {
  return Effect.gen(function* () {
    if (options.view !== undefined && options.defaultView)
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "--view and --default-view are mutually exclusive."),
      )
    if (options.profile !== undefined && options.database === undefined)
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "--profile requires an explicit --database shared library entry."),
      )
    const policy: ReadPolicyOptions = {
      ...(options.refresh === undefined ? {} : { refresh: options.refresh }),
      ...(options.offline === undefined ? {} : { offline: options.offline }),
      ...(options.maxAge === undefined ? {} : { maxAge: options.maxAge }),
    }
    if (options.view !== undefined)
      return yield* viewCatalog({ ...policy, database: options.database, view: options.view })
    if (!options.defaultView && options.profile === undefined)
      return yield* catalog({ ...policy, database: options.database })

    let binding: SharedProfileBinding | undefined
    if (options.profile !== undefined) {
      // The explicit database requirement was checked before any I/O above.
      const entry = yield* databaseId(options.database!)
      binding = { library_entry: entry, profile_id: options.profile }
    } else {
      const configured = (yield* configuration).shared_profile
      if (
        configured !== undefined &&
        (options.database === undefined ||
          (yield* databaseId(options.database)) === configured.library_entry)
      )
        binding = configured
    }
    const observed =
      binding === undefined
        ? undefined
        : yield* loadSharedProfileEntryCached(binding.library_entry, binding.profile_id, policy)
    const selection = yield* checked(() => selectProfileView(observed?.profile))
    const result = yield* viewCatalog({
      ...policy,
      database: observed?.library.skills.database_id ?? options.database,
      view: "view" in selection ? selection.view : undefined,
    })
    if (observed !== undefined && result.scope !== observed.scope)
      return yield* Effect.fail(
        fail(
          "ACCESS_DENIED",
          "Credential scope changed between Profile and View observation; retry discovery.",
        ),
      )
    return {
      ...result,
      records: result.records.filter((record) => record.kind !== "prompt"),
      capability_directory: true as const,
      ...(observed === undefined
        ? {}
        : {
            profile: {
              library_id: observed.library.library_id,
              library_entry: observed.library.skills.database_id,
              profile_id: observed.profile.profile_id,
              revision_id: observed.profile.revision_id,
              selection: selection.selection,
              source: observed.source,
              freshness: observed.freshness,
            },
          }),
    }
  })
}
