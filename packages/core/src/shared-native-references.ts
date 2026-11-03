import { Effect, Schema } from "effect"
import {
  decode,
  fail,
  listSchema,
  property,
  SkillsError,
  type SharedSkillRecord,
  type Source,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { fileRef, pageId } from "./ref.ts"
import { sharedRecordFromPage } from "./shared-content.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
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

export interface NativeReferenceSource {
  readonly path: string
  readonly markdown: string
  /** Exact native observation, before consumer projection. */
  readonly body_sha256: string
  readonly page_id?: string
}
export interface NativeMetadataInventory {
  readonly data_source_id: string
  readonly complete: true
  readonly pages: readonly unknown[]
}
type Candidate = { from: string; href: string; page_id: string }
const List = listSchema(Schema.Unknown)
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
  supplied?: NativeMetadataInventory,
) {
  return Effect.gen(function* () {
    const source = library[kind]
    if (supplied !== undefined) {
      if (supplied.data_source_id !== source.data_source_id || supplied.complete !== true)
        return yield* Effect.fail(
          fail("SHARED_REFERENCE_SCOPE", "The reference inventory belongs to another data source."),
        )
      return supplied.pages
    }
    const fields =
      kind === "skills"
        ? ["Name", "Description", "Kind", "Skill ID", "Enabled", "Default Context"]
        : ["File ID", "Skill", "Path", "Projection", "Status"]
    const query = new URLSearchParams()
    for (const name of fields) {
      const id = source.property_ids[name]
      if (!id)
        return yield* Effect.fail(
          fail("LIBRARY_INVALID", "A registered native reference metadata property is missing.", {
            kind,
            property: name,
          }),
        )
      query.append("filter_properties", id)
    }
    const api = yield* Notion
    const pages: unknown[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const raw = yield* api.request(`v1/data_sources/${source.data_source_id}/query?${query}`, {
        page_size: 100,
        ...(cursor === undefined ? {} : { start_cursor: cursor }),
      })
      const result = yield* checked(() => {
        if (property(raw).object !== "list")
          throw fail(
            "SHARED_REFERENCE_INCOMPLETE",
            "Native reference metadata is not a complete list.",
          )
        return decode(List, raw)
      })
      pages.push(...result.results)
      if (!result.has_more) {
        if (result.next_cursor !== null)
          return yield* Effect.fail(
            fail("SHARED_REFERENCE_INCOMPLETE", "A terminal reference inventory retains a cursor."),
          )
        break
      }
      if (!result.next_cursor || cursors.has(result.next_cursor) || cursors.size >= 1000)
        return yield* Effect.fail(
          fail("SHARED_REFERENCE_INCOMPLETE", "Reference inventory pagination did not advance."),
        )
      cursor = result.next_cursor
      cursors.add(cursor)
    } while (cursor !== undefined)
    return pages
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
    readonly skills?: NativeMetadataInventory
    readonly files?: NativeMetadataInventory
  }
}) {
  return Effect.gen(function* () {
    const candidates = new Map<string, Candidate>()
    const linkedPages = new Map<string, ReadonlySet<string>>()
    const api = yield* Notion
    for (const source of input.files) {
      const tags = yield* checked(() => nativeReferenceTags(source.markdown))
      const pages = new Set<string>()
      // Native <page> is normally a child page. Only ambiguous actual tags
      // justify a block read, and child page bodies remain outside this walk.
      if (source.page_id !== undefined && tags.some((tag) => tag.kind === "page")) {
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
      return { linkedPages, links: [] as readonly SharedFileLink[], index: undefined }
    const ownFiles = new Map(input.bindings.map((file) => [file.page_id, file]))
    const external = [...candidates.values()].filter(
      (value) => value.page_id !== input.record.locator.page_id && !ownFiles.has(value.page_id),
    )
    const skills = new Map<string, SharedSkillRecord>([
      [input.record.locator.page_id, input.record],
    ])
    const skillClaims = new Map<string, Set<string>>()
    const files = new Map<string, FileRecord>()
    const fileClaims = new Map<string, Set<string>>()
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
            return sharedRecordFromPage(raw, source, input.library.skills.data_source_id)
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
          if (seenFilePages.has(file.page_id))
            return yield* Effect.fail(
              fail("SHARED_REFERENCE_INCOMPLETE", "Reference inventory repeats a File page."),
            )
          seenFilePages.add(file.page_id)
          files.set(file.page_id, file)
          const claims = fileClaims.get(file.file_id) ?? new Set<string>()
          claims.add(file.page_id)
          fileClaims.set(file.file_id, claims)
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
      if (file !== undefined && (fileClaims.get(file.file_id)?.size ?? 0) > 1)
        return yield* Effect.fail(
          fail("SHARED_FILE_ID_CONFLICT", "Several pages claim a referenced File ID.", {
            file_id: file.file_id,
            page_ids: [...fileClaims.get(file.file_id)!].sort(),
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
          }
        }),
    )
    const identity = {
      version: 1 as const,
      parser_version: 1 as const,
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
    return { linkedPages, links, index }
  })
}
