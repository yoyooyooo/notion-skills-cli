import { Context, Effect, Layer, Option, Stdio, Stream } from "effect"
import { Command, Flag } from "effect/cli"

import { SkillsError, configuration, fail, parseDuration } from "@notion-skills-cli/core"
import type { ReadPolicyOptions } from "@notion-skills-cli/core"
import type { PublicationOptions } from "@notion-skills-cli/core"

import {
  enforceExclusive,
  enforceConstraint,
  exclusiveFlags,
  Constraints,
  type CommandConstraint,
} from "../../core/src/command-schema.ts"

export const viewSelectionConstraint = exclusiveFlags(["view", "defaultView"])
export const readPolicyConstraint = exclusiveFlags(["refresh", "offline", "maxAge"])
export const pinnedPolicyConstraint: CommandConstraint = {
  kind: "pinned_target_policy",
  target: "selector",
  from: "from",
  absent: ["refresh", "maxAge"],
}
export const filesConstraints: readonly CommandConstraint[] = [
  readPolicyConstraint,
  pinnedPolicyConstraint,
]
export const readConstraints: readonly CommandConstraint[] = [
  ...filesConstraints,
  exclusiveFlags(["raw", "output"]),
  exclusiveFlags(["lines", "output"]),
  exclusiveFlags(["from", "path"]),
]
export const syncFromConstraint: CommandConstraint = {
  kind: "allowed_values",
  flag: "from",
  values: ["local", "notion"],
}
export const planConstraints: readonly CommandConstraint[] = [
  { kind: "exactly_one", flags: ["binding", "all"] },
  { kind: "requires_absent", flag: "all", absent: ["from"] },
  syncFromConstraint,
]
export const cacheClearConstraints: readonly CommandConstraint[] = [
  { kind: "exactly_one", flags: ["target", "all"] },
  { kind: "requires_absent", flag: "all", absent: ["database"] },
]
export const exportConstraints: readonly CommandConstraint[] = [
  ...filesConstraints,
  { kind: "allowed_values", flag: "format", values: ["zip", "directory"] },
  { kind: "allowed_values", flag: "projection", values: ["source", "snapshot"] },
]
export const exactTargetConstraint: CommandConstraint = { kind: "exact_target", target: "target" }
export const memberConstraint = exclusiveFlags(["member", "clear-members"])
export function validateConstraints(
  constraints: readonly CommandConstraint[],
  values: Readonly<Record<string, unknown>>,
) {
  return Effect.forEach(constraints, (constraint) =>
    Effect.try({
      try: () => {
        if (!enforceConstraint(constraint, values))
          throw fail("INVALID_ARGUMENT", "Command parameters violate a declared constraint.", {
            constraint,
          })
      },
      catch: (error) => error as SkillsError,
    }),
  )
}
export function withRuntime<Name extends string, Input, ContextInput, Error, Requirements, L, E, R>(
  command: Command.Command<Name, Input, ContextInput, Error, Requirements>,
  layer: Layer.Layer<L, E, R>,
): Command.Command<
  Name,
  Input,
  ContextInput,
  Error | E | SkillsError,
  Exclude<Requirements, L> | R
> {
  if (command.subcommands.length)
    return command.pipe(
      Command.withSubcommands(
        command.subcommands.flatMap<Command.Command.SubcommandEntry>((group) =>
          group.group === undefined
            ? group.commands.map((child) => withRuntime(child, layer))
            : [
                {
                  group: group.group,
                  commands: group.commands.map((child) => withRuntime(child, layer)),
                },
              ],
        ),
      ),
    ) as unknown as Command.Command<
      Name,
      Input,
      ContextInput,
      Error | E | SkillsError,
      Exclude<Requirements, L> | R
    >
  const constraints = Context.getOption(command.annotations, Constraints).pipe(
    Option.getOrElse(() => []),
  )
  return command.pipe(
    Command.provide(layer),
    Command.provideEffectDiscard((input) =>
      validateConstraints(constraints, input as Readonly<Record<string, unknown>>),
    ),
  )
}
export const requiredDatabaseFlag = Flag.String("database").pipe(
  Flag.between(1, 1),
  Flag.map((values) => values[0]!),
  Flag.withDescription(
    "One Skills Database ID, URL or exact registered alias; repeated --database is rejected",
  ),
)
export const databaseFlag = Flag.String("database").pipe(
  Flag.atMost(1),
  Flag.map((values) => Option.fromUndefinedOr(values[0])),
  Flag.withDescription(
    "Restrict to one Skills Database ID, URL or exact registered alias; repeated --database is rejected",
  ),
)
export const singleton = (name: string, description: string) =>
  Flag.String(name).pipe(
    Flag.atMost(1),
    Flag.map((values) => Option.fromUndefinedOr(values[0])),
    Flag.withDescription(description),
  )
export const requiredSingleton = (name: string, description: string) =>
  Flag.String(name).pipe(
    Flag.between(1, 1),
    Flag.map((values) => values[0]!),
    Flag.withDescription(description),
  )
export const switchFlag = (name: string, description: string) =>
  Flag.Boolean(name).pipe(
    Flag.atMost(1),
    Flag.map((values) => values[0] ?? false),
    Flag.withDescription(description),
  )
export const refreshFlag = switchFlag("refresh", "Validate online regardless of cache age")
export const readPolicyFlags = {
  refresh: refreshFlag,
  offline: switchFlag("offline", "Read local observations only, including expired content"),
  maxAge: singleton(
    "max-age",
    "Maximum observation age: 0, Ns, Nm, Nh or Nd; default 5m (list 60s)",
  ),
}
export function readPolicy(config: {
  refresh: boolean
  offline: boolean
  maxAge: Option.Option<string>
}) {
  return Effect.try({
    try: (): ReadPolicyOptions => {
      const maxAge = Option.getOrUndefined(config.maxAge)
      if (!enforceExclusive(readPolicyConstraint, config))
        throw fail("INVALID_ARGUMENT", "--refresh, --offline and --max-age are mutually exclusive.")
      return {
        refresh: config.refresh,
        offline: config.offline,
        ...(maxAge === undefined ? {} : { maxAge: parseDuration(maxAge) }),
      }
    },
    catch: (error) => error as SkillsError,
  })
}

export function emit(value: object) {
  return Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    const result = Array.isArray(value) ? { ok: true, items: value } : { ok: true, ...value }
    yield* Stream.make(JSON.stringify(result) + "\n").pipe(Stream.run(stdio.stdout()))
  })
}

export const progressFlag = switchFlag(
  "progress",
  "Emit publication stage and timing events as JSONL on stderr",
)
export const publicationOptions = (enabled: boolean) =>
  Effect.gen(function* () {
    if (!enabled) return {} satisfies PublicationOptions
    const stdio = yield* Stdio.Stdio
    return {
      onProgress: (event) =>
        Stream.make(JSON.stringify(event) + "\n").pipe(
          Stream.run(stdio.stderr()),
          Effect.mapError(() =>
            fail("PROGRESS_OUTPUT_FAILED", "Could not write publication progress."),
          ),
        ),
    } satisfies PublicationOptions
  })

export const dryRunFlag = switchFlag(
  "dry-run",
  "Validate inputs and show the decision without content or configuration writes",
)
export const memberFlags = {
  member: Flag.String("member").pipe(
    Flag.atLeast(0),
    Flag.withDescription(
      "Exact content Skill ID or ref for Router Members; repeat for multiple Skills in the same database",
    ),
  ),
  "clear-members": switchFlag(
    "clear-members",
    "Clear Router Members; mutually exclusive with --member",
  ),
}
