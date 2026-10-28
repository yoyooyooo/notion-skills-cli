import { Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { Store, sha256 } from "./store.ts"
import { canonical } from "./publication-effect-proof.ts"
import { PublicationMarkerSchema, IntegrityIntentSchema } from "./publication-integrity-state.ts"
import {
  UpstreamPlanSchema,
  UpstreamOperationSchema,
  FrozenPortableSchema,
} from "./upstream-model.ts"
import {
  ContentAdoptionOwnershipSchema,
  ContentAdoptionEvidenceSchema,
  ContentAdoptionSourceInstallationSchema,
} from "./publication-content-adoption-authority.ts"
import { compileSourceRootBody } from "./source-root-completion-physical.ts"
import {
  sourceRootCompletionAckMatches,
  sourceRootCompletionAfterMatches,
  sourceRootCompletionExactBefore,
  sourceRootCompletionInventory,
} from "./source-root-completion-guards.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Page = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
)
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
export const SourceRootCompletionInputSchema = Schema.Struct({
  original_plan_id: Schema.String,
  member_key: Schema.String,
  page_id: Page,
  old_operation_id: Schema.String.check(Schema.isPattern(/^p_[a-zA-Z0-9-]{1,100}$/)),
})
export type SourceRootCompletionInput = typeof SourceRootCompletionInputSchema.Type
export const SourceRootCompletionObservationSchema = Schema.Struct({
  raw: Schema.Record(Schema.String, Schema.Unknown),
  attachments: Schema.Array(
    Schema.Struct({ index: Count, name: Schema.String, bytes: Count, sha256: Hash }),
  ),
  page_ids: Schema.Array(Page),
  graph_sha256: Hash,
})
export type SourceRootCompletionObservation = typeof SourceRootCompletionObservationSchema.Type
const RequestSchema = Schema.Struct({
  path: Schema.String,
  method: Schema.Literal("PATCH"),
  body: Schema.Struct({
    markdown_version: Schema.Literal("v2"),
    type: Schema.Literal("replace_content"),
    replace_content: Schema.Struct({ new_str: Schema.String }),
  }),
})
export const SourceRootCompletionEffectSchema = Schema.Struct({
  kind: Schema.Literal("empty_authored_root"),
  before_shape: Schema.Literal("only_retained_reference_child_pages"),
  source_path: Schema.String,
  source_sha256: Hash,
  source_body_sha256: Hash,
  authored_body: Schema.String,
  body_model_sha256: Hash,
  references: Schema.Array(
    Schema.Struct({ path: Schema.String, page_id: Page, tag: Schema.String }),
  ),
  retained_markdown: Schema.String,
  request: RequestSchema,
  proposed_only: Schema.Literal(true),
})
export const SourceRootCompletionPlanSchema = Schema.Struct({
  format: Schema.Literal(1),
  domain: Schema.Literal("source_root_completion"),
  plan_id: Schema.String,
  plan_hash: Hash,
  input: SourceRootCompletionInputSchema,
  original_plan: UpstreamPlanSchema,
  original_operation: UpstreamOperationSchema,
  item_index: Count,
  original_publication_id: Schema.String,
  original_integrity: IntegrityIntentSchema,
  old_marker: PublicationMarkerSchema,
  old_history: Schema.Literal("absent_in_current_database"),
  database_id: Page,
  data_source_id: Page,
  scope: Hash,
  target_key: Schema.String,
  frozen: FrozenPortableSchema,
  intended_hash: Hash,
  ownership: ContentAdoptionOwnershipSchema,
  native_inputs_sha256: Hash,
  before: SourceRootCompletionObservationSchema,
  before_body_verified: Schema.Literal(false),
  before_source_bytes_verified: Schema.Literal(false),
  source_installation: ContentAdoptionSourceInstallationSchema,
  effect: SourceRootCompletionEffectSchema,
})
export type SourceRootCompletionPlan = typeof SourceRootCompletionPlanSchema.Type
const FailureSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
})
const ResolutionSchema = Schema.Struct({
  outcome: Schema.Literals(["known_not_applied", "observed_applied"]),
  observed_at_ms: Count,
  observation: SourceRootCompletionObservationSchema,
})
const AttemptSchema = Schema.Struct({
  index: Count,
  started_at_ms: Count,
  request: RequestSchema,
  before_sha256: Hash,
  outcome: Schema.Literals(["pending", "unknown", "acknowledged"]),
  response: Schema.optional(Schema.Unknown),
  untrusted_response: Schema.optional(Schema.Unknown),
  failure: Schema.optional(FailureSchema),
  resolution: Schema.optional(ResolutionSchema),
})
const ResultSchema = Schema.Struct({
  first_observed_at_ms: Count,
  observed_at_ms: Count,
  body_verified: Schema.Literal(true),
  source_bytes_verified: Schema.Literal(false),
  publication_completed: Schema.Literal(false),
  original_history_preserved: Schema.Literal(true),
  first_observation: SourceRootCompletionObservationSchema,
  proof: ContentAdoptionEvidenceSchema,
})
/** This one CAS row owns the reviewed completion claim and all request history.
 * It is never a publication receipt, page marker, source archive or parent ACK. */
