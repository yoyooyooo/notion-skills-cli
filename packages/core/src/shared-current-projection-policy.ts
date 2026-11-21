import { Schema } from "effect"
import { fail } from "./model.ts"

export const currentProjectionDefaultInclude = ["**/*.md"] as const
export const currentProjectionDefaultExclude = [
  "**/{test,tests,__tests__,__snapshots__,fixtures,corpus,testdata,node_modules,vendor,dist,build,coverage}/**",
] as const

const Pattern = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.makeFilter(
    (pattern) =>
      (!pattern.startsWith("/") &&
        !pattern.includes("\\") &&
        !/[\u0000-\u001f\u007f]/u.test(pattern) &&
        !pattern.split("/").includes("..")) ||
      "Use a relative POSIX glob.",
  ),
)
const Patterns = Schema.Array(Pattern).check(Schema.isMaxLength(100))
export const CurrentProjectionPolicySchema = Schema.Struct({
  include: Patterns,
  exclude: Patterns,
})
export type CurrentProjectionPolicy = typeof CurrentProjectionPolicySchema.Type

/** Freeze the effective policy in the same finite intent as its input fingerprint. */
export function currentProjectionPolicy(input: {
  readonly include?: readonly string[]
  readonly exclude?: readonly string[]
}): CurrentProjectionPolicy {
  try {
    return Schema.decodeUnknownSync(CurrentProjectionPolicySchema)({
      include: [...(input.include ?? currentProjectionDefaultInclude)],
      exclude: [...(input.exclude ?? currentProjectionDefaultExclude)],
    })
  } catch {
    throw fail(
      "CURRENT_PROJECTION_CONFLICT",
      "Projection patterns must be bounded relative POSIX globs.",
    )
  }
}
