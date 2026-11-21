import { Schema } from "effect"

const Page = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
)
const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))

/** Registration keeps author bodies in place. Only this unfinished metadata intent
 * retains the original field fingerprints and its exact desired bindings. */
export const CurrentSkillRegistrationInputSchema = Schema.Struct({
  kind: Schema.Literal("register"),
  page_id: Page,
  skill_id: Identity,
  request_sha256: Hash,
  owner_before_sha256: Hash,
  owner_was_registered: Schema.Boolean,
  name: Schema.String,
  description: Schema.String,
  content_kind: Schema.Literals(["skill", "router", "prompt"]),
  main_file_id: Identity,
  main_content: Schema.String,
  enabled: Schema.Boolean,
  default_context: Schema.Boolean,
  files: Schema.Array(
    Schema.Struct({
      page_id: Page,
      file_id: Identity,
      path: Schema.String,
      name: Schema.String,
      content: Schema.String,
      before_sha256: Hash,
    }),
  ).check(Schema.isMaxLength(10000)),
}).check(
  Schema.makeFilter(
    (input) =>
      (new Set(input.files.map((row) => row.page_id)).size === input.files.length &&
        new Set([input.main_file_id, ...input.files.map((row) => row.file_id)]).size ===
          input.files.length + 1 &&
        new Set(input.files.map((row) => row.path)).size === input.files.length) ||
      "Registered File pages, identities and paths must be unique.",
  ),
)
export type CurrentSkillRegistrationInput = typeof CurrentSkillRegistrationInputSchema.Type