export const SourceRootCompletionReceiptSchema = Schema.Struct({
  format: Schema.Literal(1),
  domain: Schema.Literal("source_root_completion_receipt"),
  plan: SourceRootCompletionPlanSchema,
  phase: Schema.Literals([
    "planned",
    "pending",
    "unknown",
    "acknowledged",
    "conflict",
    "body_verified",
  ]),
  attempts: Schema.Array(AttemptSchema),
  result: Schema.optional(ResultSchema),
  failure: Schema.optional(FailureSchema),
})
export type SourceRootCompletionReceipt = typeof SourceRootCompletionReceiptSchema.Type
export const sourceRootCompletionKey = (plan: string, index: number) =>
  `source-root-completion:member:${plan}:${index}`
export const sourceRootCompletionId = (plan: string, index: number) =>
  `src_${plan.slice(3)}_${index}`
export const sourceRootCompletionRefusal = (message: string, details?: unknown) =>
  fail("SOURCE_ROOT_COMPLETION_REFUSED", message, details)
export const sourceRootCompletionTry = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : sourceRootCompletionRefusal("The complete source root-completion evidence is invalid."),
  })

export function decodeSourceRootCompletion(value: unknown) {
  return Effect.gen(function* () {
    const receipt = yield* Schema.decodeUnknownEffect(SourceRootCompletionReceiptSchema)(value, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(() =>
        sourceRootCompletionRefusal("The retained root-completion claim is missing or invalid."),
      ),
    )
    const plan = receipt.plan,
      { plan_id: _id, plan_hash: _hash, ...body } = plan
    const original = plan.original_plan,
      selected = original.items[plan.item_index],
      effect = plan.effect
    const before = yield* sourceRootCompletionTry(() =>
      sourceRootCompletionInventory(plan.input.page_id, plan.before),
    )
    const compiled = yield* sourceRootCompletionTry(() =>
      compileSourceRootBody(effect.authored_body),
    )
    if (
      plan.plan_id !== sourceRootCompletionId(original.plan_id, plan.item_index) ||
      (yield* sha256(canonical(body))) !== plan.plan_hash ||
      !selected ||
      selected.member_key !== plan.input.member_key ||
      original.plan_id !== plan.input.original_plan_id ||
      plan.target_key !== selected.target_key ||
      plan.old_marker.operation_id !== plan.input.old_operation_id ||
      canonical(plan.frozen) !== canonical(selected.candidate) ||
      plan.original_operation.plan_id !== original.plan_id ||
      plan.original_operation.items[plan.item_index]?.member_key !== plan.input.member_key ||
      plan.old_marker.state !== "writing" ||
      plan.old_marker.intended_hash !== plan.intended_hash ||
      before.ordinary_nodes.length ||
      !before.references.length ||
      canonical(before.references) !== canonical(effect.references) ||
      before.markdown !== effect.retained_markdown ||
      !/^[\t\r\n ]*$/.test(before.markdown.replace(/<page url="[^"]+">[^<>]*<\/page>/g, "")) ||
      effect.source_path !== plan.frozen.main ||
      effect.source_sha256 !==
        plan.frozen.files.find((file) => file.path === plan.frozen.main)?.hash ||
      /<\/?page(?=[\s/>]|$)/i.test(effect.authored_body) ||
      !compiled ||
      (yield* sha256(canonical(compiled))) !== effect.body_model_sha256 ||
      effect.request.path !== `v1/pages/${plan.input.page_id}/markdown` ||
      effect.request.body.replace_content.new_str !==
        `${effect.authored_body}${effect.authored_body.endsWith("\n") ? "" : "\n"}${effect.retained_markdown}`
    )
      return yield* Effect.fail(
        sourceRootCompletionRefusal(
          "The immutable completion identity, complete source model or sole request changed.",
        ),
      )
    const beforeHash = yield* sha256(canonical(plan.before))
    for (const [index, attempt] of receipt.attempts.entries()) {
      if (
        attempt.index !== index ||
        attempt.before_sha256 !== beforeHash ||
        canonical(attempt.request) !== canonical(effect.request) ||
        (attempt.outcome === "pending" &&
          (attempt.response !== undefined || attempt.failure !== undefined)) ||
        (attempt.outcome === "unknown" &&
          (attempt.response !== undefined || attempt.failure === undefined)) ||
        (attempt.untrusted_response !== undefined &&
          (attempt.outcome !== "unknown" ||
            attempt.failure?.code !== "SOURCE_ROOT_COMPLETION_ACK_INVALID")) ||
        (attempt.outcome === "acknowledged" &&
          (attempt.response === undefined ||
            attempt.failure !== undefined ||
            attempt.resolution !== undefined)) ||
        (attempt.outcome === "acknowledged" &&
          !sourceRootCompletionAckMatches(plan, attempt.response)) ||
        (index < receipt.attempts.length - 1 &&
          attempt.resolution?.outcome !== "known_not_applied") ||
        (attempt.resolution &&
          (attempt.outcome === "acknowledged" ||
            attempt.resolution.observed_at_ms < attempt.started_at_ms ||
            !(attempt.resolution.outcome === "known_not_applied"
              ? sourceRootCompletionExactBefore(plan.before, attempt.resolution.observation)
              : sourceRootCompletionAfterMatches(plan, attempt.resolution.observation))))
      )
        return yield* Effect.fail(
          sourceRootCompletionRefusal("The exact completion request journal changed."),
        )
    }
    const last = receipt.attempts.at(-1),
      result = receipt.result
    let invalid = false
    if (receipt.phase === "planned")
      invalid =
        receipt.attempts.length !== 0 || result !== undefined || receipt.failure !== undefined
    else if (receipt.phase === "body_verified")
      invalid =
        !last ||
        !result ||
        receipt.failure !== undefined ||
        !(last.outcome === "acknowledged" || last.resolution?.outcome === "observed_applied") ||
        result.first_observed_at_ms < last.started_at_ms ||
        result.observed_at_ms < result.first_observed_at_ms ||
        !sourceRootCompletionAfterMatches(plan, result.first_observation) ||
        !sourceRootCompletionAfterMatches(plan, result.proof) ||
        !sourceRootCompletionExactBefore(result.first_observation, result.proof) ||
        (last.resolution !== undefined &&
          !sourceRootCompletionExactBefore(last.resolution.observation, result.proof)) ||
        result.proof.source_proof !== "not_installed" ||
        result.proof.files.length !== 0 ||
        result.proof.attachments.length !== 0
    else if (receipt.phase === "conflict")
      invalid =
        !last ||
        result !== undefined ||
        receipt.failure === undefined ||
        last.resolution !== undefined
    else
      invalid =
        !last ||
        result !== undefined ||
        receipt.failure !== undefined ||
        receipt.phase !== last.outcome ||
        last.resolution !== undefined
    if (invalid)
      return yield* Effect.fail(
        sourceRootCompletionRefusal(
          "The completion phase contradicts its retained request outcome or stable full AFTER proof.",
        ),
      )
    return receipt
  })
}

export function loadSourceRootCompletion(id: string, hash?: string) {
  return Effect.gen(function* () {
    const match = /^src_([a-f0-9]{64})_(0|[1-9][0-9]{0,6})$/.exec(id)
    if (!match)
      return yield* Effect.fail(
        sourceRootCompletionRefusal("Select an exact source root-completion plan identity."),
      )
    const store = yield* Store
    const receipt = yield* decodeSourceRootCompletion(
      yield* store.upstream.command(sourceRootCompletionKey(`up_${match[1]}`, Number(match[2]))),
    )
    if (receipt.plan.plan_id !== id || (hash !== undefined && receipt.plan.plan_hash !== hash))
      return yield* Effect.fail(
        sourceRootCompletionRefusal("The reviewed source root-completion plan hash changed."),
      )
    return receipt
  })
}

/** A terminal result only removes this fence. CA must still capture and prove
 * the entire current body, graph, source archive and ownership independently. */
export function assertNoPendingSourceRootCompletion(
  plan: string,
  index: number,
  page: string,
  target: string,
) {
  return Effect.gen(function* () {
    const store = yield* Store,
      key = sourceRootCompletionKey(plan, index)
    const own = yield* store.upstream.command(key)
    const claims = yield* store.upstream.sourceRootCompletionClaims(page, target)
    if (own !== undefined && !claims.some((claim) => claim.operation_id === key))
      return yield* Effect.fail(
        sourceRootCompletionRefusal(
          "The original member has a contradictory root-completion claim.",
        ),
      )
    for (const claim of claims) {
      const receipt = yield* decodeSourceRootCompletion(claim.value)
      if (
        claim.operation_id !== key ||
        receipt.plan.original_plan.plan_id !== plan ||
        receipt.plan.item_index !== index ||
        receipt.plan.input.page_id !== page ||
        receipt.plan.target_key !== target ||
        receipt.phase !== "body_verified"
      )
        return yield* Effect.fail(
          sourceRootCompletionRefusal(
            "This page or target retains a nonterminal or different root completion; reconcile that exact plan first.",
          ),
        )
    }
  })
}
