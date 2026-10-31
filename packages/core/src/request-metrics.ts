/** Counts actual transport attempts. Call begin after admission, immediately before sending. */
export type RequestKind = "notion_metadata" | "notion_body" | "notion_write" | "provider"
export type BodyRequestKind = "current_body" | "retained_body" | "unclassified_body"
export type RequestMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "HEAD"
export type RequestOutcome = "success" | "failure" | "cancelled"
export type RequestObservation = {
  readonly path: string
  readonly method: RequestMethod
  readonly provider?: string
  /** Opaque, credential-scoped identity including query/body identity. Never a signed URL. */
  readonly key?: string
  readonly requestBytes?: number
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
}

export function createRequestMetrics(options: { readonly now?: () => number } = {}) {
  const now = options.now ?? (() => performance.now())
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
      const kind = classifyRequest(request)
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
      return (
        result: { readonly outcome?: RequestOutcome; readonly responseBytes?: number } = {},
      ) => {
        if (finished) return
        if (result.responseBytes !== undefined) nonNegative(result.responseBytes, "responseBytes")
        const elapsed = nonNegative(now() - sentAt, "elapsed")
        finished = true
        inFlight -= 1
        outcomes[result.outcome ?? "success"] += 1
        if (result.responseBytes === undefined) unknownResponseBytes += 1
        else responseBytes += result.responseBytes
        requestDurations.push(elapsed)
      }
    },
    coalesced() {
      coalesced += 1
    },
    wait(milliseconds: number, kind: "queue" | "retry") {
      nonNegative(milliseconds, "wait")
      if (kind === "queue") queueWait += milliseconds
      else retryWait += milliseconds
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
