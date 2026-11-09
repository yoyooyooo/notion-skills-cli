import { Schema } from "effect"
import { decode, fail } from "./model.ts"
import { normalizePath } from "./ref.ts"

const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/))
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const BodyFingerprintSchema = Schema.Struct({
  normalization_version: Schema.Literal(1),
  sha256: Hash,
})
export type BodyFingerprint = typeof BodyFingerprintSchema.Type
/** Optional immutable native-file metadata. Absence preserves historical unknown values. */
export const NativeFileMetadataFields = {
  mode: Schema.optionalKey(Schema.Literals(["100644", "100755"])),
  frontmatter: Schema.optionalKey(Schema.String),
}
export const NativeFileMetadataSchema = Schema.Struct(NativeFileMetadataFields)
export type NativeFileMetadata = typeof NativeFileMetadataSchema.Type
export function nativeFileMetadata(value: {
  readonly mode?: "100644" | "100755" | null
  readonly frontmatter?: string
}): NativeFileMetadata {
  return {
    ...(value.mode === undefined || value.mode === null ? {} : { mode: value.mode }),
    ...(value.frontmatter === undefined ? {} : { frontmatter: value.frontmatter }),
  }
}
const RetainedContentFields = {
  object_id: Identity,
  sha256: Hash,
  bytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
}
export const ResourceContentSchema = Schema.Struct({
  ...RetainedContentFields,
  kind: Schema.Literal("resource"),
  mode: Schema.NullOr(Schema.Literals(["100644", "100755"])),
})
export type ResourceContent = typeof ResourceContentSchema.Type
export const RetainedContentSchema = Schema.Union([
  ResourceContentSchema,
  Schema.Struct({
    ...RetainedContentFields,
    kind: Schema.optionalKey(Schema.Never),
    ...NativeFileMetadataFields,
  }),
])
export type RetainedContent = typeof RetainedContentSchema.Type
export function isResourceContent(content: RetainedContent): content is ResourceContent {
  return content.kind === "resource"
}
export const ResourceFollowingOwnershipSchema = Schema.Struct({
  kind: Schema.Literal("following"),
  source_revision: Identity,
  source_id: Identity,
  source_path: Schema.String,
  resource: ResourceContentSchema,
  projection: Schema.optionalKey(Schema.Never),
})
export type ResourceFollowingOwnership = typeof ResourceFollowingOwnershipSchema.Type

