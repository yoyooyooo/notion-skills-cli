import { canonicalGitUrl } from "./shared-git-origin.ts"
import { Effect, Schema } from "effect"
import { fail, listSchema, property, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { sharedRecordFromPage, sharedSkillTextProperty } from "./shared-content.ts"
import {
  currentSourceText,
  parseCurrentSourceRegistration,
  parseCurrentSourceConfiguration,
  parseCurrentSourceManagement,
  queryCurrentSourceManagementRow,
} from "./shared-current-source-management.ts"
import {
  legacySourceRegistration,
  sameLegacySourceRegistration,
  type LegacySourceRegistration,
} from "./shared-current-source-legacy-registration.ts"
import { validateCurrentSourceContributions } from "./shared-current-source-input.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"
import type { SharedLibrary } from "./shared-library-model.ts"

export const materializationChecked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail(
            "SOURCE_MATERIALIZATION_INVALID",
            "The registered Source or member metadata is invalid.",
          ),
  })
export function materializationRecord(library: SharedLibrary, raw: unknown) {
  return sharedRecordFromPage(
    raw,
    {
      alias: library.library_id,
      title: "",
      role: "content",
      database_id: library.skills.database_id,
      data_source_ids: [library.skills.data_source_id],
      shared_library: library,
    },
    library.skills.data_source_id,
  )
}
/** Complete, parent-bound metadata enumeration. POST query is read-only. */
export function queryMaterializationPages(
  library: SharedLibrary,
  table: "skills" | "sources" | "files",
  filter?: unknown,
) {
  return Effect.gen(function* () {
    const api = yield* Notion,
      descriptor = library[table]
    const rows: unknown[] = [],
      cursors = new Set<string>(),
      pages = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const raw = yield* api.request(
        `v1/data_sources/${descriptor.data_source_id}/query`,
        {
          page_size: 100,
          ...(filter === undefined ? {} : { filter }),
          ...(cursor === undefined ? {} : { start_cursor: cursor }),
        },
        { method: "POST" },
      )
      const list = yield* materializationChecked(() => {
        const outer = property(raw)
        if (
          outer.object !== "list" ||
          (outer.request_status !== undefined && property(outer.request_status).type !== "complete")
        )
          throw fail(
            "SOURCE_MATERIALIZATION_INCOMPLETE",
            "Member metadata enumeration is incomplete.",
          )
        const list = Schema.decodeUnknownSync(listSchema(Schema.Unknown))(raw)
        if (
          list.has_more
            ? !list.next_cursor || cursors.has(list.next_cursor)
            : list.next_cursor !== null
        )
          throw fail(
            "SOURCE_MATERIALIZATION_INCOMPLETE",
            "Member metadata pagination did not finish.",
          )
        for (const raw of list.results) {
          const row = property(raw),
            parent = property(row.parent),
            id = typeof row.id === "string" ? pageId(row.id) : undefined
          if (
            !id ||
            row.object !== "page" ||
            row.archived === true ||
            row.in_trash === true ||
            parent.type !== "data_source_id" ||
            pageId(String(parent.data_source_id)) !== descriptor.data_source_id ||
            pages.has(id)
          )
            throw fail(
              "SOURCE_MATERIALIZATION_INVALID",
              "Member metadata returned a foreign or repeated page.",
            )
          pages.add(id)
        }
        return list
      })
      rows.push(...list.results)
      if (!list.has_more) return rows
      cursor = list.next_cursor!
      cursors.add(cursor)
    }
  })
}
export function parseMaterializationRegistration(
  library: SharedLibrary,
  raw: unknown,
  expectedLegacy?: { registration: LegacySourceRegistration; operation_id: string },
) {
  const legacy = legacySourceRegistration(library, raw, expectedLegacy?.operation_id)
  if (
    expectedLegacy !== undefined &&
    legacy !== undefined &&
    !sameLegacySourceRegistration(legacy, expectedLegacy.registration)
  )
    throw fail("SOURCE_LEGACY_REGISTRATION_CHANGED", "The frozen legacy Source evidence changed.")
  const registration =
    legacy !== undefined && currentSourceText(library, raw, "Operation") === ""
      ? {
          ...parseCurrentSourceConfiguration(library, raw),
          state: { state: "uninitialized" as const },
        }
      : parseCurrentSourceRegistration(library, raw)
  const content = currentSourceText(library, raw, "Content"),
    contributions = currentSourceText(library, raw, "Contributions"),
    revision = currentSourceText(library, raw, "Last Revision")
  if (!content && revision && legacy === undefined)
    throw fail(
      "SOURCE_MATERIALIZATION_INVALID",
      "An uninitialized Source cannot claim a current revision.",
    )
  const current = content ? parseCurrentSourceManagement(library, raw) : undefined
  return {
    ...registration,
    raw,
    current,
    legacy_registration: legacy,
    contributions:
      current?.declaration.contributions ??
      validateCurrentSourceContributions(contributions ? JSON.parse(contributions) : []),
  }
}
export type MaterializationRegistration = ReturnType<typeof parseMaterializationRegistration>
export function readMaterializationRegistration(
  library: SharedLibrary,
  sourceId: string,
  expectedLegacy?: { registration: LegacySourceRegistration; operation_id: string },
) {
  return Effect.gen(function* () {
    const raw = yield* queryCurrentSourceManagementRow(library, sourceId)
    if (raw === undefined)
      return yield* Effect.fail(
        fail("CURRENT_SOURCE_MISSING", "Materialization requires an existing registered Source.", {
          source_id: sourceId,
        }),
      )
    return yield* materializationChecked(() =>
      parseMaterializationRegistration(library, raw, expectedLegacy),
    )
  })
}
export function sourceRegistrationDigest(registration: MaterializationRegistration) {
  // Contributions and current plan may grow under the writer. Registration is
  // the exact physical owner plus its authored configuration, not that mutable set.
  const definition =
    registration.definition.adapter.type === "git"
      ? {
          ...registration.definition,
          adapter: {
            ...registration.definition.adapter,
            url: canonicalGitUrl(registration.definition.adapter.url),
          },
        }
      : registration.definition
  return sha256(canonicalSharedJson({ page_id: registration.page_id, definition }))
}
/** Legacy identity metadata only; old bodies, Publication and ZIP are not inputs. */
export function legacySourceMember(raw: unknown): string | undefined {
  const values = Object.entries(property(property(raw).properties)).flatMap(([name, value]) =>
    name === "Source Member" ? [property(value)] : [],
  )
  if (values.length === 0) return undefined
  const value = values[0]!
  if (
    values.length !== 1 ||
    value.type !== "rich_text" ||
    !Array.isArray(value.rich_text) ||
    value.has_more === true
  )
    throw fail("SOURCE_MEMBER_IDENTITY_AMBIGUOUS", "The legacy member identity is incomplete.")
  return text(value.rich_text) || undefined
}
export function materializationSkillId(library: SharedLibrary, raw: unknown) {
  return sharedSkillTextProperty(raw, library, "Skill ID")
}
