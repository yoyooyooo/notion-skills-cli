import { Clock, Effect, Schema, type Result } from "effect"
import { authScope } from "./catalog.ts"
import { decode, fail, listSchema, property, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { pageId } from "./ref.ts"
import { sharedSkillProperty } from "./shared-content.ts"
import { FileEventSchema, type FileEvent } from "./shared-file-state.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { loadPendingSharedBodyWrites } from "./shared-body-write.ts"
import { loadPendingSharedMetadataWrites } from "./shared-metadata-write.ts"
import { sharedMetadataEntity } from "./shared-metadata-write-model.ts"
import { loadPendingSharedObservationPlans } from "./shared-observation-operation.ts"
import { querySharedOperationIndex } from "./shared-operation-index.ts"
import { observeSharedBody } from "./shared-page-body.ts"
import {
  pendingFileOperations,
  sharedPendingObservationPrefix,
} from "./shared-pending-file-operations.ts"
import { querySharedRecords } from "./shared-records.ts"
import {
  describeSharedResourceFile,
  type ResourceBodyObservation,
} from "./shared-resource-state-model.ts"
import { resolveSelectedSharedSourceReference } from "./shared-selected-source.ts"
import { querySharedSkillIndex, type SharedSkillIndex } from "./shared-skill-index.ts"
import { inspectSharedSnapshotHistory } from "./shared-snapshot-history.ts"
import { listSourceDefinitions, readSourceDefinition } from "./shared-source-definitions.ts"
import { validateSourceRefresh } from "./shared-source-refresh.ts"

const checked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_RESOURCE_STATE_INVALID", "Resource state could not be decoded."),
  })
const accessErrors = new Set(["AUTH_REQUIRED", "ACCESS_DENIED", "NOT_FOUND", "SKILL_NOT_FOUND"])
const unavailable = (error: SkillsError) => ({
  kind: "unavailable" as const,
  code: error.code,
  access:
    error.code === "ACCESS_DENIED" || error.code === "AUTH_REQUIRED"
      ? ("denied" as const)
      : ("unknown" as const),
})

/** Narrow, fully paginated identity lookup. Disabled duplicate claims also conflict. */
function assertUniqueSkill(library: SharedLibrary, index: SharedSkillIndex) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const identity = library.skills.property_ids["Skill ID"]
    if (identity === undefined)
      return yield* Effect.fail(fail("LIBRARY_INVALID", "The stable Skill ID property is missing."))
    const query = new URLSearchParams({ filter_properties: identity })
    const cursors = new Set<string>()
    const pages = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const raw = yield* api.request(
        `v1/data_sources/${library.skills.data_source_id}/query?${query}`,
        {
          page_size: 100,
          filter: { property: identity, rich_text: { equals: index.skill_id } },
          ...(cursor === undefined ? {} : { start_cursor: cursor }),
        },
        { method: "POST" },
      )
      const list = yield* checked(() => {
        const value = property(raw)
        if (
          value.object !== "list" ||
          (value.request_status !== undefined && property(value.request_status).type !== "complete")
        )
          throw fail(
            "SHARED_RESOURCE_STATE_INCOMPLETE",
            "The exact Skill identity query is incomplete.",
          )
        const result = decode(listSchema(Schema.Unknown), raw)
        for (const item of result.results) {
          const row = property(item)
          const field = sharedSkillProperty(row, library, "Skill ID")
          if (
            row.object !== "page" ||
            typeof row.id !== "string" ||
            pageId(row.id) !== row.id ||
            row.in_trash === true ||
            row.archived === true ||
            row.is_archived === true ||
            property(row.parent).data_source_id !== library.skills.data_source_id ||
            field.type !== "rich_text" ||
            !Array.isArray(field.rich_text) ||
            (field.has_more !== undefined && field.has_more !== false) ||
            text(field.rich_text) !== index.skill_id ||
            pages.has(row.id)
          )
            throw fail(
              "SHARED_SKILL_ID_CONFLICT",
              "The exact Skill identity query returned a conflicting claim.",
            )
          pages.add(row.id)
        }
        if (!result.has_more && result.next_cursor !== null)
          throw fail(
            "SHARED_RESOURCE_STATE_INCOMPLETE",
            "The identity query retained a terminal cursor.",
          )
        if (
          result.has_more &&
          (!result.next_cursor || cursors.has(result.next_cursor) || cursors.size >= 1000)
        )
          throw fail("SHARED_RESOURCE_STATE_INCOMPLETE", "The identity query did not advance.")
        return result
      })
      if (!list.has_more) break
      cursor = list.next_cursor ?? undefined
      if (cursor !== undefined) cursors.add(cursor)
    }
    if (pages.size !== 1 || !pages.has(index.page_id))
      return yield* Effect.fail(
        fail(
          "SHARED_SKILL_ID_CONFLICT",
          "Several pages claim the selected Skill identity, or its claim is unavailable.",
          {
            skill_id: index.skill_id,
            page_ids: [...pages].sort(),
          },
        ),
      )
  })
}

