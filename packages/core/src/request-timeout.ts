import { Config, Effect } from "effect"
import { fail } from "./model.ts"

/** Network attempts have independent budgets; a complete operation has no deadline. */
export const requestTimeoutMs = Config.String("NTN_SKILLS_REQUEST_TIMEOUT_MS").pipe(
  Config.withDefault("30000"),
  Effect.mapError(() => fail("CONFIG_ERROR", "The request timeout configuration is invalid.")),
  Effect.flatMap((raw) => {
    const millis = Number(raw)
    return Number.isSafeInteger(millis) && millis > 0 && millis <= 2_147_483_647
      ? Effect.succeed(millis)
      : Effect.fail(
          fail(
            "CONFIG_ERROR",
            "Request timeout must be a positive integer of milliseconds up to 2147483647.",
          ),
        )
  }),
)
