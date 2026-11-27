import { Effect, Schema } from "effect"
import type { CurrentFact } from "./current-evidence-model.ts"
import {
  beginCurrentEvidence,
  currentEvidenceForResponse,
  currentFact,
  currentPageFact,
  observeCurrentFacts,
} from "./current-evidence.ts"
import { fail, listSchema, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { planSharedFiles } from "./shared-composition.ts"
import type { CurrentFileContent } from "./shared-current-file.ts"
import type { CurrentSkillIndex } from "./shared-current-index.ts"
import {
  currentSourceProperty,
  parseCurrentSourceManagement,
  type CurrentSourceManagement,
} from "./shared-current-source-management.ts"
import type { CurrentSourceContribution } from "./shared-current-source-input.ts"
import { resolveCurrentSharedSources, type CurrentSharedSource } from "./shared-current-source.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import type { SharedSourcePlanOptions } from "./shared-source-plan.ts"
import { sha256 } from "./store.ts"

export type CurrentSkillConsumption = {
  readonly files: readonly { readonly path: string; readonly content: CurrentFileContent }[]
  readonly sources: ReadonlyMap<string, CurrentSharedSource>
  readonly source_fingerprint: string
  /** Exact metadata read by this candidate; undefined means some page evidence is unknown. */
  readonly current_facts: readonly CurrentFact[] | undefined
}
export type CurrentSourceConsumption = Omit<CurrentSkillConsumption, "files"> & {
  readonly files: readonly {
    readonly path: string
    readonly content: Extract<CurrentFileContent, { kind: "source" }>
  }[]
}

const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_SOURCE_INVALID", message, details)
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("Current consumption metadata is invalid."),
  })
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function physicalId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu.test(value)
  )
    throw invalid("A Source candidate needs an exact physical identity.")
  const id = pageId(value)
  if (id === undefined) throw invalid("A Source candidate has an invalid identity.")
  return id
}

/** A contains query only finds candidates. Unrelated candidates need no Content,
 * definition or provider admission, even if their other metadata is broken. */
function contributesTo(row: unknown, propertyId: string, skillId: string): boolean {
  const fields = Object.entries(property(property(row).properties)).flatMap(([key, raw]) =>
    key === propertyId || property(raw).id === propertyId ? [property(raw)] : [],
  )
  const field = fields[0]
  if (
    fields.length !== 1 ||
    field?.type !== "rich_text" ||
    (field.has_more !== undefined && field.has_more !== false) ||
    !Array.isArray(field.rich_text) ||
    field.rich_text.length > 100
  )
    throw invalid("The current Contributions property is missing, ambiguous or incomplete.")
  const encoded = field.rich_text
    .map((part) => {
      const value = property(part)
      const text =
        typeof value.plain_text === "string" ? value.plain_text : property(value.text).content
      if (typeof text !== "string" || text.length > 2000)
        throw invalid("The current Contributions property contains incomplete text.")
      return text
    })
    .join("")
  const entries = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(JSON.parse(encoded))
  return entries.some((entry) => property(entry).skill_id === skillId)
}

function currentContributions(library: SharedLibrary, skillId: string) {
  return Effect.gen(function* () {
    const contributionId = yield* checked(() => currentSourceProperty(library, "Contributions"))
    const api = yield* Notion
    let attempt = yield* beginCurrentEvidence(api.credentialIdentity, api.apiOrigin)
    const physical = new Set<string>(),
      cursors = new Set<string>(),
      selected = new Map<string, CurrentSourceManagement>(),
      selectedPages = new Map<string, unknown>()
    let cursor: string | undefined
    for (;;) {
      const raw = yield* api.request(
        `v1/data_sources/${library.sources.data_source_id}/query`,
        {
          page_size: 100,
          filter: { property: contributionId, rich_text: { contains: skillId } },
          ...(cursor === undefined ? {} : { start_cursor: cursor }),
        },
        { method: "POST" },
      )
      attempt = yield* currentEvidenceForResponse(attempt, raw)
      const list = yield* checked(() => {
        const envelope = property(raw)
        if (
          envelope.object !== "list" ||
          (envelope.request_status !== undefined &&
            property(envelope.request_status).type !== "complete")
        )
          throw fail("CURRENT_SOURCE_INCOMPLETE", "Source contribution enumeration is incomplete.")
        const list = Schema.decodeUnknownSync(listSchema(Schema.Unknown))(raw)
        if (
          list.has_more
            ? !list.next_cursor || list.next_cursor.length > 2048 || cursors.has(list.next_cursor)
            : list.next_cursor !== null
        )
          throw fail("CURRENT_SOURCE_INCOMPLETE", "Source contribution pagination did not advance.")
        for (const value of list.results) {
          const row = property(value),
            parent = property(row.parent),
            id = physicalId(row.id)
          if (
            row.object !== "page" ||
            row.archived === true ||
            row.is_archived === true ||
            row.in_trash === true ||
            physical.has(id) ||
            parent.type !== "data_source_id" ||
            physicalId(parent.data_source_id) !== physicalId(library.sources.data_source_id) ||
            (parent.database_id !== undefined &&
              physicalId(parent.database_id) !== physicalId(library.sources.database_id))
          )
            throw invalid("Source candidates contain a foreign, unavailable or repeated page.")
          physical.add(id)
          if (!contributesTo(value, contributionId, skillId)) continue
          const current = parseCurrentSourceManagement(library, value)
          const sourceId = current.declaration.definition.source_id
          if (selected.has(sourceId))
            throw fail("CURRENT_SOURCE_DUPLICATE", "Several Sources claim one stable identity.", {
              source_id: sourceId,
            })
          selected.set(sourceId, current)
          selectedPages.set(current.page_id, value)
        }
        return list
      })
      if (!list.has_more) break
      const next = list.next_cursor
      if (next === null)
        return yield* Effect.fail(
          fail("CURRENT_SOURCE_INCOMPLETE", "Source contribution pagination has no next cursor."),
        )
      cursor = next
      cursors.add(next)
    }
    const currents = [...selected.values()].sort((a, b) =>
      compare(a.declaration.definition.source_id, b.declaration.definition.source_id),
    )
    const pages: CurrentFact[] = []
    for (const current of currents) {
      const fact = yield* currentPageFact(selectedPages.get(current.page_id))
      // Missing page metadata is unknown, not proof that an old timestamp is current.
      if (fact === undefined) return { currents, current_facts: undefined }
      pages.push(fact)
    }
    const collection = yield* currentFact(
      `sources:${physicalId(library.sources.data_source_id)}:${skillId}`,
      { sources: currents, pages },
    )
    yield* observeCurrentFacts(attempt, [collection])
    return { currents, current_facts: [collection, ...pages] }
  })
}

