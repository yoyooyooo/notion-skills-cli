import { Schema } from "effect"
import { LegacySourceRegistrationSchema } from "./shared-current-source-legacy-registration.ts"
import { CurrentSourceFileInputSchema } from "./shared-current-source-file-input.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const StableId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const Page = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
)
const Scope = Schema.Array(StableId).check(
  Schema.isMaxLength(10000),
  Schema.makeFilter(
    (ids) => new Set(ids).size === ids.length || "Affected Skill IDs must be unique.",
  ),
)
const Retirements = Schema.Array(Schema.Struct({ skill_id: StableId, page_id: Page })).check(
  Schema.isMaxLength(10000),
  Schema.makeFilter(
    (rows) =>
      (new Set(rows.map((row) => row.skill_id)).size === rows.length &&
        new Set(rows.map((row) => row.page_id)).size === rows.length) ||
      "Each retiring Skill and physical page must be unique.",
  ),
)
const CurrentSelection = {
  configuration_sha256: Hash,
  affected_skill_ids: Scope,
  source_page_id: Page,
  revision: Hash,
}

/** Only an unfinished action keeps these coordinates. Completed Sources retain
 * their current declaration and selected bytes, with no action history. */
export const CurrentSourceInputSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("declaration"),
    configuration_sha256: Hash,
    resolved_commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
    affected_skill_ids: Scope,
    retirements: Retirements,
    materialization_sha256: Schema.optional(Hash),
    legacy_registration: Schema.optional(LegacySourceRegistrationSchema),
  }).check(
    Schema.makeFilter(
      (input) =>
        input.legacy_registration === undefined ||
        input.materialization_sha256 !== undefined ||
        "Legacy Source initialization requires an exact materialization scope.",
    ),
    Schema.makeFilter(
      (input) =>
        !input.legacy_registration?.last_revision ||
        input.resolved_commit === input.legacy_registration.last_revision ||
        "Legacy Source initialization must preserve the accepted Git commit.",
    ),
    Schema.makeFilter(
      (input) =>
        input.retirements.every((row) => input.affected_skill_ids.includes(row.skill_id)) ||
        "Retiring Skills must belong to the frozen affected scope.",
    ),
  ),
  CurrentSourceFileInputSchema,
  Schema.Struct({
    kind: Schema.Literal("enabled"),
    ...CurrentSelection,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("remove"),
    ...CurrentSelection,
  }),
])
export type CurrentSourceInput = typeof CurrentSourceInputSchema.Type
