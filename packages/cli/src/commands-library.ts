import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { initializeSharedLibrary, loadSharedLibrary } from "../../core/src/shared-library.ts"
import { libraryId } from "../../core/src/library-selection.ts"
import { queryCurrentSkillIndex } from "../../core/src/shared-current-index.ts"
import { Notion } from "../../core/src/notion.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"
import { libraryProfilesCommand } from "./commands-library-profiles.ts"
import { currentSkillCommand } from "./commands-current-skill.ts"
import { currentImportCommand } from "./commands-current-import.ts"
import { currentImportBatchCommand } from "./commands-current-import-batch.ts"
import { currentMembersPlanCommand } from "./commands-current-members.ts"
import { currentSourceCommand } from "./commands-current-source.ts"
import { currentOperationCommand } from "./commands-current-operation.ts"
import { currentProjectionCommand } from "./commands-current-projection.ts"

const initialize = defineCommand(
  "init",
  {
    parent: singleton("parent", "Create one current library under this exact parent page"),
    library: singleton("library", "Inspect an existing Library root"),
    operation: singleton("operation", "Reconcile the exact pending table creation"),
    resume: switchFlag(
      "resume",
      "Continue the exact initialization with --parent and --operation using its retained local state",
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const result = yield* initializeSharedLibrary({
        parent: Option.getOrUndefined(options.parent),
        library: Option.getOrUndefined(options.library) === undefined ? undefined : yield* libraryId(Option.getOrUndefined(options.library)!),
        operation: Option.getOrUndefined(options.operation),
        resume: options.resume,
      })
      yield* emit({
        ...result,
        contract: "current",
        root_url: `https://www.notion.so/${result.library.library_id.replaceAll("-", "")}`,
        next: {
          argv: [
            "ntn-skills",
            "list",
            "--library",
            result.library.library_id,
            "--refresh",
            "--json",
          ],
        },
      })
    }),
).pipe(
  Command.withDescription(
    "Create or validate the current Skills, Files, Records and Sources layout. Success means the structure is ready; keep library.library_id as the root identity. next.argv is a read-only list and may return an empty library. This does not create Skill content or copy builtins, save a default library, or configure a host. --operation alone is read-only reconciliation; add --resume to continue the original initialization. Retain its local state until completion. Existing libraries must already use the current Content contract; this command does not convert old content or continue old publication operations.",
  ),
)

const inspect = defineCommand("inspect", { library: requiredSingleton("library", "Exact Library root page ID, URL or alias") }, ({ library }) =>
  Effect.gen(function* () {
    yield* emit({ library: yield* loadSharedLibrary(yield* libraryId(library)), contract: "current" })
  }),
).pipe(
  Command.withDescription(
    "Read the current library descriptor by its exact Library root page ID. This does not read bodies or change schema.",
  ),
)

const files = defineCommand(
  "files",
  {
    target: Argument.String("target"),
    library: requiredSingleton("library", "Exact Library root page ID, URL or alias"),
  },
  ({ target, library: selected }) =>
    Effect.gen(function* () {
      const library = yield* loadSharedLibrary(yield* libraryId(selected))
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
    "Manage the current library and Profile, import one complete current Skill, or manage current Source contributions, eligibility and file authority. Each write, resume and explicit supersede uses exact finite operation identities.",
  ),
  Command.withSubcommands([
    initialize,
    inspect,
    files,
    currentOperationCommand,
    currentSkillCommand,
    currentImportCommand,
    currentImportBatchCommand,
    currentMembersPlanCommand,
    currentSourceCommand,
    currentProjectionCommand,
    libraryProfilesCommand,
  ]),
)
