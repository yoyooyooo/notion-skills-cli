import { Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { normalizePath } from "./ref.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"

const FileSchema = Schema.Struct({
  path: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  bytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  mode: Schema.NullOr(Schema.Literals(["100644", "100755"])),
})
const InputSchema = Schema.Struct({ main: Schema.String, files: Schema.Array(FileSchema) })

/** Portable input identity is independent of host paths, timestamps and Notion
 * presentation. It establishes content equality, never sharing or write authority. */
export function fingerprintSkillInput(input: unknown) {
  return Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => {
        const value = Schema.decodeUnknownSync(InputSchema)(input)
        if (
          value.files.length === 0 ||
          !value.files.some((file) => file.path === value.main) ||
          new Set(value.files.map((file) => file.path)).size !== value.files.length ||
          value.files.some((file) => normalizePath(file.path) !== file.path)
        )
          throw fail(
            "INPUT_FINGERPRINT_INVALID",
            "A content fingerprint requires a complete unique relative file tree and its entrypoint.",
          )
        return {
          version: 1,
          kind: "skill_input_content",
          main: value.main,
          files: [...value.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
        }
      },
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail(
              "INPUT_FINGERPRINT_INVALID",
              "Input file hashes, sizes and modes must be complete and valid.",
            ),
    })
    return yield* sha256(canonicalSharedJson(parsed))
  })
}
