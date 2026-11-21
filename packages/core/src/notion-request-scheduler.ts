import { randomUUID } from "node:crypto"
import { lstat } from "node:fs/promises"
import { userInfo } from "node:os"
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path"
import {
  Clock,
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Random,
  Semaphore,
} from "effect"
import { SqlClient } from "effect/sql"
import { fail, SkillsError } from "./model.ts"
import { probeSqliteRuntime } from "./sqlite-runtime-policy.ts"

export const NOTION_ADMISSION_BUDGET_MS = 5 * 60_000
export const NOTION_QUEUE_LIMIT = 256
const requestIntervalMs = 350
const leaseMs = 2_000
const agingMs = 15_000

export type RequestPriority = "foreground" | "required" | "prefetch"
/** Delay policy only; the transport remains the single owner of retry attempts. */
export const notionRetryDelay = (input: {
  readonly attempt: number
  readonly retryAfterSeconds?: number
}) =>
  Effect.gen(function* () {
    const fallback = Math.min(30_000, 1_000 * 2 ** Math.min(30, Math.max(0, input.attempt)))
    const server =
      input.retryAfterSeconds !== undefined &&
      Number.isFinite(input.retryAfterSeconds) &&
      input.retryAfterSeconds >= 0
        ? Math.min(Number.MAX_VALUE, input.retryAfterSeconds * 1_000)
        : 0
    return Math.min(
      Number.MAX_VALUE,
      Math.max(fallback, server) + (yield* Random.nextIntBetween(0, 251)),
    )
  })
export type RequestScheduleOptions = {
  /** Proven server identity, never a database ID or display name. */
  readonly connection?: string
  readonly workspace?: string | null
  readonly apiOrigin?: string
  readonly endpoint?: string
  readonly priority?: RequestPriority
  readonly queueBudgetMs?: number
  /** Additional prefetch-only rate lane. Foreground requests do not wait on this lane. */
  readonly rateShare?: number
  /** Actual sleep intervals only; includes partial waits interrupted by cancellation. */
  readonly onWait?: (started: bigint, ended: bigint) => void
}
type ScopeBudget = { readonly key: string; readonly interval: number }
type PendingRequest = {
  readonly id: string
  readonly lane: string
  readonly created: number
  readonly priority: number
  readonly limit: number
}
type ClaimContext = {
  readonly scopes: readonly ScopeBudget[]
  readonly pending: PendingRequest
}
type Admission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly at: number; readonly deferred?: "foreground_pending" }

export interface RequestScheduleState {
  /** Claim only a slot which is due now; never reserve a future send. */
  readonly claim: (
    credential: string,
    now: number,
    interval: number,
    context?: ClaimContext,
  ) => Effect.Effect<Admission, SkillsError>
  readonly defer: (
    credential: string,
    until: number,
    scopes?: readonly string[],
  ) => Effect.Effect<void, SkillsError>
  readonly enqueue?: (request: PendingRequest, now: number) => Effect.Effect<void, SkillsError>
  readonly remove?: (id: string) => Effect.Effect<void, SkillsError>
  readonly blocked?: (id: string, blocked: boolean) => Effect.Effect<void, SkillsError>
}

export class NotionRequestScheduler extends Context.Service<
  NotionRequestScheduler,
  {
    readonly acquire: (
      credential: string,
      deadline: bigint,
      options?: RequestScheduleOptions,
    ) => Effect.Effect<void, SkillsError>
    readonly withAdmission: <A, E, R>(
      credential: string,
      deadline: bigint,
      permits: Semaphore.Semaphore,
      attempt: Effect.Effect<A, E, R>,
      options?: RequestScheduleOptions,
    ) => Effect.Effect<A, E | SkillsError, R>
    readonly cooldown: (
      credential: string,
      millis: number,
      options?: RequestScheduleOptions & { readonly reason?: string },
    ) => Effect.Effect<void, SkillsError>
  }
>()("ntn-skills/NotionRequestScheduler") {}

