import { Cache, Effect, Equal, Fiber, Hash } from "effect"
import type { SkillsError } from "./model.ts"
import type { createRequestMetrics, RequestMethod } from "./request-metrics.ts"

export interface SharedReadRequest {
  /** Opaque identity including the credential, method, path and complete request body. */
  readonly key: string
  readonly path: string
  readonly method: RequestMethod
  readonly file?: string
  readonly content?: "body" | "current_body" | "retained_body"
}

/** POST queries are read operations; no other mutation-shaped endpoint is eligible. */
export function isCoalescibleNotionRead(request: SharedReadRequest): boolean {
  if (request.file !== undefined || request.key === "") return false
  const endpoint = (request.path.split("?", 1)[0] ?? "").replace(/^\//u, "")
  if (!endpoint.startsWith("v1/")) return false
  if (request.method === "GET") return true
  if (request.method !== "POST") return false
  if (endpoint === "v1/search") return true
  const query = /^v1\/(data_sources|views)\/([^/]+)\/(query|queries)$/u.exec(endpoint)
  if (
    query === null ||
    !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu.test(
      query[2] ?? "",
    )
  )
    return false
  return (
    (query[1] === "data_sources" && query[3] === "query") ||
    (query[1] === "views" && query[3] === "queries")
  )
}

/** Equality excludes the effect closure; one immutable transport identity selects its producer. */
class ReadKey<A> implements Equal.Equal {
  selectedForLookup = false
  readonly identity: string
  readonly execute: Effect.Effect<A, SkillsError>

  constructor(identity: string, execute: Effect.Effect<A, SkillsError>) {
    this.identity = identity
    this.execute = execute
  }

  [Equal.symbol](other: Equal.Equal): boolean {
    return other instanceof ReadKey && other.identity === this.identity
  }

  [Hash.symbol](): number {
    return Hash.string(this.identity)
  }
}

export interface SharedReadCoalescer {
  readonly run: (
    request: SharedReadRequest,
    execute: Effect.Effect<unknown, SkillsError>,
  ) => Effect.Effect<unknown, SkillsError>
}

/**
 * Create once per Notion service. Cache owns pending producers and their reference
 * counts; zero TTL releases success, failure and interruption without a result cache.
 * There is no capacity eviction of live requests. The transport's admission, retry
 * loop and actual-attempt metrics belong inside execute.
 */
export function makeSharedReadCoalescer(
  metrics?: Pick<ReturnType<typeof createRequestMetrics>, "coalesced">,
): Effect.Effect<SharedReadCoalescer> {
  return Effect.gen(function* () {
    const shared = yield* makeSharedResultCoalescer<unknown>(metrics)
    return {
      run: (request, execute) =>
        !isCoalescibleNotionRead(request)
          ? execute
          : shared.run(
              JSON.stringify([request.key, request.method, request.path, request.content ?? null]),
              execute,
            ),
    } satisfies SharedReadCoalescer
  })
}

export interface SharedResultCoalescer<A> {
  readonly run: (
    identity: string,
    execute: Effect.Effect<A, SkillsError>,
  ) => Effect.Effect<A, SkillsError>
}

/** Pending-only sharing for an already validated immutable source identity.
 * Callers own authorization and identity; this retains no completed result. */
export function makeSharedResultCoalescer<A>(
  metrics?: Pick<ReturnType<typeof createRequestMetrics>, "coalesced">,
): Effect.Effect<SharedResultCoalescer<A>> {
  return Effect.gen(function* () {
    const cache = yield* Cache.make({
      capacity: Infinity,
      timeToLive: 0,
      lookup: (key: ReadKey<A>) => {
        key.selectedForLookup = true
        return key.execute
      },
    })
    return {
      run: (identity, execute) =>
        Effect.suspend(() => {
          const key = new ReadKey(identity, execute)
          return Effect.acquireUseRelease(
            Effect.gen(function* () {
              // Enter Cache.get before observing lookup ownership. Each caller owns
              // only this waiter; Cache independently owns the shared producer.
              const waiter = yield* Effect.forkChild(Cache.get(cache, key), {
                startImmediately: true,
              })
              if (!key.selectedForLookup) metrics?.coalesced()
              return waiter
            }),
            Fiber.join,
            Fiber.interrupt,
          )
        }),
    } satisfies SharedResultCoalescer<A>
  })
}
