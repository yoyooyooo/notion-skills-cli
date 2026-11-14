import { Effect } from "effect"
import { fail, property, SkillsError, type SharedSkillRecord, type Source } from "./model.ts"
import { Notion } from "./notion.ts"
import { fileRef, pageId } from "./ref.ts"
import { sharedRecordFromPage } from "./shared-content.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import {
  querySharedMetadataInventory,
  type CompleteSharedMetadataInventory,
} from "./shared-metadata-inventory.ts"
import {
  nativeNotionPageId,
  nativeReferenceTags,
  type SharedFileLink,
} from "./shared-native-file-content.ts"
import type { NativeReference, NativeReferenceIndex } from "./shared-native-reference-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import type { SharedBodyBinding } from "./shared-skill-index.ts"
import { fileRecord, type FileRecord } from "./skill-file-index.ts"
import { sha256 } from "./store.ts"
import { mapMarkdownLinks, readLinkBlocks } from "./typed-links.ts"
import { referenceProse } from "./shared-file-references.ts"
import {
  nativeAliasTargets,
  validateNativeBodyCompletion,
  type NativeBodyCompletion,
} from "./shared-native-body-completion.ts"

export interface NativeReferenceSource {
  readonly path: string
  readonly markdown: string
  /** Exact native observation, before consumer projection. */
  readonly body_sha256: string
  readonly page_id?: string
  readonly native_body_completion?: NativeBodyCompletion
}
export type NativeMetadataInventory = CompleteSharedMetadataInventory
type Candidate = {
  from: string
  href: string
  page_id: string
  block_id?: string
  source_form?: "link_to_page"
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
function checked<A>(run: () => A): Effect.Effect<A, SkillsError> {
  return Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_REFERENCE_INVALID", "Native reference metadata could not be decoded."),
  })
}

function inventory(
  library: SharedLibrary,
  kind: "skills" | "files",
  supplied?: {
    readonly data_source_id: string
    readonly complete: boolean
    readonly pages: readonly unknown[]
  },
) {
  return Effect.gen(function* () {
    const source = library[kind]
    if (supplied !== undefined) {
      if (supplied.data_source_id !== source.data_source_id)
        return yield* Effect.fail(
          fail("SHARED_REFERENCE_SCOPE", "The reference inventory belongs to another data source."),
        )
      return supplied.pages
    }
    return (yield* querySharedMetadataInventory(library, kind)).pages
  })
}

function ownerOfFile(raw: unknown, library: SharedLibrary) {
  const properties = Object.values(property(property(raw).properties)).map(property)
  const relations = properties.filter((value) => value.id === library.files.property_ids.Skill)
  const relation = relations[0]
  if (
    relations.length !== 1 ||
    relation?.type !== "relation" ||
    !Array.isArray(relation.relation) ||
    relation.relation.length !== 1 ||
    (relation.has_more !== undefined && relation.has_more !== false)
  )
    throw fail(
      "SHARED_REFERENCE_INVALID",
      "A referenced File must have exactly one complete native owner relation.",
    )
  const owner = property(relation.relation[0]).id
  const id = typeof owner === "string" ? pageId(owner) : undefined
  if (id === undefined)
    throw fail(
      "SHARED_REFERENCE_INVALID",
      "The referenced File owner is not an exact page identity.",
    )
  return id
}

function target(
  owner: SharedSkillRecord,
  candidate: Candidate,
  file?: SharedBodyBinding | FileRecord,
  verifiedFile = false,
): NativeReference {
  const path = file?.path ?? owner.entrypoint
  return {
    from: candidate.from,
    href: candidate.href,
    id:
      file === undefined
        ? owner.id
        : `shared_file:${encodeURIComponent(owner.locator.library_id)}:${encodeURIComponent(owner.locator.skill_id)}:${encodeURIComponent(file.file_id)}`,
    ref: fileRef(owner.id, path, undefined, file?.file_id),
    kind: file === undefined ? "skill" : "file",
    name: file === undefined ? owner.name : file.path,
    description: owner.description,
    availability: !owner.enabled
      ? "disabled"
      : file !== undefined && !verifiedFile
        ? "metadata_only"
        : "available",
    library_id: owner.locator.library_id,
    skill_id: owner.locator.skill_id,
    skill_page_id: owner.locator.page_id,
    page_id: file?.page_id ?? owner.locator.page_id,
    ...(file === undefined ? {} : { file_id: file.file_id }),
    path,
    ...(candidate.block_id === undefined
      ? {}
      : { block_id: candidate.block_id, source_form: candidate.source_form }),
  }
}

