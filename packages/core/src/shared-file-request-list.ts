import { Effect } from "effect"
import { ContentKindSchema, decode, entrypointFor, fail, property, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { normalizePath, pageId } from "./ref.ts"
import { fileIntentChecked } from "./shared-file-intent.ts"
import {
  fileRequestProperty,
  fileRequestResultProperty,
  fileRequestReceiptProperty,
} from "./shared-file-request-schema.ts"
import type { SharedLibrary, TableBinding } from "./shared-library-model.ts"
import { sourceField } from "./shared-source-definitions.ts"

export interface SharedFileRequestTarget {
  readonly skill_page_id: string
  readonly skill_id: string
  readonly file_id: string
  readonly page_id: string
  readonly path: string
  readonly kind: "main" | "supporting"
}

function field(row: unknown, table: TableBinding, name: string, type: string) {
  const id = table.property_ids[name]
  if (!id)
    throw fail(
      "SHARED_FILE_REQUEST_SCHEMA",
      "A request inventory requires its registered property identity.",
      { property: name },
    )
  const result = sourceField(row, id)
  if (result.type !== type)
    throw fail("SHARED_FILE_REQUEST_SCHEMA", "A request inventory property changed type.", {
      property: name,
    })
  return result
}
function rich(row: unknown, table: TableBinding, name: string) {
  const value = field(row, table, name, "rich_text")
  if (!Array.isArray(value.rich_text) || value.has_more === true || value.rich_text.length >= 25)
    throw fail("SHARED_FILE_REQUEST_INCOMPLETE", "A stable request identity is truncated.", {
      property: name,
    })
  return text(value.rich_text)
}
function identity(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(value))
    throw fail(
      "SHARED_FILE_REQUEST_SCOPE",
      "Request targets require exact stable Skill and File identities.",
    )
  return value
}
function livePage(raw: unknown, table: TableBinding, exact?: string) {
  const row = property(raw)
  if (
    row.object !== "page" ||
    typeof row.id !== "string" ||
    pageId(row.id) !== row.id ||
    (exact !== undefined && row.id !== exact) ||
    row.archived === true ||
    row.in_trash === true ||
    property(row.parent).type !== "data_source_id" ||
    property(row.parent).data_source_id !== table.data_source_id
  )
    throw fail(
      "SHARED_FILE_REQUEST_SCOPE",
      "The request target is not an active page in the exact registered table.",
    )
  return row.id
}

