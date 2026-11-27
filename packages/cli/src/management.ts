import packageManifest from "../package.json" with { type: "json" }
import { Effect, Schema } from "effect"
import { fail } from "../../core/src/model.ts"
import { authScope, libraryId } from "../../core/src/catalog.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { canonicalSharedJson } from "../../core/src/shared-records.ts"
import { CurrentSourceSyncItemSchema } from "../../core/src/shared-current-source-sync-batch-model.ts"
import { invalidateMaterializationFacts } from "../../core/src/shared-source-materialization-management.ts"
import {
  decodeSourceMaterializationRequest,
  decodeSourceMaterializationReceipt,
  type SourceMaterializationRequest,
  type SourceMaterializationReceipt,
} from "../../core/src/shared-source-materialization-model.ts"
import {
  invokeSourceManager,
  sourceManagerBinding,
  type SourceManagerBinding,
} from "./source-manager-transport.ts"
import {
  runCurrentSourceSync,
  validateCurrentSourceSyncCommand,
} from "../../core/src/shared-current-source-sync.ts"
import {
  CURRENT_SOURCE_SYNC_VERSION,
  type CurrentSourceCheckRequest,
  type CurrentSourceSyncRequest,
  type CurrentSourceSyncResult,
} from "../../core/src/shared-current-source-sync-model.ts"
import {
  runLocalRuntimeOperation,
  runRuntimeOperation,
  type OperationOptions,
} from "./operation-runtime.ts"

export { SOURCE_MATERIALIZATION_VERSION } from "../../core/src/shared-source-materialization-model.ts"
export type {
  SourceMaterializationRequest,
  SourceMaterializationReceipt,
  SourceMaterializationTarget,
} from "../../core/src/shared-source-materialization-model.ts"
export const MANAGEMENT_VERSION = CURRENT_SOURCE_SYNC_VERSION
export const PACKAGE_VERSION: string = packageManifest.version
export { SkillsError } from "../../core/src/model.ts"
export {
  CURRENT_SOURCE_SYNC_VERSION,
  currentSourceSyncExitCode,
} from "../../core/src/shared-current-source-sync-model.ts"
export type {
  CurrentSourceCheckRequest,
  CurrentSourceSyncRequest,
  CurrentSourceSyncResult,
  CurrentSourceSyncItem,
  CurrentSourceSyncContent,
  CurrentSourceSyncProjection,
  CurrentSourceSyncSelection,
} from "../../core/src/shared-current-source-sync-model.ts"
export type { RequestBudgetLimits, RequestBudgetSnapshot } from "../../core/src/request-budget.ts"
export type { RequestMetricsSnapshot } from "../../core/src/request-metrics.ts"

export interface ManagementOptions extends OperationOptions {}
export type SourceCheckInput = CurrentSourceCheckRequest & { readonly library: string }
export type SourceSyncInput = CurrentSourceSyncRequest & { readonly library: string }