function observeSource(library: SharedLibrary, rawPage: unknown) {
  return Effect.gen(function* () {
    if (!library.sources || library.skills.property_ids.Origin === undefined)
      return { kind: "unconfigured" as const }
    const origin = yield* checked(() => {
      const relation = sharedSkillProperty(rawPage, library, "Origin")
      if (
        relation.type !== "relation" ||
        !Array.isArray(relation.relation) ||
        (relation.has_more !== undefined && relation.has_more !== false) ||
        relation.relation.length > 1
      )
        throw fail(
          "SOURCE_BINDING_AMBIGUOUS",
          "The Skill must have at most one complete Source origin.",
        )
      if (relation.relation.length === 0) return undefined
      const id = property(relation.relation[0]).id
      if (typeof id !== "string" || pageId(id) !== id)
        throw fail("SOURCE_BINDING_SCOPE", "The Source origin must be an exact page identity.")
      const member = sharedSkillProperty(rawPage, library, "Source Member")
      if (
        member.type !== "rich_text" ||
        !Array.isArray(member.rich_text) ||
        (member.has_more !== undefined && member.has_more !== false)
      )
        throw fail("SOURCE_BINDING_SCOPE", "The Source member property is incomplete.")
      return { page_id: id, member: text(member.rich_text) }
    })
    if (origin === undefined) return { kind: "unbound" as const }
    const observed = yield* readSourceDefinition(library, origin.page_id).pipe(Effect.result)
    if (observed._tag === "Failure") {
      if (!accessErrors.has(observed.failure.code)) return yield* Effect.fail(observed.failure)
      return { ...unavailable(observed.failure), ...origin }
    }
    const definition = observed.success
    const claims = yield* listSourceDefinitions(library, definition.source_id)
    if (claims.length !== 1 || claims[0]?.page_id !== definition.page_id)
      return yield* Effect.fail(
        fail("SOURCE_ID_CONFLICT", "Several pages claim the selected Source identity."),
      )
    return {
      kind: "observed" as const,
      ...origin,
      source_id: definition.source_id,
      fingerprint: definition.fingerprint,
      policy: definition.policy,
      enabled: definition.enabled,
      recorded_status: definition.status,
      recorded_revision:
        definition.last_revision === ""
          ? { kind: "unobserved" as const }
          : { kind: "recorded" as const, revision: definition.last_revision },
      provider_checked: false as const,
    }
  })
}

function inspectSelected(library: SharedLibrary, index: SharedSkillIndex) {
  return Effect.gen(function* () {
    if (index.source_reference === "") return { kind: "none" as const }
    const result = yield* resolveSelectedSharedSourceReference(library, {
      skillPageId: index.page_id,
      sourceId: index.source_reference,
    }).pipe(Effect.result)
    if (result._tag === "Failure") {
      if (!accessErrors.has(result.failure.code)) return yield* Effect.fail(result.failure)
      return { ...unavailable(result.failure), source_id: index.source_reference }
    }
    return {
      kind: "selected" as const,
      source_kind: result.success.kind,
      source_id: result.success.source_id,
      revision: result.success.revision,
      paths: result.success.paths,
      provider_checked: false as const,
    }
  })
}

