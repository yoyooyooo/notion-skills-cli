import { Context, Effect, Option } from "effect"
import { fail } from "./model.ts"
import { Notion } from "./notion.ts"
import { isCoalescibleNotionRead, makeSharedResultCoalescer } from "./shared-read-coalescing.ts"

/** A single read-only planner can share the observations it just obtained.
 * This is neither a freshness cache nor write authority. Original dispatch,
 * reconciliation and post-write verification must use the original transport. */
class AuthoringPlanReads extends Context.Service<
  AuthoringPlanReads,
  {
    readonly original: Notion["Service"]
    readonly scoped: Notion["Service"]
    readonly clear: () => void
  }
>()("ntn-skills/AuthoringPlanReads") {}

const maxEntries = 128
const maxBytes = 8 * 1024 * 1024

/** Scope ends before dispatch. Only successful complete transport observations
 * are memoized; their existing domain decoders remain mandatory at every use.
 * No local Store receipt, metadata timestamp or remote state is synthesized. */
export function withAuthoringPlanReads<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* Effect.serviceOption(AuthoringPlanReads))) return yield* effect
    const original = yield* Notion
    const cache = new Map<string, unknown>()
    let bytes = 0
    let closed = false
    const shared = yield* makeSharedResultCoalescer<unknown>()
    const clear = () => {
      closed = true
      cache.clear()
      bytes = 0
    }
    const api: Notion["Service"] = {
      ...original,
      readOnly: true,
      request: (path, body, options) =>
        Effect.suspend(() => {
          const method = options?.method ?? (body === undefined ? "GET" : "POST")
          const key = JSON.stringify([path, body ?? null, options ?? null])
          if (!isCoalescibleNotionRead({ key, path, method, file: options?.file }))
            return Effect.fail(
              fail(
                "SHARED_PLAN_READ_ONLY",
                "A planner cannot dispatch a write. Leave its observation scope before executing an original operation.",
              ),
            )
          // Leaving planning is one-way. Even a retained reference or a late
          // producer cannot seed/join a pre-write observation afterward.
          if (closed) return original.request(path, body, options)
          const cached = cache.get(key)
          if (cache.has(key)) return Effect.sync(() => structuredClone(cached))
          return shared
            .run(
              key,
              Effect.gen(function* () {
                const value = yield* original.request(path, body, options)
                if (!closed && cache.size < maxEntries) {
                  const size = new TextEncoder().encode(JSON.stringify(value)).byteLength
                  if (bytes + size <= maxBytes) {
                    cache.set(key, structuredClone(value))
                    bytes += size
                  }
                }
                return value
              }),
            )
            .pipe(Effect.map((value) => structuredClone(value)))
        }),
    }
    return yield* effect.pipe(
      Effect.provideService(Notion, api),
      Effect.provideService(AuthoringPlanReads, { original, scoped: api, clear }),
      Effect.ensuring(Effect.sync(clear)),
    )
  })
}

/** Explicit capability boundary: current guards and original writes see fresh
 * transport responses, including on reconcile and unknown-outcome paths. */
export function outsideAuthoringPlanReads<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const context = yield* Effect.serviceOption(AuthoringPlanReads)
    if (Option.isNone(context)) return yield* effect
    context.value.clear()
    const current = yield* Notion
    // An inner read-only or separately authenticated transport is not ours to
    // replace. Never unwrap another caller's restriction or credential scope.
    return yield* effect.pipe(
      Effect.provideService(
        Notion,
        current === context.value.scoped ? context.value.original : current,
      ),
    )
  })
}
