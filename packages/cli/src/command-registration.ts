import { Effect, Stdio } from "effect"
import { Argument, Command } from "effect/cli"
import type { PlatformError } from "effect/PlatformError"
import { SkillsError, fail } from "@notion-skills-cli/core"

import { upstreamCommand } from "../../core/src/upstream-command.ts"

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
  createCommand,
  applyCommand,
  replaceCommand,
  exportCommand,
  writeCommand,
  resolveCommand,
  updateCommand,
} from "./commands-content.ts"
import { configCommand } from "./commands-configuration.ts"
import { databaseCommand } from "./commands-database.ts"
import { libraryCommand } from "./commands-library.ts"
import { libraryAuditCommand } from "./commands-library-audit.ts"
import { libraryFilesCommand } from "./commands-library-files.ts"
import { libraryResourceCommand } from "./commands-library-resource.ts"
import { repairCommand } from "./commands-maintenance-repair.ts"
import { syncLocalCommand } from "./commands-local-sync.ts"
import { cacheCommand } from "./commands-cache.ts"
import { builtinCommand } from "./commands-builtin.ts"
import { operationCommand, statusCommand, backupCommand } from "./commands-operations.ts"
import { doctorCommand } from "./commands-doctor.ts"
import { apiCommand } from "./commands-api.ts"
import { archiveCommand } from "./commands-archive.ts"
import { prepareCommand } from "./commands-prepare.ts"
import { useCommand } from "./commands-use.ts"
import { adoptCommand } from "./commands-adopt.ts"
import { live, upstreamLive } from "./command-runtime.ts"
const syncCommand = defineCommand("sync").pipe(
  Command.withDescription(
    "Use upstream for source subscriptions and local for page-directory bindings. Connect establishes the relationship and performs its first run. Status and check inspect the selected scope; run applies the next synchronization workflow. Recover an interruption using its exact original operation ID.",
  ),
  Command.withSubcommands([
    withRuntime(syncLocalCommand, live),
    withRuntime(
      upstreamCommand((value) => emit(value as object)),
      upstreamLive,
    ),
  ]),
)
// Root compatibility paths and canonical ctl paths share these exact runtime
// commands. unlisted changes discovery only, never their parser or handlers.
function advanced<Name extends string, Input, ContextInput, E, R>(
  command: Command.Command<Name, Input, ContextInput, E, R>,
) {
  return { command, compatibility: command.pipe(Command.unlisted) }
}
const advancedCommands = [
  advanced(withRuntime(viewsCommand.pipe(withConstraints([readPolicyConstraint])), live)),
  advanced(withRuntime(prepareCommand, live)),
  advanced(withRuntime(resolveCommand, live)),
  advanced(withRuntime(operationCommand, upstreamLive)),
  advanced(syncCommand),
]
const ctlCommand = defineCommand("ctl").pipe(
  Command.withDescription(
    "Manage setup, libraries, sources, Views, synchronization and original-operation recovery. Prepare exposes advanced graph/session/budget controls; resolve inspects relative references. Status reports recorded local state, not current remote health. Use ctl COMMAND --help or schema ctl COMMAND for exact parameters.",
  ),
  Command.withSubcommands([
    withRuntime(libraryCommand, live),
    withRuntime(libraryAuditCommand, live),
    withRuntime(libraryFilesCommand, live),
    withRuntime(libraryResourceCommand, live),
    withRuntime(repairCommand, live),
    withRuntime(databaseCommand, upstreamLive),
    withRuntime(configCommand, upstreamLive),
    withRuntime(cacheCommand, upstreamLive),
    builtinCommand,
    withRuntime(statusCommand, upstreamLive),
    withRuntime(doctorCommand, upstreamLive),
    withRuntime(apiCommand, live),
    withRuntime(archiveCommand, live),
    withRuntime(backupCommand, upstreamLive),
    ...advancedCommands.map(({ command }) => command),
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
    "Emit command types, occurrence bounds and defaults from the same parser AST. Without a path, show the daily surface; has_subcommands marks on-demand trees. Supply an exact command path for its complete schema, including unlisted author and compatibility paths.",
  ),
)

const rootDefinition = () =>
  defineCommand("ntn-skills").pipe(
    Command.withDescription(
      "Discover Notion Skills with list --query, inspect original text or an exact resource with read, and load one root plus its complete Requires with use. Keep returned canonical refs for later resource reads. Files and export provide optional inventories and packages. Authoring is available on demand through create/adopt/write/update and pinned apply/replace; inspect exact disabled drafts with read --authoring and enable a verified tree with update --enabled true. Use COMMAND --help or the bundled maintenance Skill. Manage libraries, sources, Views, preparation, synchronization and original operations with ctl. Help/schema work offline. Loading instructions does not execute them or attest delivery; preserve an interrupted operation's exact next.argv.",
    ),
    Command.withExamples([
      {
        command: "ntn-skills list",
        description: "Discover skill names, descriptions and refs without loading bodies",
      },
      {
        command: "ntn-skills read 'skill://resource-tag-governance/SKILL.md'",
        description: "Inspect the original text and retain the returned pinned ref",
      },
      {
        command: "ntn-skills use 'skill://resource-tag-governance/SKILL.md'",
        description: "Load one root and every Requires instruction",
      },
      {
        command: "ntn-skills read vocabulary.md --from 'PINNED_REF'",
        description: "Read an attachment; replace PINNED_REF with the previous read's ref",
      },
      {
        command: "ntn-skills ctl builtin read notion/ntn-skills-maintain",
        description: "Read the bundled maintenance workflow without connecting to Notion",
      },
      {
        command: "ntn-skills ctl --help",
        description: "Discover management and original-operation recovery",
      },
    ]),
    Command.withSubcommands([
      withRuntime(
        listCommand.pipe(withConstraints([readPolicyConstraint, viewSelectionConstraint])),
        live,
      ),
      ctlCommand,
      withRuntime(readCommand.pipe(withConstraints(readConstraints)), live),
      withRuntime(useCommand, live),
      withRuntime(filesCommand.pipe(withConstraints(filesConstraints)), live),
      withRuntime(createCommand, live).pipe(Command.unlisted),
      withRuntime(adoptCommand, live).pipe(Command.unlisted),
      withRuntime(applyCommand, live).pipe(Command.unlisted),
      withRuntime(replaceCommand, live).pipe(Command.unlisted),
      withRuntime(exportCommand.pipe(withConstraints(exportConstraints)), live),
      withRuntime(writeCommand, live).pipe(Command.unlisted),
      withRuntime(updateCommand, live).pipe(Command.unlisted),
      ...advancedCommands.map(({ compatibility }) => compatibility),
      schemaCommand,
    ]),
  )
export const root = rootDefinition()