function inspectOperations(
  library: SharedLibrary,
  index: SharedSkillIndex,
  events: readonly FileEvent[],
  observe: boolean,
) {
  return Effect.gen(function* () {
    const headers = yield* querySharedOperationIndex(library, index.page_id)
    const input = { skillPageId: index.page_id, events, headers }
    const scope = yield* authScope
    const local = yield* pendingFileOperations({
      prefix: yield* sharedPendingObservationPrefix(scope, library.library_id, index.skill_id),
      scope,
      library_id: library.library_id,
      skill_id: index.skill_id,
      skill_page_id: index.page_id,
    })
    const summary = <
      A extends { readonly operation_id: string; readonly file_id: string; readonly kind: string },
    >(
      result: Result.Result<readonly A[], SkillsError>,
    ) =>
      result._tag === "Failure"
        ? { kind: "unavailable" as const, code: result.failure.code }
        : {
            kind: "observed" as const,
            pending: result.success.map((plan) => ({
              operation_id: plan.operation_id,
              file_id: plan.file_id,
              kind: plan.kind,
            })),
          }
    const observedFamilies = observe
      ? {
          file_observations: summary(
            yield* loadPendingSharedObservationPlans(library, input).pipe(Effect.result),
          ),
          body_writes: summary(
            yield* loadPendingSharedBodyWrites(library, input).pipe(Effect.result),
          ),
          metadata_writes: summary(
            yield* loadPendingSharedMetadataWrites(library, input).pipe(Effect.result),
          ),
        }
      : {
          file_observations: { kind: "unobserved" as const },
          body_writes: { kind: "unobserved" as const },
          metadata_writes: { kind: "unobserved" as const },
        }
    const unclassified = headers.filter(
      (header) =>
        !header.record_id.startsWith("observe-") &&
        !header.record_id.startsWith("body-write-") &&
        !header.record_id.startsWith("outcome-body-write-") &&
        header.entity_id !== sharedMetadataEntity,
    )
    return {
      reconciled: false as const,
      shared_headers: headers,
      families: observedFamilies,
      unclassified_headers: unclassified,
      local_pending: local.map(({ plan }) => ({
        operation_id: plan.operation_id,
        kind: plan.kind,
        file_id: plan.file_id,
      })),
      coverage:
        unclassified.length === 0 &&
        Object.values(observedFamilies).every((value) => value.kind === "observed")
          ? ("observed_supported_families" as const)
          : ("partial" as const),
    }
  })
}

/** Current shared facts, optional exact body observations, and explicit caller pins.
 * This path never calls auto-adoption, source discovery, or original-operation reconciliation. */
