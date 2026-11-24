import { Effect } from "effect"
import { authScope, explicitSource } from "./catalog.ts"
import { fail, property, type SharedSkillRecord, type Source } from "./model.ts"
import { Notion } from "./notion.ts"
import type { NotionMcpSearchMatch } from "./notion-mcp-client.ts"
import { pageId } from "./ref.ts"
import {
  currentFileMetadata,
  readCurrentSkillMetadata,
  type CurrentFileBinding,
} from "./shared-current-index.ts"
import { sharedRecordFromPage } from "./shared-content.ts"
import type { CurrentFileContent } from "./shared-current-file.ts"
import {
  queryCurrentSourceManagement,
  type CurrentSourceManagement,
} from "./shared-current-source-management.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { querySelectedSkillMetadataWithClaims } from "./shared-skill-targets.ts"

export const CONTENT_SEARCH_CONTRACT_VERSION = 1

export type ContentSearchInput = { readonly query: string; readonly limit?: number }
export type ContentSearchRecord = SharedSkillRecord & {
  readonly match: {
    readonly kind: "notion_remote_match"
    readonly pageId: string
    readonly url: string
    readonly title?: string
    readonly snippet?: string
    readonly representation: "native" | "projection" | "supporting_file"
  }
}
export type ContentSearchResult = {
  readonly kind: "results"
  readonly records: readonly ContentSearchRecord[]
  readonly connection: { readonly id: string; readonly grantEpoch: string }
  readonly resultId: string
  readonly coverage: "remote_non_exhaustive"
  readonly partial: boolean
  readonly notices: readonly { readonly code: string; readonly message: string }[]
  readonly exhaustive: false
}
export type ContentSearchSource = {
  readonly scope: string
  readonly workspaceId: string | null
  readonly source: Source & { readonly shared_library: SharedLibrary }
}

export function validateContentSearchInput(input: ContentSearchInput): {
  query: string
  limit: number
} {
  if (typeof input?.query !== "string" || !input.query.trim() || input.query.length > 4096)
    throw fail(
      "INVALID_ARGUMENT",
      "Content search requires a nonempty query of at most 4096 characters.",
    )
  const limit = input.limit ?? 20
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    throw fail("INVALID_ARGUMENT", "Content search limit must be between 1 and 50.")
  return { query: input.query, limit }
}

/** No View, cached directory, page title, or MCP principal can grant REST eligibility. */
export function contentSearchSource(database: string) {
  return Effect.gen(function* () {
    if (typeof database !== "string" || !database.trim())
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Content search requires one explicit Library root."),
      )
    const scope = yield* authScope
    const api = yield* Notion
    const identity =
      api.connectionIdentity === undefined ? undefined : yield* api.connectionIdentity
    const source = yield* explicitSource(database)
    if (source.shared_library === undefined)
      return yield* Effect.fail(
        fail("MCP_SOURCE_UNAVAILABLE", "Select one current Skill library for content search."),
      )
    return {
      scope,
      workspaceId: identity?.workspace ?? null,
      source: { ...source, shared_library: source.shared_library },
    } satisfies ContentSearchSource
  })
}

export function assertContentSearchSource(
  before: ContentSearchSource,
  after: ContentSearchSource,
): void {
  if (
    before.scope !== after.scope ||
    before.workspaceId !== after.workspaceId ||
    before.source.database_id !== after.source.database_id ||
    canonicalSharedJson(before.source.shared_library) !==
      canonicalSharedJson(after.source.shared_library)
  )
    throw fail(
      "MCP_SEARCH_STALE",
      "The selected REST connection or library changed during content search.",
    )
}

const admissionFailure = () =>
  fail(
    "MCP_ADMISSION_FAILED",
    "Current REST eligibility could not be established for the remote search result.",
  )
const checked = <A>(read: () => A) => Effect.try({ try: read, catch: admissionFailure })

function safeText(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) return undefined
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
    .slice(0, maximum)
}

/** Raw hits stay private until exact physical page, owner, stable claim and current eligibility pass.
 * This reads metadata only. It never downloads Git/resources or claims their bytes matched. */
