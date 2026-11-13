import { Effect, Schema } from "effect"
import { fail, SkillsError, validateDescription, validateDisplayName } from "./model.ts"
import { pageId } from "./ref.ts"
import { SharedLibrarySchema, type SharedLibrary } from "./shared-library-model.ts"
import {
  makeSharedObservationPlan,
  SharedObservationPlanSchema,
  validateSharedObservationPlan,
  type FrozenObservationBody,
} from "./shared-observation-operation.ts"
import { nativeObservedObjectIdentity } from "./shared-native-body-completion.ts"
import { canonicalSharedJson, validateSharedRecordEnvelope } from "./shared-records.ts"
import { sha256 } from "./store.ts"

const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
export const NativeAdoptionMetadataSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  default_context: Schema.Boolean,
})
export type NativeAdoptionMetadata = typeof NativeAdoptionMetadataSchema.Type
export const SharedNativeAdoptionPlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("native_adoption"),
  operation_id: Schema.String.check(Schema.isPattern(/^skill-adopt-[a-f0-9]{64}$/u)),
  library: SharedLibrarySchema,
  library_id: Identity,
  skill_id: Identity,
  skill_page_id: Schema.String,
  file_id: Identity,
  metadata: NativeAdoptionMetadataSchema,
  observation: SharedObservationPlanSchema,
})
export type SharedNativeAdoptionPlan = typeof SharedNativeAdoptionPlanSchema.Type
export const nativeAdoptionEntity = "native-adoptions-v1"
export const nativeAdoptionOutcomeId = (operation: string) => `outcome-${operation}`
export const nativeAdoptionProtection = {
  original_page_preserved: true,
  body_writes: false,
  enabled_preserved: true,
  enabled: false,
  automatic_retry: false,
  metadata_compare_and_swap: false,
} as const

export function adoptionChecked<A>(action: () => A) {
  return Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_ADOPTION_INVALID", "Invalid native page adoption input or retained facts."),
  })
}

/** File identity is the skill plus the canonical path. It does not rotate when the body changes. */
export function nativeFileIdentity(skillId: string, path: string) {
  return sha256(canonicalSharedJson([skillId, path])).pipe(Effect.map((digest) => `file-${digest}`))
}

/** The existing physical page anchors identity; later body or title edits cannot rotate it. */
export function nativeAdoptionIdentity(libraryId: string, selected: string) {
  return Effect.gen(function* () {
    const skill_id = `skill-${yield* sha256(canonicalSharedJson([1, "native-page", libraryId, selected]))}`
    const file_id = yield* nativeFileIdentity(skill_id, "SKILL.md")
    return { skill_id, file_id }
  })
}

export function validateSharedNativeAdoptionPlan(input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* adoptionChecked(() =>
      Schema.decodeUnknownSync(SharedNativeAdoptionPlanSchema)(input, {
        onExcessProperty: "error",
      }),
    )
    const identity = yield* nativeAdoptionIdentity(plan.library_id, plan.skill_page_id)
    const observation = yield* validateSharedObservationPlan(plan.observation)
    yield* adoptionChecked(() => {
      if (
        pageId(plan.skill_page_id) !== plan.skill_page_id ||
        plan.library_id !== plan.library.library_id ||
        plan.skill_id !== identity.skill_id ||
        plan.file_id !== identity.file_id ||
        observation.skill_page_id !== plan.skill_page_id ||
        observation.page_id !== plan.skill_page_id ||
        observation.file_id !== plan.file_id ||
        observation.event.parents.length !== 0 ||
        validateDisplayName(plan.metadata.name) !== plan.metadata.name ||
        validateDescription(plan.metadata.description) !== plan.metadata.description
      )
        throw fail(
          "SHARED_ADOPTION_INVALID",
          "The original page, identities and initial observation do not describe one native draft.",
        )
    })
    const { operation_id, ...description } = plan
    if (operation_id !== `skill-adopt-${yield* sha256(canonicalSharedJson(description))}`)
      return yield* Effect.fail(
        fail(
          "SHARED_ADOPTION_INVALID",
          "The adoption operation differs from its complete frozen input.",
        ),
      )
    yield* adoptionChecked(() => validateSharedRecordEnvelope(operation_id, plan))
    return plan
  })
}

export function makeSharedNativeAdoptionPlan(input: {
  readonly library: SharedLibrary
  readonly pageId: string
  readonly metadata: NativeAdoptionMetadata
  readonly body: FrozenObservationBody
}) {
  return Effect.gen(function* () {
    const identity = yield* nativeAdoptionIdentity(input.library.library_id, input.pageId)
    const retained = yield* nativeObservedObjectIdentity(
      input.body.fingerprint.sha256,
      input.body.native_body_completion,
    )
    const content = {
      object_id: retained.object_id,
      sha256: input.body.fingerprint.sha256,
      bytes: input.body.bytes,
    }
    const eventIdentity = { version: 1, file_id: identity.file_id, parents: [], content }
    const observation = yield* makeSharedObservationPlan({
      skillPageId: input.pageId,
      fileId: identity.file_id,
      pageId: input.pageId,
      body: input.body,
      event: {
        kind: "adopted",
        file_id: identity.file_id,
        parents: [],
        content,
        event_id: `adopt-${yield* sha256(canonicalSharedJson(eventIdentity))}`,
      },
    })
    const description = {
      version: 1 as const,
      kind: "native_adoption" as const,
      library: input.library,
      library_id: input.library.library_id,
      ...identity,
      skill_page_id: input.pageId,
      metadata: input.metadata,
      observation,
    }
    return yield* validateSharedNativeAdoptionPlan({
      ...description,
      operation_id: `skill-adopt-${yield* sha256(canonicalSharedJson(description))}`,
    })
  })
}
