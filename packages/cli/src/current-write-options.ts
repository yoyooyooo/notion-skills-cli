import { fail } from "../../core/src/model.ts"
import type { CurrentWriteMode } from "../../core/src/shared-current-operation.ts"
import { currentWriteIdentity } from "../../core/src/shared-current-write-input.ts"

/** Admission shared by the current import and Source commands, before remote work. */
export function selectCurrentWriteMode(input: {
  readonly operation?: string
  readonly resume: boolean
  readonly supersede?: string
  readonly dryRun: boolean
}): CurrentWriteMode {
  if (input.operation !== undefined) currentWriteIdentity(input.operation, "Operation ID")
  if (input.supersede !== undefined) {
    currentWriteIdentity(input.supersede, "Superseded operation ID")
    if (
      input.operation === undefined ||
      input.operation === input.supersede ||
      input.resume ||
      input.dryRun
    )
      throw fail(
        "INVALID_ARGUMENT",
        "--supersede OLD requires a distinct --operation NEW and cannot be combined with --resume or --dry-run.",
      )
    return { kind: "supersede", operation_id: input.supersede }
  }
  if (input.resume && (input.operation === undefined || input.dryRun))
    throw fail(
      "INVALID_ARGUMENT",
      "--resume requires --operation and cannot be combined with --dry-run.",
    )
  return input.resume ? "resume" : "apply"
}
