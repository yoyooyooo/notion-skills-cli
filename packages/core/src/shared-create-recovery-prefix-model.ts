import { prefixRecoveryRequired } from "./shared-create-recovery-errors.ts"
export { prefixRecoveryRequired } from "./shared-create-recovery-errors.ts"
import { Effect, Schema } from "effect"
import { fail, property, text } from "./model.ts"
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
import { nativeFileMetadata, normalizeObservedBody } from "./shared-file-state.ts"
import { SharedLibrarySchema } from "./shared-library-model.ts"
import { sharedNotionMarkdownPolicy } from "./shared-notion-projection.ts"
import { canonicalSharedJson, validateSharedRecordEnvelope } from "./shared-records.ts"
import { sourceField } from "./shared-source-definitions.ts"
import { SourceMutationAcknowledgementSchema } from "./shared-sources-model.ts"
import { sha256 } from "./store.ts"
import {
  projectSharedRecoveryFiles,
  sharedRecoveryEventId,
} from "./shared-create-recovery-projection.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const OriginalId = Schema.String.check(Schema.isPattern(/^skill-create-[a-f0-9]{64}$/u))
const ReviewId = Schema.String.check(Schema.isPattern(/^create-recovery-[a-f0-9]{64}$/u))
const identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)

export const SharedCreatePrefixBootstrapSchema = Schema.Struct({
  kind: Schema.Literal("acknowledged_main_before_manifest"),
  original_journal_sha256: Hash,
  dispatch: Schema.Struct({
    version: Schema.Literal(1),
    operation: Schema.String.check(Schema.isPattern(/^source-op-[a-f0-9]{64}$/u)),
    identity: Schema.String,
    path: Schema.Literal("v1/pages"),
    method: Schema.Literal("POST"),
    body: Schema.Unknown,
  }),
  acknowledgement: SourceMutationAcknowledgementSchema,
})
export type SharedCreatePrefixBootstrap = typeof SharedCreatePrefixBootstrapSchema.Type

/** A new decision never relabels a missing original terminal as an observed failure. */
export const SharedCreatePrefixRecoveryReviewSchema = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literal("skill_create_recovery_review"),
  review_id: ReviewId,
  original_operation_id: OriginalId,
  original_plan_sha256: Hash,
  original_manifest_sha256: Hash,
  original_outcome_sha256: Schema.Null,
  bootstrap: SharedCreatePrefixBootstrapSchema,
  library: SharedLibrarySchema,
  library_id: identity,
  skill_id: identity,
  skill_page_id: Schema.String,
  decision: Schema.Literal("reproject_retained_input"),
  projection_version: Schema.Literal(9),
  observation_kind: Schema.Literal("post_failure_current_read"),
  bindings: Schema.Array(SharedCreateRecoveryBindingSchema),
  files: Schema.Array(SharedCreateRecoveryFileSchema),
  observations: Schema.Array(SharedCreateRecoveryObservationSchema),
})
export type SharedCreatePrefixRecoveryReview = typeof SharedCreatePrefixRecoveryReviewSchema.Type

export const SharedCreatePrefixRecoveryOutcomeSchema = Schema.Struct({
  version: Schema.Literal(3),
  kind: Schema.Literal("skill_create_recovery_outcome"),
  status: Schema.Literal("applied"),
  original_operation_id: OriginalId,
  original_manifest_sha256: Hash,
  original_plan_sha256: Hash,
  original_outcome_sha256: Schema.Null,
  bootstrap_sha256: Hash,
  recovery_id: ReviewId,
  skill_id: identity,
  skill_page_id: Schema.String,
  review_record_hash: Hash,
  bindings: Schema.Array(SharedCreateRecoveryBindingSchema),
})
export type SharedCreatePrefixRecoveryOutcome = typeof SharedCreatePrefixRecoveryOutcomeSchema.Type

export function prefixRecoveryPlan(input: unknown) {
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
          file.projection.version !== 8 ||
          file.projection.purpose !== "data_source_create" ||
          file.event.kind !== "projected" ||
          file.event.parents.length !== 0 ||
          file.ancestors !== undefined ||
          file.baseline_body !== undefined,
      )
    )
      return yield* Effect.fail(
        prefixRecoveryRequired(
          "This prefix recovery requires the exact original v1 fixed Git Skill admission with v8 native projections and no local overrides.",
        ),
      )
    return { ...plan, source_projection: plan.source_projection }
  })
}

function eventId(original: string, fields: unknown) {
  return sharedRecoveryEventId(original, fields, 9)
}

/** The historical v8 to v9 decision remains fixed even when new creation advances. */
export function makeSharedCreatePrefixRecoveryFiles(input: unknown) {
  return prefixRecoveryPlan(input).pipe(
    Effect.flatMap((plan) => projectSharedRecoveryFiles(plan, 9)),
  )
}

