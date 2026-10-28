import { Context, Option } from "effect"
import { Command, Param, Primitive } from "effect/cli"
import { pageId, parseTarget } from "./ref.ts"

class Parameters extends Context.Service<Parameters, readonly object[]>()(
  "ntn-skills/CommandParameters",
) {}
export class Constraints extends Context.Service<Constraints, readonly CommandConstraint[]>()(
  "ntn-skills/CommandConstraints",
) {}
export interface ExclusiveFlags {
  readonly kind: "mutually_exclusive"
  readonly flags: readonly string[]
}
export type CommandConstraint =
  | ExclusiveFlags
  | { readonly kind: "exactly_one"; readonly flags: readonly string[] }
  | { readonly kind: "requires_absent"; readonly flag: string; readonly absent: readonly string[] }
  | { readonly kind: "allowed_values"; readonly flag: string; readonly values: readonly string[] }
  | { readonly kind: "exact_target"; readonly target: string }
  | {
      readonly kind: "pinned_target_policy"
      readonly target: string
      readonly from?: string
      readonly absent: readonly string[]
    }
export function exclusiveFlags(flags: readonly string[]): ExclusiveFlags {
  return { kind: "mutually_exclusive", flags }
}
function present(value: unknown): boolean {
  return Option.isOption(value)
    ? Option.isSome(value)
    : Array.isArray(value)
      ? value.length > 0
      : value !== undefined && value !== false
}
export function enforceConstraint(
  constraint: CommandConstraint,
  values: Readonly<Record<string, unknown>>,
): boolean {
  switch (constraint.kind) {
    case "exact_target": {
      const value = values[constraint.target]
      const actual = Option.isOption(value) ? Option.getOrUndefined(value) : value
      if (actual === undefined) return true
      const target = parseTarget(String(actual))
      return (
        Boolean(target.snapshot || pageId(target.selector)) &&
        (!target.path || ["SKILL.md", "ROUTER.md", "PROMPT.md"].includes(target.path))
      )
    }
    case "pinned_target_policy": {
      const containing = constraint.from === undefined ? undefined : values[constraint.from]
      const from = Option.isOption(containing) ? Option.getOrUndefined(containing) : containing
      const target = parseTarget(String(from ?? values[constraint.target]))
      return !target.snapshot || constraint.absent.every((name) => !present(values[name]))
    }
    case "mutually_exclusive":
      return constraint.flags.filter((name) => present(values[name])).length <= 1
    case "exactly_one":
      return constraint.flags.filter((name) => present(values[name])).length === 1
    case "requires_absent":
      return (
        !present(values[constraint.flag]) ||
        constraint.absent.every((name) => !present(values[name]))
      )
    case "allowed_values": {
      const value = values[constraint.flag]
      const actual = Option.isOption(value) ? Option.getOrUndefined(value) : value
      return actual === undefined || constraint.values.includes(actual as string)
    }
  }
}
export const enforceExclusive = enforceConstraint
export const withConstraints = (constraints: readonly CommandConstraint[]) =>
  Command.annotate(Constraints, constraints)
type Node =
  | Param.Single<Param.ParamKind, unknown>
  | Param.Map<Param.ParamKind, unknown, unknown>
  | Param.Transform<Param.ParamKind, unknown, unknown>
  | Param.Optional<Param.ParamKind, unknown>
  | Param.Variadic<Param.ParamKind, unknown>
function parameterSchema(param: Param.Any): object {
  let node = param as Node
  let min = 1
  let max: number | null = 1
  let absent: unknown = undefined
  const maps: ((value: unknown) => unknown)[] = []
  while (node._tag !== "Single") {
    if (node._tag === "Optional") {
      min = 0
      absent = Option.none()
    }
    if (node._tag === "Variadic") {
      min = Option.getOrElse(node.min, () => 0)
      max = Option.getOrElse(node.max, () => null)
      if (min === 0) absent = []
    }
    if (node._tag === "Map") maps.push(node.f)
    node = node.param as Node
  }
  // Evaluate only the same pure mapping that the parser applies to absent input.
  if (min === 0) for (const map of maps.reverse()) absent = map(absent)
  const defaultValue = Option.isOption(absent) ? Option.getOrUndefined(absent) : absent
  return {
    name: node.name,
    kind: node.kind,
    type: Primitive.getTypeName(node.primitiveType),
    primitive: node.primitiveType._tag,
    description: Option.getOrUndefined(node.description),
    aliases: node.aliases,
    required: min > 0,
    min_occurrences: min,
    max_occurrences: max,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
    ...(node.optionalValue === undefined ? {} : { bare_value: node.optionalValue }),
  }
}
/** The same config object is consumed once by official Command.make and its machine projection. */
export const defineCommand: typeof Command.make = ((...args: unknown[]) => {
  const command = (Command.make as (...args: unknown[]) => Command.Command.Any)(...args)
  const parameters: object[] = []
  const visit = (value: unknown): void => {
    if (Param.isParam(value)) parameters.push(parameterSchema(value))
    else if (value && typeof value === "object")
      for (const child of Object.values(value)) visit(child)
  }
  visit(args[1])
  return command.pipe(Command.annotate(Parameters, parameters))
}) as typeof Command.make

export function commandSchema(command: Command.Command.Any): object {
  return {
    name: command.name,
    description: command.description,
    parameters: Context.getOption(command.annotations, Parameters).pipe(Option.getOrElse(() => [])),
    constraints: Context.getOption(command.annotations, Constraints).pipe(
      Option.getOrElse(() => []),
    ),
    commands: command.subcommands.flatMap((group) => group.commands.map(commandSchema)),
  }
}
export function selectCommand(
  command: Command.Command.Any,
  path: readonly string[],
): Command.Command.Any | undefined {
  let current = command
  for (const name of path) {
    const child = current.subcommands
      .flatMap((group) => group.commands)
      .find((child) => child.name === name)
    if (!child) return undefined
    current = child
  }
  return current
}
