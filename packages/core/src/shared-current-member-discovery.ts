import { Effect } from "effect"
import type { ImportFile } from "./import.ts"
import { entrypointFor, fail, property, SkillsError, type ContentKind } from "./model.ts"
import {
  validatePortableRelations,
  type PortableRelations,
  type PortableSkill,
} from "./portable.ts"
import { fileRef, normalizePath } from "./ref.ts"
import {
  bindSkillRef,
  decodeSkillPath,
  formatSkillIdentity,
  formatSkillRef,
  parseSkillRef,
  type BoundSkillRef,
} from "./skill-ref.ts"
import { queryCurrentSkillIndex, readCurrentSkillMetadata } from "./shared-current-index.ts"
import { queryCurrentSkillIdentity } from "./shared-current-skill-target.ts"
import {
  assertSharedFileReferences,
  mapSharedMarkdownLinks,
  sharedMarkdownLinks,
  type SharedMarkdownLink,
} from "./shared-file-references.ts"
import type { SharedLibrary } from "./shared-library-model.ts"

export type CurrentMemberBindings = {
  readonly version: 1
  readonly root: string
  readonly targets: readonly { readonly path: string; readonly ref: string }[]
}
export type CurrentMemberInput = {
  readonly skill_id: string
  readonly kind: ContentKind
  readonly name: string
  readonly description: string
  readonly files: readonly ImportFile[]
  readonly relations?: PortableRelations
}
type Evidence = { readonly from: string; readonly line: number; readonly href: string }
export type ConfirmedCurrentMember = Evidence & {
  readonly ref: string
  readonly member: string
  readonly rewritten: boolean
}
export type UnresolvedCurrentMember = Evidence & {
  readonly reason: string
  readonly blocks_import: boolean
}
type Candidate = {
  readonly link: SharedMarkdownLink
  readonly ref: string
  readonly rewrite: boolean
}
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()
export const MAX_CURRENT_MEMBER_CANDIDATES = 100
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError ? error : fail("MEMBERS_PLAN_INVALID", "Invalid Members input."),
  })
const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw fail("MEMBERS_BINDINGS_INVALID", "Bindings must contain JSON objects.")
  return value as Record<string, unknown>
}
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw fail("MEMBERS_BINDINGS_INVALID", "Bindings contain an unknown field.")
}
const treePath = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !value ||
    normalizePath(value) !== value ||
    /[\p{Cc}\p{Cf}\p{Cs}*?<>#]/u.test(value)
  )
    throw fail("MEMBERS_BINDINGS_INVALID", "Bindings require exact relative POSIX paths.")
  return value
}

/** These paths are explicit identity declarations, never names to search for. */
export function parseCurrentMemberBindings(input: unknown): CurrentMemberBindings {
  const value = record(input)
  exactKeys(value, ["version", "root", "targets"])
  if (value.version !== 1 || !Array.isArray(value.targets) || value.targets.length > 10_000)
    throw fail(
      "MEMBERS_BINDINGS_INVALID",
      "Bindings require version 1 and a bounded targets array.",
    )
  return {
    version: 1,
    root: treePath(value.root),
    targets: value.targets.map((raw) => {
      const target = record(raw)
      exactKeys(target, ["path", "ref"])
      if (typeof target.ref !== "string")
        throw fail("MEMBERS_BINDINGS_INVALID", "Each binding requires an exact Skill reference.")
      return { path: treePath(target.path), ref: target.ref }
    }),
  }
}

function exactCurrentRef(libraryId: string, ref: string): BoundSkillRef {
  const parsed = bindSkillRef(parseSkillRef(ref), libraryId)
  if (parsed.selection.kind !== "current")
    throw fail("MEMBERS_REF_UNCONFIRMED", "historical_reference")
  validatePortableRelations({
    version: 1,
    ownership: "notion",
    library_id: libraryId,
    members: [formatSkillIdentity(parsed.owner)],
  })
  return parsed
}

