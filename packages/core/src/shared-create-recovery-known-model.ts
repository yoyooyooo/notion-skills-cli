import { Effect, Schema } from "effect"
import { property, text } from "./model.ts"
import { pageId } from "./ref.ts"
import { createChecked, validateSharedCreatePlan } from "./shared-create-model.ts"
import { sharedCreateManifestRecordHash } from "./shared-create-outcome.ts"
import {
  SharedCreateRecoveryBindingSchema,
  SharedCreateRecoveryFileSchema,
  SharedCreateRecoveryObservationSchema,
  type SharedCreateRecoveryBinding,
  type SharedCreateRecoveryObservation,
} from "./shared-create-recovery-proof-model.ts"
import { prefixRecoveryRequired } from "./shared-create-recovery-errors.ts"
import {
  projectSharedRecoveryFiles,
  sharedRecoveryEventId,
} from "./shared-create-recovery-projection.ts"
import { nativeFileMetadata } from "./shared-file-state.ts"
import { SharedLibrarySchema } from "./shared-library-model.ts"
import { sharedNotionMarkdownPolicy } from "./shared-notion-projection.ts"
import { canonicalSharedJson, validateSharedRecordEnvelope } from "./shared-records.ts"
import { sourceField } from "./shared-source-definitions.ts"
import { SourceMutationAcknowledgementSchema } from "./shared-sources-model.ts"
import { sha256 } from "./store.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const OriginalId = Schema.String.check(Schema.isPattern(/^skill-create-[a-f0-9]{64}$/u))
const ReviewId = Schema.String.check(Schema.isPattern(/^create-recovery-[a-f0-9]{64}$/u))
const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const refusal = (message: string) => Effect.fail(prefixRecoveryRequired(message))

/** Request bodies are derived from the full original plan, never copied into this proof. */
export const SharedCreateKnownBootstrapSchema = Schema.Struct({
  kind: Schema.Literals(["known_needs_review", "acknowledged_main_before_manifest"]),
  original_journal_sha256: Hash,
  original_dispatches_sha256: Hash,
  allocations: Schema.Array(
    Schema.Struct({
      file_id: Identity,
      acknowledgement: SourceMutationAcknowledgementSchema,
    }),
  ),
})
export type SharedCreateKnownBootstrap = typeof SharedCreateKnownBootstrapSchema.Type

/** The full v2 response is checked before this bounded statement is made.
 * The original input and fixed policy reconstruct all bytes; apply reads them again. */
export const SharedCreateKnownRecoveryObservationSchema = Schema.Struct({
  file_id: Identity,
  page_id: Schema.String,
  format: Schema.Literal("notion_markdown_v2"),
  normalization_version: Schema.Literal(1),
  response_sha256: Hash,
  body_sha256: Hash,
  body_bytes: SharedCreateRecoveryObservationSchema.fields.body_bytes,
  truncated: Schema.Literal(false),
  unknown_block_count: Schema.Literal(0),
  warning_count: Schema.Literal(0),
  has_more: Schema.Literal(false),
  next_cursor: Schema.Null,
})
export type SharedCreateKnownRecoveryObservation =
  typeof SharedCreateKnownRecoveryObservationSchema.Type
export function compactSharedCreateRecoveryObservation(
  observed: SharedCreateRecoveryObservation,
): SharedCreateKnownRecoveryObservation {
  return {
    file_id: observed.file_id,
    page_id: observed.page_id,
    format: "notion_markdown_v2",
    normalization_version: 1,
    response_sha256: observed.response_sha256,
    body_sha256: observed.body_sha256,
    body_bytes: observed.body_bytes,
    truncated: false,
    unknown_block_count: 0,
    warning_count: 0,
    has_more: false,
    next_cursor: null,
  }
}

export const SharedCreateKnownRecoveryReviewSchema = Schema.Struct({
  version: Schema.Literal(3),
  kind: Schema.Literal("skill_create_recovery_review"),
  review_id: ReviewId,
  original_operation_id: OriginalId,
  original_plan_sha256: Hash,
  original_manifest_sha256: Hash,
  original_outcome_sha256: Schema.Union([Hash, Schema.Null]),
  bootstrap: SharedCreateKnownBootstrapSchema,
  library: SharedLibrarySchema,
  library_id: Identity,
  skill_id: Identity,
  skill_page_id: Schema.String,
  decision: Schema.Literal("reproject_retained_input"),
  projection_version: Schema.Literal(10),
  observation_kind: Schema.Literal("post_failure_current_read"),
  bindings: Schema.Array(SharedCreateRecoveryBindingSchema),
  files: Schema.Array(SharedCreateRecoveryFileSchema),
  observations: Schema.Array(SharedCreateKnownRecoveryObservationSchema),
})
export type SharedCreateKnownRecoveryReview = typeof SharedCreateKnownRecoveryReviewSchema.Type
export const SharedCreateKnownRecoveryOutcomeSchema = Schema.Struct({
  version: Schema.Literal(4),
  kind: Schema.Literal("skill_create_recovery_outcome"),
  status: Schema.Literal("applied"),
  original_operation_id: OriginalId,
  original_manifest_sha256: Hash,
  original_plan_sha256: Hash,
  original_outcome_sha256: Schema.Union([Hash, Schema.Null]),
  bootstrap_sha256: Hash,
  recovery_id: ReviewId,
  skill_id: Identity,
  skill_page_id: Schema.String,
  review_record_hash: Hash,
  bindings: Schema.Array(SharedCreateRecoveryBindingSchema),
})
export type SharedCreateKnownRecoveryOutcome = typeof SharedCreateKnownRecoveryOutcomeSchema.Type

