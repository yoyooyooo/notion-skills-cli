import { Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { normalizePath } from "./ref.ts"
import { CurrentFileModeSchema } from "./shared-current-file.ts"

const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Page = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
)
const ExactPath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
  Schema.makeFilter((value) =>
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value) && normalizePath(value) === value
      ? true
      : "Use one exact current file path.",
  ),
)
export const CurrentSourceFileRequestSchema = Schema.Struct({
  source_path: ExactPath,
  skill_id: Identity,
  file_id: Identity,
  action: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("takeover"),
      to: Schema.Literals(["native", "resource"]),
    }),
    Schema.Struct({ kind: Schema.Literal("restore_follow") }),
  ]),
})
export type CurrentSourceFileRequest = typeof CurrentSourceFileRequestSchema.Type

/** The exact current transfer, retained only while its parent intent is unfinished. */
export const CurrentSourceFileInputSchema = Schema.Struct({
  kind: Schema.Literal("file_authority"),
  configuration_sha256: Hash,
  affected_skill_ids: Schema.Array(Identity).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
  source_page_id: Page,
  revision: Hash,
  before_configuration_sha256: Hash,
  source_content_sha256: Hash,
  request: CurrentSourceFileRequestSchema,
  target: Schema.Struct({
    skill_page_id: Page,
    page_id: Page,
    path: ExactPath,
    content_sha256: Hash,
    native_sha256: Schema.NullOr(Hash),
  }),
  selected: Schema.Struct({
    sha256: Hash,
    bytes: Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(64 * 1024 * 1024),
    ),
    mode: CurrentFileModeSchema,
  }),
})
export type CurrentSourceFileInput = typeof CurrentSourceFileInputSchema.Type

export function validateCurrentSourceFileInput(input: unknown): CurrentSourceFileInput {
  try {
    const value = Schema.decodeUnknownSync(CurrentSourceFileInputSchema)(structuredClone(input), {
      onExcessProperty: "error",
    })
    if (value.affected_skill_ids[0] !== value.request.skill_id)
      throw fail("CURRENT_SOURCE_INPUT_INVALID", "The transfer has a different current target.")
    return value
  } catch (error) {
    if (error instanceof SkillsError) throw error
    throw fail("CURRENT_SOURCE_INPUT_INVALID", "Use one complete current Source file transfer.")
  }
}
