import { Effect } from "effect"
import { portableIdentity } from "./export.ts"
import { withLocalLocks } from "./local-locks.ts"
import { fail } from "./model.ts"
import { PublicationReceiptSchema } from "./publication-model.ts"
import { reconcilePublication } from "./publication-reconcile.ts"
import { sha256, Store } from "./store.ts"
import { publicationMemberKey, thawPortable } from "./upstream-content.ts"
import { UpstreamPublisher, type UpstreamCommandOperation } from "./upstream-model.ts"
import { UpstreamState } from "./upstream-state.ts"
import { getSubscription } from "./upstream-subscription.ts"
import { proveUnsentModePublication } from "./upstream-unsent-mode.ts"

type ModeCommand = Extract<UpstreamCommandOperation, { domain: "upstream_fork" | "upstream_track" }>
export function observeModeChild(command: ModeCommand) {
  return Effect.gen(function* () {
    const store = yield* Store
    const id = `p_${yield* sha256(command.operation_id)}`
    const receipt = yield* store.readJson(`publications/${id}.json`, PublicationReceiptSchema)
    if (!receipt) return undefined
    const subscription = yield* getSubscription(command.subscription_id, command.database_id)
    const owner = receipt.context?.ownership
    const integrity = yield* store.integrity.inspect(id)
    if (
      receipt.operation_id !== id ||
      receipt.operation !== "write" ||
      receipt.scope !== command.scope ||
      receipt.database_id !== subscription.target_database_id ||
      receipt.page_id !== command.page_id ||
      !owner ||
      owner.subscription_id !==
        (subscription.source.publisher_subscription_id ?? subscription.subscription_id) ||
      owner.member_key !== publicationMemberKey(subscription, command.member_key) ||
      owner.mode !== (command.domain === "upstream_fork" ? "fork" : "tracked") ||
      (command.domain === "upstream_track" &&
        (owner.published_hash !== command.content_hash || owner.revision !== command.revision)) ||
      (command.domain === "upstream_fork" &&
        JSON.stringify(owner.fork_baseline) !== JSON.stringify(command.baseline)) ||
      !integrity ||
      integrity.page_id !== command.page_id
    )
      return yield* Effect.fail(
        fail(
          "WRITE_CONFLICT",
          "The mode publication child does not match its frozen parent authority.",
        ),
      )
    if (receipt.intents.length === 0) {
      const current = yield* (yield* UpstreamPublisher).inspect(command.page_id)
      if (yield* proveUnsentModePublication(receipt, command.expected_version, current))
        return {
          id,
          receipt,
          proof: { outcome: "needs_safe_resume" as const, verified: false },
        }
    }
    return { id, receipt, proof: yield* reconcilePublication(id) }
  })
}

