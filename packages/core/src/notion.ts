import {
  Clock,
  Config,
  Context,
  Crypto,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
  Semaphore,
} from "effect"
import { HttpClient } from "effect/http"
import { ApiErrorSchema, decode, fail, property, SkillsError } from "./model.ts"
import { sha256 } from "./store.ts"
import {
  NOTION_ADMISSION_BUDGET_MS,
  NotionRequestScheduler,
  NotionRequestSchedulerLive,
  notionEndpoint,
  notionRetryDelay,
  type RequestPriority,
} from "./notion-request-scheduler.ts"
import { requestTimeoutMs } from "./request-timeout.ts"
import { RequestBudget, withinRequestBudget } from "./request-budget.ts"
import {
  createRequestMetrics,
  requestAttribution,
  type RequestAttribution,
  type RequestMetricsSnapshot,
} from "./request-metrics.ts"
import { isCoalescibleNotionRead, makeSharedReadCoalescer } from "./shared-read-coalescing.ts"
import {
  NotionCredentialProvider,
  NotionCredentialProviderLive,
  type NotionCredential,
} from "./notion-credential.ts"
import {
  NOTION_API_VERSION,
  notionApiOrigin,
  notionResponseDetails,
  prepareNotionRequest,
  sendNotionRequest,
  verifiedWorkspaceId,
} from "./notion-http.ts"
import {
  isDefinitiveNotionRejection,
  isRetryableNotionWriteRejection,
  notionRejectionStatus,
} from "./notion-write-policy.ts"

export type NotionConnectionIdentity = {
  readonly principal: string
  readonly credential: string
  readonly connection: string
  readonly workspace: string | null
  readonly api_origin: string
}

const NotionRequestAttribution = Context.Reference<RequestAttribution>(
  "ntn-skills/NotionRequestAttribution",
  { defaultValue: () => requestAttribution(undefined) },
)
/** Diagnostic lineage only. This does not grant authority or reuse any request. */
export function withNotionRequestAttribution<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  attribution: Partial<RequestAttribution>,
) {
  return Effect.gen(function* () {
    const inherited = yield* NotionRequestAttribution
    return yield* effect.pipe(
      Effect.provideService(NotionRequestAttribution, { ...inherited, ...attribution }),
    )
  })
}

type NotionRequestOptions = {
  readonly method?: "GET" | "POST" | "PATCH"
  readonly file?: string
  readonly content?: "body"
  readonly priority?: RequestPriority
  readonly queueBudgetMs?: number
  readonly rateShare?: number
  /** Records schema property ID; the transport derives identities from sent JSON only. */
  readonly entityPropertyId?: string
}

export class Notion extends Context.Service<
  Notion,
  {
    readonly request: (
      path: string,
      body?: unknown,
      options?: NotionRequestOptions,
    ) => Effect.Effect<unknown, SkillsError>
    readonly version: Effect.Effect<string, SkillsError>
    readonly credentialIdentity: Effect.Effect<string, SkillsError>
    /** Static endpoint identity; reading it performs no authentication or HTTP request. */
    readonly apiOrigin?: string
    readonly connectionIdentity?: Effect.Effect<NotionConnectionIdentity, SkillsError>
    /** Actual HTTP attempts; payload bytes exclude HTTP/TLS framing. */
    readonly requestMetrics?: () => RequestMetricsSnapshot
    readonly metrics?: ReturnType<typeof createRequestMetrics>
  }
>()("ntn-skills/Notion") {}

const apiCodes: Readonly<Record<string, string>> = {
  unauthorized: "AUTH_REQUIRED",
  restricted_resource: "ACCESS_DENIED",
  object_not_found: "NOT_FOUND",
  directory_not_found: "SKILL_NOT_FOUND",
  rate_limited: "RATE_LIMITED",
  service_overload: "RATE_LIMITED",
}
const knownApiCodes = new Set([
  ...Object.keys(notionRejectionStatus),
  "directory_not_found",
  "conflict_error",
  "internal_server_error",
  "bad_gateway",
  "service_unavailable",
  "database_connection_unavailable",
  "gateway_timeout",
  "service_overload",
])
function isRateLimit(code: unknown, status: unknown) {
  return status === 429 || status === 529 || (status === undefined && code === "rate_limited")
}
function apiFailure(
  path: string,
  code: string,
  mutating: boolean,
  diagnostics: Readonly<Record<string, unknown>>,
  status: number,
) {
  const safeCode = knownApiCodes.has(code) ? code : "unrecognized"
  const rejected = isDefinitiveNotionRejection(safeCode, status, diagnostics)
  return fail(
    mutating && !rejected
      ? "WRITE_OUTCOME_UNKNOWN"
      : (apiCodes[safeCode] ??
          (isRateLimit(code, status) ? "RATE_LIMITED" : "NOTION_REQUEST_FAILED")),
    "The Notion API request failed.",
    {
      path,
      notion_code: safeCode,
      ...diagnostics,
      phase: rejected ? "definitive_rejection" : "outcome_unknown",
    },
  )
}

