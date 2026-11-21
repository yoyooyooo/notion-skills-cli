import { Schema } from "effect"
import { fail, type Snapshot } from "./model.ts"
import { normalizePath, pageId } from "./ref.ts"
import { CurrentSourceIdSchema } from "./shared-current-file.ts"

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
  const bindings = snapshot.file_bindings ?? []
  if (
    snapshot.files.some(
      (file) =>
        !acquisition.files.some((route) => route.path === file.path && route.kind === "source") &&
        !bindings.some((binding) => binding.path === file.path),
    ) ||
    new Set(bindings.map((file) => file.file_id)).size !== bindings.length ||
    new Set(bindings.map((file) => file.page_id)).size !== bindings.length ||
    new Set(bindings.map((file) => file.path)).size !== bindings.length ||
    bindings.some(
      (file) =>
        !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(file.file_id) ||
        pageId(file.page_id) !== file.page_id ||
        !snapshot.files.some((selected) => selected.path === file.path) ||
        (file.path === snapshot.entrypoint) !== (file.page_id === locator.page_id),
    )
  )
    throw fail("STATE_CORRUPT", "Notion-owned files require unique exact physical bindings.")
  const revisions = new Map<string, string>()
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
      if (acquisition.library.sources === undefined)
        throw fail("STATE_CORRUPT", "A selected Source requires its registered Sources table.")
      try {
        Schema.decodeUnknownSync(CurrentSourceIdSchema)(route.source_id)
      } catch {
        throw fail("STATE_CORRUPT", "A selected path requires a stable current Source ID.")
      }
      if (
        !/^[a-f0-9]{64}$/u.test(route.revision) ||
        !route.source_path ||
        normalizePath(route.source_path) !== route.source_path
      )
        throw fail("STATE_CORRUPT", "A selected raw path has no exact source identity.")
      const revision = revisions.get(route.source_id)
      if (revision !== undefined && revision !== route.revision)
        throw fail("STATE_CORRUPT", "One current Source has conflicting selected revisions.")
      revisions.set(route.source_id, route.revision)
    } else if (!/^resource-[a-f0-9]{64}$/u.test(route.object_id))
      throw fail("STATE_CORRUPT", "A selected raw path has an invalid resource identity.")
  }
  return new Set(acquisition.files.map((route) => route.path))
}
