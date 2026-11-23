import { Effect, Schema } from "effect"
import {
  fail,
  listSchema,
  property,
  SkillsError,
  type ContentKind,
  type SharedSkillRecord,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { validatePortableRelations, type PortableRelations } from "./portable.ts"
import { pageId } from "./ref.ts"
import { sharedRecordFromPage, skillIdentity } from "./shared-content.ts"
import { parseSkillIdentity } from "./skill-ref.ts"
import { queryCurrentSkillIndex } from "./shared-current-index.ts"
import type { CurrentOperationSession } from "./shared-current-operation.ts"
import type { SharedLibrary, SharedSkillRelationField } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { completeSharedSkillRelationIds } from "./shared-router-members.ts"

const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_RELATION_INVALID", message, details)
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("The current relation boundary is invalid."),
  })
const fields = ["Members", "Requires"] as const
const keyFor = (field: SharedSkillRelationField) => (field === "Members" ? "members" : "requires")
const same = (a: readonly string[], b: readonly string[]) =>
  canonicalSharedJson([...a].sort()) === canonicalSharedJson([...b].sort())
function exactId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu.test(value)
  )
    throw invalid("A relation requires an exact physical page identity.")
  const id = pageId(value)
  if (id === undefined) throw invalid("A relation requires an exact physical page identity.")
  return id
}

