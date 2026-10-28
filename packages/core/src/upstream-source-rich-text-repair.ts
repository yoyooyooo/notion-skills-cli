import { Clock, Effect, Schema } from "effect"
import { authScope, explicitSource } from "./catalog.ts"
import { fail, property, type SkillsError } from "./model.ts"
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
  type ContentAdoptionReadProof,
} from "./publication-content-adoption-proof.ts"
import { prepareContentAdoptionSourceInstallation } from "./publication-content-adoption-source.ts"
import {
  readContentAdoptionOriginalInput,
  assertContentAdoptionUniquePage,
} from "./upstream-content-adoption.ts"
import { getSubscription } from "./upstream-subscription.ts"
import { referencePagesMatch } from "./reference-mutation.ts"
import { deriveSourceRichTextRepair } from "./publication-source-rich-text-repair-effect.ts"
import {
  sourceRichTextRepairAckMatches,
  sourceRichTextRepairObservationMatches,
} from "./source-rich-text-repair-guards.ts"
import {
  SourceRichTextRepairInputSchema,
  decodeSourceRichTextRepair,
  loadSourceRichTextRepair,
  sourceRichTextRepairKey,
  sourceRichTextRepairId,
  sourceRichTextRepairRefusal,
  sourceRichTextRepairTry,
  type SourceRichTextRepairInput,
  type SourceRichTextRepairPlan,
  type SourceRichTextRepairReceipt,
  type SourceRichTextRepairObservation,
} from "./upstream-source-rich-text-repair-model.ts"

