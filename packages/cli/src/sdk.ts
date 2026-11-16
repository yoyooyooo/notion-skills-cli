import { resolve } from "node:path"
import {
  reviewSourceStorage as coreReviewSourceStorage,
  prepareSourceStorageAlignment as corePrepareSourceStorageAlignment,
  applySourceStorageAlignment as coreApplySourceStorageAlignment,
  reconcileSourceStorageAlignment as coreReconcileSourceStorageAlignment,
} from "../../core/src/shared-source-storage.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { withSourceCommandBudget } from "../../core/src/shared-source-budget.ts"
import {
  reviewSourceOnboarding as coreReviewSources,
  prepareSourceOnboarding as corePrepareSourceOnboarding,
  executeSourceOnboarding as coreExecuteSourceOnboarding,
} from "../../core/src/shared-source-onboarding.ts"
import type {
  SourceOnboardingScope,
  SourceOnboardingBindingDecision,
} from "../../core/src/shared-source-onboarding-model.ts"
import type { RequestBudgetLimits } from "../../core/src/request-budget.ts"
import type { SourceMemberStorage } from "../../core/src/shared-source-member.ts"
import {
  reviewSharedSourceProjectionRepair as coreReviewSourceProjectionRepair,
  applySharedSourceProjectionRepair as coreApplySourceProjectionRepair,
  reconcileSharedSourceProjectionRepair as coreReconcileSourceProjectionRepair,
} from "../../core/src/shared-source-projection-repair.ts"
import {
  reviewSharedSourceFileRepair as coreReviewSourceFileRepair,
  applySharedSourceFileRepair as coreApplySourceFileRepair,
  reconcileSharedSourceFileRepair as coreReconcileSourceFileRepair,
} from "../../core/src/shared-source-file-repair.ts"
import {
  reviewSharedSourceFileResubmission as coreReviewSourceFileResubmission,
  applySharedSourceFileResubmission as coreApplySourceFileResubmission,
  reconcileSharedSourceFileResubmission as coreReconcileSourceFileResubmission,
} from "../../core/src/shared-source-file-resubmission.ts"
import {
  reviewSharedSourceRecovery as coreReviewSourceRecovery,
  applySharedSourceRecovery as coreApplySourceRecovery,
  reconcileSharedSourceRecovery as coreReconcileSourceRecovery,
} from "../../core/src/shared-source-recovery.ts"
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
import { fail, property, SkillsError } from "../../core/src/model.ts"
import { noConsumptionWrites } from "../../core/src/consumption-effects.ts"
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
export { CONSUMPTION_EFFECTS_VERSION } from "../../core/src/consumption-effects.ts"
export type {
  ConsumptionEffects,
  ConsumptionRetentionEffect,
} from "../../core/src/consumption-effects.ts"
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
  RESOURCE_READ_EFFECTS_VERSION,
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

export type {
  SourceOnboardingScope,
  SourceOnboardingReport,
  SourceOnboardingPlan,
  SourceOnboardingBindingDecision,
} from "../../core/src/shared-source-onboarding-model.ts"
export type SourceManagementOptions = SdkOptions & { readonly budget?: RequestBudgetLimits }
const sourceManagementBudget = (options: SourceManagementOptions): RequestBudgetLimits =>
  options.budget ?? { requests: 2000, bytes: 134217728, duration_ms: 300000 }

export function reviewSourceStorage(
  input: Parameters<typeof coreReviewSourceStorage>[0],
  options: SourceManagementOptions = {},
) {
  return runOperation(
    () => withSourceCommandBudget(coreReviewSourceStorage(input), sourceManagementBudget(options)),
    options,
  )
}
export function prepareSourceStorageAlignment(
  input: Parameters<typeof corePrepareSourceStorageAlignment>[0],
  options: SourceManagementOptions = {},
) {
  return runOperation(
    () =>
      withSourceCommandBudget(
        corePrepareSourceStorageAlignment(input),
        sourceManagementBudget(options),
      ),
    options,
  )
}
export function applySourceStorageAlignment(
  input: Parameters<typeof coreApplySourceStorageAlignment>[0],
  options: SourceManagementOptions = {},
) {
  return runOperation(
    () =>
      withSourceCommandBudget(
        coreApplySourceStorageAlignment(input),
        sourceManagementBudget(options),
      ),
    options,
  )
}
export function reconcileSourceStorageAlignment(
  input: Parameters<typeof coreReconcileSourceStorageAlignment>[0],
  options: SourceManagementOptions = {},
) {
  return runOperation(
    () =>
      withSourceCommandBudget(
        coreReconcileSourceStorageAlignment(input),
        sourceManagementBudget(options),
      ),
    options,
  )
}

