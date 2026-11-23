import { Effect, Schema } from "effect"
import {
  decode,
  fail,
  listSchema,
  property,
  SkillsError,
  type SharedSkillRecord,
  type Source,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { sharedRecordFromPage, skillIdentity } from "./shared-content.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import type { CompleteSharedMetadataInventory } from "./shared-metadata-inventory.ts"

/** Exact requested targets with their stable claims checked. This is not an inventory. */
export interface SelectedSharedSkillMetadata {
  readonly record: SharedSkillRecord
  readonly rawPage: unknown
}

/** Only the normalized rejection for the exact requested physical child is an
 * access observation. A relation ID alone or a library query is not one. */
export function observedRelationPageDenial(error: SkillsError) {
  const details = property(error.details)
  const field = details.field
  const id = typeof details.page_id === "string" ? pageId(details.page_id) : undefined
  return error.code === "SHARED_ROUTER_MEMBER_UNAVAILABLE" &&
    details.cause_code === "ACCESS_DENIED" &&
    (field === "Requires" || field === "Members") &&
    id !== undefined &&
    details.path === `v1/pages/${id}`
    ? { page_id: id, field }
    : undefined
}

const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_GRAPH_METADATA_INVALID", "Selected Skill metadata is invalid."),
  })
const sourceFor = (library: SharedLibrary): Source => ({
  alias: library.library_id,
  title: "",
  role: "content",
  database_id: library.skills.database_id,
  data_source_ids: [library.skills.data_source_id],
  shared_library: library,
})
function physicalPage(raw: unknown, library: SharedLibrary) {
  const row = property(raw),
    parent = property(row.parent)
  const id = typeof row.id === "string" ? pageId(row.id) : undefined
  if (
    row.object !== "page" ||
    id === undefined ||
    parent.type !== "data_source_id" ||
    parent.data_source_id !== library.skills.data_source_id ||
    (parent.database_id !== undefined && parent.database_id !== library.skills.database_id)
  )
    throw fail(
      "SHARED_GRAPH_METADATA_INVALID",
      "Selected metadata contains a foreign or invalid Skill page.",
    )
  return id
}
function observed(rawPage: unknown, library: SharedLibrary): SelectedSharedSkillMetadata {
  const record = sharedRecordFromPage(rawPage, sourceFor(library), library.skills.data_source_id)
  physicalPage(rawPage, library)
  return { rawPage, record }
}
function wantedPages(ids: readonly string[]) {
  const wanted = new Set<string>()
  for (const id of ids) {
    if (pageId(id) !== id || wanted.has(id))
      throw fail("SHARED_GRAPH_METADATA_INVALID", "Select distinct exact Skill page identities.")
    wanted.add(id)
  }
  return wanted
}
function unavailable(page_id: string, cause_code?: string) {
  return fail(
    "SHARED_ROUTER_MEMBER_UNAVAILABLE",
    "A selected relation target is unavailable in this library.",
    { page_id, ...(cause_code === undefined ? {} : { cause_code }) },
  )
}
function assertUnique(
  target: SelectedSharedSkillMetadata,
  claims: ReadonlyMap<string, ReadonlySet<string>>,
) {
  const pages = claims.get(target.record.id)
  if (pages?.size !== 1 || !pages.has(target.record.locator.page_id))
    throw fail(
      "SHARED_SKILL_ID_CONFLICT",
      "Several pages claim the selected Skill identity, or its observed claim changed.",
      {
        id: target.record.id,
        page_ids: [...(pages ?? [])].sort(),
        expected_page_id: target.record.locator.page_id,
      },
    )
}

