import { Clock, Crypto, Effect, Schema } from "effect"
import { decode, fail, type SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256, Store } from "./store.ts"
import type { AuditRun } from "./shared-audit-model.ts"
import { saveAuditRun } from "./shared-audit-store.ts"

const FailureSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  details: Schema.Unknown,
})
const ConnectionSchema = Schema.Struct({
  principal: Schema.String,
  credential: Schema.String,
  connection: Schema.String,
  workspace: Schema.NullOr(Schema.String),
  api_origin: Schema.String,
})

export interface AuditCheckpointOwner {
  readonly get: () => AuditRun
  readonly set: (run: AuditRun) => void
}

/** Successful read observations are the continuation, not a cached health
 * verdict. Their original timestamps and raw versions remain in the checkpoint.
 * A separate final census rejects stale item reuse. */
export function auditJournalNotion(
  api: Notion["Service"],
  owner: AuditCheckpointOwner,
  taskKey: string,
  services: { readonly crypto: Crypto.Crypto; readonly store: Store["Service"] },
) {
  const observe = (
    path: string,
    body: unknown,
    options: Parameters<Notion["Service"]["request"]>[2],
    request: Effect.Effect<unknown, SkillsError>,
  ) =>
    Effect.gen(function* () {
      const identity = yield* sha256(
        canonicalSharedJson([taskKey, path, body ?? null, options?.content ?? null]),
      )
      const previous = owner.get().observations[identity]
      if (previous !== undefined) {
        if ((yield* sha256(canonicalSharedJson(previous.value))) !== previous.response_sha256)
          return yield* Effect.fail(
            fail("AUDIT_CHECKPOINT_CORRUPT", "A retained request observation failed its digest."),
          )
        const current = owner.get()
        owner.set({
          ...current,
          totals: { ...current.totals, replayed_requests: current.totals.replayed_requests + 1 },
        })
        if (previous.outcome === "failure") {
          const failure = yield* Effect.try({
            try: () => decode(FailureSchema, previous.value),
            catch: () =>
              fail("AUDIT_CHECKPOINT_CORRUPT", "A confirmed failed read has an invalid receipt."),
          })
          return yield* Effect.fail(fail(failure.code, failure.message, failure.details))
        }
        return previous.value
      }
      const result = yield* request.pipe(Effect.result)
      if (
        result._tag === "Failure" &&
        (["REQUEST_BUDGET_EXHAUSTED", "AUTH_REQUIRED", "RATE_LIMITED"].includes(
          result.failure.code,
        ) ||
          (!taskKey.startsWith("skill:") && !/^v1\/(?:pages|blocks)\//u.test(path)))
      )
        return yield* Effect.fail(result.failure)
      const value =
        result._tag === "Success"
          ? result.success
          : {
              code: result.failure.code,
              message: result.failure.message,
              details: result.failure.details ?? null,
            }
      const observed_at = yield* Clock.currentTimeMillis
      const response_sha256 = yield* sha256(canonicalSharedJson(value))
      return yield* Effect.gen(function* () {
        const current = owner.get()
        const next = {
          ...current,
          updated_at: observed_at,
          observations: {
            ...current.observations,
            [identity]: {
              task_key: taskKey,
              path,
              outcome: result._tag === "Success" ? ("success" as const) : ("failure" as const),
              observed_at,
              response_sha256,
              value,
            },
          },
          totals: { ...current.totals, confirmed_requests: current.totals.confirmed_requests + 1 },
        }
        yield* saveAuditRun(next)
        owner.set(next)
        if (result._tag === "Failure") return yield* Effect.fail(result.failure)
        return value
      }).pipe(Effect.uninterruptible)
    }).pipe(
      Effect.provideService(Crypto.Crypto, services.crypto),
      Effect.provideService(Store, services.store),
    )
  return {
    ...api,
    request: (path, body, options) =>
      observe(path, body, options, api.request(path, body, options)),
    ...(api.connectionIdentity === undefined
      ? {}
      : {
          connectionIdentity: observe(
            "audit-connection-identity",
            undefined,
            undefined,
            api.connectionIdentity,
          ).pipe(
            Effect.flatMap((value) =>
              Effect.try({
                try: () => decode(ConnectionSchema, value),
                catch: () =>
                  fail(
                    "AUDIT_CHECKPOINT_CORRUPT",
                    "The confirmed connection identity is malformed.",
                  ),
              }),
            ),
          ),
        }),
  } satisfies Notion["Service"]
}
