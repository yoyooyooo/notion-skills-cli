import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { initializeSharedLibrary, loadSharedLibrary } from "../../core/src/shared-library.ts"
import { queryCurrentSkillIndex } from "../../core/src/shared-current-index.ts"
import { Notion } from "../../core/src/notion.ts"
import { emit, requiredSingleton, singleton } from "./command-options.ts"
import { libraryProfilesCommand } from "./commands-library-profiles.ts"
import { currentImportCommand } from "./commands-current-import.ts"
import { currentSourceCommand } from "./commands-current-source.ts"

const initialize = defineCommand(
  "init",
  {
    parent: singleton("parent", "Create one current library under this exact parent page"),
    entry: singleton("entry", "Inspect an existing current library entry"),
    operation: singleton("operation", "Reconcile the exact pending table creation"),
  },
  (options) =>
    Effect.gen(function* () {
      const result = yield* initializeSharedLibrary({
        parent: Option.getOrUndefined(options.parent),
        entry: Option.getOrUndefined(options.entry),
        operation: Option.getOrUndefined(options.operation),
      })
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
    "Manage the current library and Profile, import one complete current Skill, or apply and refresh Sources with stable target contributions. Each write and resume uses its exact finite operation identity.",
  ),
  Command.withSubcommands([
    initialize,
    inspect,
    files,
    currentImportCommand,
    currentSourceCommand,
    libraryProfilesCommand,
  ]),
)
