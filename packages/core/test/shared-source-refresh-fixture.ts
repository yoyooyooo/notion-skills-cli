import { Effect } from "effect"
import type { HttpClient } from "effect/http"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Notion } from "../src/notion.ts"
import { property, SkillsError } from "../src/model.ts"
import { sourceDefinitionPropertiesFor } from "../src/shared-source-definitions.ts"
import { sourceDefinitionLayout, type SourceDefinitionInput } from "../src/shared-sources-model.ts"
import {
  library as base,
  sharedSnapshotFixture,
  id,
  skillPage,
  rich,
} from "./shared-snapshot-fixture.ts"
import type { SourceSnapshot } from "../src/upstream-source.ts"
import { Store } from "../src/store.ts"

const layout = sourceDefinitionLayout(base.skills.data_source_id, base.records.data_source_id),
  sourceIds = Object.fromEntries(
    Object.keys(layout).map((name, index) => [name, name === "Name" ? "title" : `s${index}`]),
  )
export const library = {
  ...base,
  skills: {
    ...base.skills,
    property_ids: {
      ...base.skills.property_ids,
      Members: "members",
      Requires: "requires",
      Origin: "origin",
      "Source Member": "source_member",
    },
  },
  records: { ...base.records, property_ids: { ...base.records.property_ids, Origin: "origin" } },
  sources: { database_id: id(80), data_source_id: id(81), property_ids: sourceIds },
}
export const definition: SourceDefinitionInput = {
  version: 1,
  source_id: "refresh-source",
  name: "Source name",
  description: "Upstream description",
  enabled: true,
  policy: "manual",
  adapter: { type: "git", url: "https://gitlab.com/org/repo.git", ref: "main" },
  selection: { roots: ["skills/demo"], include: [], exclude: [], mapping: {} },
  options: {},
}
const encode = (s: string) => new TextEncoder().encode(s)
export async function sourceRefreshFixture(
  options: {
    nativeMain?: string
    definition?: SourceDefinitionInput
    member?: string
    httpClient?: HttpClient.HttpClient
  } = {},
) {
  const f = sharedSnapshotFixture({ fileCount: 2, httpClient: options.httpClient })
  if (options.nativeMain !== undefined) f.bodies.set(skillPage, options.nativeMain)
  await f.open()
  const relatedPages: Record<string, unknown>[] = []
  const hooks: { beforeTargetPatch?: () => void } = {}
  const p = property(f.main.properties)
  p.origin = { id: "origin", type: "relation", relation: [{ id: id(82) }], has_more: false }
  p.source_member = rich("source_member", options.member ?? "skills/demo")
  p.members = { id: "members", type: "relation", relation: [], has_more: false }
  p.requires = { id: "requires", type: "relation", relation: [], has_more: false }
  const props = sourceDefinitionPropertiesFor(library, options.definition ?? definition),
    properties: Record<string, unknown> = {}
  for (const [name, shape] of Object.entries(layout)) {
    const key = sourceIds[name]!,
      type = Object.keys(shape)[0]!
    properties[key] = {
      id: key,
      type,
      ...(props[key] ??
        (type === "rich_text"
          ? { rich_text: [] }
          : type === "select"
            ? { select: null }
            : type === "relation"
              ? { relation: [], has_more: false }
              : { date: null })),
    }
  }
  const source = {
    object: "page",
    id: id(82),
    parent: { data_source_id: library.sources.data_source_id },
    in_trash: false,
    properties,
  }
  let snapshot: SourceSnapshot = {
    revision: "a".repeat(40),
    provenance: { provider: "git" },
    members: [
      {
        member_key: "skills/demo",
        source_path: "skills/demo",
        upstream_hash: "a".repeat(64),
        content_hash: "b".repeat(64),
        portable: {
          kind: "skill",
          name: "Source name",
          description: "Upstream description",
          main: "SKILL.md",
          files: [
            {
              path: "SKILL.md",
              bytes: encode(
                "---\nname: source\ndescription: upstream\nlicense: MIT\n---\n\nReplacement that must not overwrite custom main.\n",
              ),
            },
            {
              path: "references/1.md",
              bytes: encode("New upstream guide that must not replace custom body.\n"),
            },
            { path: "assets/file.bin", bytes: new Uint8Array([0, 255, 3, 128]) },
          ],
        },
      },
    ],
  }
  let acquisitions = 0
  const acquire = () => {
    acquisitions++
    return Effect.succeed(structuredClone(snapshot))
  }
  const run = <A, E, R>(action: Effect.Effect<A, E, R>) =>
    f.run(
      Effect.gen(function* () {
        const original = yield* Notion
        const api: Notion["Service"] = {
          ...original,
          request: (path, body, options) =>
            Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
              const method = options?.method ?? (body ? "POST" : "GET"),
                row =
                  path === `v1/pages/${source.id}`
                    ? source
                    : path === `v1/pages/${skillPage}`
                      ? f.main
                      : [...relatedPages, ...f.records.values()].find(
                          (r) => path === `v1/pages/${r.id}`,
                        )
              if (path === `v1/databases/${base.skills.database_id}`)
                return original.request(path, body, options).pipe(
                  Effect.map((raw) => ({
                    ...property(raw),
                    description: [
                      { plain_text: "ntn-skills-library:v1 " + JSON.stringify(library) },
                    ],
                  })),
                )
              if (path === `v1/pages/${source.id}` && method === "GET")
                return Effect.succeed(structuredClone(source))
              if (path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`)) {
                f.calls.push({ path, body, method })
                const origin = property(property(property(body).filter).relation).contains
                const rows = [f.main, ...relatedPages].filter(
                  (row) =>
                    origin === undefined ||
                    (property(property(row.properties).origin).relation instanceof Array &&
                      (property(property(row.properties).origin).relation as unknown[]).some(
                        (item) => property(item).id === origin,
                      )),
                )
                return Effect.succeed({
                  object: "list",
                  results: structuredClone(rows),
                  has_more: false,
                  next_cursor: null,
                })
              }
              if (row && method === "GET" && relatedPages.includes(row))
                return Effect.succeed(structuredClone(row))
              if (row && method === "PATCH") {
                if (row === f.main) hooks.beforeTargetPatch?.()
                f.calls.push({ path, body, method })
                const fields = property(row.properties)
                for (const [key, value] of Object.entries(property(property(body).properties))) {
                  const prior = property(fields[key])
                  fields[key] = {
                    ...prior,
                    id: key,
                    type: prior.type ?? Object.keys(property(value))[0],
                    ...property(value),
                    ...(property(value).relation ? { has_more: false } : {}),
                  }
                }
                return Effect.succeed(structuredClone(row))
              }
              if (row && f.records.has(String(row.id)) && method === "GET")
                return Effect.succeed(structuredClone(row))
              return original.request(path, body, options)
            }),
        }
        return yield* action.pipe(Effect.provideService(Notion, api))
      }).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<A, E, Store | Notion>,
    )
  return {
    ...f,
    run,
    source,
    get snapshot() {
      return snapshot
    },
    replaceSnapshot: (next: SourceSnapshot) => {
      snapshot = structuredClone(next)
    },
    acquire,
    relatedPages,
    hooks,
    acquisitions: () => acquisitions,
  }
}

export { sourceIds }

export function relation(id: string, pages: readonly string[]) {
  return { id, type: "relation", relation: pages.map((page) => ({ id: page })), has_more: false }
}

export function relatedSkill(
  f: Awaited<ReturnType<typeof sourceRefreshFixture>>,
  page: string,
  key: string,
  name: string,
  member?: string,
) {
  const row = structuredClone(f.main)
  row.id = page
  const props = property(row.properties)
  props.skill_id = rich("skill_id", key)
  props.main_file_id = rich("main_file_id", `main-${key}`)
  props.title = { id: "title", type: "title", title: [{ plain_text: name }] }
  props.members = relation("members", [])
  props.requires = relation("requires", [])
  props.source = rich("source", "")
  props.origin = relation("origin", member === undefined ? [] : [id(82)])
  props.source_member = rich("source_member", member ?? "")
  f.relatedPages.push(row)
  return row
}