/** Only a genuinely complete observation may prove global claim uniqueness without a query. */
export function selectedSkillsFromInventory(
  library: SharedLibrary,
  ids: readonly string[],
  inventory: CompleteSharedMetadataInventory,
) {
  if (inventory.data_source_id !== library.skills.data_source_id || inventory.complete !== true)
    throw fail(
      "SHARED_GRAPH_METADATA_INVALID",
      "The complete Skills inventory belongs to another library.",
    )
  const wanted = wantedPages(ids),
    targets = new Map<string, SelectedSharedSkillMetadata>()
  const claims = new Map<string, Set<string>>(),
    seen = new Set<string>()
  for (const raw of inventory.pages) {
    const rawId =
      typeof property(raw).id === "string" ? pageId(String(property(raw).id)) : undefined
    let target: SelectedSharedSkillMetadata
    try {
      target = observed(raw, library)
    } catch (error) {
      // The complete inventory's transport proof belongs to its producer.
      // Only selected malformed rows block relation decoding; unrelated invalid
      // records never become identity claims or selected targets.
      if ((rawId === undefined || !wanted.has(rawId)) && error instanceof SkillsError) continue
      throw error
    }
    const id = target.record.locator.page_id
    if (wanted.has(id) && seen.has(id))
      throw fail(
        "SHARED_GRAPH_METADATA_INCOMPLETE",
        "The complete inventory repeats a selected Skill page.",
      )
    seen.add(id)
    const owners = claims.get(target.record.id) ?? new Set<string>()
    owners.add(id)
    claims.set(target.record.id, owners)
    if (wanted.has(id)) targets.set(id, target)
  }
  for (const id of wanted) {
    const target = targets.get(id)
    if (target === undefined) throw unavailable(id)
    assertUnique(target, claims)
  }
  return targets
}

function querySkillClaims(library: SharedLibrary, stableIds: readonly string[]) {
  return Effect.gen(function* () {
    yield* checked(() => {
      for (const id of stableIds) skillIdentity(library.library_id, id)
    })
    const api = yield* Notion
    const query = new URLSearchParams()
    for (const name of [
      "Name",
      "Description",
      "Kind",
      "Skill ID",
      "Enabled",
      "Default Context",
      "Main File ID",
      "Content",
      "Current State",
      "Operation",
      "Origin",
      "Members",
      "Requires",
    ]) {
      const id = library.skills.property_ids[name]
      if (!id) {
        if (
          ["Name", "Description", "Kind", "Skill ID", "Enabled", "Default Context"].includes(name)
        )
          return yield* Effect.fail(
            fail("LIBRARY_INVALID", "A registered Skill identity property is missing.", {
              property: name,
            }),
          )
        continue
      }
      query.append("filter_properties", id)
    }
    const claims = new Map<string, Set<string>>(),
      seen = new Set<string>(),
      observations = new Map<string, SelectedSharedSkillMetadata>()
    for (let offset = 0; offset < stableIds.length; offset += 80) {
      const selected = new Set(stableIds.slice(offset, offset + 80))
      const parts = [...selected].map((id) => ({
        property: library.skills.property_ids["Skill ID"],
        rich_text: { equals: id },
      }))
      const cursors = new Set<string>()
      let cursor: string | undefined
      for (;;) {
        const raw = yield* api
          .request(
            `v1/data_sources/${library.skills.data_source_id}/query?${query}`,
            {
              page_size: 100,
              filter: parts.length === 1 ? parts[0] : { or: parts },
              ...(cursor === undefined ? {} : { start_cursor: cursor }),
            },
            { method: "POST" },
          )
          .pipe(
            Effect.catch((error) =>
              ["ACCESS_DENIED", "NOT_FOUND"].includes(error.code)
                ? Effect.fail(
                    fail(
                      "SHARED_GRAPH_METADATA_UNAVAILABLE",
                      "The selected Skill identity claims could not be read.",
                      {
                        ...property(error.details),
                        cause_code: error.code,
                      },
                    ),
                  )
                : Effect.fail(error),
            ),
          )
        const result = yield* checked(() => {
          const envelope = property(raw)
          if (
            envelope.object !== "list" ||
            (envelope.request_status !== undefined &&
              (property(envelope.request_status).type !== "complete" ||
                property(envelope.request_status).incomplete_reason != null))
          )
            throw fail(
              "SHARED_GRAPH_METADATA_INCOMPLETE",
              "The selected Skill claim query is incomplete.",
            )
          const page = decode(listSchema(Schema.Unknown), raw)
          if (
            page.has_more
              ? !page.next_cursor || cursors.has(page.next_cursor) || cursors.size >= 1000
              : page.next_cursor !== null
          )
            throw fail(
              "SHARED_GRAPH_METADATA_INCOMPLETE",
              "Selected Skill claim pagination did not complete or advance.",
            )
          for (const row of page.results) {
            const target = observed(row, library),
              id = target.record.locator.page_id
            if (!selected.has(target.record.locator.skill_id) || seen.has(id))
              throw fail(
                "SHARED_GRAPH_METADATA_INVALID",
                "A selected Skill query returned an unrequested or repeated identity.",
              )
            seen.add(id)
            observations.set(id, target)
            const owners = claims.get(target.record.id) ?? new Set<string>()
            owners.add(id)
            claims.set(target.record.id, owners)
          }
          return page
        })
        if (!result.has_more) break
        cursor = result.next_cursor!
        cursors.add(cursor)
      }
    }
    return { claims, observations }
  })
}

