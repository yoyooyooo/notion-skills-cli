#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Cause, Effect, Layer, Option, Stdio, Stream } from "effect"
import { CliConfig, CliError, CliOutput, Command, GlobalFlag } from "effect/cli"

import { SkillsError } from "@notion-skills-cli/core"

import packageManifest from "../package.json" with { type: "json" }
const { version } = packageManifest
import { root } from "./command-registration.ts"
import { selectCommand } from "../../core/src/command-schema.ts"
const args = process.argv.length > 2 ? process.argv.slice(2) : ["--help"]
const helpArgv = () => {
  const path: string[] = []
  for (const name of args) {
    if (!selectCommand(root, [...path, name])) break
    path.push(name)
  }
  return ["ntn-skills", ...path, "--help"]
}
const formatter = CliOutput.defaultFormatter({ colors: false })
const requestedHelp = args.includes("--help") || args.includes("-h") || args.length === 0
const cliConfiguration = Layer.mergeAll(
  CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.Completions] }),
  CliOutput.layer({
    ...formatter,
    formatHelpDoc: (doc) => (requestedHelp ? formatter.formatHelpDoc(doc) : ""),
  }),
)

const program = Command.runWith(root, { version, renderErrors: false })(args).pipe(
  Effect.catchCause((cause) =>
    Effect.gen(function* () {
      if (Cause.hasInterruptsOnly(cause)) {
        process.exitCode = 130
        return
      }
      const error = Option.getOrUndefined(Cause.findErrorOption(cause))
      if (Cause.hasDies(cause) || !(error instanceof SkillsError || CliError.isCliError(error))) {
        return yield* Effect.failCause(cause)
      }
      const code = error instanceof SkillsError ? error.code : "INVALID_ARGUMENT"
      const parseErrors =
        CliError.isCliError(error) && error._tag === "ShowHelp" ? error.errors : []
      const message = parseErrors.length
        ? parseErrors.map((e) => e.message).join("; ")
        : error.message
      const details =
        error instanceof SkillsError
          ? error.details
          : parseErrors.map((e) => ({ code: e._tag, message: e.message }))
      const stdio = yield* Stdio.Stdio
      yield* Stream.make(
        JSON.stringify({
          ok: false,
          error: { code, message, ...(details === undefined ? {} : { details }) },
          ...(CliError.isCliError(error)
            ? {
                next: {
                  argv: helpArgv(),
                  reason: "Inspect this command's accepted parameters before retrying.",
                },
              }
            : {}),
        }) + "\n",
      ).pipe(Stream.run(stdio.stdout()))
      process.exitCode = code === "INVALID_ARGUMENT" ? 2 : 1
    }),
  ),
  Effect.provide(Layer.mergeAll(NodeServices.layer, cliConfiguration)),
)
NodeRuntime.runMain(program)