/** Keep source offsets and refuse destinations also used by images or code.
 * Both relative compilation and explicit Library rebinding use this boundary. */
export function currentImportMarkdownLinks(path: string, original: string) {
  const visible = original.replace(/^(?: {4}|\t)[^\n]*/gmu, (line) => " ".repeat(line.length))
  const originalLinks = sharedMarkdownLinks(path, original)
  const links = sharedMarkdownLinks(path, visible)
  const originalUses = new Map<number, { count: number; image: boolean }>()
  const selectedUses = new Map<number, number>()
  for (const link of originalLinks) {
    if (link.destination_start === undefined) continue
    const previous = originalUses.get(link.destination_start)
    originalUses.set(link.destination_start, {
      count: (previous?.count ?? 0) + 1,
      image: previous?.image === true || link.kind !== "link",
    })
  }
  for (const link of links)
    if (link.destination_start !== undefined)
      selectedUses.set(link.destination_start, (selectedUses.get(link.destination_start) ?? 0) + 1)
  const protectedDestinations = new Set<number>()
  for (const [start, count] of selectedUses) {
    const originalUse = originalUses.get(start)
    if (originalUse?.image || originalUse?.count !== count) protectedDestinations.add(start)
  }
  return { links, protectedDestinations }
}

function inspectLinks(input: CurrentMemberInput, bindings?: CurrentMemberBindings) {
  const candidates: Candidate[] = []
  const unresolved: UnresolvedCurrentMember[] = []
  const files = new Set(input.files.map((file) => file.path))
  const paths = new Map<string, readonly string[]>()
  for (const target of bindings?.targets ?? [])
    paths.set(target.path, [...(paths.get(target.path) ?? []), target.ref])
  const reject = (link: SharedMarkdownLink, reason: string, blocks_import = true) =>
    unresolved.push({ from: link.from, line: link.line, href: link.href, reason, blocks_import })
  for (const file of input.files) {
    if (!/\.(md|markdown)$/iu.test(file.path)) continue
    const original = decoder.decode(file.bytes)
    const { links, protectedDestinations } = currentImportMarkdownLinks(file.path, original)
    for (const link of links) {
      if (link.kind !== "link") continue
      const href = link.destination
      if (href.startsWith("skill://")) {
        candidates.push({ link, ref: href, rewrite: false })
        continue
      }
      if (
        !href ||
        href.startsWith("#") ||
        href.startsWith("//") ||
        /^[a-z][a-z\d+.-]*:/iu.test(href)
      )
        continue
      const rawPath = href.split(/[?#]/u)[0]!
      let local: string
      try {
        local = decodeSkillPath(rawPath)
      } catch {
        reject(link, "invalid_path")
        continue
      }
      if (/[\p{Cc}\p{Cf}\p{Cs}*<>]/u.test(local) || local.startsWith("/") || local.includes("\\")) {
        reject(link, "unsupported_path")
        continue
      }
      let within: string | undefined
      try {
        within = normalizePath(local, file.path)
      } catch {
        // An escaping path needs a separately declared source-tree identity.
      }
      if (within !== undefined) {
        if (
          (within === "" && files.size > 0) ||
          files.has(within) ||
          [...files].some((path) => path.startsWith(within + "/"))
        )
          continue
        reject(link, "missing_local_file")
        continue
      }
      if (href !== rawPath) {
        reject(link, "cross_skill_fragment_or_query")
        continue
      }
      if (bindings === undefined) {
        reject(link, "missing_identity_binding")
        continue
      }
      let targetPath: string
      try {
        targetPath = normalizePath(local, `${bindings.root}/${file.path}`)
      } catch {
        reject(link, "outside_declared_tree")
        continue
      }
      const refs = paths.get(targetPath) ?? []
      if (refs.length !== 1) {
        reject(link, refs.length ? "ambiguous_identity_binding" : "missing_identity_binding")
        continue
      }
      if (!link.rewritable) {
        reject(link, "link_form_cannot_be_rewritten")
        continue
      }
      if (
        link.destination_start !== undefined &&
        protectedDestinations.has(link.destination_start)
      ) {
        reject(link, "shared_destination_has_unselected_uses")
        continue
      }
      candidates.push({ link, ref: refs[0]!, rewrite: true })
    }
  }
  return { candidates, unresolved }
}

function confirmTarget(
  library: SharedLibrary,
  ref: string,
  planned: readonly CurrentMemberInput[] = [],
) {
  return Effect.gen(function* () {
    const parsed = yield* checked(() => exactCurrentRef(library.library_id, ref))
    const skillId = parsed.owner.skillId
    const future = planned.filter((target) => target.skill_id === skillId)
    if (future.length > 1)
      return yield* Effect.fail(fail("MEMBERS_REF_UNCONFIRMED", "ambiguous_batch_identity"))
    const proposed = future[0]
    if (proposed !== undefined) {
      const path = parsed.path || entrypointFor(proposed.kind)
      if (
        proposed.kind !== "skill" ||
        proposed.files.filter((file) => file.path === path).length !== 1
      )
        return yield* Effect.fail(fail("MEMBERS_REF_UNCONFIRMED", "batch_target_file_unconfirmed"))
      return {
        member: formatSkillIdentity(parsed.owner),
        ref: fileRef(formatSkillIdentity(parsed.owner), path),
      }
    }
    const raw = yield* queryCurrentSkillIdentity(library, skillId)
    if (raw === undefined)
      return yield* Effect.fail(fail("MEMBERS_REF_UNCONFIRMED", "target_missing"))
    const page = property(raw).id
    if (typeof page !== "string")
      return yield* Effect.fail(fail("MEMBERS_REF_UNCONFIRMED", "target_identity_invalid"))
    const metadata = yield* readCurrentSkillMetadata(library, page, raw)
    if (metadata.kind !== "skill" || !metadata.enabled || metadata.state.state !== "ready")
      return yield* Effect.fail(fail("MEMBERS_REF_UNCONFIRMED", "target_not_enabled_ready_skill"))
    const path = parsed.path || metadata.main.path
    const files =
      path === metadata.main.path
        ? [metadata.main]
        : (yield* queryCurrentSkillIndex(library, page, raw)).files
    const found = files.find((file) => file.path === path)
    if (found === undefined)
      return yield* Effect.fail(fail("MEMBERS_REF_UNCONFIRMED", "target_file_unconfirmed"))
    return {
      member: formatSkillIdentity(parsed.owner),
      ref: fileRef(formatSkillIdentity(parsed.owner), path),
    }
  })
}

const unconfirmedCodes = new Set([
  "MEMBERS_REF_UNCONFIRMED",
  "INVALID_REF",
  "INVALID_PATH",
  "INVALID_ARGUMENT",
  "PORTABLE_RELATION_SCOPE",
  "PORTABLE_RELATION_INVALID",
  "SHARED_SKILL_ID_CONFLICT",
  "CURRENT_INDEX_INVALID",
  "CURRENT_SCHEMA_REQUIRED",
  "SHARED_INVALID",
  "CURRENT_SKILL_MANAGEMENT_CONFLICT",
  "CURRENT_SKILL_MANAGEMENT_INVALID",
  "MEMBERS_PLAN_INVALID",
])

/** Read-only identity proof. Only a caller-owned portable copy is rewritten. */
export function planCurrentMembers(
  library: SharedLibrary,
  input: CurrentMemberInput,
  options: {
    readonly existing: boolean
    readonly bindings?: CurrentMemberBindings
    /** Exact, admitted creations in this explicit batch. The writer must still
     * observe all of them ready before applying any planned relationship. */
    readonly plannedTargets?: readonly CurrentMemberInput[]
  },
) {
  return Effect.gen(function* () {
    const scanned = yield* checked(() => inspectLinks(input, options.bindings))
    const confirmed: ConfirmedCurrentMember[] = []
    const unresolved = [...scanned.unresolved]
    const outcomes = new Map<
      string,
      { readonly member: string; readonly ref: string } | { readonly reason: string }
    >()
    const changes = new Map<string, Map<string, string>>()
    const self = formatSkillIdentity({ libraryId: library.library_id, skillId: input.skill_id })
    for (const candidate of scanned.candidates) {
      let outcome = outcomes.get(candidate.ref)
      if (outcome === undefined) {
        if (outcomes.size >= MAX_CURRENT_MEMBER_CANDIDATES) {
          unresolved.push({
            from: candidate.link.from,
            line: candidate.link.line,
            href: candidate.link.href,
            reason: "candidate_limit",
            blocks_import: candidate.rewrite,
          })
          continue
        }
        const result = yield* confirmTarget(library, candidate.ref, options.plannedTargets).pipe(
          Effect.result,
        )
        if (result._tag === "Failure") {
          if (!unconfirmedCodes.has(result.failure.code)) return yield* Effect.fail(result.failure)
          outcome = {
            reason:
              result.failure.code === "MEMBERS_REF_UNCONFIRMED"
                ? result.failure.message
                : result.failure.code.toLowerCase(),
          }
        } else outcome = result.success
        outcomes.set(candidate.ref, outcome)
      }
      const evidence = {
        from: candidate.link.from,
        line: candidate.link.line,
        href: candidate.link.href,
      }
      if ("reason" in outcome || outcome.member === self) {
        unresolved.push({
          ...evidence,
          reason: "reason" in outcome ? outcome.reason : "self_reference",
          blocks_import: candidate.rewrite,
        })
        continue
      }
      confirmed.push({ ...evidence, ...outcome, rewritten: candidate.rewrite })
      if (candidate.rewrite) {
        const byHref = changes.get(candidate.link.from) ?? new Map<string, string>()
        const target = parseSkillRef(outcome.ref)
        byHref.set(
          `${candidate.link.line}:${candidate.link.href}`,
          formatSkillRef({
            ...target,
            scope: { kind: "context" },
          }),
        )
        changes.set(candidate.link.from, byHref)
      }
    }
    const files = yield* checked(() =>
      input.files.map((file) => {
        const selected = changes.get(file.path)
        if (selected === undefined) return file
        return {
          ...file,
          bytes: encoder.encode(
            mapSharedMarkdownLinks(file.path, decoder.decode(file.bytes), (link) =>
              link.kind === "link" && link.rewritable
                ? (selected.get(`${link.line}:${link.href}`) ?? link.href)
                : link.href,
            ),
          ),
        }
      }),
    )
    const member_policy =
      input.relations?.members !== undefined
        ? "explicit"
        : options.existing
          ? "preserve_existing"
          : input.kind === "prompt"
            ? "not_applicable"
            : "first_creation"
    const members = [...new Set(confirmed.map((item) => item.member))].sort()
    const relations =
      member_policy === "first_creation" && members.length > 0
        ? {
            ...(input.relations ?? {
              version: 1 as const,
              ownership: "notion" as const,
              library_id: library.library_id,
            }),
            members,
          }
        : input.relations
    const validation = yield* checked(() => assertSharedFileReferences(files)).pipe(Effect.result)
    if (validation._tag === "Failure" && !unresolved.some((item) => item.blocks_import))
      unresolved.push({
        from: "",
        line: 0,
        href: "",
        reason: validation.failure.code.toLowerCase(),
        blocks_import: true,
      })
    const portable: PortableSkill = {
      kind: input.kind,
      name: input.name,
      description: input.description,
      main: entrypointFor(input.kind),
      files,
      ...(relations === undefined ? {} : { relations }),
    }
    return {
      skill_id: input.skill_id,
      member_policy,
      confirmed,
      unresolved,
      importable: validation._tag === "Success" && !unresolved.some((item) => item.blocks_import),
      ...(relations === undefined ? {} : { relations }),
      portable,
    }
  })
}
