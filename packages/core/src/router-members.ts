import { Effect } from "effect"
import {
  decode,
  fail,
  PageSchema,
  property,
  recordFromPage,
  SkillsError,
  type ContentKind,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId, parseTarget } from "./ref.ts"
import { metadata } from "./publication-observation.ts"

export interface MemberSource {
  readonly database_id: string
  readonly data_source_id: string
}

export function membersProperty(raw: unknown) {
  const value = property(property(property(raw).properties).Members)
  if (value.type !== "relation" || typeof value.id !== "string")
    throw fail("INVALID_MEMBERS", "Router Members must be an existing relation property.")
  return value
}

export function memberIds(raw: unknown): readonly string[] {
  const relation = property(property(property(raw).properties).Members)
  if (
    relation.type !== "relation" ||
    !Array.isArray(relation.relation) ||
    relation.has_more === true
  )
    throw fail("INVALID_MEMBERS", "Router Members must be a complete relation property.")
  return [
    ...new Set(
      relation.relation.map((item) => {
        const id = pageId(String(property(item).id))
        if (!id) throw fail("INVALID_MEMBERS", "Invalid Router member identity.")
        return id
      }),
    ),
  ].sort()
}

/** Resolve only current member metadata; member instructions and resources stay lazy. */
export function resolveRouterMembers(
  inputs: readonly string[],
  source: MemberSource,
  kind: ContentKind = "router",
) {
  return Effect.gen(function* () {
    if (kind !== "router")
      return yield* Effect.fail(fail("INVALID_MEMBERS", "Only Routers can author Members."))
    const api = yield* Notion
    const targets = yield* Effect.try({
      try: () =>
        inputs.map((input) => {
          const target = parseTarget(input)
          const id = pageId(target.selector)
          if (!id || target.snapshot)
            throw fail(
              "INVALID_MEMBERS",
              "Members require exact current content Skill page IDs or entrypoint refs.",
              { input },
            )
          return { id, path: target.path }
        }),
      catch: (error) => error as SkillsError,
    })
    const members = []
    for (const id of [...new Set(targets.map((target) => target.id))].sort()) {
      const raw = yield* api.request(`v1/pages/${id}`)
      const member = yield* Effect.try({
        try: () => {
          const row = decode(PageSchema, raw)
          const parent = property(property(raw).parent)
          if (
            row.in_trash ||
            pageId(row.id) !== id ||
            pageId(String(parent.database_id)) !== source.database_id ||
            pageId(String(parent.data_source_id)) !== source.data_source_id
          )
            throw fail(
              "INVALID_MEMBERS",
              "Router members must be accessible Skills in the same content library.",
              { page_id: id },
            )
          const record = recordFromPage(
            row,
            {
              alias: source.database_id,
              database_id: source.database_id,
              title: "",
              data_source_ids: [source.data_source_id],
              role: "content",
            },
            source.data_source_id,
          )
          if (record.kind !== "skill")
            throw fail(
              "INVALID_MEMBERS",
              "Router members must be Skills; nested Routers and Prompts are unsupported.",
              { id: record.id, kind: record.kind },
            )
          if (
            targets.some(
              (target) =>
                target.id === id && target.path !== undefined && target.path !== record.entrypoint,
            )
          )
            throw fail("INVALID_MEMBERS", "Member refs must select the Skill entrypoint.", {
              page_id: id,
            })
          return {
            id: record.id,
            kind: "skill" as const,
            name: record.name,
            description: record.description,
            ref: record.ref,
            metadata: metadata(raw),
          }
        },
        catch: (error) => error as SkillsError,
      })
      members.push(member)
    }
    return members
  })
}
