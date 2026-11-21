import { Schema } from "effect"

const StableId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const ResourceId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u))
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Page = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
)
const Pages = Schema.Array(Page).check(
  Schema.isMaxLength(10000),
  Schema.makeFilter(
    (values) => new Set(values).size === values.length || "Repeated relation page.",
  ),
)

/** These coordinates exist only while the one owner removal is unfinished. */
export const CurrentSkillRemovalInputSchema = Schema.Struct({
  kind: Schema.Literal("remove"),
  page_id: Page,
  owner_sha256: Hash,
  files: Schema.Array(
    Schema.Struct({
      file_id: StableId,
      page_id: Page,
      path: Schema.String.check(Schema.isMinLength(1)),
      content_sha256: Hash,
    }),
  ).check(Schema.isMaxLength(10000)),
  resources: Schema.Array(
    Schema.Struct({ resource_id: ResourceId, page_id: Page, payload_sha256: Hash }),
  ).check(Schema.isMaxLength(10000)),
  relations: Schema.Array(
    Schema.Struct({
      skill_id: StableId,
      page_id: Page,
      field: Schema.Literals(["Members", "Requires"]),
      before: Pages,
      after: Pages.check(Schema.isMaxLength(100)),
    }),
  ).check(Schema.isMaxLength(20000)),
}).check(
  Schema.makeFilter((input) => {
    if (
      new Set(input.files.map((row) => row.file_id)).size !== input.files.length ||
      new Set(input.files.map((row) => row.path)).size !== input.files.length ||
      new Set(input.resources.map((row) => row.resource_id)).size !== input.resources.length ||
      new Set([
        input.page_id,
        ...input.files.map((row) => row.page_id),
        ...input.resources.map((row) => row.page_id),
      ]).size !==
        1 + input.files.length + input.resources.length
    )
      return "Removal coordinates must identify unique owned objects."
    if (
      new Set(input.relations.map((row) => `${row.page_id}:${row.field}`)).size !==
        input.relations.length ||
      input.relations.some(
        (row) =>
          row.page_id === input.page_id ||
          !row.before.includes(input.page_id) ||
          JSON.stringify([...row.after].sort()) !==
            JSON.stringify(row.before.filter((id) => id !== input.page_id).sort()),
      )
    )
      return "Removal may only unlink its exact owner from each complete relation."
    return true
  }),
)
export type CurrentSkillRemovalInput = typeof CurrentSkillRemovalInputSchema.Type
