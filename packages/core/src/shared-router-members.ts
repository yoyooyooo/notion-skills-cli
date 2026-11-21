import { Effect, Schema } from "effect"
import { isSharedAuthoringTarget } from "./shared-authoring-context.ts"
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
import {
  sharedRecordFromPage,
  sharedSkillProperty,
  validateSharedRecordIdentity,
} from "./shared-content.ts"
import type { SharedLibrary, SharedSkillRelationField } from "./shared-library-model.ts"
import { sharedGraphSkillTargets } from "./shared-graph-read-context.ts"
export type { SharedSkillRelationField } from "./shared-library-model.ts"

export interface SharedSkillRelationTarget {
  readonly id: string
  readonly ref: string
  readonly kind: "skill"
  readonly name: string
  readonly description: string
  readonly metadata: {
    readonly version: 1
    readonly library_id: string
    readonly skill_id: string
    readonly page_id: string
    readonly database_id: string
    readonly data_source_id: string
    readonly kind: "skill"
    readonly enabled: true
    readonly name: string
    readonly description: string
  }
}

/** Historical Router callers use the same native relation engine. */
export type SharedRouterMember = SharedSkillRelationTarget

const RelationPageSchema = listSchema(
  Schema.Struct({
    object: Schema.Literal("property_item"),
    id: Schema.String,
    type: Schema.Literal("relation"),
    relation: Schema.Struct({ id: Schema.String }),
  }),
)

function checked<A>(run: () => A): Effect.Effect<A, SkillsError> {
  return Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("INVALID_MEMBERS", "Shared Router member metadata is invalid."),
  })
}

function exactPage(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu.test(value)
  )
    return undefined
  return pageId(value) ?? undefined
}

function memberPage(value: unknown): string {
  const id = exactPage(value)
  if (id === undefined)
    throw fail("INVALID_MEMBERS", "A Router relation contains an invalid page identity.")
  return id
}

function nextCursor(
  page: { readonly has_more: boolean; readonly next_cursor: string | null },
  seen: Set<string>,
) {
  if (!page.has_more) {
    if (page.next_cursor !== null)
      throw fail(
        "SHARED_ROUTER_MEMBERS_INCOMPLETE",
        "A final member metadata page retains an unexpected cursor.",
      )
    return undefined
  }
  const next = page.next_cursor
  if (next === null || next === "" || seen.has(next))
    throw fail("SHARED_ROUTER_MEMBERS_INCOMPLETE", "Member metadata pagination did not advance.")
  seen.add(next)
  return next
}

function sourceFor(library: SharedLibrary): Source {
  return {
    alias: library.library_id,
    title: "",
    role: "content",
    database_id: library.skills.database_id,
    data_source_ids: [library.skills.data_source_id],
    shared_library: library,
  }
}

function relationBinding(
  library: SharedLibrary,
  router: SharedSkillRecord,
  rawPage: unknown,
  field: SharedSkillRelationField,
  allowDisabled: boolean,
) {
  const id = library.skills.property_ids[field]
  // Notion returns URL-encoded property IDs. Keep this path segment as returned;
  // encoding it again would address a different property (for example %3A -> %253A).
  if (typeof id !== "string" || !/^(?:[A-Za-z0-9._~-]|%[0-9a-f]{2})+$/iu.test(id))
    throw fail(
      "SHARED_ROUTER_MEMBERS_UNAVAILABLE",
      `This shared library has no registered native ${field} property; explicitly upgrade its relation schema.`,
    )
  if (
    Object.entries(library.skills.property_ids).some(
      ([name, value]) => name !== field && value === id,
    )
  )
    throw fail(
      "SHARED_ROUTER_MEMBERS_UNAVAILABLE",
      "The registered Members identity overlaps another Skills property.",
    )
  validateSharedRecordIdentity(router)
  const current = sharedRecordFromPage(rawPage, sourceFor(library), library.skills.data_source_id)
  if (
    (router.kind !== "router" && router.kind !== "skill") ||
    current.kind !== router.kind ||
    (!allowDisabled && (router.enabled !== true || current.enabled !== true)) ||
    router.enabled !== current.enabled ||
    router.id !== current.id ||
    router.locator.page_id !== current.locator.page_id ||
    router.locator.library_id !== library.library_id ||
    router.locator.database_id !== library.skills.database_id ||
    router.locator.data_source_id !== library.skills.data_source_id
  )
    throw fail(
      "INVALID_MEMBERS",
      `${field} require the current enabled Skill or Router in this exact shared library.`,
    )
  const relation = sharedSkillProperty(rawPage, library, field)
  if (
    relation.type !== "relation" ||
    !Array.isArray(relation.relation) ||
    typeof relation.has_more !== "boolean"
  )
    throw fail(
      "SHARED_ROUTER_MEMBERS_UNAVAILABLE",
      "The registered Members property is not a readable native relation.",
    )
  const inline = relation.relation.map((item) => memberPage(property(item).id))
  if (new Set(inline).size !== inline.length)
    throw fail(
      "SHARED_ROUTER_MEMBERS_INCOMPLETE",
      "The Router Members relation repeats a page identity.",
    )
  return { id, inline, has_more: relation.has_more }
}

