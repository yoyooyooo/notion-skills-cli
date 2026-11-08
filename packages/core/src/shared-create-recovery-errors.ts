import { fail } from "./model.ts"

/** Shared recovery refusal has no schema or runtime dependency. */
export const prefixRecoveryRequired = (message: string) =>
  fail("SHARED_CREATE_RECOVERY_REQUIRED", message)
