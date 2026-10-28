import { Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { Store, sha256 } from "./store.ts"
import { canonical } from "./publication-effect-proof.ts"
import { ContentAdoptionEvidenceSchema } from "./publication-content-adoption-authority.ts"
import {
  SourceRootCompletionReceiptSchema,
  SourceRootCompletionObservationSchema,
  decodeSourceRootCompletion,
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

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Page = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
)
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const Raw = Schema.Record(Schema.String, Schema.Unknown)
const Request = Schema.Struct({ path: Schema.String, method: Schema.Literal("PATCH"), body: Raw })
export const SourceRootFidelityInputSchema = Schema.Struct({
  completion_plan_id: Schema.String,
  completion_plan_hash: Hash,
})
const EffectSchema = Schema.Struct({
  index: Count,
  kind: Schema.Literals([
    "restore_literal_entity",
    "restore_literal_plus",
    "remove_filename_autolink",
  ]),
  block_id: Page,
  root_index: Count,
  row_index: Schema.NullOr(Count),
  column_index: Schema.NullOr(Count),
  occurrences: Count,
  ancestor_ids: Schema.Array(Page),
  source_edit: Schema.Struct({
    start: Count,
    end: Count,
    source: Schema.String,
    observed: Schema.String,
  }),
  observed_link: Schema.NullOr(Schema.Struct({ label: Schema.String, url: Schema.String })),
  before_block: Raw,
  after_block: Raw,
  request: Request,
})
export const SourceRootFidelityPlanSchema = Schema.Struct({
  format: Schema.Literal(1),
  domain: Schema.Literal("source_root_fidelity"),
  plan_id: Schema.String,
  plan_hash: Hash,
  input: SourceRootFidelityInputSchema,
  parent: SourceRootCompletionReceiptSchema,
  parent_receipt_sha256: Hash,
  page_id: Page,
  target_key: Schema.String,
  kind: Schema.Literal("acknowledged_root_nine_literal_effects"),
  before: SourceRootCompletionObservationSchema,
  before_body: Schema.String,
  before_body_verified: Schema.Literal(false),
  before_source_bytes_verified: Schema.Literal(false),
  effects: Schema.Array(EffectSchema),
})
export type SourceRootFidelityPlan = typeof SourceRootFidelityPlanSchema.Type
const Failure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
})
const Resolution = Schema.Struct({
  outcome: Schema.Literals(["known_not_applied", "observed_applied"]),
  observed_at_ms: Count,
  observation: Schema.optional(SourceRootCompletionObservationSchema),
  checkpoint_sha256: Schema.optional(Hash),
})
const Attempt = Schema.Struct({
  index: Count,
  effect_index: Count,
  started_at_ms: Count,
  request: Request,
  before_sha256: Hash,
  outcome: Schema.Literals(["pending", "unknown", "acknowledged"]),
  response: Schema.optional(Schema.Unknown),
  untrusted_response: Schema.optional(Schema.Unknown),
  failure: Schema.optional(Failure),
  resolution: Schema.optional(Resolution),
})
const Checkpoint = Schema.Struct({
  effect_index: Count,
  attempt_index: Count,
  observed_at_ms: Count,
  observation: SourceRootCompletionObservationSchema,
})
const Result = Schema.Struct({
  parent_receipt_sha256: Hash,
  first_observed_at_ms: Count,
  observed_at_ms: Count,
  body_verified: Schema.Literal(true),
  source_bytes_verified: Schema.Literal(false),
  publication_completed: Schema.Literal(false),
  parent_receipt_unchanged: Schema.Literal(true),
  first_observation: SourceRootCompletionObservationSchema,
  proof: ContentAdoptionEvidenceSchema,
})
/** One independent CAS row owns only these nine typed block requests. The
 * acknowledged parent request, publication, original UO and source stay intact. */
export const SourceRootFidelityReceiptSchema = Schema.Struct({
  format: Schema.Literal(1),
  domain: Schema.Literal("source_root_fidelity_receipt"),
  plan: SourceRootFidelityPlanSchema,
  phase: Schema.Literals([
    "planned",
    "ready",
    "pending",
    "unknown",
    "acknowledged",
    "conflict",
    "body_verified",
  ]),
  attempts: Schema.Array(Attempt),
  checkpoints: Schema.Array(Checkpoint),
  result: Schema.optional(Result),
  failure: Schema.optional(Failure),
})
export type SourceRootFidelityReceipt = typeof SourceRootFidelityReceiptSchema.Type
export const SOURCE_ROOT_FIDELITY_ATTEMPT_LIMIT = 18
export const sourceRootFidelityKey = (plan: string, index: number) =>
  `source-root-fidelity:member:${plan}:${index}`
export const sourceRootFidelityId = (plan: string, index: number) => `srf_${plan.slice(3)}_${index}`
export const sourceRootFidelityRefusal = (message: string, details?: unknown) =>
  fail("SOURCE_ROOT_FIDELITY_REFUSED", message, details)
