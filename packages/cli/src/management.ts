import packageManifest from "../package.json" with { type: "json" }
import { fail } from "../../core/src/model.ts"
import {
  runCurrentSourceSync,
  validateCurrentSourceSyncCommand,
} from "../../core/src/shared-current-source-sync.ts"
import {
  CURRENT_SOURCE_SYNC_VERSION,
  type CurrentSourceCheckRequest,
  type CurrentSourceSyncRequest,
  type CurrentSourceSyncResult,
} from "../../core/src/shared-current-source-sync-model.ts"
import { runRuntimeOperation, type OperationOptions } from "./operation-runtime.ts"

export const MANAGEMENT_VERSION = CURRENT_SOURCE_SYNC_VERSION
export const PACKAGE_VERSION: string = packageManifest.version
export { SkillsError } from "../../core/src/model.ts"
export {
  CURRENT_SOURCE_SYNC_VERSION,
  currentSourceSyncExitCode,
} from "../../core/src/shared-current-source-sync-model.ts"
export type {
  CurrentSourceCheckRequest,
  CurrentSourceSyncRequest,
  CurrentSourceSyncResult,
  CurrentSourceSyncItem,
  CurrentSourceSyncContent,
  CurrentSourceSyncProjection,
  CurrentSourceSyncSelection,
} from "../../core/src/shared-current-source-sync-model.ts"
export type { RequestBudgetLimits, RequestBudgetSnapshot } from "../../core/src/request-budget.ts"
export type { RequestMetricsSnapshot } from "../../core/src/request-metrics.ts"

export interface ManagementOptions extends OperationOptions {}
export type SourceCheckInput = CurrentSourceCheckRequest & { readonly entry: string }
export type SourceSyncInput = CurrentSourceSyncRequest & { readonly entry: string }

function checkedEntry(input: SourceCheckInput, options: ManagementOptions): string {
  if (Object.hasOwn(options, "readOnly"))
    throw fail(
      "INVALID_ARGUMENT",
      "readOnly is not a management option. Select checkSources or syncSources explicitly.",
    )
  if (
    input === null ||
    typeof input !== "object" ||
    typeof input.entry !== "string" ||
    !input.entry.trim()
  )
    throw fail("INVALID_ARGUMENT", "Source management requires one explicit library entry.")
  if (
    /^notion_page:/iu.test(input.entry) ||
    (/^[a-z][a-z\d+.-]*:\/\//iu.test(input.entry) && !/^https?:\/\//iu.test(input.entry))
  )
    throw fail(
      "INVALID_ARGUMENT",
      "Source management requires a current database ID or Notion URL.",
    )
  return input.entry
}

/** Read current declarations and upstream refs. No Notion semantic writes and no
 * automatic publication. An unchanged upstream does not certify target contents. */
export function checkSources(
  input: SourceCheckInput,
  options: ManagementOptions = {},
): Promise<CurrentSourceSyncResult> {
  return runRuntimeOperation(() => {
    const entry = checkedEntry(input, options)
    const { entry: _, ...request } = input
    return runCurrentSourceSync(
      entry,
      validateCurrentSourceSyncCommand({ ...request, action: "check" }),
    )
  }, options)
}

/** Explicit management. One call checks, freezes and publishes exact upstream
 * content or resumes its finite original intent. Keep manager/execution identity
 * and original local Store stable across retries; scheduling stays with the caller. */
export function syncSources(
  input: SourceSyncInput,
  options: ManagementOptions = {},
): Promise<CurrentSourceSyncResult> {
  return runRuntimeOperation(() => {
    const entry = checkedEntry(input, options)
    const { entry: _, ...request } = input
    return runCurrentSourceSync(
      entry,
      validateCurrentSourceSyncCommand({ ...request, action: "sync" }),
    )
  }, options)
}
