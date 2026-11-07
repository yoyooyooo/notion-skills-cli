import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { defineCommand, exclusiveFlags, withConstraints } from "../../core/src/command-schema.ts"
import { adoptSharedNative } from "../../core/src/shared-native-adoption.ts"
import {
  databaseFlag,
  dryRunFlag,
  emit,
  switchFlag,
  validateConstraints,
} from "./command-options.ts"

const constraints = [exclusiveFlags(["dryRun", "reconcile"])]
export const adoptCommand = defineCommand(
  "adopt",
  {
    target: Argument.String("page").pipe(
      Argument.withDescription("Exact unregistered disabled native Skill page ID or Notion URL"),
    ),
    database: databaseFlag,
    dryRun: dryRunFlag,
    reconcile: switchFlag(
      "reconcile",
      "Verify only the retained original adoption; never repeat an uncertain write",
    ),
  },
  (options) =>
    Effect.gen(function* () {
      yield* validateConstraints(constraints, options)
      yield* emit(
        yield* adoptSharedNative(options.target, {
          database: Option.getOrUndefined(options.database),
          dryRun: options.dryRun,
          reconcile: options.reconcile,
        }),
      )
    }),
).pipe(
  withConstraints(constraints),
  Command.withDescription(
    "Adopt one manually created disabled Skill in place. The exact page in the registered shared library must have empty Skill ID/Main File ID and no prior Files, Source, relations or Records lifecycle. Freeze and retain its complete current body, establish stable Skill/main-file identities, and preserve the native page, body, metadata and Enabled=false. No new Skills/Files page or body PATCH is sent. Dry-run reads metadata and the full body without Notion writes. Repeating an existing intent only verifies its original completion; an unknown write is never replayed. Use the returned authoring read, then existing write/update/apply/file commands; update --enabled true explicitly enables a fully verified tree.",
  ),
)
