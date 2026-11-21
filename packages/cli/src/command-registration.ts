import { Effect, Stdio } from "effect"
import { Argument, Command } from "effect/cli"
import type { PlatformError } from "effect/PlatformError"
import { SkillsError, fail } from "@notion-skills-cli/core"

import {
  defineCommand,
  commandSchema,
  selectCommand,
  withConstraints,
} from "../../core/src/command-schema.ts"

import {
  readPolicyConstraint,
  viewSelectionConstraint,
  filesConstraints,
  readConstraints,
  exportConstraints,
  withRuntime,
  emit,
} from "./command-options.ts"
import {
  listCommand,
  viewsCommand,
  readCommand,
  filesCommand,
  exportCommand,
  resolveCommand,
} from "./commands-content.ts"
import { configCommand } from "./commands-configuration.ts"
import { libraryCommand } from "./commands-library.ts"
import { cacheCommand } from "./commands-cache.ts"
import { builtinCommand } from "./commands-builtin.ts"
import { doctorCommand } from "./commands-doctor.ts"
import { apiCommand } from "./commands-api.ts"
import { prepareCommand } from "./commands-prepare.ts"
import { useCommand } from "./commands-use.ts"
import { live } from "./command-runtime.ts"
const ctlCommand = defineCommand("ctl").pipe(
  Command.withDescription(
    "Import a complete current Skill tree, manage current Source contributions, eligibility and file authority, inspect the library, manage current Profiles and local configuration, or diagnose a specific request. Resume uses the same current command and exact intent; supersede explicitly names the unfinished predecessor and a distinct new operation. Publication, historical snapshot, repair and compatibility routes are not available.",
  ),
  Command.withSubcommands([
    withRuntime(libraryCommand, live),
    withRuntime(configCommand, live),
    withRuntime(cacheCommand, live),
    builtinCommand,
    withRuntime(doctorCommand, live),
    withRuntime(apiCommand, live),
    withRuntime(viewsCommand.pipe(withConstraints([readPolicyConstraint])), live),
    withRuntime(prepareCommand, live),
    withRuntime(resolveCommand, live),
  ]),
)
const schemaCommand = defineCommand(
  "schema",
  { path: Argument.String("command").pipe(Argument.variadic()) },
  ({ path }): Effect.Effect<void, SkillsError | PlatformError, Stdio.Stdio> => {
    const selected = selectCommand(rootDefinition(), path)
    return selected
      ? emit({
          format: "effect-cli-schema",
          version: 1,
          command: path,
          schema: commandSchema(selected, path.length === 0 ? { depth: 1 } : {}),
        })
      : Effect.fail(fail("INVALID_ARGUMENT", "Unknown command path.", { command: path }))
  },
).pipe(
  Command.withDescription(
    "Emit command types, occurrence bounds and defaults from the same parser AST. Without a path, show the daily surface; has_subcommands marks on-demand trees. Supply an exact command path for its complete schema, without legacy aliases.",
  ),
)

const rootDefinition = () =>
  defineCommand("ntn-skills").pipe(
    Command.withDescription(
      "Read the current Notion Skill library. list discovers candidates; read inspects exact files; use expands Requires; files returns the complete directory; export writes selected current bytes locally. Ordinary consumption never writes Notion. Manage complete trees with ctl library import, Source declarations and lifecycle with ctl library source, and Profiles with ctl library profile. Missing current Content descriptors require an explicit data cutover.",
    ),
    Command.withSubcommands([
      withRuntime(
        listCommand.pipe(withConstraints([readPolicyConstraint, viewSelectionConstraint])),
        live,
      ),
      ctlCommand,
      withRuntime(readCommand.pipe(withConstraints(readConstraints)), live),
      withRuntime(useCommand, live),
      withRuntime(filesCommand.pipe(withConstraints(filesConstraints)), live),
      withRuntime(exportCommand.pipe(withConstraints(exportConstraints)), live),
      schemaCommand,
    ]),
  )
export const root = rootDefinition()
