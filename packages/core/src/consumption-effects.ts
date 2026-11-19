import { Context, Effect, Schema } from "effect"
import { fail, property, type SkillsError } from "./model.ts"
import { Notion, withNotionRequestAttribution } from "./notion.ts"
import { readOnlyNotion } from "./notion-readonly.ts"

export const CONSUMPTION_EFFECTS_VERSION = 1
export const ConsumptionEffectsSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(CONSUMPTION_EFFECTS_VERSION),
    remote_writes: Schema.Literal("none"),
    author_content: Schema.Literal("unchanged"),
  }),
  Schema.Struct({
    version: Schema.Literal(CONSUMPTION_EFFECTS_VERSION),
    remote_writes: Schema.Literal("unknown"),
    author_content: Schema.Literals(["unchanged", "unknown"]),
  }),
])
export type ConsumptionEffects = typeof ConsumptionEffectsSchema.Type
export interface ConsumptionObservationOptions {
  /** Runs after request cleanup, including cancellation, without changing the result. */
  readonly onEffects?: (effects: ConsumptionEffects) => void
}
export const noConsumptionWrites = (): ConsumptionEffects => ({
  version: CONSUMPTION_EFFECTS_VERSION,
  remote_writes: "none",
  author_content: "unchanged",
})

const ConsumptionEffectsSnapshot = Context.Reference<(() => ConsumptionEffects) | undefined>(
  "ntn-skills/ConsumptionEffectsSnapshot",
  { defaultValue: () => undefined },
)
/** Allows the existing preparation budget to include the same operation's receipt. */
export const currentConsumptionEffects = ConsumptionEffectsSnapshot.pipe(
  Effect.map((snapshot) => snapshot?.()),
)

/** The entire descendant Notion boundary rejects writes before dispatch.
 * Read queries remain reads; reporting adds no requests or history records. */
export function withConsumptionEffects<A extends object, R>(
  effect: Effect.Effect<A, SkillsError, R>,
  options: ConsumptionObservationOptions = {},
) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const snapshot = noConsumptionWrites
    return yield* withNotionRequestAttribution(effect, { phase: "consume" }).pipe(
      Effect.provideService(Notion, readOnlyNotion(api)),
      Effect.provideService(ConsumptionEffectsSnapshot, snapshot),
      Effect.map((result) => ({ ...result, effects: snapshot() })),
      Effect.mapError((error) =>
        fail(error.code, error.message, { ...property(error.details), effects: snapshot() }),
      ),
      Effect.onExit(() => Effect.sync(() => options.onEffects?.(snapshot()))),
    )
  })
}