export function knownRecoveryPlan(input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedCreatePlan(input)
    if (
      plan.version !== 1 ||
      plan.content_kind !== "skill" ||
      plan.source_projection?.version !== 1 ||
      plan.source_projection.local !== undefined ||
      plan.complete_resources !== undefined ||
      (plan.resources?.length ?? 0) !== 0 ||
      plan.members.length !== 0 ||
      (plan.requires?.length ?? 0) !== 0 ||
      plan.files.length === 0 ||
      plan.files.some(
        (file) =>
          file.projection.version !== 9 ||
          file.projection.purpose !== "data_source_create" ||
          file.event.kind !== "projected" ||
          file.event.parents.length !== 0 ||
          file.ancestors !== undefined ||
          file.baseline_body !== undefined,
      )
    )
      return yield* refusal(
        "This recovery requires the exact original v1 fixed Git Skill admission with v9 projections and no local overrides.",
      )
    return { ...plan, source_projection: plan.source_projection }
  })
}
export function makeSharedCreateKnownRecoveryFiles(input: unknown) {
  return knownRecoveryPlan(input).pipe(
    Effect.flatMap((plan) => projectSharedRecoveryFiles(plan, 10)),
  )
}

/** Validate immutable proof structure without reading mutable current pages. */
export function validateSharedCreateKnownRecoveryReview(input: unknown, expectedId?: string) {
  return Effect.gen(function* () {
    const review = yield* createChecked(() =>
      Schema.decodeUnknownSync(SharedCreateKnownRecoveryReviewSchema)(input, {
        onExcessProperty: "error",
      }),
    )
    const count = review.bindings.length
    if (
      pageId(review.skill_page_id) !== review.skill_page_id ||
      review.library_id !== review.library.library_id ||
      count === 0 ||
      count > review.files.length ||
      review.bootstrap.allocations.length !== count ||
      review.observations.length !== count ||
      review.bindings[0]?.page_id !== review.skill_page_id ||
      new Set(review.bindings.map((binding) => binding.page_id)).size !== count ||
      new Set(review.bindings.map((binding) => binding.file_id)).size !== count ||
      new Set(review.bootstrap.allocations.map((item) => item.acknowledgement.operation_id))
        .size !== count ||
      new Set(review.files.map((file) => file.file_id)).size !== review.files.length ||
      new Set(review.files.map((file) => file.path)).size !== review.files.length ||
      (review.bootstrap.kind === "acknowledged_main_before_manifest"
        ? count !== 1 || review.original_outcome_sha256 !== null
        : review.original_outcome_sha256 === null)
    )
      return yield* refusal(
        "The recovery does not distinguish the exact acknowledged prefix from its original terminal state.",
      )
    for (const file of review.files) {
      if (
        file.projection.version !== 10 ||
        file.projection.purpose !== "data_source_create" ||
        file.event.kind !== "projected" ||
        file.event.file_id !== file.file_id ||
        file.event.parents.length !== 0 ||
        file.event.projection.sha256 !== file.content.sha256 ||
        file.content.object_id !== "body-" + file.content.sha256 ||
        !same(nativeFileMetadata(file.event), nativeFileMetadata(file.content))
      )
        return yield* refusal(
          "Recovery files must preserve exact initial ownership and native metadata.",
        )
      const { event_id, ...fields } = file.event
      if (event_id !== (yield* sharedRecoveryEventId(review.original_operation_id, fields, 10)))
        return yield* refusal("A recovered ownership event has another immutable identity.")
    }
    const ordered = [
      ...review.files.filter((file) => file.file_id === review.bindings[0]!.file_id),
      ...review.files.filter((file) => file.file_id !== review.bindings[0]!.file_id),
    ]
    for (let index = 0; index < count; index++) {
      const binding = review.bindings[index]!,
        allocation = review.bootstrap.allocations[index]!,
        observation = review.observations[index]!,
        file = ordered[index]!
      const ack = allocation.acknowledgement,
        response = property(ack.response)
      if (
        pageId(binding.page_id) !== binding.page_id ||
        binding.file_id !== file.file_id ||
        binding.path !== file.path ||
        allocation.file_id !== file.file_id ||
        binding.event_id === file.event.event_id ||
        response.object !== "page" ||
        response.id !== binding.page_id ||
        response.in_trash === true ||
        response.archived === true ||
        response.is_archived === true ||
        property(response.parent).data_source_id !==
          (index === 0
            ? review.library.skills.data_source_id
            : review.library.files.data_source_id) ||
        ack.response_hash !== (yield* sha256(canonicalSharedJson(ack.response))) ||
        !Number.isSafeInteger(ack.acknowledged_at) ||
        ack.acknowledged_at < 0 ||
        observation.file_id !== binding.file_id ||
        observation.page_id !== binding.page_id ||
        observation.body_sha256 !== file.content.sha256 ||
        observation.body_bytes !== file.content.bytes
      )
        return yield* refusal(
          "The recovery prefix does not bind exact original ACK pages and complete observations in original file order.",
        )
      const ids =
        index === 0 ? review.library.skills.property_ids : review.library.files.property_ids
      if (
        text(sourceField(response, ids[index === 0 ? "Main File ID" : "File ID"]!).rich_text) !==
        file.file_id
      )
        return yield* refusal("An original ACK has another stable File identity.")
      if (index === 0) {
        if (
          text(sourceField(response, ids["Skill ID"]!).rich_text) !== review.skill_id ||
          sourceField(response, ids.Enabled!).checkbox !== false
        )
          return yield* refusal(
            "The original main ACK does not identify the disabled original Skill.",
          )
      } else {
        const owner = sourceField(response, ids.Skill!),
          relation = owner.relation
        if (
          text(sourceField(response, ids.Path!).rich_text) !== file.path ||
          owner.has_more === true ||
          !Array.isArray(relation) ||
          relation.length !== 1 ||
          property(relation[0]).id !== review.skill_page_id
        )
          return yield* refusal("An original reference ACK has another path or owner.")
      }
    }
    const { review_id, ...fields } = review
    if (
      review_id !== "create-recovery-" + (yield* sha256(canonicalSharedJson(fields))) ||
      (expectedId !== undefined && expectedId !== review_id)
    )
      return yield* refusal("The complete recovery review does not match its inspected digest.")
    yield* createChecked(() => validateSharedRecordEnvelope(review.review_id, review, "operation"))
    return review
  })
}

