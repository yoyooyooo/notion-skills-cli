import { Clock, Context, Crypto, Effect, Option, Schema } from "effect"
import { fail, property, SkillsError } from "./model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { Store, sha256 } from "./store.ts"

/** Ref advertisements are bounded metadata observations, never an authorization
 * grant or a certificate for Notion's current Source plan. */
export const DEFAULT_SOURCE_REF_MAX_AGE_MS = 60_000
export const SOURCE_REF_CACHE_PREFIX = "cache/shared-source-refs"
const terminalRunMarkers = new Set(["TERM_SESSION_ID", "ITERM_SESSION_ID", "SHLVL", "_", "OLDPWD"])

/** The standard runtime supplies the same captured environment and cwd used by
 * its Git spawner. A custom runtime without that contract does not share durable
 * observations. Helpers remain opaque; only this local routing context is known. */
export class SourceRefAccessContext extends Context.Service<
  SourceRefAccessContext,
  {
    readonly cwd: string
    readonly environment: Readonly<Record<string, string | undefined>>
  }
>()("ntn-skills/SourceRefAccessContext") {}

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Commit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u))
const BoundedText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))
const Time = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const Generation = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))

export const SourceRefObservationSchema = Schema.Struct({
  url: BoundedText,
  ref: BoundedText,
  resolved_ref: BoundedText,
  resolved_commit: Commit,
  observed_at: Time,
})
export type SourceRefObservation = typeof SourceRefObservationSchema.Type

export const SourceRefObservationCacheSchema = Schema.Struct({
  version: Schema.Literal(1),
  scope: Hash,
  identity: Hash,
  generation: Generation,
  result: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("observed"), observation: SourceRefObservationSchema }),
    Schema.Struct({ kind: Schema.Literal("unknown"), code: BoundedText }),
  ]),
})
export type SourceRefObservationCache = typeof SourceRefObservationCacheSchema.Type

/** Store owner validation is shared with the actual SQLite publication fence. */
export function sourceRefCacheOwner(key: string, value: unknown) {
  const { version, scope, identity, generation } = property(value)
  if (
    version !== 1 ||
    typeof scope !== "string" ||
    !/^[a-f0-9]{64}$/u.test(scope) ||
    typeof identity !== "string" ||
    !/^[a-f0-9]{64}$/u.test(identity) ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    key !== `${SOURCE_REF_CACHE_PREFIX}/${identity}/latest.json`
  )
    throw fail("STATE_CORRUPT", "A Git ref observation requires its exact owner and generation.")
  return { scope, identity, generation, record_identity: `source-ref:${identity}` }
}

/** Hash only; neither environment values nor credentials enter state or errors.
 * Keep explicit Git/helper routing, including custom variables, while excluding
 * five terminal run markers that would make every new window miss. This known
 * execution context does not certify opaque helper/keychain state or access. */
export function sourceRefAccessScope(scope: string) {
  return Effect.gen(function* () {
    const supplied = yield* Effect.serviceOption(SourceRefAccessContext)
    if (Option.isNone(supplied)) return undefined
    const { environment, cwd } = supplied.value
    return yield* sha256(
      canonicalSharedJson([
        scope,
        cwd,
        Object.entries(environment)
          .filter(([key, value]) => value !== undefined && !terminalRunMarkers.has(key))
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      ]),
    )
  })
}

export function sourceRefObservationFresh(
  observation: SourceRefObservation,
  now: number,
  maxAge: number,
): boolean {
  return (
    maxAge > 0 &&
    Number.isSafeInteger(observation.observed_at) &&
    observation.observed_at >= 0 &&
    now >= observation.observed_at &&
    now - observation.observed_at < maxAge
  )
}

/** Successful observations are reusable across operations; live producers still
 * belong to their caller's budget. A failure does not re-date an older success.
 * It publishes an ordered unknown result so an older producer cannot resurrect
 * the superseded observation after the failed newer attempt. */
export function reuseSourceRefObservation<R>(
  input: {
    readonly scope: string
    readonly url: string
    readonly ref: string
    readonly maxAge: number
  },
  execute: Effect.Effect<SourceRefObservation, SkillsError, R>,
): Effect.Effect<SourceRefObservation, SkillsError, R | Store | Crypto.Crypto> {
  return Effect.gen(function* () {
    const store = yield* Store
    const identity = yield* sha256(canonicalSharedJson([input.scope, input.url, input.ref]))
    const key = `${SOURCE_REF_CACHE_PREFIX}/${identity}/latest.json`
    const read = store.readJson(key, SourceRefObservationCacheSchema).pipe(
      Effect.flatMap((record) => {
        if (record === undefined) return Effect.succeed(undefined)
        if (
          record.scope !== input.scope ||
          record.identity !== identity ||
          !Number.isSafeInteger(record.generation) ||
          (record.result.kind === "observed" &&
            (record.result.observation.url !== input.url ||
              record.result.observation.ref !== input.ref))
        )
          return Effect.fail(
            fail("STATE_CORRUPT", "A cached Git observation has a different owner."),
          )
        return Effect.succeed(record)
      }),
    )
    const cached = yield* read
    if (
      cached?.result.kind === "observed" &&
      sourceRefObservationFresh(
        cached.result.observation,
        yield* Clock.currentTimeMillis,
        input.maxAge,
      )
    )
      return cached.result.observation

    const generation = yield* store.reserveCacheGeneration(input.scope, `source-ref:${identity}`)
    const observed = yield* execute.pipe(Effect.result)
    const result: SourceRefObservationCache["result"] =
      observed._tag === "Success"
        ? { kind: "observed", observation: observed.success }
        : { kind: "unknown", code: observed.failure.code }
    yield* store.writeJson(key, { version: 1, scope: input.scope, identity, generation, result })
    if (observed._tag === "Failure") return yield* Effect.fail(observed.failure)

    // SQL rejecting an old write does not stop that call returning its old value.
    // Re-read the accepted slot before this observation can drive a source check.
    const latest = yield* read
    if (latest !== undefined && latest.generation > generation) {
      if (
        latest.result.kind === "observed" &&
        sourceRefObservationFresh(
          latest.result.observation,
          yield* Clock.currentTimeMillis,
          DEFAULT_SOURCE_REF_MAX_AGE_MS,
        )
      )
        return latest.result.observation
      return yield* Effect.fail(
        fail("CURRENT_SOURCE_CHECK_SUPERSEDED", "A newer Git ref check superseded this result."),
      )
    }
    return observed.success
  })
}
