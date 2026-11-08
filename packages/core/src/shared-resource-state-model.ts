import type { Effect } from "effect"
import { fail } from "./model.ts"
import {
  resolveFileState,
  type BodyFingerprint,
  type FileEvent,
  type ResolvedFileState,
} from "./shared-file-state.ts"
import type { SharedBodyBinding } from "./shared-skill-index.ts"
import type { observeSharedBody } from "./shared-page-body.ts"
import {
  resourceContentForOwnership,
  isResourceFollowing,
  type ResourceContent,
} from "./shared-resource-content.ts"

type ProjectionEvent = Extract<
  FileEvent,
  { readonly kind: "projected" | "following_restored" | "resource_followed" }
>
function projectionFingerprint(event: ProjectionEvent) {
  return event.kind === "resource_followed"
    ? {
        kind: "resource" as const,
        sha256: event.content.sha256,
        bytes: event.content.bytes,
        mode: event.content.mode,
      }
    : event.projection
}
export type ResourceBodyObservation =
  | { readonly kind: "unobserved" }
  | {
      readonly kind: "resource_verified"
      readonly content: ResourceContent
      readonly observed_at: number
      readonly verification: "remote_verified"
    }
  | {
      readonly kind: "observed"
      readonly body: Effect.Success<ReturnType<typeof observeSharedBody>>
    }
  | {
      readonly kind: "unavailable"
      readonly code: string
      readonly access: "denied" | "unknown"
    }

/** Nearest projection ancestors, not the newest event in the whole history. */
function projectionAncestors(events: readonly FileEvent[], state: ResolvedFileState) {
  const byId = new Map(events.map((event) => [event.event_id, event]))
  const projections = new Map<string, ProjectionEvent>()
  const unprojectedRoots = new Set<string>()
  const seen = new Set<string>()
  const visit = (id: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    const event = byId.get(id)
    // resolveFileState already validates the complete graph. Preserve that boundary.
    if (event === undefined)
      throw fail("SHARED_STATE_INCOMPLETE", "A projection ancestor is missing.", { event_id: id })
    if (
      event.kind === "projected" ||
      event.kind === "following_restored" ||
      event.kind === "resource_followed"
    ) {
      projections.set(event.event_id, event)
      return
    }
    if (event.parents.length === 0) unprojectedRoots.add(event.event_id)
    for (const parent of event.parents) visit(parent)
  }
  for (const id of state.heads) visit(id)
  return {
    projections: [...projections.values()].sort((left, right) =>
      left.event_id.localeCompare(right.event_id),
    ),
    unprojectedRoots: [...unprojectedRoots].sort(),
  }
}

function recordedProjection(events: readonly FileEvent[], state: ResolvedFileState | undefined) {
  if (state === undefined) return { kind: "unknown" as const, reason: "no_file_events" as const }
  const { projections: ancestors, unprojectedRoots } = projectionAncestors(events, state)
  if (unprojectedRoots.length > 0)
    return {
      kind: "unknown" as const,
      reason: "incomplete_projection_ancestry" as const,
      unknown_root_event_ids: unprojectedRoots,
      candidates: ancestors.map((event) => ({
        event_id: event.event_id,
        source_revision: event.source_revision,
        fingerprint: projectionFingerprint(event),
      })),
    }
  const first = ancestors[0]
  if (first === undefined)
    return { kind: "unknown" as const, reason: "no_projection_ancestor" as const }
  const same = ancestors.every(
    (event) =>
      event.source_revision === first.source_revision &&
      JSON.stringify(projectionFingerprint(event)) ===
        JSON.stringify(projectionFingerprint(first)) &&
      (event.kind === "resource_followed" ? event.source_id : null) ===
        (first.kind === "resource_followed" ? first.source_id : null) &&
      (event.kind === "resource_followed" ? event.source_path : null) ===
        (first.kind === "resource_followed" ? first.source_path : null),
  )
  if (!same)
    return {
      kind: "ambiguous" as const,
      candidates: ancestors.map((event) => ({
        event_id: event.event_id,
        source_revision: event.source_revision,
        fingerprint: projectionFingerprint(event),
      })),
    }
  return {
    kind: "recorded" as const,
    evidence: "file_event_ancestry" as const,
    event_ids: ancestors.map((event) => event.event_id),
    source_revision: first.source_revision,
    fingerprint: projectionFingerprint(first),
    ...(first.kind === "resource_followed"
      ? { source_id: first.source_id, source_path: first.source_path }
      : {}),
  }
}

function sameFingerprint(left: BodyFingerprint, right: BodyFingerprint): boolean {
  return left.normalization_version === right.normalization_version && left.sha256 === right.sha256
}

/** State presentation is pure. It cannot adopt, reconcile, or infer ownership from timestamps. */
export function describeSharedResourceFile(input: {
  readonly binding: SharedBodyBinding
  readonly events: readonly FileEvent[]
  readonly selectedRevision: string | null
  readonly observation: ResourceBodyObservation
}) {
  const { binding, events } = input
  const state = events.length === 0 ? undefined : resolveFileState(binding.file_id, events)
  const resource = state === undefined ? undefined : resourceContentForOwnership(state.ownership)
  const recorded = recordedProjection(events, state)
  const projectionProperty =
    binding.baseline === undefined
      ? { kind: "unrecorded" as const }
      : { kind: "recorded" as const, evidence: "native_property" as const, ...binding.baseline }
  const selectedComparison =
    input.selectedRevision === null || recorded.kind !== "recorded"
      ? "unknown"
      : input.selectedRevision === recorded.source_revision
        ? "same_revision"
        : "different_revision"
  const observed = input.observation
  const observation =
    observed.kind !== "observed"
      ? observed
      : {
          kind: "observed" as const,
          observed_at: observed.body.downloaded_at,
          fingerprint: observed.body.fingerprint,
          bytes: observed.body.bytes,
          projection_comparison:
            recorded.kind !== "recorded" || !("normalization_version" in recorded.fingerprint)
              ? "unknown"
              : sameFingerprint(recorded.fingerprint, observed.body.fingerprint)
                ? "matches_recorded_projection"
                : "differs_from_recorded_projection",
          ownership_comparison:
            state === undefined
              ? "uninitialized"
              : state.ownership.kind === "tombstone"
                ? "tombstone"
                : (
                      state.ownership.kind === "following" && !isResourceFollowing(state.ownership)
                        ? sameFingerprint(state.ownership.projection, observed.body.fingerprint)
                        : state.ownership.kind === "custom" &&
                          state.ownership.content.sha256 === observed.body.fingerprint.sha256
                    )
                  ? "matches_recorded_owner"
                  : "requires_observation_commit",
        }
  return {
    file_id: binding.file_id,
    path: state?.placement?.path ?? binding.path,
    page_id: binding.page_id,
    ...(resource === undefined
      ? {}
      : {
          representation: {
            kind: "resource" as const,
            content: resource,
            editable_body: false as const,
          },
        }),
    resolution: state ?? { kind: "uninitialized" as const },
    display: {
      recorded,
      projection_property: projectionProperty,
      selected_comparison: selectedComparison,
      page_last_edited_time: binding.last_edited_time,
      observation,
    },
    customization:
      state === undefined
        ? { kind: "unknown" as const }
        : state.ownership.kind === "custom"
          ? { kind: "custom" as const, content: state.ownership.content, based_on: recorded }
          : { kind: "not_custom" as const },
  }
}
