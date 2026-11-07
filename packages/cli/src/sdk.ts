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
import {
  createRequestMetrics,
  type RequestMetricsSnapshot,
} from "../../core/src/request-metrics.ts"
import {
  readSkill as coreReadSkill,
  listSkill as coreListSkill,
  type ReadOptions,
} from "../../core/src/snapshot.ts"
import {
  readResources as coreReadResources,
  decodeResourceReadInput,
  decodeResourceReadResult as coreDecodeResourceReadResult,
  type ResourceReadOptions as CoreResourceReadOptions,
} from "../../core/src/resource-read.ts"
import {
  RESOURCE_READ_CONTRACT_VERSION,
  type ResourceReadInput,
  type ResourceReadResult,
} from "../../core/src/resource-read-model.ts"
import { localRuntime, live, nodeRuntime } from "./runtime.ts"
import {
  listCatalog as coreListCatalog,
  listSkills as coreListSkills,
  validateListPage,
  type ListCatalogOptions as CoreListCatalogOptions,
  type ListCatalogDirectoryOptions as CoreListCatalogDirectoryOptions,
  type ListSkillsOptions as CoreListSkillsOptions,
  type ListCatalogResult,
  type ListCatalogDirectoryResult,
  type ListSkillsResult,
} from "../../core/src/catalog-consumption.ts"

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
export { resolveCatalogReference } from "../../core/src/catalog-reference.ts"
export { READ_OUTPUT_PROOF_VERSION } from "../../core/src/snapshot.ts"
export type { RequestMetricsSnapshot } from "../../core/src/request-metrics.ts"
export {
  RESOURCE_READ_CONTRACT_VERSION,
  RESOURCE_READ_DEFAULT_BUDGET,
  RESOURCE_READ_MAX_BUDGET,
} from "../../core/src/resource-read-model.ts"
export type {
  ResourceReadInput,
  ResourceReadResult,
  ResourceReadReady,
  ResourceReadFile,
} from "../../core/src/resource-read-model.ts"

export interface SdkOptions {
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

export type ConsumeOptions = SdkOptions & Omit<CoreConsumeOptions, "signal">
export type ReadSkillOptions = SdkOptions & ReadOptions
export type ReadSkillResult = Effect.Success<ReturnType<typeof coreReadSkill>>
export type ListSkillOptions = SdkOptions & NonNullable<Parameters<typeof coreListSkill>[1]>
export type ListSkillResult = Effect.Success<ReturnType<typeof coreListSkill>>
export type ResourceReadOptions = SdkOptions & Omit<CoreResourceReadOptions, "signal">
export type ListCatalogOptions = SdkOptions & CoreListCatalogOptions
export type ListCatalogDirectoryOptions = SdkOptions & CoreListCatalogDirectoryOptions
export type ListSkillsOptions = SdkOptions & CoreListSkillsOptions
export { CATALOG_DIRECTORY_CONTRACT_VERSION } from "../../core/src/catalog-consumption.ts"
export type {
  CatalogDirectorySelection,
  CatalogReadOutcome,
  ListCatalogResult,
  ListCatalogDirectoryResult,
  ListSkillsResult,
} from "../../core/src/catalog-consumption.ts"

/** Complete metadata-only directory; no CLI subprocess or second cache identity request. */
export function listCatalog(
  options: ListCatalogDirectoryOptions,
): Promise<ListCatalogDirectoryResult>
export function listCatalog(options?: ListCatalogOptions): Promise<ListCatalogResult>
export function listCatalog(
  options: ListCatalogOptions | ListCatalogDirectoryOptions = {},
): Promise<ListCatalogResult | ListCatalogDirectoryResult> {
  // Narrow before the operation factory so each overload keeps its success type.
  return "directory" in options
    ? runOperation(() => coreListCatalog(options), options)
    : runOperation(() => coreListCatalog(options), options)
}

/** Bounded explicit discovery. count/has_more never imply exhaustive source coverage. */
export function listSkills(options: ListSkillsOptions = {}): Promise<ListSkillsResult> {
  return runOperation(() => {
    validateListPage(options)
    return coreListSkills(options)
  }, options)
}

const cancelled = () => fail("CANCELLED", "The SDK operation was cancelled.")

async function runOperation<A>(
  operation: () => Effect.Effect<A, SkillsError, Layer.Success<typeof live>>,
  options: SdkOptions,
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
    // Runtime construction only builds services and local Store state. Every
    // HTTP-capable Effect executes after the Notion acquisition gate above.
    // Before that gate, cancellation/failure proves zero attempts; after it,
    // absent transport metrics remain unknown rather than becoming zero.
    options.onRequestMetrics?.(
      transportAcquired
        ? (requestMetrics?.() ?? null)
        : createRequestMetrics({ traceLimit: traceRequested ? 10_000 : 0 }).snapshot(),
    )
  }
}

/** Exact targets only. Resolve current names from listCatalog before this single preparation. */
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

/** A fixed resource set shares one runtime, owner admission and selected object acquisition. */
export async function readResources(
  input: unknown,
  options: ResourceReadOptions = {},
): Promise<ResourceReadResult> {
  try {
    return await runOperation(
      () =>
        coreReadResources(decodeResourceReadInput(input), {
          database: options.database,
          offline: options.offline,
        }),
      options,
    )
  } catch (error) {
    if (!(error instanceof SkillsError)) throw error
    if (error.code === "CANCELLED")
      return { version: RESOURCE_READ_CONTRACT_VERSION, status: "cancelled", reason: "interrupted" }
    return {
      version: RESOURCE_READ_CONTRACT_VERSION,
      status: "failed",
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    }
  }
}

/** Pure resource proof validation; no Store or HTTP service is acquired. */
export async function decodeResourceReadResult(
  value: unknown,
  expected?: ResourceReadInput,
): Promise<ResourceReadResult> {
  const result = await Effect.runPromiseExit(
    coreDecodeResourceReadResult(value, expected).pipe(Effect.provide(localRuntime)),
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

/** Core files shape. Fixed refs read the verified manifest without acquiring file objects. */
export function listSkill(
  target: string,
  options: ListSkillOptions = {},
): Promise<ListSkillResult> {
  return runOperation(
    () =>
      coreListSkill(target, {
        database: options.database,
        path: options.path,
        refresh: options.refresh,
        offline: options.offline,
        maxAge: options.maxAge,
      }),
    options,
  )
}
