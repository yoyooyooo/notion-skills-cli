import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { databaseId } from "../../core/src/catalog.ts"
import { defineCommand, exclusiveFlags, withConstraints } from "../../core/src/command-schema.ts"
import { fail } from "../../core/src/model.ts"
import { pageId } from "../../core/src/ref.ts"
import {
  reconcileSelectedSharedFileRestore,
  restoreSelectedSharedFile,
} from "../../core/src/shared-file-restore.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"

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
    reconcile: switchFlag(
      "reconcile",
      "Read the exact original restore outcome without writes; requires --operation",
    ),
    operation: singleton(
      "operation",
      "Exact original body-write-follow operation ID for --reconcile",
    ),
  },
  ({ target, path, entry, dryRun, allowLocalArchive, reconcile, operation }) =>
    Effect.gen(function* () {
      const operationId = Option.getOrUndefined(operation)
      if (dryRun && reconcile)
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "--dry-run and --reconcile are mutually exclusive."),
        )
      if (reconcile !== (operationId !== undefined))
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Use --reconcile with exactly one --operation."),
        )
      const selected = pageId(target)
      if (!selected)
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            "Restore requires an exact shared Skill page ID or Notion page URL.",
          ),
        )
      const library = yield* loadSharedLibrary(yield* databaseId(entry))
      if (reconcile && operationId !== undefined)
        return yield* emit(
          yield* reconcileSelectedSharedFileRestore({
            library,
            skillPageId: selected,
            path,
            operationId,
          }),
        )
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
  withConstraints([exclusiveFlags(["dryRun", "reconcile"])]),
  Command.withDescription(
    "Prepare or restore one whole file to the exact source currently selected in Notion; moved files keep their original source path. --dry-run freezes the complete current body and fixed-source candidate. A differing body uses one nonempty complete old-string match, retaining custom history before dispatch. This is not page revision CAS: unmatched edits remain and any warning or differing full readback prevents following ownership. An identical body needs no body PATCH. Repeated already-following state is unchanged. --reconcile --operation reads only the original plan/outcome; it never replays unknown writes or infers completion from current text. Selection, unrelated files and relations remain independent; binary content and unauthorized local archives fail before mutation.",
  ),
)
