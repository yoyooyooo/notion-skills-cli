import { Schema } from "effect"
import { decode, fail } from "./model.ts"

const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/))
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const BodyFingerprintSchema = Schema.Struct({
  normalization_version: Schema.Literal(1),
  sha256: Hash,
})
export type BodyFingerprint = typeof BodyFingerprintSchema.Type
export const RetainedContentSchema = Schema.Struct({
  object_id: Identity,
  sha256: Hash,
  bytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
})
export type RetainedContent = typeof RetainedContentSchema.Type

/** These are shared facts, not a status checkbox or a local cache observation. */
export const FileOwnershipSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("following"),
    source_revision: Identity,
    projection: BodyFingerprintSchema,
  }),
  Schema.Struct({ kind: Schema.Literal("custom"), content: RetainedContentSchema }),
  Schema.Struct({ kind: Schema.Literal("tombstone"), retained: RetainedContentSchema }),
])
export type FileOwnership = typeof FileOwnershipSchema.Type

const Common = {
  event_id: Identity,
  file_id: Identity,
  parents: Schema.Array(Identity),
}
export const FileEventSchema = Schema.Union([
  Schema.Struct({
    ...Common,
    kind: Schema.Literal("projected"),
    source_revision: Identity,
    projection: BodyFingerprintSchema,
  }),
  Schema.Struct({ ...Common, kind: Schema.Literal("adopted"), content: RetainedContentSchema }),
  Schema.Struct({
    ...Common,
    kind: Schema.Literal("following_restored"),
    source_revision: Identity,
    projection: BodyFingerprintSchema,
    retained: RetainedContentSchema,
  }),
  Schema.Struct({ ...Common, kind: Schema.Literal("deleted"), retained: RetainedContentSchema }),
])
export type FileEvent = typeof FileEventSchema.Type
export interface ResolvedFileState {
  readonly file_id: string
  readonly heads: readonly string[]
  readonly ownership: FileOwnership
}

/** Preserve whitespace, code, links and instructions. Only transport newlines normalize. */
export function normalizeObservedBody(markdown: string, version: 1 = 1): string {
  if (version !== 1) throw fail("NORMALIZATION_UNSUPPORTED", "Unknown body normalization version.")
  if (/<unknown(?:\s|\/?>)/i.test(markdown))
    throw fail("BODY_INCOMPLETE", "Notion returned unsupported or unavailable body content.")
  return markdown.replace(/\r\n/g, "\n")
}

function stateAfter(event: FileEvent): FileOwnership {
  switch (event.kind) {
    case "projected":
    case "following_restored":
      return {
        kind: "following",
        source_revision: event.source_revision,
        projection: event.projection,
      }
    case "adopted":
      return { kind: "custom", content: event.content }
    case "deleted":
      return { kind: "tombstone", retained: event.retained }
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}

function contentEqual(left: RetainedContent, right: RetainedContent): boolean {
  return left.sha256 === right.sha256 && left.bytes === right.bytes
}
function sameOwnership(left: FileOwnership, right: FileOwnership): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case "following":
      return (
        right.kind === "following" &&
        left.source_revision === right.source_revision &&
        left.projection.normalization_version === right.projection.normalization_version &&
        left.projection.sha256 === right.projection.sha256
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
    if (
      event.kind === "projected" &&
      parents.some((parent) => parent.kind !== "projected" && parent.kind !== "following_restored")
    )
      throw fail(
        "OWNERSHIP_TRANSITION_INVALID",
        "A projection cannot release customization or a tombstone.",
      )
    if ((event.kind === "following_restored" || event.kind === "deleted") && !parents.length)
      throw fail(
        "OWNERSHIP_TRANSITION_INVALID",
        "Restoring or deleting requires shared prior state.",
      )
    if (event.kind === "following_restored") {
      for (const parent of parents) {
        const state = stateAfter(parent)
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
    visiting.delete(event.event_id)
    visited.add(event.event_id)
  }
  for (const event of events.values()) visit(event)
  const heads = [...events.values()]
    .filter((event) => !superseded.has(event.event_id))
    .sort((a, b) => a.event_id.localeCompare(b.event_id))
  const head = heads[0]
  if (!head) throw fail("SHARED_STATE_INVALID", "Shared file state has no head.")
  const ownership = stateAfter(head)
  if (heads.some((event) => !sameOwnership(ownership, stateAfter(event))))
    throw fail(
      "SHARED_STATE_CONFLICT",
      "Concurrent file changes require an explicit resolution; all candidates are retained.",
      {
        file_id: fileId,
        heads: heads.map((event) => event.event_id),
      },
    )
  return { file_id: fileId, heads: heads.map((event) => event.event_id), ownership }
}

export type BodyDecision =
  | { readonly kind: "unchanged" }
  | { readonly kind: "adopt"; readonly previous: "following" | "custom" }
  | { readonly kind: "deleted" }

/** Metadata timestamps only decide whether to observe, never who owns content. */
export function decideObservedBody(state: FileOwnership, observed: BodyFingerprint): BodyDecision {
  if (state.kind === "tombstone") return { kind: "deleted" }
  if (state.kind === "custom")
    return state.content.sha256 === observed.sha256
      ? { kind: "unchanged" }
      : { kind: "adopt", previous: "custom" }
  if (state.projection.normalization_version !== observed.normalization_version)
    throw fail(
      "BASELINE_VERSION_MISMATCH",
      "Re-observe with the saved normalization rule before changing ownership.",
    )
  return state.projection.sha256 === observed.sha256
    ? { kind: "unchanged" }
    : { kind: "adopt", previous: "following" }
}

export const notionWriteCapabilities = { conditional_body_replace: false } as const

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
      },
    )
}