export const sourceRootFidelityTry = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : sourceRootFidelityRefusal("The complete fidelity evidence is invalid."),
  })
export const sourceRootFidelityCheckpoint = (receipt: SourceRootFidelityReceipt) =>
  receipt.checkpoints.at(-1)?.observation ?? receipt.plan.before

export function decodeSourceRootFidelity(value: unknown) {
  return Effect.gen(function* () {
    const receipt = yield* Schema.decodeUnknownEffect(SourceRootFidelityReceiptSchema)(value, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(() =>
        sourceRootFidelityRefusal("The retained source-root fidelity claim is missing or invalid."),
      ),
    )
    const plan = receipt.plan,
      parent = yield* decodeSourceRootCompletion(plan.parent)
    const { plan_id: _id, plan_hash: _hash, ...body } = plan
    const acknowledged = parent.attempts[0]
    if (
      parent.phase !== "acknowledged" ||
      parent.attempts.length !== 1 ||
      !acknowledged ||
      acknowledged.outcome !== "acknowledged" ||
      acknowledged.response === undefined ||
      acknowledged.resolution !== undefined ||
      parent.failure !== undefined ||
      parent.result !== undefined ||
      plan.input.completion_plan_id !== parent.plan.plan_id ||
      plan.input.completion_plan_hash !== parent.plan.plan_hash ||
      plan.parent_receipt_sha256 !== (yield* sha256(canonical(parent))) ||
      plan.page_id !== parent.plan.input.page_id ||
      plan.target_key !== parent.plan.target_key ||
      plan.plan_id !==
        sourceRootFidelityId(parent.plan.original_plan.plan_id, parent.plan.item_index) ||
      plan.plan_hash !== (yield* sha256(canonical(body)))
    )
      return yield* Effect.fail(
        sourceRootFidelityRefusal(
          "The immutable fidelity plan must bind the sole genuinely acknowledged original completion.",
        ),
      )
    const derived = yield* sourceRootFidelityTry(() =>
      deriveSourceRootFidelity(parent.plan, plan.before),
    )
    if (
      canonical(derived.effects) !== canonical(plan.effects) ||
      derived.before_body !== plan.before_body ||
      (yield* sha256(canonical(derived.source_body_model))) !==
        parent.plan.effect.body_model_sha256 ||
      receipt.attempts.length > SOURCE_ROOT_FIDELITY_ATTEMPT_LIMIT ||
      receipt.checkpoints.length > plan.effects.length
    )
      return yield* Effect.fail(
        sourceRootFidelityRefusal(
          "Every exact block effect must be reconstructed from the original frozen source model and complete BEFORE.",
        ),
      )
    let completed = 0,
      checkpoint = plan.before,
      previousAt = 0,
      active = false
    for (const [index, attempt] of receipt.attempts.entries()) {
      const effect = plan.effects[completed],
        resolution = attempt.resolution
      const current = receipt.checkpoints[completed]
      if (
        !effect ||
        attempt.index !== index ||
        attempt.effect_index !== completed ||
        attempt.started_at_ms < previousAt ||
        canonical(attempt.request) !== canonical(effect.request) ||
        attempt.before_sha256 !== (yield* sha256(canonical(checkpoint))) ||
        (attempt.outcome === "pending" &&
          (attempt.response !== undefined ||
            attempt.failure !== undefined ||
            attempt.untrusted_response !== undefined)) ||
        (attempt.outcome === "unknown" &&
          (attempt.response !== undefined || attempt.failure === undefined)) ||
        (attempt.outcome === "acknowledged" &&
          (attempt.response === undefined ||
            attempt.failure !== undefined ||
            attempt.untrusted_response !== undefined ||
            resolution !== undefined ||
            !sourceRootFidelityAckMatches(effect, attempt.response))) ||
        (attempt.untrusted_response !== undefined &&
          (attempt.outcome !== "unknown" ||
            attempt.failure?.code !== "SOURCE_ROOT_FIDELITY_ACK_INVALID")) ||
        (resolution &&
          (attempt.outcome === "acknowledged" || resolution.observed_at_ms < attempt.started_at_ms))
      )
        return yield* Effect.fail(
          sourceRootFidelityRefusal(
            "The exact typed request journal or its full block acknowledgement changed.",
          ),
        )
      if (resolution?.outcome === "known_not_applied") {
        if (
          !resolution.observation ||
          resolution.checkpoint_sha256 !== undefined ||
          !sourceRootFidelityBeforeMatches(
            parent.plan,
            plan.effects,
            checkpoint,
            resolution.observation,
            completed,
          ) ||
          current?.attempt_index === index
        )
          return yield* Effect.fail(
            sourceRootFidelityRefusal(
              "A known-not-applied resolution must retain one complete exact current BEFORE.",
            ),
          )
        previousAt = resolution.observed_at_ms
        continue
      }
      if (current?.attempt_index === index) {
        if (
          current.effect_index !== completed ||
          current.observed_at_ms < attempt.started_at_ms ||
          !sourceRootFidelityAfterMatches(
            parent.plan,
            plan.effects,
            checkpoint,
            current.observation,
            completed,
          ) ||
          !(attempt.outcome === "acknowledged" || resolution?.outcome === "observed_applied") ||
          (resolution &&
            (resolution.observation !== undefined ||
              resolution.observed_at_ms !== current.observed_at_ms ||
              resolution.checkpoint_sha256 !== (yield* sha256(canonical(current.observation)))))
        )
          return yield* Effect.fail(
            sourceRootFidelityRefusal(
              "Each completed effect requires its own exact adjacent full-graph AFTER checkpoint.",
            ),
          )
        checkpoint = current.observation
        previousAt = current.observed_at_ms
        completed++
      } else {
        if (resolution !== undefined || index !== receipt.attempts.length - 1)
          return yield* Effect.fail(
            sourceRootFidelityRefusal(
              "A pending or unknown effect cannot be skipped or inferred from a later prefix.",
            ),
          )
        active = true
      }
    }
    if (completed !== receipt.checkpoints.length)
      return yield* Effect.fail(
        sourceRootFidelityRefusal("A fidelity checkpoint has no exact preceding native attempt."),
      )
    const last = receipt.attempts.at(-1),
      result = receipt.result
    let invalid = false
    if (receipt.phase === "planned")
      invalid =
        receipt.attempts.length !== 0 ||
        completed !== 0 ||
        result !== undefined ||
        receipt.failure !== undefined
    else if (receipt.phase === "ready")
      invalid = !last || active || result !== undefined || receipt.failure !== undefined
    else if (receipt.phase === "body_verified")
      invalid =
        active ||
        completed !== plan.effects.length ||
        !result ||
        receipt.failure !== undefined ||
        result.parent_receipt_sha256 !== plan.parent_receipt_sha256 ||
        result.first_observed_at_ms < previousAt ||
        result.observed_at_ms < result.first_observed_at_ms ||
        !sourceRootCompletionExactBefore(checkpoint, result.first_observation) ||
        !sourceRootCompletionExactBefore(result.first_observation, result.proof) ||
        !sourceRootCompletionAfterMatches(parent.plan, result.first_observation) ||
        !sourceRootCompletionAfterMatches(parent.plan, result.proof) ||
        result.proof.source_proof !== "not_installed" ||
        result.proof.files.length !== 0 ||
        result.proof.attachments.length !== 0
    else if (receipt.phase === "conflict")
      invalid = result !== undefined || receipt.failure === undefined
    else
      invalid =
        !last ||
        !active ||
        result !== undefined ||
        receipt.failure !== undefined ||
        receipt.phase !== last.outcome
    if (invalid)
      return yield* Effect.fail(
        sourceRootFidelityRefusal(
          "The fidelity phase contradicts its retained attempts, complete prefix or independent final evidence.",
        ),
      )
    return receipt
  })
}

