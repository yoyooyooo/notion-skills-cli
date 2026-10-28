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
import { syncLocalCommand } from "./commands-local-sync.ts"
import { cacheCommand } from "./commands-cache.ts"
import { builtinCommand } from "./commands-builtin.ts"
import { operationCommand, statusCommand, backupCommand } from "./commands-operations.ts"
import { doctorCommand } from "./commands-doctor.ts"
import { live, upstreamLive } from "./command-runtime.ts"
const ctlCommand = defineCommand("ctl").pipe(
  Command.withDescription(
    "Inspect local setup with status, diagnose access with doctor, and manage configuration, registered databases, cache and bundled Skills. Status reports local configuration and recorded operations; it does not establish current remote content health.",
  ),
  Command.withSubcommands([
    withRuntime(databaseCommand, upstreamLive),
    withRuntime(configCommand, upstreamLive),
    withRuntime(cacheCommand, upstreamLive),
    builtinCommand,
    withRuntime(statusCommand, upstreamLive),
    withRuntime(doctorCommand, upstreamLive),
    withRuntime(backupCommand, upstreamLive),
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
          schema: commandSchema(selected),
        })
      : Effect.fail(fail("INVALID_ARGUMENT", "Unknown command path.", { command: path }))
  },
).pipe(
  Command.withDescription(
    "Emit command types, occurrence bounds and defaults from the same official parameter AST used by the parser.",
  ),
)

const rootDefinition = () =>
  defineCommand("ntn-skills").pipe(
    Command.withDescription(
      "Discover with list, then read one exact target and keep its pinned ref for supporting files. Create new content with create and submit one pinned file/metadata change with apply. Use the bundled maintenance Skill for the complete workflow. Connect a Git source with sync upstream connect or a page/directory with sync local connect, then use the corresponding run command. If an operation stops, inspect its original ID with operation show and follow the returned next.argv; operation resume continues that same operation. Use ctl for setup and diagnostics. Help and schema work offline; reads and previews never execute Skill content.",
    ),
    Command.withExamples([
      {
        command: "ntn-skills list",
        description: "Discover skill names, descriptions and refs without loading bodies",
      },
      {
        command: "ntn-skills read 'skill://resource-tag-governance/SKILL.md'",
        description: "Activate one skill and retain the returned pinned ref",
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
        command: "ntn-skills apply PINNED_MAIN_REF --input ./changed-files",
        description: "Publish one file/metadata change against the version returned by read",
      },
      {
        command: "ntn-skills sync upstream connect SOURCE --database LIBRARY",
        description: "Register or reuse a Git subscription and synchronize its selected members",
      },
      {
        command: "ntn-skills sync local connect PAGE_ID --path ./local-skill",
        description: "Connect an existing page to a local directory and synchronize it",
      },
      {
        command: "ntn-skills operation show OPERATION_ID",
        description: "Inspect the original result and its exact next action before recovery",
      },
      {
        command: "ntn-skills schema sync upstream run",
        description: "Inspect accepted parameters offline before running a subscription",
      },
    ]),
    Command.withSubcommands([
      withRuntime(
        listCommand.pipe(withConstraints([readPolicyConstraint, viewSelectionConstraint])),
        live,
      ),
      withRuntime(viewsCommand.pipe(withConstraints([readPolicyConstraint])), live),
      ctlCommand,
      withRuntime(readCommand.pipe(withConstraints(readConstraints)), live),
      withRuntime(filesCommand.pipe(withConstraints(filesConstraints)), live),
      withRuntime(createCommand, live),
      withRuntime(applyCommand, live),
      withRuntime(replaceCommand, live),
      withRuntime(exportCommand.pipe(withConstraints(exportConstraints)), live),
      withRuntime(writeCommand, live),
      withRuntime(updateCommand, live),
      withRuntime(operationCommand, upstreamLive),
      defineCommand("sync").pipe(
        Command.withDescription(
          "Use upstream for source subscriptions and local for page-directory bindings. Connect establishes the relationship and performs its first run. Status and check inspect the selected scope; run applies the next synchronization workflow. Use the exact returned operation ID to recover an interrupted result instead of starting another write.",
        ),
        Command.withSubcommands([
          withRuntime(syncLocalCommand, live),
          withRuntime(
            upstreamCommand((value) => emit(value as object)),
            upstreamLive,
          ),
        ]),
      ),
      withRuntime(resolveCommand, live),
      schemaCommand,
    ]),
  )
export const root = rootDefinition()
