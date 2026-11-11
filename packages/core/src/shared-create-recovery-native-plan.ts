import { Effect, Schema } from "effect"
import { pageId } from "./ref.ts"
import { createChecked, validateSharedCreatePlan } from "./shared-create-model.ts"
import { sharedCreateManifestRecordHash } from "./shared-create-outcome.ts"
import { prefixRecoveryRequired } from "./shared-create-recovery-errors.ts"
import {
  SharedCreateNativeRecoveryReviewSchema,
  type SharedCreateNativeRecoveryReview,
} from "./shared-create-recovery-native-model.ts"
import { nativeFileMetadata } from "./shared-file-state.ts"
import {
  projectSharedNotionMarkdown,
  sharedNotionMarkdownPolicy,
  sharedNotionMarkdownWire,
} from "./shared-notion-projection.ts"
import { canonicalSharedJson, validateSharedRecordEnvelope } from "./shared-records.ts"
import { sha256 } from "./store.ts"

const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const refusal = (message: string) => Effect.fail(prefixRecoveryRequired(message))
export function nativeMainRecoveryPlan(input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedCreatePlan(input)
    const file = plan.files[0]
    if (
      plan.version !== 1 ||
      plan.content_kind !== "skill" ||
      plan.complete_resources !== 1 ||
      plan.source_projection !== undefined ||
      (plan.resources?.length ?? 0) !== 0 ||
      plan.members.length !== 0 ||
      (plan.requires?.length ?? 0) !== 0 ||
      plan.enabled !== false ||
      plan.default_context !== false ||
      plan.files.length !== 1 ||
      file === undefined ||
      file.path !== plan.entrypoint ||
      file.projection.version !== 11 ||
      file.projection.purpose !== "data_source_create" ||
      file.event.kind !== "adopted" ||
      file.event.parents.length !== 0 ||
      file.ancestors !== undefined ||
      file.baseline_body !== undefined
    )
      return yield* refusal(
        "Native recovery requires the unchanged disabled complete one-main v1 creation with an initial adopted v11 body and no Source, resources or relations.",
      )
    return plan
  })
}

export function makeSharedCreateNativeRecoveryFile(input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* nativeMainRecoveryPlan(input),
      file = plan.files[0]!
    const projection = yield* createChecked(() => {
      const next = projectSharedNotionMarkdown(file.projection.input_markdown, {
        version: 12,
        purpose: "data_source_create",
      })
      if (sharedNotionMarkdownWire(next) !== sharedNotionMarkdownWire(file.projection))
        throw prefixRecoveryRequired(
          "Native recovery cannot change any originally submitted wire byte.",
        )
      return next
    })
    const digest = yield* sha256(projection.markdown)
    if (digest === file.content.sha256)
      return yield* refusal(
        "Native recovery requires an independently changed fixed v12 prediction.",
      )
    const content = {
      object_id: "body-" + digest,
      sha256: digest,
      bytes: new TextEncoder().encode(projection.markdown).length,
      ...nativeFileMetadata(file.content),
    }
    const fields = {
      kind: "adopted" as const,
      file_id: file.file_id,
      parents: [] as readonly string[],
      content,
    }
    const event = {
      ...fields,
      event_id:
        "recovery-file-" +
        (yield* sha256(
          canonicalSharedJson({
            version: 5,
            original_operation_id: plan.operation_id,
            projection_version: 12,
            event: fields,
          }),
        )),
    }
    return { ...file, projection, content, event }
  })
}