export function resumeModeCommand(command: ModeCommand) {
  return Effect.gen(function* () {
    const store = yield* Store
    const state = yield* UpstreamState
    const initial = (yield* state.bindings(command.subscription_id)).find(
      (entry) => entry.member_key === command.member_key,
    )
    if (!initial || initial.page_id !== command.page_id)
      return yield* Effect.fail(
        fail("WRITE_CONFLICT", "The frozen mode root no longer targets this binding."),
      )
    return yield* withLocalLocks(
      store.root,
      [`upstream-subscription:${command.subscription_id}`, `upstream-target:${initial.target_key}`],
      Effect.gen(function* () {
        const binding = (yield* state.bindings(command.subscription_id)).find(
          (entry) => entry.member_key === command.member_key,
        )
        if (!binding || binding.page_id !== command.page_id)
          return yield* Effect.fail(
            fail("WRITE_CONFLICT", "The frozen mode root no longer targets this binding."),
          )
        const mode = command.domain === "upstream_fork" ? "fork" : "tracked"
        const identityAt = (generation: number) =>
          sha256(
            JSON.stringify([
              command.scope,
              command.database_id,
              binding.subscription_id,
              binding.member_key,
              generation,
              mode,
            ]),
          ).pipe(Effect.map((hash) => `um_${hash}`))
        let generation = command.recovery_generation ?? binding.generation
        if (
          command.recovery_generation === undefined &&
          (yield* identityAt(generation)) !== command.operation_id &&
          generation > 0
        )
          generation -= 1
        const advanced = binding.generation === generation + 1
        if (
          (yield* identityAt(generation)) !== command.operation_id ||
          (binding.generation !== generation && !advanced) ||
          (advanced &&
            (binding.mode !== mode ||
              (command.domain === "upstream_track"
                ? binding.published_hash !== command.content_hash ||
                  binding.revision !== command.revision
                : JSON.stringify(binding.fork_baseline) !== JSON.stringify(command.baseline))))
        )
          return yield* Effect.fail(
            fail(
              "WRITE_CONFLICT",
              "The frozen mode root differs from the current binding generation.",
            ),
          )
        const child = yield* observeModeChild(command)
        if (!child)
          return yield* Effect.fail(
            fail(
              "WRITE_OUTCOME_UNKNOWN",
              "No existing mode child is proven; no publication or baseline create was replayed.",
              { operation_id: command.operation_id },
            ),
          )
        if (child.proof.outcome === "conflict")
          return yield* Effect.fail(
            fail("WRITE_CONFLICT", "The original mode child observed an external change."),
          )
        const publisher = yield* UpstreamPublisher
        const baseline =
          command.domain === "upstream_fork" ? command.baseline : binding.fork_baseline
        if (
          baseline &&
          (yield* portableIdentity(yield* publisher.readBaseline(baseline.portable_ref))) !==
            baseline.content_hash
        )
          return yield* Effect.fail(
            fail(
              "UPSTREAM_BASELINE_UNVERIFIED",
              "The original remote fork baseline is no longer recoverable.",
            ),
          )
        const frozen = {
          ...child.receipt.portable,
          kind: "skill" as const,
          files: child.receipt.portable.files.map((file) => ({
            path: file.path,
            hash: file.sha256,
          })),
        }
        const portable = yield* thawPortable(frozen)
        if (
          command.domain === "upstream_track" &&
          (yield* portableIdentity(portable)) !== command.content_hash
        )
          return yield* Effect.fail(
            fail("STATE_CORRUPT", "The frozen track child bytes differ from the parent hash."),
          )
        if (
          advanced &&
          command.domain === "upstream_track" &&
          (JSON.stringify(binding.accepted) !== JSON.stringify(frozen) ||
            JSON.stringify(binding.materialized) !== JSON.stringify(frozen))
        )
          return yield* Effect.fail(
            fail(
              "WRITE_CONFLICT",
              "The already advanced binding differs from its frozen accepted and materialized bytes.",
            ),
          )
        yield* publisher.setMode({
          operation_id: command.operation_id,
          page_id: command.page_id,
          expected_version: command.expected_version,
          mode,
          ...(command.domain === "upstream_fork"
            ? { fork_baseline: command.baseline }
            : { published_hash: command.content_hash, revision: command.revision }),
        })
        const current = yield* publisher.inspect(command.page_id)
        const owner = current.ownership
        const intended = child.receipt.context!.ownership!
        if (
          !owner ||
          JSON.stringify(owner) !== JSON.stringify(intended) ||
          (command.domain === "upstream_track" && current.content_hash !== command.content_hash)
        )
          return yield* Effect.fail(
            fail(
              "WRITE_CONFLICT",
              "The completed mode child differs from its original frozen content and ownership.",
            ),
          )
        const next =
          command.domain === "upstream_fork"
            ? {
                ...binding,
                generation: generation + 1,
                mode: "fork" as const,
                fork_baseline: command.baseline,
              }
            : {
                ...binding,
                generation: generation + 1,
                mode: "tracked" as const,
                accepted: frozen,
                materialized: frozen,
                published_hash: command.content_hash,
                revision: command.revision,
              }
        if (!advanced) yield* state.setMode(next, generation)
        if (command.domain === "upstream_track")
          yield* state.saveCommand(`materialized:${binding.target_key}`, {
            portable: frozen,
            content_hash: command.content_hash,
            revision: command.revision,
          })
        yield* state.saveCommand(command.operation_id, {
          ...command,
          recovery_generation: generation,
          state: "verified",
        })
      }),
    )
  })
}