/** Direct Core management, not a CLI subprocess. All observations remain remotely read-only. */
export function reviewSources(
  input: {
    readonly entry: string
    readonly scope: SourceOnboardingScope
    readonly sourceTimeoutMs?: number
  },
  options: SourceManagementOptions = {},
) {
  return runOperation(
    () =>
      withSourceCommandBudget(
        Effect.gen(function* () {
          return yield* coreReviewSources(
            yield* loadSharedLibrary(input.entry),
            input.scope,
            undefined,
            { sourceTimeoutMs: input.sourceTimeoutMs },
          )
        }),
        sourceManagementBudget(options),
      ),
    options,
  )
}

/** The caller must retain the returned full plan before an explicit apply. */
export function prepareSourceOnboarding(
  input: {
    readonly entry: string
    readonly scope: SourceOnboardingScope
    readonly storage?: SourceMemberStorage
    readonly bindings?: readonly SourceOnboardingBindingDecision[]
    readonly sourceTimeoutMs?: number
  },
  options: SourceManagementOptions = {},
) {
  return runOperation(
    () =>
      withSourceCommandBudget(
        Effect.gen(function* () {
          return yield* corePrepareSourceOnboarding(
            yield* loadSharedLibrary(input.entry),
            input.scope,
            {
              storage: input.storage,
              sourceTimeoutMs: input.sourceTimeoutMs,
              bindings: input.bindings,
            },
          )
        }),
        sourceManagementBudget(options),
      ),
    options,
  )
}

export function applySourceOnboarding(
  input: { readonly entry: string; readonly plan: unknown; readonly dryRun?: boolean },
  options: SourceManagementOptions = {},
) {
  return runOperation(
    () =>
      withSourceCommandBudget(
        Effect.gen(function* () {
          return yield* coreExecuteSourceOnboarding(
            yield* loadSharedLibrary(input.entry),
            input.plan,
            input.dryRun ? "dry-run" : "apply",
          )
        }),
        sourceManagementBudget(options),
      ),
    options,
  )
}

export function reconcileSourceOnboarding(
  input: { readonly entry: string; readonly plan: unknown },
  options: SourceManagementOptions = {},
) {
  return runOperation(
    () =>
      withSourceCommandBudget(
        Effect.gen(function* () {
          return yield* coreExecuteSourceOnboarding(
            yield* loadSharedLibrary(input.entry),
            input.plan,
            "reconcile",
          )
        }),
        sourceManagementBudget(options),
      ),
    options,
  )
}

/** Review and execute the selected original child using the same CLI recovery
 * authority. No subprocess, new admission plan or implicit enablement. */
export function reviewSourceRecovery(
  input: Parameters<typeof coreReviewSourceRecovery>[0],
  options: SourceManagementOptions = {},
) {
  return runOperation(
    () => withSourceCommandBudget(coreReviewSourceRecovery(input), sourceManagementBudget(options)),
    options,
  )
}
export function applySourceRecovery(
  input: Parameters<typeof coreApplySourceRecovery>[0],
  options: SourceManagementOptions = {},
) {
  return runOperation(
    () => withSourceCommandBudget(coreApplySourceRecovery(input), sourceManagementBudget(options)),
    options,
  )
}
export function reconcileSourceRecovery(
  input: Parameters<typeof coreReconcileSourceRecovery>[0],
  options: SourceManagementOptions = {},
) {
  return runOperation(
    () =>
      withSourceCommandBudget(coreReconcileSourceRecovery(input), sourceManagementBudget(options)),
    options,
  )
}

export type ConsumeOptions = SdkOptions & Omit<CoreConsumeOptions, "signal" | "onEffects">

export function reviewSourceFileRepair(
  input: Parameters<typeof coreReviewSourceFileRepair>[0],
  options: SourceManagementOptions = {},
) {
  return runOperation(
    () =>
      withSourceCommandBudget(coreReviewSourceFileRepair(input), sourceManagementBudget(options)),
    options,
  )
}
export function applySourceFileRepair(
  input: Parameters<typeof coreApplySourceFileRepair>[0],
  options: SourceManagementOptions = {},
) {
  return runOperation(
    () =>
      withSourceCommandBudget(coreApplySourceFileRepair(input), sourceManagementBudget(options)),
    options,
  )
}
export function reconcileSourceFileRepair(
  input: Parameters<typeof coreReconcileSourceFileRepair>[0],
  options: SourceManagementOptions = {},
) {
  return runOperation(
    () =>
      withSourceCommandBudget(
        coreReconcileSourceFileRepair(input),
        sourceManagementBudget(options),
      ),
    options,
  )
}

