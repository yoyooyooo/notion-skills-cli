import { pageId } from "./notion-id.ts"
import { fail } from "./model.ts"
import {
  bindSkillRef,
  formatSkillIdentity,
  formatSkillRef,
  normalizeSkillPath,
  parseSkillIdentity,
  parseSkillRef,
  referenceSelection,
  SkillReferenceError,
  skillRefSnapshot,
  type ParsedSkillRef,
} from "./skill-ref.ts"

export * from "./skill-ref.ts"
export type SkillRef = ParsedSkillRef

/** Translate errors at the Core boundary; the protocol has one implementation. */
function protocol<A>(read: () => A): A {
  try {
    return read()
  } catch (error) {
    if (error instanceof SkillReferenceError) throw fail(error.code, error.message)
    throw error
  }
}

export function normalizePath(input: string, base = ""): string {
  return protocol(() => normalizeSkillPath(input, base))
}

export function parseRef(input: string): SkillRef {
  return protocol(() => parseSkillRef(input))
}

/** Only a complete canonical Skill identity can produce a machine file ref. */
export function fileRef(identity: string, path: string, snapshot?: string): string {
  return protocol(() => {
    const owner = parseSkillIdentity(identity)
    return formatSkillRef({
      owner,
      path,
      selection: referenceSelection(snapshot),
    })
  })
}

export function resolveRef(base: string, relative: string): string {
  return protocol(() => {
    const parsed = bindSkillRef(parseSkillRef(base))
    if (relative.startsWith("skill://")) {
      return formatSkillRef(bindSkillRef(parseSkillRef(relative), parsed.owner.libraryId))
    }
    if (relative.includes("?") || relative.includes("#") || /^[a-z]+:/i.test(relative)) {
      throw fail("INVALID_PATH", "Only relative file paths can be resolved within a skill.")
    }
    return formatSkillRef({ ...parsed, path: normalizeSkillPath(relative, parsed.path) })
  })
}

export { pageId } from "./notion-id.ts"

type TargetPath = { readonly path?: string }
export type SkillTarget = TargetPath &
  (
    | {
        readonly kind: "skill"
        readonly reference: ParsedSkillRef
        /** A canonical root URI, contextual until the entry scope is bound. */
        readonly selector: string
        readonly snapshot?: string
      }
    | { readonly kind: "page"; readonly selector: string; readonly snapshot?: never }
    | { readonly kind: "snapshot"; readonly selector: ""; readonly snapshot: string }
  )

export function parseTarget(input: string, path?: string): SkillTarget {
  if (!input.trim() || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(input))
    throw fail("INVALID_ARGUMENT", "Provide a nonempty Skill target without control characters.")
  if (/^(?:shared_skill|notion_page|notion_subscription|upstream):/u.test(input))
    throw fail(
      "CURRENT_TARGET_REQUIRED",
      "Use a current skill:// reference or a physical Notion page address.",
    )
  if (input.startsWith("s_")) {
    if (!/^s_[a-f0-9]{64}$/.test(input)) throw fail("INVALID_SNAPSHOT", "Invalid snapshot ID.")
    return {
      kind: "snapshot",
      selector: "",
      snapshot: input,
      ...(path === undefined ? {} : { path: normalizePath(path) }),
    }
  }
  const physical = input.startsWith("skill://") ? undefined : pageId(input)
  if (physical !== undefined) {
    return {
      kind: "page",
      selector: physical,
      ...(path === undefined ? {} : { path: normalizePath(path) }),
    }
  }
  const reference = parseRef(input.startsWith("skill://") ? input : `skill://${input}`)
  if (path !== undefined && reference.path !== "")
    throw fail("INVALID_ARGUMENT", "The target already contains a file path; omit --path.")
  const selectedPath = path === undefined ? reference.path : normalizePath(path)
  const snapshot = skillRefSnapshot(reference)
  return {
    kind: "skill",
    reference: { ...reference, path: selectedPath },
    selector: protocol(() =>
      formatSkillRef({ ...reference, path: "", selection: { kind: "current" } }),
    ),
    ...(selectedPath === "" ? {} : { path: selectedPath }),
    ...(snapshot === undefined ? {} : { snapshot }),
  }
}

export function bindTarget(target: SkillTarget, contextLibraryId?: string): SkillTarget {
  if (target.kind !== "skill") return target
  return protocol(() => {
    const bound = bindSkillRef(target.reference, contextLibraryId)
    return {
      ...target,
      selector: formatSkillIdentity(bound.owner),
      reference: {
        ...target.reference,
        scope: { kind: "library", libraryId: bound.owner.libraryId },
      },
    }
  })
}