export const NotionTransport = Layer.effect(
  Notion,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const fs = yield* FileSystem.FileSystem
    const paths = yield* Path.Path
    const crypto = yield* Crypto.Crypto
    const scheduler = yield* NotionRequestScheduler
    const credentials = yield* NotionCredentialProvider
    // One service is one CLI operation. A rotation takes effect in the next service.
    const resolveCredential = yield* Effect.cached(credentials.resolve)
    const origin = yield* notionApiOrigin
    const hash = (value: string) => sha256(value).pipe(Effect.provideService(Crypto.Crypto, crypto))
    const timeoutMs = yield* requestTimeoutMs
    const concurrencyError = () =>
      fail(
        "CONFIG_ERROR",
        "NTN_SKILLS_NOTION_CONCURRENCY must be an integer from 1 to 64; unset or empty uses 4.",
      )
    const configuredConcurrency = yield* Config.String("NTN_SKILLS_NOTION_CONCURRENCY").pipe(
      Config.withDefault("4"),
      Effect.mapError(concurrencyError),
    )
    const maxInFlight = Number(configuredConcurrency)
    if (
      !/^[1-9][0-9]*$/u.test(configuredConcurrency) ||
      !Number.isSafeInteger(maxInFlight) ||
      maxInFlight > 64
    )
      return yield* Effect.fail(concurrencyError())
    const permits = yield* Semaphore.make(maxInFlight)
    const traceLimit = yield* Config.Number("NTN_SKILLS_REQUEST_TRACE_LIMIT").pipe(
      Config.withDefault(0),
      Effect.mapError(() => fail("CONFIG_ERROR", "Invalid request trace limit.")),
    )
    if (!Number.isSafeInteger(traceLimit) || traceLimit < 0 || traceLimit > 10_000)
      return yield* Effect.fail(
        fail("CONFIG_ERROR", "NTN_SKILLS_REQUEST_TRACE_LIMIT must be an integer from 0 to 10000."),
      )
    const metrics = createRequestMetrics({ traceLimit })
    const identities = new Map<string, NotionConnectionIdentity>()
    const coalescer = yield* makeSharedReadCoalescer(metrics)
    const request = (
      credential: NotionCredential,
      path: string,
      body?: unknown,
      options?: NotionRequestOptions,
    ) =>
      Effect.gen(function* () {
        const budget = Option.getOrUndefined(yield* Effect.serviceOption(RequestBudget))
        const attribution = requestAttribution(
          yield* NotionRequestAttribution,
          Redacted.value(credential.token),
        )
        const method = options?.method ?? (body === undefined ? "GET" : "POST")
        const identity = credential.identity
        const mutating =
          method !== "GET" && !isCoalescibleNotionRead({ key: identity, path, method })
        if (options?.priority === "prefetch" && mutating)
          return yield* Effect.fail(
            fail("NOTION_PREFETCH_WRITE_FORBIDDEN", "Prefetch cannot mutate Notion.", {
              phase: "input_rejected",
              reason: "prefetch_read_only",
            }),
          )
        // Serialization and file validation occur before admission or an HTTP attempt.
        const prepared = yield* prepareNotionRequest({
          origin,
          path,
          method,
          credential,
          body,
          file: options?.file,
          entityPropertyId: options?.entityPropertyId,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, paths),
        )
        const requestKey = yield* hash(
          JSON.stringify([
            origin,
            identity,
            method,
            path,
            body,
            options?.file,
            // A shared producer owns admission; incompatible queue budgets
            // cannot inherit the first waiter's timeout or deferred outcome.
            options?.queueBudgetMs ?? NOTION_ADMISSION_BUDGET_MS,
            ...(budget === undefined ? [] : [budget.identity]),
            ...(options?.priority === "prefetch" ? ["prefetch", options.rateShare ?? 0.1] : []),
          ]),
        )
        const operationDeadline =
          (yield* Clock.monotonicTimeNanos) + BigInt(NOTION_ADMISSION_BUDGET_MS) * 1_000_000n
        const deadline =
          budget !== undefined && budget.deadline < operationDeadline
            ? budget.deadline
            : operationDeadline
        const scheduleOptions = () => ({
          ...identities.get(identity),
          apiOrigin: origin,
          endpoint: notionEndpoint(path, method),
          priority: options?.priority,
          queueBudgetMs: options?.queueBudgetMs,
          rateShare: options?.rateShare,
        })
        let retryNotBefore: bigint | undefined
        const once = Effect.scoped(
          Effect.gen(function* () {
            if (budget !== undefined) yield* budget.check
            const queuedAt = yield* Clock.monotonicTimeNanos
            let admitted = false
            let waitedForRetry = 0
            const observedWait = (started: bigint, ended: bigint) => {
              if (retryNotBefore === undefined || started >= retryNotBefore) return
              const retryEnd = ended < retryNotBefore ? ended : retryNotBefore
              waitedForRetry += Number(retryEnd - started) / 1_000_000
            }
            const recordWait = Effect.gen(function* () {
              const elapsed = Number((yield* Clock.monotonicTimeNanos) - queuedAt) / 1_000_000
              const retry = Math.min(elapsed, waitedForRetry)
              if (retry > 0) metrics.wait(retry, "retry", attribution)
              metrics.wait(elapsed - retry, "queue", attribution)
            })
            const unbudgetedAttempt = Effect.gen(function* () {
              if (budget !== undefined) yield* budget.admit(prepared.requestBytes)
              admitted = true
              yield* recordWait
              const finish = metrics.begin({
                path,
                method,
                key: requestKey,
                ...(options?.content ? { content: options.content } : {}),
                requestBytes: prepared.requestBytes,
                target: prepared.target,
                attribution,
              })
              let responseBytes: number | undefined
              let budgetResponseBytes = 0
              let observed: ReturnType<typeof notionResponseDetails> | undefined
              return yield* Effect.gen(function* () {
                const response = yield* sendNotionRequest({
                  client: http,
                  request: prepared.request,
                  credential,
                  observe: (metadata, bytes) => {
                    observed = metadata
                    responseBytes = bytes
                    budget?.responseBytes(bytes - budgetResponseBytes)
                    budgetResponseBytes = bytes
                  },
                }).pipe(
                  Effect.timeout(timeoutMs),
                  (effect) => (budget === undefined ? effect : withinRequestBudget(effect, budget)),
                  Effect.mapError((error) => {
                    const cause =
                      error instanceof SkillsError
                        ? error
                        : fail("NOTION_UNAVAILABLE", "The Notion HTTP attempt timed out.", {
                            reason: "timeout",
                          })
                    return mutating
                      ? fail(
                          "WRITE_OUTCOME_UNKNOWN",
                          "The write may have completed; read the target before retrying.",
                          {
                            path,
                            cause_code: cause.code,
                            ...property(cause.details),
                            phase: "outcome_unknown",
                          },
                        )
                      : cause
                  }),
                )
                responseBytes = response.bytes
                observed = notionResponseDetails(response, credential)
                const value = response.value
                if (
                  response.status < 200 ||
                  response.status >= 300 ||
                  property(value).object === "error"
                ) {
                  const parsed = yield* Effect.try({
                    try: () => decode(ApiErrorSchema, value),
                    catch: () =>
                      fail(
                        mutating ? "WRITE_OUTCOME_UNKNOWN" : "INVALID_RESPONSE",
                        "Invalid Notion error response.",
                        notionResponseDetails(response, credential),
                      ),
                  }).pipe(Effect.result)
                  if (parsed._tag === "Failure") return yield* Effect.fail(parsed.failure)
                  return yield* Effect.fail(
                    apiFailure(
                      path,
                      parsed.success.code,
                      mutating,
                      notionResponseDetails(response, credential),
                      response.status,
                    ),
                  )
                }
                return value
              }).pipe(
                Effect.onExit((exit) =>
                  Effect.sync(() =>
                    finish({
                      outcome: Exit.isSuccess(exit)
                        ? "success"
                        : Exit.hasInterrupts(exit)
                          ? "cancelled"
                          : "failure",
                      ...(responseBytes === undefined ? {} : { responseBytes }),
                      ...(observed === undefined
                        ? {}
                        : {
                            httpStatus: observed.http_status,
                            requestId: observed.request_id,
                            rateLimitReason: observed.rate_limit_reason,
                            retryAfterSeconds: observed.retry_after_seconds,
                          }),
                    }),
                  ),
                ),
              )
            })
            const attempt =
              budget === undefined ? unbudgetedAttempt : budget.withPermit(unbudgetedAttempt)
            return yield* scheduler
              .withAdmission(identity, deadline, permits, attempt, {
                ...scheduleOptions(),
                onWait: observedWait,
              })
              .pipe(
                Effect.mapError((error) =>
                  budget !== undefined &&
                  deadline === budget.deadline &&
                  property(error.details).reason === "admission_wait_exhausted"
                    ? budget.exhaust("duration")
                    : error,
                ),
                Effect.onExit(() => (admitted ? Effect.void : recordWait)),
              )
          }),
        )
        const execute = Effect.gen(function* () {
          for (let attempt = 0; ; attempt++) {
            const result = yield* once.pipe(Effect.result)
            if (result._tag === "Success") return result.success
            const error = result.failure
            const details = property(error.details)
            if (details.rate_limit_reason === "public_api_request_blocked")
              return yield* Effect.fail(error)
            const limited = isRateLimit(details.notion_code, details.http_status)
            const retryable = mutating
              ? isRetryableNotionWriteRejection(details)
              : limited ||
                (typeof details.http_status === "number" &&
                  [500, 502, 503, 504].includes(details.http_status)) ||
                (error.code === "NOTION_UNAVAILABLE" && details.reason === "timeout") ||
                ["dns", "network", "timeout"].includes(String(details.reason)) ||
                [
                  "internal_server_error",
                  "bad_gateway",
                  "service_unavailable",
                  "database_connection_unavailable",
                  "gateway_timeout",
                ].includes(String(details.notion_code))
            // Every retry reuses the prepared bytes and remains in this operation.
            // A server cooldown also applies when an unknown write cannot be repeated.
            if (retryable || limited || typeof details.retry_after_seconds === "number") {
              const delay = yield* notionRetryDelay({
                attempt,
                retryAfterSeconds:
                  typeof details.retry_after_seconds === "number"
                    ? details.retry_after_seconds
                    : undefined,
              })
              if (retryable && attempt < 3)
                retryNotBefore =
                  (yield* Clock.monotonicTimeNanos) +
                  BigInt(Math.ceil(Math.min(delay, NOTION_ADMISSION_BUDGET_MS))) * 1_000_000n
              const cooldown = yield* scheduler
                .cooldown(identity, delay, {
                  ...scheduleOptions(),
                  reason:
                    typeof details.rate_limit_reason === "string"
                      ? details.rate_limit_reason
                      : undefined,
                })
                .pipe(Effect.result)
              if (cooldown._tag === "Failure")
                return yield* Effect.fail(
                  fail(error.code, error.message, {
                    ...details,
                    scheduler_code: cooldown.failure.code,
                  }),
                )
            }
            if (options?.priority === "prefetch" && (limited || details.http_status === 529))
              return yield* Effect.fail(
                fail(error.code, error.message, {
                  ...details,
                  deferred: true,
                  reason: "prefetch_service_pressure",
                }),
              )
            if (!retryable || attempt >= 3) return yield* Effect.fail(error)
          }
        })
        return yield* coalescer.run(
          { key: requestKey, path, method, file: options?.file, content: options?.content },
          execute,
        )
      })
    return {
      credentialIdentity: resolveCredential.pipe(Effect.map((credential) => credential.identity)),
      apiOrigin: origin,
      version: Effect.succeed(NOTION_API_VERSION),
      requestMetrics: () => metrics.snapshot(),
      metrics,
      request: (path, body, options) =>
        resolveCredential.pipe(
          Effect.flatMap((credential) => request(credential, path, body, options)),
        ),
      connectionIdentity: Effect.gen(function* () {
        const credential = yield* resolveCredential
        const value = yield* request(credential, "v1/users/me")
        const user = yield* Effect.try({
          try: () =>
            decode(
              Schema.Struct({
                object: Schema.Literal("user"),
                id: Schema.String.check(Schema.isUUID()),
              }),
              value,
            ),
          catch: () => fail("INVALID_RESPONSE", "Invalid authenticated Notion identity."),
        })
        const verified = {
          principal: user.id,
          credential: credential.identity,
          connection: yield* hash(JSON.stringify([origin, user.id])),
          workspace: verifiedWorkspaceId(value),
          api_origin: origin,
        }
        identities.set(credential.identity, verified)
        return verified
      }),
    }
  }),
)

export const NotionLive = NotionTransport.pipe(
  Layer.provide(NotionCredentialProviderLive),
  Layer.provide(NotionRequestSchedulerLive),
)