const originalInput = (input: SourceRichTextRepairInput) => ({
  original_plan_id: input.original_plan_id,
  member_key: input.member_key,
  page_id: input.page_id,
  old_operation_id: input.old_operation_id,
})
const locks = (plan: SourceRichTextRepairPlan) => [
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

/** Reuse the exact original CREATE_CONFLICT authority. Every repair claim and
 * already planned CA is checked under the same native publication/target locks. */
function readAuthority(input: SourceRichTextRepairInput, expected?: SourceRichTextRepairReceipt) {
  return Effect.gen(function* () {
    const store = yield* Store,
      original = yield* readContentAdoptionOriginalInput(originalInput(input))
    const key = sourceRichTextRepairKey(original.plan.plan_id, original.index)
    if (
      (yield* store.upstream.sourceRootCompletionClaims(input.page_id, original.item.target_key))
        .length
    )
      return yield* Effect.fail(
        sourceRichTextRepairRefusal(
          "A retained root-completion operation already owns this page or target.",
        ),
      )
    const own = yield* store.upstream.command(key)
    const repairs = yield* store.upstream.sourceRichTextRepairClaims(
      input.page_id,
      original.item.target_key,
    )
    if (
      expected
        ? canonical(own) !== canonical(expected) ||
          repairs.length !== 1 ||
          repairs[0]!.operation_id !== key
        : own !== undefined || repairs.length !== 0
    )
      return yield* Effect.fail(
        sourceRichTextRepairRefusal("Another retained repair claims this member, page or target."),
      )
    if (
      (yield* store.upstream.command(
        contentAdoptionMemberKey(original.plan.plan_id, original.index),
      )) !== undefined ||
      (yield* store.upstream.contentAdoptionPlanClaims(input.page_id, original.item.target_key))
        .length
    )
      return yield* Effect.fail(
        sourceRichTextRepairRefusal(
          "An existing content adoption must finish without changing its frozen body checkpoint.",
        ),
      )
    const { portable, ...identity } = original
    if (
      !portable.files.length ||
      portable.files.length > 100 ||
      original.operation.projections?.entries.length ||
      portable.files.some(
        (file) =>
          file.bytes.length > 1024 * 1024 ||
          (file.path !== portable.main && /^references\/.+\.md$/i.test(file.path)),
      ) ||
      portable.files.reduce((total, file) => total + file.bytes.length, 0) > 5 * 1024 * 1024
    )
      return yield* Effect.fail(
        sourceRichTextRepairRefusal(
          "Single-leaf repair requires the complete bounded pure-text source of one authored root.",
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

function assertAuthority(receipt: SourceRichTextRepairReceipt) {
  return Effect.gen(function* () {
    const current = yield* readAuthority(receipt.plan.input, receipt)
    if (
      current.hash !== receipt.plan.native_inputs_sha256 ||
      canonical(current.original.plan) !== canonical(receipt.plan.original_plan) ||
      canonical(current.original.operation) !== canonical(receipt.plan.original_operation) ||
      canonical(current.original.item.candidate) !== canonical(receipt.plan.frozen)
    )
      return yield* Effect.fail(
        sourceRichTextRepairRefusal(
          "The original native source, operation, map, binding or subscription changed after planning.",
        ),
      )
    if ((yield* authScope) !== receipt.plan.scope)
      return yield* Effect.fail(
        sourceRichTextRepairRefusal("The original authentication scope changed."),
      )
    yield* assertContentAdoptionUniquePage(
      current.original.plan,
      current.original.portable,
      receipt.plan.input.page_id,
      receipt.plan.data_source_id,
    )
    return current.original
  })
}

function bounds(
  plan: SourceRichTextRepairPlan,
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
    ...(plan.source_installation
      ? { source_installation: plan.source_installation, source_installed: false }
      : {}),
  }
}

function proposedEffect(
  input: SourceRichTextRepairInput,
  original: Effect.Success<ReturnType<typeof readContentAdoptionOriginalInput>>,
  capture: ContentAdoptionCapture,
) {
  return Effect.gen(function* () {
    const actual = yield* referencePagesMatch(capture.snapshot, original.portable).pipe(
      Effect.provideService(Store, capture.memoryStore),
      Effect.result,
    )
    if (actual._tag === "Success" && actual.success)
      return yield* Effect.fail(
        sourceRichTextRepairRefusal(
          "The actual body already passes the unchanged strict source proof.",
        ),
      )
    if (actual._tag === "Failure" && actual.failure.code !== "WRITE_VERIFICATION_FAILED")
      return yield* Effect.fail(actual.failure)
    const proposed = yield* sourceRichTextRepairTry(() =>
      deriveSourceRichTextRepair(original.portable, input.page_id, capture.raw, capture.snapshot, {
        kind: input.kind,
        block_id: input.block_id,
      }),
    )
    if (
      !(yield* referencePagesMatch(proposed.snapshot, original.portable).pipe(
        Effect.provideService(Store, capture.memoryStore),
      ))
    )
      return yield* Effect.fail(
        sourceRichTextRepairRefusal(
          "The proposed single effect does not prove the complete original source body.",
        ),
      )
    return proposed.effect
  })
}

function summary(receipt: SourceRichTextRepairReceipt, reused = false) {
  return {
    plan_id: receipt.plan.plan_id,
    plan_hash: receipt.plan.plan_hash,
    domain: receipt.domain,
    state: receipt.phase,
    reused,
    page_id: receipt.plan.input.page_id,
    original_plan_id: receipt.plan.original_plan.plan_id,
    member_key: receipt.plan.input.member_key,
    original_publication_id: receipt.plan.original_publication_id,
    old_operation_id: receipt.plan.input.old_operation_id,
    effect: receipt.plan.effect,
    attempt_count: receipt.attempts.length,
    body_verified: receipt.phase === "body_verified",
    source_bytes_verified: receipt.result?.source_bytes_verified ?? false,
    publication_completed: false,
    original_history_preserved: true,
    ...(receipt.result ? { result: receipt.result } : {}),
    ...(receipt.failure ? { failure: receipt.failure } : {}),
  }
}

export function showSourceRichTextRepair(planId: string) {
  return loadSourceRichTextRepair(planId)
}

export function planSourceRichTextRepair(input: SourceRichTextRepairInput) {
  return Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(SourceRichTextRepairInputSchema)(input, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(() =>
        sourceRichTextRepairRefusal(
          "Select strict original identities and one supported physical leaf.",
        ),
      ),
    )
    const store = yield* Store,
      first = yield* readContentAdoptionOriginalInput(originalInput(input))
    return yield* withLocalLocks(
      store.root,
      [
        `publication:${first.originalId}`,
        `publication:${input.old_operation_id}`,
        `upstream-subscription:${first.plan.subscription_id}`,
        ...first.plan.items.map((item) => `upstream-target:${item.target_key}`),
      ],
      Effect.gen(function* () {
        const key = sourceRichTextRepairKey(first.plan.plan_id, first.index),
          existing = yield* store.upstream.command(key)
        if (existing !== undefined) {
          const saved = yield* decodeSourceRichTextRepair(existing)
          if (canonical(saved.plan.input) !== canonical(input))
            return yield* Effect.fail(
              sourceRichTextRepairRefusal(
                "This original member already retains another exact repair plan.",
              ),
            )
          return summary(saved, true)
        }
        const authority = yield* readAuthority(input),
          current = authority.original
        const scope = yield* authScope
        if (scope !== current.plan.scope)
          return yield* Effect.fail(
            sourceRichTextRepairRefusal("The original authentication scope changed."),
          )
        const source = yield* explicitSource(current.plan.target_database_id)
        if (source.data_source_ids.length !== 1)
          return yield* Effect.fail(
            sourceRichTextRepairRefusal("One exact original data source is required."),
          )
        const dataSource = source.data_source_ids[0]!
        yield* assertContentAdoptionUniquePage(
          current.plan,
          current.portable,
          input.page_id,
          dataSource,
        )
        const raw = yield* (yield* Notion).request(`v1/pages/${input.page_id}`)
        const marker = yield* sourceRichTextRepairTry(() => publicationMarker(raw))
        if (
          !marker ||
          marker.state !== "writing" ||
          marker.operation_id !== input.old_operation_id ||
          marker.intended_hash !== current.intended
        )
          return yield* Effect.fail(
            sourceRichTextRepairRefusal(
              "The untouched original writing marker no longer matches this frozen source.",
            ),
          )
        const files = property(property(property(raw).properties).Files).files
        const archive =
          Array.isArray(files) && files.length === 0 && current.portable.files.length > 1
            ? yield* prepareContentAdoptionSourceInstallation(current.portable, raw)
            : undefined
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
          ...(archive
            ? { source_installation: archive.installation, source_installed: false }
            : {}),
        })
        const effect = yield* proposedEffect(input, current, capture)
        const again = yield* readAuthority(input)
        if (authority.hash !== again.hash)
          return yield* Effect.fail(
            sourceRichTextRepairRefusal(
              "The original native inputs changed while the complete repair plan was read.",
            ),
          )
        const body = {
          format: 1 as const,
          domain: "source_rich_text_repair" as const,
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
          ...(archive ? { source_installation: archive.installation } : {}),
          effect,
        }
        const plan = {
          ...body,
          plan_id: sourceRichTextRepairId(current.plan.plan_id, current.index),
          plan_hash: yield* sha256(canonical(body)),
        }
        const receipt = yield* decodeSourceRichTextRepair({
          format: 1,
          domain: "source_rich_text_repair_receipt",
          plan,
          phase: "planned",
          attempts: [],
        })
        // The claim and complete immutable plan are one insert-if-absent row.
        // No upload, object overwrite, publication or integrity row is created.
        yield* store.upstream.createCommand(key, receipt)
        return summary(receipt)
      }),
    )
  })
}

function save(expected: SourceRichTextRepairReceipt, value: SourceRichTextRepairReceipt) {
  return Effect.gen(function* () {
    const next = yield* decodeSourceRichTextRepair(value)
    if (canonical(next.plan) !== canonical(expected.plan))
      return yield* Effect.fail(
        sourceRichTextRepairRefusal("The immutable repair plan cannot change during an attempt."),
      )
    const store = yield* Store
    yield* store.upstream.claimCommand(
      sourceRichTextRepairKey(next.plan.original_plan.plan_id, next.plan.item_index),
      expected,
      next,
    )
    return next
  })
}

function conflict(receipt: SourceRichTextRepairReceipt, observed: SourceRichTextRepairObservation) {
  return Effect.gen(function* () {
    const error = fail(
      "SOURCE_RICH_TEXT_REPAIR_CONFLICT",
      "The complete observed graph is neither this exact BEFORE nor this exact single-effect AFTER.",
      { observation: observed },
    )
    if (receipt.attempts.length)
      yield* save(receipt, { ...receipt, phase: "conflict", failure: failure(error) })
    return yield* Effect.fail(error)
  })
}

function complete(receipt: SourceRichTextRepairReceipt, proof: ContentAdoptionReadProof) {
  return Effect.gen(function* () {
    if (!sourceRichTextRepairObservationMatches(receipt.plan, proof.evidence, "after"))
      return yield* conflict(receipt, proof.evidence)
    yield* assertAuthority(receipt)
    const last = receipt.attempts.at(-1)
    if (!last)
      return yield* Effect.fail(
        sourceRichTextRepairRefusal("No original request exists for the observed repair."),
      )
    const now = yield* Clock.currentTimeMillis
    const observation: SourceRichTextRepairObservation = {
      raw: proof.evidence.raw,
      attachments: proof.evidence.attachments,
      page_ids: proof.evidence.page_ids,
      graph_sha256: proof.evidence.graph_sha256,
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
        observed_at_ms: now,
        body_verified: true,
        source_bytes_verified: proof.source_bytes_verified,
        publication_completed: false,
        original_history_preserved: true,
        proof: proof.evidence,
      },
    })
  })
}

