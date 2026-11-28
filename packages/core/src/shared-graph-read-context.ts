import { Context, Effect, Option, Schema } from "effect"
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
import { sharedRecordFromPage, skillIdentity } from "./shared-content.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import type { SharedSkillRelationTarget } from "./shared-router-members.ts"
import { queryCurrentFilesForSkills } from "./shared-current-index.ts"
import type { CurrentFileBinding } from "./shared-current-index.ts"
import {
  querySelectedSkillMetadata,
  querySelectedSkillIdentity,
  selectedSkillsFromInventory,
  type SelectedSharedSkillMetadata,
} from "./shared-skill-targets.ts"

export type CompleteSharedSkillInventory = {
  readonly data_source_id: string
  readonly complete: true
  readonly pages: readonly unknown[]
}
type Work<A> = Effect.Effect<A, SkillsError, Notion>
type SelectedMetadata = {
  readonly files: readonly CurrentFileBinding[]
}
type SharedTarget = { readonly library: SharedLibrary; readonly rawPage: unknown }

/** Request-scoped exact targets and explicitly complete inventories; never global freshness authority. */
class SharedGraphReads extends Context.Service<
  SharedGraphReads,
  {
    readonly inventory: (library: SharedLibrary) => Work<CompleteSharedSkillInventory>
    readonly identity: (
      library: SharedLibrary,
      skillId: string,
    ) => Work<SelectedSharedSkillMetadata>
    readonly observe: (
      library: SharedLibrary,
      raw: unknown,
      inventory?: CompleteSharedSkillInventory,
    ) => Work<CompleteSharedSkillInventory | undefined>
    readonly targets: (
      library: SharedLibrary,
      ids: readonly string[],
    ) => Work<ReadonlyMap<string, SelectedSharedSkillMetadata>>
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
      "Content",
      "Current State",
      "Operation",
      "Origin",
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
    const selectedTargets = new Map<
      string,
      { library: SharedLibrary; pages: Map<string, SelectedSharedSkillMetadata> }
    >()
    const selectedMetadata = new Map<string, SelectedMetadata>()
    const checkLibrary = (library: SharedLibrary) => {
      const previous =
        observations.get(library.library_id)?.library ??
        selectedTargets.get(library.library_id)?.library
      if (previous !== undefined && canonicalSharedJson(previous) !== canonicalSharedJson(library))
        throw fail(
          "SHARED_LIBRARY_ID_CONFLICT",
          "The preparation observed conflicting descriptors for one library.",
        )
    }
    const rememberInventory = (library: SharedLibrary, value: CompleteSharedSkillInventory) => {
      checkLibrary(library)
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
    }
    const targets = (
      library: SharedLibrary,
      ids: readonly string[],
      seeds: readonly unknown[] = [],
    ): Work<ReadonlyMap<string, SelectedSharedSkillMetadata>> =>
      Effect.gen(function* () {
        yield* checked(() => checkLibrary(library))
        const known = selectedTargets.get(library.library_id) ?? {
          library,
          pages: new Map<string, SelectedSharedSkillMetadata>(),
        }
        selectedTargets.set(library.library_id, known)
        const complete = completed.get(library.library_id)?.inventory
        if (complete !== undefined) {
          const loaded = yield* checked(() => selectedSkillsFromInventory(library, ids, complete))
          for (const [id, value] of loaded) known.pages.set(id, value)
        } else {
          const missing = ids.filter((id) => !known.pages.has(id))
          if (missing.length) {
            const loaded = yield* querySelectedSkillMetadata(
              library,
              missing,
              seeds.filter((raw) => missing.includes(String(property(raw).id))),
            )
            for (const [id, value] of loaded) known.pages.set(id, value)
          }
        }
        yield* checked(() => {
          for (const raw of seeds) {
            const selected = sharedRecordFromPage(
              raw,
              sourceFor(library),
              library.skills.data_source_id,
            )
            if (known.pages.get(selected.locator.page_id)?.record.id !== selected.id)
              throw fail(
                "SHARED_SKILL_ID_CONFLICT",
                "The selected Skill changed identity during metadata observation.",
              )
          }
        })
        return new Map(ids.map((id) => [id, known.pages.get(id)!]))
      })
    const admitted = new Set<string>()
    const inventory = (library: SharedLibrary): Work<CompleteSharedSkillInventory> =>
      Effect.gen(function* () {
        yield* checked(() => checkLibrary(library))
        const previous = observations.get(library.library_id)
        if (previous !== undefined) return yield* previous.inventory
        const supplied = completed.get(library.library_id)?.inventory
        if (supplied !== undefined) return supplied
        const load = yield* Effect.cached(
          queryInventory(library).pipe(
            Effect.tap((value) => checked(() => rememberInventory(library, value))),
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
      for (const value of selectedTargets.values()) {
        if (database !== undefined && database !== value.library.skills.database_id) continue
        const target =
          exact === undefined
            ? [...value.pages.values()].find((target) => target.record.id === selector)
            : value.pages.get(exact)
        if (target !== undefined) return { library: value.library, rawPage: target.rawPage }
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
        const key = (owner: string) => canonicalSharedJson([library.library_id, owner])
        const existing = selectedMetadata.get(key(selected.locator.page_id))
        if (existing !== undefined) return existing
        const candidates = yield* checked(() => {
          const current = find(selected.id, library.skills.database_id)
          if (current === undefined || property(current.rawPage).id !== selected.locator.page_id)
            throw fail(
              "SHARED_SKILL_ID_CONFLICT",
              "The selected Skill changed identity during the shared metadata observation.",
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
        const files = yield* queryCurrentFilesForSkills({
          dataSourceId: library.files.data_source_id,
          propertyIds: library.files.property_ids,
          skillPageIds: owners,
        })
        for (const owner of owners)
          selectedMetadata.set(key(owner), {
            files: files.get(owner) ?? [],
          })
        return selectedMetadata.get(key(selected.locator.page_id))!
      })
    return yield* effect.pipe(
      Effect.provideService(SharedGraphReads, {
        inventory,
        targets,
        identity: (library, skillId) =>
          Effect.gen(function* () {
            yield* checked(() => checkLibrary(library))
            const id = yield* checked(() => skillIdentity(library.library_id, skillId))
            const found = yield* checked(() => find(id, library.skills.database_id))
            if (found !== undefined)
              return {
                rawPage: found.rawPage,
                record: yield* checked(() =>
                  sharedRecordFromPage(
                    found.rawPage,
                    sourceFor(library),
                    library.skills.data_source_id,
                  ),
                ),
              }
            if (completed.has(library.library_id))
              return yield* Effect.fail(
                fail(
                  "SKILL_NOT_FOUND",
                  "No current Skill has the selected stable identity in this library.",
                  { id },
                ),
              )
            const selected = yield* querySelectedSkillIdentity(library, skillId)
            const known = selectedTargets.get(library.library_id) ?? {
              library,
              pages: new Map<string, SelectedSharedSkillMetadata>(),
            }
            known.pages.set(selected.record.locator.page_id, selected)
            selectedTargets.set(library.library_id, known)
            return selected
          }),
        observe: (library, raw, supplied) =>
          Effect.gen(function* () {
            if (supplied !== undefined) yield* checked(() => rememberInventory(library, supplied))
            yield* targets(library, [String(property(raw).id)], [raw])
            return completed.get(library.library_id)?.inventory
          }),
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

/** Observe the selected current page without requiring discovery of the whole library. */
export function observeSharedGraphTarget(
  library: SharedLibrary,
  raw: unknown,
  inventory?: CompleteSharedSkillInventory,
) {
  return Effect.gen(function* () {
    const context = yield* Effect.serviceOption(SharedGraphReads)
    return Option.isSome(context)
      ? yield* context.value.observe(library, raw, inventory)
      : inventory
  })
}

export function sharedGraphSkillTargets(
  library: SharedLibrary,
  ids: readonly string[],
  inventory?: CompleteSharedSkillInventory,
) {
  return Effect.gen(function* () {
    if (inventory !== undefined)
      return yield* checked(() => selectedSkillsFromInventory(library, ids, inventory))
    const context = yield* Effect.serviceOption(SharedGraphReads)
    return Option.isSome(context)
      ? yield* context.value.targets(library, ids)
      : yield* querySelectedSkillMetadata(library, ids)
  })
}

export function sharedGraphSkillIdentity(library: SharedLibrary, skillId: string) {
  return Effect.gen(function* () {
    const context = yield* Effect.serviceOption(SharedGraphReads)
    return Option.isSome(context)
      ? yield* context.value.identity(library, skillId)
      : yield* querySelectedSkillIdentity(library, skillId)
  })
}
