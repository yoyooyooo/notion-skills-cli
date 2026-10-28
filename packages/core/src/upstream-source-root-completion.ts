import { Clock, Effect, Schema } from "effect"
import { authScope, explicitSource } from "./catalog.ts"
import { fail, type SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { Store, sha256 } from "./store.ts"
import { withLocalLocks } from "./local-locks.ts"
import { canonical } from "./publication-effect-proof.ts"
import { publicationMarker } from "./publication-integrity.ts"
import { contentAdoptionMemberKey } from "./publication-content-adoption-authority.ts"
import {
  readContentAdoptionCapture,
  readContentAdoptionProof,
  type ContentAdoptionCapture,
  type ContentAdoptionReadBounds,
} from "./publication-content-adoption-proof.ts"
import { prepareContentAdoptionSourceInstallation } from "./publication-content-adoption-source.ts"
import {
  readContentAdoptionOriginalInput,
  assertContentAdoptionUniquePage,
} from "./upstream-content-adoption.ts"
import { getSubscription } from "./upstream-subscription.ts"
import { referencePagesMatch } from "./reference-mutation.ts"
import { deriveSourceRootCompletion } from "./publication-source-root-completion-effect.ts"
import {
  sourceRootCompletionAckMatches,
  sourceRootCompletionAfterMatches,
  sourceRootCompletionExactBefore,
} from "./source-root-completion-guards.ts"
import { assertNoPendingSourceRootFidelity } from "./upstream-source-root-fidelity-model.ts"
import {
  SourceRootCompletionInputSchema,
  decodeSourceRootCompletion,
  loadSourceRootCompletion,
  sourceRootCompletionKey,
  sourceRootCompletionId,
  sourceRootCompletionRefusal,
  sourceRootCompletionTry,
  type SourceRootCompletionInput,
  type SourceRootCompletionPlan,
  type SourceRootCompletionReceipt,
  type SourceRootCompletionObservation,
} from "./upstream-source-root-completion-model.ts"

const locks = (plan: SourceRootCompletionPlan) => [
  `publication:${plan.original_publication_id}`,
  `publication:${plan.input.old_operation_id}`,
  `upstream-subscription:${plan.original_plan.subscription_id}`,
  ...plan.original_plan.items.map((item) => `upstream-target:${item.target_key}`),
]
const failure = (error: SkillsError) => ({
  code: error.code,
  message: error.message,
  ...(error.details === undefined ? {} : { details: error.details }),
})

/** The original CREATE_CONFLICT authority is reused, not reinterpreted. The
 * complete native input is frozen independently of this one completion row. */
function readAuthority(input: SourceRootCompletionInput, expected?: SourceRootCompletionReceipt) {
  return Effect.gen(function* () {
    const store = yield* Store,
      original = yield* readContentAdoptionOriginalInput(input)
    const key = sourceRootCompletionKey(original.plan.plan_id, original.index)
    const own = yield* store.upstream.command(key)
    const completions = yield* store.upstream.sourceRootCompletionClaims(
      input.page_id,
      original.item.target_key,
    )
    if (
      expected
        ? canonical(own) !== canonical(expected) ||
          completions.length !== 1 ||
          completions[0]!.operation_id !== key
        : own !== undefined || completions.length !== 0
    )
      return yield* Effect.fail(
        sourceRootCompletionRefusal(
          "Another retained completion claims this member, page or target.",
        ),
      )
    if (
      (yield* store.upstream.sourceRichTextRepairClaims(input.page_id, original.item.target_key))
        .length
    )
      return yield* Effect.fail(
        sourceRootCompletionRefusal(
          "A retained single-leaf repair already owns this page or target.",
        ),
      )
    if (
      (yield* store.upstream.command(
        contentAdoptionMemberKey(original.plan.plan_id, original.index),
      )) !== undefined ||
      (yield* store.upstream.contentAdoptionPlanClaims(input.page_id, original.item.target_key))
        .length
    )
      return yield* Effect.fail(
        sourceRootCompletionRefusal(
          "An existing content adoption must finish without changing its frozen body checkpoint.",
        ),
      )
    const { portable, ...identity } = original
    if (
      portable.kind !== "skill" ||
      portable.files.length < 2 ||
      portable.files.length > 100 ||
      !portable.files.some(
        (file) => file.path !== portable.main && /^references\/.+\.md$/i.test(file.path),
      ) ||
      original.operation.projections?.entries.length ||
      portable.files.some((file) => file.bytes.length > 1024 * 1024) ||
      portable.files.reduce((total, file) => total + file.bytes.length, 0) > 5 * 1024 * 1024
    )
      return yield* Effect.fail(
        sourceRootCompletionRefusal(
          "Empty-root completion requires the complete bounded skill with retained reference sources.",
        ),
      )
    const subscription = yield* getSubscription(
      original.plan.subscription_id,
      original.plan.database_id,
    )
    const bindings = yield* store.upstream.bindings(original.plan.subscription_id)
    const commands: Record<string, { readonly exists: boolean; readonly value: unknown }> = {}
    for (const suffix of [
      "subscription-map",
      "subscription-map:intended",
      "subscription-map:checkpoint",
      "accepted-config",
    ]) {
      const value = yield* store.upstream.command(`${original.plan.plan_id}:${suffix}`)
      commands[suffix] = { exists: value !== undefined, value: value ?? null }
    }
    const projection = yield* store.upstream.command(
      `${original.operation.operation_id}:projections`,
    )
    commands.projections = { exists: projection !== undefined, value: projection ?? null }
    return {
      original,
      hash: yield* sha256(canonical({ identity, subscription, bindings, commands })),
    }
  })
}

function assertAuthority(receipt: SourceRootCompletionReceipt) {
  return Effect.gen(function* () {
    const plan = receipt.plan,
      current = yield* readAuthority(plan.input, receipt)
    if (
      current.hash !== plan.native_inputs_sha256 ||
      canonical(current.original.plan) !== canonical(plan.original_plan) ||
      canonical(current.original.operation) !== canonical(plan.original_operation) ||
      canonical(current.original.item.candidate) !== canonical(plan.frozen)
    )
      return yield* Effect.fail(
        sourceRootCompletionRefusal(
          "The original source, operation, map, bindings or subscription changed after planning.",
        ),
      )
    if ((yield* authScope) !== plan.scope)
      return yield* Effect.fail(
        sourceRootCompletionRefusal("The original authentication scope changed."),
      )
    // Reconstruct the reviewed request from the original frozen bytes even when
    // current live content is AFTER. The retained plan is never its own source.
    const effect = yield* sourceRootCompletionTry(() =>
      deriveSourceRootCompletion(plan.input.page_id, current.original.portable, plan.before),
    )
    const archive = yield* prepareContentAdoptionSourceInstallation(
      current.original.portable,
      plan.before.raw[`v1/pages/${plan.input.page_id}`],
    )
    if (
      canonical(effect) !== canonical(plan.effect) ||
      canonical(archive.installation) !== canonical(plan.source_installation)
    )
      return yield* Effect.fail(
        sourceRootCompletionRefusal(
          "The complete reviewed request or frozen source archive descriptor cannot be reconstructed.",
        ),
      )
    yield* assertContentAdoptionUniquePage(
      current.original.plan,
      current.original.portable,
      plan.input.page_id,
      plan.data_source_id,
    )
    return current.original
  })
}

function bounds(
  plan: SourceRootCompletionPlan,
  original: Effect.Success<ReturnType<typeof readContentAdoptionOriginalInput>>,
): ContentAdoptionReadBounds {
  return {
    page_id: plan.input.page_id,
    database_id: plan.database_id,
    data_source_id: plan.data_source_id,
    scope: plan.scope,
    portable: original.portable,
    intended_hash: plan.intended_hash,
    old_marker: plan.old_marker,
    marker: plan.old_marker,
    planned_ownership: plan.ownership,
    source_installation: plan.source_installation,
    source_installed: false,
  }
}

function proposedEffect(
  input: SourceRootCompletionInput,
  original: Effect.Success<ReturnType<typeof readContentAdoptionOriginalInput>>,
  capture: ContentAdoptionCapture,
) {
  return Effect.gen(function* () {
    const effect = yield* sourceRootCompletionTry(() =>
      deriveSourceRootCompletion(input.page_id, original.portable, capture.observation),
    )
    const actual = yield* referencePagesMatch(capture.snapshot, original.portable).pipe(
      Effect.provideService(Store, capture.memoryStore),
      Effect.result,
    )
    if (actual._tag === "Success" && actual.success)
      return yield* Effect.fail(
        sourceRootCompletionRefusal("A complete authored root must use ordinary content adoption."),
      )
    if (!capture.snapshot.references?.some((page) => page.id === input.page_id))
      return yield* Effect.fail(
        sourceRootCompletionRefusal(
          "The observed root is absent from the complete captured page graph.",
        ),
      )
    const proposed = {
      ...capture.snapshot,
      references: capture.snapshot.references.map((page) =>
        page.id === input.page_id
          ? { ...page, markdown: effect.request.body.replace_content.new_str }
          : page,
      ),
    }
    if (
      !(yield* referencePagesMatch(proposed, original.portable).pipe(
        Effect.provideService(Store, capture.memoryStore),
        Effect.mapError((error) =>
          sourceRootCompletionRefusal(
            "Every retained reference must already match its complete frozen source.",
            { cause: error.code, details: error.details },
          ),
        ),
      ))
    )
      return yield* Effect.fail(
        sourceRootCompletionRefusal(
          "The hypothetical root cannot preserve all original complete references and destinations.",
        ),
      )
    return effect
  })
}

function summary(receipt: SourceRootCompletionReceipt, reused = false) {
  return {
    domain: receipt.plan.domain,
    plan_id: receipt.plan.plan_id,
    plan_hash: receipt.plan.plan_hash,
    phase: receipt.phase,
    page_id: receipt.plan.input.page_id,
    member_key: receipt.plan.input.member_key,
    kind: receipt.plan.effect.kind,
    attempts: receipt.attempts.length,
    request: receipt.plan.effect.request,
    retained_references: receipt.plan.effect.references,
    source_sha256: receipt.plan.effect.source_sha256,
    body_model_sha256: receipt.plan.effect.body_model_sha256,
    body_verified: receipt.phase === "body_verified",
    source_bytes_verified: false,
    publication_completed: false,
    original_history_preserved: true,
    ...(reused ? { reused: true, proof: "retained_historical_result" as const } : {}),
  }
}
export const showSourceRootCompletion = (id: string) => loadSourceRootCompletion(id)

export function planSourceRootCompletion(value: unknown) {
  return Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(SourceRootCompletionInputSchema)(value, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(() =>
        sourceRootCompletionRefusal(
          "Select only the exact original plan, member, page and old writing operation.",
        ),
      ),
    )
    const store = yield* Store,
      initial = yield* readContentAdoptionOriginalInput(input)
    const lockKeys = [
      `publication:${initial.originalId}`,
      `publication:${input.old_operation_id}`,
      `upstream-subscription:${initial.plan.subscription_id}`,
      ...initial.plan.items.map((item) => `upstream-target:${item.target_key}`),
    ]
    return yield* withLocalLocks(
      store.root,
      lockKeys,
      Effect.gen(function* () {
        const key = sourceRootCompletionKey(initial.plan.plan_id, initial.index),
          retained = yield* store.upstream.command(key)
        if (retained !== undefined) {
          const receipt = yield* decodeSourceRootCompletion(retained)
          if (canonical(receipt.plan.input) !== canonical(input))
            return yield* Effect.fail(
              sourceRootCompletionRefusal(
                "This original member already has a different immutable completion plan.",
              ),
            )
          return summary(receipt, true)
        }
        if (
          (yield* store.upstream.sourceRootFidelityClaims(input.page_id, initial.item.target_key))
            .length
        )
          return yield* Effect.fail(
            sourceRootCompletionRefusal(
              "A retained fidelity child cannot be adopted by a new root-completion plan.",
            ),
          )
        const authority = yield* readAuthority(input),
          current = authority.original
        const scope = yield* authScope,
          source = yield* explicitSource(current.plan.target_database_id)
        if (source.data_source_ids.length !== 1)
          return yield* Effect.fail(
            sourceRootCompletionRefusal("The target database must retain one exact data source."),
          )
        const dataSource = source.data_source_ids[0]!
        yield* assertContentAdoptionUniquePage(
          current.plan,
          current.portable,
          input.page_id,
          dataSource,
        )
        const api = yield* Notion,
          raw = yield* api.request(`v1/pages/${input.page_id}`)
        const marker = yield* sourceRootCompletionTry(() => publicationMarker(raw))
        if (
          !marker ||
          marker.state !== "writing" ||
          marker.operation_id !== input.old_operation_id ||
          marker.intended_hash !== current.intended
        )
          return yield* Effect.fail(
            sourceRootCompletionRefusal(
              "The untouched original writing marker no longer matches this frozen source.",
            ),
          )
        // This validates and compresses all original pure-text bytes in memory.
        // No artifact, upload, attachment or source journal is created here.
        const archive = yield* prepareContentAdoptionSourceInstallation(current.portable, raw)
        const capture = yield* readContentAdoptionCapture({
          page_id: input.page_id,
          database_id: current.plan.target_database_id,
          data_source_id: dataSource,
          scope,
          portable: current.portable,
          intended_hash: current.intended,
          old_marker: marker,
          marker,
          planned_ownership: current.ownership,
          source_installation: archive.installation,
          source_installed: false,
        })
        const effect = yield* proposedEffect(input, current, capture)
        const again = yield* readAuthority(input)
        if (authority.hash !== again.hash)
          return yield* Effect.fail(
            sourceRootCompletionRefusal(
              "The complete original native inputs changed while the reviewed completion was read.",
            ),
          )
        const body = {
          format: 1 as const,
          domain: "source_root_completion" as const,
          input,
          original_plan: current.plan,
          original_operation: current.operation,
          item_index: current.index,
          original_publication_id: current.originalId,
          original_integrity: current.originalIntegrity,
          old_marker: marker,
          old_history: "absent_in_current_database" as const,
          database_id: current.plan.target_database_id,
          data_source_id: dataSource,
          scope,
          target_key: current.item.target_key,
          frozen: current.item.candidate!,
          intended_hash: current.intended,
          ownership: current.ownership,
          native_inputs_sha256: authority.hash,
          before: capture.observation,
          before_body_verified: false as const,
          before_source_bytes_verified: false as const,
          source_installation: archive.installation,
          effect,
        }
        const plan = {
          ...body,
          plan_id: sourceRootCompletionId(current.plan.plan_id, current.index),
          plan_hash: yield* sha256(canonical(body)),
        }
        const receipt = yield* decodeSourceRootCompletion({
          format: 1,
          domain: "source_root_completion_receipt",
          plan,
          phase: "planned",
          attempts: [],
        })
        yield* store.upstream.createCommand(key, receipt)
        return summary(receipt)
      }),
    )
  })
}

