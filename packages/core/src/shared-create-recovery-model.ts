import {
  SharedCreateRecoveryBindingSchema,
  SharedCreateRecoveryObservationSchema,
  SharedCreateRecoveryFileSchema,
  type SharedCreateRecoveryBinding,
  type SharedCreateRecoveryObservation,
  type SharedCreateRecoveryFile,
} from "./shared-create-recovery-proof-model.ts"
export {
  SharedCreateRecoveryBindingSchema,
  SharedCreateRecoveryObservationSchema,
  SharedCreateRecoveryFileSchema,
  type SharedCreateRecoveryBinding,
  type SharedCreateRecoveryObservation,
  type SharedCreateRecoveryFile,
} from "./shared-create-recovery-proof-model.ts"
import { Effect, Schema } from "effect"
import { importDocument } from "./import.ts"
import { fail, property } from "./model.ts"
import { normalizePath, pageId } from "./ref.ts"
import { validateSharedCreatePlan, type SharedCreatePlan } from "./shared-create-model.ts"
import { FileEventSchema, normalizeObservedBody, type FileEvent } from "./shared-file-state.ts"
import { SharedLibrarySchema } from "./shared-library-model.ts"
import {
  projectSharedNotionMarkdown,
  sharedNotionMarkdownPolicy,
  sharedNotionMarkdownWire,
} from "./shared-notion-projection.ts"
import { canonicalSharedJson, validateSharedRecordEnvelope } from "./shared-records.ts"
import { sha256 } from "./store.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const invalid = (message: string) => fail("SHARED_CREATE_RECOVERY_INVALID", message)
const checked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (cause) => invalid(cause instanceof Error ? cause.message : "Invalid recovery input."),
  })
const bytes = (text: string) => new TextEncoder().encode(text).length
const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)

export const SharedCreateRecoveryReviewSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("skill_create_recovery_review"),
  review_id: Schema.String.check(Schema.isPattern(/^create-recovery-[a-f0-9]{64}$/u)),
  original_operation_id: Schema.String.check(Schema.isPattern(/^skill-create-[a-f0-9]{64}$/u)),
  original_manifest_sha256: Hash,
  original_outcome_sha256: Hash,
  library: SharedLibrarySchema,
  library_id: Identity,
  skill_id: Identity,
  skill_page_id: Schema.String,
  decision: Schema.Literal("reproject_retained_input"),
  projection_version: Schema.Literal(5),
  observation_kind: Schema.Literal("post_failure_current_read"),
  bindings: Schema.Array(SharedCreateRecoveryBindingSchema),
  files: Schema.Array(SharedCreateRecoveryFileSchema),
  observations: Schema.Array(SharedCreateRecoveryObservationSchema),
})
export type SharedCreateRecoveryReview = typeof SharedCreateRecoveryReviewSchema.Type
export interface SharedCreateRecoveryReviewInput {
  readonly originalManifestHash: string
  readonly originalOutcomeHash: string
  readonly skillPageId: string
  readonly bindings: readonly SharedCreateRecoveryBinding[]
  readonly observations: readonly SharedCreateRecoveryObservation[]
}

function eventId(originalOperationId: string, event: Omit<FileEvent, "event_id">) {
  return sha256(
    canonicalSharedJson({
      version: 1,
      original_operation_id: originalOperationId,
      projection_version: 5,
      ...event,
    }),
  ).pipe(Effect.map((hash) => `recovery-file-${hash}`))
}
function reviewId(fields: Omit<SharedCreateRecoveryReview, "review_id">) {
  return sha256(canonicalSharedJson(fields)).pipe(Effect.map((hash) => `create-recovery-${hash}`))
}
function originalPlan(input: SharedCreatePlan) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedCreatePlan(input).pipe(
      Effect.mapError((error) => invalid(error.message)),
    )
    if (
      plan.version !== 2 ||
      plan.files.length === 0 ||
      plan.files.some(
        (file) =>
          file.projection.version !== 4 ||
          file.projection.purpose !== "data_source_create" ||
          file.event.parents.length !== 0 ||
          (file.event.kind !== "projected" && file.event.kind !== "adopted"),
      )
    )
      return yield* Effect.fail(
        invalid(
          "Recovery requires an exact retained v2 migration plan with v4 creation projections and initial ownership events.",
        ),
      )
    return plan
  })
}