export function notionEndpoint(path: string, method: string): string {
  const endpoint = (path.split("?")[0] ?? "").replace(/^\//u, "")
  if (method === "POST" && /^v1\/data_sources\/[^/]+\/query$/u.test(endpoint))
    return "POST data-source-query"
  if (method === "POST" && /^v1\/views\/[^/]+\/queries$/u.test(endpoint)) return "POST view-query"
  return `${method} ${endpoint.replace(/[a-f\d]{8}-[a-f\d-]{27}|[a-f\d]{32}/giu, ":id")}`
}

function scopesFor(credential: string, interval: number, options: RequestScheduleOptions) {
  const origin = options.apiOrigin ?? ""
  const scopes: ScopeBudget[] = [
    { key: JSON.stringify(["credential", origin, credential]), interval },
  ]
  if (options.connection !== undefined)
    scopes.push({ key: JSON.stringify(["connection", origin, options.connection]), interval })
  else if (options.apiOrigin !== undefined)
    scopes.push({ key: JSON.stringify(["bootstrap", origin]), interval })
  if (options.workspace)
    scopes.push({ key: JSON.stringify(["workspace", origin, options.workspace]), interval: 0 })
  if (options.endpoint !== undefined)
    scopes.push({
      key: JSON.stringify(["endpoint", origin, options.connection ?? credential, options.endpoint]),
      interval: options.endpoint === "POST data-source-query" ? interval : 0,
    })
  if (options.priority === "prefetch")
    scopes.push({
      key: JSON.stringify(["prefetch", origin, options.connection ?? credential]),
      interval: Math.ceil(interval / (options.rateShare ?? 0.1)),
    })
  return scopes
}

function cooldownScopes(
  credential: string,
  interval: number,
  options: RequestScheduleOptions & { readonly reason?: string },
) {
  const all = scopesFor(credential, interval, options)
  const tagged = (tag: string) => all.filter((scope) => scope.key.startsWith(`["${tag}",`))
  switch (options.reason) {
    case "public_api_space_request_rate_limit":
      return options.workspace ? tagged("workspace") : all
    case "public_api_endpoint_rate_limit":
    case "collection_router_too_many_requests":
    case "collection_router_upstream_429":
      return options.endpoint ? tagged("endpoint") : all
    case "public_api_request_rate_limit":
    case "public_api_request_blocked":
      return [...tagged("credential"), ...tagged("connection")]
    default:
      return all
  }
}

const queueFull = (limit: number) =>
  fail("NOTION_QUEUE_FULL", "The bounded Notion request queue is full.", {
    phase: "input_rejected",
    reason: "queue_capacity",
    queue_limit: limit,
  })

const prefetchDeferred = () =>
  fail("NOTION_PREFETCH_DEFERRED", "Prefetch stopped because a foreground request is waiting.", {
    phase: "input_rejected",
    deferred: true,
    reason: "foreground_pending",
  })

/** A short local priority queue plus the driver's cross-process queue. No worker,
 * timer or permit survives its owner. The SQL driver leases only queue positions.
 */
export const makeRequestScheduler = (
  state: RequestScheduleState,
  settings: { readonly intervalMs?: number; readonly maxQueued?: number } = {},
) =>
  Effect.gen(function* () {
    const interval = settings.intervalMs ?? requestIntervalMs
    const maxQueued = settings.maxQueued ?? NOTION_QUEUE_LIMIT
    const pending = new Map<string, PendingRequest>()
    const networkBlocked = new Set<string>()
    const score = (request: PendingRequest, now: number) =>
      Math.max(0, request.priority - Math.floor((now - request.created) / agingMs))
    const first = (lane: string, now: number) =>
      [...pending.values()]
        .filter((entry) => entry.lane === lane && !networkBlocked.has(entry.id))
        .sort(
          (left, right) => score(left, now) - score(right, now) || left.created - right.created,
        )[0]?.id

    function schedule<A, E, R>(
      credential: string,
      operationDeadline: bigint,
      attempt: Effect.Effect<A, E, R>,
      options: RequestScheduleOptions = {},
      permits?: Semaphore.Semaphore,
    ): Effect.Effect<A, E | SkillsError, R> {
      return Effect.suspend(() =>
        Effect.gen(function* () {
          if (
            options.rateShare !== undefined &&
            (options.priority !== "prefetch" ||
              !Number.isFinite(options.rateShare) ||
              options.rateShare <= 0 ||
              options.rateShare > 1)
          )
            return yield* Effect.fail(
              fail(
                "CONFIG_ERROR",
                "Prefetch rate share must be greater than zero and at most one.",
              ),
            )
          const scopes = scopesFor(credential, interval, options)
          const lane = JSON.stringify([options.apiOrigin ?? "", options.connection ?? credential])
          const queueBudget = options.queueBudgetMs ?? NOTION_ADMISSION_BUDGET_MS
          if (!Number.isSafeInteger(queueBudget) || queueBudget <= 0)
            return yield* Effect.fail(
              fail("CONFIG_ERROR", "The request queue budget must be positive."),
            )
          const started = yield* Clock.monotonicTimeNanos
          const queueDeadline = started + BigInt(queueBudget) * 1_000_000n
          const deadline = queueDeadline < operationDeadline ? queueDeadline : operationDeadline
          const ticket: PendingRequest = {
            id: randomUUID(),
            lane,
            created: yield* Clock.currentTimeMillis,
            priority: options.priority === "prefetch" ? 2 : 0,
            limit: maxQueued,
          }
          let renewAt = ticket.created + leaseMs / 2
          const inLane = [...pending.values()].filter((entry) => entry.lane === lane).length
          if (inLane >= maxQueued) return yield* Effect.fail(queueFull(maxQueued))
          const release = Effect.gen(function* () {
            pending.delete(ticket.id)
            networkBlocked.delete(ticket.id)
            if (state.remove) yield* state.remove(ticket.id)
          })
          return yield* Effect.acquireUseRelease(
            Effect.gen(function* () {
              pending.set(ticket.id, ticket)
              if (state.enqueue) yield* state.enqueue(ticket, ticket.created)
            }).pipe(Effect.onError(() => release.pipe(Effect.ignore))),
            () =>
              Effect.gen(function* () {
                while (true) {
                  const remaining = Number(deadline - (yield* Clock.monotonicTimeNanos)) / 1_000_000
                  const expired = (delay?: number) =>
                    fail(
                      "RATE_LIMITED",
                      "Notion request admission is deferred beyond its waiting budget.",
                      {
                        phase: "input_rejected",
                        reason: "admission_wait_exhausted",
                        deferred: true,
                        budget: queueDeadline < operationDeadline ? "queue" : "operation",
                        ...(delay === undefined
                          ? {}
                          : { retry_after_seconds: Math.ceil(delay / 1_000) }),
                      },
                    )
                  if (remaining <= 0) return yield* Effect.fail(expired())
                  const now = yield* Clock.currentTimeMillis
                  if (state.enqueue && now >= renewAt) {
                    yield* state.enqueue(ticket, now)
                    renewAt = now + leaseMs / 2
                  }
                  const take = Effect.gen(function* () {
                    const current = yield* Clock.currentTimeMillis
                    if (
                      ticket.priority > 0 &&
                      [...pending.values()].some(
                        (entry) =>
                          entry.lane === lane && entry.id !== ticket.id && entry.priority === 0,
                      )
                    )
                      return yield* Effect.fail(prefetchDeferred())
                    if (networkBlocked.delete(ticket.id) && state.blocked)
                      yield* state.blocked(ticket.id, false)
                    if (first(lane, current) !== ticket.id)
                      return { kind: "wait", at: current + 25 } as const
                    // Semaphore acquisition might have waited for another HTTP request.
                    if ((yield* Clock.monotonicTimeNanos) >= deadline)
                      return yield* Effect.fail(expired())
                    const decision = yield* state.claim(credential, current, interval, {
                      scopes,
                      pending: ticket,
                    })
                    if (!decision.admitted) {
                      if (decision.deferred === "foreground_pending")
                        return yield* Effect.fail(prefetchDeferred())
                      return { kind: "wait", at: decision.at } as const
                    }
                    // A shared driver removes the queue row in the same admission
                    // transaction. Do not run another SQL operation before sending.
                    pending.delete(ticket.id)
                    return { kind: "done", value: yield* attempt } as const
                  })
                  const granted = permits
                    ? yield* permits.withPermitsIfAvailable(1)(take)
                    : Option.some(yield* take)
                  if (Option.isNone(granted) && !networkBlocked.has(ticket.id)) {
                    networkBlocked.add(ticket.id)
                    if (state.blocked) yield* state.blocked(ticket.id, true)
                  }
                  const outcome = Option.isSome(granted)
                    ? granted.value
                    : ({ kind: "wait", at: now + 25 } as const)
                  if (outcome.kind === "done") return outcome.value
                  const delay = Math.max(1, outcome.at - now)
                  if (delay > remaining) return yield* Effect.fail(expired(delay))
                  // Refresh the leased queue position after each short wait. No network
                  // permit or SQL transaction is held while sleeping.
                  const waitingAt = yield* Clock.monotonicTimeNanos
                  yield* Effect.sleep(Math.min(delay, leaseMs / 2)).pipe(
                    Effect.onExit(() =>
                      Effect.gen(function* () {
                        const ended = yield* Clock.monotonicTimeNanos
                        yield* Effect.sync(() => options.onWait?.(waitingAt, ended))
                      }),
                    ),
                  )
                }
              }),
            // Queue leases expire independently when SQL cleanup itself is unavailable.
            () => release.pipe(Effect.ignore),
          )
        }),
      )
    }

    return {
      acquire: (credential, deadline, options) =>
        schedule(credential, deadline, Effect.void, options),
      withAdmission: (credential, deadline, permits, attempt, options) =>
        schedule(credential, deadline, attempt, options, permits),
      cooldown: (credential, millis, options = {}) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const until = Math.min(Number.MAX_VALUE, now + Math.max(0, millis))
          yield* state.defer(
            credential,
            until,
            cooldownScopes(credential, interval, options).map((scope) => scope.key),
          )
        }),
    } satisfies NotionRequestScheduler["Service"]
  })