function save(expected: SourceRootCompletionReceipt, value: SourceRootCompletionReceipt) {
  return Effect.gen(function* () {
    yield* assertNoPendingSourceRootFidelity(
      expected.plan.original_plan.plan_id,
      expected.plan.item_index,
      expected.plan.input.page_id,
      expected.plan.target_key,
    )
    const next = yield* decodeSourceRootCompletion(value)
    if (canonical(next.plan) !== canonical(expected.plan))
      return yield* Effect.fail(
        sourceRootCompletionRefusal(
          "The immutable root-completion plan cannot change during an attempt.",
        ),
      )
    const store = yield* Store
    yield* store.upstream.claimCommand(
      sourceRootCompletionKey(next.plan.original_plan.plan_id, next.plan.item_index),
      expected,
      next,
    )
    return next
  })
}

function conflict(receipt: SourceRootCompletionReceipt, observed: unknown) {
  return Effect.gen(function* () {
    const error = fail(
      "SOURCE_ROOT_COMPLETION_CONFLICT",
      "The complete graph is neither the exact empty BEFORE nor the exact complete authored AFTER.",
      { observation: observed },
    )
    if (receipt.attempts.length)
      yield* save(receipt, { ...receipt, phase: "conflict", failure: failure(error) })
    return yield* Effect.fail(error)
  })
}

