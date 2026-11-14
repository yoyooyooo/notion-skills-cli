import { Effect, Schema } from "effect"
import { authScope, databaseId } from "./catalog.ts"
import { validateSnapshotManifest } from "./cache.ts"
import { decode, fail, listSchema, property, SkillsError, SnapshotSchema } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId, parseTarget } from "./ref.ts"
import { configuredSources, Store } from "./store.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import {
  sharedSkillId,
  sharedSkillTextProperty,
  validateSharedRecordIdentity,
} from "./shared-content.ts"

const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("MAINTENANCE_TARGET_INVALID", "The exact management target could not be verified."),
  })

/** Resolve an exact owner without materializing a Skill or granting write authority. */
export function resolveSharedMaintenanceTarget(input: string, entry?: string) {
  return Effect.gen(function* () {
    const target = yield* checked(() => parseTarget(input))
    if (target.path !== undefined && !["SKILL.md", "ROUTER.md", "PROMPT.md"].includes(target.path))
      return yield* Effect.fail(
        fail(
          "EXACT_TARGET_REQUIRED",
          "Select the Skill's main reference; supporting-file actions must explicitly name their path or File ID.",
        ),
      )
    const requestedEntry = entry === undefined ? undefined : yield* databaseId(entry)
    if (target.snapshot !== undefined) {
      const snapshot = yield* (yield* Store).readJson(
        `snapshots/${target.snapshot}.json`,
        SnapshotSchema,
      )
      if (snapshot === undefined)
        return yield* Effect.fail(
          fail(
            "MAINTENANCE_PIN_UNAVAILABLE",
            "The exact pinned manifest is not available locally. Read this same fixed reference through the normal read-only consumer before retrying; current names are not a substitute.",
            {
              next: {
                argv: ["ntn-skills", "read", input, "--read-only", "--json"],
                read_only: true,
                reason:
                  "Resolve the original fixed manifest without granting current-write permission.",
              },
            },
          ),
        )
      yield* validateSnapshotManifest(snapshot)
      yield* checked(() => validateSharedRecordIdentity(snapshot.record))
      const locator = snapshot.record.locator
      if (
        locator.type !== "shared_skill" ||
        target.selector !== snapshot.record.id ||
        snapshot.scope !== (yield* authScope) ||
        (requestedEntry !== undefined && requestedEntry !== locator.database_id) ||
        (target.path !== undefined && target.path !== snapshot.entrypoint) ||
        (target.file_id !== undefined &&
          !snapshot.file_bindings?.some(
            (binding) => binding.path === snapshot.entrypoint && binding.file_id === target.file_id,
          ))
      )
        return yield* Effect.fail(
          fail(
            "MAINTENANCE_TARGET_SCOPE",
            "The fixed reference does not match this authenticated Skill and library.",
          ),
        )
      return {
        page_id: locator.page_id,
        entry: locator.database_id,
        library_id: locator.library_id,
        selected_from: "fixed_manifest" as const,
        pin: snapshot.snapshot_id,
      }
    }
    const api = yield* Notion
    let selectedPage = pageId(target.selector),
      selectedEntry = requestedEntry
    let expected: { library_id: string; skill_id: string } | undefined
    if (selectedPage === undefined) {
      const match = /^shared_skill:([^:]+):([^:]+)$/u.exec(target.selector)
      if (match === null)
        return yield* Effect.fail(
          fail(
            "EXACT_TARGET_REQUIRED",
            "Management requires an exact page, URL or shared Skill ref. Search results and display names do not prove unique identity.",
          ),
        )
      expected = yield* checked(() => ({
        library_id: decodeURIComponent(match[1]!),
        skill_id: decodeURIComponent(match[2]!),
      }))
      if (sharedSkillId(expected.library_id, expected.skill_id) !== target.selector)
        return yield* Effect.fail(
          fail("MAINTENANCE_TARGET_INVALID", "The shared Skill identity is not canonical."),
        )
      if (selectedEntry === undefined) {
        const candidates = [
          ...new Set(
            (yield* configuredSources)
              .filter((source) => source.shared_library?.library_id === expected!.library_id)
              .map((source) => source.database_id),
          ),
        ]
        if (candidates.length !== 1)
          return yield* Effect.fail(
            fail(
              "MAINTENANCE_ENTRY_REQUIRED",
              "Supply --entry for this exact shared library; no other library was searched.",
              { library_id: expected.library_id },
            ),
          )
        selectedEntry = candidates[0]!
      }
      const library = yield* loadSharedLibrary(selectedEntry)
      if (library.library_id !== expected.library_id)
        return yield* Effect.fail(
          fail("MAINTENANCE_TARGET_SCOPE", "The shared reference belongs to another library."),
        )
      const found = new Set<string>(),
        cursors = new Set<string>()
      let cursor: string | undefined
      do {
        const raw = yield* api.request(
          `v1/data_sources/${library.skills.data_source_id}/query`,
          {
            page_size: 100,
            filter: {
              property: library.skills.property_ids["Skill ID"],
              rich_text: { equals: expected.skill_id },
            },
            ...(cursor === undefined ? {} : { start_cursor: cursor }),
          },
          { method: "POST" },
        )
        const list = yield* checked(() => {
          if (
            property(raw).object !== "list" ||
            (property(raw).request_status !== undefined &&
              property(property(raw).request_status).type !== "complete")
          )
            throw fail("MAINTENANCE_TARGET_INCOMPLETE", "The exact identity query was incomplete.")
          const list = decode(listSchema(Schema.Unknown), raw)
          if (
            (list.has_more && (!list.next_cursor || cursors.has(list.next_cursor))) ||
            (!list.has_more && list.next_cursor !== null)
          )
            throw fail(
              "MAINTENANCE_TARGET_INCOMPLETE",
              "The exact identity query did not finish its pagination.",
            )
          return list
        })
        for (const row of list.results) {
          const id = property(row).id
          if (
            typeof id !== "string" ||
            pageId(id) !== id ||
            property(property(row).parent).data_source_id !== library.skills.data_source_id ||
            sharedSkillTextProperty(row, library, "Skill ID") !== expected.skill_id ||
            found.has(id)
          )
            return yield* Effect.fail(
              fail(
                "MAINTENANCE_TARGET_INCOMPLETE",
                "The exact identity query contains an unrelated or repeated row.",
              ),
            )
          found.add(id)
        }
        if (found.size > 1)
          return yield* Effect.fail(
            fail(
              "MAINTENANCE_TARGET_AMBIGUOUS",
              "Multiple pages carry the same shared identity; select and repair their ownership explicitly.",
              { pages: [...found] },
            ),
          )
        cursor = list.has_more ? (list.next_cursor ?? undefined) : undefined
        if (cursor) cursors.add(cursor)
      } while (cursor !== undefined)
      selectedPage = [...found][0]
      if (selectedPage === undefined)
        return yield* Effect.fail(
          fail(
            "MAINTENANCE_TARGET_UNAVAILABLE",
            "The exact shared identity was not observed. This does not prove deletion.",
          ),
        )
    }
    const raw = property(yield* api.request(`v1/pages/${selectedPage}`))
    if (
      raw.object !== "page" ||
      raw.id !== selectedPage ||
      raw.in_trash === true ||
      raw.archived === true ||
      raw.is_archived === true
    )
      return yield* Effect.fail(
        fail("MAINTENANCE_TARGET_UNAVAILABLE", "The exact selected page is unavailable."),
      )
    const parent = property(raw.parent)
    let observedEntry =
      typeof parent.database_id === "string" ? pageId(parent.database_id) : undefined
    if (
      parent.type !== "data_source_id" ||
      typeof parent.data_source_id !== "string" ||
      pageId(parent.data_source_id) !== parent.data_source_id
    )
      return yield* Effect.fail(
        fail(
          "MAINTENANCE_ENTRY_REQUIRED",
          "The page does not expose a registered database parent. Provide its exact --entry instead of guessing by title.",
        ),
      )
    if (observedEntry === undefined && selectedEntry === undefined) {
      const dataSource = property(yield* api.request(`v1/data_sources/${parent.data_source_id}`))
      const container = property(dataSource.parent)
      if (
        dataSource.object !== "data_source" ||
        dataSource.id !== parent.data_source_id ||
        container.type !== "database_id" ||
        typeof container.database_id !== "string" ||
        pageId(container.database_id) !== container.database_id
      )
        return yield* Effect.fail(
          fail(
            "MAINTENANCE_ENTRY_REQUIRED",
            "The exact selected data source did not identify a verifiable database parent.",
          ),
        )
      observedEntry = container.database_id
    }
    if (
      selectedEntry !== undefined &&
      observedEntry !== undefined &&
      selectedEntry !== observedEntry
    )
      return yield* Effect.fail(
        fail(
          "MAINTENANCE_TARGET_SCOPE",
          "The selected page and --entry belong to different databases.",
        ),
      )
    const library = yield* loadSharedLibrary(selectedEntry ?? observedEntry!)
    if (
      parent.data_source_id !== library.skills.data_source_id ||
      (expected !== undefined && library.library_id !== expected.library_id)
    )
      return yield* Effect.fail(
        fail(
          "MAINTENANCE_TARGET_SCOPE",
          "The selected page is not a Skill in this exact registered library.",
        ),
      )
    if (
      expected !== undefined &&
      sharedSkillTextProperty(raw, library, "Skill ID") !== expected.skill_id
    )
      return yield* Effect.fail(
        fail(
          "MAINTENANCE_TARGET_SCOPE",
          "The selected shared identity changed before the exact page observation.",
        ),
      )
    return {
      page_id: selectedPage,
      entry: library.skills.database_id,
      library_id: library.library_id,
      selected_from: "exact_page_metadata" as const,
      pin: null,
    }
  })
}