export function makeSharedCreateKnownRecoveryReview(input: {
  readonly plan: unknown
  readonly bootstrap: SharedCreateKnownBootstrap
  readonly originalOutcomeHash: string | null
  readonly skillPageId: string
  readonly bindings: readonly SharedCreateRecoveryBinding[]
  readonly observations: readonly SharedCreateKnownRecoveryObservation[]
}) {
  return Effect.gen(function* () {
    const plan = yield* knownRecoveryPlan(input.plan),
      files = yield* makeSharedCreateKnownRecoveryFiles(plan)
    if (
      !input.bindings.some(
        (binding) =>
          files.find((file) => file.file_id === binding.file_id)?.content.sha256 !==
          plan.files.find((file) => file.file_id === binding.file_id)?.content.sha256,
      )
    )
      return yield* refusal(
        "This projection recovery needs an independently changed original native prediction.",
      )
    const fields = {
      version: 3 as const,
      kind: "skill_create_recovery_review" as const,
      original_operation_id: plan.operation_id,
      original_plan_sha256: yield* sha256(canonicalSharedJson(plan)),
      original_manifest_sha256: yield* sharedCreateManifestRecordHash(plan),
      original_outcome_sha256: input.originalOutcomeHash,
      bootstrap: input.bootstrap,
      library: plan.library,
      library_id: plan.library.library_id,
      skill_id: plan.skill_id,
      skill_page_id: input.skillPageId,
      decision: "reproject_retained_input" as const,
      projection_version: 10 as const,
      observation_kind: "post_failure_current_read" as const,
      bindings: input.bindings,
      files: files.map((file) => ({
        file_id: file.file_id,
        path: file.path,
        input_sha256: file.input.sha256,
        projection: sharedNotionMarkdownPolicy(file.projection),
        content: file.content,
        event: file.event,
      })),
      observations: input.observations,
    }
    return yield* validateSharedCreateKnownRecoveryReview({
      ...fields,
      review_id: "create-recovery-" + (yield* sha256(canonicalSharedJson(fields))),
    })
  })
}
