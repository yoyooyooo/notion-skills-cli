import { Effect, Schema } from "effect"
import {
  aliasFor,
  DatabaseSchema,
  decode,
  fail,
  listSchema,
  PageSchema,
  property,
  text,
  SkillsError,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { configuration, Store } from "./store.ts"
import { pageId } from "./ref.ts"
import { decodePublishedMembers } from "./upstream-subscription.ts"
export { PublishedMembersSchema } from "./upstream-model.ts"
import { publicationMarker } from "./publication-integrity.ts"
import { strictJson, UpstreamSourceSchema } from "./upstream-model.ts"
import type { PublishedMembers } from "./upstream-model.ts"
export { decodePublishedMembers } from "./upstream-subscription.ts"

export const SUBSCRIPTION_ROUTER_MIN_MEMBERS = 2

export interface PublishedSubscription {
  readonly subscription_id: string
  readonly database_id: string
  readonly data_source_id: string
  readonly target_database_id: string
  readonly name: string
  readonly description: string
  readonly default_context: boolean
  readonly members: readonly { readonly page_id: string }[]
  readonly revision: string
  readonly published: PublishedMembers
  readonly source: typeof UpstreamSourceSchema.Type
}

/** Decode the same authority whether obtained by a fresh page read or a complete query. */
export function publishedSubscriptionFromPage(
  database: string,
  db: typeof DatabaseSchema.Type,
  raw: unknown,
  subscriptionId: string,
): PublishedSubscription {
  const row = decode(PageSchema, raw)
  const ds = property(property(raw).parent).data_source_id
  if (
    row.id !== subscriptionId ||
    db.id !== database ||
    typeof ds !== "string" ||
    !db.data_sources.some((source) => source.id === ds) ||
    row.in_trash ||
    db.in_trash
  )
    throw fail(
      "UPSTREAM_ROUTER_UNAVAILABLE",
      "The subscription has been removed or belongs to another database.",
    )
  const props = row.properties
  const field = (name: string, type = "rich_text") => {
    const p = property(props[name])
    if (p.type !== type) throw fail("INVALID_UPSTREAM", `Invalid subscription ${name}.`)
    return text(p[type])
  }
  const published = decodePublishedMembers(field("Published Members"))
  const source = strictJson(UpstreamSourceSchema, field("Source"))
  if (
    !published ||
    !["verified", "partial", "disabled"].includes(
      String(property(property(props.Status).select).name),
    )
  )
    throw fail(
      "UPSTREAM_ROUTER_UNAVAILABLE",
      "The subscription has no verified published active map.",
    )
  const checkbox = property(props["Default Context"])
  if (checkbox.type !== "checkbox" || typeof checkbox.checkbox !== "boolean")
    throw fail("INVALID_UPSTREAM", "Default Context must be checkbox.")
  const target = pageId(field("Target Database ID"))
  const name = field("Name", "title")
  aliasFor(name)
  if (!target) throw fail("INVALID_UPSTREAM", "Subscription target database must be a UUID.")
  return {
    published,
    source,
    subscription_id: subscriptionId,
    database_id: database,
    data_source_id: ds,
    target_database_id: target,
    name,
    description: field("Description"),
    default_context: checkbox.checkbox,
    revision: published.revision,
    members: published.members.map((member) => ({ page_id: member.page_id })),
  }
}

/** Metadata only: membership never authorizes reading a body during discovery. */
export function validatePublishedMember(
  parsed: PublishedSubscription,
  member: PublishedMembers["members"][number],
  rawMember: unknown,
) {
  const page = decode(PageSchema, rawMember),
    props = page.properties
  const relation = property(props.Upstream)
  const links = relation.relation
  const sourceHash = text(property(props["Published Hash"]).rich_text)
  const kind = property(props.Kind)
  const marker = publicationMarker(rawMember)
  const prefix = parsed.source.strip_prefix?.replace(/\/$/, "")
  const relative =
    prefix && member.member_key.startsWith(prefix + "/")
      ? member.member_key.slice(prefix.length + 1)
      : member.member_key
  const ownerKey = parsed.source.target_prefix
    ? `${parsed.source.target_prefix}/${relative}`
    : relative
  if (marker?.state !== "committed")
    throw fail(
      "UPSTREAM_ROUTER_UNAVAILABLE",
      "An active member has no committed remote publication.",
      { page_id: member.page_id },
    )
  if (
    page.id !== member.page_id ||
    page.in_trash ||
    relation.type !== "relation" ||
    relation.has_more === true ||
    !Array.isArray(links) ||
    links.length !== 1 ||
    pageId(String(property(links[0]).id)) !== parsed.published.publisher_subscription_id ||
    text(property(props["Upstream Key"]).rich_text) !== ownerKey ||
    sourceHash !== member.content_hash ||
    (kind.type !== undefined &&
      (kind.type !== "select" || (kind.select !== null && property(kind.select).name !== "skill")))
  )
    throw fail(
      "UPSTREAM_ROUTER_UNAVAILABLE",
      "An active published member no longer matches its exact ownership and published hash.",
      { page_id: member.page_id },
    )
}

/** Router activation validates all members; a selected Skill validates only its own publication. */
export function resolvePublishedSubscription(
  subscriptionId: string,
  selection: { readonly type: "all" } | { readonly type: "member"; readonly pageId: string } = {
    type: "all",
  },
): Effect.Effect<
  PublishedSubscription & { readonly memberPages: ReadonlyMap<string, unknown> },
  SkillsError,
  Notion | Store
> {
  return Effect.gen(function* () {
    const id = pageId(subscriptionId)
    if (!id)
      return yield* Effect.fail(
        fail("EXACT_TARGET_REQUIRED", "Subscription Router requires a UUID."),
      )
    const config = yield* configuration
    const database = config.upstream_database && pageId(config.upstream_database)
    if (!database)
      return yield* Effect.fail(
        fail("UPSTREAM_NOT_CONFIGURED", "Subscription database is not configured."),
      )
    const api = yield* Notion
    const rawDatabase = yield* api.request(`v1/databases/${database}`)
    const raw = yield* api.request(`v1/pages/${id}`)
    const parsed = yield* Effect.try({
      try: () =>
        publishedSubscriptionFromPage(database, decode(DatabaseSchema, rawDatabase), raw, id),
      catch: (e) =>
        e instanceof SkillsError
          ? e
          : fail("INVALID_RESPONSE", "Invalid subscription Router metadata."),
    })
    const memberPages = new Map<string, unknown>()
    if (!parsed.members.length) return { ...parsed, memberPages }
    const rawTarget = yield* api.request(`v1/databases/${parsed.target_database_id}`)
    const target = yield* Effect.try({
      try: () => decode(DatabaseSchema, rawTarget),
      catch: () => fail("INVALID_RESPONSE", "Invalid published member database response."),
    })
    if (target.id !== parsed.target_database_id || target.in_trash)
      return yield* Effect.fail(
        fail("UPSTREAM_ROUTER_UNAVAILABLE", "The published member database is unavailable."),
      )
    if (selection.type === "member") {
      const member = parsed.published.members.find((member) => member.page_id === selection.pageId)
      if (!member)
        return yield* Effect.fail(
          fail(
            "SOURCE_MEMBER_UNAVAILABLE",
            "This page is absent from its active source publication map.",
            { page_id: selection.pageId },
          ),
        )
      const rawMember = yield* api.request(`v1/pages/${member.page_id}`)
      const parent = property(property(rawMember).parent)
      if (
        parent.database_id !== target.id ||
        !target.data_sources.some((source) => source.id === parent.data_source_id)
      )
        return yield* Effect.fail(
          fail(
            "UPSTREAM_ROUTER_UNAVAILABLE",
            "Selected member belongs to a different database or data source.",
            { page_id: member.page_id },
          ),
        )
      yield* Effect.try({
        try: () => validatePublishedMember(parsed, member, rawMember),
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail("INVALID_RESPONSE", "Invalid selected member response."),
      })
      memberPages.set(member.page_id, rawMember)
      return { ...parsed, memberPages }
    }
    const expected = new Map(parsed.published.members.map((member) => [member.page_id, member]))
    const MemberPage = Schema.Struct({ ...PageSchema.fields, parent: Schema.Unknown })
    for (const source of target.data_sources) {
      const path = `v1/data_sources/${source.id}/query`
      const cursors = new Set<string>()
      let cursor: string | undefined
      while (true) {
        const value = yield* api.request(path, {
          page_size: 100,
          filter: {
            property: "Upstream",
            relation: { contains: parsed.published.publisher_subscription_id },
          },
          ...(cursor ? { start_cursor: cursor } : {}),
        })
        const page = yield* Effect.try({
          try: () => decode(listSchema(MemberPage), value),
          catch: () => fail("INVALID_RESPONSE", "Invalid paginated published member response."),
        })
        for (const row of page.results) {
          const member = expected.get(row.id)
          if (!member) continue
          const parent = property(row.parent)
          if (
            memberPages.has(row.id) ||
            parent.database_id !== target.id ||
            parent.data_source_id !== source.id
          )
            return yield* Effect.fail(
              fail(
                "UPSTREAM_ROUTER_UNAVAILABLE",
                "Published member metadata has conflicting identity or scope.",
                { page_id: row.id },
              ),
            )
          yield* Effect.try({
            try: () => validatePublishedMember(parsed, member, row),
            catch: (e) =>
              e instanceof SkillsError
                ? e
                : fail("INVALID_RESPONSE", "Invalid published member response."),
          })
          memberPages.set(row.id, row)
        }
        if (!page.has_more) break
        if (!page.next_cursor || cursors.has(page.next_cursor))
          return yield* Effect.fail(
            fail(
              "INVALID_RESPONSE",
              "Published member query returned a missing or repeating cursor.",
            ),
          )
        cursors.add(page.next_cursor)
        cursor = page.next_cursor
      }
    }
    for (const member of parsed.published.members)
      if (!memberPages.has(member.page_id))
        return yield* Effect.fail(
          fail(
            "UPSTREAM_ROUTER_UNAVAILABLE",
            "An active published member is absent from the current metadata query.",
            { page_id: member.page_id },
          ),
        )
    return { ...parsed, memberPages }
  })
}
