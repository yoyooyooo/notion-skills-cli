import { Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"

import {
  Notion,
  SkillsError,
  catalog,
  fail,
  builtinStatus,
  installBuiltin,
  updateBuiltin,
  exportBuiltin,
  publishBuiltin,
  readBuiltin,
  selectBuiltin,
} from "@notion-skills-cli/core"

import { builtins } from "./builtins.ts"
import { defineCommand, withConstraints } from "../../core/src/command-schema.ts"
import { localRuntime, storeRuntime, upstreamLive } from "./command-runtime.ts"

import {
  exactTargetConstraint,
  validateConstraints,
  databaseFlag,
  singleton,
  requiredSingleton,
  emit,
  progressFlag,
  publicationOptions,
  dryRunFlag,
  withRuntime,
} from "./command-options.ts"
export const builtinArgument = Argument.String("id").pipe(
  Argument.withDescription("Exact package ID from builtin list, e.g. notion/ntn-skills-maintain"),
)
export const selectedBuiltin = (id: string) =>
  Effect.try({
    try: () => selectBuiltin(builtins, id),
    catch: (error) => error as SkillsError,
  })
export const builtinAgentDirs = Flag.String("agent-dir").pipe(
  Flag.atLeast(0),
  Flag.withDescription(
    "Additional agent root for skills/<builtin-name> links; repeat for multiple agents. Defaults include ~/.agents",
  ),
)
export const builtinListCommand = defineCommand("list", { agentDirs: builtinAgentDirs }, (config) =>
  Effect.gen(function* () {
    yield* emit(yield* builtinStatus(builtins, config.agentDirs))
  }),
).pipe(
  Command.withShortDescription(
    "List optional project-maintained built-ins offline; no remote discovery",
  ),
)
export const builtinStatusCommand = defineCommand(
  "status",
  { id: builtinArgument.pipe(Argument.optional), agentDirs: builtinAgentDirs },
  (config) =>
    Effect.gen(function* () {
      const skills = Option.isSome(config.id) ? [yield* selectedBuiltin(config.id.value)] : builtins
      yield* emit(yield* builtinStatus(skills, config.agentDirs))
    }),
).pipe(
  Command.withShortDescription("Inspect complete installed files and transaction state offline"),
)
export const builtinInstallCommand = defineCommand(
  "install",
  { id: builtinArgument, agentDirs: builtinAgentDirs },
  (config) =>
    Effect.gen(function* () {
      yield* emit(yield* installBuiltin(yield* selectedBuiltin(config.id), config.agentDirs))
    }),
).pipe(Command.withShortDescription("Install a built-in centrally and link it to selected agents"))
export const builtinUpdateCommand = defineCommand(
  "update",
  { id: builtinArgument, agentDirs: builtinAgentDirs },
  (config) =>
    Effect.gen(function* () {
      yield* emit(yield* updateBuiltin(yield* selectedBuiltin(config.id), config.agentDirs))
    }),
).pipe(
  Command.withShortDescription(
    "Replace a clean registered built-in and retain its prior tree in Trash",
  ),
)
export const builtinReadCommand = defineCommand(
  "read",
  {
    id: builtinArgument,
    path: singleton("path", "One bundled file, default SKILL.md; relative to this built-in"),
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit(
        yield* readBuiltin(yield* selectedBuiltin(config.id), Option.getOrUndefined(config.path)),
      )
    }),
).pipe(Command.withShortDescription("Read one packaged built-in file offline"))
export const builtinExportCommand = defineCommand(
  "export",
  {
    id: builtinArgument,
    output: requiredSingleton(
      "output",
      "New Skill directory or ZIP path; differing output is rejected",
    ),
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit(yield* exportBuiltin(yield* selectedBuiltin(config.id), config.output))
    }),
).pipe(Command.withShortDescription("Export a built-in for an explicitly chosen host installation"))
export const builtinPublishCommand = defineCommand(
  "publish",
  {
    id: builtinArgument,
    database: databaseFlag,
    target: singleton(
      "target",
      "Existing page ID/URL, page-ID main ref or snapshot; names cannot select an update",
    ),
    dryRun: dryRunFlag,
    progress: progressFlag,
  },
  (config) =>
    Effect.gen(function* () {
      yield* validateConstraints([exactTargetConstraint], config)
      yield* emit(
        yield* publishBuiltin(yield* selectedBuiltin(config.id), {
          database: Option.getOrUndefined(config.database),
          target: Option.getOrUndefined(config.target),
          dryRun: config.dryRun,
          ...(yield* publicationOptions(config.progress)),
        }),
      )
    }),
).pipe(
  withConstraints([exactTargetConstraint]),
  Command.withShortDescription(
    "Publish one optional built-in; name collisions fail unless an exact update target is selected",
  ),
  Command.withDescription(
    "First publication uses create semantics: --database > config.builtin_database > config.default_database > sole discovered database. Same-name pages fail with CREATE_CONFLICT. --target replaces one exact existing page using version checks; page identity owns the destination. Writes Source Type=builtin and the exact Builtin ID through the guarded publication; initialize missing fields with ctl database init. Identical content with missing or different origin receives only the journaled metadata update, and a fully matching repeat performs no remote writes. Publisher metadata describes package input. Preview with --dry-run, use --progress for stage/timing JSONL, and operation resume OPERATION_ID for guarded continuation of retained input.",
  ),
)
export const builtinCommand = defineCommand("builtin").pipe(
  Command.withShortDescription(
    "Read, install, update, export or explicitly publish official ntn-skills Skills",
  ),
  Command.withDescription(
    "Project-maintained package catalog under skills/notion, separate from ordinary Notion list/read. IDs are exact notion/<name>; origin=builtin and publisher=ntn-skills describe package bytes only, not Notion, Inc. endorsement. No registration, installation or remote mutation occurs automatically.",
  ),
  Command.withSubcommands([
    withRuntime(builtinListCommand, localRuntime),
    withRuntime(builtinStatusCommand, localRuntime),
    withRuntime(builtinInstallCommand, localRuntime),
    withRuntime(builtinUpdateCommand, localRuntime),
    withRuntime(builtinReadCommand, localRuntime),
    withRuntime(builtinExportCommand, storeRuntime),
    withRuntime(builtinPublishCommand, upstreamLive),
  ]),
)