/** An independently reviewed new file request, never replay authority for the rejected POST. */
export function reviewSourceFileResubmission(
  input: Parameters<typeof coreReviewSourceFileResubmission>[0],
  options: SourceManagementOptions = {},
) {
  return runOperation(
    () =>
      withSourceCommandBudget(
        coreReviewSourceFileResubmission(input),
        sourceManagementBudget(options),
      ),
    options,
  )
}
export function applySourceFileResubmission(
  input: Parameters<typeof coreApplySourceFileResubmission>[0],
  options: SourceManagementOptions = {},
) {
  return runOperation(
    () =>
      withSourceCommandBudget(
        coreApplySourceFileResubmission(input),
        sourceManagementBudget(options),
      ),
    options,
  )
}
export function reconcileSourceFileResubmission(
  input: Parameters<typeof coreReconcileSourceFileResubmission>[0],
  options: SourceManagementOptions = {},
) {
  return runOperation(
    () =>
      withSourceCommandBudget(
        coreReconcileSourceFileResubmission(input),
        sourceManagementBudget(options),
      ),
    options,
  )
}

export function reviewSourceProjectionRepair(
  input: Parameters<typeof coreReviewSourceProjectionRepair>[0],
  options: SourceManagementOptions = {},
) {
  return runOperation(
    () =>
      withSourceCommandBudget(
        coreReviewSourceProjectionRepair(input),
        sourceManagementBudget(options),
      ),
    options,
  )
}
export function applySourceProjectionRepair(
  input: Parameters<typeof coreApplySourceProjectionRepair>[0],
  options: SourceManagementOptions = {},
) {
  return runOperation(
    () =>
      withSourceCommandBudget(
        coreApplySourceProjectionRepair(input),
        sourceManagementBudget(options),
      ),
    options,
  )
}
export function reconcileSourceProjectionRepair(
  input: Parameters<typeof coreReconcileSourceProjectionRepair>[0],
  options: SourceManagementOptions = {},
) {
  return runOperation(
    () =>
      withSourceCommandBudget(
        coreReconcileSourceProjectionRepair(input),
        sourceManagementBudget(options),
      ),
    options,
  )
}
export type ReadSkillOptions = SdkOptions & Omit<ReadOptions, "onEffects">
export type ReadSkillResult = Effect.Success<ReturnType<typeof coreReadSkill>>
export type ListSkillOptions = SdkOptions & NonNullable<Parameters<typeof coreListSkill>[1]>
export type ListSkillResult = Effect.Success<ReturnType<typeof coreListSkill>>
export type ResourceReadOptions = SdkOptions & Omit<CoreResourceReadOptions, "signal" | "onEffects">
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
  let effects = noConsumptionWrites()
  try {
    return await runOperation(
      () =>
        coreConsume(decodeConsumeInput(input), {
          database: options.database,
          execution: options.execution,
          metrics: options.metrics,
          readOnly: options.readOnly,
          onEffects: (value) => {
            effects = value
          },
        }),
      options,
    )
  } catch (error) {
    if (!(error instanceof SkillsError)) throw error
    if (error.code === "CANCELLED")
      return {
        version: CONSUMER_CONTRACT_VERSION,
        status: "cancelled",
        reason: "interrupted",
        effects,
      }
    return {
      version: CONSUMER_CONTRACT_VERSION,
      status: "failed",
      effects,
      error: {
        code: error.code,
        message: error.message,
        details: { ...property(error.details), effects },
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
  let effects = noConsumptionWrites()
  try {
    return await runOperation(
      () =>
        coreReadResources(decodeResourceReadInput(input), {
          database: options.database,
          offline: options.offline,
          readOnly: options.readOnly,
          onEffects: (value) => {
            effects = value
          },
        }),
      options,
    )
  } catch (error) {
    if (!(error instanceof SkillsError)) throw error
    if (error.code === "CANCELLED")
      return {
        version: RESOURCE_READ_CONTRACT_VERSION,
        status: "cancelled",
        reason: "interrupted",
        effects,
      }
    return {
      version: RESOURCE_READ_CONTRACT_VERSION,
      status: "failed",
      effects,
      error: {
        code: error.code,
        message: error.message,
        details: { ...property(error.details), effects },
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
export async function readSkill(
  target: string,
  options: ReadSkillOptions = {},
): Promise<ReadSkillResult> {
  let effects = noConsumptionWrites()
  try {
    return await runOperation(
      () =>
        coreReadSkill(target, {
          database: options.database,
          path: options.path,
          from: options.from,
          lines: options.lines,
          output: options.output,
          authoring: options.authoring,
          refresh: options.refresh,
          offline: options.offline,
          maxAge: options.maxAge,
          readOnly: options.readOnly,
          onEffects: (value) => {
            effects = value
          },
        }),
      options,
    )
  } catch (error) {
    if (error instanceof SkillsError)
      throw fail(error.code, error.message, { ...property(error.details), effects })
    throw error
  }
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
