import { Clock, Context, Effect, FileSystem, Layer, Semaphore } from "effect"
import { SqlClient } from "effect/sql"
import { fail, SkillsError } from "./model.ts"
import { probeSqliteRuntime } from "./sqlite-runtime-policy.ts"
import { Store } from "./store.ts"

export const NOTION_ADMISSION_BUDGET_MS = 5 * 60_000
const requestIntervalMs = 350

export interface RequestScheduleState {
  /** Atomically claim a due slot, or return the next permitted wall-clock time. */
  readonly claim: (
    credential: string,
    now: number,
    interval: number,
  ) => Effect.Effect<
    { readonly admitted: true } | { readonly admitted: false; readonly at: number },
    SkillsError
  >
  readonly defer: (credential: string, until: number) => Effect.Effect<void, SkillsError>
}

export class NotionRequestScheduler extends Context.Service<
  NotionRequestScheduler,
  {
    readonly acquire: (credential: string, deadline: bigint) => Effect.Effect<void, SkillsError>
    readonly cooldown: (credential: string, millis: number) => Effect.Effect<void, SkillsError>
  }
>()("ntn-skills/NotionRequestScheduler") {}

/** The state driver is shared across processes; only this short local queue is
 * per service. Waiters claim nothing until due and interruption releases the queue.
 */
export const makeRequestScheduler = (state: RequestScheduleState) =>
  Effect.gen(function* () {
    const queue = yield* Semaphore.make(1)
    return {
      acquire: (credential: string, deadline: bigint) =>
        queue.withPermit(
          Effect.gen(function* () {
            while (true) {
              const remaining = Number(deadline - (yield* Clock.monotonicTimeNanos)) / 1_000_000
              if (remaining <= 0)
                return yield* Effect.fail(
                  fail("RATE_LIMITED", "The bounded wait for Notion request admission expired.", {
                    phase: "input_rejected",
                    reason: "admission_wait_exhausted",
                  }),
                )
              const now = yield* Clock.currentTimeMillis
              const decision = yield* state.claim(credential, now, requestIntervalMs)
              if (decision.admitted) return
              const delay = Math.max(1, decision.at - now)
              if (delay > remaining)
                return yield* Effect.fail(
                  fail("RATE_LIMITED", "Notion's cooldown exceeds this request's waiting budget.", {
                    phase: "input_rejected",
                    reason: "admission_wait_exhausted",
                    retry_after_seconds: Math.ceil(delay / 1_000),
                  }),
                )
              // Recheck shared extensions and cancellation without a long held SQL transaction.
              yield* Effect.sleep(Math.min(delay, 30_000))
            }
          }),
        ),
      cooldown: (credential: string, millis: number) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          // Preserve even an unrepresentably large server delay as a far-future
          // refusal, rather than turning it into a short fallback or Infinity row.
          yield* state.defer(credential, Math.min(Number.MAX_VALUE, now + millis))
        }),
    } satisfies NotionRequestScheduler["Service"]
  })

const schedulerError = (error: unknown) =>
  error instanceof SkillsError
    ? error
    : fail("NOTION_SCHEDULER_UNAVAILABLE", "The shared Notion request schedule is unavailable.", {
        phase: "input_rejected",
      })

/** Scheduling is disposable coordination, separate from authoritative publication
 * state. SQLite supplies atomic admission and crash recovery without per-request
 * PID locks. No request paths, bodies, tokens or publication evidence are stored.
 */
export const makeSqliteRequestScheduler = (cacheRoot: string) =>
  Effect.gen(function* () {
    yield* probeSqliteRuntime
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(cacheRoot, { recursive: true, mode: 0o700 })
    const { SqliteClient } = yield* Effect.tryPromise({
      try: () => import("@effect/sql-sqlite-node"),
      catch: schedulerError,
    })
    const context = yield* Layer.build(
      SqliteClient.layer({
        filename: `${cacheRoot}/notion-requests.sqlite`,
        busyTimeout: "2 seconds",
      }),
    )
    const sql = Context.get(context, SqlClient.SqlClient)
    yield* sql`CREATE TABLE IF NOT EXISTS request_schedule (credential TEXT PRIMARY KEY, next_start_ms REAL NOT NULL, cooldown_until_ms REAL NOT NULL)`
    const run = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(schedulerError))
    const ensure = (credential: string) =>
      sql`INSERT INTO request_schedule (credential,next_start_ms,cooldown_until_ms) VALUES (${credential},0,0) ON CONFLICT(credential) DO NOTHING`
    return yield* makeRequestScheduler({
      claim: (credential, now, interval) =>
        run(
          Effect.gen(function* () {
            yield* ensure(credential)
            // A single conditional write is the cross-process admission boundary.
            const claimed = yield* sql<{
              credential: string
            }>`UPDATE request_schedule SET next_start_ms=${now + interval} WHERE credential=${credential} AND next_start_ms<=${now} AND cooldown_until_ms<=${now} RETURNING credential`
            if (claimed.length === 1) return { admitted: true } as const
            const rows = yield* sql<{
              at: number
            }>`SELECT MAX(next_start_ms,cooldown_until_ms) AS at FROM request_schedule WHERE credential=${credential}`
            const at = rows[0]?.at
            if (rows.length !== 1 || typeof at !== "number" || !Number.isFinite(at))
              return yield* Effect.fail(schedulerError(undefined))
            return { admitted: false, at } as const
          }),
        ),
      defer: (credential, until) =>
        run(
          Effect.gen(function* () {
            yield* ensure(credential)
            yield* sql`UPDATE request_schedule SET cooldown_until_ms=MAX(cooldown_until_ms,${until}) WHERE credential=${credential}`
          }),
        ),
    })
  }).pipe(Effect.mapError(schedulerError))

export const NotionRequestSchedulerLive = Layer.effect(
  NotionRequestScheduler,
  Effect.gen(function* () {
    const store = yield* Store
    return yield* makeSqliteRequestScheduler(store.cacheRoot)
  }),
)