export function loadSourceRootFidelity(id: string, hash?: string) {
  return Effect.gen(function* () {
    const match = /^srf_([a-f0-9]{64})_(0|[1-9][0-9]{0,6})$/.exec(id)
    if (!match)
      return yield* Effect.fail(
        sourceRootFidelityRefusal("Select an exact source-root fidelity plan identity."),
      )
    const store = yield* Store
    const receipt = yield* decodeSourceRootFidelity(
      yield* store.upstream.command(sourceRootFidelityKey(`up_${match[1]}`, Number(match[2]))),
    )
    if (receipt.plan.plan_id !== id || (hash !== undefined && receipt.plan.plan_hash !== hash))
      return yield* Effect.fail(
        sourceRootFidelityRefusal("The reviewed source-root fidelity plan hash changed."),
      )
    return receipt
  })
}

/** This removes only the mutual-exclusion fence. The parent and ordinary CA
 * still perform their own unchanged, fresh full-body/source proof. */
export function assertNoPendingSourceRootFidelity(
  plan: string,
  index: number,
  page: string,
  target: string,
) {
  return Effect.gen(function* () {
    const store = yield* Store,
      key = sourceRootFidelityKey(plan, index)
    const own = yield* store.upstream.command(key),
      claims = yield* store.upstream.sourceRootFidelityClaims(page, target)
    if (own !== undefined && !claims.some((claim) => claim.operation_id === key))
      return yield* Effect.fail(
        sourceRootFidelityRefusal("The original member has a contradictory fidelity claim."),
      )
    for (const claim of claims) {
      const receipt = yield* decodeSourceRootFidelity(claim.value),
        parent = receipt.plan.parent.plan
      if (
        claim.operation_id !== key ||
        parent.original_plan.plan_id !== plan ||
        parent.item_index !== index ||
        receipt.plan.page_id !== page ||
        receipt.plan.target_key !== target ||
        receipt.phase !== "body_verified"
      )
        return yield* Effect.fail(
          sourceRootFidelityRefusal(
            "This page or target retains an active or different source-root fidelity repair; reconcile that exact child first.",
          ),
        )
    }
  })
}
