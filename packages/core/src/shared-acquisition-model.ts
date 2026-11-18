import { fail, type Snapshot } from "./model.ts"
import { normalizePath } from "./ref.ts"

/** Pure boundary for the single current acquisition contract. The full file
 * directory remains Snapshot.files; routes locate only missing selected bytes. */
export function validateSnapshotAcquisition(snapshot: Snapshot): ReadonlySet<string> {
  const acquisition = snapshot.shared_acquisition
  if (acquisition === undefined) return new Set<string>()
  const locator = snapshot.record.locator
  if (
    locator.type !== "shared_skill" ||
    acquisition.library.library_id !== locator.library_id ||
    acquisition.library.skills.database_id !== locator.database_id ||
    acquisition.library.skills.data_source_id !== locator.data_source_id ||
    new Set(acquisition.files.map((file) => file.path)).size !== acquisition.files.length
  )
    throw fail("STATE_CORRUPT", "Shared acquisition differs from the exact selected owner.")
  if (
    acquisition.source !== null &&
    (!acquisition.source.source_id || !acquisition.source.revision)
  )
    throw fail("STATE_CORRUPT", "A selected source requires its identity and exact revision.")
  if (acquisition.source?.source_id.startsWith("snapshot-"))
    throw fail(
      "CURRENT_SOURCE_REQUIRED",
      "Historical snapshots cannot supply current acquisition. Migrate the current content first.",
      { next: "migrate_current_content" },
    )
  for (const route of acquisition.files) {
    if (
      !snapshot.files.some((file) => file.path === route.path) ||
      normalizePath(route.path) !== route.path
    )
      throw fail(
        "STATE_CORRUPT",
        "An acquisition route must name an exact path in the complete selected directory.",
      )
    if (route.kind === "source") {
      if (
        acquisition.source === null ||
        acquisition.source.source_id === "" ||
        acquisition.source.revision === "" ||
        normalizePath(route.source_path) !== route.source_path
      )
        throw fail("STATE_CORRUPT", "A selected raw path has no exact source identity.")
    } else if (!/^resource-[a-f0-9]{64}$/u.test(route.object_id))
      throw fail("STATE_CORRUPT", "A selected raw path has an invalid resource identity.")
  }
  if (
    acquisition.source?.kind === "git_member" &&
    (normalizePath(acquisition.source.member_root) !== acquisition.source.member_root ||
      !acquisition.source.source_id ||
      !acquisition.source.revision)
  )
    throw fail(
      "STATE_CORRUPT",
      "A Git member requires its selected source revision and canonical member root.",
    )
  return new Set(acquisition.files.map((route) => route.path))
}
