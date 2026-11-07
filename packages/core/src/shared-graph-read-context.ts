import { Context, Crypto, Effect, Option, Schema } from "effect"
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
import { pageId } from "./ref.ts"
import { sharedRecordFromPage } from "./shared-content.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import {
  querySharedOperationIndexes,
  type SharedOperationHeader,
} from "./shared-operation-index.ts"
import {
  canonicalSharedJson,
  querySharedFileFactsForSkills,
  type SharedRecord,
} from "./shared-records.ts"
import type { SharedSkillRelationTarget } from "./shared-router-members.ts"
import { querySkillFilesForSkills, type FileRecord } from "./skill-file-index.ts"
import { Store } from "./store.ts"

export type CompleteSharedSkillInventory = {
  readonly data_source_id: string
  readonly complete: true
  readonly pages: readonly unknown[]
}
type Work<A> = Effect.Effect<A, SkillsError, Notion | Store | Crypto.Crypto>
type SelectedMetadata = {
  readonly files: readonly FileRecord[]
  readonly facts: readonly SharedRecord[]
  readonly operations: readonly SharedOperationHeader[]
}
type SharedTarget = { readonly library: SharedLibrary; readonly rawPage: unknown }

/** A single preparation's complete metadata observations; never a global freshness authority. */
class SharedGraphReads extends Context.Service<
  SharedGraphReads,
  {
    readonly inventory: (library: SharedLibrary) => Work<CompleteSharedSkillInventory>
    readonly target: (selector: string, database?: string) => Work<SharedTarget | undefined>
    readonly metadata: (
      library: SharedLibrary,
      selected: SharedSkillRecord,
      required: readonly SharedSkillRelationTarget[],
      scope: string,
      depth: number,
    ) => Work<SelectedMetadata>
  }
>()("ntn-skills/SharedGraphReads") {}

class SharedGraphReadDepth extends Context.Service<
  SharedGraphReadDepth,
  { readonly depth: number }
>()("ntn-skills/SharedGraphReadDepth") {}
export function withSharedGraphReadDepth<A, E, R>(effect: Effect.Effect<A, E, R>, depth: number) {
  return effect.pipe(Effect.provideService(SharedGraphReadDepth, { depth }))
}

const checked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_GRAPH_METADATA_INVALID", "The preparation metadata observation is invalid."),
  })
const sourceFor = (library: SharedLibrary): Source => ({
  alias: library.library_id,
  title: "",
  role: "content",
  database_id: library.skills.database_id,
  data_source_ids: [library.skills.data_source_id],
  shared_library: library,
})

function queryInventory(library: SharedLibrary) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const parameters = new URLSearchParams()
    // These rows also serve selected graph targets. Keep their body/source
    // bindings and registered relations, without unrelated schema properties.
    const fields = [
      "Name",
      "Description",
      "Kind",
      "Enabled",
      "Default Context",
      "Skill ID",
      "Main File ID",
      "Projection",
      "References",
      "Source",
      "Members",
      "Requires",
    ]
    const ids = fields
      .map((field) => library.skills.property_ids[field])
      .filter((id): id is string => id !== undefined)
    for (const id of new Set(ids)) parameters.append("filter_properties", id)
    const pages: unknown[] = [],
      seen = new Set<string>(),
      cursors = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const raw = yield* api.request(
        `v1/data_sources/${library.skills.data_source_id}/query?${parameters}`,
        {
          page_size: 100,
          ...(cursor === undefined ? {} : { start_cursor: cursor }),
        },
        { method: "POST" },
      )
      const page = yield* checked(() => {
        const value = property(raw)
        if (
          value.object !== "list" ||
          (value.request_status !== undefined && property(value.request_status).type !== "complete")
        )
          throw fail(
            "SHARED_GRAPH_METADATA_INCOMPLETE",
            "The shared Skills inventory is incomplete.",
          )
        const list = decode(listSchema(Schema.Unknown), raw)
        if (
          (!list.has_more && list.next_cursor !== null) ||
          (list.has_more && (!list.next_cursor || cursors.has(list.next_cursor)))
        )
          throw fail(
            "SHARED_GRAPH_METADATA_INCOMPLETE",
            "Shared Skills pagination did not advance.",
          )
        for (const item of list.results) {
          const row = property(item),
            parent = property(row.parent)
          const id = typeof row.id === "string" ? pageId(row.id) : undefined
          if (
            row.object !== "page" ||
            id === undefined ||
            parent.type !== "data_source_id" ||
            parent.data_source_id !== library.skills.data_source_id ||
            (parent.database_id !== undefined &&
              parent.database_id !== library.skills.database_id) ||
            seen.has(id)
          )
            throw fail(
              "SHARED_GRAPH_METADATA_INVALID",
              "The shared inventory contains a foreign or repeated page.",
            )
          seen.add(id)
        }
        return list
      })
      pages.push(...page.results)
      if (!page.has_more)
        return { data_source_id: library.skills.data_source_id, complete: true as const, pages }
      cursor = page.next_cursor!
      cursors.add(cursor)
    }
  })
}