export function observeSharedCreatePrefixBody(fileId: string, page: string, raw: unknown) {
  return Effect.gen(function* () {
    const body = yield* createChecked(() => {
      const value = property(raw)
      if (
        (value.object !== undefined && value.object !== "page_markdown") ||
        value.id !== page ||
        typeof value.markdown !== "string" ||
        value.truncated !== false ||
        !Array.isArray(value.unknown_block_ids) ||
        value.unknown_block_ids.length !== 0 ||
        (value.warnings !== undefined &&
          (!Array.isArray(value.warnings) || value.warnings.length !== 0)) ||
        (value.has_more !== undefined && value.has_more !== false) ||
        (value.next_cursor !== undefined && value.next_cursor !== null)
      )
        throw fail(
          "BODY_INCOMPLETE",
          "Recovery requires the complete exact current Markdown response.",
        )
      return normalizeObservedBody(value.markdown)
    })
    const response = canonicalSharedJson(raw)
    return {
      file_id: fileId,
      page_id: page,
      response_json: response,
      response_sha256: yield* sha256(response),
      body_sha256: yield* sha256(body),
      body_bytes: new TextEncoder().encode(body).length,
    }
  })
}

function acknowledgedPropertyValue(input: unknown) {
  const value = property(input)
  if (value.has_more === true)
    throw prefixRecoveryRequired("The original ACK contains an incomplete requested property.")
  if (Array.isArray(value.rich_text)) return { type: "rich_text", value: text(value.rich_text) }
  if (Array.isArray(value.title)) return { type: "title", value: text(value.title) }
  if (typeof value.checkbox === "boolean") return { type: "checkbox", value: value.checkbox }
  if (typeof property(value.select).name === "string")
    return { type: "select", value: property(value.select).name }
  if (Array.isArray(value.relation)) {
    const ids = value.relation.map((item) => {
      const id = property(item).id
      const canonical = typeof id === "string" ? pageId(id) : undefined
      if (!canonical)
        throw prefixRecoveryRequired("The original ACK has an invalid requested relation.")
      return canonical
    })
    return { type: "relation", value: ids.sort() }
  }
  throw prefixRecoveryRequired("The original ACK cannot prove a requested native property.")
}

/** Compare only declared create properties, using registered IDs and native values.
 * Generated response fields and visible property names are not request identity. */
export function assertSharedCreateAcknowledgedMetadata(body: unknown, response: unknown): void {
  const requested = property(property(body).properties)
  if (Object.keys(requested).length === 0)
    throw prefixRecoveryRequired("The original request has no frozen native properties.")
  for (const [id, value] of Object.entries(requested)) {
    const actual = sourceField(property(response), id)
    if (!same(acknowledgedPropertyValue(value), acknowledgedPropertyValue(actual)))
      throw prefixRecoveryRequired(
        "The original ACK metadata differs from a declared request property.",
      )
  }
}

