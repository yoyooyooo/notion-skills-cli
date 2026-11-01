import { fail } from "./model.ts"
import {
  composeSharedFiles,
  type CompositionFile,
  type CompositionOverride,
  type FileProvenance,
} from "./shared-composition.ts"
import type { ResolvedFileState } from "./shared-file-state.ts"

/** Apply explicit immutable placement to the already resolved Base/Mount source tree. */
export function composeSharedFilePlacements(input: {
  readonly source: readonly CompositionFile[]
  readonly overrides: readonly CompositionOverride[]
  readonly bindings: readonly {
    readonly file_id: string
    readonly path: string
    readonly state: ResolvedFileState
  }[]
  readonly entrypoint: string
}) {
  // Validate the complete original provider tree even when an old path will be
  // suppressed. A real native main override supplies the entrypoint if needed.
  const main = input.overrides.find((override) => override.path === input.entrypoint)
  composeSharedFiles({
    base: input.source,
    mounts: [],
    overrides: main === undefined ? [] : [main],
    entrypoint: input.entrypoint,
  })
  const source = new Map(input.source.map((file) => [file.path, file]))
  const suppressed = new Set<string>()
  const following: Array<{
    readonly path: string
    readonly source_path: string
    readonly bytes: Uint8Array
  }> = []
  const customOrigins = new Map<string, string>()
  for (const binding of input.bindings) {
    if (binding.file_id !== binding.state.file_id)
      throw fail("SHARED_PATH_CONFLICT", "File placement and stable binding identities disagree.")
    const placement = binding.state.placement
    if (placement === undefined) continue
    if (
      placement.path !== binding.path ||
      binding.path === input.entrypoint ||
      placement.suppressed_paths.includes(input.entrypoint)
    )
      throw fail(
        "SHARED_PATH_CONFLICT",
        "The shared placement disagrees with its current binding or attempts to move the main file.",
      )
    for (const path of placement.suppressed_paths) suppressed.add(path)
    if (binding.state.ownership.kind === "following") {
      if (placement.source_path === null)
        throw fail(
          "SHARED_SOURCE_FILE_MISSING",
          "A following moved file has no explicit original source path.",
        )
      const original = source.get(placement.source_path)
      if (original === undefined)
        throw fail(
          "SHARED_SOURCE_FILE_MISSING",
          "The exact selected source no longer has this moved file's original path.",
          { file_id: binding.file_id, source_path: placement.source_path, path: binding.path },
        )
      if (placement.source_path !== placement.path) {
        suppressed.add(placement.source_path)
        following.push({
          path: placement.path,
          source_path: placement.source_path,
          bytes: original.bytes,
        })
      }
    } else if (binding.state.ownership.kind === "custom") {
      if (placement.source_path !== null && source.has(placement.source_path))
        customOrigins.set(binding.file_id, placement.source_path)
    } else if (placement.source_path !== null) suppressed.add(placement.source_path)
  }
  const base = [
    ...input.source.filter((file) => !suppressed.has(file.path)),
    ...following.map(({ path, bytes }) => ({ path, bytes })),
  ]
  const result = composeSharedFiles({
    base,
    mounts: [],
    overrides: input.overrides,
    entrypoint: input.entrypoint,
  })
  const movedSource = new Map(following.map((file) => [file.path, file.source_path]))
  const provenance = new Map<string, FileProvenance>()
  for (const [path, original] of result.provenance) {
    const sourcePath = movedSource.get(path)
    if (original.kind === "base" && sourcePath !== undefined)
      provenance.set(path, { kind: "base", source_path: sourcePath })
    else if (original.kind === "custom" && customOrigins.has(original.file_id))
      provenance.set(path, {
        ...original,
        replaces: { kind: "base", source_path: customOrigins.get(original.file_id)! },
      })
    else provenance.set(path, original)
  }
  return { files: result.files, provenance }
}

export function sharedFileSourcePath(path: string, state: ResolvedFileState): string {
  if (state.placement === undefined) return path
  if (state.placement.path !== path || state.placement.source_path === null)
    throw fail(
      "SHARED_SOURCE_FILE_MISSING",
      "This file has no explicit fixed-source path at its current logical location.",
      { file_id: state.file_id, path },
    )
  return state.placement.source_path
}