export function inspectSharedResourceState(
  library: SharedLibrary,
  input: {
    readonly target: string
    readonly observe?: boolean
    readonly candidate?: unknown
    readonly sessionPin?: string
  },
) {
  return Effect.gen(function* () {
    const target = pageId(input.target)
    if (target === undefined)
      return yield* Effect.fail(fail("INVALID_ARGUMENT", "Inspect one exact Skill page ID."))
    const api = yield* Notion
    const rawPage = yield* api.request(`v1/pages/${target}`)
    const index = yield* querySharedSkillIndex(library, target, rawPage)
    yield* assertUniqueSkill(library, index)
    const facts = yield* querySharedRecords(library, { skillPageId: target, kind: "file_event" })
    const events = yield* checked(() =>
      facts.map((fact) => {
        const event = decode(FileEventSchema, fact.payload)
        if (fact.entity_id !== event.file_id || fact.record_id !== event.event_id)
          throw fail(
            "SHARED_STATE_SCOPE",
            "A file event disagrees with its shared record identity.",
          )
        return event
      }),
    )
    const source = yield* observeSource(library, rawPage)
    const selected = yield* inspectSelected(library, index)
    const candidate =
      input.candidate === undefined
        ? { kind: "unobserved" as const, reason: "no_frozen_candidate_supplied" as const }
        : yield* Effect.gen(function* () {
            const { plan } = yield* validateSourceRefresh(library, input.candidate)
            if (plan.target_page_id !== target)
              return yield* Effect.fail(
                fail("SOURCE_REFRESH_INVALID", "The candidate belongs to another Skill."),
              )
            return {
              kind: "frozen" as const,
              plan_id: plan.plan_id,
              source_id: plan.source_id,
              source_page_id: plan.source_page_id,
              source_fingerprint: plan.source_fingerprint,
              provider_revision: plan.provider_revision,
              member: plan.member,
              prepared_at: plan.created_at,
              proposed_source_id: plan.bundle_id,
              based_on: plan.previous_pin,
              selection_matches: plan.previous_pin === index.source_reference,
              application_readiness: "not_checked" as const,
              source_binding_matches:
                source.kind === "unavailable"
                  ? ("unknown" as const)
                  : source.kind === "observed" &&
                    source.source_id === plan.source_id &&
                    source.page_id === plan.source_page_id &&
                    source.member === plan.member &&
                    source.fingerprint === plan.source_fingerprint,
              files: plan.bundle.files,
            }
          })
    const sessionPin = input.sessionPin
    const session =
      sessionPin === undefined
        ? { kind: "unobserved" as const, reason: "no_session_pin_supplied" as const }
        : yield* Effect.gen(function* () {
            const pinned = yield* inspectSharedSnapshotHistory(library, {
              skillPageId: target,
              pinId: sessionPin,
            })
            if (
              pinned.manifest.record.locator.type !== "shared_skill" ||
              pinned.manifest.record.locator.skill_id !== index.skill_id
            )
              return yield* Effect.fail(
                fail(
                  "SHARED_HISTORY_SCOPE",
                  "The caller's session pin has another Skill identity.",
                ),
              )
            return {
              kind: "pinned" as const,
              supplied_by: "caller" as const,
              pin_id: pinned.pin_id,
              version_id: pinned.manifest.version_id,
              file_bindings: pinned.manifest.file_bindings,
              files: pinned.manifest.files.map(({ path, sha256, bytes }) => ({
                path,
                sha256,
                bytes,
              })),
              availability: "manifest_only" as const,
            }
          })
    const operations = yield* inspectOperations(library, index, events, input.observe === true)
    const bindings = [index.main, ...index.files]
    const files = yield* Effect.forEach(
      bindings,
      (binding) =>
        Effect.gen(function* () {
          const observation: ResourceBodyObservation =
            input.observe === true
              ? yield* observeSharedBody(binding.page_id).pipe(
                  Effect.map((body): ResourceBodyObservation => ({ kind: "observed", body })),
                  Effect.catch((error) => Effect.succeed(unavailable(error))),
                )
              : { kind: "unobserved" }
          return yield* checked(() =>
            describeSharedResourceFile({
              binding,
              events: events.filter((event) => event.file_id === binding.file_id),
              selectedRevision: selected.kind === "selected" ? selected.revision : null,
              observation,
            }),
          )
        }),
      { concurrency: 4 },
    )
    const bound = new Set(bindings.map((binding) => binding.file_id))
    return {
      state_version: 1 as const,
      library_id: library.library_id,
      skill_id: index.skill_id,
      skill_page_id: index.page_id,
      observed_at: yield* Clock.currentTimeMillis,
      source,
      selected,
      candidate,
      session,
      files,
      unbound_file_ids: [...new Set(events.map((event) => event.file_id))]
        .filter((id) => !bound.has(id))
        .sort(),
      operations,
      metadata_only: input.observe !== true,
      remote_writes: 0 as const,
      request_metrics: api.requestMetrics?.(),
    }
  }).pipe(withReadOnlyNotion)
}
