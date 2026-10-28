import { Clock, Effect, Schema } from "effect"
import { fail, type SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { Store, sha256 } from "./store.ts"
import { withLocalLocks } from "./local-locks.ts"
import { canonical } from "./publication-effect-proof.ts"
import {
  readContentAdoptionCapture,
  readContentAdoptionProof,
} from "./publication-content-adoption-proof.ts"
import {
  assertSourceRootCompletionAuthority,
  sourceRootCompletionReadBounds,
  sourceRootCompletionLocks,
} from "./upstream-source-root-completion.ts"
import {
  loadSourceRootCompletion,
  sourceRootCompletionKey,
  type SourceRootCompletionReceipt,
} from "./upstream-source-root-completion-model.ts"
import {
  sourceRootCompletionAfterMatches,
  sourceRootCompletionExactBefore,
} from "./source-root-completion-guards.ts"
import { deriveSourceRootFidelity } from "./source-root-fidelity-effect.ts"
import {
  sourceRootFidelityAckMatches,
  sourceRootFidelityAfterMatches,
  sourceRootFidelityBeforeMatches,
} from "./source-root-fidelity-guards.ts"
import {
  SourceRootFidelityInputSchema,
  SOURCE_ROOT_FIDELITY_ATTEMPT_LIMIT,
  decodeSourceRootFidelity,
  loadSourceRootFidelity,
  sourceRootFidelityKey,
  sourceRootFidelityId,
  sourceRootFidelityCheckpoint,
  sourceRootFidelityRefusal,
  sourceRootFidelityTry,
  type SourceRootFidelityReceipt,
} from "./upstream-source-root-fidelity-model.ts"

const failure = (error: SkillsError) => ({
  code: error.code,
  message: error.message,
  ...(error.details === undefined ? {} : { details: error.details }),
})
function summary(receipt: SourceRootFidelityReceipt, historical = false) {
  return {
    domain: receipt.plan.domain,
    plan_id: receipt.plan.plan_id,
    plan_hash: receipt.plan.plan_hash,
    parent_plan_id: receipt.plan.parent.plan.plan_id,
    parent_plan_hash: receipt.plan.parent.plan.plan_hash,
    page_id: receipt.plan.page_id,
    phase: receipt.phase,
    kind: receipt.plan.kind,
    completed_effects: receipt.checkpoints.length,
    total_effects: receipt.plan.effects.length,
    attempts: receipt.attempts.length,
    requests: receipt.plan.effects.map((effect) => ({
      index: effect.index,
      kind: effect.kind,
      block_id: effect.block_id,
      request: effect.request,
    })),
    body_verified: receipt.phase === "body_verified",
    source_bytes_verified: false,
    publication_completed: false,
    parent_receipt_unchanged: true,
    ...(historical ? { reused: true, proof: "retained_historical_result" as const } : {}),
  }
}

/** The existing parent authority checks the original UO, every frozen object,
 * bindings, map, subscription, target and competing CA/leaf/publication claims.
 * These reads occur under the parent's complete common lock set. */
function authority(parent: SourceRootCompletionReceipt, expected?: SourceRootFidelityReceipt) {
  return Effect.gen(function* () {
    const store = yield* Store,
      plan = parent.plan
    const current = yield* loadSourceRootCompletion(plan.plan_id, plan.plan_hash)
    if (
      canonical(current) !== canonical(parent) ||
      current.phase !== "acknowledged" ||
      current.attempts.length !== 1 ||
      current.attempts[0]?.outcome !== "acknowledged"
    )
      return yield* Effect.fail(
        sourceRootFidelityRefusal(
          "The exact original acknowledged completion changed; no child effect may be issued.",
        ),
      )
    const key = sourceRootFidelityKey(plan.original_plan.plan_id, plan.item_index)
    const own = yield* store.upstream.command(key),
      claims = yield* store.upstream.sourceRootFidelityClaims(plan.input.page_id, plan.target_key)
    if (
      expected
        ? canonical(own) !== canonical(expected) ||
          claims.length !== 1 ||
          claims[0]?.operation_id !== key
        : own !== undefined || claims.length !== 0
    )
      return yield* Effect.fail(
        sourceRootFidelityRefusal(
          "A different retained fidelity claim already owns this member, page or target.",
        ),
      )
    return yield* assertSourceRootCompletionAuthority(current)
  })
}

export const showSourceRootFidelity = (id: string) => loadSourceRootFidelity(id)
export function planSourceRootFidelity(value: unknown) {
  return Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(SourceRootFidelityInputSchema)(value, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(() =>
        sourceRootFidelityRefusal(
          "Select only the exact acknowledged completion plan ID and hash.",
        ),
      ),
    )
    const parent = yield* loadSourceRootCompletion(
        input.completion_plan_id,
        input.completion_plan_hash,
      ),
      store = yield* Store
    return yield* withLocalLocks(
      store.root,
      sourceRootCompletionLocks(parent.plan),
      Effect.gen(function* () {
        const key = sourceRootFidelityKey(parent.plan.original_plan.plan_id, parent.plan.item_index)
        const retained = yield* store.upstream.command(key)
        if (retained !== undefined) {
          const receipt = yield* decodeSourceRootFidelity(retained)
          if (canonical(receipt.plan.input) !== canonical(input))
            return yield* Effect.fail(
              sourceRootFidelityRefusal(
                "This original member already has a different immutable fidelity plan.",
              ),
            )
          return summary(receipt, true)
        }
        const original = yield* authority(parent)
        const capture = yield* readContentAdoptionCapture(
          sourceRootCompletionReadBounds(parent.plan, original),
        )
        const derived = yield* sourceRootFidelityTry(() =>
          deriveSourceRootFidelity(parent.plan, capture.observation),
        )
        if (
          (yield* sha256(canonical(derived.source_body_model))) !==
          parent.plan.effect.body_model_sha256
        )
          return yield* Effect.fail(
            sourceRootFidelityRefusal(
              "The source compiler no longer reproduces the original immutable parent model.",
            ),
          )
        yield* authority(parent)
        const body = {
          format: 1 as const,
          domain: "source_root_fidelity" as const,
          input,
          parent,
          parent_receipt_sha256: yield* sha256(canonical(parent)),
          page_id: parent.plan.input.page_id,
          target_key: parent.plan.target_key,
          kind: derived.kind,
          before: capture.observation,
          before_body: derived.before_body,
          before_body_verified: false as const,
          before_source_bytes_verified: false as const,
          effects: derived.effects,
        }
        const plan = {
          ...body,
          plan_id: sourceRootFidelityId(parent.plan.original_plan.plan_id, parent.plan.item_index),
          plan_hash: yield* sha256(canonical(body)),
        }
        const receipt = yield* decodeSourceRootFidelity({
          format: 1,
          domain: "source_root_fidelity_receipt",
          plan,
          phase: "planned",
          attempts: [],
          checkpoints: [],
        })
        yield* store.upstream.createCommand(key, receipt)
        return summary(receipt)
      }),
    )
  })
}