const schedulerError = (error: unknown) =>
  error instanceof SkillsError
    ? error
    : fail("NOTION_SCHEDULER_UNAVAILABLE", "The shared Notion request schedule is unavailable.", {
        phase: "input_rejected",
      })

const privatePath = (path: string, directory: boolean) =>
  Effect.tryPromise({
    try: async () => {
      const absolute = resolve(path)
      let ancestor = parse(absolute).root
      for (const part of relative(ancestor, absolute).split(sep).slice(0, -1)) {
        ancestor = join(ancestor, part)
        try {
          const info = await lstat(ancestor)
          if (info.isSymbolicLink() || !info.isDirectory()) throw schedulerError(undefined)
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          )
            break
          throw error
        }
      }
      try {
        const info = await lstat(path)
        if (
          info.isSymbolicLink() ||
          (directory ? !info.isDirectory() : !info.isFile()) ||
          info.uid !== userInfo().uid
        )
          throw schedulerError(undefined)
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return
        throw error
      }
    },
    catch: schedulerError,
  })

/** The explicit root is for machine configuration or owned tests. Content cache
 * roots never choose this file. Only safe scope digests and short queue leases
 * are stored; no paths, bodies, tokens or publication evidence.
 */
export const makeSqliteRequestScheduler = (
  root: string,
  settings: { readonly intervalMs?: number; readonly maxQueued?: number } = {},
) =>
  Effect.gen(function* () {
    yield* probeSqliteRuntime
    const fs = yield* FileSystem.FileSystem
    yield* privatePath(root, true)
    yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 })
    yield* privatePath(root, true)
    yield* fs.chmod(root, 0o700)
    const filename = join(root, "notion-requests.sqlite")
    yield* privatePath(filename, false)
    yield* privatePath(`${filename}-wal`, false)
    yield* privatePath(`${filename}-shm`, false)
    const { SqliteClient } = yield* Effect.tryPromise({
      try: () => import("@effect/sql-sqlite-node"),
      catch: schedulerError,
    })
    const context = yield* Layer.build(SqliteClient.layer({ filename, busyTimeout: "2 seconds" }))
    const sql = Context.get(context, SqlClient.SqlClient)
    yield* fs.chmod(filename, 0o600)
    yield* sql`CREATE TABLE IF NOT EXISTS request_schedule (credential TEXT PRIMARY KEY, next_start_ms REAL NOT NULL, cooldown_until_ms REAL NOT NULL)`
    yield* sql`CREATE TABLE IF NOT EXISTS request_waiters (id TEXT PRIMARY KEY, lane TEXT NOT NULL, priority INTEGER NOT NULL, created_ms REAL NOT NULL, lease_until_ms REAL NOT NULL, network_blocked INTEGER NOT NULL DEFAULT 0)`
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const columns = yield* sql<{ name: string }>`PRAGMA table_info(request_waiters)`
        if (!columns.some((column) => column.name === "network_blocked"))
          yield* sql`ALTER TABLE request_waiters ADD COLUMN network_blocked INTEGER NOT NULL DEFAULT 0`
      }),
    )
    yield* sql`CREATE INDEX IF NOT EXISTS request_waiters_lane ON request_waiters(lane,lease_until_ms)`
    const run = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(schedulerError))
    const ensure = (key: string) =>
      sql`INSERT INTO request_schedule (credential,next_start_ms,cooldown_until_ms) VALUES (${key},0,0) ON CONFLICT(credential) DO NOTHING`
    const enqueue = (entry: PendingRequest, now: number) =>
      Effect.gen(function* () {
        const current = Math.max(now, yield* Clock.currentTimeMillis)
        yield* sql`DELETE FROM request_waiters WHERE lease_until_ms<=${current}`
        const rows = yield* sql<{
          id: string
        }>`INSERT INTO request_waiters (id,lane,priority,created_ms,lease_until_ms)
      SELECT ${entry.id},${entry.lane},${entry.priority},${entry.created},${current + leaseMs}
      WHERE (SELECT COUNT(*) FROM request_waiters WHERE lane=${entry.lane} AND id!=${entry.id})<${entry.limit}
      ON CONFLICT(id) DO UPDATE SET lease_until_ms=${current + leaseMs} RETURNING id`
        if (rows.length !== 1) return yield* Effect.fail(queueFull(entry.limit))
      })
    return yield* makeRequestScheduler(
      {
        enqueue: (entry, now) => run(sql.withTransaction(enqueue(entry, now))),
        remove: (id) => run(sql`DELETE FROM request_waiters WHERE id=${id}`.pipe(Effect.asVoid)),
        blocked: (id, blocked) =>
          run(
            sql`UPDATE request_waiters SET network_blocked=${blocked ? 1 : 0} WHERE id=${id}`.pipe(
              Effect.asVoid,
            ),
          ),
        claim: (credential, now, interval, claim) =>
          run(
            sql.withTransaction(
              Effect.gen(function* () {
                // BEGIN IMMEDIATE can wait on another process. Sample after that wait,
                // otherwise an already-expired timestamp would permit a send burst.
                const current = Math.max(now, yield* Clock.currentTimeMillis)
                const scopes = claim?.scopes ?? [{ key: credential, interval }]
                if (claim) {
                  yield* enqueue(claim.pending, current)
                  if (claim.pending.priority > 0) {
                    const foreground = yield* sql<{ id: string }>`SELECT id FROM request_waiters
                      WHERE lane=${claim.pending.lane} AND lease_until_ms>${current}
                      AND priority=0 AND id!=${claim.pending.id} LIMIT 1`
                    if (foreground.length > 0)
                      return {
                        admitted: false,
                        at: current,
                        deferred: "foreground_pending",
                      } as const
                  }
                  const next = yield* sql<{
                    id: string
                  }>`SELECT id FROM request_waiters WHERE lane=${claim.pending.lane} AND lease_until_ms>${current} AND network_blocked=0
          ORDER BY MAX(0,priority-CAST((${current}-created_ms)/${agingMs} AS INTEGER)),created_ms,rowid LIMIT 1`
                  if (next[0]?.id !== claim.pending.id)
                    return { admitted: false, at: current + 25 } as const
                }
                for (const scope of scopes) yield* ensure(scope.key)
                const rows = yield* sql<{
                  at: number
                }>`SELECT MAX(MAX(next_start_ms,cooldown_until_ms)) AS at FROM request_schedule WHERE ${sql.in(
                  "credential",
                  scopes.map((scope) => scope.key),
                )}`
                const at = rows[0]?.at
                if (rows.length !== 1 || typeof at !== "number" || !Number.isFinite(at))
                  return yield* Effect.fail(schedulerError(undefined))
                if (at > current) return { admitted: false, at } as const
                if (claim) yield* sql`DELETE FROM request_waiters WHERE id=${claim.pending.id}`
                const intervals = sql.join(
                  " ",
                  false,
                )(scopes.map((scope) => sql`WHEN ${scope.key} THEN ${scope.interval}`))
                // Preparation must not consume the next request's interval. Keep the
                // freshly sampled budget update as the transaction's final write.
                const admittedAt = Math.max(current, yield* Clock.currentTimeMillis)
                yield* sql`UPDATE request_schedule SET next_start_ms=${admittedAt} + CASE credential ${intervals} END WHERE ${sql.in(
                  "credential",
                  scopes.map((scope) => scope.key),
                )}`
                return { admitted: true } as const
              }),
            ),
          ),
        defer: (credential, until, keys = [credential]) =>
          run(
            sql.withTransaction(
              Effect.gen(function* () {
                for (const key of keys) {
                  yield* ensure(key)
                  yield* sql`UPDATE request_schedule SET cooldown_until_ms=MAX(cooldown_until_ms,${until}) WHERE credential=${key}`
                }
              }),
            ),
          ),
      },
      settings,
    )
  }).pipe(Effect.mapError(schedulerError))