export function completeSharedSkillRelationIds(
  library: SharedLibrary,
  router: SharedSkillRecord,
  rawPage: unknown,
  field: SharedSkillRelationField,
  options: { readonly allowDisabled?: boolean } = {},
) {
  return Effect.gen(function* () {
    const relation = yield* checked(() =>
      relationBinding(library, router, rawPage, field, options.allowDisabled === true),
    )
    if (!relation.has_more) return relation.inline
    const api = yield* Notion
    const ids = new Set<string>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const query = new URLSearchParams({
        page_size: "100",
        ...(cursor === undefined ? {} : { start_cursor: cursor }),
      })
      const raw = yield* api.request(
        `v1/pages/${router.locator.page_id}/properties/${relation.id}?${query}`,
      )
      const page = yield* checked(() => {
        const value = property(raw)
        const metadata = property(value.property_item)
        if (
          value.object !== "list" ||
          value.type !== "property_item" ||
          metadata.id !== relation.id ||
          metadata.type !== "relation"
        )
          throw fail(
            "SHARED_ROUTER_MEMBERS_INCOMPLETE",
            "The returned property page does not belong to the registered Members relation.",
          )
        const decoded = decode(RelationPageSchema, raw)
        if (
          (decoded.has_more &&
            (typeof metadata.next_url !== "string" || metadata.next_url === "")) ||
          (!decoded.has_more && metadata.next_url !== null)
        )
          throw fail(
            "SHARED_ROUTER_MEMBERS_INCOMPLETE",
            "The Members property pagination metadata is incomplete.",
          )
        for (const item of decoded.results) {
          if (item.id !== relation.id)
            throw fail(
              "SHARED_ROUTER_MEMBERS_INCOMPLETE",
              "A property item belongs to another Members relation.",
            )
          const id = memberPage(item.relation.id)
          if (ids.has(id))
            throw fail(
              "SHARED_ROUTER_MEMBERS_INCOMPLETE",
              "The paginated Members relation repeats a page identity.",
            )
          ids.add(id)
        }
        return decoded
      })
      cursor = yield* checked(() => nextCursor(page, cursors))
    } while (cursor !== undefined)
    if (ids.size <= relation.inline.length || relation.inline.some((id) => !ids.has(id)))
      return yield* Effect.fail(
        fail(
          "SHARED_ROUTER_MEMBERS_INCOMPLETE",
          "Router membership changed while its complete relation was being observed; read it again.",
        ),
      )
    return [...ids]
  })
}

/** Complete relation plus exact physical targets and stable claims; never reads member bodies. */
export function querySharedSkillRelation(
  library: SharedLibrary,
  input: {
    readonly record: SharedSkillRecord
    readonly rawPage: unknown
    readonly field: SharedSkillRelationField
    /** The caller has exhausted this exact data source's inventory, including disabled rows. */
    readonly inventory?: {
      readonly data_source_id: string
      readonly complete: true
      readonly pages: readonly unknown[]
    }
  },
): Effect.Effect<readonly SharedSkillRelationTarget[], SkillsError, Notion> {
  return Effect.gen(function* () {
    const wanted = new Set(
      yield* completeSharedSkillRelationIds(library, input.record, input.rawPage, input.field, {
        allowDisabled: yield* isSharedAuthoringTarget(input.record.locator.page_id),
      }),
    )
    if (
      input.inventory !== undefined &&
      input.inventory.data_source_id !== library.skills.data_source_id
    )
      return yield* Effect.fail(
        fail("INVALID_MEMBERS", "The complete metadata inventory belongs to another data source."),
      )
    if (wanted.size === 0) return []
    const records = yield* sharedGraphSkillTargets(library, [...wanted], input.inventory).pipe(
      Effect.catch((error) =>
        ["SHARED_ROUTER_MEMBER_UNAVAILABLE", "SHARED_SKILL_ID_CONFLICT"].includes(error.code)
          ? Effect.fail(
              fail(error.code, `${input.field}: ${error.message}`, {
                ...property(error.details),
                field: input.field,
              }),
            )
          : Effect.fail(error),
      ),
    )

    const members: SharedSkillRelationTarget[] = []
    for (const pageIdentity of wanted) {
      const record = records.get(pageIdentity)?.record
      if (record === undefined)
        return yield* Effect.fail(
          fail(
            "SHARED_ROUTER_MEMBER_UNAVAILABLE",
            `A selected ${input.field} target is missing, inaccessible or outside this shared library.`,
            { field: input.field, page_id: pageIdentity },
          ),
        )
      if (record.kind !== "skill")
        return yield* Effect.fail(
          fail(
            "INVALID_MEMBERS",
            `${input.field} targets must be Skills; nested Routers and Prompts are unsupported.`,
            { field: input.field, page_id: pageIdentity, kind: record.kind },
          ),
        )
      if (!record.enabled)
        return yield* Effect.fail(
          fail(
            "SHARED_ROUTER_MEMBER_UNAVAILABLE",
            `A selected ${input.field} target is disabled.`,
            { field: input.field, page_id: pageIdentity, reason: "disabled" },
          ),
        )
      members.push({
        id: record.id,
        ref: record.ref,
        kind: "skill",
        name: record.name,
        description: record.description,
        metadata: {
          version: 1,
          library_id: library.library_id,
          skill_id: record.locator.skill_id,
          page_id: record.locator.page_id,
          database_id: record.locator.database_id,
          data_source_id: record.locator.data_source_id,
          kind: "skill",
          enabled: true,
          name: record.name,
          description: record.description,
        },
      })
    }
    return members.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  })
}

export function completeSharedRouterMemberIds(
  library: SharedLibrary,
  router: SharedSkillRecord,
  rawPage: unknown,
) {
  return completeSharedSkillRelationIds(library, router, rawPage, "Members")
}

export function querySharedRouterMembers(
  library: SharedLibrary,
  input: {
    readonly router: SharedSkillRecord
    readonly rawPage: unknown
    readonly inventory?: {
      readonly data_source_id: string
      readonly complete: true
      readonly pages: readonly unknown[]
    }
  },
) {
  return querySharedSkillRelation(library, {
    record: input.router,
    rawPage: input.rawPage,
    field: "Members",
    inventory: input.inventory,
  })
}