function save(
  expected: SourceRootFidelityReceipt,
  value: SourceRootFidelityReceipt,
  guardParent = true,
) {
  return Effect.gen(function* () {
    const next = yield* decodeSourceRootFidelity(value)
    if (canonical(next.plan) !== canonical(expected.plan))
      return yield* Effect.fail(
        sourceRootFidelityRefusal(
          "The original source-root fidelity plan cannot change during execution.",
        ),
      )
    const store = yield* Store,
      parent = next.plan.parent.plan
    yield* store.upstream.claimCommand(
      sourceRootFidelityKey(parent.original_plan.plan_id, parent.item_index),
      expected,
      next,
      guardParent
        ? {
            operation_id: sourceRootCompletionKey(parent.original_plan.plan_id, parent.item_index),
            expected: next.plan.parent,
          }
        : undefined,
    )
    return next
  })
}
function conflict(receipt: SourceRootFidelityReceipt, observation: unknown) {
  return Effect.gen(function* () {
    const error = fail(
      "SOURCE_ROOT_FIDELITY_CONFLICT",
      "The complete graph is neither this step's exact BEFORE nor its one adjacent full AFTER.",
      { observation },
    )
    yield* save(receipt, { ...receipt, phase: "conflict", failure: failure(error) })
    return yield* Effect.fail(error)
  })
}

