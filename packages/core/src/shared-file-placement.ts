import { fail } from "./model.ts"
import {
  planSharedFiles,
  type CompositionFile,
  type CompositionOverride,
  type CompositionOverrideMetadata,
  type CompositionPath,
  type FileProvenance,
  type SharedComposition,
  type SharedCompositionPlan,
  type SourceProvenance,
} from "./shared-composition.ts"
import type { ResolvedFileState } from "./shared-file-state.ts"

export type PlanSharedFilePlacementsInput = {
  readonly source: readonly CompositionPath[]
  readonly overrides: readonly CompositionOverrideMetadata[]
  readonly bindings: readonly {
    readonly file_id: string
    readonly path: string
    readonly state: ResolvedFileState
  }[]
  readonly entrypoint: string
}

export type SharedFilePlacementPlan = SharedCompositionPlan & {
  /** Original source paths needed by effective source outputs; excludes extra synthesis inputs. */
  readonly source_paths: readonly string[]
}

function sourcePath(provenance: SourceProvenance): string {
  return provenance.kind === "base" || provenance.mount_path === ""
    ? provenance.source_path
    : `${provenance.mount_path}/${provenance.source_path}`
}

/** Resolve ownership and placement from the complete source directory without content I/O. */
export function planSharedFilePlacements(
  input: PlanSharedFilePlacementsInput,
): SharedFilePlacementPlan {
  // Validate the complete original provider tree even when an old path will be
  // suppressed. A real native main override supplies the entrypoint if needed.
  const main = input.overrides.find((override) => override.path === input.entrypoint)
  planSharedFiles({
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
        })
      }
    } else if (binding.state.ownership.kind === "custom") {
      if (placement.source_path !== null && source.has(placement.source_path))
        customOrigins.set(binding.file_id, placement.source_path)
    } else if (placement.source_path !== null) suppressed.add(placement.source_path)
  }
  const base = [
    ...input.source.filter((file) => !suppressed.has(file.path)),
    ...following.map(({ path }) => ({ path })),
  ]
  const result = planSharedFiles({
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
  const sourcePaths = new Set<string>()
  for (const origin of provenance.values())
    if (origin.kind !== "custom") sourcePaths.add(sourcePath(origin))
  return { paths: result.paths, provenance, source_paths: [...sourcePaths].sort() }
}

/** Assemble real bytes from the same placement plan; an omitted source is never an empty file. */
export function composeSharedFilePlacements(
  input: Omit<PlanSharedFilePlacementsInput, "source" | "overrides"> & {
    readonly source: readonly CompositionFile[]
    readonly overrides: readonly CompositionOverride[]
    /** Complete immutable directory when source contains only the requested real bytes. */
    readonly manifest?: readonly CompositionPath[]
  },
): SharedComposition {
  const manifest = input.manifest ?? input.source
  const plan = planSharedFilePlacements({ ...input, source: manifest })
  const sourcePaths = new Set(manifest.map((file) => file.path))
  const sources = new Map<string, CompositionFile>()
  for (const file of input.source) {
    if (!sourcePaths.has(file.path))
      throw fail("INVALID_SOURCE", "Supplied source bytes are absent from the complete manifest.", {
        path: file.path,
      })
    if (sources.has(file.path))
      throw fail("COMPOSITION_SOURCE_COLLISION", "Fixed source byte paths must be unique.", {
        path: file.path,
      })
    if (!(file.bytes instanceof Uint8Array))
      throw fail("INVALID_COMPOSITION_BYTES", "Resolved file content must be Uint8Array", {
        path: file.path,
      })
    sources.set(file.path, file)
  }
  const custom = new Map<string, { readonly path: string; readonly bytes: Uint8Array }>()
  for (const override of input.overrides)
    if (override.kind === "custom") {
      if (!(override.bytes instanceof Uint8Array))
        throw fail("INVALID_COMPOSITION_BYTES", "Resolved file content must be Uint8Array", {
          path: override.path,
        })
      custom.set(override.file_id, override)
    }
  return {
    files: plan.paths.map((path) => {
      const origin = plan.provenance.get(path)
      if (origin === undefined)
        throw fail("INVALID_SOURCE", "An effective file has no planned provenance.", { path })
      if (origin.kind === "custom") {
        const file = custom.get(origin.file_id)
        if (file === undefined || file.path !== path)
          throw fail("INVALID_COMPOSITION_OVERRIDE", "A planned custom file has no exact bytes.", {
            file_id: origin.file_id,
            path,
          })
        return { path, bytes: file.bytes }
      }
      const originalPath = sourcePath(origin)
      const file = sources.get(originalPath)
      if (file === undefined)
        throw fail("SHARED_SOURCE_FILE_MISSING", "Required fixed source bytes are unavailable.", {
          path,
          source_path: originalPath,
        })
      return { path, bytes: file.bytes }
    }),
    provenance: plan.provenance,
  }
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
