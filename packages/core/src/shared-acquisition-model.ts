import { fail, type Snapshot } from "./model.ts"
import { normalizePath } from "./ref.ts"

/** Pure boundary shared by durable storage and current/fixed consumers. The file
 * directory remains Snapshot.files; this validates only its frozen locations. */
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
    throw fail("STATE_CORRUPT", "Frozen shared acquisition differs from the exact snapshot owner.")
  for (const route of acquisition.files) {
    if (
      !snapshot.files.some((file) => file.path === route.path) ||
      route.path === snapshot.entrypoint ||
      /\.(md|markdown)$/iu.test(route.path)
    )
      throw fail(
        "STATE_CORRUPT",
        "Only exact supporting raw snapshot paths may defer byte acquisition.",
      )
    if (route.kind === "source") {
      if (
        acquisition.source === null ||
        acquisition.source.source_id === "" ||
        acquisition.source.revision === "" ||
        normalizePath(route.source_path) !== route.source_path
      )
        throw fail("STATE_CORRUPT", "A fixed raw path has no exact frozen source identity.")
    } else if (!/^resource-[a-f0-9]{64}$/u.test(route.object_id))
      throw fail("STATE_CORRUPT", "A retained raw path has an invalid immutable manifest identity.")
  }
  return new Set(acquisition.files.map((route) => route.path))
}