function observeAttempt(receipt: SourceRootFidelityReceipt) {
  return Effect.gen(function* () {
    const parent = receipt.plan.parent,
      original = yield* authority(parent, receipt)
    const capture = yield* readContentAdoptionCapture(
      sourceRootCompletionReadBounds(parent.plan, original),
    )
    const index = receipt.checkpoints.length,
      checkpoint = sourceRootFidelityCheckpoint(receipt),
      last = receipt.attempts.at(-1)
    if (!last || last.effect_index !== index || last.resolution !== undefined)
      return yield* Effect.fail(
        sourceRootFidelityRefusal("There is no unresolved current typed request to observe."),
      )
    yield* authority(parent, receipt)
    const now = yield* Clock.currentTimeMillis
    if (
      sourceRootFidelityAfterMatches(
        parent.plan,
        receipt.plan.effects,
        checkpoint,
        capture.observation,
        index,
      )
    ) {
      // Hash only the actual complete observation; no response is manufactured.
      const digest = yield* sha256(canonical(capture.observation))
      const resolved =
        last.outcome === "acknowledged"
          ? receipt.attempts
          : receipt.attempts.map((attempt, at) =>
              at === receipt.attempts.length - 1
                ? {
                    ...attempt,
                    resolution: {
                      outcome: "observed_applied" as const,
                      observed_at_ms: now,
                      checkpoint_sha256: digest,
                    },
                  }
                : attempt,
            )
      return yield* save(receipt, {
        ...receipt,
        phase: "ready",
        attempts: resolved,
        checkpoints: [
          ...receipt.checkpoints,
          {
            effect_index: index,
            attempt_index: last.index,
            observed_at_ms: now,
            observation: capture.observation,
          },
        ],
      })
    }
    const exactBefore = sourceRootFidelityBeforeMatches(
      parent.plan,
      receipt.plan.effects,
      checkpoint,
      capture.observation,
      index,
    )
    if (last.outcome === "acknowledged" && exactBefore)
      return yield* Effect.fail(
        fail(
          "SOURCE_ROOT_FIDELITY_NOT_CONVERGED",
          "The real block ACK is retained, but the complete read still shows its exact BEFORE; reconcile again without resending.",
        ),
      )
    if (last.outcome !== "acknowledged" && exactBefore)
      return yield* save(receipt, {
        ...receipt,
        phase: "ready",
        attempts: receipt.attempts.map((attempt, at) =>
          at === receipt.attempts.length - 1
            ? {
                ...attempt,
                resolution: {
                  outcome: "known_not_applied" as const,
                  observed_at_ms: now,
                  observation: capture.observation,
                },
              }
            : attempt,
        ),
      })
    return yield* conflict(receipt, capture.observation)
  })
}

function strictFinal(receipt: SourceRootFidelityReceipt) {
  return Effect.gen(function* () {
    const parent = receipt.plan.parent,
      original = yield* authority(parent, receipt)
    const bounds = sourceRootCompletionReadBounds(parent.plan, original),
      checkpoint = sourceRootFidelityCheckpoint(receipt)
    const first = yield* readContentAdoptionProof(bounds),
      firstAt = yield* Clock.currentTimeMillis
    if (
      first.source_bytes_verified ||
      !sourceRootCompletionAfterMatches(parent.plan, first.evidence) ||
      !sourceRootCompletionExactBefore(checkpoint, first.evidence)
    )
      return yield* conflict(receipt, first.evidence)
    yield* authority(parent, receipt)
    const second = yield* readContentAdoptionProof(bounds),
      now = yield* Clock.currentTimeMillis
    if (
      second.source_bytes_verified ||
      !sourceRootCompletionAfterMatches(parent.plan, second.evidence) ||
      !sourceRootCompletionExactBefore(first.evidence, second.evidence)
    )
      return yield* conflict(receipt, { first: first.evidence, second: second.evidence })
    yield* authority(parent, receipt)
    return yield* save(receipt, {
      ...receipt,
      phase: "body_verified",
      result: {
        parent_receipt_sha256: receipt.plan.parent_receipt_sha256,
        first_observed_at_ms: firstAt,
        observed_at_ms: now,
        body_verified: true,
        source_bytes_verified: false,
        publication_completed: false,
        parent_receipt_unchanged: true,
        first_observation: {
          raw: first.evidence.raw,
          attachments: first.evidence.attachments,
          page_ids: first.evidence.page_ids,
          graph_sha256: first.evidence.graph_sha256,
        },
        proof: second.evidence,
      },
    })
  })
}

