import { resolve } from "node:path"
import { Cause, ConfigProvider, Effect, Exit, Layer, Option } from "effect"
import { version } from "../package.json"
import {
  consume as coreConsume,
  decodeConsumeInput,
  decodeConsumeResult as coreDecodeConsumeResult,
  type ConsumeOptions as CoreConsumeOptions,
} from "../../core/src/consumer.ts"
import {
  CONSUMER_CONTRACT_VERSION,
  type ConsumeInput,
  type ConsumeResult,
} from "../../core/src/consumer-model.ts"
import { fail, SkillsError } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import type { RequestMetricsSnapshot } from "../../core/src/request-metrics.ts"
import { readSkill as coreReadSkill, type ReadOptions } from "../../core/src/snapshot.ts"
import { localRuntime, live, nodeRuntime } from "./runtime.ts"

export const SDK_VERSION = 1
export const PACKAGE_VERSION = version
export {
  CONSUMER_CONTRACT_VERSION,
  SOURCE_IDENTITY_COMPILER,
} from "../../core/src/consumer-model.ts"
export type {
  ConsumeInput,
  ConsumeResult,
  ConsumeReady,
  ConsumeEntry,
  VerifiedManifest,
} from "../../core/src/consumer-model.ts"
export { SkillsError } from "../../core/src/model.ts"
export { parseDuration } from "../../core/src/cache.ts"
export type { RequestMetricsSnapshot } from "../../core/src/request-metrics.ts"

export interface SdkOptions {
  /** Complete environment for this operation; omission captures process.env at invocation. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Relative configuration roots and outputs resolve here, without process.chdir. */
  readonly cwd?: string
  readonly signal?: AbortSignal
  /** Enable the existing bounded safe request trace (default limit 10000). */
  readonly metrics?: boolean
  /** Called once after scope cleanup. null means the Notion service was not acquired. */
  readonly onRequestMetrics?: (snapshot: RequestMetricsSnapshot | null) => void
}

export type ConsumeOptions = SdkOptions & Omit<CoreConsumeOptions, "signal">
export type ReadSkillOptions = SdkOptions & ReadOptions
export type ReadSkillResult = Effect.Success<ReturnType<typeof coreReadSkill>>

const cancelled = () => fail("CANCELLED", "The SDK operation was cancelled.")

async function runOperation<A>(
  operation: () => Effect.Effect<A, SkillsError, Layer.Success<typeof live>>,
  options: SdkOptions,
): Promise<A> {
  let requestMetrics: (() => RequestMetricsSnapshot) | undefined
  try {
    if (options.signal?.aborted) throw cancelled()
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(options.env ?? process.env))
      if (value !== undefined) env[key] = value
    if (options.metrics && env.NTN_SKILLS_REQUEST_TRACE_LIMIT === undefined)
      env.NTN_SKILLS_REQUEST_TRACE_LIMIT = "10000"
    const cwd = resolve(options.cwd ?? ".")
    const effect = operation()
    const program = Effect.gen(function* () {
      requestMetrics = (yield* Notion).requestMetrics
      return yield* effect
    }).pipe(
      Effect.provide(nodeRuntime(cwd).live),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
      Effect.scoped,
    )
    const result = await Effect.runPromiseExit(program, { signal: options.signal })
    if (options.signal?.aborted) throw cancelled()
    if (Exit.isSuccess(result)) return result.value
    const error = Option.getOrUndefined(Cause.findErrorOption(result.cause))
    throw error ?? Cause.squash(result.cause)
  } finally {
    options.onRequestMetrics?.(requestMetrics?.() ?? null)
  }
}

/** One preparation and one verified receipt; this never loops over readSkill. */
export async function consume(
  input: unknown,
  options: ConsumeOptions = {},
): Promise<ConsumeResult> {
  try {
    return await runOperation(
      () =>
        coreConsume(decodeConsumeInput(input), {
          database: options.database,
          execution: options.execution,
          metrics: options.metrics,
        }),
      options,
    )
  } catch (error) {
    if (!(error instanceof SkillsError)) throw error
    if (error.code === "CANCELLED")
      return { version: CONSUMER_CONTRACT_VERSION, status: "cancelled", reason: "interrupted" }
    return {
      version: CONSUMER_CONTRACT_VERSION,
      status: "failed",
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    }
  }
}

/** Pure proof validation using the same decoder as consume; no Store or HTTP service. */
export async function decodeConsumeResult(
  value: unknown,
  expected?: ConsumeInput,
): Promise<ConsumeResult> {
  const result = await Effect.runPromiseExit(
    coreDecodeConsumeResult(value, expected).pipe(Effect.provide(localRuntime)),
  )
  if (Exit.isSuccess(result)) return result.value
  throw Option.getOrUndefined(Cause.findErrorOption(result.cause)) ?? Cause.squash(result.cause)
}

/** Core read shape, without the CLI ok wrapper. Fixed File refs preserve the same checks. */
export function readSkill(
  target: string,
  options: ReadSkillOptions = {},
): Promise<ReadSkillResult> {
  return runOperation(
    () =>
      coreReadSkill(target, {
        database: options.database,
        path: options.path,
        from: options.from,
        lines: options.lines,
        output: options.output,
        refresh: options.refresh,
        offline: options.offline,
        maxAge: options.maxAge,
      }),
    options,
  )
}