export function withSharedGraphReads<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  input: {
    readonly currentRoots: readonly string[]
    readonly purpose: "use" | "inspect"
    readonly maxNodes: number
    readonly maxDepth: number
    readonly scope: string
  },
) {
  return Effect.gen(function* () {
    const observations = new Map<
      string,
      { library: SharedLibrary; inventory: Work<CompleteSharedSkillInventory> }
    >()
    const completed = new Map<
      string,
      {
        library: SharedLibrary
        inventory: CompleteSharedSkillInventory
        pages: Map<string, unknown>
        records: Map<string, SharedSkillRecord>
        claims: Map<string, Set<string>>
        invalid: Map<string, SkillsError>
      }
    >()
    const selectedMetadata = new Map<string, SelectedMetadata>()
    const admitted = new Set<string>()
    const inventory = (library: SharedLibrary): Work<CompleteSharedSkillInventory> =>
      Effect.gen(function* () {
        const previous = observations.get(library.library_id)
        if (previous !== undefined) {
          if (canonicalSharedJson(previous.library) !== canonicalSharedJson(library))
            return yield* Effect.fail(
              fail(
                "SHARED_LIBRARY_ID_CONFLICT",
                "The preparation observed conflicting descriptors for one library.",
              ),
            )
          return yield* previous.inventory
        }
        const load = yield* Effect.cached(
          queryInventory(library).pipe(
            Effect.tap((value) =>
              checked(() => {
                const pages = new Map<string, unknown>(),
                  records = new Map<string, SharedSkillRecord>(),
                  claims = new Map<string, Set<string>>(),
                  invalid = new Map<string, SkillsError>()
                for (const raw of value.pages) {
                  const id = String(property(raw).id)
                  pages.set(id, raw)
                  try {
                    const record = sharedRecordFromPage(
                      raw,
                      sourceFor(library),
                      library.skills.data_source_id,
                    )
                    records.set(id, record)
                    const owners = claims.get(record.id) ?? new Set<string>()
                    owners.add(id)
                    claims.set(record.id, owners)
                  } catch (error) {
                    if (!(error instanceof SkillsError)) throw error
                    invalid.set(id, error)
                  }
                }
                completed.set(library.library_id, {
                  library,
                  inventory: value,
                  pages,
                  records,
                  claims,
                  invalid,
                })
              }),
            ),
          ),
        )
        observations.set(library.library_id, { library, inventory: load })
        return yield* load
      })
    const find = (selector: string, database?: string): SharedTarget | undefined => {
      const exact = pageId(selector)
      for (const value of completed.values()) {
        if (database !== undefined && database !== value.library.skills.database_id) continue
        if (exact !== undefined && value.invalid.has(exact)) throw value.invalid.get(exact)!
        const identity = exact === undefined ? selector : value.records.get(exact)?.id
        const claims = identity === undefined ? undefined : value.claims.get(identity)
        if (claims === undefined) continue
        if (claims.size !== 1)
          throw fail(
            "SHARED_SKILL_ID_CONFLICT",
            "Several pages claim the selected Skill identity.",
            { id: identity, page_ids: [...claims].sort() },
          )
        const selectedPage = exact ?? [...claims][0]!
        return { library: value.library, rawPage: value.pages.get(selectedPage)! }
      }
      return undefined
    }
    const metadata: SharedGraphReads["Service"]["metadata"] = (
      library,
      selected,
      required,
      scope,
      depth,
    ) =>
      Effect.gen(function* () {
        if (scope !== input.scope)
          return yield* Effect.fail(
            fail(
              "PREPARE_SCOPE_CONFLICT",
              "Shared graph metadata belongs to another authorization scope.",
            ),
          )
        yield* inventory(library)
        const key = (owner: string) => canonicalSharedJson([library.library_id, owner])
        const existing = selectedMetadata.get(key(selected.locator.page_id))
        if (existing !== undefined) return existing
        const candidates = yield* checked(() => {
          const current = find(selected.id, library.skills.database_id)
          if (current === undefined || property(current.rawPage).id !== selected.locator.page_id)
            throw fail(
              "SHARED_SKILL_ID_CONFLICT",
              "The selected Skill changed identity during the shared inventory observation.",
            )
          const roots = input.currentRoots.flatMap((root) => {
            const target = find(root, library.skills.database_id)
            return target === undefined ? [] : [String(property(target.rawPage).id)]
          })
          return [
            ...new Set([
              selected.locator.page_id,
              ...roots,
              ...(input.purpose === "use" && depth < input.maxDepth
                ? required.map((target) => target.metadata.page_id)
                : []),
            ]),
          ]
        })
        const owners: string[] = []
        for (const owner of candidates) {
          const identity = key(owner)
          if (selectedMetadata.has(identity)) continue
          if (!admitted.has(identity) && admitted.size >= input.maxNodes) continue
          admitted.add(identity)
          owners.push(owner)
        }
        if (!owners.includes(selected.locator.page_id))
          return yield* Effect.fail(
            fail(
              "PREPARE_BUDGET_EXCEEDED",
              "Preparation metadata exceeded the selected-node budget.",
            ),
          )
        const files = yield* querySkillFilesForSkills({
          dataSourceId: library.files.data_source_id,
          propertyIds: library.files.property_ids,
          skillPageIds: owners,
        })
        const facts = yield* querySharedFileFactsForSkills(library, owners, scope)
        const operations = yield* querySharedOperationIndexes(library, owners)
        for (const owner of owners)
          selectedMetadata.set(key(owner), {
            files: files.get(owner) ?? [],
            facts: facts.get(owner) ?? [],
            operations: operations.get(owner) ?? [],
          })
        return selectedMetadata.get(key(selected.locator.page_id))!
      })
    return yield* effect.pipe(
      Effect.provideService(SharedGraphReads, {
        inventory,
        target: (selector, database) => checked(() => find(selector, database)),
        metadata,
      }),
    )
  })
}

export function sharedGraphInventory(library: SharedLibrary) {
  return Effect.gen(function* () {
    const context = yield* Effect.serviceOption(SharedGraphReads)
    return Option.isSome(context) ? yield* context.value.inventory(library) : undefined
  })
}
export function sharedGraphTarget(selector: string, database?: string) {
  return Effect.gen(function* () {
    const context = yield* Effect.serviceOption(SharedGraphReads)
    return Option.isSome(context) ? yield* context.value.target(selector, database) : undefined
  })
}
export function sharedGraphMetadata(
  library: SharedLibrary,
  selected: SharedSkillRecord,
  required: readonly SharedSkillRelationTarget[],
  scope: string,
) {
  return Effect.gen(function* () {
    const context = yield* Effect.serviceOption(SharedGraphReads)
    const node = yield* Effect.serviceOption(SharedGraphReadDepth)
    return Option.isSome(context)
      ? yield* context.value.metadata(
          library,
          selected,
          required,
          scope,
          Option.isSome(node) ? node.value.depth : 0,
        )
      : undefined
  })
}