/** Metadata-only inventory; query filtering reduces work but never substitutes for scope validation. */
export function listSharedFileRequests(library: SharedLibrary, skillPageIds: readonly string[]) {
  return Effect.gen(function* () {
    const notConfigured = (["skills", "files"] as const).filter(
      (role) =>
        !library[role].property_ids[fileRequestProperty] ||
        !library[role].property_ids[fileRequestResultProperty] ||
        !library[role].property_ids[fileRequestReceiptProperty],
    )
    yield* fileIntentChecked(() => {
      if (
        new Set(skillPageIds).size !== skillPageIds.length ||
        skillPageIds.some((id) => pageId(id) !== id)
      )
        throw fail("INVALID_ARGUMENT", "Request inventory needs unique canonical Skill page IDs.")
    })
    if (notConfigured.length === 2)
      return {
        status: "not_configured" as const,
        requests: [] as readonly SharedFileRequestTarget[],
        not_configured: notConfigured,
      }
    const api = yield* Notion,
      requests: SharedFileRequestTarget[] = []
    const skillIdentities = new Set<string>(),
      seen = new Set<string>()
    for (const skillPage of skillPageIds) {
      const raw = yield* api.request(`v1/pages/${skillPage}`)
      const skill = yield* fileIntentChecked(() => {
        livePage(raw, library.skills, skillPage)
        const skillId = identity(rich(raw, library.skills, "Skill ID"))
        if (skillIdentities.has(skillId))
          throw fail("SHARED_FILE_REQUEST_SCOPE", "Several native pages claim the same Skill ID.")
        skillIdentities.add(skillId)
        const main = identity(rich(raw, library.skills, "Main File ID"))
        const kind = decode(
          ContentKindSchema,
          property(field(raw, library.skills, "Kind", "select").select).name,
        )
        const enabled = field(raw, library.skills, "Enabled", "checkbox").checkbox
        if (typeof enabled !== "boolean")
          throw fail("SHARED_FILE_REQUEST_SCHEMA", "Skill Enabled is not a complete checkbox.")
        const request = notConfigured.includes("skills")
          ? undefined
          : property(field(raw, library.skills, fileRequestProperty, "select").select).name
        return {
          skillId,
          main,
          path: entrypointFor(kind),
          enabled,
          requested: request === "restore-follow",
        }
      })
      if (!skill.enabled) continue
      if (skill.requested) {
        requests.push({
          skill_page_id: skillPage,
          skill_id: skill.skillId,
          file_id: skill.main,
          page_id: skillPage,
          path: skill.path,
          kind: "main",
        })
        seen.add(`${skillPage}:${skill.main}`)
      }
      if (notConfigured.includes("files")) continue
      let cursor: string | undefined
      const cursors = new Set<string>()
      do {
        const result = property(
          yield* api.request(`v1/data_sources/${library.files.data_source_id}/query`, {
            page_size: 100,
            ...(cursor === undefined ? {} : { start_cursor: cursor }),
            filter: {
              and: [
                { property: library.files.property_ids.Skill, relation: { contains: skillPage } },
                {
                  property: library.files.property_ids[fileRequestProperty],
                  select: { equals: "restore-follow" },
                },
              ],
            },
          }),
        )
        const next = yield* fileIntentChecked(() => {
          if (
            result.object !== "list" ||
            !Array.isArray(result.results) ||
            typeof result.has_more !== "boolean"
          )
            throw fail(
              "SHARED_FILE_REQUEST_INCOMPLETE",
              "The native request query is not a complete page.",
            )
          for (const raw of result.results) {
            const id = livePage(raw, library.files)
            const relation = field(raw, library.files, "Skill", "relation")
            if (
              relation.has_more === true ||
              !Array.isArray(relation.relation) ||
              relation.relation.length !== 1 ||
              property(relation.relation[0]).id !== skillPage
            )
              throw fail(
                "SHARED_FILE_REQUEST_SCOPE",
                "A supporting request must have exactly the selected Skill relation.",
              )
            const fileId = identity(rich(raw, library.files, "File ID")),
              path = rich(raw, library.files, "Path")
            if (
              fileId === skill.main ||
              path === skill.path ||
              !path ||
              path === "." ||
              normalizePath(path) !== path ||
              /[\u0000-\u001f\u007f-\u009f]/u.test(path)
            )
              throw fail(
                "SHARED_FILE_REQUEST_SCOPE",
                "A supporting request collides with the main file or has an invalid logical path.",
              )
            if (
              property(field(raw, library.files, fileRequestProperty, "select").select).name !==
              "restore-follow"
            )
              throw fail(
                "SHARED_FILE_REQUEST_SCOPE",
                "A filtered row does not contain the declared user request.",
              )
            const key = `${skillPage}:${fileId}`
            if (
              seen.has(key) ||
              requests.some(
                (target) =>
                  target.page_id === id ||
                  (target.skill_page_id === skillPage && target.path === path),
              )
            )
              throw fail(
                "SHARED_FILE_REQUEST_SCOPE",
                "The request inventory repeats a File ID, page or logical path.",
              )
            seen.add(key)
            requests.push({
              skill_page_id: skillPage,
              skill_id: skill.skillId,
              file_id: fileId,
              page_id: id,
              path,
              kind: "supporting",
            })
          }
          if (!result.has_more) {
            if (result.next_cursor !== null)
              throw fail(
                "SHARED_FILE_REQUEST_INCOMPLETE",
                "Request query has an invalid terminal cursor.",
              )
            return undefined
          }
          if (
            typeof result.next_cursor !== "string" ||
            !result.next_cursor ||
            cursors.has(result.next_cursor)
          )
            throw fail(
              "SHARED_FILE_REQUEST_INCOMPLETE",
              "Request query cursor is missing or repeated.",
            )
          cursors.add(result.next_cursor)
          return result.next_cursor
        })
        cursor = next
      } while (cursor !== undefined)
    }
    return {
      status: notConfigured.length > 0 ? ("not_configured" as const) : ("complete" as const),
      requests,
      not_configured: notConfigured,
    }
  }).pipe(withReadOnlyNotion)
}
