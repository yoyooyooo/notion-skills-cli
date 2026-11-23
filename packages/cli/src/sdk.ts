import { resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { Cause, Effect, Exit, Option } from "effect"
import packageManifest from "../package.json" with { type: "json" }
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
import {
  readSkill as coreReadSkill,
  listSkill as coreListSkill,
  resolveReference as coreResolveReference,
  type ReadOptions,
  type ResolveReferenceOptions as CoreResolveReferenceOptions,
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
import { localRuntime } from "./runtime.ts"
import {
  runRuntimeOperation,
  type OperationOptions,
  type OperationServices,
} from "./operation-runtime.ts"
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
import {
  getMcpAuthStatus,
  loginMcp,
  logoutMcp,
  setMcpToken,
  resolveMcpCredential,
  type McpAuthOptions,
  type McpAuthStatus,
  type McpAuthorizationRequest,
} from "../../core/src/notion-mcp-auth.ts"
import {
  getNotionMcpIdentity,
  searchNotionMcp,
  verifyNotionMcpSource,
} from "../../core/src/notion-mcp-client.ts"
import {
  contentSearchSource,
  assertContentSearchSource,
  admitContentSearchMatches,
  validateContentSearchInput,
  type ContentSearchInput,
  type ContentSearchResult,
} from "../../core/src/notion-mcp-search.ts"

export const SDK_VERSION = 2
/** Selected CLI can expose the complete HTTP ledger independently of compact
 * stdout, with an exact closed-output SHA-256 proof. Not remote authority. */
export const COMMAND_OUTPUT_PROOF_VERSION = 1
export const PACKAGE_VERSION = packageManifest.version
export { CONTENT_SEARCH_CONTRACT_VERSION } from "../../core/src/notion-mcp-search.ts"
export type {
  ContentSearchInput,
  ContentSearchResult,
  ContentSearchRecord,
} from "../../core/src/notion-mcp-search.ts"
export type { McpAuthStatus, McpAuthorizationRequest } from "../../core/src/notion-mcp-auth.ts"
export { CONSUMPTION_EFFECTS_VERSION } from "../../core/src/consumption-effects.ts"
export type { ConsumptionEffects } from "../../core/src/consumption-effects.ts"
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
export { compareNativeMarkdown } from "../../core/src/shared-native-markdown.ts"
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

export interface SdkOptions extends OperationOptions {}

export type McpOptions = Pick<SdkOptions, "env" | "cwd" | "signal"> &
  Pick<McpAuthOptions, "profile" | "deadline" | "onAuthorize" | "serverUrl">
export type ContentSearchOptions = McpOptions & { readonly database: string }

function mcpOptions(options: McpOptions): McpAuthOptions {
  const env = { ...(options.env ?? process.env) }
  const home = env.HOME ?? env.USERPROFILE
  const root =
    env.NTN_SKILLS_CONFIG_HOME ??
    (env.XDG_CONFIG_HOME === undefined
      ? home === undefined
        ? undefined
        : resolve(options.cwd ?? ".", home, ".config", "ntn-skills")
      : resolve(options.cwd ?? ".", env.XDG_CONFIG_HOME, "ntn-skills"))
  return {
    env,
    ...(root === undefined ? {} : { configHome: resolve(options.cwd ?? ".", root) }),
    profile: options.profile,
    serverUrl: options.serverUrl,
    signal: options.signal,
    deadline: options.deadline,
    onAuthorize: options.onAuthorize,
    resolveIdentity: getNotionMcpIdentity,
  }
}

/** MCP authentication is independent of the REST service and never returns credentials. */
export function mcpAuthStatus(options: McpOptions = {}): Promise<McpAuthStatus> {
  return getMcpAuthStatus(mcpOptions(options))
}
export function mcpLogin(options: McpOptions = {}): Promise<McpAuthStatus> {
  return loginMcp(mcpOptions(options))
}
export function mcpLogout(options: McpOptions = {}): Promise<McpAuthStatus> {
  return logoutMcp(mcpOptions(options))
}
export function mcpSetToken(
  token: string | undefined,
  options: McpOptions = {},
): Promise<McpAuthStatus> {
  return setMcpToken(token, mcpOptions(options))
}

async function withinSearchDeadline<A>(
  deadline: number,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<A>,
): Promise<A> {
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now())
    throw fail("MCP_TIMEOUT", "Content search reached its deadline.")
  if (signal?.aborted) throw fail("MCP_CANCELLED", "Content search was cancelled.")
  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal?.addEventListener("abort", cancel, { once: true })
  const timer = setTimeout(cancel, deadline - Date.now())
  try {
    const value = await run(controller.signal)
    if (signal?.aborted) throw fail("MCP_CANCELLED", "Content search was cancelled.")
    if (controller.signal.aborted || Date.now() >= deadline)
      throw fail("MCP_TIMEOUT", "Content search reached its deadline.")
    return value
  } catch (error) {
    if (signal?.aborted) throw fail("MCP_CANCELLED", "Content search was cancelled.")
    if (controller.signal.aborted || Date.now() >= deadline)
      throw fail("MCP_TIMEOUT", "Content search reached its deadline.")
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", cancel)
  }
}

/** Remote discovery only. Every returned page is admitted by fresh REST metadata;
 * Views and local pins are untouched and the result never claims exact byte matching. */
export async function contentSearch(
  input: ContentSearchInput,
  options: ContentSearchOptions,
): Promise<ContentSearchResult> {
  const request = validateContentSearchInput(input)
  if (typeof options?.database !== "string" || !options.database.trim())
    throw fail("INVALID_ARGUMENT", "Content search requires one explicit library entry.")
  const env = { ...(options.env ?? process.env) }
  const complete = { ...options, env }
  const deadline = options.deadline ?? Date.now() + 360_000
  const before = await withinSearchDeadline(
    Math.min(deadline, Date.now() + 30_000),
    options.signal,
    (signal) => runOperation(() => contentSearchSource(options.database), { ...complete, signal }),
  )
  const auth = mcpOptions({ ...complete, deadline: Math.min(deadline, Date.now() + 300_000) })
  let credential = await resolveMcpCredential({
    ...auth,
    interactive: options.onAuthorize !== undefined,
  })
  return withinSearchDeadline(
    Math.min(deadline, Date.now() + 60_000),
    options.signal,
    async (signal) => {
      const searchDeadline = Math.min(deadline, Date.now() + 60_000)
      const authorized = credential
      credential = await resolveMcpCredential({
        ...mcpOptions({ ...complete, signal, deadline: searchDeadline }),
        interactive: false,
      })
      if (
        credential.connectionId !== authorized.connectionId ||
        credential.grantEpoch !== authorized.grantEpoch
      )
        throw fail("MCP_SEARCH_STALE", "The MCP connection changed after authorization.")
      const runtime = { ...complete, signal }
      const selected = await runOperation(() => contentSearchSource(options.database), runtime)
      assertContentSearchSource(before, selected)
      const perform = async () => {
        await credential.assertCurrent()
        if (selected.workspaceId !== null && selected.workspaceId !== credential.workspaceId)
          throw fail(
            "MCP_SOURCE_UNAVAILABLE",
            "The MCP workspace does not match the selected REST library.",
          )
        const connection = {
          bearer: credential.bearer,
          serverUrl: options.serverUrl,
          signal,
          deadline: searchDeadline,
        }
        // Access to the same physical entry binds the verified MCP workspace to this REST source.
        await verifyNotionMcpSource({ ...connection, pageId: selected.source.database_id })
        await credential.assertCurrent()
        return searchNotionMcp({
          ...connection,
          query: request.query,
          pageSize: request.limit,
          pageUrl: `https://www.notion.so/${selected.source.shared_library.parent_page_id.replaceAll("-", "")}`,
        })
      }
      let remote
      try {
        remote = await perform()
      } catch (error) {
        if (
          !(error instanceof SkillsError) ||
          error.code !== "MCP_AUTH_REQUIRED" ||
          credential.kind !== "oauth"
        )
          throw error
        credential = await resolveMcpCredential({
          ...auth,
          signal,
          deadline: searchDeadline,
          interactive: false,
          forceRefresh: true,
        })
        if (
          credential.connectionId !== authorized.connectionId ||
          credential.grantEpoch !== authorized.grantEpoch
        )
          throw fail(
            "MCP_SEARCH_STALE",
            "The MCP connection changed while refreshing the search credential.",
          )
        remote = await perform()
      }
      await credential.assertCurrent()
      const admission = await runOperation(
        () => admitContentSearchMatches(selected, remote.matches),
        runtime,
      )
      const latest = await runOperation(() => contentSearchSource(options.database), runtime)
      assertContentSearchSource(selected, latest)
      await credential.assertCurrent()
      const partial =
        remote.notices.length > 0 ||
        admission.rejected > 0 ||
        remote.matches.length >= request.limit
      const notices = [
        {
          code: "REMOTE_NON_EXHAUSTIVE",
          message:
            "Notion remote matches may include titles and display projections. Empty results do not prove absence, and matches do not prove exact current file bytes.",
        },
        ...(remote.notices.length === 0
          ? []
          : [
              {
                code: "REMOTE_NOTICE",
                message:
                  "The remote service reported search limitations. Local eligibility checks still apply.",
              },
            ]),
        ...(admission.rejected === 0
          ? []
          : [
              {
                code: "RESULTS_FILTERED",
                message:
                  "Some remote matches could not be admitted under current library eligibility.",
              },
            ]),
      ]
      return {
        kind: "results",
        records: admission.records,
        connection: { id: credential.connectionId, grantEpoch: credential.grantEpoch },
        resultId: randomUUID(),
        coverage: "remote_non_exhaustive",
        partial,
        notices,
        exhaustive: false,
      }
    },
  )
}

export type ConsumeOptions = SdkOptions & Omit<CoreConsumeOptions, "signal" | "onEffects">

export type ReadSkillOptions = SdkOptions & Omit<ReadOptions, "onEffects">
export type ReadSkillResult = Effect.Success<ReturnType<typeof coreReadSkill>>
export type ResolveReferenceOptions = SdkOptions & Omit<CoreResolveReferenceOptions, "onEffects">
export type ResolveReferenceResult = Effect.Success<ReturnType<typeof coreResolveReference>>
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

function runOperation<A>(
  operation: () => Effect.Effect<A, SkillsError, OperationServices>,
  options: SdkOptions,
): Promise<A> {
  return runRuntimeOperation(() => {
    if (Object.hasOwn(options, "readOnly"))
      throw fail(
        "INVALID_ARGUMENT",
        "readOnly is not an SDK option. Consumption never writes to Notion.",
      )
    return operation()
  }, options)
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

/** Resolve a relative path from an exact fixed containing File. The returned
 * target identity lets hosts apply their own target session pin before reading. */
export async function resolveReference(
  relative: string,
  options: ResolveReferenceOptions,
): Promise<ResolveReferenceResult> {
  let effects = noConsumptionWrites()
  try {
    return await runOperation(
      () =>
        coreResolveReference(relative, {
          from: options.from,
          database: options.database,
          refresh: options.refresh,
          offline: options.offline,
          maxAge: options.maxAge,
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