function strictAfter(receipt: SourceRootCompletionReceipt) {
  return Effect.gen(function* () {
    const original = yield* assertAuthority(receipt)
    const first = yield* readContentAdoptionProof(bounds(receipt.plan, original))
    if (
      first.source_bytes_verified ||
      !sourceRootCompletionAfterMatches(receipt.plan, first.evidence)
    )
      return yield* conflict(receipt, first.evidence)
    const firstAt = yield* Clock.currentTimeMillis
    yield* assertAuthority(receipt)
    // Re-read the entire graph. Allocated IDs and every raw physical resource
    // from the first actual AFTER must now agree; no simulated capture is used.
    const second = yield* readContentAdoptionProof(bounds(receipt.plan, original))
    if (
      second.source_bytes_verified ||
      !sourceRootCompletionAfterMatches(receipt.plan, second.evidence) ||
      !sourceRootCompletionExactBefore(first.evidence, second.evidence)
    )
      return yield* conflict(receipt, { first: first.evidence, second: second.evidence })
    yield* assertAuthority(receipt)
    const last = receipt.attempts.at(-1)
    if (!last)
      return yield* Effect.fail(
        sourceRootCompletionRefusal(
          "No original completion request exists for this observed root.",
        ),
      )
    const now = yield* Clock.currentTimeMillis
    const observation: SourceRootCompletionObservation = {
      raw: second.evidence.raw,
      attachments: second.evidence.attachments,
      page_ids: second.evidence.page_ids,
      graph_sha256: second.evidence.graph_sha256,
    }
    const attempts =
      last.outcome === "acknowledged"
        ? receipt.attempts
        : receipt.attempts.map((attempt, index) =>
            index === receipt.attempts.length - 1
              ? {
                  ...attempt,
                  resolution: {
                    outcome: "observed_applied" as const,
                    observed_at_ms: now,
                    observation,
                  },
                }
              : attempt,
          )
    return yield* save(receipt, {
      ...receipt,
      phase: "body_verified",
      attempts,
      result: {
        first_observed_at_ms: firstAt,
        observed_at_ms: now,
        body_verified: true,
        source_bytes_verified: false,
        publication_completed: false,
        original_history_preserved: true,
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

function continueCompletion(receipt: SourceRootCompletionReceipt, mode: "apply" | "reconcile") {
  return Effect.gen(function* () {
    if (receipt.phase === "body_verified") return summary(receipt, true)
    yield* assertNoPendingSourceRootFidelity(
      receipt.plan.original_plan.plan_id,
      receipt.plan.item_index,
      receipt.plan.input.page_id,
      receipt.plan.target_key,
    )
    if (receipt.phase === "conflict")
      return yield* Effect.fail(
        fail(
          "SOURCE_ROOT_COMPLETION_CONFLICT",
          "This completion retains a conflict; its original evidence cannot be refreshed or overwritten.",
          receipt.failure,
        ),
      )
    if (receipt.phase === "acknowledged") return summary(yield* strictAfter(receipt))
    const original = yield* assertAuthority(receipt)
    const capture = yield* readContentAdoptionCapture(bounds(receipt.plan, original))
    const before = sourceRootCompletionExactBefore(receipt.plan.before, capture.observation)
    if (!before) {
      if (
        receipt.phase === "planned" ||
        !sourceRootCompletionAfterMatches(receipt.plan, capture.observation)
      )
        return yield* conflict(receipt, capture.observation)
      return summary(yield* strictAfter(receipt))
    }
    const effect = yield* proposedEffect(receipt.plan.input, original, capture)
    if (canonical(effect) !== canonical(receipt.plan.effect))
      return yield* Effect.fail(
        sourceRootCompletionRefusal(
          "The exact complete source request cannot be reconstructed from this empty BEFORE.",
        ),
      )
    yield* assertAuthority(receipt)
    if (mode === "reconcile")
      return { ...summary(receipt), observation: "exact_before", needs_safe_apply: true }
    const now = yield* Clock.currentTimeMillis,
      previous = receipt.attempts.at(-1)
    const attempts = previous
      ? receipt.attempts.map((attempt, index) =>
          index === receipt.attempts.length - 1
            ? {
                ...attempt,
                resolution: {
                  outcome: "known_not_applied" as const,
                  observed_at_ms: now,
                  observation: capture.observation,
                },
              }
            : attempt,
        )
      : receipt.attempts
    const pending = yield* save(receipt, {
      ...receipt,
      phase: "pending",
      attempts: [
        ...attempts,
        {
          index: attempts.length,
          started_at_ms: now,
          request: receipt.plan.effect.request,
          before_sha256: yield* sha256(canonical(receipt.plan.before)),
          outcome: "pending",
        },
      ],
    })
    const api = yield* Notion,
      request = pending.plan.effect.request
    const sent = yield* api
      .request(request.path, request.body, { method: request.method })
      .pipe(Effect.result)
    const acknowledged =
      sent._tag === "Success" && sourceRootCompletionAckMatches(pending.plan, sent.success)
    const error =
      sent._tag === "Failure"
        ? sent.failure
        : fail(
            "SOURCE_ROOT_COMPLETION_ACK_INVALID",
            "The request returned without the complete target Markdown acknowledgement.",
          )
    const retained = yield* save(pending, {
      ...pending,
      phase: acknowledged ? "acknowledged" : "unknown",
      attempts: pending.attempts.map((attempt, index) =>
        index !== pending.attempts.length - 1
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
    })
    if (!acknowledged) return yield* Effect.fail(error)
    return summary(yield* strictAfter(retained))
  })
}

function runCompletion(planId: string, planHash: string, mode: "apply" | "reconcile") {
  return Effect.gen(function* () {
    const receipt = yield* loadSourceRootCompletion(planId, planHash),
      store = yield* Store
    return yield* withLocalLocks(
      store.root,
      locks(receipt.plan),
      Effect.gen(function* () {
        const current = yield* loadSourceRootCompletion(planId, planHash)
        return yield* continueCompletion(current, mode)
      }),
    )
  })
}
export const applySourceRootCompletion = (planId: string, planHash: string) =>
  runCompletion(planId, planHash, "apply")
export const reconcileSourceRootCompletion = (planId: string, planHash: string) =>
  runCompletion(planId, planHash, "reconcile")

// The follow-on child reuses the exact original authority and lock set. None of
// these helpers changes the original plan, model, source, receipt or hash input.
export {
  assertAuthority as assertSourceRootCompletionAuthority,
  bounds as sourceRootCompletionReadBounds,
  locks as sourceRootCompletionLocks,
}
