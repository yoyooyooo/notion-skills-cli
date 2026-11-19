import { Schema } from "effect"
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
  }),
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
