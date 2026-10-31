import { fail, SkillsError } from "./model.ts"
import { normalizePath } from "./ref.ts"

export type CompositionFile = {
  readonly path: string
  readonly bytes: Uint8Array
}

export type CompositionMount = {
  /** The empty string mounts files at the output root. */
  readonly mount_path: string
  readonly files: readonly CompositionFile[]
}

export type CompositionOverride =
  | {
      readonly kind: "custom"
      readonly file_id: string
      readonly path: string
      readonly bytes: Uint8Array
    }
  | { readonly kind: "tombstone"; readonly file_id: string; readonly path: string }

export type SourceProvenance =
  | { readonly kind: "base"; readonly source_path: string }
  | { readonly kind: "mount"; readonly mount_path: string; readonly source_path: string }

export type FileProvenance =
  | SourceProvenance
  | {
      readonly kind: "custom"
      readonly file_id: string
      readonly replaces?: SourceProvenance
    }

export type ComposeSharedFilesInput = {
  readonly base: readonly CompositionFile[]
  readonly mounts: readonly CompositionMount[]
  readonly overrides: readonly CompositionOverride[]
  readonly entrypoint: string
}

export type SharedComposition = {
  readonly files: readonly CompositionFile[]
  /** Effective files only, in the same deterministic path order as files. */
  readonly provenance: ReadonlyMap<string, FileProvenance>
}

type SourcedFile = { readonly file: CompositionFile; readonly provenance: SourceProvenance }
type EffectiveFile = { readonly file: CompositionFile; readonly provenance: FileProvenance }
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u

// Conservative equality for destinations with case or Unicode normalization.
// Uppercasing first also joins aliases such as sharp-s/SS and sigma variants.
const portableKey = (path: string): string =>
  path.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC")

function canonicalPath(value: string, label: string): string {
  if (typeof value !== "string" || value === "" || controlCharacters.test(value)) {
    throw fail(
      "INVALID_COMPOSITION_PATH",
      `${label} must be a non-empty relative path without control characters`,
    )
  }
  let path: string
  try {
    path = normalizePath(value)
  } catch (error) {
    if (error instanceof SkillsError) throw error
    throw fail("INVALID_COMPOSITION_PATH", `${label} is not a safe relative path`)
  }
  if (path !== value || path === "" || path === ".") {
    throw fail("INVALID_COMPOSITION_PATH", `${label} must already be canonical`, { path: value })
  }
  for (const segment of path.split("/")) {
    const folded = portableKey(segment)
    if (
      folded === ".git" ||
      folded === ".ntn-skills.json" ||
      folded === "." ||
      folded === ".." ||
      folded.includes("/") ||
      folded.includes("\\") ||
      controlCharacters.test(folded)
    ) {
      throw fail(
        "INVALID_COMPOSITION_PATH",
        `${label} contains a reserved or ambiguous path component`,
        { path },
      )
    }
  }
  return path
}

function fileBytes(value: Uint8Array, path: string): Uint8Array {
  if (!(value instanceof Uint8Array))
    throw fail("INVALID_COMPOSITION_BYTES", "Resolved file content must be Uint8Array", { path })
  return value
}

function overrideId(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    controlCharacters.test(value)
  ) {
    throw fail(
      "INVALID_COMPOSITION_OVERRIDE",
      "Override file_id must be a non-empty, bounded identifier",
    )
  }
  return value
}

function registerSpelling(spellings: Map<string, string>, path: string): void {
  const segments = path.split("/")
  for (let length = 1; length <= segments.length; length += 1) {
    const prefix = segments.slice(0, length).join("/")
    const key = portableKey(prefix)
    const previous = spellings.get(key)
    if (previous !== undefined && previous !== prefix) {
      throw fail(
        "COMPOSITION_PATH_COLLISION",
        "Paths collide after case or Unicode normalization",
        { paths: [previous, prefix] },
      )
    }
    spellings.set(key, prefix)
  }
}

