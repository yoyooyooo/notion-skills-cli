import type { Snapshot } from "./model.ts"
import { resolveFileState, type FileEvent, type ResolvedFileState } from "./shared-file-state.ts"
import type { SharedBodyBinding, SharedSkillIndex } from "./shared-skill-index.ts"

/** A completed sparse admission proves only its initial EMPTY native main.
 * It never proves an absent supporting event, or a lost custom/restore event.
 * No virtual event ID is persisted or used as a parent of a future event. */
export function sparseStateFromSnapshot(
  index: SharedSkillIndex,
  binding: SharedBodyBinding,
  events: readonly FileEvent[],
  snapshot?: Snapshot,
): ResolvedFileState {
  const selected = events.filter((event) => event.file_id === binding.file_id)
  if (selected.length) return resolveFileState(binding.file_id, selected)
  const acquisition = snapshot?.shared_acquisition
  if (
    snapshot &&
    acquisition?.version === 3 &&
    binding.file_id === index.main.file_id &&
    binding.page_id === index.page_id &&
    binding.path === snapshot.entrypoint &&
    acquisition.source.source_id === index.source_reference &&
    snapshot.record.locator.type === "shared_skill" &&
    snapshot.record.locator.skill_id === index.skill_id
  )
    return {
      file_id: binding.file_id,
      heads: [],
      ownership: {
        kind: "following",
        source_revision: acquisition.source.revision,
        projection: {
          normalization_version: 1,
          sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
      },
    }
  return resolveFileState(binding.file_id, selected)
}