export const NotionRequestSchedulerLive = Layer.effect(
  NotionRequestScheduler,
  Effect.gen(function* () {
    const root = yield* Config.String("NTN_SKILLS_SCHEDULER_ROOT").pipe(
      Config.withDefault(
        join(userInfo().homedir, ".local", "state", "ntn-skills", "request-engine"),
      ),
      Effect.mapError(schedulerError),
    )
    if (!isAbsolute(root))
      return yield* Effect.fail(
        fail("CONFIG_ERROR", "NTN_SKILLS_SCHEDULER_ROOT must be an absolute private directory."),
      )
    const configuredLimit = yield* Config.String("NTN_SKILLS_NOTION_QUEUE_LIMIT").pipe(
      Config.withDefault(String(NOTION_QUEUE_LIMIT)),
      Effect.mapError(schedulerError),
    )
    const configuredInterval = yield* Config.String("NTN_SKILLS_NOTION_INTERVAL_MS").pipe(
      Config.withDefault(String(requestIntervalMs)),
      Effect.mapError(schedulerError),
    )
    const maxQueued = Number(configuredLimit)
    const intervalMs = Number(configuredInterval)
    if (
      !Number.isSafeInteger(maxQueued) ||
      maxQueued < 1 ||
      maxQueued > 4096 ||
      !Number.isSafeInteger(intervalMs) ||
      intervalMs < 100 ||
      intervalMs > 60_000
    )
      return yield* Effect.fail(
        fail(
          "CONFIG_ERROR",
          "Notion queue limit must be 1..4096 and conservative interval 100..60000 ms.",
        ),
      )
    return yield* makeSqliteRequestScheduler(root, { maxQueued, intervalMs })
  }),
)