/** These are shared facts, not a status checkbox or a local cache observation. */
export const FileOwnershipSchema = Schema.Union([
  ResourceFollowingOwnershipSchema,
  Schema.Struct({
    kind: Schema.Literal("following"),
    source_revision: Identity,
    projection: BodyFingerprintSchema,
    ...NativeFileMetadataFields,
    resource: Schema.optionalKey(Schema.Never),
    source_id: Schema.optionalKey(Schema.Never),
    source_path: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({ kind: Schema.Literal("custom"), content: RetainedContentSchema }),
  Schema.Struct({ kind: Schema.Literal("tombstone"), retained: RetainedContentSchema }),
])
export type FileOwnership = typeof FileOwnershipSchema.Type
export function nativeMetadataForOwnership(
  ownership: FileOwnership | undefined,
): NativeFileMetadata {
  if (ownership === undefined || resourceContentForOwnership(ownership) !== undefined) return {}
  if (isResourceFollowing(ownership)) return {}
  return nativeFileMetadata(
    ownership.kind === "following"
      ? ownership
      : ownership.kind === "custom"
        ? ownership.content
        : ownership.retained,
  )
}
export function isResourceFollowing(
  ownership: FileOwnership,
): ownership is ResourceFollowingOwnership {
  return ownership.kind === "following" && ownership.resource !== undefined
}
/** Resource classification is a shared ownership fact, never a path or page-body guess. */
export function resourceContentForOwnership(ownership: FileOwnership): ResourceContent | undefined {
  if (isResourceFollowing(ownership)) return ownership.resource
  const content =
    ownership.kind === "custom"
      ? ownership.content
      : ownership.kind === "tombstone"
        ? ownership.retained
        : undefined
  return content !== undefined && isResourceContent(content) ? content : undefined
}

const Common = {
  event_id: Identity,
  file_id: Identity,
  parents: Schema.Array(Identity),
}
export const ResourceFollowingEventSchema = Schema.Struct({
  ...Common,
  kind: Schema.Literal("resource_followed"),
  source_id: Identity,
  source_revision: Identity,
  path: Schema.String,
  source_path: Schema.String,
  content: ResourceContentSchema,
  retained: Schema.NullOr(ResourceContentSchema),
})
export type ResourceFollowingEvent = typeof ResourceFollowingEventSchema.Type
export const FileEventSchema = Schema.Union([
  ResourceFollowingEventSchema,
  Schema.Struct({
    ...Common,
    kind: Schema.Literal("projected"),
    source_revision: Identity,
    projection: BodyFingerprintSchema,
    ...NativeFileMetadataFields,
  }),
  Schema.Struct({ ...Common, kind: Schema.Literal("adopted"), content: RetainedContentSchema }),
  Schema.Struct({
    ...Common,
    kind: Schema.Literal("following_restored"),
    source_revision: Identity,
    projection: BodyFingerprintSchema,
    retained: RetainedContentSchema,
    ...NativeFileMetadataFields,
  }),
  Schema.Struct({ ...Common, kind: Schema.Literal("deleted"), retained: RetainedContentSchema }),
  Schema.Struct({
    ...Common,
    kind: Schema.Literal("moved"),
    from_path: Schema.String,
    to_path: Schema.String,
    source_path: Schema.NullOr(Schema.String),
    suppressed_paths: Schema.Array(Schema.String),
    retained: RetainedContentSchema,
  }),
])
export type FileEvent = typeof FileEventSchema.Type
export interface FilePlacement {
  readonly path: string
  readonly source_path: string | null
  readonly suppressed_paths: readonly string[]
}
export interface ResolvedFileState {
  readonly file_id: string
  readonly heads: readonly string[]
  readonly ownership: FileOwnership
  readonly placement?: FilePlacement
}

/** Preserve whitespace, code, links and instructions. Only transport newlines normalize. */
export function normalizeObservedBody(markdown: string, version: 1 = 1): string {
  if (version !== 1) throw fail("NORMALIZATION_UNSUPPORTED", "Unknown body normalization version.")
  if (/<unknown(?:\s|\/?>)/i.test(markdown))
    throw fail("BODY_INCOMPLETE", "Notion returned unsupported or unavailable body content.")
  return markdown.replace(/\r\n/g, "\n")
}

function stateAfter(event: FileEvent, parents: readonly FileOwnership[] = []): FileOwnership {
  switch (event.kind) {
    case "resource_followed":
      return {
        kind: "following",
        source_id: event.source_id,
        source_revision: event.source_revision,
        source_path: event.source_path,
        resource: event.content,
      }
    case "projected":
    case "following_restored":
      return {
        kind: "following",
        source_revision: event.source_revision,
        projection: event.projection,
        ...nativeFileMetadata(event),
      }
    case "adopted":
      return { kind: "custom", content: event.content }
    case "deleted":
      return { kind: "tombstone", retained: event.retained }
    case "moved": {
      const parent = parents[0]
      if (
        parent === undefined ||
        parent.kind === "tombstone" ||
        parents.some((value) => !sameOwnership(parent, value))
      )
        throw fail(
          "OWNERSHIP_TRANSITION_INVALID",
          "Moving requires compatible active parent ownership; a path change cannot release customization or restore a deletion.",
        )
      return parent
    }
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}

function placementPath(value: string): string {
  if (
    value === "" ||
    value === "." ||
    normalizePath(value) !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
    throw fail("SHARED_PATH_INVALID", "A shared file placement requires canonical relative paths.")
  return value
}
function samePlacement(left: FilePlacement | undefined, right: FilePlacement | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}
function placementAfter(
  event: FileEvent,
  parents: readonly (FilePlacement | undefined)[],
  ownership: FileOwnership,
): FilePlacement | undefined {
  const previous = parents[0]
  if (parents.some((value) => !samePlacement(previous, value)))
    throw fail(
      "SHARED_PATH_CONFLICT",
      "The file's parent events have incompatible logical placements; a body edit cannot choose a path winner.",
    )
  if (event.kind === "resource_followed") {
    const path = placementPath(event.path),
      source = placementPath(event.source_path)
    if (previous !== undefined && previous.path !== path)
      throw fail(
        "SHARED_PATH_CONFLICT",
        "Following a raw source cannot silently move its logical file.",
      )
    return { path, source_path: source, suppressed_paths: previous?.suppressed_paths ?? [] }
  }
  if (event.kind !== "moved") return previous
  const from = placementPath(event.from_path),
    to = placementPath(event.to_path)
  if (from === to || (previous !== undefined && previous.path !== from))
    throw fail("SHARED_PATH_CONFLICT", "A move must continue from its exact prior logical path.")
  const source = event.source_path === null ? null : placementPath(event.source_path)
  if (
    (previous !== undefined && previous.source_path !== source) ||
    (previous === undefined && source !== null && source !== from) ||
    (ownership.kind === "following" && source === null)
  )
    throw fail(
      "SHARED_PATH_CONFLICT",
      "A move must preserve its original source path independently of its logical destination.",
    )
  const suppressed = [
    ...new Set([...(previous?.suppressed_paths ?? []), from, ...(source === null ? [] : [source])]),
  ]
    .filter((path) => path !== to)
    .sort()
  if (JSON.stringify(event.suppressed_paths) !== JSON.stringify(suppressed))
    throw fail(
      "SHARED_PATH_INVALID",
      "The move's explicit old-path suppression does not match its complete path history.",
    )
  return { path: to, source_path: source, suppressed_paths: suppressed }
}

function contentEqual(left: RetainedContent, right: RetainedContent): boolean {
  if (isResourceContent(left) || isResourceContent(right))
    return (
      isResourceContent(left) &&
      isResourceContent(right) &&
      left.sha256 === right.sha256 &&
      left.bytes === right.bytes &&
      left.mode === right.mode &&
      left.object_id === right.object_id
    )
  return (
    left.sha256 === right.sha256 &&
    left.bytes === right.bytes &&
    left.mode === right.mode &&
    left.frontmatter === right.frontmatter
  )
}
function sameOwnership(left: FileOwnership, right: FileOwnership): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case "following":
      if (isResourceFollowing(left))
        return (
          isResourceFollowing(right) &&
          left.source_id === right.source_id &&
          left.source_revision === right.source_revision &&
          left.source_path === right.source_path &&
          contentEqual(left.resource, right.resource)
        )
      return (
        right.kind === "following" &&
        !isResourceFollowing(right) &&
        left.source_revision === right.source_revision &&
        left.projection.normalization_version === right.projection.normalization_version &&
        left.projection.sha256 === right.projection.sha256 &&
        left.mode === right.mode &&
        left.frontmatter === right.frontmatter
      )
    case "custom":
      return right.kind === "custom" && contentEqual(left.content, right.content)
    case "tombstone":
      return right.kind === "tombstone" && contentEqual(left.retained, right.retained)
  }
}

/**
 * Rebuild from the complete Notion event set. Concurrent incompatible heads fail
 * closed. This detects conflicts; it is deliberately not a compare-and-swap lock.
 */
export function resolveFileState(fileId: string, input: readonly unknown[]): ResolvedFileState {
  const events = new Map<string, FileEvent>()
  for (const raw of input) {
    const event = decode(FileEventSchema, raw)
    if (event.file_id !== fileId)
      throw fail("SHARED_STATE_SCOPE", "A file event belongs to a different stable file.")
    if (
      new Set(event.parents).size !== event.parents.length ||
      event.parents.includes(event.event_id)
    )
      throw fail(
        "SHARED_STATE_INVALID",
        "A file event contains repeated or self-referential parents.",
      )
    const previous = events.get(event.event_id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(event))
      throw fail("SHARED_STATE_CONFLICT", "One event identity has different immutable payloads.", {
        event_id: event.event_id,
      })
    events.set(event.event_id, event)
  }
  if (!events.size)
    throw fail("BASELINE_MISSING", "No shared file baseline exists; preserve the current body.")
  const visited = new Set<string>(),
    visiting = new Set<string>(),
    superseded = new Set<string>()
  const ownershipByEvent = new Map<string, FileOwnership>()
  const placementByEvent = new Map<string, FilePlacement | undefined>()
  const visit = (event: FileEvent): void => {
    if (visited.has(event.event_id)) return
    if (visiting.has(event.event_id))
      throw fail("SHARED_STATE_INVALID", "File events contain a cycle.")
    visiting.add(event.event_id)
    const parents: FileEvent[] = []
    for (const id of event.parents) {
      const parent = events.get(id)
      if (!parent)
        throw fail("SHARED_STATE_INCOMPLETE", "A shared event parent is unavailable.", {
          event_id: event.event_id,
          parent: id,
        })
      visit(parent)
      parents.push(parent)
      superseded.add(id)
    }
    const parentStates = parents.map((parent) => {
      const state = ownershipByEvent.get(parent.event_id)
      if (state === undefined)
        throw fail("SHARED_STATE_INVALID", "A resolved parent has no ownership state.")
      return state
    })
    if (
      event.kind === "projected" &&
      parentStates.some((parent) => parent.kind !== "following" || isResourceFollowing(parent))
    )
      throw fail(
        "OWNERSHIP_TRANSITION_INVALID",
        "A projection cannot release customization or a tombstone.",
      )
    if (
      (event.kind === "following_restored" || event.kind === "deleted" || event.kind === "moved") &&
      !parents.length
    )
      throw fail(
        "OWNERSHIP_TRANSITION_INVALID",
        "Restoring, deleting or moving requires shared prior state.",
      )
    if (event.kind === "following_restored") {
      if (
        isResourceContent(event.retained) ||
        parentStates.some((state) => resourceContentForOwnership(state) !== undefined)
      )
        throw fail(
          "SHARED_RESOURCE_FOLLOWING_UNSUPPORTED",
          "A raw resource requires an explicit source-byte following contract; its management page is not a Markdown projection.",
        )
      for (const state of parentStates) {
        const retained =
          state.kind === "custom"
            ? state.content
            : state.kind === "tombstone"
              ? state.retained
              : undefined
        if (retained && !contentEqual(event.retained, retained))
          throw fail(
            "OWNERSHIP_TRANSITION_INVALID",
            "Restoring follow must retain the exact custom version.",
          )
      }
    }
    if (event.kind === "resource_followed") {
      if ((parents.length === 0) !== (event.retained === null))
        throw fail(
          "OWNERSHIP_TRANSITION_INVALID",
          "Raw following must retain its prior ownership, or declare one initial source baseline.",
        )
      for (const state of parentStates) {
        const content = resourceContentForOwnership(state)
        if (
          content === undefined ||
          event.retained === null ||
          !contentEqual(event.retained, content)
        )
          throw fail(
            "OWNERSHIP_TRANSITION_INVALID",
            "Following a raw source must preserve the exact prior retained resource.",
          )
      }
    }
    if (event.kind === "deleted" || event.kind === "moved") {
      for (const state of parentStates) {
        const retained =
          state.kind === "custom"
            ? state.content
            : state.kind === "tombstone"
              ? state.retained
              : undefined
        if (
          (retained !== undefined && !contentEqual(event.retained, retained)) ||
          (state.kind === "following" &&
            (isResourceFollowing(state)
              ? !isResourceContent(event.retained)
              : event.retained.sha256 !== state.projection.sha256 ||
                JSON.stringify(nativeFileMetadata(event.retained)) !==
                  JSON.stringify(nativeFileMetadata(state))))
        )
          throw fail(
            "OWNERSHIP_TRANSITION_INVALID",
            "Deleting or moving must retain the complete previously observed body.",
          )
      }
    }
    if (
      event.kind === "adopted" &&
      parentStates.some(
        (state) =>
          isResourceContent(event.content) !== (resourceContentForOwnership(state) !== undefined),
      )
    )
      throw fail(
        "SHARED_RESOURCE_NOT_EDITABLE",
        "Raw resources and editable bodies cannot implicitly change representation.",
      )
    const ownership = stateAfter(event, parentStates)
    ownershipByEvent.set(event.event_id, ownership)
    placementByEvent.set(
      event.event_id,
      placementAfter(
        event,
        parents.map((parent) => placementByEvent.get(parent.event_id)),
        ownership,
      ),
    )
    visiting.delete(event.event_id)
    visited.add(event.event_id)
  }
  for (const event of events.values()) visit(event)
  const heads = [...events.values()]
    .filter((event) => !superseded.has(event.event_id))
    .sort((a, b) => a.event_id.localeCompare(b.event_id))
  const head = heads[0]
  if (!head) throw fail("SHARED_STATE_INVALID", "Shared file state has no head.")
  const ownership = ownershipByEvent.get(head.event_id)
  if (ownership === undefined)
    throw fail("SHARED_STATE_INVALID", "The shared file head has no resolved ownership.")
  if (
    heads.some((event) => {
      const other = ownershipByEvent.get(event.event_id)
      return other === undefined || !sameOwnership(ownership, other)
    })
  )
    throw fail(
      "SHARED_STATE_CONFLICT",
      "Concurrent file changes require an explicit resolution; all candidates are retained.",
      {
        file_id: fileId,
        heads: heads.map((event) => event.event_id),
      },
    )
  const placement = placementByEvent.get(head.event_id)
  if (heads.some((event) => !samePlacement(placement, placementByEvent.get(event.event_id))))
    throw fail(
      "SHARED_PATH_CONFLICT",
      "Concurrent file events have incompatible logical paths; all original candidates remain available.",
      { file_id: fileId, heads: heads.map((event) => event.event_id) },
    )
  return {
    file_id: fileId,
    heads: heads.map((event) => event.event_id),
    ownership,
    ...(placement === undefined ? {} : { placement }),
  }
}

export type BodyDecision =
  | { readonly kind: "unchanged" }
  | { readonly kind: "adopt"; readonly previous: "following" | "custom" }
  | { readonly kind: "deleted" }

/** Metadata timestamps only decide whether to observe, never who owns content. */
export function decideObservedBody(state: FileOwnership, observed: BodyFingerprint): BodyDecision {
  if (resourceContentForOwnership(state) !== undefined)
    throw fail(
      "SHARED_RESOURCE_NOT_EDITABLE",
      "Resource ownership never observes its management page as an editable body.",
    )
  if (state.kind === "tombstone") return { kind: "deleted" }
  if (state.kind === "custom")
    return state.content.sha256 === observed.sha256
      ? { kind: "unchanged" }
      : { kind: "adopt", previous: "custom" }
  if (state.projection === undefined)
    throw fail(
      "SHARED_RESOURCE_NOT_EDITABLE",
      "A raw following resource has no Markdown projection.",
    )
  if (state.projection.normalization_version !== observed.normalization_version)
    throw fail(
      "BASELINE_VERSION_MISMATCH",
      "Re-observe with the saved normalization rule before changing ownership.",
    )
  return state.projection.sha256 === observed.sha256
    ? { kind: "unchanged" }
    : { kind: "adopt", previous: "following" }
}

/**
 * A content search match is not a page revision precondition. The public Notion
 * contract also makes is_locked UI-only. Keep preparation independent of this
 * unsupported automatic overwrite capability.
 * https://developers.notion.com/reference/update-page-markdown
 * https://developers.notion.com/reference/patch-page
 */
export const notionWriteCapabilities = Object.freeze({
  conditional_body_replace: false,
  explicit_source_restore: Object.freeze({
    kind: "single_full_body_match",
    conditional_body_replace: false,
    nonempty_complete_old_body: true,
    exact_postcondition_required: true,
    automatic_retry: false,
  }),
  editable_projection_overwrite: Object.freeze({
    kind: "unsupported",
    provider: "notion",
    operation: "overwrite_editable_projection",
    reason: "atomic_content_precondition_unavailable",
    editing_isolation: "unverified",
    preparation_allowed: true,
    automatic_retry: false,
    content_match_is_revision_cas: false,
    ui_lock_blocks_api_writers: false,
  }),
} as const)

/** Current Notion has no atomic body precondition. Do not overwrite an editable page. */
export function requireSafeBodyReplacement(input: {
  readonly existing_editable_page: boolean
  readonly operation_id: string
  readonly retained_candidate_id: string
}): void {
  if (input.existing_editable_page)
    throw fail(
      "BODY_REPLACEMENT_UNSAFE",
      "The provider cannot conditionally replace an editable page. The candidate and operation remain available; no body was overwritten.",
      {
        operation_id: input.operation_id,
        candidate_id: input.retained_candidate_id,
        conditional_body_replace: notionWriteCapabilities.conditional_body_replace,
        capability: notionWriteCapabilities.editable_projection_overwrite,
      },
    )
}
