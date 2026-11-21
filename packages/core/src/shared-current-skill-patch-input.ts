import { Schema } from "effect"
import { ContentKindSchema } from "./model.ts"
import { CurrentFileContentSchema } from "./shared-current-file.ts"

const Page = Schema.String.check(Schema.isUUID())
const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))

/** The finite patch retains identities and authority, never an old native body.
 * A resumed removal must still know a row that disappeared from live queries. */
export const CurrentSkillPatchScopeSchema = Schema.Struct({
  page_id: Page,
  skill_id: Identity,
  kind: ContentKindSchema,
  bindings: Schema.Array(
    Schema.Struct({
      file_id: Identity,
      page_id: Page,
      skill_page_id: Page,
      path: Schema.String,
      content: CurrentFileContentSchema,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(10000)),
})
export type CurrentSkillPatchScope = typeof CurrentSkillPatchScopeSchema.Type