export function validateSharedCreatePrefixRecoveryReview(input: unknown, expectedId?: string) {
  return Effect.gen(function* () {
    const review = yield* createChecked(() =>
      Schema.decodeUnknownSync(SharedCreatePrefixRecoveryReviewSchema)(input, {
        onExcessProperty: "error",
      }),
    )
    const bootstrap = review.bootstrap,
      dispatch = bootstrap.dispatch,
      ack = bootstrap.acknowledgement
    const { version: _version, operation: _operation, ...request } = dispatch
    if (
      dispatch.identity !==
        review.original_operation_id +
          ":" +
          (yield* sha256(canonicalSharedJson([dispatch.path, dispatch.method, dispatch.body]))) ||
      dispatch.operation !== "source-op-" + (yield* sha256(canonicalSharedJson(request))) ||
      ack.operation_id !== dispatch.operation ||
      ack.request_hash !== (yield* sha256(canonicalSharedJson(dispatch))) ||
      ack.response_hash !== (yield* sha256(canonicalSharedJson(ack.response))) ||
      !Number.isSafeInteger(ack.acknowledged_at) ||
      ack.acknowledged_at < 0 ||
      property(ack.response).object !== "page" ||
      property(ack.response).id !== review.skill_page_id ||
      property(ack.response).archived === true ||
      property(ack.response).in_trash === true ||
      property(property(ack.response).parent).data_source_id !==
        review.library.skills.data_source_id ||
      pageId(review.skill_page_id) !== review.skill_page_id ||
      review.library_id !== review.library.library_id ||
      review.bindings.length !== 1 ||
      review.bindings[0]?.page_id !== review.skill_page_id ||
      review.observations.length !== 1 ||
      review.files.length === 0 ||
      new Set(review.files.map((file) => file.file_id)).size !== review.files.length ||
      new Set(review.files.map((file) => file.path)).size !== review.files.length
    )
      return yield* Effect.fail(
        prefixRecoveryRequired(
          "The bootstrap does not prove one exact acknowledged original main allocation.",
        ),
      )
    yield* createChecked(() => assertSharedCreateAcknowledgedMetadata(dispatch.body, ack.response))
    for (const file of review.files) {
      if (
        file.projection.version !== 9 ||
        file.projection.purpose !== "data_source_create" ||
        file.event.kind !== "projected" ||
        file.event.file_id !== file.file_id ||
        file.event.parents.length !== 0 ||
        file.event.projection.sha256 !== file.content.sha256 ||
        file.content.object_id !== "body-" + file.content.sha256 ||
        !same(nativeFileMetadata(file.event), nativeFileMetadata(file.content))
      )
        return yield* Effect.fail(
          prefixRecoveryRequired(
            "Recovery files must retain exact projected identity, content and metadata.",
          ),
        )
      const { event_id, ...fields } = file.event
      if (event_id !== (yield* eventId(review.original_operation_id, fields)))
        return yield* Effect.fail(
          prefixRecoveryRequired("A recovery event has another immutable identity."),
        )
    }
    const binding = review.bindings[0]!,
      observation = review.observations[0]!
    const file = review.files.find((item) => item.file_id === binding.file_id)
    if (
      !file ||
      binding.path !== file.path ||
      binding.event_id === file.event.event_id ||
      observation.file_id !== binding.file_id ||
      observation.page_id !== binding.page_id ||
      observation.body_sha256 !== file.content.sha256 ||
      observation.body_bytes !== file.content.bytes
    )
      return yield* Effect.fail(
        prefixRecoveryRequired("The original main binding and complete later observation differ."),
      )
    const rebuilt = yield* observeSharedCreatePrefixBody(
      binding.file_id,
      binding.page_id,
      yield* createChecked(() => JSON.parse(observation.response_json) as unknown),
    )
    if (!same(rebuilt, observation))
      return yield* Effect.fail(
        prefixRecoveryRequired(
          "The current observation failed its complete response and body checksums.",
        ),
      )
    const { review_id, ...fields } = review
    if (
      review_id !== "create-recovery-" + (yield* sha256(canonicalSharedJson(fields))) ||
      (expectedId !== undefined && expectedId !== review_id)
    )
      return yield* Effect.fail(
        prefixRecoveryRequired("The saved recovery decision differs from its selected digest."),
      )
    yield* createChecked(() => validateSharedRecordEnvelope(review.review_id, review, "operation"))
    return review
  })
}

export function makeSharedCreatePrefixRecoveryReview(input: {
  readonly plan: unknown
  readonly bootstrap: SharedCreatePrefixBootstrap
  readonly skillPageId: string
  readonly bindings: readonly SharedCreateRecoveryBinding[]
  readonly observations: readonly SharedCreateRecoveryObservation[]
}) {
  return Effect.gen(function* () {
    const plan = yield* prefixRecoveryPlan(input.plan)
    const files = yield* makeSharedCreatePrefixRecoveryFiles(plan)
    const main = plan.files.find((file) => file.path === plan.entrypoint)!
    const recoveredMain = files.find((file) => file.file_id === main.file_id)!
    if (main.content.sha256 === recoveredMain.content.sha256)
      return yield* Effect.fail(
        prefixRecoveryRequired(
          "This recovery requires the independently predicted main-body spacing difference; unchanged projections keep their original reconciliation path.",
        ),
      )
    if (
      input.bindings.length !== 1 ||
      !same(input.bindings[0], {
        file_id: main.file_id,
        path: main.path,
        page_id: input.skillPageId,
        event_id: main.event.event_id,
      })
    )
      return yield* Effect.fail(
        prefixRecoveryRequired("Recovery must preserve the original exact main-first prefix."),
      )
    const fields = {
      version: 2 as const,
      kind: "skill_create_recovery_review" as const,
      original_operation_id: plan.operation_id,
      original_plan_sha256: yield* sha256(canonicalSharedJson(plan)),
      original_manifest_sha256: yield* sharedCreateManifestRecordHash(plan),
      original_outcome_sha256: null,
      bootstrap: input.bootstrap,
      library: plan.library,
      library_id: plan.library.library_id,
      skill_id: plan.skill_id,
      skill_page_id: input.skillPageId,
      decision: "reproject_retained_input" as const,
      projection_version: 9 as const,
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
    return yield* validateSharedCreatePrefixRecoveryReview({
      ...fields,
      review_id: "create-recovery-" + (yield* sha256(canonicalSharedJson(fields))),
    })
  })
}