function validateTree(files: Iterable<CompositionFile>): void {
  const paths = new Map<string, string>()
  for (const file of files) paths.set(portableKey(file.path), file.path)
  for (const [key, path] of paths) {
    const segments = key.split("/")
    for (let length = 1; length < segments.length; length += 1) {
      const ancestor = paths.get(segments.slice(0, length).join("/"))
      if (ancestor !== undefined) {
        throw fail("COMPOSITION_PATH_COLLISION", "A file occupies a required directory path", {
          paths: [ancestor, path],
        })
      }
    }
  }
}

/** Compose resolved bytes. This function performs no I/O or content conversion. */
export function composeSharedFiles(input: ComposeSharedFilesInput): SharedComposition {
  const entrypoint = canonicalPath(input.entrypoint, "Main entrypoint")
  const spellings = new Map<string, string>()
  registerSpelling(spellings, entrypoint)
  const sources = new Map<string, SourcedFile>()

  const addSource = (path: string, bytes: Uint8Array, provenance: SourceProvenance): void => {
    registerSpelling(spellings, path)
    if (sources.has(path)) {
      throw fail(
        "COMPOSITION_SOURCE_COLLISION",
        "Base and Mount outputs must have distinct paths",
        { path },
      )
    }
    sources.set(path, { file: { path, bytes: fileBytes(bytes, path) }, provenance })
  }

  for (const file of input.base) {
    const path = canonicalPath(file.path, "Base path")
    addSource(path, file.bytes, { kind: "base", source_path: path })
  }
  for (const mount of input.mounts) {
    const mountPath = mount.mount_path === "" ? "" : canonicalPath(mount.mount_path, "Mount path")
    for (const file of mount.files) {
      const sourcePath = canonicalPath(file.path, "Mounted source path")
      const path = canonicalPath(
        mountPath === "" ? sourcePath : `${mountPath}/${sourcePath}`,
        "Mounted output path",
      )
      addSource(path, file.bytes, { kind: "mount", mount_path: mountPath, source_path: sourcePath })
    }
  }
  // An override must not conceal conflicting upstream providers.
  validateTree(Array.from(sources.values(), ({ file }) => file))

  const effective = new Map<string, EffectiveFile>(sources)
  const overrideIds = new Set<string>()
  const overridePaths = new Set<string>()
  for (const override of input.overrides) {
    const fileId = overrideId(override.file_id)
    const path = canonicalPath(override.path, "Override path")
    registerSpelling(spellings, path)
    if (overrideIds.has(fileId))
      throw fail(
        "COMPOSITION_OVERRIDE_COLLISION",
        "Each File ID may appear only once in overrides",
        { file_id: fileId },
      )
    if (overridePaths.has(path))
      throw fail("COMPOSITION_OVERRIDE_COLLISION", "Multiple overrides target the same path", {
        path,
      })
    overrideIds.add(fileId)
    overridePaths.add(path)
    switch (override.kind) {
      case "tombstone":
        effective.delete(path)
        break
      case "custom": {
        const source = sources.get(path)
        effective.set(path, {
          file: { path, bytes: fileBytes(override.bytes, path) },
          provenance: {
            kind: "custom",
            file_id: fileId,
            ...(source === undefined ? {} : { replaces: source.provenance }),
          },
        })
        break
      }
      default: {
        const exhaustive: never = override
        throw fail(
          "INVALID_COMPOSITION_OVERRIDE",
          `Unsupported override variant: ${String(exhaustive)}`,
        )
      }
    }
  }
  validateTree(Array.from(effective.values(), ({ file }) => file))
  if (!effective.has(entrypoint)) {
    throw fail(
      "COMPOSITION_MISSING_ENTRYPOINT",
      "The main entrypoint must exist in the effective file tree",
      { entrypoint },
    )
  }
  const entries = [...effective.values()].sort((a, b) =>
    a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0,
  )
  return {
    files: entries.map(({ file }) => file),
    provenance: new Map<string, FileProvenance>(
      entries.map(({ file, provenance }) => [file.path, provenance]),
    ),
  }
}
