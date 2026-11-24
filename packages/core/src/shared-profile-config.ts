import { Effect, Schema } from "effect"
import { catalog, libraryId, selectedLibraryId } from "./catalog.ts"
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
export function bindSharedProfile(input: { readonly library: string; readonly profileId: string }) {
  return Effect.gen(function* () {
    const entry = yield* libraryId(input.library)
    const selected = yield* loadSharedProfileEntryCached(entry, input.profileId, { refresh: true })
    yield* checked(() => selectProfileView(selected.profile))
    const binding = yield* checked(() =>
      Schema.decodeUnknownSync(SharedProfileBindingSchema)(
        {
          library_id: selected.library.library_id,
          profile_id: selected.profile.profile_id,
        },
        { onExcessProperty: "error" },
      ),
    )
    const current = yield* rawConfiguration()
    yield* (yield* Store).writeJson("config.json", { ...current, shared_profile: binding })
    return {
      shared_profile: binding,
      profile_fingerprint: selected.profile.fingerprint,
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
  readonly library?: string
  readonly view?: string
  readonly defaultView?: boolean
  readonly profile?: string
  readonly all?: boolean
}

/**
 * Explicit discovery and session Views retain their original behavior. Only a
 * requested default directory consults a shared Profile or a machine binding.
 */
export function catalogWithProfile(options: ProfileCatalogOptions = {}) {
  return Effect.gen(function* () {
    if (
      options.all &&
      (options.view !== undefined || options.defaultView || options.profile !== undefined)
    )
      return yield* Effect.fail(fail("INVALID_ARGUMENT", "--all cannot select a View or Profile."))
    if (options.view !== undefined && options.defaultView)
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "--view and --default-view are mutually exclusive."),
      )
    if (options.profile !== undefined && options.library === undefined)
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "--profile requires an explicit --library root."),
      )
    const policy: ReadPolicyOptions = {
      ...(options.refresh === undefined ? {} : { refresh: options.refresh }),
      ...(options.offline === undefined ? {} : { offline: options.offline }),
      ...(options.maxAge === undefined ? {} : { maxAge: options.maxAge }),
    }
    if (options.view !== undefined)
      return yield* viewCatalog({ ...policy, library: options.library, view: options.view })
    if (!options.defaultView && options.profile === undefined)
      return yield* catalog({ ...policy, library: options.library, all: options.all })

    let binding: SharedProfileBinding | undefined
    if (options.profile !== undefined) {
      // The explicit Library requirement was checked before any I/O above.
      const entry = yield* libraryId(options.library!)
      binding = { library_id: entry, profile_id: options.profile }
    } else {
      const selected = yield* selectedLibraryId(options.library)
      const configured = (yield* configuration).shared_profile
      if (configured !== undefined && selected === configured.library_id) binding = configured
    }
    const observed =
      binding === undefined
        ? undefined
        : yield* loadSharedProfileEntryCached(binding.library_id, binding.profile_id, policy)
    const selection = yield* checked(() => selectProfileView(observed?.profile))
    const result = yield* viewCatalog({
      ...policy,
      library: observed?.library.library_id ?? options.library,
      view: "view" in selection ? selection.view : undefined,
    })
    if (observed !== undefined && result.scope !== observed.scope)
      return yield* Effect.fail(
        fail(
          "ACCESS_DENIED",
          "Credential scope changed between Profile and View observation; retry discovery.",
        ),
      )
    const records = result.records.filter((record) => record.kind !== "prompt")
    return {
      ...result,
      records,
      count: records.length,
      capability_directory: true as const,
      ...(observed === undefined
        ? {}
        : {
            profile: {
              library_id: observed.library.library_id,
              profile_id: observed.profile.profile_id,
              fingerprint: observed.profile.fingerprint,
              selection: selection.selection,
              source: observed.source,
              freshness: observed.freshness,
            },
          }),
    }
  })
}
