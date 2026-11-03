import { Effect } from "effect"
import { Argument, Command } from "effect/cli"
import { archiveOwnedPage } from "../../core/src/owned-page-archive.ts"
import { defineCommand } from "../../core/src/command-schema.ts"
import { dryRunFlag, emit, requiredSingleton } from "./command-options.ts"

export const archiveCommand = defineCommand(
  "archive",
  {
    target: Argument.String("page-id"),
    operation: requiredSingleton(
      "operation",
      "Original completed creation operation that owns this exact page",
    ),
    dryRun: dryRunFlag,
  },
  ({ target, operation, dryRun }) =>
    archiveOwnedPage(target, operation, { dryRun }).pipe(Effect.flatMap(emit)),
).pipe(
  Command.withShortDescription("Archive one page proved owned by its original creation receipt"),
  Command.withDescription(
    "Set only in_trash:true on an exact page created by the original completed publication or native create operation in this credential scope. The retained ownership receipt is required; older shared creations without it are refused. --dry-run reads current archive state and returns the exact owned page IDs without writing a dispatch. Every outcome is checked by GET. Unknown writes retain their original intent and are never automatically replayed. This command cannot change properties, schema or page bodies.",
  ),
)
