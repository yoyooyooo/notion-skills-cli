import { Context, Effect, Fiber } from "effect"
import type { SkillsError } from "./model.ts"
import type { createRequestMetrics } from "./request-metrics.ts"
import { makeSharedResultCoalescer } from "./shared-read-coalescing.ts"

/** Enabled only by the standard Node CLI/SDK runtime, whose Fetch transport can
 * be reconstructed with its own Scope. Injected/custom transports opt out. */
export class IndependentByteReadRuntime extends Context.Service<
  IndependentByteReadRuntime,
  boolean
>()("ntn-skills/IndependentByteReadRuntime") {}

/** Eligibility budgets remain per caller; different contracts cannot share a producer. */
export const ImmutableByteReadPolicy = Context.Reference<string>(
  "ntn-skills/ImmutableByteReadPolicy",
  { defaultValue: () => "fixed-read-default" },
)

export function makeBoundedImmutableReadCoalescer<A>(limits: {
  readonly entries: number
  readonly bytes: number
}) {
  return Effect.gen(function* () {
    const pending = yield* makeSharedResultCoalescer<A>()
    const open = new Map<
      string,
      { token: string; waiters: number; started: boolean; finished: boolean; bytes: number }
    >()
    let sequence = 0,
      active = 0,
      admittedBytes = 0
    return {
      run: (
        identity: string,
        bytes: number,
        execute: Effect.Effect<A, SkillsError>,
        metrics?: Pick<ReturnType<typeof createRequestMetrics>, "coalesced">,
      ) =>
        Effect.acquireUseRelease(
          Effect.gen(function* () {
            let entry = open.get(identity)
            if (entry === undefined) {
              if (
                !Number.isSafeInteger(bytes) ||
                bytes < 0 ||
                active >= limits.entries ||
                admittedBytes + bytes > limits.bytes
              )
                return {
                  waiter: yield* Effect.forkChild(execute, { startImmediately: true }),
                  release: () => {},
                }
              entry = {
                token: String(++sequence),
                waiters: 0,
                started: false,
                finished: false,
                bytes,
              }
              open.set(identity, entry)
              active += 1
              admittedBytes += bytes
            } else metrics?.coalesced()
            const selected = entry
            const finish = () => {
              if (selected.finished) return
              selected.finished = true
              active -= 1
              admittedBytes -= selected.bytes
              if (open.get(identity) === selected) open.delete(identity)
            }
            selected.waiters += 1
            const waiter = yield* Effect.forkChild(
              pending.run(
                selected.token,
                Effect.suspend(() => {
                  selected.started = true
                  return execute.pipe(Effect.ensuring(Effect.sync(finish)))
                }),
              ),
              { startImmediately: true },
            )
            return {
              waiter,
              release: () => {
                selected.waiters -= 1
                if (selected.waiters === 0) {
                  if (open.get(identity) === selected) open.delete(identity)
                  if (!selected.started) finish()
                }
              },
            }
          }),
          ({ waiter }) => Fiber.join(waiter),
          ({ waiter, release }) =>
            Effect.sync(release).pipe(Effect.andThen(Fiber.interrupt(waiter))),
        ),
    }
  })
}
