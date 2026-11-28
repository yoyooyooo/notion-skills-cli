#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Cause, Effect, Layer, Option, Stdio, Stream } from "effect"
import { CliConfig, CliError, CliOutput, Command, GlobalFlag } from "effect/cli"

import { SkillsError, property } from "@notion-skills-cli/core"

import packageManifest from "../package.json" with { type: "json" }
const { version } = packageManifest
import { root } from "./command-registration.ts"
import { selectCommand } from "../../core/src/command-schema.ts"
import { commandMetrics, CommandMetricsLive } from "./command-metrics.ts"
const args = process.argv.length > 2 ? process.argv.slice(2) : ["--help"]
const helpArgv = () => {
  const path: string[] = []
  for (const name of args) {
    if (!selectCommand(root, [...path, name])) break
    path.push(name)
  }
  return ["ntn-skills", ...path, "--help"]
}
const publicNext = (details: unknown) => {
  const next = property(property(details).next)
  const argv = next.argv
  if (
    !Array.isArray(argv) ||
    argv.length < 2 ||
    argv.length > 128 ||
    argv[0] !== "ntn-skills" ||
    argv.some(
      (value) =>
        typeof value !== "string" || value.length > 8192 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value),
    )
  )
    return undefined
  const path: string[] = []
  for (const value of argv.slice(1)) {
    if (!selectCommand(root, [...path, value])) break
    path.push(value)
  }
  if (!path.length) return undefined
  return {
    argv: [...argv],
    ...(typeof next.reason === "string" ? { reason: next.reason } : {}),
    ...(typeof next.read_only === "boolean" ? { read_only: next.read_only } : {}),
  }
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
      const metrics = yield* commandMetrics
      yield* Stream.make(
        JSON.stringify({
          ok: false,
          error: { code, message, ...(details === undefined ? {} : { details }) },
          ...(metrics === undefined ? {} : { request_metrics: metrics }),
          next: publicNext(details) ?? {
            argv: helpArgv(),
            read_only: true,
            reason:
              "Inspect this command's accepted parameters before retrying. This recommendation does not authorize another write.",
          },
        }) + "\n",
      ).pipe(Stream.run(stdio.stdout()))
      process.exitCode = code === "INVALID_ARGUMENT" ? 2 : 1
    }),
  ),
  Effect.provide(Layer.mergeAll(NodeServices.layer, cliConfiguration, CommandMetricsLive)),
)
NodeRuntime.runMain(program)