function checkedEntry(input: { readonly library: string }, options: ManagementOptions): string {
  if (Object.hasOwn(options, "readOnly"))
    throw fail(
      "INVALID_ARGUMENT",
      "readOnly is not a management option. Select checkSources or syncSources explicitly.",
    )
  if (
    input === null ||
    typeof input !== "object" ||
    typeof input.library !== "string" ||
    !input.library.trim()
  )
    throw fail("INVALID_ARGUMENT", "Source management requires one explicit Library root.")
  if (
    /^notion_page:/iu.test(input.library) ||
    (/^[a-z][a-z\d+.-]*:\/\//iu.test(input.library) && !/^https?:\/\//iu.test(input.library))
  )
    throw fail(
      "INVALID_ARGUMENT",
      "Source management requires a current database ID or Notion URL.",
    )
  return input.library
}

/** Read current declarations and upstream refs. No Notion semantic writes and no
 * automatic publication. An unchanged upstream does not certify target contents. */
export function checkSources(
  input: SourceCheckInput,
  options: ManagementOptions = {},
): Promise<CurrentSourceSyncResult> {
  return runRuntimeOperation(() => {
    const entry = checkedEntry(input, options)
    const { library: _, ...request } = input
    return runCurrentSourceSync(
      entry,
      validateCurrentSourceSyncCommand({ ...request, action: "check" }),
    )
  }, options)
}

/** Explicit management. One call checks, freezes and publishes exact upstream
 * content or resumes its finite original intent. Keep manager/execution identity
 * and original local Store stable across retries; scheduling stays with the caller. */
export async function syncSources(
  input: SourceSyncInput,
  options: ManagementOptions = {},
): Promise<CurrentSourceSyncResult> {
  let binding: SourceManagerBinding | undefined
  try {
    checkedEntry(input, options)
    binding = await sourceManagerBinding(options)
  } catch (error) {
    return runLocalRuntimeOperation(() => {
      throw error
    }, options)
  }
  if (binding !== undefined) {
    try {
      validateCurrentSourceSyncCommand({ ...input, action: "sync" })
      const selected = await runLocalRuntimeOperation(() => libraryId(input.library), {
        ...options,
        onRequestMetrics: undefined,
      })
      const result = await invokeSourceManager(
        { version: 1, action: "sync", input: { ...input, library: selected } },
        binding,
        options,
      )
      return decodeManagerSyncResult(result)
    } finally {
      options.onRequestMetrics?.(null)
    }
  }
  return runRuntimeOperation(() => {
    const entry = checkedEntry(input, options)
    const { library: _, ...request } = input
    return runCurrentSourceSync(
      entry,
      validateCurrentSourceSyncCommand({ ...request, action: "sync" }),
    )
  }, options)
}

/** Explicit preparation uses the configured fixed writer. Ordinary consumption
 * never invokes this function or acquires a management credential. */
export async function materializeSource(
  value: SourceMaterializationRequest,
  options: ManagementOptions = {},
): Promise<SourceMaterializationReceipt> {
  const input = decodeSourceMaterializationRequest(value)
  checkedEntry(input, options)
  const binding = await sourceManagerBinding(options)
  if (binding === undefined)
    throw fail(
      "SOURCE_MANAGER_REQUIRED",
      "Configure a fixed Source manager before preparing a registered member.",
    )
  try {
    const selected = await runLocalRuntimeOperation(() => libraryId(input.library), {
      ...options,
      onRequestMetrics: undefined,
    })
    const result = decodeSourceMaterializationReceipt(
      await invokeSourceManager(
        { version: 1, action: "materialize", input: { ...input, library: selected } },
        binding,
        options,
      ),
    )
    if (
      result.request_id !== input.request_id ||
      result.library_id !== binding.library ||
      canonicalSharedJson(result.target) !== canonicalSharedJson(input.target) ||
      canonicalSharedJson(result.authorization_root ?? null) !==
        canonicalSharedJson(input.authorization_root ?? null)
    )
      throw fail(
        "SOURCE_MATERIALIZATION_RECEIPT_INVALID",
        "The manager receipt belongs to a different request or target.",
      )
    return await runRuntimeOperation(
      () =>
        libraryId(selected).pipe(
          Effect.flatMap(loadSharedLibrary),
          Effect.flatMap((library) =>
            Effect.gen(function* () {
              // The manager proves its own authenticated result. Delivery and local
              // cache facts belong to this consumer's independently verified scope.
              const scope = yield* authScope
              const receipt: SourceMaterializationReceipt = {
                ...result,
                manager_scope: result.scope,
                scope,
              }
              yield* invalidateMaterializationFacts(library, receipt)
              return receipt
            }),
          ),
        ),
      { ...options, onRequestMetrics: undefined },
    )
  } finally {
    options.onRequestMetrics?.(null)
  }
}

const Limits = Schema.Struct({
  requests: Schema.Number,
  bytes: Schema.Number,
  duration_ms: Schema.Number,
})
const SyncResponse = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("current_source_sync"),
  action: Schema.Literal("sync"),
  status: Schema.Literals(["complete", "partial", "blocked", "retryable", "failed"]),
  library_id: Schema.NullOr(Schema.String),
  results: Schema.Array(CurrentSourceSyncItemSchema),
  budget: Schema.Struct({
    limits: Limits,
    attempts: Schema.Number,
    request_bytes: Schema.Number,
    response_bytes: Schema.Number,
    elapsed_ms: Schema.Number,
    exhausted: Schema.NullOr(Schema.Literals(["requests", "bytes", "duration"])),
    byte_overshoot: Schema.Number,
    byte_policy: Schema.Literal("finish_admitted_response"),
    byte_units: Schema.Literal("payload_bytes_excluding_http_tls_framing"),
    maximum_in_flight: Schema.Literal(1),
  }),
  request_metrics: Schema.Unknown,
})
function decodeManagerSyncResult(value: unknown): CurrentSourceSyncResult {
  try {
    const result = Schema.decodeUnknownSync(SyncResponse)(value, { onExcessProperty: "error" })
    // The manager owns HTTP attribution. This foreground client has no local
    // transport snapshot, and never invents zero attempts for remote work.
    return { ...result, request_metrics: null }
  } catch {
    throw fail(
      "SOURCE_MANAGER_RESPONSE_INVALID",
      "The manager returned an invalid Source sync report.",
    )
  }
}
