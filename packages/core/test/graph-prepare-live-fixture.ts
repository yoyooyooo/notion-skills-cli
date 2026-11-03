import { Crypto, Effect, FileSystem, Path } from "effect"
import { HttpClient } from "effect/http"
import { property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { LIBRARY_MARKER } from "../src/shared-library-model.ts"
import { Store } from "../src/store.ts"
import { id, library, rich, sharedSnapshotFixture, skillPage } from "./shared-snapshot-fixture.ts"

export function nativeGraphFixture(
  options: { readonly width?: number; readonly filesPerSkill?: number } = {},
) {
  const f = sharedSnapshotFixture({ fileCount: 1 })
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
    const page = structuredClone(f.main)
    page.id = pageIds[index]!
    const fields = property(page.properties)
    fields.title = {
      id: "title",
      type: "title",
      title: [{ plain_text: name, type: "text", text: { content: name } }],
    }
    fields.skill_id = rich("skill_id", name)
    fields.main_file_id = rich("main_file_id", `main-${name}`)
    fields.requires = {
      id: "requires",
      type: "relation",
      relation: dependencies[index]!.slice(0, 25).map((child) => ({ id: pageIds[child]! })),
      has_more: dependencies[index]!.length > 25,
    }
    fields.members = {
      id: "members",
      type: "relation",
      relation: options.width === undefined && index === 0 ? [{ id: pageIds[4] }] : [],
      has_more: false,
    }
    f.bodies.set(pageIds[index]!, `# ${name} instruction\n`)
    return page
  })
  const templateFile = sharedSnapshotFixture({ fileCount: 2 }).files[0]!
  for (let owner = 0; owner < names.length; owner++) {
    for (let index = 0; index < (options.filesPerSkill ?? 0); index++) {
      const file = structuredClone(templateFile)
      file.id = id(2000 + owner * (options.filesPerSkill ?? 0) + index)
      file.properties.file_id = rich("file_id", `resource-${names[owner]}-${index}`)
      file.properties.path = rich("path", `references/${index}.md`)
      file.properties.skill.relation = [{ id: pageIds[owner]! }]
      f.files.push(file)
      f.bodies.set(file.id, `Resource ${names[owner]} ${index}\n`)
    }
  }
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
                const values = f.files.filter((file) =>
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
                const end = Math.min(pages.length, offset + size)
                const results = pages.slice(offset, end).map((row) => ({
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
                  has_more: end < pages.length,
                  next_cursor: end < pages.length ? `offset-${end}` : null,
                })
              }
              return api.request(path, body, requestOptions)
            },
          }),
        )
      }),
    )
  return { ...f, run, pages, pageIds, descriptor }
}
