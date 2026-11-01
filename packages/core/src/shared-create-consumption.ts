import { Effect } from "effect"
import { fail, property, SkillsError } from "./model.ts"
import type { executeSharedCreate } from "./shared-create.ts"
import { verifySharedCreatedSnapshot } from "./shared-create-verification.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { openSkill, snapshotInfo } from "./snapshot.ts"

/** Shared success boundary for public creation. A native completion alone does
 * not establish a current complete consumer snapshot. Migration requests a
 * read-only final observation, so drift cannot create an ownership event. */
export function consumeSharedCreation(
  library: SharedLibrary,
  result: Effect.Success<ReturnType<typeof executeSharedCreate>>,
  options: { readonly readOnly?: boolean } = {},
) {
  const consume = Effect.gen(function* () {
    const current = yield* openSkill(result.skill_page_id, {
      database: library.skills.database_id,
      refresh: true,
      ...(options.readOnly === undefined ? {} : { sharedReadOnly: options.readOnly }),
    })
    if (
      current.record.locator.type !== "shared_skill" ||
      current.record.locator.library_id !== library.library_id ||
      current.record.locator.skill_id !== result.skill_id
    )
      return yield* Effect.fail(
        fail(
          "WRITE_VERIFICATION_FAILED",
          "The created shared Skill no longer has its exact original identity.",
          { create_operation_id: result.operation_id },
        ),
      )
    yield* Effect.try({
      try: () => verifySharedCreatedSnapshot(current, result),
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail(
              "WRITE_VERIFICATION_FAILED",
              "The current shared tree could not be compared with the original create.",
              { create_operation_id: result.operation_id },
            ),
    })
    return {
      ...snapshotInfo(current),
      operation: "create" as const,
      action: "create" as const,
      verified: true as const,
      create_operation_id: result.operation_id,
      reused: result.reused,
    }
  })
  if (!options.readOnly) return consume
  return consume.pipe(
    Effect.mapError((error) =>
      fail(
        "WRITE_VERIFICATION_FAILED",
        "The original native creation completed, but its read-only current snapshot could not be verified. Preserve observed content and reconcile the original operation before any retry.",
        {
          ...property(error.details),
          create_operation_id: result.operation_id,
          native_create_completed: true,
          current_snapshot_verified: false,
          requires_fresh_read: true,
          verification_error_code: error.code,
          verification_error_message: error.message,
        },
      ),
    ),
  )
}