/** The v5 continuation changes expected native rendering while preserving every input and wire byte. */
export function makeSharedCreateRecoveryFiles(original: SharedCreatePlan) {
  return Effect.gen(function* () {
    const plan = yield* originalPlan(original)
    return yield* Effect.forEach(plan.files, (file) =>
      Effect.gen(function* () {
        const projection = yield* checked(() => {
          const authored =
            file.path === plan.entrypoint
              ? importDocument(
                  { path: file.input_path, bytes: new TextEncoder().encode(file.input.text) },
                  { name: plan.name, description: plan.description },
                ).body
              : file.input.text
          const projected = projectSharedNotionMarkdown(authored, {
            version: 5,
            purpose: "data_source_create",
          })
          if (sharedNotionMarkdownWire(projected) !== sharedNotionMarkdownWire(file.projection))
            throw invalid("Recovery cannot change the original submitted wire Markdown.")
          return projected
        })
        const hash = yield* sha256(projection.markdown)
        const content = {
          object_id: `body-${hash}`,
          sha256: hash,
          bytes: bytes(projection.markdown),
        }
        const fields =
          file.event.kind === "projected"
            ? {
                kind: "projected" as const,
                file_id: file.file_id,
                parents: [] as readonly string[],
                source_revision: file.event.source_revision,
                projection: { normalization_version: 1 as const, sha256: hash },
              }
            : {
                kind: "adopted" as const,
                file_id: file.file_id,
                parents: [] as readonly string[],
                content,
              }
        const event: FileEvent = { ...fields, event_id: yield* eventId(plan.operation_id, fields) }
        return { ...file, projection, content, event }
      }),
    )
  })
}

function observationBody(observation: SharedCreateRecoveryObservation) {
  return checked(() => {
    const response = property(JSON.parse(observation.response_json))
    if (
      !same(JSON.parse(observation.response_json), response) ||
      canonicalSharedJson(response) !== observation.response_json ||
      (response.object !== undefined && response.object !== "page_markdown") ||
      response.id !== observation.page_id ||
      typeof response.markdown !== "string" ||
      response.truncated !== false ||
      !Array.isArray(response.unknown_block_ids) ||
      response.unknown_block_ids.length !== 0 ||
      (response.warnings !== undefined &&
        (!Array.isArray(response.warnings) || response.warnings.length !== 0)) ||
      (response.has_more !== undefined && response.has_more !== false) ||
      (response.next_cursor !== undefined && response.next_cursor !== null)
    )
      throw invalid(
        "A recovery observation must retain one canonical complete current Markdown response for its exact page.",
      )
    return normalizeObservedBody(response.markdown)
  })
}

