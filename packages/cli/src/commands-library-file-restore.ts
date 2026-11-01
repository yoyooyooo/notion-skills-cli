import { Effect } from "effect"
import { Argument, Command } from "effect/cli"
import { databaseId } from "../../core/src/catalog.ts"
import { defineCommand } from "../../core/src/command-schema.ts"
import { fail } from "../../core/src/model.ts"
import { pageId } from "../../core/src/ref.ts"
import { restoreSelectedSharedFile } from "../../core/src/shared-file-restore.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { emit, requiredSingleton, switchFlag } from "./command-options.ts"

export const libraryFileRestoreCommand = defineCommand(
  "restore-follow",
  {
    target: Argument.String("target").pipe(
      Argument.withDescription("Exact shared Skill page ID or Notion page URL"),
    ),
    path: Argument.String("path").pipe(
      Argument.withDescription("Exact existing logical file path, including the main entrypoint"),
    ),
    entry: requiredSingleton("entry", "Exact shared library entry ID, URL or registered alias"),
    dryRun: switchFlag(
      "dry-run",
      "Read the fixed source and current body, then preview without Notion writes",
    ),
    allowLocalArchive: switchFlag(
      "allow-local-archive",
      "Authorize retaining this exact local source file in shared Notion records",
    ),
  },
  ({ target, path, entry, dryRun, allowLocalArchive }) =>
    Effect.gen(function* () {
      const selected = pageId(target)
      if (!selected)
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            "Restore requires an exact shared Skill page ID or Notion page URL.",
          ),
        )
      const library = yield* loadSharedLibrary(yield* databaseId(entry))
      yield* emit(
        yield* restoreSelectedSharedFile({
          library,
          skillPageId: selected,
          path,
          dryRun,
          allowLocalArchive,
        }),
      )
    }),
).pipe(
  Command.withDescription(
    "Explicitly release a whole-file customization and follow the source currently selected in Notion. Resolves exact immutable Git or composed source bytes; moved files use their retained original source path. Retains the previous complete custom body, writes once with a complete old-body match, and requires an exact result plus fresh current read. Does not select a newer source, infer a same-named local replacement, replay an unknown operation, or silently share local resource bytes. Native Notion body writes support UTF-8 Markdown; binary content fails before mutation.",
  ),
)
