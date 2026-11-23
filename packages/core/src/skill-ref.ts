/** The side-effect-free reference protocol shared by the CLI, SDK and Broker. */
export const SKILL_REF_VERSION = 2 as const

declare const skillIdBrand: unique symbol
declare const libraryIdBrand: unique symbol
declare const snapshotIdBrand: unique symbol
export type SkillId = string & { readonly [skillIdBrand]: true }
export type LibraryId = string & { readonly [libraryIdBrand]: true }
export type SnapshotId = string & { readonly [snapshotIdBrand]: true }

export interface SkillKey {
  readonly libraryId: LibraryId
  readonly skillId: SkillId
}

export type ReferenceScope =
  | { readonly kind: "context" }
  | { readonly kind: "library"; readonly libraryId: LibraryId }

export type ReferenceSelection =
  | { readonly kind: "current" }
  | { readonly kind: "fixed"; readonly snapshotId: SnapshotId }

/** Empty path means the Skill, whose entrypoint is selected by its metadata. */
export interface ParsedSkillRef {
  readonly skillId: SkillId
  readonly scope: ReferenceScope
  readonly path: string
  readonly selection: ReferenceSelection
}

export interface BoundSkillRef {
  readonly owner: SkillKey
  readonly path: string
  readonly selection: ReferenceSelection
}

export class SkillReferenceError extends Error {
  readonly code: "INVALID_REF" | "INVALID_PATH" | "LIBRARY_CONTEXT_REQUIRED"
  constructor(code: "INVALID_REF" | "INVALID_PATH" | "LIBRARY_CONTEXT_REQUIRED", message: string) {
    super(message)
    this.code = code
    this.name = "SkillReferenceError"
  }
}

function invalid(message: string): never {
  throw new SkillReferenceError("INVALID_REF", message)
}

export function validateSkillId(value: string): SkillId {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,199}$/u.test(value)) {
    return invalid(
      "A Skill ID must be a stable lowercase ASCII identifier, not a display name or alias.",
    )
  }
  return value as SkillId
}

function libraryId(value: string): LibraryId {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(value)) {
    return invalid("A Library ID must be an exact bounded identity.")
  }
  return value as LibraryId
}

function snapshotId(value: string): SnapshotId {
  if (typeof value !== "string" || !/^s_[a-f0-9]{64}$/u.test(value))
    return invalid("Invalid fixed selection identity.")
  return value as SnapshotId
}

export function referenceSelection(snapshot?: string): ReferenceSelection {
  return snapshot === undefined
    ? { kind: "current" }
    : { kind: "fixed", snapshotId: snapshotId(snapshot) }
}

export function createSkillKey(input: {
  readonly libraryId: string
  readonly skillId: string
}): SkillKey {
  return { libraryId: libraryId(input.libraryId), skillId: validateSkillId(input.skillId) }
}

export function sameSkillKey(left: SkillKey, right: SkillKey): boolean {
  return left.libraryId === right.libraryId && left.skillId === right.skillId
}

/** Validate before URL normalization; it must not erase an attempted escape. */
export function normalizeSkillPath(input: string, base = ""): string {
  if (typeof input !== "string" || typeof base !== "string")
    throw new SkillReferenceError("INVALID_PATH", "Skill paths must be strings.")
  if (/[\\\p{Cc}\p{Cf}\p{Cs}]/u.test(input) || input.startsWith("/") || /^[A-Za-z]:/u.test(input)) {
    throw new SkillReferenceError("INVALID_PATH", "A Skill file must use a relative POSIX path.")
  }
  const parts = base ? normalizeSkillPath(base).split("/").slice(0, -1) : []
  for (const part of input.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (parts.length === 0) {
        throw new SkillReferenceError("INVALID_PATH", "The path escapes the skill root.")
      }
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  return parts.join("/")
}

function decodeComponent(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    return invalid("The reference contains invalid percent encoding.")
  }
}

/** Decode URL path segments once without resolving them against a containing file. */
export function decodeSkillPath(input: string): string {
  if (typeof input !== "string") return invalid("A reference path must be a string.")
  return input
    .split("/")
    .map((part) => {
      const decoded = decodeComponent(part)
      if (decoded.includes("/")) return invalid("Encoded slashes cannot change path segments.")
      return decoded
    })
    .join("/")
}

