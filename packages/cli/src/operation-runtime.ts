import { resolve } from "node:path"
import { Cause, ConfigProvider, Effect, Exit, Layer, Option } from "effect"
import { fail, type SkillsError } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import {
  createRequestMetrics,
  type RequestMetricsSnapshot,
} from "../../core/src/request-metrics.ts"
import { nodeRuntime } from "./runtime.ts"

export interface OperationOptions {
  /** Complete environment for this operation; omission captures process.env at invocation. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Relative configuration roots and outputs resolve here, without process.chdir. */
  readonly cwd?: string
  readonly signal?: AbortSignal
  /** Enable the existing bounded safe request trace (default limit 10000). */
  readonly metrics?: boolean
  /** Called once after cleanup; unacquired transport has zero attempts, absent acquired metrics are null. */
  readonly onRequestMetrics?: (snapshot: RequestMetricsSnapshot | null) => void
}

export type OperationServices = Layer.Success<ReturnType<typeof nodeRuntime>["live"]>
const cancelled = () => fail("CANCELLED", "The SDK operation was cancelled.")

/** Shared Promise boundary for explicitly selected consumption or management
 * operations. The operation factory owns its input and capability checks. */
export async function runRuntimeOperation<A>(
  operation: () => Effect.Effect<A, SkillsError, OperationServices>,
  options: OperationOptions,
): Promise<A> {
  let transportAcquired = false
  let traceRequested = options.metrics === true
  let requestMetrics: (() => RequestMetricsSnapshot) | undefined
  try {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(options.env ?? process.env))
      if (value !== undefined) env[key] = value
    if (options.metrics && env.NTN_SKILLS_REQUEST_TRACE_LIMIT === undefined)
      env.NTN_SKILLS_REQUEST_TRACE_LIMIT = "10000"
    traceRequested = Number(env.NTN_SKILLS_REQUEST_TRACE_LIMIT ?? 0) > 0
    if (options.signal?.aborted) throw cancelled()
    const cwd = resolve(options.cwd ?? ".")
    const effect = operation()
    const program = Effect.gen(function* () {
      const notion = yield* Notion
      transportAcquired = true
      requestMetrics = notion.requestMetrics
      return yield* effect
    }).pipe(
      Effect.provide(nodeRuntime(cwd, env).live),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
      Effect.scoped,
    )
    const result = await Effect.runPromiseExit(program, { signal: options.signal })
    if (options.signal?.aborted) throw cancelled()
    if (Exit.isSuccess(result)) return result.value
    const error = Option.getOrUndefined(Cause.findErrorOption(result.cause))
    throw error ?? Cause.squash(result.cause)
  } finally {
    // Every HTTP-capable Effect executes after the Notion acquisition gate.
    // Before that gate, cancellation/failure proves zero attempts; afterwards,
    // absent transport metrics remain unknown rather than becoming zero.
    options.onRequestMetrics?.(
      transportAcquired
        ? (requestMetrics?.() ?? null)
        : createRequestMetrics({ traceLimit: traceRequested ? 10_000 : 0 }).snapshot(),
    )
  }
}
