import { Effect, FileSystem, Option } from "effect"
import { fail } from "./model.ts"
import { Notion } from "./notion.ts"
import { RequestBudget } from "./request-budget.ts"
import type { ResourceContent } from "./shared-file-state.ts"
import {
  ImmutableByteReadPolicy,
  makeBoundedImmutableReadCoalescer,
} from "./shared-immutable-read.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { loadSharedResourceContent } from "./shared-resource-content.ts"
import { Store } from "./store.ts"

const pendingBytes = Effect.runSync(
  makeBoundedImmutableReadCoalescer<Uint8Array>({ entries: 64, bytes: 16 * 1024 * 1024 }),
)

/** Called only after each consumer admits the original pin and current owner.
 * The producer owns only immutable network bytes; each caller owns its Store. */
export function readFixedResourceBytes(
  library: SharedLibrary,
  input: {
    readonly skillPageId: string
    readonly snapshotId: string
    readonly content: ResourceContent
  },
) {
  const read = loadSharedResourceContent(library, input).pipe(Effect.map((result) => result.bytes))
  return Effect.gen(function* () {
    const api = yield* Notion
    // Admission-budget identity and custom transports stay local to their invocation.
    if (
      api.detachedReadContext === undefined ||
      Option.isSome(yield* Effect.serviceOption(RequestBudget))
    )
      return yield* read
    const detached = yield* api.detachedReadContext
    const store = yield* Store
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs
      .realPath(store.root)
      .pipe(
        Effect.mapError(() =>
          fail("STORAGE_ERROR", "Could not identify the local immutable read root."),
        ),
      )
    const policy = yield* ImmutableByteReadPolicy
    const identity = canonicalSharedJson([
      root,
      detached.identity,
      library,
      input.skillPageId,
      input.snapshotId,
      input.content,
      api.readOnly === true,
      policy,
    ])
    const bytes = yield* pendingBytes.run(
      identity,
      input.content.bytes,
      detached.run(read),
      api.metrics,
    )
    return bytes.slice()
  })
}