/** Resolve a stable identity inside an already verified library, without global discovery. */
export function querySelectedSkillIdentity(library: SharedLibrary, skillId: string) {
  return Effect.gen(function* () {
    const id = yield* checked(() => skillIdentity(library.library_id, skillId))
    const { claims, observations } = yield* querySkillClaims(library, [skillId])
    const pages = claims.get(id)
    if (pages === undefined || pages.size === 0)
      return yield* Effect.fail(
        fail(
          "SKILL_NOT_FOUND",
          "No current Skill has the selected stable identity in this library.",
          { id },
        ),
      )
    const target = observations.get([...pages][0]!)!
    yield* checked(() => assertUnique(target, claims))
    return target
  })
}

/** Fetch only requested physical targets, then exhaust exact stable-ID claim queries.
 * Disabled claims participate. Neither a partial page set nor a filtered list is complete inventory. */
export function querySelectedSkillMetadataWithClaims(
  library: SharedLibrary,
  ids: readonly string[],
  seeds: readonly unknown[] = [],
) {
  return Effect.gen(function* () {
    const wanted = yield* checked(() => wantedPages(ids))
    const targets = new Map<string, SelectedSharedSkillMetadata>()
    for (const raw of seeds) {
      const target = yield* checked(() => observed(raw, library))
      if (!wanted.has(target.record.locator.page_id) || targets.has(target.record.locator.page_id))
        return yield* Effect.fail(
          fail(
            "SHARED_GRAPH_METADATA_INVALID",
            "A selected observation has an unexpected or repeated page.",
          ),
        )
      targets.set(target.record.locator.page_id, target)
    }
    const api = yield* Notion
    for (const id of wanted) {
      if (targets.has(id)) continue
      // The requested child is the only identity this error can name. It cannot
      // revoke a root or an authorization scope that this request did not observe.
      const raw = yield* api.request(`v1/pages/${id}`).pipe(
        Effect.catch((error) =>
          ["ACCESS_DENIED", "NOT_FOUND"].includes(error.code)
            ? Effect.fail(
                fail(
                  "SHARED_ROUTER_MEMBER_UNAVAILABLE",
                  "A selected relation target could not be read.",
                  {
                    cause_code: error.code,
                    requested_page_id: id,
                    ...(property(error.details).path === `v1/pages/${id}` ? { page_id: id } : {}),
                    ...(typeof property(error.details).path === "string"
                      ? { path: property(error.details).path }
                      : {}),
                  },
                ),
              )
            : Effect.fail(error),
        ),
      )
      const target = yield* checked(() => observed(raw, library))
      if (target.record.locator.page_id !== id)
        return yield* Effect.fail(
          fail(
            "SHARED_GRAPH_METADATA_INVALID",
            "A page read returned a different physical Skill.",
            { page_id: id },
          ),
        )
      targets.set(id, target)
    }
    if (targets.size === 0)
      return { targets, observations: new Map<string, SelectedSharedSkillMetadata>() }
    const { claims, observations } = yield* querySkillClaims(library, [
      ...new Set([...targets.values()].map((target) => target.record.locator.skill_id)),
    ])
    yield* checked(() => {
      for (const target of targets.values()) assertUnique(target, claims)
    })
    return { targets, observations }
  })
}

/** Existing consumers select exact targets; discovery can also retain newer claim observations. */
export function querySelectedSkillMetadata(
  library: SharedLibrary,
  ids: readonly string[],
  seeds: readonly unknown[] = [],
) {
  return querySelectedSkillMetadataWithClaims(library, ids, seeds).pipe(
    Effect.map((value) => value.targets),
  )
}