/** The portable selection is author intent. Omission preserves; [] clears. */
export function validateCurrentWriteRelations(
  input: unknown,
  kind: ContentKind,
  skillId: string,
): PortableRelations {
  const value = validatePortableRelations(input)
  if (kind === "prompt") throw invalid("Prompts cannot own Members or Requires relations.")
  const owner = skillIdentity(value.library_id, skillId)
  for (const field of fields)
    if (value[keyFor(field)]?.includes(owner))
      throw invalid("A Skill cannot select itself as a relation target.", { field })
  return {
    version: 1,
    ownership: "notion",
    library_id: value.library_id,
    ...(value.members === undefined ? {} : { members: [...value.members].sort() }),
    ...(value.requires === undefined ? {} : { requires: [...value.requires].sort() }),
  }
}
function record(library: SharedLibrary, raw: unknown): SharedSkillRecord {
  if (property(raw).object !== "page") throw invalid("Relation metadata is not a complete page.")
  return sharedRecordFromPage(
    raw,
    {
      alias: library.library_id,
      title: "",
      role: "content",
      database_id: library.skills.database_id,
      data_source_ids: [library.skills.data_source_id],
      shared_library: library,
    },
    library.skills.data_source_id,
  )
}
type Target = { readonly raw: unknown; readonly record: SharedSkillRecord }
type Selection = {
  readonly field: SharedSkillRelationField
  readonly before: readonly string[]
  readonly desired: readonly string[]
}
export type CurrentRelationPlan = {
  readonly skill_id: string
  readonly kind: ContentKind
  readonly selections: readonly Selection[]
  readonly targets: ReadonlyMap<string, Target>
  readonly requires: ReadonlyMap<string, readonly string[]>
}
function target(library: SharedLibrary, raw: unknown) {
  return Effect.gen(function* () {
    const selected = yield* checked(() => record(library, raw))
    const index = yield* queryCurrentSkillIndex(library, selected.locator.page_id, raw, [])
    if (index.kind !== "skill" || !index.enabled || index.state.state !== "ready")
      return yield* Effect.fail(
        invalid("Every relation target must be an enabled, ready current Skill in this library.", {
          skill_id: index.skill_id,
          page_id: index.page_id,
          kind: index.kind,
          state: index.state.state,
        }),
      )
    return { raw, record: selected } satisfies Target
  })
}
function assertSchema(library: SharedLibrary, selected: readonly SharedSkillRelationField[]) {
  return Effect.gen(function* () {
    const raw = yield* (yield* Notion).request(`v1/data_sources/${library.skills.data_source_id}`)
    yield* checked(() => {
      const value = property(raw)
      if (value.object !== "data_source" || exactId(value.id) !== library.skills.data_source_id)
        throw invalid("The relation schema belongs to another Skills data source.")
      for (const field of selected) {
        const id = library.skills.property_ids[field]
        const matches = Object.entries(property(value.properties)).flatMap(([key, raw]) =>
          key === id || property(raw).id === id ? [property(raw)] : [],
        )
        const schema = matches[0],
          relation = property(schema?.relation)
        if (
          !id ||
          matches.length !== 1 ||
          schema?.type !== "relation" ||
          relation.type !== "single_property" ||
          exactId(relation.data_source_id) !== library.skills.data_source_id ||
          Object.entries(library.skills.property_ids).some(
            ([name, value]) => name !== field && value === id,
          )
        )
          throw fail(
            "CURRENT_RELATION_SCHEMA",
            "Current Members and Requires must be distinct, registered, one-way relations to this Skills data source.",
            { field },
          )
      }
    })
  })
}
/** Resolve only requested logical identities. A missing or repeated result is never an absent relation. */
function queryTargets(library: SharedLibrary, skillIds: readonly string[]) {
  return Effect.gen(function* () {
    const api = yield* Notion,
      result = new Map<string, Target>(),
      physical = new Set<string>()
    const ids = [...new Set(skillIds)].sort()
    const params = new URLSearchParams()
    for (const name of [
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
      "Requires",
    ])
      if (library.skills.property_ids[name] !== undefined)
        params.append("filter_properties", library.skills.property_ids[name]!)
    for (let offset = 0; offset < ids.length; offset += 80) {
      const selected = ids.slice(offset, offset + 80),
        seen = new Set<string>()
      let cursor: string | undefined
      for (;;) {
        const filters = selected.map((skill) => ({
          property: library.skills.property_ids["Skill ID"],
          rich_text: { equals: skill },
        }))
        const raw = yield* api.request(
          `v1/data_sources/${library.skills.data_source_id}/query?${params}`,
          {
            page_size: 100,
            filter: filters.length === 1 ? filters[0] : { or: filters },
            ...(cursor === undefined ? {} : { start_cursor: cursor }),
          },
          { method: "POST" },
        )
        const page = yield* checked(() => {
          const outer = property(raw)
          if (
            outer.object !== "list" ||
            (outer.request_status !== undefined &&
              property(outer.request_status).type !== "complete")
          )
            throw invalid("The relation target query is incomplete.")
          const page = Schema.decodeUnknownSync(listSchema(Schema.Unknown))(raw)
          if (
            page.has_more
              ? !page.next_cursor || page.next_cursor.length > 2048 || seen.has(page.next_cursor)
              : page.next_cursor !== null
          )
            throw invalid("The relation target query did not finish or advance.")
          return page
        })
        for (const raw of page.results) {
          const value = yield* target(library, raw),
            logical = value.record.locator.skill_id,
            physicalId = value.record.locator.page_id
          if (!selected.includes(logical) || result.has(logical) || physical.has(physicalId))
            return yield* Effect.fail(
              invalid(
                "A selected logical Skill has a missing, repeated or foreign physical binding.",
                { skill_id: logical },
              ),
            )
          result.set(logical, value)
          physical.add(physicalId)
        }
        if (!page.has_more) break
        cursor = page.next_cursor!
        seen.add(cursor)
      }
      for (const logical of selected)
        if (!result.has(logical))
          return yield* Effect.fail(
            invalid("A selected relation target is missing or inaccessible.", {
              skill_id: logical,
            }),
          )
    }
    return result
  })
}
function relationIds(library: SharedLibrary, raw: unknown, field: SharedSkillRelationField) {
  return Effect.gen(function* () {
    const owner = yield* checked(() => record(library, raw))
    return yield* completeSharedSkillRelationIds(library, owner, raw, field, {
      allowDisabled: true,
    })
  })
}
function assertAcyclic(edges: ReadonlyMap<string, readonly string[]>): void {
  const colors = new Map<string, "active" | "done">()
  for (const start of edges.keys()) {
    if (colors.has(start)) continue
    const stack: { page: string; after: boolean }[] = [{ page: start, after: false }]
    while (stack.length) {
      const node = stack.pop()!
      if (node.after) {
        colors.set(node.page, "done")
        continue
      }
      const color = colors.get(node.page)
      if (color === "active")
        throw fail(
          "CURRENT_REQUIRES_CYCLE",
          "The selected Requires closure contains a dependency cycle.",
          { page_id: node.page },
        )
      if (color === "done") continue
      colors.set(node.page, "active")
      stack.push({ ...node, after: true })
      for (const child of [...(edges.get(node.page) ?? [])].reverse())
        stack.push({ page: child, after: false })
    }
  }
}