export function admitContentSearchMatches(
  selected: ContentSearchSource,
  matches: readonly NotionMcpSearchMatch[],
) {
  return Effect.gen(function* () {
    const library = selected.source.shared_library
    const api = yield* Notion
    const candidates: { match: NotionMcpSearchMatch; owner: string; file?: CurrentFileBinding }[] =
      []
    const seeds: unknown[] = []
    const seen = new Set<string>()
    let rejected = 0
    if (matches.length > 50)
      return yield* Effect.fail(
        fail("MCP_BUDGET_EXCEEDED", "The remote result exceeds the admission limit."),
      )
    for (const match of matches) {
      if (pageId(match.pageId) !== match.pageId || seen.has(match.pageId)) {
        rejected++
        continue
      }
      seen.add(match.pageId)
      const raw = yield* api
        .request(`v1/pages/${match.pageId}`)
        .pipe(
          Effect.catch((error) =>
            ["ACCESS_DENIED", "NOT_FOUND"].includes(error.code)
              ? Effect.succeed(undefined)
              : Effect.fail(admissionFailure()),
          ),
        )
      if (raw === undefined) {
        rejected++
        continue
      }
      const row = property(raw),
        parent = property(row.parent)
      if (
        row.object !== "page" ||
        row.id !== match.pageId ||
        row.in_trash === true ||
        row.archived === true ||
        row.is_archived === true ||
        parent.type !== "data_source_id"
      ) {
        rejected++
        continue
      }
      if (parent.data_source_id === library.skills.data_source_id) {
        candidates.push({ match, owner: match.pageId })
        seeds.push(raw)
      } else if (parent.data_source_id === library.files.data_source_id) {
        const decoded = yield* checked(() => currentFileMetadata(raw, library)).pipe(Effect.result)
        if (decoded._tag === "Failure") {
          rejected++
          continue
        }
        candidates.push({ match, owner: decoded.success.skill_page_id, file: decoded.success })
      } else rejected++
    }
    const ownerIds = [...new Set(candidates.map((candidate) => candidate.owner))]
    const { targets: owners, observations: claims } = yield* querySelectedSkillMetadataWithClaims(
      library,
      ownerIds,
      seeds,
    ).pipe(Effect.mapError(admissionFailure))
    const sourceRows = new Map<string, CurrentSourceManagement | undefined>()
    const records: ContentSearchRecord[] = []
    const bindings = new Map<
      string,
      {
        readonly main: CurrentFileBinding
        readonly file?: CurrentFileBinding
        readonly sources: readonly string[]
      }
    >()
    const published = new Set<string>()
    for (const candidate of candidates) {
      const owner = owners.get(candidate.owner)
      if (
        owner === undefined ||
        owner.record.enabled !== true ||
        claims.get(candidate.owner)?.record.enabled !== true
      ) {
        rejected++
        continue
      }
      const current = yield* readCurrentSkillMetadata(library, candidate.owner, owner.rawPage).pipe(
        Effect.mapError(admissionFailure),
      )
      if (current.state.state !== "ready") {
        rejected++
        continue
      }
      const content: CurrentFileContent = candidate.file?.content ?? current.main.content
      const requiredSources: string[] = []
      let sourceDenied = false
      for (const content of [
        current.main.content,
        ...(candidate.file === undefined ? [] : [candidate.file.content]),
      ]) {
        if (content.kind !== "source") continue
        requiredSources.push(content.source_id)
        if (!sourceRows.has(content.source_id))
          sourceRows.set(
            content.source_id,
            yield* queryCurrentSourceManagement(library, content.source_id).pipe(
              Effect.mapError(admissionFailure),
            ),
          )
        const source = sourceRows.get(content.source_id)
        if (
          source === undefined ||
          source.declaration.definition.enabled !== true ||
          source.state.state !== "ready" ||
          source.revision !== content.revision
        ) {
          sourceDenied = true
        }
      }
      if (sourceDenied) {
        rejected++
        continue
      }
      if (published.has(owner.record.id)) continue
      published.add(owner.record.id)
      bindings.set(owner.record.id, {
        main: current.main,
        file: candidate.file,
        sources: requiredSources,
      })
      const title = safeText(candidate.match.title, 512)
      const snippet = safeText(candidate.match.snippet, 2000)
      records.push({
        ...owner.record,
        match: {
          kind: "notion_remote_match",
          pageId: candidate.match.pageId,
          url: `https://www.notion.so/${candidate.match.pageId.replaceAll("-", "")}`,
          ...(title === undefined ? {} : { title }),
          ...(snippet === undefined ? {} : { snippet }),
          representation:
            candidate.file !== undefined
              ? "supporting_file"
              : content.kind === "native"
                ? "native"
                : "projection",
        },
      })
    }
    // Re-read every authority at publication. A claim query, another candidate,
    // or a Source lookup can have outlived the page observation above.
    const deniedSources = new Set<string>()
    for (const [id, previous] of sourceRows) {
      if (previous === undefined) {
        deniedSources.add(id)
        continue
      }
      const latest = yield* queryCurrentSourceManagement(library, id).pipe(
        Effect.mapError(admissionFailure),
      )
      if (
        latest === undefined ||
        latest.page_id !== previous.page_id ||
        latest.revision !== previous.revision ||
        latest.state.state !== "ready" ||
        latest.declaration.definition.enabled !== true
      )
        deniedSources.add(id)
    }
    const eligible: ContentSearchRecord[] = []
    for (const record of records) {
      const binding = bindings.get(record.id)!
      if (binding.sources.some((id) => deniedSources.has(id))) {
        rejected++
        continue
      }
      if (binding.file !== undefined) {
        const raw = yield* api
          .request(`v1/pages/${binding.file.page_id}`)
          .pipe(
            Effect.catch((error) =>
              ["ACCESS_DENIED", "NOT_FOUND"].includes(error.code)
                ? Effect.succeed(undefined)
                : Effect.fail(admissionFailure()),
            ),
          )
        const latest = yield* checked(() => currentFileMetadata(raw, library)).pipe(Effect.result)
        if (
          latest._tag === "Failure" ||
          canonicalSharedJson(latest.success) !== canonicalSharedJson(binding.file)
        ) {
          rejected++
          continue
        }
      }
      const raw = yield* api
        .request(`v1/pages/${record.locator.page_id}`)
        .pipe(
          Effect.catch((error) =>
            ["ACCESS_DENIED", "NOT_FOUND"].includes(error.code)
              ? Effect.succeed(undefined)
              : Effect.fail(admissionFailure()),
          ),
        )
      if (raw === undefined) {
        rejected++
        continue
      }
      const current = yield* readCurrentSkillMetadata(library, record.locator.page_id, raw).pipe(
        Effect.mapError(admissionFailure),
      )
      const latest = yield* checked(() =>
        sharedRecordFromPage(raw, selected.source, library.skills.data_source_id),
      )
      if (
        latest.enabled !== true ||
        latest.id !== record.id ||
        current.state.state !== "ready" ||
        current.main.file_id !== binding.main.file_id ||
        canonicalSharedJson(current.main.content) !== canonicalSharedJson(binding.main.content)
      ) {
        rejected++
        continue
      }
      eligible.push({ ...latest, match: record.match })
    }
    return { records: eligible, rejected }
  })
}
