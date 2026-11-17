import { Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { normalizePath } from "./ref.ts"
import { completeNativeMainInput } from "./shared-complete-main-input.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))

/** Only a first native main insertion. The original file is the complete fixed
 * Git input below; the empty control-page response is never a file baseline. */
export const SharedGitMainInitializationSchema = Schema.Struct({
  version: Schema.Literal(1),
  source_revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  source_file: Schema.Struct({
    path: Schema.String,
    source_path: Schema.String,
    git_oid: Schema.String,
    bytes: Schema.Number,
    sha256: Hash,
    mode: Schema.Literals(["100644", "100755"]),
  }),
  source_input: Schema.String,
  authored_input: Schema.String,
  authored_mode: Schema.Literals(["100644", "100755"]),
  name: Schema.String,
  description: Schema.String,
  owner_metadata_sha256: Hash,
  bindings: Schema.Array(Schema.Struct({ page_id: Schema.String, path: Schema.String })),
  snapshot_id: Schema.String,
  snapshot_version_id: Schema.String,
  snapshot_scope: Hash,
  tree_sha256: Hash,
  metadata_sha256: Hash,
  events_sha256: Hash,
})
export type SharedGitMainInitialization = typeof SharedGitMainInitializationSchema.Type

export const gitMainChecked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_GIT_MAIN_INVALID", "The initial Git main takeover is invalid."),
  })

/** The frozen Source member supplies repository coordinates for this Git main.
 * Only this owner's bindings become native links. Sibling destinations retain
 * their authored spelling and remain subject to the explicit --from reader. */
export function gitMainInput(
  input: Parameters<typeof completeNativeMainInput>[0] & {
    readonly source_member: string
  },
) {
  const member = input.source_member
  if (member !== "." && (!member || normalizePath(member) !== member))
    throw fail(
      "SHARED_GIT_MAIN_INVALID",
      "Initial Git main authoring requires its exact canonical Source member.",
    )
  const prefix = member === "." ? "" : `${member}/`
  return completeNativeMainInput({
    ...input,
    path: prefix + input.path,
    bindings: input.bindings.map((binding) => ({
      ...binding,
      path: prefix + binding.path,
    })),
  })
}