/** Compile one explicit batch's final graph before its first body write. Future
 * batch targets are exact declarations; outside targets still require complete
 * current identity observations. Requires run prerequisites first, so replacing
 * old edges cannot manufacture a transient cycle in an acyclic final graph. */
export function prepareCurrentBatchRelations(
  library: SharedLibrary,
  inputs: readonly {
    readonly skill_id: string
    readonly kind: ContentKind
    readonly enabled: boolean
    readonly relations?: PortableRelations
    readonly owner?: unknown
  }[],
) {
  return Effect.gen(function* () {
    const planned = new Map(inputs.map((input) => [input.skill_id, input]))
    if (planned.size !== inputs.length)
      return yield* Effect.fail(invalid("A batch cannot repeat a stable Skill identity."))
    const selected = new Set<SharedSkillRelationField>()
    const externalIds = new Set<string>()
    const oversized: {
      readonly input: (typeof inputs)[number]
      readonly field: SharedSkillRelationField
      readonly values: readonly string[]
    }[] = []
    for (const input of inputs) {
      if (input.relations === undefined) continue
      const relations = yield* checked(() =>
        validateCurrentWriteRelations(input.relations, input.kind, input.skill_id),
      )
      if (relations.library_id !== library.library_id)
        return yield* Effect.fail(
          fail(
            "PORTABLE_RELATION_SCOPE",
            "Batch relations must name the destination Library explicitly.",
          ),
        )
      for (const field of fields) {
        const values = relations[keyFor(field)]
        if (values === undefined) continue
        selected.add(field)
        if (values.length > 100) oversized.push({ input, field, values })
        for (const ref of values) {
          const id = parseSkillIdentity(ref).skillId
          const target = planned.get(id)
          if (target === undefined) externalIds.add(id)
          else if (target.kind !== "skill" || !target.enabled)
            return yield* Effect.fail(
              invalid("Every batch relation target must become an enabled Skill.", {
                skill_id: id,
              }),
            )
        }
      }
    }
    if (selected.size) yield* assertSchema(library, [...selected])
    const observed = yield* queryTargets(library, [...externalIds])
    const byPage = new Map(
      [...observed.values()].map((value) => [value.record.locator.page_id, value]),
    )
    const resolvePages = (pages: readonly string[]) =>
      Effect.gen(function* () {
        const ids: string[] = []
        for (const page of pages) {
          let value = byPage.get(page)
          if (value === undefined) {
            value = yield* target(library, yield* (yield* Notion).request(`v1/pages/${page}`))
            if (value.record.locator.page_id !== page)
              return yield* Effect.fail(invalid("Requires returned another physical owner."))
            byPage.set(page, value)
            observed.set(value.record.locator.skill_id, value)
          }
          ids.push(value.record.locator.skill_id)
        }
        return ids
      })
    for (const { input, field, values } of oversized) {
      const before =
        input.owner === undefined
          ? []
          : yield* resolvePages(yield* relationIds(library, input.owner, field))
      const desired = values.map((ref) => parseSkillIdentity(ref).skillId)
      if (!same(before, desired))
        return yield* Effect.fail(
          fail(
            "CURRENT_RELATION_WRITE_LIMIT",
            "A changed batch relation must contain at most 100 targets.",
            { field, skill_id: input.skill_id },
          ),
        )
    }
    if (!inputs.some((input) => input.relations?.requires !== undefined))
      return inputs.map((input) => input.skill_id)
    const edges = new Map<string, readonly string[]>()
    const pending = inputs
      .filter((input) => input.relations?.requires !== undefined)
      .map((input) => input.skill_id)
    let edgeCount = 0
    for (let at = 0; at < pending.length; at++) {
      const id = pending[at]!
      if (edges.has(id)) continue
      if (edges.size >= 10000 || edgeCount > 100000)
        return yield* Effect.fail(
          fail("CURRENT_RELATION_GRAPH_LIMIT", "The batch Requires closure exceeds its bound."),
        )
      const input = planned.get(id)
      let children: readonly string[]
      if (input?.relations?.requires !== undefined)
        children = input.relations.requires.map((ref) => parseSkillIdentity(ref).skillId)
      else {
        const raw = input?.owner ?? observed.get(id)?.raw
        children =
          raw === undefined ? [] : yield* resolvePages(yield* relationIds(library, raw, "Requires"))
      }
      edges.set(id, children)
      edgeCount += children.length
      pending.push(...children)
    }
    yield* checked(() => assertAcyclic(edges))
    const unique = yield* queryTargets(library, [...observed.keys()])
    for (const [id, value] of observed) {
      const fresh = unique.get(id)
      if (
        fresh?.record.locator.page_id !== value.record.locator.page_id ||
        (!planned.has(id) &&
          !same(
            yield* relationIds(library, value.raw, "Requires"),
            yield* relationIds(library, fresh.raw, "Requires"),
          ))
      )
        return yield* Effect.fail(
          invalid("A batch dependency changed its unique physical identity."),
        )
    }
    const ordered: string[] = [],
      done = new Set<string>()
    for (const input of inputs) {
      const stack = [{ id: input.skill_id, after: false }]
      while (stack.length) {
        const current = stack.pop()!
        if (current.after) {
          if (planned.has(current.id)) ordered.push(current.id)
        } else if (!done.has(current.id)) {
          done.add(current.id)
          stack.push({ ...current, after: true })
          for (const child of [...(edges.get(current.id) ?? [])].reverse())
            stack.push({ id: child, after: false })
        }
      }
    }
    return ordered
  })
}
/** Complete write preflight: only explicit fields are observed, and only changed Requires traverses dependencies. */
export function prepareCurrentRelations(
  library: SharedLibrary,
  input: {
    readonly skill_id: string
    readonly kind: ContentKind
    readonly relations?: PortableRelations
    readonly reconciling?: boolean
    readonly owner?: { readonly page_id: string; readonly raw: unknown }
  },
) {
  return Effect.gen(function* () {
    const retained =
      input.relations === undefined
        ? undefined
        : yield* checked(() =>
            validateCurrentWriteRelations(input.relations, input.kind, input.skill_id),
          )
    const empty: CurrentRelationPlan = {
      skill_id: input.skill_id,
      kind: input.kind,
      selections: [],
      targets: new Map(),
      requires: new Map(),
    }
    if (retained === undefined) return empty
    if (retained.library_id !== library.library_id)
      return yield* Effect.fail(
        fail(
          "PORTABLE_RELATION_SCOPE",
          "Import current relations into their exact original library; names never select targets.",
        ),
      )
    const selected = fields.filter((field) => retained[keyFor(field)] !== undefined)
    if (!selected.length) return empty
    yield* assertSchema(library, selected)
    const logical = selected.flatMap((field) =>
      retained[keyFor(field)]!.map((ref) => parseSkillIdentity(ref).skillId),
    )
    const queried = yield* queryTargets(library, logical)
    const targets = new Map(
      [...queried.values()].map((value) => [value.record.locator.page_id, value]),
    )
    const selections: Selection[] = []
    for (const field of selected) {
      const desired = retained[keyFor(field)]!.map(
        (ref) => queried.get(parseSkillIdentity(ref).skillId)!.record.locator.page_id,
      ).sort()
      const before =
        input.owner === undefined ? [] : yield* relationIds(library, input.owner.raw, field)
      if (desired.length > 100 && !same(before, desired))
        return yield* Effect.fail(
          fail(
            "CURRENT_RELATION_WRITE_LIMIT",
            "Notion replaces a complete relation with at most 100 targets per request. Larger current sets can only be retained unchanged.",
            { field, targets: desired.length },
          ),
        )
      selections.push({ field, before: [...before].sort(), desired })
    }
    const requires = new Map<string, readonly string[]>()
    const requested = selections.find((selection) => selection.field === "Requires")
    if (
      requested !== undefined &&
      (input.reconciling === true || !same(requested.before, requested.desired))
    ) {
      const pending = [...requested.desired],
        lookedUp = new Set<string>()
      let edgeCount = 0
      for (let offset = 0; offset < pending.length; offset++) {
        const page = pending[offset]!
        if (requires.has(page)) continue
        if (requires.size >= 10000 || edgeCount > 100000)
          return yield* Effect.fail(
            fail(
              "CURRENT_RELATION_GRAPH_LIMIT",
              "The Requires metadata closure exceeds this bounded current write.",
            ),
          )
        if (page === input.owner?.page_id)
          return yield* Effect.fail(
            fail("CURRENT_REQUIRES_CYCLE", "The selected Requires closure returns to its owner."),
          )
        let value = targets.get(page)
        if (value === undefined) {
          value = yield* target(library, yield* (yield* Notion).request(`v1/pages/${page}`))
          if (value.record.locator.page_id !== page)
            return yield* Effect.fail(invalid("Requires metadata returned another physical page."))
          targets.set(page, value)
          lookedUp.add(value.record.locator.skill_id)
        }
        if (value.record.locator.skill_id === input.skill_id)
          return yield* Effect.fail(
            fail(
              "CURRENT_REQUIRES_CYCLE",
              "The selected Requires closure returns to its logical owner.",
            ),
          )
        const children = (yield* relationIds(library, value.raw, "Requires")).sort()
        requires.set(page, children)
        edgeCount += children.length
        if (edgeCount > 100000)
          return yield* Effect.fail(
            fail(
              "CURRENT_RELATION_GRAPH_LIMIT",
              "The Requires metadata closure exceeds this bounded current write.",
            ),
          )
        for (const child of children) pending.push(child)
      }
      yield* checked(() => assertAcyclic(requires))
      // A physical edge must still name one unique logical Skill in this table.
      const unique = yield* queryTargets(library, [...lookedUp])
      for (const value of targets.values()) {
        const fresh = unique.get(value.record.locator.skill_id)
        if (fresh === undefined) continue
        if (
          fresh.record.locator.page_id !== value.record.locator.page_id ||
          !same(
            requires.get(value.record.locator.page_id) ?? [],
            yield* relationIds(library, fresh.raw, "Requires"),
          )
        )
          return yield* Effect.fail(
            invalid("A Requires target or its dependencies changed during preparation."),
          )
      }
    }
    return {
      skill_id: input.skill_id,
      kind: input.kind,
      selections,
      targets,
      requires,
    } satisfies CurrentRelationPlan
  })
}
function observeOwner(
  library: SharedLibrary,
  plan: CurrentRelationPlan,
  page: string,
  raw: unknown,
) {
  return Effect.gen(function* () {
    const owner = yield* checked(() => record(library, raw))
    if (
      owner.locator.page_id !== page ||
      owner.locator.skill_id !== plan.skill_id ||
      owner.kind !== plan.kind
    )
      return yield* Effect.fail(
        invalid("The relation owner changed its physical or logical identity."),
      )
    let complete = true
    for (const selection of plan.selections) {
      const actual = yield* relationIds(library, raw, selection.field)
      if (same(actual, selection.desired)) continue
      if (selection.desired.length > 100 || !same(actual, selection.before))
        return yield* Effect.fail(
          invalid(
            "The current relation changed after preparation; inspect it before replacing the selection.",
            { field: selection.field },
          ),
        )
      complete = false
    }
    return complete
  })
}
/** One stable action replaces both selected fields. Truncated ACKs are completed through native property pagination. */
export function applyCurrentRelations(
  library: SharedLibrary,
  plan: CurrentRelationPlan,
  input: {
    readonly page_id: string
    readonly raw: unknown
    readonly dispatch: CurrentOperationSession["dispatch"]
  },
) {
  return Effect.gen(function* () {
    if (!plan.selections.length) return
    const properties = Object.fromEntries(
      plan.selections
        .filter((value) => value.desired.length <= 100)
        .map((value) => [
          library.skills.property_ids[value.field]!,
          { relation: value.desired.map((id) => ({ id })) },
        ]),
    )
    yield* input.dispatch({
      key: "skill:relations",
      replay: "idempotent",
      request: {
        path: `v1/pages/${input.page_id}`,
        body: { properties },
        options: { method: "PATCH" },
      },
      observe: ({ fresh }) =>
        Effect.gen(function* () {
          const raw =
            fresh || plan.selections.some((selection) => !same(selection.before, selection.desired))
              ? yield* (yield* Notion).request(`v1/pages/${input.page_id}`)
              : input.raw
          return (yield* observeOwner(library, plan, input.page_id, raw))
            ? ({ status: "complete", value: undefined } as const)
            : ({ status: "missing" } as const)
        }),
      acknowledge: (raw) =>
        Effect.gen(function* () {
          if (!(yield* observeOwner(library, plan, input.page_id, raw)))
            return yield* Effect.fail(
              fail(
                "WRITE_OUTCOME_UNKNOWN",
                "The relation replacement was not confirmed by its current page.",
              ),
            )
        }),
    })
  })
}
/** Recheck current logical-to-physical bindings and the dependency edges actually used by this invocation. */
export function verifyCurrentRelations(
  library: SharedLibrary,
  plan: CurrentRelationPlan,
  page: string,
  raw: unknown,
) {
  return Effect.gen(function* () {
    if (!plan.selections.length) return
    if (!(yield* observeOwner(library, plan, page, raw)))
      return yield* Effect.fail(
        invalid("The final owner relations differ from the selected complete sets."),
      )
    const current = yield* queryTargets(
      library,
      [...plan.targets.values()].map((value) => value.record.locator.skill_id),
    )
    for (const [id, previous] of plan.targets) {
      const fresh = current.get(previous.record.locator.skill_id)
      if (fresh?.record.locator.page_id !== id)
        return yield* Effect.fail(
          invalid("A selected relation target changed physical identity before completion."),
        )
      const expected = plan.requires.get(id)
      if (
        expected !== undefined &&
        !same(expected, yield* relationIds(library, fresh.raw, "Requires"))
      )
        return yield* Effect.fail(
          invalid("The Requires closure changed before completion; reselect current dependencies."),
        )
    }
  })
}
export function currentRelationsInfo(plan: CurrentRelationPlan) {
  return Object.fromEntries(
    plan.selections.map((selection) => [
      keyFor(selection.field),
      {
        action: same(selection.before, selection.desired) ? "retain" : "replace",
        targets: selection.desired.length,
      },
    ]),
  )
}
