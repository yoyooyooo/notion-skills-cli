import { Crypto, Effect, FileSystem, Path } from "effect"
import { HttpClient } from "effect/http"
import { fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { LIBRARY_MARKER } from "../src/shared-library-model.ts"
import { Store } from "../src/store.ts"
import {
  currentId as id,
  currentLibrary,
  currentRich as rich,
  currentSnapshotFixture,
  currentSkillPage as skillPage,
} from "./shared-current-fixture.ts"

export const graphLibrary = {
  ...currentLibrary,
  skills: {
    ...currentLibrary.skills,
    property_ids: {
      ...currentLibrary.skills.property_ids,
      "Skill ID": "skill_id",
      "Main File ID": "main_file_id",
    },
  },
  files: {
    ...currentLibrary.files,
    property_ids: { ...currentLibrary.files.property_ids, "File ID": "file_id" },
  },
}
const library = graphLibrary

export function nativeGraphFixture(
  options: { readonly width?: number; readonly filesPerSkill?: number } = {},
) {
  const f = currentSnapshotFixture({ fileCount: 0 })
  const names =
    options.width === undefined
      ? ["a", "b", "c", "d", "optional"]
      : ["a", ...Array.from({ length: options.width }, (_, index) => `leaf-${index}`)]
  const pageIds = [
    skillPage,
    ...Array.from({ length: names.length - 1 }, (_, index) => id(900 + index)),
  ]
  const dependencies =
    options.width === undefined
      ? [[1, 2], [3], [3], [], []]
      : names.map((_, index) => (index === 0 ? names.slice(1).map((_, offset) => offset + 1) : []))
  const descriptor = {
    ...library,
    skills: {
      ...library.skills,
      property_ids: { ...library.skills.property_ids, Members: "members", Requires: "requires" },
    },
  }
  const pages = names.map((name, index) => {
    const fields = {
      title: {
        id: "title",
        type: "title",
        title: [{ plain_text: name, type: "text", text: { content: name } }],
      },
      description: rich("description", `Current instruction ${name}.`),
      kind: { id: "kind", type: "select", select: { name: "skill" } },
      tags: { id: "tags", type: "multi_select", multi_select: [] },
      enabled: { id: "enabled", type: "checkbox", checkbox: true },
      default: { id: "default", type: "checkbox", checkbox: false },
      skill_id: rich("skill_id", name),
      main_file_id: rich("main_file_id", `main-${name}`),
      content: rich("content", JSON.stringify({ kind: "native", mode: "100644", frontmatter: "" })),
      state: { id: "state", type: "select", select: { name: "ready" } },
      operation: rich("operation", ""),
      origin: { id: "origin", type: "relation", relation: [], has_more: false },
      requires: {
        id: "requires",
        type: "relation",
        relation: dependencies[index]!.slice(0, 25).map((child) => ({ id: pageIds[child]! })),
        has_more: dependencies[index]!.length > 25,
      },
      members: {
        id: "members",
        type: "relation",
        relation: options.width === undefined && index === 0 ? [{ id: pageIds[4] }] : [],
        has_more: false,
      },
    }
    const page = { ...structuredClone(f.main), id: pageIds[index]!, properties: fields }
    f.bodies.set(pageIds[index]!, `# ${name} instruction\n`)
    return page
  })
  const files = names.flatMap((name, owner) =>
    Array.from({ length: options.filesPerSkill ?? 0 }, (_, index) => {
      const file = {
        object: "page",
        id: id(2000 + owner * (options.filesPerSkill ?? 0) + index),
        last_edited_time: f.main.last_edited_time,
        parent: {
          type: "data_source_id",
          data_source_id: library.files.data_source_id,
          database_id: library.files.database_id,
        },
        properties: {
          title: { id: "title", type: "title", title: [{ plain_text: `${name} ${index}` }] },
          file_id: rich("file_id", `resource-${name}-${index}`),
          path: rich("path", `references/${index}.md`),
          content: rich(
            "content",
            JSON.stringify({ kind: "native", mode: "100644", frontmatter: "" }),
          ),
          skill: {
            id: "skill",
            type: "relation",
            has_more: false,
            relation: [{ id: pageIds[owner]! }],
          },
          origin: {
            id: "origin",
            type: "rollup",
            rollup: { type: "array", array: [], function: "show_unique" },
          },
        },
      }
      f.bodies.set(file.id, `Resource ${name} ${index}\n`)
      return file
    }),
  )
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Notion | Store | Crypto.Crypto | HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
    >,
  ) =>
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* effect.pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, requestOptions) => {
              const endpoint = path.split("?", 1)[0]
              if (endpoint === `v1/data_sources/${library.files.data_source_id}/query`) {
                f.calls.push({ path, body, method: requestOptions?.method ?? "POST" })
                const filter = property(property(body).filter)
                const parts = Array.isArray(filter.or) ? filter.or : [filter]
                const owners = new Set(
                  parts.map((part) => property(property(part).relation).contains),
                )
                const values = files.filter((file) =>
                  owners.has(file.properties.skill.relation[0]!.id),
                )
                const cursor = property(body).start_cursor
                const offset =
                  typeof cursor === "string" ? Number(cursor.replace("offset-", "")) : 0
                const end = Math.min(values.length, offset + 100)
                const selectedProperties = new Set(
                  new URL(path, "https://fixture.invalid/").searchParams.getAll(
                    "filter_properties",
                  ),
                )
                const results = values.slice(offset, end).map((row) => ({
                  ...structuredClone(row),
                  properties: Object.fromEntries(
                    Object.entries(row.properties).filter(
                      ([key]) => selectedProperties.size === 0 || selectedProperties.has(key),
                    ),
                  ),
                }))
                return Effect.succeed({
                  object: "list",
                  results,
                  has_more: end < values.length,
                  next_cursor: end < values.length ? `offset-${end}` : null,
                })
              }
              if (endpoint === `v1/databases/${library.skills.database_id}`)
                return api.request(path, body, requestOptions).pipe(
                  Effect.map((raw) => ({
                    ...property(raw),
                    description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(descriptor) }],
                  })),
                )
              const page = pages.find((page) => endpoint === `v1/pages/${page.id}`)
              const relationPage = pageIds.findIndex(
                (id) => endpoint === `v1/pages/${id}/properties/requires`,
              )
              if (relationPage >= 0) {
                f.calls.push({ path, body, method: "GET" })
                const cursor = new URL(path, "https://fixture.invalid/").searchParams.get(
                  "start_cursor",
                )
                const offset = cursor === null ? 0 : Number(cursor.replace("offset-", ""))
                const all = dependencies[relationPage]!.map((index) => ({
                  object: "property_item",
                  id: "requires",
                  type: "relation",
                  relation: { id: pageIds[index] },
                }))
                const end = Math.min(all.length, offset + 100)
                return Effect.succeed({
                  object: "list",
                  type: "property_item",
                  results: all.slice(offset, end),
                  has_more: end < all.length,
                  next_cursor: end < all.length ? `offset-${end}` : null,
                  property_item: {
                    id: "requires",
                    type: "relation",
                    next_url: end < all.length ? "https://fixture.invalid/next" : null,
                  },
                })
              }
              if (
                page !== undefined ||
                endpoint === `v1/data_sources/${library.skills.data_source_id}/query`
              ) {
                f.calls.push({
                  path,
                  body,
                  method: requestOptions?.method ?? (body === undefined ? "GET" : "POST"),
                })
                if (page !== undefined) return Effect.succeed(structuredClone(page))
                const selectedProperties = new Set(
                  new URL(path, "https://fixture.invalid/").searchParams.getAll(
                    "filter_properties",
                  ),
                )
                const cursor = property(body).start_cursor
                const offset =
                  typeof cursor === "string" ? Number(cursor.replace("offset-", "")) : 0
                const size = Math.min(100, Number(property(body).page_size ?? 100))
                const filter = property(body).filter
                const parts = Array.isArray(property(filter).or)
                  ? (property(filter).or as unknown[])
                  : [filter]
                const identities =
                  filter === undefined
                    ? undefined
                    : new Set(
                        parts.map((raw) => {
                          const part = property(raw)
                          const identity = property(part.rich_text).equals
                          if (
                            part.property !== descriptor.skills.property_ids["Skill ID"] ||
                            typeof identity !== "string"
                          )
                            throw fail(
                              "UNEXPECTED_REQUEST",
                              "The fixture requires exact registered Skill ID filters.",
                            )
                          return identity
                        }),
                      )
                const values =
                  identities === undefined
                    ? pages
                    : pages.filter((page) =>
                        identities.has(
                          String(
                            property(
                              (property(page.properties).skill_id as { rich_text: unknown[] })
                                .rich_text[0],
                            ).plain_text,
                          ),
                        ),
                      )
                const end = Math.min(values.length, offset + size)
                const results = values.slice(offset, end).map((row) => ({
                  ...structuredClone(row),
                  properties: Object.fromEntries(
                    Object.entries(property(row.properties)).filter(
                      ([key]) => selectedProperties.size === 0 || selectedProperties.has(key),
                    ),
                  ),
                }))
                return Effect.succeed({
                  object: "list",
                  results,
                  has_more: end < values.length,
                  next_cursor: end < values.length ? `offset-${end}` : null,
                })
              }
              return api.request(path, body, requestOptions)
            },
          }),
        )
      }),
    )
  return {
    ...f,
    files,
    run,
    pages,
    pageIds,
    descriptor,
    readBodyCount: () => f.bodyCalls().length,
    writeCount: () => f.semanticWrites().length,
  }
}
