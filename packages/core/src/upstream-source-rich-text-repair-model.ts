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
import {
  sourceRichTextRepairAckMatches,
  sourceRichTextRepairObservationMatches,
} from "./source-rich-text-repair-guards.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Page = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
)
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const Kind = Schema.Literals(["literal_file_line_link", "literal_dollar_equation"])
export const SourceRichTextRepairInputSchema = Schema.Struct({
  original_plan_id: Schema.String,
  member_key: Schema.String,
  page_id: Page,
  old_operation_id: Schema.String.check(Schema.isPattern(/^p_[a-zA-Z0-9-]{1,100}$/)),
  kind: Kind,
  block_id: Page,
})
export type SourceRichTextRepairInput = typeof SourceRichTextRepairInputSchema.Type
export const SourceRichTextRepairObservationSchema = Schema.Struct({
  raw: Schema.Record(Schema.String, Schema.Unknown),
  attachments: Schema.Array(
    Schema.Struct({ index: Count, name: Schema.String, bytes: Count, sha256: Hash }),
  ),
  page_ids: Schema.Array(Page),
  graph_sha256: Hash,
})
export type SourceRichTextRepairObservation = typeof SourceRichTextRepairObservationSchema.Type
export const SourceRichTextRepairEffectSchema = Schema.Struct({
  kind: Kind,
  block_id: Page,
  ancestor_ids: Schema.Array(Page),
  source_path: Schema.String,
  source_sha256: Hash,
  source_leaf_sha256: Hash,
  source_root_index: Count,
  source_item_index: Schema.optional(Count),
  source_row_index: Schema.optional(Count),
  request: Schema.Struct({
    path: Schema.String,
    method: Schema.Literal("PATCH"),
    body: Schema.Unknown,
  }),
  before_block: Schema.Unknown,
  after_block: Schema.Unknown,
  proposed_markdown_sha256: Hash,
})
export const SourceRichTextRepairPlanSchema = Schema.Struct({
  format: Schema.Literal(1),
  domain: Schema.Literal("source_rich_text_repair"),
  plan_id: Schema.String,
  plan_hash: Hash,
  input: SourceRichTextRepairInputSchema,
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
  before: SourceRichTextRepairObservationSchema,
  before_body_verified: Schema.Literal(false),
  before_source_bytes_verified: Schema.Literal(false),
  source_installation: Schema.optional(ContentAdoptionSourceInstallationSchema),
  effect: SourceRichTextRepairEffectSchema,
})
export type SourceRichTextRepairPlan = typeof SourceRichTextRepairPlanSchema.Type
const FailureSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
})
const ResolutionSchema = Schema.Struct({
  outcome: Schema.Literals(["known_not_applied", "observed_applied"]),
  observed_at_ms: Count,
  observation: SourceRichTextRepairObservationSchema,
})
const AttemptSchema = Schema.Struct({
  index: Count,
  started_at_ms: Count,
  request: Schema.Struct({
    path: Schema.String,
    method: Schema.Literal("PATCH"),
    body: Schema.Unknown,
  }),
  before_sha256: Hash,
  outcome: Schema.Literals(["pending", "unknown", "acknowledged"]),
  response: Schema.optional(Schema.Unknown),
  untrusted_response: Schema.optional(Schema.Unknown),
  failure: Schema.optional(FailureSchema),
  resolution: Schema.optional(ResolutionSchema),
})
const ResultSchema = Schema.Struct({
  observed_at_ms: Count,
  body_verified: Schema.Literal(true),
  source_bytes_verified: Schema.Boolean,
  publication_completed: Schema.Literal(false),
  original_history_preserved: Schema.Literal(true),
  proof: ContentAdoptionEvidenceSchema,
})
/** One immutable plan, durable member claim and all attempts share one CAS row.
 * It is not a publication receipt and cannot own or commit a page marker. */
