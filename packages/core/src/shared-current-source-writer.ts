import { Config, Context, Effect, Option } from "effect"
import { lstat } from "node:fs/promises"
import { join } from "node:path"
import { fail } from "./model.ts"
import { withLocalLocks } from "./local-locks.ts"
import { Notion } from "./notion.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { Store } from "./store.ts"

/** Set only by the fixed manager after validating its host, generation and Store. */
export const SourceManagerExecution = Context.Reference<{
  readonly library_id: string
  readonly store_root: string
  readonly source_ids: readonly string[]
} | null>("ntn-skills/SourceManagerExecution", { defaultValue: () => null })

// Internal nested Source calls share the acquired scope. The actual lock belongs
// to the configured manager Store, never to a caller's consumer cache.
const SourceWriterScope = Context.Reference<ReadonlySet<string>>("ntn-skills/SourceWriterScope", {
  defaultValue: () => new Set<string>(),
})

/** Hold one library writer across its fresh reads, plan and every child write.
 * Cross-host clients must enter the same configured manager; this filesystem
 * fence alone makes no claim about a different host or Store. */
export function withCurrentSourceWriter<A, E, R>(
  library: SharedLibrary,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const store = yield* Store
    const api = yield* Notion
    const manager = yield* SourceManagerExecution
    const configured = yield* Config.option(
      Config.String("NTN_SKILLS_SOURCE_MANAGER_BINDING"),
    ).pipe(
      Effect.mapError(() =>
        fail("SOURCE_MANAGER_CONFIG_INVALID", "The Source manager binding is invalid."),
      ),
    )
    const bindingPresent =
      Option.isSome(configured) ||
      (yield* Effect.tryPromise({
        try: async () => {
          try {
            await lstat(join(store.configRoot, "source-manager.json"))
            return true
          } catch (error) {
            if (
              error !== null &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "ENOENT"
            )
              return false
            throw error
          }
        },
        catch: () =>
          fail("SOURCE_MANAGER_CONFIG_INVALID", "The Source manager binding cannot be inspected."),
      }))
    if (
      manager !== null &&
      (manager.library_id !== library.library_id || manager.store_root !== store.root)
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_MANAGER_SCOPE_MISMATCH",
          "The configured manager cannot write this Library or Store.",
        ),
      )
    if (bindingPresent && manager === null)
      return yield* Effect.fail(
        fail(
          "SOURCE_MANAGER_REQUIRED",
          "Source writes must use the configured manager. This command cannot fall back to a local writer.",
        ),
      )
    const lock = `current-source-sync:${api.apiOrigin ?? "https://api.notion.com"}:${library.sources.data_source_id}`
    const identity = JSON.stringify([store.root, lock])
    const acquired = yield* SourceWriterScope
    if (acquired.has(identity)) return yield* effect
    return yield* withLocalLocks(
      store.root,
      [lock],
      effect.pipe(Effect.provideService(SourceWriterScope, new Set([...acquired, identity]))),
    )
  })
}
