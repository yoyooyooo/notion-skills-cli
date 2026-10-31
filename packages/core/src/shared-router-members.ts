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
import { pageId } from "./ref.ts"
import {
  sharedRecordFromPage,
  sharedSkillProperty,
  validateSharedRecordIdentity,
} from "./shared-content.ts"
import type { SharedLibrary } from "./shared-library-model.ts"

export interface SharedRouterMember {
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

const InventoryPageSchema = listSchema(Schema.Unknown)
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

function relationBinding(library: SharedLibrary, router: SharedSkillRecord, rawPage: unknown) {
  const id = library.skills.property_ids.Members
  // Notion returns URL-encoded property IDs. Keep this path segment as returned;
  // encoding it again would address a different property (for example %3A -> %253A).
  if (typeof id !== "string" || !/^(?:[A-Za-z0-9._~-]|%[0-9a-f]{2})+$/iu.test(id))
    throw fail(
      "SHARED_ROUTER_MEMBERS_UNAVAILABLE",
      "This shared library has no registered native Members property; explicitly upgrade its descriptor before reading a Router.",
    )
  if (
    Object.entries(library.skills.property_ids).some(
      ([name, value]) => name !== "Members" && value === id,
    )
  )
    throw fail(
      "SHARED_ROUTER_MEMBERS_UNAVAILABLE",
      "The registered Members identity overlaps another Skills property.",
    )
  validateSharedRecordIdentity(router)
  const current = sharedRecordFromPage(rawPage, sourceFor(library), library.skills.data_source_id)
  if (
    router.kind !== "router" ||
    current.kind !== "router" ||
    router.enabled !== true ||
    current.enabled !== true ||
    router.id !== current.id ||
    router.locator.page_id !== current.locator.page_id ||
    router.locator.library_id !== library.library_id ||
    router.locator.database_id !== library.skills.database_id ||
    router.locator.data_source_id !== library.skills.data_source_id
  )
    throw fail(
      "INVALID_MEMBERS",
      "Members require the current enabled Router in this exact shared library.",
    )
  const relation = sharedSkillProperty(rawPage, library, "Members")
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

function completeMemberIds(library: SharedLibrary, router: SharedSkillRecord, rawPage: unknown) {
  return Effect.gen(function* () {
    const relation = yield* checked(() => relationBinding(library, router, rawPage))
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

function inventoryPath(library: SharedLibrary): string {
  const parameters = new URLSearchParams()
  for (const name of ["Name", "Description", "Kind", "Skill ID", "Enabled", "Default Context"]) {
    const id = library.skills.property_ids[name]
    if (typeof id !== "string" || id === "")
      throw fail("LIBRARY_INVALID", "A registered member metadata property is unavailable.", {
        property: name,
      })
    parameters.append("filter_properties", id)
  }
  return `v1/data_sources/${library.skills.data_source_id}/query?${parameters}`
}

/** Complete relation + one paginated metadata inventory; never reads member bodies. */
export function querySharedRouterMembers(
  library: SharedLibrary,
  input: {
    readonly router: SharedSkillRecord
    readonly rawPage: unknown
  },
): Effect.Effect<readonly SharedRouterMember[], SkillsError, Notion> {
  return Effect.gen(function* () {
    const wanted = new Set(yield* completeMemberIds(library, input.router, input.rawPage))
    if (wanted.size === 0) return []
    const source = sourceFor(library)
    const api = yield* Notion
    const path = yield* checked(() => inventoryPath(library))
    const records = new Map<string, SharedSkillRecord>()
    const claims = new Map<string, Set<string>>()
    const selectedPages = new Set<string>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const raw = yield* api.request(path, {
        page_size: 100,
        ...(cursor === undefined ? {} : { start_cursor: cursor }),
      })
      const page = yield* checked(() => {
        if (property(raw).object !== "list")
          throw fail(
            "SHARED_ROUTER_MEMBERS_INCOMPLETE",
            "Member metadata is not a complete data-source list.",
          )
        return decode(InventoryPageSchema, raw)
      })
      for (const item of page.results) {
        const pageIdentity = exactPage(property(item).id)
        const selected = pageIdentity !== undefined && wanted.has(pageIdentity)
        const record = yield* checked(() => {
          if (selected) {
            if (selectedPages.has(pageIdentity!))
              throw fail(
                "SHARED_ROUTER_MEMBERS_INCOMPLETE",
                "Member inventory repeated a selected page identity.",
              )
            selectedPages.add(pageIdentity!)
          }
          try {
            return sharedRecordFromPage(item, source, library.skills.data_source_id)
          } catch (error) {
            // Unrelated malformed rows do not make a selected Router unavailable.
            if (!selected && error instanceof SkillsError) return undefined
            throw error
          }
        })
        if (record === undefined) continue
        const pages = claims.get(record.id) ?? new Set<string>()
        pages.add(record.locator.page_id)
        claims.set(record.id, pages)
        if (selected) records.set(record.locator.page_id, record)
      }
      cursor = yield* checked(() => nextCursor(page, cursors))
    } while (cursor !== undefined)

    const members: SharedRouterMember[] = []
    for (const pageIdentity of wanted) {
      const record = records.get(pageIdentity)
      if (record === undefined)
        return yield* Effect.fail(
          fail(
            "SHARED_ROUTER_MEMBER_UNAVAILABLE",
            "A selected member is missing, inaccessible or outside this shared library.",
            { page_id: pageIdentity },
          ),
        )
      if ((claims.get(record.id)?.size ?? 0) > 1)
        return yield* Effect.fail(
          fail(
            "SHARED_SKILL_ID_CONFLICT",
            "Several shared pages claim a selected Router member's stable identity.",
            { id: record.id, page_ids: [...claims.get(record.id)!].sort() },
          ),
        )
      if (record.kind !== "skill")
        return yield* Effect.fail(
          fail(
            "INVALID_MEMBERS",
            "Shared Router members must be Skills; nested Routers and Prompts are unsupported.",
            { page_id: pageIdentity, kind: record.kind },
          ),
        )
      if (!record.enabled)
        return yield* Effect.fail(
          fail("SHARED_ROUTER_MEMBER_UNAVAILABLE", "A selected Router member is disabled.", {
            page_id: pageIdentity,
            reason: "disabled",
          }),
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

/** Match the existing native Router projection; authored instructions stay separate. */
export function renderSharedRouterMembers(members: readonly SharedRouterMember[]): string {
  return `\n\n## Members\n\n${members.map((member) => `- [${member.name}](${member.ref}) — ${member.description}`).join("\n")}\n`
}
