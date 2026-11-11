import { Effect } from "effect"
import { decode, fail, property, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { SharedCreateManifestSchema, sharedCreateManifestEntity } from "./shared-create-model.ts"
import { sharedCreateRetainedBinding } from "./shared-create-retained.ts"
import { fileIntentChecked } from "./shared-file-intent.ts"
import { readSharedFileSourceContext } from "./shared-file-source-context.ts"
import { FileEventSchema, resolveFileState } from "./shared-file-state.ts"
import type { SharedLibrary, TableBinding } from "./shared-library-model.ts"
import { canonicalSharedJson, querySharedRecords } from "./shared-records.ts"
import { inspectSharedResourceState } from "./shared-resource-state.ts"
import {
  resourceFileDisplaySchema,
  resourceSkillDisplaySchema,
} from "./shared-resource-display-schema.ts"
import { guardedSourceMutation, sourceField, sourceRich } from "./shared-source-definitions.ts"

export type SharedResourceState = Effect.Success<ReturnType<typeof inspectSharedResourceState>>
type ResourceFile = SharedResourceState["files"][number]
type DisplayValue =
  | { readonly rich_text: string }
  | { readonly select: string }
  | { readonly date: string | null }
type DisplayValues = Readonly<Record<string, DisplayValue>>
const revision = (value: string) => (/^[a-f0-9]{40,64}$/u.test(value) ? value.slice(0, 12) : value)
const rich = (value: string): DisplayValue => ({ rich_text: value })
// Notion date properties retain minute precision; the underlying observation
// and provider facts keep their original timestamps.
const date = (value: number | string): DisplayValue => ({
  date: new Date(Math.floor(new Date(value).getTime() / 60_000) * 60_000).toISOString(),
})

/** As-observed summaries only. A new check cannot make an older projected page current. */
export function describeSharedResourceDisplay(state: SharedResourceState) {
  return state.files.map((file) => {
    const recorded = file.display.recorded,
      observation = file.display.observation
    const ownership = "ownership" in file.resolution ? file.resolution.ownership.kind : "unobserved"
    const pending = [
      ...state.operations.local_pending,
      ...Object.values(state.operations.families).flatMap((family) =>
        family.kind === "observed" ? family.pending : [],
      ),
    ].filter((operation) => operation.file_id === file.file_id)
    const unreadable = observation.kind === "unavailable"
    const changed =
      observation.kind === "observed" &&
      observation.ownership_comparison === "requires_observation_commit"
    const recordedRevision =
      recorded.kind === "recorded"
        ? revision(recorded.source_revision)
        : recorded.kind === "ambiguous"
          ? "Ambiguous"
          : "Unknown"
    const values: Record<string, DisplayValue> = {
      "Displayed Revision": rich(
        ownership === "custom"
          ? `Custom (base ${recordedRevision})`
          : ownership === "tombstone"
            ? "Deleted"
            : changed
              ? `Native edit (last projection ${recordedRevision})`
              : recordedRevision,
      ),
      "Custom Baseline": rich(ownership === "custom" ? recordedRevision : ""),
      Ownership: { select: ownership === "tombstone" ? "deleted" : ownership },
      "Projection State": rich(
        pending.length > 0
          ? "Original operation pending"
          : unreadable
            ? `Observation unavailable: ${observation.code}`
            : changed
              ? "Native edit awaiting takeover"
              : observation.kind === "unobserved"
                ? "Recorded state; content not observed"
                : ownership === "custom"
                  ? "Custom content preserved"
                  : file.display.selected_comparison === "different_revision"
                    ? "Shows an earlier selected revision"
                    : file.display.selected_comparison === "unknown"
                      ? "Version comparison unknown"
                      : state.operations.coverage === "partial"
                        ? "Content matches; operation coverage partial"
                        : "Observed complete",
      ),
    }
    if (observation.kind === "observed" || observation.kind === "resource_verified")
      values["Content Observed At"] = date(observation.observed_at)
    const main = file.page_id === state.skill_page_id
    if (main) {
      values["Selected Revision"] = rich(
        state.selected.kind === "selected"
          ? revision(state.selected.revision)
          : state.selected.kind === "none"
            ? "None"
            : "Unavailable",
      )
      if (
        state.source.kind === "observed" &&
        state.source.last_successful_check.kind === "recorded"
      )
        values["Last Successful Check"] = date(state.source.last_successful_check.checked_at)
      if (state.candidate.kind === "frozen") {
        values["Discovered Candidate"] = rich(
          `${revision(state.candidate.provider_revision)}${state.candidate.selection_matches && state.candidate.source_binding_matches === true ? " (prepared)" : " (context changed)"}`,
        )
        if (state.candidate.provider_committed_at !== null)
          values["Upstream Commit Time"] = date(state.candidate.provider_committed_at)
      }
    }
    return {
      file_id: file.file_id,
      page_id: file.page_id,
      path: file.path,
      role: main ? ("skills" as const) : ("files" as const),
      values,
    }
  })
}

function pageValues(
  raw: unknown,
  table: TableBinding,
  file: ResourceFile,
  state: SharedResourceState,
  fields: readonly string[],
) {
  const row = property(raw)
  if (
    row.object !== "page" ||
    row.id !== file.page_id ||
    row.archived === true ||
    row.in_trash === true ||
    property(row.parent).data_source_id !== table.data_source_id
  )
    throw fail(
      "RESOURCE_DISPLAY_SCOPE",
      "The display target moved outside its exact registered table.",
    )
  const main = file.page_id === state.skill_page_id
  const identity = sourceField(row, table.property_ids[main ? "Main File ID" : "File ID"]!)
  if (
    identity.type !== "rich_text" ||
    !Array.isArray(identity.rich_text) ||
    identity.has_more === true ||
    text(identity.rich_text) !== file.file_id
  )
    throw fail(
      "RESOURCE_DISPLAY_SCOPE",
      "The page no longer claims the exact stable File identity.",
    )
  if (!main) {
    const relation = sourceField(row, table.property_ids.Skill!),
      path = sourceField(row, table.property_ids.Path!)
    if (
      relation.type !== "relation" ||
      relation.has_more === true ||
      !Array.isArray(relation.relation) ||
      relation.relation.length !== 1 ||
      property(relation.relation[0]).id !== state.skill_page_id ||
      text(path.rich_text) !== file.path
    )
      throw fail(
        "RESOURCE_DISPLAY_SCOPE",
        "The supporting display requires its exact single Skill relation and canonical path.",
      )
  }
  const values: Record<string, DisplayValue> = {}
  for (const name of fields) {
    const value = sourceField(row, table.property_ids[name]!)
    if (
      value.type === "rich_text" &&
      Array.isArray(value.rich_text) &&
      value.has_more !== true &&
      value.rich_text.length < 25
    )
      values[name] = { rich_text: text(value.rich_text) }
    else if (value.type === "select")
      values[name] = { select: String(property(value.select).name ?? "") }
    else if (
      value.type === "date" &&
      (value.date === null || typeof property(value.date).start === "string")
    )
      values[name] = {
        date:
          value.date === null ? null : new Date(String(property(value.date).start)).toISOString(),
      }
    else
      throw fail(
        "RESOURCE_DISPLAY_SCHEMA",
        "A registered display property is incomplete or changed type.",
        { property: name },
      )
  }
  return values
}
const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
function assertFacts(library: SharedLibrary, state: SharedResourceState, file: ResourceFile) {
  return Effect.gen(function* () {
    const main = yield* (yield* Notion).request(`v1/pages/${state.skill_page_id}`)
    const identity = yield* fileIntentChecked(() =>
      sourceField(main, library.skills.property_ids["Skill ID"]!),
    )
    if (
      identity.type !== "rich_text" ||
      identity.has_more === true ||
      !Array.isArray(identity.rich_text) ||
      text(identity.rich_text) !== state.skill_id
    )
      return yield* Effect.fail(
        fail(
          "RESOURCE_DISPLAY_SCOPE",
          "The main page's stable Skill identity changed after observation.",
        ),
      )
    const current = yield* readSharedFileSourceContext(library, state.skill_page_id, main)
    const expected = {
      selected_version:
        state.selected.kind === "selected" || state.selected.kind === "unavailable"
          ? state.selected.source_id
          : "",
      definition:
        state.source.kind === "observed"
          ? {
              page_id: state.source.page_id,
              source_id: state.source.source_id,
              fingerprint: state.source.fingerprint,
              member: state.source.member,
            }
          : null,
    }
    if (!same(current, expected))
      return yield* Effect.fail(
        fail(
          "RESOURCE_DISPLAY_STALE",
          "Source selection or binding changed after the display observation.",
        ),
      )
    const facts = yield* querySharedRecords(library, {
      skillPageId: state.skill_page_id,
      kind: "file_event",
      entityId: file.file_id,
    })
    const heads = yield* fileIntentChecked(() => {
      const events = facts.map((fact) => {
        const event = decode(FileEventSchema, fact.payload)
        if (
          event.file_id !== file.file_id ||
          fact.record_id !== event.event_id ||
          fact.entity_id !== file.file_id
        )
          throw fail(
            "RESOURCE_DISPLAY_SCOPE",
            "Display history contains another stable file identity.",
          )
        return event
      })
      return events.length === 0 ? [] : resolveFileState(file.file_id, events).heads
    })
    if (!same(heads, "heads" in file.resolution ? file.resolution.heads : []))
      return yield* Effect.fail(
        fail("RESOURCE_DISPLAY_STALE", "File ownership changed after the display observation."),
      )
  }).pipe(withReadOnlyNotion)
}

/** Metadata-only publication; failure is reported separately from the already observed content facts. */
export function syncSharedResourceDisplay(
  library: SharedLibrary,
  state: SharedResourceState,
  dryRun = false,
) {
  return Effect.gen(function* () {
    if (state.library_id !== library.library_id)
      return yield* Effect.fail(
        fail("RESOURCE_DISPLAY_SCOPE", "The display observation belongs to another library."),
      )
    const notConfigured = (["skills", "files"] as const).filter((role) =>
      Object.keys(role === "skills" ? resourceSkillDisplaySchema : resourceFileDisplaySchema).some(
        (name) => !library[role].property_ids[name],
      ),
    )
    if (notConfigured.length > 0)
      return {
        display_status: "not_configured" as const,
        not_configured: notConfigured,
        rows: describeSharedResourceDisplay(state),
        body_writes: 0 as const,
      }
    const api = yield* Notion,
      rows = describeSharedResourceDisplay(state)
    // Initial fixed-source creation retains provider commit metadata with its original manifest.
    if (
      state.selected.kind === "selected" &&
      rows[0]?.values["Upstream Commit Time"] === undefined
    ) {
      const manifests = yield* querySharedRecords(library, {
        skillPageId: state.skill_page_id,
        kind: "operation",
        entityId: sharedCreateManifestEntity,
      })
      for (const fact of manifests) {
        const manifest = yield* fileIntentChecked(() =>
          decode(SharedCreateManifestSchema, fact.payload),
        )
        const projection = manifest.source_projection
        const selected =
          projection === undefined
            ? undefined
            : projection.version === 1
              ? projection.binding.source_id
              : (yield* sharedCreateRetainedBinding(
                  library,
                  projection.retained,
                  state.skill_page_id,
                )).source_id
        if (
          manifest.skill_id === state.skill_id &&
          manifest.library.library_id === library.library_id &&
          fact.record_id === manifest.operation_id &&
          projection !== undefined &&
          selected === state.selected.source_id &&
          projection.provider_committed_at !== undefined
        )
          rows.find((row) => row.role === "skills")!.values["Upstream Commit Time"] = date(
            projection.provider_committed_at,
          )
      }
    }
    const results = []
    for (const proposed of rows) {
      const file = state.files.find((candidate) => candidate.file_id === proposed.file_id)!,
        table = library[proposed.role]
      const result = yield* Effect.gen(function* () {
        const raw = yield* api.request(`v1/pages/${file.page_id}`)
        const before = yield* fileIntentChecked(() =>
          pageValues(raw, table, file, state, Object.keys(proposed.values)),
        )
        const differences = Object.fromEntries(
          Object.entries(proposed.values).filter(
            ([name, value]) => name !== "Content Observed At" && !same(value, before[name]),
          ),
        )
        if (Object.keys(differences).length === 0)
          return { file_id: file.file_id, display_status: "unchanged" as const }
        if (proposed.values["Content Observed At"] !== undefined)
          differences["Content Observed At"] = proposed.values["Content Observed At"]
        const properties = Object.fromEntries(
          Object.entries(differences).map(([name, value]) => [
            table.property_ids[name]!,
            "rich_text" in value
              ? { rich_text: sourceRich(value.rich_text) }
              : "select" in value
                ? { select: { name: value.select } }
                : { date: value.date === null ? null : { start: value.date } },
          ]),
        )
        if (dryRun) return { file_id: file.file_id, display_status: "planned" as const, properties }
        yield* assertFacts(library, state, file)
        const mutation = yield* guardedSourceMutation(
          library,
          {
            identity: `resource-display:${file.file_id}`,
            path: `v1/pages/${file.page_id}`,
            method: "PATCH",
            body: { properties },
            beforeDispatch: Effect.gen(function* () {
              const current = yield* api.request(`v1/pages/${file.page_id}`)
              const observed = yield* fileIntentChecked(() =>
                pageValues(current, table, file, state, Object.keys(before)),
              )
              if (!same(before, observed))
                return yield* Effect.fail(
                  fail(
                    "RESOURCE_DISPLAY_STALE",
                    "A display property changed concurrently; preserve the later field edit.",
                  ),
                )
              yield* assertFacts(library, state, file)
            }).pipe(withReadOnlyNotion),
          },
          Effect.gen(function* () {
            const current = yield* api.request(`v1/pages/${file.page_id}`)
            const observed = yield* fileIntentChecked(() =>
              pageValues(current, table, file, state, Object.keys(differences)),
            )
            return same(observed, differences) ? observed : undefined
          }),
        )
        return {
          file_id: file.file_id,
          display_status:
            "original_outcome" in mutation && mutation.original_outcome === "unknown"
              ? ("unknown" as const)
              : ("verified_applied" as const),
          operation_id: mutation.operation_id,
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            file_id: file.file_id,
            display_status: "failed" as const,
            code: error.code,
            message: error.message,
          }),
        ),
      )
      results.push(result)
    }
    return {
      display_status: results.some(
        (result) => result.display_status === "failed" || result.display_status === "unknown",
      )
        ? ("incomplete" as const)
        : dryRun
          ? ("planned" as const)
          : ("complete" as const),
      observed_at: state.observed_at,
      rows,
      results,
      body_writes: 0 as const,
      authoritative: false as const,
    }
  })
}