function continueFidelity(initial: SourceRootFidelityReceipt, mode: "apply" | "reconcile") {
  return Effect.gen(function* () {
    // Historical reuse never asks the parent to return to its old ACK phase.
    if (initial.phase === "body_verified") return summary(initial, true)
    if (initial.phase === "conflict")
      return yield* Effect.fail(
        fail(
          "SOURCE_ROOT_FIDELITY_CONFLICT",
          "This fidelity plan retains a conflict; its original evidence cannot be refreshed or overwritten.",
          initial.failure,
        ),
      )
    let receipt = initial
    if (["pending", "unknown", "acknowledged"].includes(receipt.phase)) {
      receipt = yield* observeAttempt(receipt)
      if (mode === "reconcile" && receipt.checkpoints.length < receipt.plan.effects.length)
        return {
          ...summary(receipt),
          observation: "resolved_current_attempt",
          needs_safe_apply: true,
        }
    }
    while (receipt.checkpoints.length < receipt.plan.effects.length) {
      const parent = receipt.plan.parent,
        original = yield* authority(parent, receipt)
      const capture = yield* readContentAdoptionCapture(
        sourceRootCompletionReadBounds(parent.plan, original),
      )
      const index = receipt.checkpoints.length,
        checkpoint = sourceRootFidelityCheckpoint(receipt)
      if (
        !sourceRootFidelityBeforeMatches(
          parent.plan,
          receipt.plan.effects,
          checkpoint,
          capture.observation,
          index,
        )
      )
        return yield* conflict(receipt, capture.observation)
      yield* authority(parent, receipt)
      if (mode === "reconcile")
        return { ...summary(receipt), observation: "exact_before", needs_safe_apply: true }
      // Reserve one attempt for every later effect. A failed attempt never
      // disappears, and exhaustion is detected before the next pending claim.
      if (
        receipt.attempts.length + 1 + (receipt.plan.effects.length - index - 1) >
        SOURCE_ROOT_FIDELITY_ATTEMPT_LIMIT
      )
        return yield* Effect.fail(
          sourceRootFidelityRefusal(
            "The bounded typed-attempt budget is exhausted; no additional request was claimed.",
          ),
        )
      const effect = receipt.plan.effects[index]!,
        now = yield* Clock.currentTimeMillis
      const pending = yield* save(receipt, {
        ...receipt,
        phase: "pending",
        attempts: [
          ...receipt.attempts,
          {
            index: receipt.attempts.length,
            effect_index: index,
            started_at_ms: now,
            request: effect.request,
            before_sha256: yield* sha256(canonical(checkpoint)),
            outcome: "pending",
          },
        ],
      })
      const api = yield* Notion,
        sent = yield* api
          .request(effect.request.path, effect.request.body, { method: effect.request.method })
          .pipe(Effect.result)
      const acknowledged =
        sent._tag === "Success" && sourceRootFidelityAckMatches(effect, sent.success)
      const error =
        sent._tag === "Failure"
          ? sent.failure
          : fail(
              "SOURCE_ROOT_FIDELITY_ACK_INVALID",
              "The one typed request did not return its complete expected block acknowledgement.",
            )
      // A real returned response is saved before any authority/readback check.
      // This CAS preserves evidence even if the retained parent changed meanwhile;
      // a changed parent can never authorize the next request or final certificate.
      receipt = yield* save(
        pending,
        {
          ...pending,
          phase: acknowledged ? "acknowledged" : "unknown",
          attempts: pending.attempts.map((attempt, at) =>
            at !== pending.attempts.length - 1
              ? attempt
              : acknowledged && sent._tag === "Success"
                ? { ...attempt, outcome: "acknowledged", response: sent.success }
                : {
                    ...attempt,
                    outcome: "unknown",
                    failure: failure(error),
                    ...(sent._tag === "Success" ? { untrusted_response: sent.success } : {}),
                  },
          ),
        },
        false,
      )
      if (!acknowledged) return yield* Effect.fail(error)
      receipt = yield* observeAttempt(receipt)
    }
    return summary(yield* strictFinal(receipt))
  })
}

function runFidelity(id: string, hash: string, mode: "apply" | "reconcile") {
  return Effect.gen(function* () {
    const receipt = yield* loadSourceRootFidelity(id, hash),
      store = yield* Store
    return yield* withLocalLocks(
      store.root,
      sourceRootCompletionLocks(receipt.plan.parent.plan),
      loadSourceRootFidelity(id, hash).pipe(
        Effect.flatMap((current) => continueFidelity(current, mode)),
      ),
    )
  })
}
export const applySourceRootFidelity = (id: string, hash: string) => runFidelity(id, hash, "apply")
export const reconcileSourceRootFidelity = (id: string, hash: string) =>
  runFidelity(id, hash, "reconcile")
