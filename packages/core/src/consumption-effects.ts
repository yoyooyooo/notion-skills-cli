import { Context, Effect, Exit, Schema } from "effect"
import { fail, property, type SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { readOnlyNotion } from "./notion-readonly.ts"
import { isCoalescibleNotionRead } from "./shared-read-coalescing.ts"

export const CONSUMPTION_EFFECTS_VERSION = 1
export const ConsumptionRetentionEffectSchema = Schema.Struct({
  skill_page_id: Schema.String,
  file_id: Schema.String,
  operation_id: Schema.String,
  status: Schema.Literals(["confirmed", "unknown"]),
})
export type ConsumptionRetentionEffect = typeof ConsumptionRetentionEffectSchema.Type
export const ConsumptionEffectsSchema = Schema.Struct({
  version: Schema.Literal(CONSUMPTION_EFFECTS_VERSION),
  remote_writes: Schema.Literals(["none", "retained", "unknown"]),
  author_content: Schema.Literals(["unchanged", "unknown"]),
  retention: Schema.Array(ConsumptionRetentionEffectSchema),
})
export type ConsumptionEffects = typeof ConsumptionEffectsSchema.Type
export interface ConsumptionObservationOptions {
  /** Disallow every semantic Notion write, including internal history retention. */
  readonly readOnly?: boolean
  /** Runs after request cleanup, including cancellation, without changing the result. */
  readonly onEffects?: (effects: ConsumptionEffects) => void
}
export const noConsumptionWrites = (): ConsumptionEffects => ({
  version: CONSUMPTION_EFFECTS_VERSION,
  remote_writes: "none",
  author_content: "unchanged",
  retention: [],
})

const ConsumptionEffectsSnapshot = Context.Reference<(() => ConsumptionEffects) | undefined>(
  "ntn-skills/ConsumptionEffectsSnapshot",
  { defaultValue: () => undefined },
)
/** Allows the existing preparation budget to include the same operation's receipt. */
export const currentConsumptionEffects = ConsumptionEffectsSnapshot.pipe(
  Effect.map((snapshot) => snapshot?.()),
)

type RetentionIdentity = Omit<ConsumptionRetentionEffect, "status">
interface RetentionScope {
  readonly identity: RetentionIdentity
  readonly recordsDataSourceId: string
}
const ConsumptionRetention = Context.Reference<RetentionScope | undefined>(
  "ntn-skills/ConsumptionRetention",
  { defaultValue: () => undefined },
)

/** Only the existing immutable observation commit may attest retention semantics. */
export function withConsumptionRetention<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  identity: RetentionIdentity,
  recordsDataSourceId: string,
) {
  return effect.pipe(Effect.provideService(ConsumptionRetention, { identity, recordsDataSourceId }))
}

/** Observe the existing requests; queries do not become writes and no probe is added. */
export function withConsumptionEffects<A extends object, R>(
  effect: Effect.Effect<A, SkillsError, R>,
  options: ConsumptionObservationOptions = {},
) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const retained = new Map<
      string,
      { identity: RetentionIdentity; pending: number; failed: boolean }
    >()
    let unclassifiedWrite = false
    const snapshot = (): ConsumptionEffects => {
      const retention = [...retained.values()]
        .map(
          ({ identity, pending, failed }): ConsumptionRetentionEffect => ({
            ...identity,
            status: failed || pending > 0 ? "unknown" : "confirmed",
          }),
        )
        .sort((left, right) => left.operation_id.localeCompare(right.operation_id))
      return {
        version: CONSUMPTION_EFFECTS_VERSION,
        remote_writes:
          unclassifiedWrite || retention.some((entry) => entry.status === "unknown")
            ? "unknown"
            : retention.length > 0
              ? "retained"
              : "none",
        author_content: unclassifiedWrite ? "unknown" : "unchanged",
        retention,
      }
    }
    const observed: Notion["Service"] = {
      ...api,
      request: (path, body, requestOptions) =>
        Effect.gen(function* () {
          const method = requestOptions?.method ?? (body === undefined ? "GET" : "POST")
          if (isCoalescibleNotionRead({ key: "effects", path, method, file: requestOptions?.file }))
            return yield* api.request(path, body, requestOptions)
          const scope = yield* ConsumptionRetention
          const parent = property(property(body).parent)
          if (
            scope === undefined ||
            method !== "POST" ||
            path !== "v1/pages" ||
            requestOptions?.file !== undefined ||
            parent.type !== "data_source_id" ||
            parent.data_source_id !== scope.recordsDataSourceId
          ) {
            unclassifiedWrite = true
            return yield* api.request(path, body, requestOptions)
          }
          const { identity } = scope
          const key = JSON.stringify(identity)
          const entry = retained.get(key) ?? { identity, pending: 0, failed: false }
          retained.set(key, entry)
          entry.pending++
          return yield* api.request(path, body, requestOptions).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                entry.pending--
                entry.failed ||= !Exit.isSuccess(exit)
              }),
            ),
          )
        }),
    }
    return yield* effect.pipe(
      Effect.provideService(Notion, options.readOnly ? readOnlyNotion(observed) : observed),
      Effect.provideService(ConsumptionEffectsSnapshot, snapshot),
      Effect.map((result) => ({ ...result, effects: snapshot() })),
      Effect.mapError((error) =>
        fail(error.code, error.message, { ...property(error.details), effects: snapshot() }),
      ),
      Effect.onExit(() => Effect.sync(() => options.onEffects?.(snapshot()))),
    )
  })
}
