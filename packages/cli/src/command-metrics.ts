import { Context, Effect, Layer, Option } from "effect"
import { Notion } from "@notion-skills-cli/core"
import type { RequestMetricsSnapshot } from "../../core/src/request-metrics.ts"

export class CommandMetrics extends Context.Service<
  CommandMetrics,
  {
    readonly select: (read: (() => RequestMetricsSnapshot) | undefined) => void
    readonly snapshot: () => RequestMetricsSnapshot | undefined
  }
>()("ntn-skills/CommandMetrics") {}

export const CommandMetricsLive = Layer.sync(CommandMetrics, () => {
  let read: (() => RequestMetricsSnapshot) | undefined
  return {
    select: (selected) => {
      read = selected
    },
    snapshot: () => {
      const metrics = read?.()
      return metrics?.trace_enabled ? metrics : undefined
    },
  }
})

export const selectCommandMetrics = Effect.gen(function* () {
  const reporter = yield* Effect.serviceOption(CommandMetrics)
  const api = yield* Effect.serviceOption(Notion)
  if (Option.isSome(reporter) && Option.isSome(api)) reporter.value.select(api.value.requestMetrics)
})

export const commandMetrics = Effect.serviceOption(CommandMetrics).pipe(
  Effect.map((reporter) => (Option.isSome(reporter) ? reporter.value.snapshot() : undefined)),
)
