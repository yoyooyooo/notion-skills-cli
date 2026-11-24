import { Effect } from "effect"
import { fail, type Source } from "./model.ts"
import { pageId } from "./notion-id.ts"
import { configuration, configuredSources } from "./store.ts"

/** Alias resolution is local and freezes the root before any remote work. */
export function libraryId(input: string, sources?: readonly Source[]) {
  return Effect.gen(function* () {
    const id = pageId(input)
    if (id !== undefined) return id
    const configured = sources ?? (yield* configuredSources)
    const matches = configured.filter((source) => source.alias === input)
    const roots = new Set(matches.map((source) => source.shared_library?.library_id))
    if (matches.length === 0 || roots.has(undefined))
      return yield* Effect.fail(fail("LIBRARY_NOT_FOUND", "No registered Library alias matched; use its root page ID or URL.", { selector: input }))
    if (roots.size !== 1)
      return yield* Effect.fail(fail("LIBRARY_AMBIGUOUS", "The alias names several Library roots; use an exact root ID.", { selector: input }))
    return matches[0]!.shared_library!.library_id
  })
}

export function selectedLibraryId(explicit?: string) {
  return Effect.gen(function* () {
    const config = yield* configuration
    const selected = explicit ?? config.default_library
    if (selected === undefined)
      return yield* Effect.fail(fail("LIBRARY_CONTEXT_REQUIRED", "Select --library or configure default_library before unscoped consumption."))
    return yield* libraryId(selected, config.sources ?? [])
  })
}
