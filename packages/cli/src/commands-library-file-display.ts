import { Effect, FileSystem, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { databaseId } from "../../core/src/catalog.ts"
import { defineCommand } from "../../core/src/command-schema.ts"
import { fail, property } from "../../core/src/model.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { inspectSharedResourceState } from "../../core/src/shared-resource-state.ts"
import { syncSharedResourceDisplay } from "../../core/src/shared-resource-display.ts"
import { initializeSharedResourceDisplay } from "../../core/src/shared-resource-display-schema.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"

const entry = requiredSingleton("entry", "Exact shared library entry ID, URL or registered alias")
export const libraryFileDisplaySchemaCommand = defineCommand(
  "display-schema",
  {
    entry,
    dryRun: switchFlag(
      "dry-run",
      "Inspect the optional display fields and one-hop rollups without writes",
    ),
  },
  ({ entry, dryRun }) =>
    Effect.gen(function* () {
      const library = yield* loadSharedLibrary(yield* databaseId(entry))
      return yield* emit(yield* initializeSharedResourceDisplay(library, dryRun))
    }),
).pipe(
  Command.withDescription(
    "Register readable observed-version fields on Skills and Files. Files use the existing Skill relation to roll up plain selected/check/candidate values. Keeps current views and user properties; display and rollups never determine ownership or authorize writes.",
  ),
)

export const libraryFileDisplayCommand = defineCommand(
  "display",
  {
    target: Argument.String("target"),
    entry,
    publish: switchFlag(
      "publish",
      "Observe complete content and publish changed display fields only",
    ),
    observe: switchFlag(
      "observe",
      "Include complete read-only native body/resource observations in the preview",
    ),
    candidate: singleton(
      "candidate",
      "Optional original frozen source candidate JSON or complete prepare output",
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const library = yield* loadSharedLibrary(yield* databaseId(options.entry))
      const candidatePath = Option.getOrUndefined(options.candidate)
      let candidate: unknown
      if (candidatePath !== undefined) {
        const value = yield* (yield* FileSystem.FileSystem)
          .readFileString(candidatePath)
          .pipe(
            Effect.mapError(() =>
              fail("INVALID_ARGUMENT", "The frozen candidate file is unavailable."),
            ),
          )
        const parsed = yield* Effect.try({
          try: (): unknown => JSON.parse(value),
          catch: () => fail("INVALID_ARGUMENT", "The frozen candidate must be valid JSON."),
        })
        candidate = property(parsed).plan ?? parsed
      }
      const state = yield* inspectSharedResourceState(library, {
        target: options.target,
        observe: options.observe || options.publish,
        ...(candidate === undefined ? {} : { candidate }),
      })
      const display = yield* syncSharedResourceDisplay(library, state, !options.publish)
      return yield* emit({ state, display })
    }),
).pipe(
  Command.withDescription(
    "Preview readable version, ownership and custom-baseline fields; --publish writes only changed CLI-owned display properties after exact binding/frontier revalidation. Check times describe successful Source checks, not page freshness. No-change publication does not rewrite bodies, append history or patch unchanged rows. Display failure is reported separately from content state.",
  ),
)