export const SourceRichTextRepairReceiptSchema = Schema.Struct({
  format: Schema.Literal(1),
  domain: Schema.Literal("source_rich_text_repair_receipt"),
  plan: SourceRichTextRepairPlanSchema,
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
export type SourceRichTextRepairReceipt = typeof SourceRichTextRepairReceiptSchema.Type
export const sourceRichTextRepairKey = (plan: string, index: number) =>
  `source-rich-text-repair:member:${plan}:${index}`
export const sourceRichTextRepairId = (plan: string, index: number) =>
  `srr_${plan.slice(3)}_${index}`
export const sourceRichTextRepairRefusal = (message: string, details?: unknown) =>
  fail("SOURCE_RICH_TEXT_REPAIR_REFUSED", message, details)
export const sourceRichTextRepairTry = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : sourceRichTextRepairRefusal("The complete source rich-text repair evidence is invalid."),
  })

export function decodeSourceRichTextRepair(value: unknown) {
  return Effect.gen(function* () {
    const receipt = yield* Schema.decodeUnknownEffect(SourceRichTextRepairReceiptSchema)(value, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(() =>
        sourceRichTextRepairRefusal(
          "The retained source rich-text repair claim is missing or invalid.",
        ),
      ),
    )
    const plan = receipt.plan,
      { plan_id: _id, plan_hash: _hash, ...body } = plan
    const original = plan.original_plan,
      selected = original.items[plan.item_index]
    if (
      plan.plan_id !== sourceRichTextRepairId(original.plan_id, plan.item_index) ||
      (yield* sha256(canonical(body))) !== plan.plan_hash ||
      !selected ||
      selected.member_key !== plan.input.member_key ||
      original.plan_id !== plan.input.original_plan_id ||
      plan.target_key !== selected.target_key ||
      plan.input.page_id !== plan.before.page_ids[0] ||
      plan.before.page_ids.length !== 1 ||
      plan.old_marker.operation_id !== plan.input.old_operation_id ||
      canonical(plan.frozen) !== canonical(selected.candidate) ||
      plan.original_operation.plan_id !== original.plan_id ||
      plan.original_operation.items[plan.item_index]?.member_key !== plan.input.member_key ||
      plan.old_marker.state !== "writing" ||
      plan.old_marker.intended_hash !== plan.intended_hash ||
      plan.effect.block_id !== plan.input.block_id ||
      plan.effect.kind !== plan.input.kind ||
      plan.effect.request.path !== `v1/blocks/${plan.input.block_id}` ||
      plan.effect.ancestor_ids[0] !== plan.input.page_id ||
      new Set(plan.effect.ancestor_ids).size !== plan.effect.ancestor_ids.length ||
      plan.effect.ancestor_ids.includes(plan.input.block_id)
    )
      return yield* Effect.fail(
        sourceRichTextRepairRefusal(
          "The immutable repair identity, source or single effect changed.",
        ),
      )
    const beforeHash = yield* sha256(canonical(plan.before))
    for (const [index, attempt] of receipt.attempts.entries()) {
      if (
        attempt.index !== index ||
        attempt.before_sha256 !== beforeHash ||
        canonical(attempt.request) !== canonical(plan.effect.request) ||
        (attempt.outcome === "pending" &&
          (attempt.response !== undefined || attempt.failure !== undefined)) ||
        (attempt.outcome === "unknown" &&
          (attempt.response !== undefined || attempt.failure === undefined)) ||
        (attempt.untrusted_response !== undefined &&
          (attempt.outcome !== "unknown" ||
            attempt.failure?.code !== "SOURCE_RICH_TEXT_REPAIR_ACK_INVALID")) ||
        (attempt.outcome === "acknowledged" &&
          (attempt.response === undefined ||
            attempt.failure !== undefined ||
            attempt.resolution !== undefined)) ||
        (attempt.outcome === "acknowledged" &&
          !sourceRichTextRepairAckMatches(plan, attempt.response)) ||
        (index < receipt.attempts.length - 1 &&
          attempt.resolution?.outcome !== "known_not_applied") ||
        (attempt.resolution &&
          (attempt.outcome === "acknowledged" ||
            !sourceRichTextRepairObservationMatches(
              plan,
              attempt.resolution.observation,
              attempt.resolution.outcome === "known_not_applied" ? "before" : "after",
            )))
      )
        return yield* Effect.fail(
          sourceRichTextRepairRefusal("The exact repair request journal changed."),
        )
    }
    const last = receipt.attempts.at(-1)
    let invalid = false
    if (receipt.phase === "planned")
      invalid =
        receipt.attempts.length !== 0 ||
        receipt.result !== undefined ||
        receipt.failure !== undefined
    else if (receipt.phase === "body_verified")
      invalid =
        !last ||
        !receipt.result ||
        receipt.failure !== undefined ||
        !(last.outcome === "acknowledged" || last.resolution?.outcome === "observed_applied") ||
        !sourceRichTextRepairObservationMatches(plan, receipt.result.proof, "after") ||
        receipt.result.source_bytes_verified !== !plan.source_installation ||
        (plan.source_installation
          ? receipt.result.proof.source_proof !== "not_installed" ||
            receipt.result.proof.files.length !== 0
          : receipt.result.proof.source_proof !== undefined)
    else if (receipt.phase === "conflict")
      invalid = !last || receipt.result !== undefined || receipt.failure === undefined
    else
      invalid =
        !last ||
        receipt.result !== undefined ||
        receipt.failure !== undefined ||
        receipt.phase !== last.outcome ||
        last.resolution !== undefined
    if (invalid)
      return yield* Effect.fail(
        sourceRichTextRepairRefusal("The repair phase contradicts its retained request outcome."),
      )
    return receipt
  })
}
export function loadSourceRichTextRepair(id: string, hash?: string) {
  return Effect.gen(function* () {
    const match = /^srr_([a-f0-9]{64})_(0|[1-9][0-9]{0,6})$/.exec(id)
    if (!match)
      return yield* Effect.fail(
        sourceRichTextRepairRefusal("Select an exact source rich-text repair plan identity."),
      )
    const store = yield* Store
    const receipt = yield* decodeSourceRichTextRepair(
      yield* store.upstream.command(sourceRichTextRepairKey(`up_${match[1]}`, Number(match[2]))),
    )
    if (receipt.plan.plan_id !== id || (hash !== undefined && receipt.plan.plan_hash !== hash))
      return yield* Effect.fail(
        sourceRichTextRepairRefusal("The reviewed source rich-text repair plan hash changed."),
      )
    return receipt
  })
}