/** Compile only authored native identities. Inventory reads stay inside this
 * registered library and never fetch a linked target body or register a page. */
export function compileSharedNativeReferences(input: {
  readonly library: SharedLibrary
  readonly record: SharedSkillRecord
  readonly files: readonly NativeReferenceSource[]
  readonly bindings: readonly SharedBodyBinding[]
  readonly relations: unknown
  readonly inventory?: {
    readonly skills?: {
      readonly data_source_id: string
      readonly complete: boolean
      readonly pages: readonly unknown[]
    }
    readonly files?: {
      readonly data_source_id: string
      readonly complete: boolean
      readonly pages: readonly unknown[]
    }
  }
}) {
  return Effect.gen(function* () {
    const candidates = new Map<string, Candidate>()
    const linkedPages = new Map<string, ReadonlySet<string>>()
    const completions = new Map<string, NativeBodyCompletion>()
    const api = yield* Notion
    for (const source of input.files) {
      const tags = yield* checked(() => nativeReferenceTags(source.markdown))
      const pages = new Set<string>()
      if (
        source.native_body_completion === undefined &&
        /<unknown(?:\s|\/?>)/iu.test(referenceProse(source.markdown))
      )
        return yield* Effect.fail(
          fail(
            "BODY_INCOMPLETE",
            "An unknown native export node has no retained completion proof.",
          ),
        )
      if (source.native_body_completion !== undefined) {
        const completion = source.native_body_completion
        if (source.page_id !== completion.page_id)
          return yield* Effect.fail(
            fail("SHARED_REFERENCE_INVALID", "Native alias evidence requires its exact body page."),
          )
        yield* checked(() =>
          validateNativeBodyCompletion(source.markdown, completion, {
            page_id: source.page_id,
            body_sha256: source.body_sha256,
          }),
        )
        if ((yield* sha256(source.markdown)) !== completion.body_sha256)
          return yield* Effect.fail(
            fail(
              "SHARED_REFERENCE_INVALID",
              "Native alias evidence does not match the exact authored body.",
            ),
          )
        completions.set(source.path, completion)
        for (const block of completion.inventory)
          if (block.type === "link_to_page" && block.target_page_id !== undefined)
            pages.add(block.target_page_id)
        for (const alias of yield* checked(() => nativeAliasTargets(source.markdown, completion)))
          candidates.set(JSON.stringify([source.path, alias.href]), {
            from: source.path,
            href: alias.href,
            page_id: alias.page_id,
            block_id: alias.block_id,
            source_form: "link_to_page",
          })
      }
      // Native <page> is normally a child page. Only ambiguous actual tags
      // justify a block read, and child page bodies remain outside this walk.
      if (
        source.native_body_completion === undefined &&
        source.page_id !== undefined &&
        tags.some((tag) => tag.kind === "page")
      ) {
        const blocks = yield* readLinkBlocks(source.page_id, api, { structureEvidence: true })
        for (const block of blocks) {
          if (block.type !== "link_to_page") continue
          const link = property(block.link_to_page)
          if (link.type !== "page_id") continue
          const id = typeof link.page_id === "string" ? pageId(link.page_id) : undefined
          if (id === undefined)
            return yield* Effect.fail(
              fail(
                "SHARED_REFERENCE_INVALID",
                "A native Link to page block has no exact page identity.",
              ),
            )
          pages.add(id)
        }
      }
      linkedPages.set(source.path, pages)
      const remember = (href: string) => {
        const id = nativeNotionPageId(href)
        if (id !== undefined)
          candidates.set(JSON.stringify([source.path, href]), {
            from: source.path,
            href,
            page_id: id,
          })
        return href
      }
      yield* checked(() => mapMarkdownLinks(source.markdown, remember))
      for (const tag of tags)
        if (tag.kind === "mention" || pages.has(nativeNotionPageId(tag.href)!)) remember(tag.href)
    }
    if (candidates.size === 0)
      return { linkedPages, completions, links: [] as readonly SharedFileLink[], index: undefined }
    const ownFiles = new Map<string, SharedBodyBinding>()
    const ownLogicalFiles = new Set<string>()
    for (const file of input.bindings) {
      if (file.skill_page_id !== input.record.locator.page_id)
        return yield* Effect.fail(
          fail("SHARED_REFERENCE_SCOPE", "A current File binding belongs to another owner."),
        )
      if (ownFiles.has(file.page_id) || ownLogicalFiles.has(file.file_id))
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_ID_CONFLICT",
            "One owner repeats a logical File or physical page binding.",
          ),
        )
      ownFiles.set(file.page_id, file)
      ownLogicalFiles.add(file.file_id)
    }
    const external = [...candidates.values()].filter(
      (value) => value.page_id !== input.record.locator.page_id && !ownFiles.has(value.page_id),
    )
    const skills = new Map<string, SharedSkillRecord>([
      [input.record.locator.page_id, input.record],
    ])
    const skillClaims = new Map<string, Set<string>>([
      [input.record.id, new Set([input.record.locator.page_id])],
    ])
    const files = new Map<string, FileRecord>()
    const fileClaims = new Map<string, Set<string>>()
    // File identity is scoped to its exact owner in this authorized library.
    // Duplicate logical Skill claims are checked separately before a target is emitted.
    const fileIdentity = (file: Pick<FileRecord, "skill_page_id" | "file_id">) =>
      canonicalSharedJson([file.skill_page_id, file.file_id])
    if (external.length > 0) {
      const source: Source = {
        alias: input.library.library_id,
        title: "",
        role: "content",
        database_id: input.library.skills.database_id,
        data_source_ids: [input.library.skills.data_source_id],
        shared_library: input.library,
      }
      const wanted = new Set(external.map((value) => value.page_id))
      const skillPages = yield* inventory(input.library, "skills", input.inventory?.skills)
      const seenSkillPages = new Set<string>()
      for (const raw of skillPages) {
        const id =
          typeof property(raw).id === "string" ? pageId(String(property(raw).id)) : undefined
        const record = yield* checked(() => {
          try {
            const observed = sharedRecordFromPage(raw, source, input.library.skills.data_source_id)
            // A current selected-page read is newer than its directory observation.
            return observed.locator.page_id === input.record.locator.page_id
              ? input.record
              : observed
          } catch (error) {
            if ((!id || !wanted.has(id)) && error instanceof SkillsError) return undefined
            throw error
          }
        })
        if (record === undefined) continue
        if (seenSkillPages.has(record.locator.page_id))
          return yield* Effect.fail(
            fail("SHARED_REFERENCE_INCOMPLETE", "Reference inventory repeats a Skill page."),
          )
        seenSkillPages.add(record.locator.page_id)
        skills.set(record.locator.page_id, record)
        const claims = skillClaims.get(record.id) ?? new Set<string>()
        claims.add(record.locator.page_id)
        skillClaims.set(record.id, claims)
      }
      const missing = new Set(
        external.filter((value) => !skills.has(value.page_id)).map((value) => value.page_id),
      )
      if (missing.size > 0) {
        const rawFiles = yield* inventory(input.library, "files", input.inventory?.files)
        const seenFilePages = new Set<string>()
        for (const raw of rawFiles) {
          const id =
            typeof property(raw).id === "string" ? pageId(String(property(raw).id)) : undefined
          const file = yield* checked(() => {
            try {
              return fileRecord(
                raw,
                ownerOfFile(raw, input.library),
                input.library.files.data_source_id,
                input.library.files.property_ids,
              )
            } catch (error) {
              if ((!id || !missing.has(id)) && error instanceof SkillsError) return undefined
              throw error
            }
          })
          if (file === undefined) continue
          const own = ownFiles.get(file.page_id)
          if (
            own !== undefined &&
            (own.skill_page_id !== file.skill_page_id ||
              own.file_id !== file.file_id ||
              own.path !== file.path)
          )
            return yield* Effect.fail(
              fail(
                "SHARED_FILE_ID_CONFLICT",
                "A current physical File page has incompatible owner or binding metadata.",
              ),
            )
          if (seenFilePages.has(file.page_id))
            return yield* Effect.fail(
              fail("SHARED_REFERENCE_INCOMPLETE", "Reference inventory repeats a File page."),
            )
          seenFilePages.add(file.page_id)
          files.set(file.page_id, file)
          const identity = fileIdentity(file)
          const claims = fileClaims.get(identity) ?? new Set<string>()
          claims.add(file.page_id)
          fileClaims.set(identity, claims)
        }
      }
    }
    const entries: NativeReference[] = []
    const unresolved: NativeReferenceIndex["unresolved"][number][] = []
    for (const candidate of candidates.values()) {
      const own = ownFiles.get(candidate.page_id)
      const file = own ?? files.get(candidate.page_id)
      const owner = own
        ? input.record
        : file
          ? skills.get(file.skill_page_id)
          : skills.get(candidate.page_id)
      if (owner === undefined) {
        unresolved.push({ ...candidate, availability: "unmanaged_or_unavailable" })
        continue
      }
      if ((skillClaims.get(owner.id)?.size ?? 0) > 1)
        return yield* Effect.fail(
          fail("SHARED_SKILL_ID_CONFLICT", "Several pages claim a referenced Skill ID.", {
            id: owner.id,
            page_ids: [...skillClaims.get(owner.id)!].sort(),
          }),
        )
      if (file !== undefined && (fileClaims.get(fileIdentity(file))?.size ?? 0) > 1)
        return yield* Effect.fail(
          fail("SHARED_FILE_ID_CONFLICT", "Several pages claim a referenced owner's File ID.", {
            file_id: file.file_id,
            owner_skill_id: owner.id,
            page_ids: [...fileClaims.get(fileIdentity(file))!].sort(),
          }),
        )
      // A link to the main native page names the Skill, not an inferred File.
      entries.push(
        target(
          owner,
          candidate,
          candidate.page_id === owner.locator.page_id ? undefined : file,
          own !== undefined,
        ),
      )
    }
    entries.sort((a, b) => compare(a.from, b.from) || compare(a.href, b.href))
    unresolved.sort((a, b) => compare(a.from, b.from) || compare(a.href, b.href))
    const sources = yield* Effect.forEach(
      [...input.files].sort((a, b) => compare(a.path, b.path)),
      (source) =>
        Effect.gen(function* () {
          return {
            path: source.path,
            body_sha256: source.body_sha256,
            input_sha256: yield* sha256(source.markdown),
            ...(source.native_body_completion === undefined
              ? {}
              : {
                  completion_sha256: yield* sha256(
                    canonicalSharedJson(source.native_body_completion),
                  ),
                }),
          }
        }),
    )
    const identity = {
      version: 1 as const,
      parser_version: (completions.size > 0 ? 2 : 1) as NativeReferenceIndex["parser_version"],
      parent_id: input.record.id,
      source_files: sources,
      relations_sha256: yield* sha256(canonicalSharedJson(input.relations)),
      entries,
      unresolved,
    }
    const index: NativeReferenceIndex = {
      ...identity,
      index_sha256: yield* sha256(canonicalSharedJson(identity)),
    }
    // Same-owner resources retain portable relative links in file bytes; their
    // directory entry still carries the stable File ID for independent reads.
    const links = entries
      .filter(
        (entry) => entry.skill_page_id !== input.record.locator.page_id || entry.kind === "skill",
      )
      .map((entry) => ({ from: entry.from, href: entry.href, target: entry.ref }))
    return { linkedPages, completions, links, index }
  })
}
