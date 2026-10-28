import { Effect } from "effect"
import { resolveDatabasePropertyIds } from "./database-init.ts"
import {
  ContentKindSchema,
  DatabaseSchema,
  decode,
  fail,
  listSchema,
  PageSchema,
  property,
  SkillsError,
  text,
  type ContentKind,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"

export type PublishedUpstreamLookup = (
  memberKey: string,
  kind: ContentKind,
) => Effect.Effect<string | undefined, SkillsError>

/** One fresh, fully paginated publisher inventory, owned only by the current plan. */
export function readPublishedUpstreamPages(
  targetDatabaseId: string,
  publisherSubscriptionId: string,
) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const raw = yield* api.request(`v1/databases/${targetDatabaseId}`)
    const db = yield* Effect.try({
      try: () => decode(DatabaseSchema, raw),
      catch: () => fail("INVALID_RESPONSE", "Invalid upstream target database."),
    })
    if (db.id !== targetDatabaseId || db.in_trash || !db.data_sources.length)
      return yield* Effect.fail(
        fail("UPSTREAM_TARGET_UNAVAILABLE", "Upstream target database is unavailable."),
      )
    const members = new Map<string, { id: string; kind: ContentKind }[]>()
    for (const source of db.data_sources) {
      const ids = yield* resolveDatabasePropertyIds(source.id, targetDatabaseId)
      if (!ids.Upstream || !ids["Upstream Key"])
        return yield* Effect.fail(
          fail("DATABASE_SCHEMA_CONFLICT", "Target lacks native upstream ownership properties."),
        )
      let cursor: string | undefined
      const seen = new Set<string>()
      do {
        const result = yield* api.request(`v1/data_sources/${source.id}/query`, {
          page_size: 100,
          filter: { property: ids.Upstream, relation: { contains: publisherSubscriptionId } },
          ...(cursor ? { start_cursor: cursor } : {}),
        })
        const page = yield* Effect.try({
          try: () => decode(listSchema(PageSchema), result),
          catch: () => fail("INVALID_RESPONSE", "Invalid upstream publisher inventory."),
        })
        yield* Effect.try({
          try: () => {
            const rawRows = property(result).results as unknown[]
            for (let i = 0; i < page.results.length; i++) {
              const member = page.results[i]!
              if (member.in_trash) continue
              const id = pageId(member.id)
              const parent = property(property(rawRows[i]).parent)
              if (
                !id ||
                parent.data_source_id !== source.id ||
                (parent.database_id !== undefined && parent.database_id !== targetDatabaseId)
              )
                throw fail(
                  "INVALID_RESPONSE",
                  "Upstream member belongs to an invalid target source.",
                )
              const fields = member.properties
              const relation = property(fields.Upstream)
              if (fields.Upstream === undefined) continue
              if (
                relation.type !== "relation" ||
                relation.has_more === true ||
                !Array.isArray(relation.relation) ||
                relation.relation.length > 1
              )
                throw fail(
                  "INVALID_UPSTREAM",
                  "Upstream must contain at most one complete owner relation.",
                )
              if (relation.relation.length === 0) continue
              if (pageId(String(property(relation.relation[0]).id)) !== publisherSubscriptionId)
                continue
              const key = property(fields["Upstream Key"])
              if (fields["Upstream Key"] === undefined) continue
              if (key.type !== "rich_text" || !Array.isArray(key.rich_text))
                throw fail("INVALID_UPSTREAM", "Upstream Key must be rich_text.")
              const memberKey = text(key.rich_text)
              if (!memberKey) continue
              const rawKind = fields.Kind
              const kind = property(rawKind)
              if (rawKind !== undefined && kind.type !== "select")
                throw fail("INVALID_RESPONSE", "Kind must be a select property.")
              const decodedKind =
                rawKind === undefined || kind.select === null
                  ? "skill"
                  : decode(ContentKindSchema, property(kind.select).name)
              const matches = members.get(memberKey)
              const match = { id, kind: decodedKind }
              if (matches) matches.push(match)
              else members.set(memberKey, [match])
            }
          },
          catch: (error) =>
            error instanceof SkillsError
              ? error
              : fail("INVALID_RESPONSE", "Invalid upstream identity metadata."),
        })
        if (!page.has_more) break
        if (!page.next_cursor || seen.has(page.next_cursor))
          return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid upstream identity cursor."))
        cursor = page.next_cursor
        seen.add(cursor)
      } while (cursor)
    }
    const lookup: PublishedUpstreamLookup = (memberKey, kind) =>
      Effect.gen(function* () {
        const matches = members.get(memberKey)
        if (matches && (matches.length > 1 || matches[0]!.kind !== kind))
          return yield* Effect.fail(
            fail(
              "UPSTREAM_IDENTITY_CONFLICT",
              "Content pages claim an ambiguous subscription/member identity or a different kind.",
              { page_ids: matches.map((match) => match.id) },
            ),
          )
        return matches?.[0]?.id
      })
    return lookup
  })
}
