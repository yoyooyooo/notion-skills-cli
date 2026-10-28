import { createHash } from "node:crypto"
import { Schema } from "effect"
import { fail, property } from "./model.ts"
import type { PortableSkill } from "./portable.ts"
import type { PublicationMarker } from "./publication-integrity-state.ts"
import { canonical } from "./publication-effect-proof.ts"

export const DescriptionFinalLfMigration = "restore_source_description_final_lf"
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const ContentAdoptionDescriptionMigrationSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal(DescriptionFinalLfMigration),
  property_id: Schema.String,
  legacy_description: Schema.String,
  source_description: Schema.String,
  legacy_intended_hash: Hash,
  source_intended_hash: Hash,
})
export type ContentAdoptionDescriptionMigration =
  typeof ContentAdoptionDescriptionMigrationSchema.Type
export interface ContentAdoptionDescriptionPhase {
  readonly migration: ContentAdoptionDescriptionMigration
  readonly restored: boolean
}
const refusal = (message: string) => fail("CONTENT_ADOPTION_REFUSED", message)
const neutral = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
}
const keys = (value: Record<string, unknown>, expected: readonly string[]) =>
  canonical(Object.keys(value).sort()) === canonical([...expected].sort())

/** This migration accepts one complete plain Description value, including its
 * original property identity. Formatting, links, partial values and aliases are
 * not a text-normalization opportunity. */
function plainDescription(raw: unknown) {
  const fields = property(property(raw).properties),
    field = property(fields.Description)
  if (
    !keys(field, ["id", "type", "rich_text"]) ||
    typeof field.id !== "string" ||
    !field.id ||
    field.type !== "rich_text" ||
    !Array.isArray(field.rich_text) ||
    field.rich_text.length !== 1 ||
    Object.values(fields).filter((value) => property(value).id === field.id).length !== 1 ||
    Object.keys(fields).some((name) => name !== "Description" && name === field.id)
  )
    return undefined
  const span = property(field.rich_text[0]),
    text = property(span.text)
  if (
    !keys(span, ["type", "text", "plain_text", "href", "annotations"]) ||
    span.type !== "text" ||
    !keys(text, ["content", "link"]) ||
    typeof text.content !== "string" ||
    text.link !== null ||
    span.href !== null ||
    span.plain_text !== text.content ||
    canonical(span.annotations) !== canonical(neutral)
  )
    return undefined
  return { property_id: field.id, value: text.content }
}
function intended(portable: PortableSkill) {
  const files = [...portable.files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => [
      file.path,
      file.bytes.length,
      createHash("sha256").update(file.bytes).digest("hex"),
    ])
  return createHash("sha256")
    .update(canonical([portable.kind, portable.name, portable.description, portable.main, files]))
    .digest("hex")
}

/** Derive exactly one historical descriptor from the complete original source.
 * The source portable, its files and its new publication identity never change. */
export function deriveContentAdoptionDescriptionMigration(
  portable: PortableSkill,
  sourceIntended: string,
  oldMarker: PublicationMarker,
  raw: unknown,
): ContentAdoptionDescriptionMigration {
  const description = portable.description,
    field = plainDescription(raw)
  if (
    portable.kind !== "skill" ||
    !description.endsWith("\n") ||
    description.endsWith("\n\n") ||
    description.endsWith("\r\n") ||
    description.length < 2 ||
    description.length > 2000 ||
    intended(portable) !== sourceIntended ||
    oldMarker.state !== "writing" ||
    oldMarker.creation !== undefined ||
    !field ||
    field.value !== description.slice(0, -1)
  )
    throw refusal(
      "The explicit Description migration requires one source final LF and its exact plain legacy value.",
    )
  const legacy = { ...portable, description: description.slice(0, -1) }
  const legacyIntended = intended(legacy)
  if (legacyIntended === sourceIntended || oldMarker.intended_hash !== legacyIntended)
    throw refusal(
      "The old writing hash is not the exact full-source descriptor with its one final Description LF removed.",
    )
  return {
    version: 1,
    kind: DescriptionFinalLfMigration,
    property_id: field.property_id,
    legacy_description: legacy.description,
    source_description: description,
    legacy_intended_hash: legacyIntended,
    source_intended_hash: sourceIntended,
  }
}

export function contentAdoptionDescriptionMatches(
  raw: unknown,
  phase: ContentAdoptionDescriptionPhase,
) {
  const field = plainDescription(raw),
    migration = phase.migration
  return (
    field !== undefined &&
    field.property_id === migration.property_id &&
    field.value === (phase.restored ? migration.source_description : migration.legacy_description)
  )
}

/** Select the BEFORE comparison view only. Archives, receipts and integrity
 * always use the original portable, never this historical descriptor view. */
export function contentAdoptionDescriptorBounds(
  portable: PortableSkill,
  sourceIntended: string,
  migration?: ContentAdoptionDescriptionMigration,
  restored = false,
) {
  if (!migration) return { portable, intended_hash: sourceIntended }
  if (
    migration.kind !== DescriptionFinalLfMigration ||
    migration.source_description !== portable.description ||
    migration.source_intended_hash !== sourceIntended ||
    migration.legacy_description !== portable.description.slice(0, -1)
  )
    throw refusal("The Description phase no longer binds the original source descriptor.")
  return {
    portable: restored ? portable : { ...portable, description: migration.legacy_description },
    intended_hash: restored ? sourceIntended : migration.legacy_intended_hash,
    descriptor_migration: { migration, restored },
  }
}

/** Only after the declared effect is proven may its two exact plain values be
 * compared in one view. All other metadata and field definitions stay intact. */
export function contentAdoptionDescriptionComparison(
  raw: unknown,
  phase: ContentAdoptionDescriptionPhase,
) {
  if (!contentAdoptionDescriptionMatches(raw, phase))
    throw refusal("The Description is not the exact declared before/after value of its migration.")
  const copy = structuredClone(property(raw)),
    field = property(property(copy.properties).Description)
  const values = field.rich_text
  if (!Array.isArray(values)) throw refusal("The complete Description property is missing.")
  const span = property(values[0])
  property(span.text).content = phase.migration.legacy_description
  span.plain_text = phase.migration.legacy_description
  return copy
}

export function contentAdoptionDescriptionProperties(
  migration: ContentAdoptionDescriptionMigration,
) {
  return {
    [migration.property_id]: {
      rich_text: [{ type: "text", text: { content: migration.source_description } }],
    },
  }
}
