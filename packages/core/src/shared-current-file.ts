import { Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { normalizePath } from "./ref.ts"

const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
export const CurrentSourceIdSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u),
  Schema.makeFilter((id) =>
    !/^(?:snapshot-|bundle-|source-plan-)/u.test(id) && !/^source-[a-f0-9]{64}$/u.test(id)
      ? true
      : "Current Source IDs cannot be retired content-carrier identities.",
  ),
)
export const CurrentFileModeSchema = Schema.Literals(["100644", "100755"])
const ExactContent = {
  sha256: Hash,
  bytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  mode: CurrentFileModeSchema,
}
export const CurrentResourceContentSchema = Schema.Struct({
  kind: Schema.Literal("resource"),
  object_id: Schema.String.check(Schema.isPattern(/^resource-[a-f0-9]{64}$/u)),
  ...ExactContent,
})
export type CurrentResourceContent = typeof CurrentResourceContentSchema.Type

/** The discriminant is also the authority: native/resource belong to Notion;
 * source belongs to the named current Source. A page projection never owns bytes. */
export const CurrentFileContentSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("native"),
    mode: CurrentFileModeSchema,
    frontmatter: Schema.String,
  }),
  CurrentResourceContentSchema,
  Schema.Struct({
    kind: Schema.Literal("source"),
    source_id: CurrentSourceIdSchema,
    revision: Hash,
    source_path: Schema.String,
    ...ExactContent,
  }),
])
export type CurrentFileContent = typeof CurrentFileContentSchema.Type

export const CurrentSkillStateSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal("ready") }),
  Schema.Struct({
    state: Schema.Literals(["applying", "attention"]),
    operation_id: Identity,
  }),
])
export type CurrentSkillState = typeof CurrentSkillStateSchema.Type

export function currentSchemaRequired(details?: unknown): SkillsError {
  return fail(
    "CURRENT_SCHEMA_REQUIRED",
    "This library entry requires explicit current-content migration before use.",
    { next: "migrate_current_content", ...(details === undefined ? {} : { missing: details }) },
  )
}

/** Decode only current facts. Old hashes, event heads and ownership markers are errors. */
export function decodeCurrentFileContent(input: unknown): CurrentFileContent {
  try {
    const content = Schema.decodeUnknownSync(CurrentFileContentSchema)(input, {
      onExcessProperty: "error",
    })
    if (content.kind === "native") {
      if (
        content.frontmatter !== "" &&
        !/^\uFEFF?---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)(?:\r?\n)*$/u.test(content.frontmatter)
      )
        throw fail(
          "CURRENT_CONTENT_INVALID",
          "Native frontmatter must be an exact YAML header or empty.",
        )
    } else {
      if (!Number.isSafeInteger(content.bytes))
        throw fail(
          "CURRENT_CONTENT_INVALID",
          "Current byte size must be a safe nonnegative integer.",
        )
      if (content.kind === "source") {
        if (
          !content.source_path ||
          content.source_path.length > 4096 ||
          /[\u0000-\u001f\u007f-\u009f]/u.test(content.source_path) ||
          normalizePath(content.source_path) !== content.source_path
        )
          throw fail(
            "CURRENT_CONTENT_INVALID",
            "A current Source file needs an exact revision and canonical source path.",
          )
      }
    }
    return content
  } catch (error) {
    if (error instanceof SkillsError && error.code === "CURRENT_CONTENT_INVALID") throw error
    throw fail("CURRENT_CONTENT_INVALID", "The current Content descriptor is invalid.")
  }
}

export function parseCurrentFileContent(encoded: string): CurrentFileContent {
  if (encoded === "") throw currentSchemaRequired("Content")
  let input: unknown
  try {
    input = JSON.parse(encoded)
  } catch {
    throw fail(
      "CURRENT_CONTENT_INVALID",
      "Content must contain one complete current JSON descriptor.",
    )
  }
  return decodeCurrentFileContent(input)
}

/** Two physical properties decode into one state; ready cannot retain an operation pointer. */
export function parseCurrentSkillState(state: string, operation: string): CurrentSkillState {
  if (state === "") throw currentSchemaRequired("Current State")
  try {
    return Schema.decodeUnknownSync(CurrentSkillStateSchema)(
      { state, ...(operation === "" ? {} : { operation_id: operation }) },
      { onExcessProperty: "error" },
    )
  } catch {
    throw fail(
      "CURRENT_STATE_INVALID",
      "Current State and Operation do not describe one valid current operation.",
    )
  }
}

/** Normal consumption only observes readiness. Management explicitly reconciles pending work. */
export function requireCurrentSkillReady(state: CurrentSkillState, skillPageId: string): void {
  if (state.state === "ready") return
  throw fail(
    "CURRENT_OPERATION_PENDING",
    "This Skill has unfinished current work; reconcile its operation before consuming a complete tree.",
    {
      skill_page_id: skillPageId,
      state: state.state,
      operation_id: state.operation_id,
      next: "reconcile_current",
    },
  )
}
