import { Effect, Schema } from "effect"
import { fail, property, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { LIBRARY_MARKER, SharedLibrarySchema, type SharedLibrary } from "./shared-library-model.ts"
import {
  inspectTable,
  libraryFromDatabase,
  loadSharedLibrary,
  initializeSharedLibrary,
} from "./shared-library.ts"
import { sourceDefinitionLayout } from "./shared-sources-model.ts"
import { guardedSourceMutation, sourceChecked, sourceRich } from "./shared-source-definitions.ts"
import { canonicalSharedJson } from "./shared-records.ts"

/** Attach only an explicitly supplied fourth-table descriptor. Existing library
 * identities and property bindings are frozen; this is not schema discovery by title. */
export function attachSourceLibrary(entry: string, input: unknown, dryRun = false) {
  return Effect.gen(function* () {
    const current = yield* loadSharedLibrary(entry)
    const candidate = yield* sourceChecked(() =>
      Schema.decodeUnknownSync(SharedLibrarySchema)(structuredClone(input), {
        onExcessProperty: "error",
      }),
    )
    yield* sourceChecked(() => {
      if (!candidate.sources)
        throw fail(
          "SOURCES_NOT_ATTACHED",
          "Supply the Sources table and exact relation identities.",
        )
      for (const key of ["version", "library_id", "operation_id", "parent_page_id"] as const)
        if (current[key] !== candidate[key])
          throw fail("SOURCE_LIBRARY_CONFLICT", "The existing library identity cannot be replaced.")
      for (const role of ["skills", "files", "records"] as const) {
        const before = current[role],
          after = candidate[role]
        if (
          before.database_id !== after.database_id ||
          before.data_source_id !== after.data_source_id
        )
          throw fail("SOURCE_LIBRARY_CONFLICT", "The existing tables cannot be replaced.")
        for (const [key, value] of Object.entries(before.property_ids))
          if (after.property_ids[key] !== value)
            throw fail(
              "SOURCE_LIBRARY_CONFLICT",
              "An existing property binding cannot be replaced.",
              { role, property: key },
            )
      }
      if (
        current.sources &&
        canonicalSharedJson(current.sources) !== canonicalSharedJson(candidate.sources)
      )
        throw fail(
          "SOURCE_LIBRARY_CONFLICT",
          "An attached Sources database cannot be silently replaced.",
        )
      libraryFromDatabase({
        id: current.skills.database_id,
        description: sourceRich(LIBRARY_MARKER + JSON.stringify(candidate)),
      })
    })
    yield* inspectTable(
      candidate.sources!.database_id,
      sourceDefinitionLayout(candidate.skills.data_source_id, candidate.records.data_source_id),
      candidate.parent_page_id,
      candidate.sources,
    )
    for (const role of ["skills", "records"] as const)
      yield* inspectTable(
        candidate[role].database_id,
        {
          Origin: {
            relation: { data_source_id: candidate.sources!.data_source_id, single_property: {} },
          },
          ...(role === "skills" ? { "Source Member": { rich_text: {} } } : {}),
        },
        candidate.parent_page_id,
        candidate[role],
      )
    if (canonicalSharedJson(current) === canonicalSharedJson(candidate))
      return { library: candidate, status: "unchanged", writes: 0 }
    const result = yield* guardedSourceMutation(
      current,
      {
        identity: `${current.library_id}:sources-descriptor`,
        path: `v1/databases/${current.skills.database_id}`,
        method: "PATCH",
        body: { description: sourceRich(LIBRARY_MARKER + JSON.stringify(candidate)) },
        dryRun,
      },
      Effect.gen(function* () {
        const observed = yield* loadSharedLibrary(entry)
        return canonicalSharedJson(observed) === canonicalSharedJson(candidate)
          ? observed
          : undefined
      }),
    )
    return { ...result, library: candidate }
  })
}

export function initializeSourceLibrary(library: SharedLibrary) {
  return Effect.gen(function* () {
    if (library.sources) {
      yield* initializeSharedLibrary({ entry: library.skills.database_id })
      return { library, reused: true }
    }
    const api = yield* Notion,
      marker = `ntn-skills-sources:v1 ${JSON.stringify({ version: 1, library_id: library.library_id, parent_page_id: library.parent_page_id })}`
    const discover = Effect.gen(function* () {
      const found: unknown[] = [],
        seen = new Set<string>()
      let cursor: string | undefined
      do {
        const params = new URLSearchParams({
          page_size: "100",
          ...(cursor ? { start_cursor: cursor } : {}),
        })
        const response = property(
          yield* api.request(`v1/blocks/${library.parent_page_id}/children?${params}`),
        )
        if (
          response.object !== "list" ||
          !Array.isArray(response.results) ||
          typeof response.has_more !== "boolean"
        )
          return yield* Effect.fail(
            fail(
              "SOURCES_INCOMPLETE",
              "Source initialization requires complete parent enumeration.",
            ),
          )
        for (const child of response.results) {
          const block = property(child)
          if (
            block.type !== "child_database" ||
            [
              library.skills.database_id,
              library.files.database_id,
              library.records.database_id,
            ].includes(String(block.id))
          )
            continue
          const db = yield* api.request(`v1/databases/${block.id}`)
          if (text(property(db).description) === marker) found.push(db)
        }
        if (response.has_more) {
          if (
            typeof response.next_cursor !== "string" ||
            !response.next_cursor ||
            seen.has(response.next_cursor)
          )
            return yield* Effect.fail(fail("SOURCES_INCOMPLETE", "Invalid parent cursor."))
          cursor = response.next_cursor
          seen.add(cursor)
        } else {
          if (response.next_cursor !== null)
            return yield* Effect.fail(fail("SOURCES_INCOMPLETE", "Unexpected terminal cursor."))
          cursor = undefined
        }
      } while (cursor)
      if (found.length > 1)
        return yield* Effect.fail(
          fail("SOURCE_LIBRARY_CONFLICT", "Several tables claim this exact Sources identity."),
        )
      return found[0]
    })
    const before = property(yield* api.request(`v1/data_sources/${library.skills.data_source_id}`))
    const origin = property(property(before.properties).Origin)
    if (origin.id && property(origin.relation).data_source_id === library.records.data_source_id) {
      if (property(before.properties)["Source Archive"])
        return yield* Effect.fail(
          fail("SOURCE_LIBRARY_CONFLICT", "Preserved archive relation name is already occupied."),
        )
      yield* guardedSourceMutation(
        library,
        {
          identity: "preserve-origin-archive",
          path: `v1/data_sources/${library.skills.data_source_id}`,
          method: "PATCH",
          body: { properties: { [String(origin.id)]: { name: "Source Archive" } } },
        },
        Effect.gen(function* () {
          const row = property(
            yield* api.request(`v1/data_sources/${library.skills.data_source_id}`),
          )
          return Object.values(property(row.properties)).some(
            (v) => property(v).id === origin.id && property(v).name === "Source Archive",
          )
            ? row
            : undefined
        }),
      )
    }
    let database = yield* discover
    if (database === undefined) {
      const created = yield* guardedSourceMutation(
        library,
        {
          identity: "initialize-sources-table",
          path: "v1/databases",
          method: "POST",
          body: {
            parent: { type: "page_id", page_id: library.parent_page_id },
            title: sourceRich("Sources"),
            description: sourceRich(marker),
            is_inline: false,
            initial_data_source: {
              properties: sourceDefinitionLayout(
                library.skills.data_source_id,
                library.records.data_source_id,
              ),
            },
          },
        },
        discover,
      )
      database = "result" in created ? created.result : undefined
    }
    const db = property(database)
    if (
      typeof db.id !== "string" ||
      pageId(db.id) !== db.id ||
      db.is_inline !== false ||
      property(db.parent).page_id !== library.parent_page_id
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_LIBRARY_CONFLICT",
          "Sources table readback does not match its declared parent and mode.",
        ),
      )
    const sourceBinding = yield* inspectTable(
      db.id,
      sourceDefinitionLayout(library.skills.data_source_id, library.records.data_source_id),
      library.parent_page_id,
    )
    const schema = property(yield* api.request(`v1/data_sources/${sourceBinding.data_source_id}`))
    const reverse = (name: string) =>
      property(property(property(property(schema.properties)[name]).relation).dual_property)
        .synced_property_id
    const skillOrigin = yield* sourceChecked(() => {
      const id = reverse("Skills")
      if (typeof id !== "string" || !id)
        throw fail("SOURCE_LIBRARY_CONFLICT", "Sources Skills reverse relation is missing.")
      return id
    })
    const recordOrigin = yield* sourceChecked(() => {
      const id = reverse("Records")
      if (typeof id !== "string" || !id)
        throw fail("SOURCE_LIBRARY_CONFLICT", "Sources Records reverse relation is missing.")
      return id
    })
    let skillSchema = property(
      yield* api.request(`v1/data_sources/${library.skills.data_source_id}`),
    )
    const existingMember = property(property(skillSchema.properties)["Source Member"])
    if (existingMember.id && existingMember.type !== "rich_text")
      return yield* Effect.fail(
        fail("SOURCE_LIBRARY_CONFLICT", "Source Member is occupied by another property type."),
      )
    if (!existingMember.id) {
      const result = yield* guardedSourceMutation(
        library,
        {
          identity: "initialize-source-member",
          path: `v1/data_sources/${library.skills.data_source_id}`,
          method: "PATCH",
          body: { properties: { "Source Member": { rich_text: {} } } },
        },
        Effect.gen(function* () {
          const row = property(
            yield* api.request(`v1/data_sources/${library.skills.data_source_id}`),
          )
          return property(property(row.properties)["Source Member"]).type === "rich_text"
            ? row
            : undefined
        }),
      )
      skillSchema = property("result" in result ? result.result : undefined)
    }
    const memberId = property(property(skillSchema.properties)["Source Member"]).id
    if (typeof memberId !== "string")
      return yield* Effect.fail(
        fail("SOURCE_LIBRARY_CONFLICT", "Source Member identity is unavailable."),
      )
    const candidate: SharedLibrary = {
      ...library,
      sources: sourceBinding,
      skills: {
        ...library.skills,
        property_ids: {
          ...library.skills.property_ids,
          Origin: skillOrigin,
          "Source Member": memberId,
        },
      },
      records: {
        ...library.records,
        property_ids: { ...library.records.property_ids, Origin: recordOrigin },
      },
    }
    // A source is derived for Files rather than maintained in a second mutable relation.
    const fs = property(yield* api.request(`v1/data_sources/${library.files.data_source_id}`))
    const fileOrigin = property(property(fs.properties).Origin)
    if (!fileOrigin.id) {
      yield* guardedSourceMutation(
        library,
        {
          identity: "initialize-file-origin-rollup",
          path: `v1/data_sources/${library.files.data_source_id}`,
          method: "PATCH",
          body: {
            properties: {
              Origin: {
                rollup: {
                  relation_property_id: library.files.property_ids.Skill,
                  rollup_property_id: skillOrigin,
                  function: "show_unique",
                },
              },
            },
          },
        },
        Effect.gen(function* () {
          const row = property(
              yield* api.request(`v1/data_sources/${library.files.data_source_id}`),
            ),
            value = property(property(row.properties).Origin)
          return value.type === "rollup" &&
            property(value.rollup).rollup_property_id === skillOrigin
            ? row
            : undefined
        }),
      )
    } else if (
      fileOrigin.type !== "rollup" ||
      property(fileOrigin.rollup).rollup_property_id !== skillOrigin
    )
      return yield* Effect.fail(
        fail("SOURCE_LIBRARY_CONFLICT", "Files Origin is not the selected Skill-derived source."),
      )
    const attached = yield* attachSourceLibrary(library.skills.database_id, candidate)
    return { library: attached.library, reused: false }
  })
}
