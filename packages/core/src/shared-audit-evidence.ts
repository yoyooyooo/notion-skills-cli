import { Clock, Context, Crypto, Effect } from "effect"
import { fail, type SkillsError } from "./model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { Store, sha256 } from "./store.ts"
import type { AuditRun } from "./shared-audit-model.ts"
import type { AuditCheckpointOwner } from "./shared-audit-transport.ts"
import { saveAuditRun } from "./shared-audit-store.ts"

type Observation = AuditRun["observations"][string]
export class AuditEvidence extends Context.Service<
  AuditEvidence,
  {
    readonly read: (path: string) => Effect.Effect<Observation | undefined, SkillsError>
    readonly save: (path: string, value: unknown) => Effect.Effect<void, SkillsError>
  }
>()("ntn-skills/AuditEvidence") {}

/** Source byte completion uses the same run checkpoint as Notion pagination;
 * it is not an additional cache, lock or remote fact store. */
export function auditEvidenceService(
  owner: AuditCheckpointOwner,
  taskKey: string,
  services: {
    readonly crypto: Crypto.Crypto
    readonly store: Store["Service"]
  },
): AuditEvidence["Service"] {
  const provide = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Store>) =>
    effect.pipe(
      Effect.provideService(Crypto.Crypto, services.crypto),
      Effect.provideService(Store, services.store),
    )
  const key = (path: string) => sha256(canonicalSharedJson([taskKey, path, null, null]))
  return {
    read: (path) =>
      provide(
        Effect.gen(function* () {
          const observation = owner.get().observations[yield* key(path)]
          if (
            observation !== undefined &&
            (yield* sha256(canonicalSharedJson(observation.value))) !== observation.response_sha256
          )
            return yield* Effect.fail(
              fail("AUDIT_CHECKPOINT_CORRUPT", "The confirmed audit evidence failed its checksum."),
            )
          return observation
        }),
      ),
    save: (path, value) =>
      provide(
        Effect.gen(function* () {
          const identity = yield* key(path)
          const observed_at = yield* Clock.currentTimeMillis
          const response_sha256 = yield* sha256(canonicalSharedJson(value))
          const previous = owner.get()
          const next = {
            ...previous,
            updated_at: observed_at,
            observations: {
              ...previous.observations,
              [identity]: {
                task_key: taskKey,
                path,
                outcome: "success" as const,
                observed_at,
                response_sha256,
                value,
              },
            },
          }
          yield* saveAuditRun(next)
          owner.set(next)
        }).pipe(Effect.uninterruptible),
      ),
  }
}
