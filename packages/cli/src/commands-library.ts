import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { initializeSharedLibrary, loadSharedLibrary } from "../../core/src/shared-library.ts"
import { initializeSourceLibrary } from "../../core/src/shared-sources-library.ts"
import { queryCurrentSkillIndex } from "../../core/src/shared-current-index.ts"
import { Notion } from "../../core/src/notion.ts"
import { emit, requiredSingleton, singleton } from "./command-options.ts"
import { libraryProfilesCommand } from "./commands-library-profiles.ts"

const initialize = defineCommand(
  "init",
  {
    parent: singleton("parent", "Create one current library under this exact parent page"),
    entry: singleton("entry", "Inspect an existing current library entry"),
    operation: singleton("operation", "Reconcile the exact pending table creation"),
  },
  (options) =>
    Effect.gen(function* () {
      const base = yield* initializeSharedLibrary({
        parent: Option.getOrUndefined(options.parent),
        entry: Option.getOrUndefined(options.entry),
        operation: Option.getOrUndefined(options.operation),
      })
      const result =
        base.library.sources === undefined && !base.reused
          ? yield* initializeSourceLibrary(base.library)
          : base
      yield* emit({
        ...result,
        contract: "current",
        next: {
          argv: [
            "ntn-skills",
            "list",
            "--database",
            result.library.skills.database_id,
            "--refresh",
            "--json",
          ],
        },
      })
    }),
).pipe(
  Command.withDescription(
    "Create the current Skills, Files, Records and Sources layout. Existing libraries must already use the current Content contract; this command does not convert old content or continue old publication operations.",
  ),
)

const inspect = defineCommand("inspect", { entry: Argument.String("entry") }, ({ entry }) =>
  Effect.gen(function* () {
    yield* emit({ library: yield* loadSharedLibrary(entry), contract: "current" })
  }),
).pipe(
  Command.withDescription(
    "Read the current library descriptor by its exact Skills database ID. This does not read bodies or change schema.",
  ),
)

const files = defineCommand(
  "files",
  {
    target: Argument.String("target"),
    entry: requiredSingleton("entry", "Exact current Skills database entry"),
  },
  ({ target, entry }) =>
    Effect.gen(function* () {
      const library = yield* loadSharedLibrary(entry)
      const index = yield* queryCurrentSkillIndex(library, target)
      yield* emit({
        library_id: library.library_id,
        ...index,
        count: index.files.length,
        metadata_only: true,
        request_metrics: (yield* Notion).requestMetrics?.(),
      })
    }),
).pipe(
  Command.withDescription(
    "Read the main Content descriptor and every supporting Files row. Returns current authority, exact owner, path and finite operation state after complete pagination. No body, Records history, repairs or writes.",
  ),
)

export const libraryCommand = defineCommand("library").pipe(
  Command.withDescription(
    "Manage the current library and Profile. Content import, source refresh and file mutations are unavailable until their current writer is installed; old event, snapshot, archive and repair commands are retired.",
  ),
  Command.withSubcommands([initialize, inspect, files, libraryProfilesCommand]),
)