export function validateSharedCreateRecoveryReview(input: unknown, expectedReviewId?: string) {
  return Effect.gen(function* () {
    const review = yield* checked(() =>
      Schema.decodeUnknownSync(SharedCreateRecoveryReviewSchema)(input, {
        onExcessProperty: "error",
      }),
    )
    yield* checked(() => {
      if (
        review.library.library_id !== review.library_id ||
        pageId(review.skill_page_id) !== review.skill_page_id ||
        review.files.length === 0 ||
        review.bindings.length === 0 ||
        review.bindings.length > review.files.length ||
        review.observations.length !== review.bindings.length ||
        review.bindings[0]?.page_id !== review.skill_page_id ||
        new Set(review.files.map((file) => file.file_id)).size !== review.files.length ||
        new Set(review.files.map((file) => file.path)).size !== review.files.length ||
        new Set(review.bindings.map((binding) => binding.file_id)).size !==
          review.bindings.length ||
        new Set(review.bindings.map((binding) => binding.page_id)).size !==
          review.bindings.length ||
        new Set(review.bindings.map((binding) => binding.event_id)).size !==
          review.bindings.length ||
        new Set(review.observations.map((observation) => observation.file_id)).size !==
          review.observations.length
      )
        throw invalid(
          "Recovery requires one exact library, complete file inventory and unique original page bindings.",
        )
      for (const file of review.files) {
        if (
          file.path === "" ||
          file.path === "." ||
          normalizePath(file.path) !== file.path ||
          file.content.object_id !== `body-${file.content.sha256}` ||
          file.projection.version !== 5 ||
          file.projection.purpose !== "data_source_create" ||
          file.event.file_id !== file.file_id ||
          file.event.parents.length !== 0 ||
          (file.event.kind !== "projected" && file.event.kind !== "adopted") ||
          (file.event.kind === "projected" &&
            file.event.projection.sha256 !== file.content.sha256) ||
          (file.event.kind === "adopted" && !same(file.event.content, file.content))
        )
          throw invalid(
            "Recovery file content, ownership event or fixed v5 creation policy is inconsistent.",
          )
      }
      for (const binding of review.bindings) {
        const file = review.files.find((item) => item.file_id === binding.file_id)
        const observation = review.observations.find((item) => item.file_id === binding.file_id)
        if (
          !file ||
          file.path !== binding.path ||
          pageId(binding.page_id) !== binding.page_id ||
          binding.event_id === file.event.event_id ||
          !observation ||
          observation.page_id !== binding.page_id ||
          observation.body_sha256 !== file.content.sha256 ||
          observation.body_bytes !== file.content.bytes
        )
          throw invalid(
            "Each original page binding must have one exact new observation and independently identified recovery event.",
          )
      }
    })
    for (const file of review.files) {
      const { event_id: actual, ...fields } = file.event
      if (actual !== (yield* eventId(review.original_operation_id, fields)))
        return yield* Effect.fail(
          invalid("A recovery event differs from its immutable content identity."),
        )
    }
    for (const observation of review.observations) {
      const body = yield* observationBody(observation)
      if (
        (yield* sha256(observation.response_json)) !== observation.response_sha256 ||
        (yield* sha256(body)) !== observation.body_sha256 ||
        bytes(body) !== observation.body_bytes
      )
        return yield* Effect.fail(
          invalid("A captured recovery response or normalized body failed its exact checksum."),
        )
    }
    const { review_id: actual, ...fields } = review
    if (
      actual !== (yield* reviewId(fields)) ||
      (expectedReviewId !== undefined && expectedReviewId !== actual)
    )
      return yield* Effect.fail(
        invalid(
          "The recovery review differs from its complete immutable contents or selected digest.",
        ),
      )
    yield* checked(() => validateSharedRecordEnvelope(review.review_id, review))
    return review
  })
}

export function makeSharedCreateRecoveryReview(
  original: SharedCreatePlan,
  input: SharedCreateRecoveryReviewInput,
) {
  return Effect.gen(function* () {
    const plan = yield* originalPlan(original)
    const derived = yield* makeSharedCreateRecoveryFiles(plan)
    yield* checked(() => {
      const ordered = [
        ...plan.files.filter((file) => file.path === plan.entrypoint),
        ...plan.files.filter((file) => file.path !== plan.entrypoint),
      ]
      if (
        input.bindings.length === 0 ||
        input.bindings.length > ordered.length ||
        input.bindings.some((binding, index) => {
          const file = ordered[index]
          return (
            !file ||
            binding.file_id !== file.file_id ||
            binding.path !== file.path ||
            binding.event_id !== file.event.event_id
          )
        })
      )
        throw invalid(
          "The recovery must preserve the original main-first created-page prefix and historical event identities.",
        )
    })
    const fields = {
      version: 1 as const,
      kind: "skill_create_recovery_review" as const,
      original_operation_id: plan.operation_id,
      original_manifest_sha256: input.originalManifestHash,
      original_outcome_sha256: input.originalOutcomeHash,
      library: plan.library,
      library_id: plan.library.library_id,
      skill_id: plan.skill_id,
      skill_page_id: input.skillPageId,
      decision: "reproject_retained_input" as const,
      projection_version: 5 as const,
      observation_kind: "post_failure_current_read" as const,
      bindings: input.bindings,
      files: derived.map((file) => ({
        file_id: file.file_id,
        path: file.path,
        input_sha256: file.input.sha256,
        projection: sharedNotionMarkdownPolicy(file.projection),
        content: file.content,
        event: file.event,
      })),
      observations: input.observations,
    }
    return yield* validateSharedCreateRecoveryReview({
      ...fields,
      review_id: yield* reviewId(fields),
    })
  })
}