/** One exact Skill's member-relative mapping and authority exclusions. */
export function currentSourceContributionFiles(
  skillId: string,
  contributions: readonly CurrentSourceContribution[],
  source: Pick<CurrentSharedSource, "source_id" | "revision" | "manifest">,
): CurrentSourceConsumption["files"] {
  const files: {
    path: string
    content: Extract<CurrentFileContent, { kind: "source" }>
  }[] = []
  for (const contribution of contributions) {
    if (contribution.skill_id !== skillId) continue
    const prefix = contribution.member_key === "." ? "" : contribution.member_key + "/"
    for (const file of source.manifest) {
      if (!file.path.startsWith(prefix)) continue
      const relative = file.path.slice(prefix.length)
      if (contribution.exclude.includes(relative)) continue
      const mapped = contribution.mapping[relative] ?? relative
      const path = contribution.mount_path ? contribution.mount_path + "/" + mapped : mapped
      files.push({
        path,
        content: {
          kind: "source",
          source_id: source.source_id,
          revision: source.revision,
          source_path: file.path,
          sha256: file.sha256,
          bytes: file.bytes,
          mode: file.mode,
        },
      })
    }
  }
  return files.sort((a, b) => compare(a.path, b.path))
}

/** Management may replace one Source while reading all other contributions.
 * This Source-only subset has no required main file or Notion-owned overrides. */
export function resolveCurrentSourceConsumption(
  library: SharedLibrary,
  skillId: string,
  options: {
    readonly sourceOptions?: SharedSourcePlanOptions
    readonly excludeSourceIds?: readonly string[]
  } = {},
) {
  return Effect.gen(function* () {
    const excluded = new Set(options.excludeSourceIds)
    const enumeration = yield* currentContributions(library, skillId)
    const currents = enumeration.currents.filter(
      (current) => !excluded.has(current.declaration.definition.source_id),
    )
    const sources = yield* resolveCurrentSharedSources(library, {
      selections: currents.map((current) => ({
        source_id: current.declaration.definition.source_id,
        revision: current.revision,
      })),
      sourceOptions: options.sourceOptions,
    })
    const files = yield* checked(() => {
      const files = currents.flatMap((current) => {
        const sourceId = current.declaration.definition.source_id
        const source = sources.get(sourceId)
        if (source === undefined) throw invalid("A selected Source has no complete manifest.")
        if (pageId(source.page_id) !== current.page_id)
          throw fail(
            "CURRENT_SOURCE_CONFLICT",
            "The selected Source changed its physical owner while its manifest was being read.",
            {
              source_id: sourceId,
              next: "reselect_current",
            },
          )
        return currentSourceContributionFiles(skillId, current.declaration.contributions, source)
      })
      return files.sort((a, b) => compare(a.path, b.path))
    })
    const definitions = currents.map((current) => {
      const definition = current.declaration.definition
      return {
        source_id: definition.source_id,
        revision: current.revision,
        definition: {
          enabled: definition.enabled,
          policy: definition.policy,
          adapter: definition.adapter,
          selection: definition.selection,
          options: definition.options,
        },
        contributions: current.declaration.contributions.filter(
          (entry) => entry.skill_id === skillId,
        ),
      }
    })
    const result: CurrentSourceConsumption = {
      files,
      sources,
      source_fingerprint: yield* sha256(canonicalSharedJson(definitions)),
      current_facts: enumeration.current_facts,
    }
    return result
  })
}

/** Source manifests own complete consumption trees. Source-kind Notion rows are
 * disposable projections; only native/resource rows contribute Notion authority. */
export function resolveCurrentSkillConsumption(
  library: SharedLibrary,
  index: CurrentSkillIndex,
  options: { readonly sourceOptions?: SharedSourcePlanOptions } = {},
) {
  return Effect.gen(function* () {
    const source = yield* resolveCurrentSourceConsumption(library, index.skill_id, {
      sourceOptions: options.sourceOptions,
    })
    const files = yield* checked(() => {
      const files = [
        ...source.files,
        ...[index.main, ...index.files]
          .filter((file) => file.content.kind !== "source")
          .map(({ path, content }) => ({ path, content })),
      ]
      planSharedFiles({ base: files, mounts: [], overrides: [], entrypoint: index.main.path })
      return files.sort((a, b) => compare(a.path, b.path))
    })
    const result: CurrentSkillConsumption = { ...source, files }
    return result
  })
}