/** Added refusal only. A terminal repair never substitutes for CA's fresh body,
 * source, ownership and graph proofs, and never claims its old publication. */
export function assertNoPendingSourceRichTextRepair(
  plan: string,
  index: number,
  page: string,
  target: string,
) {
  return Effect.gen(function* () {
    const store = yield* Store,
      key = sourceRichTextRepairKey(plan, index)
    const own = yield* store.upstream.command(key)
    const claims = yield* store.upstream.sourceRichTextRepairClaims(page, target)
    if (own !== undefined && !claims.some((claim) => claim.operation_id === key))
      return yield* Effect.fail(
        sourceRichTextRepairRefusal("The original member has a contradictory source repair claim."),
      )
    for (const claim of claims) {
      const receipt = yield* decodeSourceRichTextRepair(claim.value)
      if (
        claim.operation_id !== key ||
        receipt.plan.original_plan.plan_id !== plan ||
        receipt.plan.item_index !== index ||
        receipt.plan.input.page_id !== page ||
        receipt.plan.target_key !== target ||
        receipt.phase !== "body_verified"
      )
        return yield* Effect.fail(
          sourceRichTextRepairRefusal(
            "This page or target has a retained nonterminal or different source rich-text repair; reconcile that exact plan first.",
          ),
        )
    }
  })
}
