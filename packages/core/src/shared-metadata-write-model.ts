import { sharedSkillId } from "./shared-content.ts"
import { Effect, Schema } from "effect"
import { fail, SkillsError, validateDescription, validateDisplayName } from "./model.ts"
import { pageId } from "./ref.ts"
import { canonicalSharedJson, validateSharedRecordEnvelope } from "./shared-records.ts"
import { sha256 } from "./store.ts"

const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
export const SharedMetadataFieldSchema = Schema.Literals([
  "Name",
  "Description",
  "Default Context",
  "Members",
  "Source",
])
export type SharedMetadataField = typeof SharedMetadataFieldSchema.Type
const ValueSchema = Schema.Union([Schema.String, Schema.Boolean, Schema.Array(Schema.String)])
export type SharedMetadataValue = typeof ValueSchema.Type
export type SharedMetadataChange = {
  readonly field: SharedMetadataField
  readonly value: SharedMetadataValue
}
export const SharedMetadataWritePlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("metadata_write"),
  operation_id: Schema.String.check(Schema.isPattern(/^metadata-write-[a-f0-9]{64}$/u)),
  library_id: Identity,
  skill_id: Identity,
  skill_page_id: Schema.String,
  file_id: Identity,
  page_id: Schema.String,
  record_id: Schema.String,
  observed_at: Schema.Number,
  changes: Schema.Array(
    Schema.Struct({
      field: SharedMetadataFieldSchema,
      property_id: Schema.String,
      before: ValueSchema,
      after: ValueSchema,
    }),
  ),
})
export type SharedMetadataWritePlan = typeof SharedMetadataWritePlanSchema.Type
export const sharedMetadataEntity = "metadata-writes-v1"
export const sharedMetadataOutcomeId = (operationId: string) => `outcome-${operationId}`
export const sharedMetadataWriteProtection = {
  strategy: "native_explicit_properties",
  conditional: false,
  concurrency: "last_writer_on_requested_fields",
  automatic_retry: false,
  omitted_properties_preserved: true,
} as const

export function metadataChecked<A>(action: () => A) {
  return Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_METADATA_WRITE_INVALID", "The frozen metadata operation is invalid."),
  })
}

export function validateMetadataValue(
  field: SharedMetadataField,
  value: SharedMetadataValue,
): SharedMetadataValue {
  switch (field) {
    case "Name":
      if (typeof value !== "string" || validateDisplayName(value) !== value)
        throw fail("INVALID_SKILL_NAME", "Name must use its exact validated display form.")
      return value
    case "Description":
      if (typeof value !== "string" || validateDescription(value) !== value)
        throw fail("INVALID_DESCRIPTION", "Description must use its exact validated form.")
      return value
    case "Default Context":
      if (typeof value !== "boolean")
        throw fail("INVALID_ARGUMENT", "Default Context must be a boolean.")
      return value
    case "Source":
      if (
        typeof value !== "string" ||
        (value !== "" && !/^(?:source|source-plan)-[a-f0-9]{64}$/u.test(value))
      )
        throw fail(
          "INVALID_SOURCE",
          "Select native content or one exact immutable shared source identity.",
        )
      return value
    case "Members": {
      if (
        !Array.isArray(value) ||
        value.some((id) => pageId(id) !== id) ||
        new Set(value).size !== value.length
      )
        throw fail("INVALID_MEMBERS", "Members must be unique canonical page identities.")
      return [...value].sort()
    }
  }
}

export function validateSharedMetadataWritePlan(input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* metadataChecked(() =>
      Schema.decodeUnknownSync(SharedMetadataWritePlanSchema)(input, { onExcessProperty: "error" }),
    )
    yield* metadataChecked(() => {
      if (
        pageId(plan.skill_page_id) !== plan.skill_page_id ||
        plan.page_id !== plan.skill_page_id ||
        plan.record_id !== sharedSkillId(plan.library_id, plan.skill_id) ||
        !Number.isSafeInteger(plan.observed_at) ||
        plan.observed_at < 0 ||
        !plan.changes.length ||
        new Set(plan.changes.map((change) => change.field)).size !== plan.changes.length ||
        new Set(plan.changes.map((change) => change.property_id)).size !== plan.changes.length
      )
        throw fail(
          "SHARED_METADATA_WRITE_INVALID",
          "Metadata operation identities, fields or observation time are invalid.",
        )
      if (
        canonicalSharedJson(plan.changes.map((change) => change.field)) !==
        canonicalSharedJson(plan.changes.map((change) => change.field).sort())
      )
        throw fail(
          "SHARED_METADATA_WRITE_INVALID",
          "Metadata changes require canonical field ordering.",
        )
      for (const change of plan.changes) {
        if (
          !/^(?:[A-Za-z0-9._~-]|%[0-9a-f]{2})+$/iu.test(change.property_id) ||
          canonicalSharedJson(validateMetadataValue(change.field, change.before)) !==
            canonicalSharedJson(change.before) ||
          canonicalSharedJson(validateMetadataValue(change.field, change.after)) !==
            canonicalSharedJson(change.after)
        )
          throw fail(
            "SHARED_METADATA_WRITE_INVALID",
            "Frozen metadata values or property identities are not canonical.",
          )
      }
    })
    const { operation_id, ...description } = plan
    if (operation_id !== `metadata-write-${yield* sha256(canonicalSharedJson(description))}`)
      return yield* Effect.fail(
        fail(
          "SHARED_METADATA_WRITE_INVALID",
          "The original metadata operation does not match its complete frozen content.",
        ),
      )
    yield* metadataChecked(() => validateSharedRecordEnvelope(operation_id, plan))
    return plan
  })
}

export function makeSharedMetadataWritePlan(
  input: Omit<SharedMetadataWritePlan, "version" | "kind" | "operation_id">,
) {
  return Effect.gen(function* () {
    const description = { version: 1 as const, kind: "metadata_write" as const, ...input }
    const operation_id = `metadata-write-${yield* sha256(canonicalSharedJson(description))}`
    return yield* validateSharedMetadataWritePlan({ ...description, operation_id })
  })
}