export function validateSharedCreateNativeRecoveryReview(input: unknown, expectedId?: string) {
  return Effect.gen(function* () {
    const review = yield* createChecked(() =>
      Schema.decodeUnknownSync(SharedCreateNativeRecoveryReviewSchema)(input, {
        onExcessProperty: "error",
      }),
    )
    const binding = review.bindings[0],
      file = review.files[0],
      allocation = review.bootstrap.allocations[0],
      observation = review.observations[0]
    if (
      pageId(review.skill_page_id) !== review.skill_page_id ||
      review.library_id !== review.library.library_id ||
      review.bindings.length !== 1 ||
      review.files.length !== 1 ||
      review.bootstrap.allocations.length !== 1 ||
      review.observations.length !== 1 ||
      binding === undefined ||
      file === undefined ||
      allocation === undefined ||
      observation === undefined ||
      binding.page_id !== review.skill_page_id ||
      binding.file_id !== file.file_id ||
      binding.path !== file.path ||
      binding.event_id === file.event.event_id ||
      allocation.file_id !== binding.file_id ||
      allocation.page_id !== binding.page_id ||
      allocation.allocation_operation_id !== review.original_operation_id ||
      file.projection.version !== 12 ||
      file.projection.purpose !== "data_source_create" ||
      file.event.kind !== "adopted" ||
      file.event.parents.length !== 0 ||
      file.event.file_id !== file.file_id ||
      !same(file.event.content, file.content) ||
      file.content.object_id !== "body-" + file.content.sha256 ||
      observation.file_id !== binding.file_id ||
      observation.page_id !== binding.page_id ||
      observation.body_sha256 !== file.content.sha256 ||
      observation.body_bytes !== file.content.bytes
    )
      return yield* refusal(
        "The native recovery does not bind its complete sole main, original ACK and fixed adopted prediction.",
      )
    const { event_id, ...event } = file.event
    if (
      event_id !==
      "recovery-file-" +
        (yield* sha256(
          canonicalSharedJson({
            version: 5,
            original_operation_id: review.original_operation_id,
            projection_version: 12,
            event,
          }),
        ))
    )
      return yield* refusal("The native recovery event has another immutable identity.")
    const { review_id, ...fields } = review
    if (
      review_id !== "create-recovery-" + (yield* sha256(canonicalSharedJson(fields))) ||
      (expectedId !== undefined && review_id !== expectedId)
    )
      return yield* refusal("The exact inspected native recovery digest differs.")
    yield* createChecked(() => validateSharedRecordEnvelope(review.review_id, review, "operation"))
    return review
  })
}

export function makeSharedCreateNativeRecoveryReview(input: {
  readonly plan: unknown
  readonly page: string
  readonly origin: SharedCreateNativeRecoveryReview["origin"]
  readonly bootstrap: SharedCreateNativeRecoveryReview["bootstrap"]
  readonly observations: SharedCreateNativeRecoveryReview["observations"]
}) {
  return Effect.gen(function* () {
    const plan = yield* nativeMainRecoveryPlan(input.plan),
      old = plan.files[0]!
    const file = yield* makeSharedCreateNativeRecoveryFile(plan)
    const fields = {
      version: 5 as const,
      kind: "skill_create_recovery_review" as const,
      original_operation_id: plan.operation_id,
      original_plan_sha256: yield* sha256(canonicalSharedJson(plan)),
      original_manifest_sha256: yield* sharedCreateManifestRecordHash(plan),
      original_outcome_sha256: null,
      library: plan.library,
      library_id: plan.library.library_id,
      skill_id: plan.skill_id,
      skill_page_id: input.page,
      decision: "reproject_retained_input" as const,
      projection_version: 12 as const,
      observation_kind: "post_failure_current_read" as const,
      origin: input.origin,
      bootstrap: input.bootstrap,
      bindings: [
        { file_id: old.file_id, path: old.path, page_id: input.page, event_id: old.event.event_id },
      ],
      files: [
        {
          file_id: file.file_id,
          path: file.path,
          input_sha256: file.input.sha256,
          projection: sharedNotionMarkdownPolicy(file.projection),
          content: file.content,
          event: file.event,
        },
      ],
      observations: input.observations,
    }
    return yield* validateSharedCreateNativeRecoveryReview({
      ...fields,
      review_id: "create-recovery-" + (yield* sha256(canonicalSharedJson(fields))),
    })
  })
}
