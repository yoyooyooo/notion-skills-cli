/** Counts actual transport attempts. Call begin after admission, immediately before sending. */
export type RequestKind = "notion_metadata" | "notion_body" | "notion_write" | "provider"
export type BodyRequestKind = "current_body" | "retained_body" | "unclassified_body"
export type RequestMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "HEAD"
export type RequestOutcome = "success" | "failure" | "cancelled"
export type NotionRequestTarget =
  | { readonly page_id: string }
  | { readonly block_id: string }
  | { readonly data_source_id: string; readonly entity_ids?: readonly string[] }

/** Diagnostic identities come from the sent path and exact Entity filters, never a work plan. */
export function notionRequestTarget(request: {
  readonly path: string
  readonly method: RequestMethod
  readonly provider?: string
  readonly body?: unknown
  readonly entityPropertyId?: string
  readonly redactedValue?: string
}): NotionRequestTarget | null {
  if (request.provider !== undefined && request.provider !== "notion") return null
  const path = (request.path.split("?")[0] ?? "").replace(/^\//u, "")
  const uuid = (value: string | undefined) => {
    if (
      value === undefined ||
      !/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/iu.test(value)
    )
      return undefined
    const hex = value.replaceAll("-", "").toLowerCase()
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  const page = /^v1\/pages\/([^/]+)(?:\/markdown|\/properties\/[^/]+)?$/u.exec(path)
  const pageId = uuid(page?.[1])
  if (pageId !== undefined) return { page_id: pageId }
  const block = /^v1\/blocks\/([^/]+)(?:\/children)?$/u.exec(path)
  const blockId = uuid(block?.[1])
  if (blockId !== undefined) return { block_id: blockId }
  const query = /^v1\/data_sources\/([^/]+)\/query$/u.exec(path)
  const dataSourceId = request.method === "POST" ? uuid(query?.[1]) : undefined
  if (dataSourceId === undefined) return null
  const target = { data_source_id: dataSourceId }
  const field = request.entityPropertyId
  if (field === undefined || field.length === 0) return target
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : undefined
  const body = object(request.body)
  let remaining = 256
  const select = (value: unknown, depth: number): ReadonlySet<string> | undefined => {
    if (--remaining < 0 || depth > 4) throw new Error("Unbounded diagnostic filter")
    const filter = object(value)
    if (filter === undefined) return undefined
    if (Object.keys(filter).length === 1 && Array.isArray(filter.and) && filter.and.length > 0) {
      let result: ReadonlySet<string> | undefined
      for (const child of filter.and) {
        const selected = select(child, depth + 1)
        if (selected !== undefined)
          result =
            result === undefined ? selected : new Set([...result].filter((id) => selected.has(id)))
      }
      return result
    }
    if (Object.keys(filter).length === 1 && Array.isArray(filter.or) && filter.or.length > 0) {
      const result = new Set<string>()
      for (const child of filter.or) {
        const selected = select(child, depth + 1)
        if (selected === undefined) return undefined
        for (const id of selected) result.add(id)
        if (result.size > 100) return undefined
      }
      return result
    }
    if (
      filter.property !== field ||
      Object.keys(filter).some((key) => !["property", "rich_text"].includes(key))
    )
      return undefined
    const condition = object(filter.rich_text)
    const id = condition?.equals
    if (
      condition === undefined ||
      Object.keys(condition).length !== 1 ||
      typeof id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id) ||
      (request.redactedValue !== undefined &&
        request.redactedValue.length > 0 &&
        id.includes(request.redactedValue))
    )
      return undefined
    return new Set([id])
  }
  try {
    const ids = select(body?.filter, 0)
    return ids !== undefined && ids.size > 0 && ids.size <= 100
      ? { ...target, entity_ids: [...ids].sort() }
      : target
  } catch {
    return target
  }
}
export type RequestResponseObservation = {
  readonly outcome?: RequestOutcome
  readonly responseBytes?: number
  readonly httpStatus?: number
  readonly requestId?: string
  readonly rateLimitReason?: string
  readonly retryAfterSeconds?: number
}
export type RequestTraceEvent =
  | {
      readonly event: "attempt"
      readonly attempt: number
      readonly kind: RequestKind
      readonly body_kind: BodyRequestKind | null
      readonly target: NotionRequestTarget | null
      readonly method: RequestMethod
      readonly started_ms: number
      readonly duration_ms: number
      readonly outcome: RequestOutcome
      readonly request_bytes: number | null
      readonly response_bytes: number | null
      readonly http_status: number | null
      readonly request_id: string | null
      readonly rate_limit_reason: string | null
      readonly retry_after_seconds: number | null
    }
  | { readonly event: "wait"; readonly kind: "queue" | "retry"; readonly milliseconds: number }
export type RequestObservation = {
  readonly path: string
  readonly method: RequestMethod
  readonly provider?: string
  /** Opaque, credential-scoped identity including query/body identity. Never a signed URL. */
  readonly key?: string
  readonly requestBytes?: number
  /** Already derived from the serialized HTTP request at the transport boundary. */
  readonly target?: NotionRequestTarget | null
  /** A metadata-shaped endpoint may carry retained body bytes. Never hide them as metadata. */
  readonly content?: "body" | "current_body" | "retained_body"
}

export function classifyRequest(request: RequestObservation): RequestKind {
  if (request.provider !== undefined && request.provider !== "notion") return "provider"
  const path = (request.path.split("?")[0] ?? "").replace(/^\//, "")
  const query =
    request.method === "POST" &&
    (path === "v1/search" ||
      /^v1\/data_sources\/[^/]+\/query$/.test(path) ||
      /^v1\/views\/[^/]+\/queries$/.test(path))
  if (query) return request.content === undefined ? "notion_metadata" : "notion_body"
  if (request.method !== "GET" && request.method !== "HEAD") return "notion_write"
  if (request.content !== undefined) return "notion_body"
  if (
    path === "v1/users/me" ||
    path === "v1/views" ||
    /^v1\/views\/[^/]+\/queries\/[^/]+$/.test(path) ||
    /^v1\/(pages|databases|data_sources|views)\/[^/]+$/.test(path)
  )
    return "notion_metadata"
  // Unknown read endpoints are not allowed to hide downloads inside metadata budgets.
  return "notion_body"
}

/** Subcategories do not add extra requests to the legacy notion_body total. */
export function classifyBodyRequest(request: RequestObservation): BodyRequestKind | undefined {
  if (classifyRequest(request) !== "notion_body") return undefined
  if (request.content === "retained_body") return "retained_body"
  if (request.content === "current_body") return "current_body"
  const path = (request.path.split("?")[0] ?? "").replace(/^\//, "")
  // Existing content:'body' hints on Records queries mean retained objects.
  if (
    request.content === "body" &&
    request.method === "POST" &&
    /^v1\/data_sources\/[^/]+\/query$/.test(path)
  )
    return "retained_body"
  if (/^v1\/pages\/[^/]+\/markdown$/.test(path) || /^v1\/blocks\/[^/]+(?:\/children)?$/.test(path))
    return "current_body"
  return "unclassified_body"
}

export type DurationSummary = {
  readonly samples: number
  readonly p50_ms: number | null
  readonly p95_ms: number | null
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be nonnegative.`)
  return value
}

function durations(samples: readonly number[]): DurationSummary {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    samples: sorted.length,
    p50_ms: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
  }
}

export type RequestMetricsSnapshot = {
  readonly requests: Readonly<Record<RequestKind, number>>
  readonly body_requests: Readonly<Record<BodyRequestKind, number>>
  readonly total_requests: number
  readonly provider_requests: Readonly<Record<string, number>>
  readonly request_bytes: number
  readonly response_bytes: number
  readonly unknown_request_bytes: number
  readonly unknown_response_bytes: number
  readonly in_flight: number
  readonly peak_concurrency: number
  readonly duplicate_requests: number
  readonly requests_without_identity: number
  readonly coalesced_requests: number
  readonly queue_wait_ms: number
  readonly retry_wait_ms: number
  readonly outcomes: Readonly<Record<RequestOutcome, number>>
  readonly request_duration: DurationSummary
  readonly operation_duration: DurationSummary
  /** Opt-in, bounded diagnostics. Never contains raw request paths, bodies or headers. */
  readonly trace: readonly RequestTraceEvent[]
  readonly trace_enabled: boolean
  readonly trace_dropped: number
}

export function createRequestMetrics(
  options: { readonly now?: () => number; readonly traceLimit?: number } = {},
) {
  const now = options.now ?? (() => performance.now())
  const traceLimit = options.traceLimit ?? 0
  if (!Number.isSafeInteger(traceLimit) || traceLimit < 0 || traceLimit > 10_000)
    throw new TypeError("traceLimit must be an integer from 0 to 10000.")
  const trace: RequestTraceEvent[] = []
  let traceDropped = 0
  let attempts = 0
  const retain = (entry: RequestTraceEvent) => {
    if (traceLimit === 0) return
    if (trace.length < traceLimit) trace.push(entry)
    else traceDropped += 1
  }
  const safeLabel = (value: string | undefined) =>
    value !== undefined && /^[A-Za-z0-9_.:/-]{1,160}$/u.test(value) ? value : null
  const requests: Record<RequestKind, number> = {
    notion_metadata: 0,
    notion_body: 0,
    notion_write: 0,
    provider: 0,
  }
  const outcomes: Record<RequestOutcome, number> = { success: 0, failure: 0, cancelled: 0 }
  const bodyRequests: Record<BodyRequestKind, number> = {
    current_body: 0,
    retained_body: 0,
    unclassified_body: 0,
  }
  const providers = new Map<string, number>()
  const identities = new Set<string>()
  const requestDurations: number[] = []
  const operationDurations: number[] = []
  let requestBytes = 0
  let responseBytes = 0
  let unknownRequestBytes = 0
  let unknownResponseBytes = 0
  let inFlight = 0
  let peak = 0
  let duplicates = 0
  let unidentified = 0
  let coalesced = 0
  let queueWait = 0
  let retryWait = 0

  return {
    begin(request: RequestObservation) {
      const sentAt = now()
      const attempt = ++attempts
      const kind = classifyRequest(request)
      const target = kind === "provider" ? null : (request.target ?? notionRequestTarget(request))
      const provider = request.provider ?? "notion"
      if (request.requestBytes !== undefined) nonNegative(request.requestBytes, "requestBytes")
      requests[kind] += 1
      const bodyKind = classifyBodyRequest(request)
      if (bodyKind !== undefined) bodyRequests[bodyKind] += 1
      providers.set(provider, (providers.get(provider) ?? 0) + 1)
      if (request.key === undefined) unidentified += 1
      else {
        const identity = JSON.stringify([provider, request.method, request.key])
        if (identities.has(identity)) duplicates += 1
        identities.add(identity)
      }
      if (request.requestBytes === undefined) unknownRequestBytes += 1
      else requestBytes += request.requestBytes
      inFlight += 1
      peak = Math.max(peak, inFlight)
      let finished = false
      return (result: RequestResponseObservation = {}) => {
        if (finished) return
        if (result.responseBytes !== undefined) nonNegative(result.responseBytes, "responseBytes")
        const elapsed = nonNegative(now() - sentAt, "elapsed")
        finished = true
        inFlight -= 1
        outcomes[result.outcome ?? "success"] += 1
        if (result.responseBytes === undefined) unknownResponseBytes += 1
        else responseBytes += result.responseBytes
        requestDurations.push(elapsed)
        retain({
          event: "attempt",
          attempt,
          kind,
          body_kind: bodyKind ?? null,
          target,
          method: request.method,
          started_ms: sentAt,
          duration_ms: elapsed,
          outcome: result.outcome ?? "success",
          request_bytes: request.requestBytes ?? null,
          response_bytes: result.responseBytes ?? null,
          http_status:
            result.httpStatus !== undefined &&
            Number.isInteger(result.httpStatus) &&
            result.httpStatus >= 100 &&
            result.httpStatus <= 599
              ? result.httpStatus
              : null,
          request_id: safeLabel(result.requestId),
          rate_limit_reason: safeLabel(result.rateLimitReason),
          retry_after_seconds:
            result.retryAfterSeconds !== undefined &&
            Number.isFinite(result.retryAfterSeconds) &&
            result.retryAfterSeconds >= 0
              ? result.retryAfterSeconds
              : null,
        })
      }
    },
    coalesced() {
      coalesced += 1
    },
    wait(milliseconds: number, kind: "queue" | "retry") {
      nonNegative(milliseconds, "wait")
      if (kind === "queue") queueWait += milliseconds
      else retryWait += milliseconds
      retain({ event: "wait", kind, milliseconds })
    },
    /** Record one real end-to-end operation, not one request or an invented matrix sample. */
    operation(milliseconds: number) {
      operationDurations.push(nonNegative(milliseconds, "operation duration"))
    },
    snapshot(): RequestMetricsSnapshot {
      return {
        requests: { ...requests },
        body_requests: { ...bodyRequests },
        total_requests: Object.values(requests).reduce((total, count) => total + count, 0),
        provider_requests: Object.fromEntries(providers),
        request_bytes: requestBytes,
        response_bytes: responseBytes,
        unknown_request_bytes: unknownRequestBytes,
        unknown_response_bytes: unknownResponseBytes,
        in_flight: inFlight,
        peak_concurrency: peak,
        duplicate_requests: duplicates,
        requests_without_identity: unidentified,
        coalesced_requests: coalesced,
        queue_wait_ms: queueWait,
        retry_wait_ms: retryWait,
        outcomes: { ...outcomes },
        request_duration: durations(requestDurations),
        operation_duration: durations(operationDurations),
        trace: [...trace],
        trace_enabled: traceLimit > 0,
        trace_dropped: traceDropped,
      }
    },
  }
}

export type PerChangeRequestCost = {
  readonly metadata: number
  readonly retainedBody: number
  readonly writes: number
}

/** One event lookup, plan/object body lookups, then three immutable creates. */
export const SHARED_ADOPTION_REQUEST_COST: PerChangeRequestCost = Object.freeze({
  metadata: 1,
  retainedBody: 2,
  writes: 3,
})

export type RequestBudget = {
  readonly scenario: "catalog" | "ttl_hit" | "ttl_expired" | "body_changed" | "retained_recovery"
  /** Number of metadata rows covered by the operation, including its main file if queried. */
  readonly fileCount: number
  readonly changedFiles?: number
  /** Known complete pagination across queried tables. Defaults to ceil(fileCount/100) for one table. */
  readonly metadataPages?: number
  /** Exact missing retained objects selected for this recovery, never all files by default. */
  readonly recoveredObjects?: number
  /** A fixed operation graph, shared across every N. Current-body reads remain bounded by k. */
  readonly perChangeCost?: PerChangeRequestCost
  /** Fixed auth/bootstrap/schema overhead, frozen across every N of the same scenario. */
  readonly metadataConstant: number
}

export class RequestBudgetError extends Error {
  readonly code = "REQUEST_BUDGET_EXCEEDED"
  readonly violations: readonly string[]
  constructor(violations: readonly string[]) {
    super(`Request budget exceeded: ${violations.join("; ")}`)
    this.name = "RequestBudgetError"
    this.violations = violations
  }
}

export function assertRequestBudget(actual: RequestMetricsSnapshot, budget: RequestBudget): void {
  const perChange = budget.perChangeCost ?? SHARED_ADOPTION_REQUEST_COST
  for (const [name, value] of Object.entries({
    fileCount: budget.fileCount,
    metadataConstant: budget.metadataConstant,
    changedFiles: budget.changedFiles ?? 0,
    metadataPages: budget.metadataPages ?? Math.max(1, Math.ceil(budget.fileCount / 100)),
    recoveredObjects: budget.recoveredObjects ?? 0,
    "perChangeCost.metadata": perChange.metadata,
    "perChangeCost.retainedBody": perChange.retainedBody,
    "perChangeCost.writes": perChange.writes,
  })) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new TypeError(`${name} must be a nonnegative integer.`)
  }
  const changed = budget.changedFiles ?? 0
  if (changed > budget.fileCount) throw new TypeError("changedFiles exceeds fileCount.")
  if ((budget.recoveredObjects ?? 0) > budget.fileCount)
    throw new TypeError("recoveredObjects exceeds fileCount.")
  const violations: string[] = []
  const atMost = (label: string, value: number, limit: number) => {
    if (value > limit) violations.push(`${label}=${value}, limit=${limit}`)
  }
  // An unfinished/failed run cannot pass by having stopped before issuing all required requests.
  atMost("in_flight", actual.in_flight, 0)
  atMost("failure", actual.outcomes.failure, 0)
  atMost("cancelled", actual.outcomes.cancelled, 0)
  if (budget.scenario === "ttl_hit") atMost("total_requests", actual.total_requests, 0)
  else {
    const pages = budget.metadataPages ?? Math.max(1, Math.ceil(budget.fileCount / 100))
    const affected = budget.scenario === "body_changed" ? changed : 0
    // P is the sum of real table pagination. Only changed files contribute
    // operation-specific requests; K and perChange must stay fixed across N.
    // Body-shaped lookups remain visible even when their response is empty.
    atMost(
      "notion_metadata",
      actual.requests.notion_metadata,
      pages + budget.metadataConstant + perChange.metadata * affected,
    )
    atMost("provider", actual.requests.provider, 0)
    const retained =
      budget.scenario === "retained_recovery"
        ? (budget.recoveredObjects ?? 0)
        : perChange.retainedBody * affected
    // Unclassified legacy body endpoints consume current-body allowance; they
    // cannot borrow the retained-object allowance to hide duplicate downloads.
    atMost(
      "current_body",
      actual.body_requests.current_body + actual.body_requests.unclassified_body,
      affected,
    )
    atMost("retained_body", actual.body_requests.retained_body, retained)
    atMost("notion_body", actual.requests.notion_body, affected + retained)
    atMost("notion_write", actual.requests.notion_write, perChange.writes * affected)
  }
  if (violations.length) throw new RequestBudgetError(violations)
}