function strictAfter(receipt: SourceRichTextRepairReceipt) {
  return Effect.gen(function* () {
    const original = yield* assertAuthority(receipt)
    // This is the unchanged native CA proof, with a new actual live capture.
    // The hypothetical snapshot used to plan the effect never reaches here.
    const proof = yield* readContentAdoptionProof(bounds(receipt.plan, original))
    return yield* complete(receipt, proof)
  })
}

function continueRepair(receipt: SourceRichTextRepairReceipt, mode: "apply" | "reconcile") {
  return Effect.gen(function* () {
    if (receipt.phase === "body_verified") return summary(receipt, true)
    if (receipt.phase === "conflict")
      return yield* Effect.fail(
        fail(
          "SOURCE_RICH_TEXT_REPAIR_CONFLICT",
          "This exact repair retains a conflict; its evidence cannot be refreshed or replaced.",
          receipt.failure,
        ),
      )
    if (receipt.phase === "acknowledged") return summary(yield* strictAfter(receipt))
    const original = yield* assertAuthority(receipt)
    const capture = yield* readContentAdoptionCapture(bounds(receipt.plan, original))
    const before = sourceRichTextRepairObservationMatches(
      receipt.plan,
      capture.observation,
      "before",
    )
    const after = sourceRichTextRepairObservationMatches(receipt.plan, capture.observation, "after")
    if (!before) {
      if (!after || receipt.phase === "planned")
        return yield* conflict(receipt, capture.observation)
      return summary(yield* strictAfter(receipt))
    }
    const effect = yield* proposedEffect(receipt.plan.input, original, capture)
    if (canonical(effect) !== canonical(receipt.plan.effect))
      return yield* Effect.fail(
        sourceRichTextRepairRefusal(
          "The exact frozen single effect cannot be reconstructed from this complete BEFORE.",
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
    // The old unknown stays in the journal. Its exact BEFORE resolution and the
    // next pending request are committed together, before the one request.
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
      sent._tag === "Success" && sourceRichTextRepairAckMatches(pending.plan, sent.success)
    const error =
      sent._tag === "Failure"
        ? sent.failure
        : fail(
            "SOURCE_RICH_TEXT_REPAIR_ACK_INVALID",
            "The request returned without the exact complete expected block acknowledgement.",
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

function runRepair(planId: string, planHash: string, mode: "apply" | "reconcile") {
  return Effect.gen(function* () {
    const receipt = yield* loadSourceRichTextRepair(planId, planHash),
      store = yield* Store
    return yield* withLocalLocks(
      store.root,
      locks(receipt.plan),
      Effect.gen(function* () {
        const current = yield* loadSourceRichTextRepair(planId, planHash)
        return yield* continueRepair(current, mode)
      }),
    )
  })
}
export const applySourceRichTextRepair = (planId: string, planHash: string) =>
  runRepair(planId, planHash, "apply")
export const reconcileSourceRichTextRepair = (planId: string, planHash: string) =>
  runRepair(planId, planHash, "reconcile")