export function parseSkillRef(input: string): ParsedSkillRef {
  if (typeof input !== "string") return invalid("A Skill reference must be a string.")
  const match = /^skill:\/\/([^/?#]+)(?:\/([^?#]*))?(?:\?([^#]*))?$/u.exec(input)
  if (!match) return invalid("Expected skill://<skill-id>[/<path>][?library=<library-id>].")
  const id = validateSkillId(decodeComponent(match[1]!))
  const path = normalizeSkillPath(decodeSkillPath(match[2] ?? ""))
  const parameters = new Map<string, string>()
  for (const pair of (match[3] ?? "").split("&")) {
    if (!pair) {
      if (match[3] !== undefined) return invalid("Empty reference parameters are not allowed.")
      continue
    }
    const separator = pair.indexOf("=")
    if (separator < 0) return invalid("Reference parameters require a value.")
    const name = decodeComponent(pair.slice(0, separator).replaceAll("+", " "))
    const value = decodeComponent(pair.slice(separator + 1).replaceAll("+", " "))
    if ((name !== "library" && name !== "snapshot") || parameters.has(name)) {
      return invalid("Only one library and one snapshot parameter are allowed.")
    }
    parameters.set(name, value)
  }
  const library = parameters.get("library")
  const snapshot = parameters.get("snapshot")
  return {
    skillId: id,
    scope:
      library === undefined
        ? { kind: "context" }
        : { kind: "library", libraryId: libraryId(library) },
    path,
    selection: referenceSelection(snapshot),
  }
}

/** The caller supplies a document's owner or its already-bound entry context. */
export function bindSkillRef(reference: ParsedSkillRef, contextLibraryId?: string): BoundSkillRef {
  const library = reference.scope.kind === "library" ? reference.scope.libraryId : contextLibraryId
  if (library === undefined) {
    throw new SkillReferenceError(
      "LIBRARY_CONTEXT_REQUIRED",
      "A contextual Skill reference needs its containing Library or an explicitly bound entry.",
    )
  }
  return {
    owner: createSkillKey({ libraryId: library, skillId: reference.skillId }),
    path: reference.path,
    selection: reference.selection,
  }
}

export function skillRefPath(reference: ParsedSkillRef | BoundSkillRef): string {
  return reference.path
}

export function skillRefSnapshot(reference: ParsedSkillRef | BoundSkillRef): string | undefined {
  return reference.selection.kind === "fixed" ? reference.selection.snapshotId : undefined
}

export function formatSkillRef(reference: ParsedSkillRef | BoundSkillRef): string {
  const id = "owner" in reference ? reference.owner.skillId : reference.skillId
  const library =
    "owner" in reference
      ? reference.owner.libraryId
      : reference.scope.kind === "library"
        ? reference.scope.libraryId
        : undefined
  const path = normalizeSkillPath(reference.path)
  const parameters: string[] = []
  if (library !== undefined) parameters.push(`library=${encodeURIComponent(libraryId(library))}`)
  if (reference.selection.kind === "fixed") {
    parameters.push(`snapshot=${snapshotId(reference.selection.snapshotId)}`)
  }
  return `skill://${validateSkillId(id)}${path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : ""}${parameters.length ? `?${parameters.join("&")}` : ""}`
}

export function formatSkillIdentity(input: {
  readonly libraryId: string
  readonly skillId: string
}): string {
  return formatSkillRef({ owner: createSkillKey(input), path: "", selection: { kind: "current" } })
}

export function parseSkillIdentity(input: string): SkillKey {
  const reference = parseSkillRef(input)
  if (
    reference.scope.kind !== "library" ||
    reference.path ||
    reference.selection.kind !== "current"
  ) {
    return invalid(
      "A complete Skill identity is a current root reference with an explicit Library.",
    )
  }
  const owner = createSkillKey({ libraryId: reference.scope.libraryId, skillId: reference.skillId })
  if (formatSkillIdentity(owner) !== input)
    return invalid("The Skill identity must use its canonical encoding.")
  return owner
}
