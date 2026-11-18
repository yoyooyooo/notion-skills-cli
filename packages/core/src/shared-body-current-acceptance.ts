import { Clock, Effect, Schema } from "effect"
import { fail, property } from "./model.ts"
import { Notion } from "./notion.ts"
import {
  bodyWriteChecked as checked,
  bodyWriteOutcomeId,
  SharedBodyWritePlanSchema,
  validateSharedBodyWritePlan,
  type SharedBodyWritePlan,
} from "./shared-body-write-model.ts"
import {
  FileEventSchema,
  nativeFileMetadata,
  normalizeObservedBody,
  resolveFileState,
  type FileEvent,
  type ResolvedFileState,
} from "./shared-file-state.ts"
import { readSharedFileSourceContext } from "./shared-file-source-context.ts"
import { sharedFileSourcePath } from "./shared-file-placement.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import type { SharedOperationHeader } from "./shared-operation-index.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  validateSharedRecordEnvelope,
} from "./shared-records.ts"
import { querySharedSkillIndex, type SharedSkillIndex } from "./shared-skill-index.ts"
import { storedSharedOperationPlan } from "./shared-plan-storage.ts"
import { resolveSelectedSharedSourceReference } from "./shared-selected-source.ts"
import { sha256, Store } from "./store.ts"
import { parseYaml } from "./yaml.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Response = Schema.Struct({
  id: Schema.String,
  markdown: Schema.String,
  truncated: Schema.Boolean,
  unknown_block_ids: Schema.Array(Schema.String),
  warnings: Schema.optional(Schema.Array(Schema.Unknown)),
})
const Decision = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("body_write_current_acceptance"),
  operation_id: Schema.String,
  original_operation_id: Schema.String,
  original_plan_sha256: Hash,
  original_write_outcome: Schema.Literal("unknown"),
  decision: Schema.Literal("accepted_current"),
  library_id: Schema.String,
  skill_page_id: Schema.String,
  skill_id: Schema.String,
  file_id: Schema.String,
  page_id: Schema.String,
  event_sha256: Hash,
  accepted_observed_sha256: Hash,
  candidate_sha256: Hash,
  observation_basis: Schema.Literal("post_failure_current_read"),
  response: Response,
})
const Dispatch = Schema.Struct({
  version: Schema.Literal(1),
  scope: Hash,
  original: SharedBodyWritePlanSchema,
  decision: Decision,
})
type Acceptance = typeof Decision.Type

function identity(original: SharedBodyWritePlan) {
  return sha256(
    canonicalSharedJson([1, "body_write_current_acceptance", original.operation_id]),
  ).pipe(Effect.map((hash) => `accept-current-${hash}`))
}

function originalHash(original: SharedBodyWritePlan) {
  return sha256(
    canonicalSharedJson({ version: 1, operation_id: original.operation_id, payload: original }),
  )
}

function unchangedBodyRestore(original: SharedBodyWritePlan) {
  return (
    original.action === "restore_follow" &&
    original.event.kind === "following_restored" &&
    original.restore_source !== undefined &&
    original.source_context !== undefined &&
    original.candidate.content.kind !== "resource" &&
    original.before.fingerprint.sha256 === original.candidate.content.sha256 &&
    original.before.bytes === original.candidate.content.bytes &&
    original.before.markdown === original.candidate.markdown &&
    canonicalSharedJson(nativeFileMetadata(original.candidate.content)) ===
      canonicalSharedJson(nativeFileMetadata(original.event))
  )
}

function completeResponse(input: unknown, original: SharedBodyWritePlan) {
  return Effect.gen(function* () {
    const response = yield* checked(() => Schema.decodeUnknownSync(Response)(input))
    if (
      response.id !== original.page_id ||
      response.truncated ||
      response.unknown_block_ids.length !== 0 ||
      (response.warnings?.length ?? 0) !== 0
    )
      return yield* Effect.fail(
        fail(
          "SHARED_CURRENT_ACCEPTANCE_INCOMPLETE",
          "Acceptance requires a complete warning-free response for the exact original page.",
        ),
      )
    if (
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        new TextEncoder().encode(response.markdown),
      ) !== response.markdown
    )
      return yield* Effect.fail(
        fail(
          "SHARED_CURRENT_ACCEPTANCE_INCOMPLETE",
          "The complete response must round-trip as exact UTF-8 bytes.",
        ),
      )
    const normalized = yield* checked(() => normalizeObservedBody(response.markdown))
    if (
      (yield* sha256(normalized)) !== original.candidate.content.sha256 ||
      new TextEncoder().encode(normalized).byteLength !== original.candidate.content.bytes ||
      (original.action === "restore_follow" && response.markdown !== original.before.raw_markdown)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_CURRENT_ACCEPTANCE_STALE",
          "The current complete body differs from the original frozen candidate.",
        ),
      )
    return response
  })
}

function eventsFor(library: SharedLibrary, original: SharedBodyWritePlan) {
  return Effect.gen(function* () {
    const rows = yield* querySharedRecords(library, {
      kind: "file_event",
      skillPageId: original.skill_page_id,
      entityId: original.file_id,
    })
    return yield* checked(() =>
      rows.map((row) => {
        const event = Schema.decodeUnknownSync(FileEventSchema)(row.payload, {
          onExcessProperty: "error",
        })
        if (
          row.record_id !== event.event_id ||
          row.operation_id !== event.event_id ||
          row.entity_id !== original.file_id ||
          event.file_id !== original.file_id
        )
          throw fail(
            "SHARED_CURRENT_ACCEPTANCE_INVALID",
            "The recorded file event identity is inconsistent.",
          )
        return event
      }),
    )
  })
}

function verifyEvent(
  original: SharedBodyWritePlan,
  events: readonly FileEvent[],
  current: boolean,
) {
  const selected = events.filter((event) => event.file_id === original.file_id)
  const accepted = selected.find((event) => event.event_id === original.event.event_id)
  if (
    !(
      (original.action === "write" && original.event.kind === "adopted") ||
      unchangedBodyRestore(original)
    ) ||
    accepted === undefined ||
    canonicalSharedJson(accepted) !== canonicalSharedJson(original.event)
  )
    throw fail(
      "SHARED_CURRENT_ACCEPTANCE_INELIGIBLE",
      "The exact original adopted event or unchanged-body following restoration must already exist; acceptance never creates a missing event or completes the original operation.",
    )
  const state = resolveFileState(original.file_id, selected)
  const ownership =
    original.event.kind === "following_restored"
      ? {
          kind: "following",
          source_revision: original.event.source_revision,
          projection: original.event.projection,
          ...nativeFileMetadata(original.event),
        }
      : { kind: "custom", content: original.candidate.content }
  if (
    current &&
    (canonicalSharedJson(state.heads) !== canonicalSharedJson([original.event.event_id]) ||
      canonicalSharedJson(state.ownership) !== canonicalSharedJson(ownership))
  )
    throw fail(
      "SHARED_CURRENT_ACCEPTANCE_STALE",
      "The complete current frontier no longer consists of the original accepted event.",
    )
  return state
}

function verifyRestoreSource(
  library: SharedLibrary,
  original: SharedBodyWritePlan,
  state: ResolvedFileState,
  index: SharedSkillIndex,
) {
  return Effect.gen(function* () {
    if (original.action !== "restore_follow") return
    if (original.file_id === index.main.file_id) {
      const header = nativeFileMetadata(original.candidate.content).frontmatter
      const match =
        header === undefined ? null : /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(header)
      const metadata = yield* checked(() =>
        property(match === null ? undefined : parseYaml(match[1] ?? "")),
      )
      if (
        match === null ||
        metadata.name !== index.name ||
        metadata.description !== index.description
      )
        return yield* Effect.fail(
          fail(
            "SHARED_CURRENT_ACCEPTANCE_STALE",
            "The current native main header differs from the complete frozen restore header.",
          ),
        )
    }
    const source = original.restore_source
    const context = yield* readSharedFileSourceContext(library, original.skill_page_id)
    if (
      source === undefined ||
      canonicalSharedJson(context) !== canonicalSharedJson(original.source_context)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_CURRENT_ACCEPTANCE_STALE",
          "The complete Source definition, selected version or member differs from the original restore plan.",
        ),
      )
    const selected = yield* resolveSelectedSharedSourceReference(library, {
      skillPageId: original.skill_page_id,
      sourceId: original.source_id,
    })
    const path = yield* checked(() => sharedFileSourcePath(original.path, state))
    if (
      selected.revision !== source.revision ||
      path !== source.path ||
      !selected.paths.includes(path)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_CURRENT_ACCEPTANCE_STALE",
          "The fixed Source revision or file path differs from the original restore plan.",
        ),
      )
  })
}

function validateDecision(input: unknown, original: SharedBodyWritePlan) {
  return Effect.gen(function* () {
    const value = yield* checked(() =>
      Schema.decodeUnknownSync(Decision)(input, { onExcessProperty: "error" }),
    )
    const response = yield* completeResponse(value.response, original)
    if (
      value.operation_id !== (yield* identity(original)) ||
      value.original_operation_id !== original.operation_id ||
      value.original_plan_sha256 !== (yield* originalHash(original)) ||
      value.library_id !== original.library_id ||
      value.skill_page_id !== original.skill_page_id ||
      value.skill_id !== original.skill_id ||
      value.file_id !== original.file_id ||
      value.page_id !== original.page_id ||
      value.event_sha256 !== (yield* sha256(canonicalSharedJson(original.event))) ||
      value.candidate_sha256 !== original.candidate.content.sha256 ||
      value.accepted_observed_sha256 !== (yield* sha256(response.markdown))
    )
      return yield* Effect.fail(
        fail(
          "SHARED_CURRENT_ACCEPTANCE_INVALID",
          "The current acceptance differs from its exact original plan, event or observed bytes.",
        ),
      )
    yield* checked(() => validateSharedRecordEnvelope(value.operation_id, value))
    return value
  })
}

function reviewed(value: Acceptance, original: SharedBodyWritePlan) {
  return {
    status: "reviewed" as const,
    decision: "accepted_current" as const,
    operation_id: value.operation_id,
    original_operation_id: original.operation_id,
    original_status: "unknown" as const,
    original_write_outcome: "unknown" as const,
    observation_basis: "post_failure_current_read" as const,
    accepted_observed_sha256: value.accepted_observed_sha256,
    content_sha256: value.candidate_sha256,
    event: original.event,
    verified: true as const,
    requires_fresh_read: true as const,
  }
}

/** An independent decision, never evidence that the original write or restore completed. */
export function completedSharedBodyCurrentAcceptance(
  library: SharedLibrary,
  original: SharedBodyWritePlan,
  observed?: {
    readonly headers: readonly SharedOperationHeader[]
    readonly events: readonly FileEvent[]
  },
) {
  return Effect.gen(function* () {
    const id = yield* identity(original)
    const header = observed?.headers.find((value) => value.record_id === id)
    if (observed !== undefined && header === undefined) return undefined
    const rows = yield* querySharedRecords(library, {
      kind: "operation",
      skillPageId: original.skill_page_id,
      entityId: original.file_id,
      recordId: id,
      payloadContainsBody: true,
    })
    const row = rows[0]
    if (rows.length === 0 && header === undefined) return undefined
    if (
      rows.length !== 1 ||
      row === undefined ||
      row.record_id !== id ||
      row.operation_id !== id ||
      row.entity_id !== original.file_id ||
      (header !== undefined && header.hash !== row.hash)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_CURRENT_ACCEPTANCE_UNRESOLVED",
          "The indexed acceptance is unavailable or inconsistent; the original fence remains.",
        ),
      )
    const decision = yield* validateDecision(row.payload, original)
    const events = observed?.events ?? (yield* eventsFor(library, original))
    yield* checked(() => verifyEvent(original, events, false))
    return reviewed(decision, original)
  })
}

/** A current-version proof, distinct from the historical independent decision. */
export function observeSharedBodyCurrentAcceptance(
  library: SharedLibrary,
  original: SharedBodyWritePlan,
  observed: {
    readonly index: SharedSkillIndex
    readonly headers: readonly SharedOperationHeader[]
    readonly events: readonly FileEvent[]
  },
) {
  return Effect.gen(function* () {
    const acceptance = yield* completedSharedBodyCurrentAcceptance(library, original, observed)
    if (acceptance === undefined) return undefined
    const { index } = observed
    const binding = [index.main, ...index.files].find((item) => item.file_id === original.file_id)
    if (
      index.page_id !== original.skill_page_id ||
      index.skill_id !== original.skill_id ||
      index.source_reference !== original.source_id ||
      binding?.page_id !== original.page_id ||
      binding.path !== original.path
    )
      return yield* Effect.fail(
        fail(
          "SHARED_CURRENT_ACCEPTANCE_STALE",
          "The accepted current file binding or Source changed.",
        ),
      )
    const state = yield* checked(() => verifyEvent(original, observed.events, true))
    yield* verifyRestoreSource(library, original, state, index)
    const response = yield* completeResponse(
      yield* (yield* Notion).request(`v1/pages/${original.page_id}/markdown?markdown_version=v2`),
      original,
    )
    if ((yield* sha256(response.markdown)) !== acceptance.accepted_observed_sha256)
      return yield* Effect.fail(
        fail(
          "SHARED_CURRENT_ACCEPTANCE_STALE",
          "The current exact body differs from the independently accepted observation.",
        ),
      )
    const markdown = normalizeObservedBody(response.markdown)
    return {
      acceptance,
      observation: {
        changed: false as const,
        state: yield* checked(() =>
          resolveFileState(
            original.file_id,
            observed.events.filter((event) => event.file_id === original.file_id),
          ),
        ),
        body: {
          page_id: original.page_id,
          markdown,
          fingerprint: {
            normalization_version: 1 as const,
            sha256: original.candidate.content.sha256,
          },
          bytes: original.candidate.content.bytes,
          downloaded_at: yield* Clock.currentTimeMillis,
        },
      },
    }
  })
}

export function acceptCurrentSharedBodyWrite(input: {
  readonly library: SharedLibrary
  readonly skillPageId: string
  readonly originalOperationId: string
  readonly acceptedObservedSha256: string
  readonly scope: string
  readonly dryRun: boolean
  readonly mode: "create" | "reconcile"
}) {
  return Effect.gen(function* () {
    const { library } = input
    const rows = yield* querySharedRecords(library, {
      kind: "operation",
      skillPageId: input.skillPageId,
      recordId: input.originalOperationId,
      payloadContainsBody: true,
    })
    const row = rows[0]
    if (rows.length !== 1 || row === undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_CURRENT_ACCEPTANCE_INELIGIBLE",
          "The exact original body-write plan is unavailable.",
        ),
      )
    const original = yield* validateSharedBodyWritePlan(row.payload)
    // Validate the actual retained representation. A legal complete legacy
    // payload keeps its own envelope hash; a derived payload must exactly
    // match the supported encoding of the independently validated full plan.
    const stored =
      canonicalSharedJson(row.payload) === canonicalSharedJson(original)
        ? original
        : storedSharedOperationPlan(original)
    const storedHash = yield* sha256(
      canonicalSharedJson({ version: 1, operation_id: original.operation_id, payload: stored }),
    )
    if (
      row.kind !== "operation" ||
      row.record_id !== original.operation_id ||
      row.operation_id !== original.operation_id ||
      row.entity_id !== original.file_id ||
      row.skill_page_id !== original.skill_page_id ||
      original.operation_id !== input.originalOperationId ||
      original.skill_page_id !== input.skillPageId ||
      original.library_id !== library.library_id ||
      canonicalSharedJson(row.payload) !== canonicalSharedJson(stored) ||
      row.hash !== storedHash
    )
      return yield* Effect.fail(
        fail(
          "SHARED_CURRENT_ACCEPTANCE_INVALID",
          "The selected original plan belongs to another exact identity.",
        ),
      )
    const outcomes = yield* querySharedRecords(library, {
      kind: "operation",
      skillPageId: original.skill_page_id,
      recordId: bodyWriteOutcomeId(original.operation_id),
    })
    if (outcomes.length !== 0)
      return yield* Effect.fail(
        fail(
          "SHARED_CURRENT_ACCEPTANCE_INELIGIBLE",
          "A recorded original outcome must use its existing recovery workflow.",
        ),
      )
    const id = yield* identity(original)
    const store = yield* Store
    const key = `operations/shared-body-current-acceptance/${input.scope}/${id}/plan.json`
    const saved = yield* store.readJson(key, Dispatch)
    const completed = yield* completedSharedBodyCurrentAcceptance(library, original)
    if (completed !== undefined) {
      if (completed.accepted_observed_sha256 !== input.acceptedObservedSha256)
        return yield* Effect.fail(
          fail(
            "SHARED_CURRENT_ACCEPTANCE_CONFLICT",
            "The existing immutable acceptance has another explicitly selected hash.",
          ),
        )
      return completed
    }
    let decision: Acceptance
    if (saved !== undefined) {
      if (
        saved.scope !== input.scope ||
        canonicalSharedJson(saved.original) !== canonicalSharedJson(original)
      )
        return yield* Effect.fail(
          fail(
            "SHARED_CURRENT_ACCEPTANCE_CONFLICT",
            "The retained dispatch belongs to another original operation or scope.",
          ),
        )
      decision = yield* validateDecision(saved.decision, original)
      if (decision.accepted_observed_sha256 !== input.acceptedObservedSha256)
        return yield* Effect.fail(
          fail(
            "SHARED_CURRENT_ACCEPTANCE_CONFLICT",
            "An unresolved acceptance cannot be replaced with another hash.",
          ),
        )
    } else {
      if (input.mode === "reconcile")
        return yield* Effect.fail(
          fail(
            "SHARED_CURRENT_ACCEPTANCE_UNRESOLVED",
            "The original acceptance is absent; reconciliation never creates a decision.",
          ),
        )
      const index = yield* querySharedSkillIndex(library, original.skill_page_id)
      const binding = [index.main, ...index.files].find(
        (value) => value.file_id === original.file_id,
      )
      // This exact-target authoring decision does not enable or publish a Skill.
      // Disabled ordinary consumption remains guarded by openSharedSnapshot.
      if (
        index.skill_id !== original.skill_id ||
        binding?.page_id !== original.page_id ||
        binding.path !== original.path ||
        index.source_reference !== original.source_id
      )
        return yield* Effect.fail(
          fail(
            "SHARED_CURRENT_ACCEPTANCE_STALE",
            "The selected Skill, file binding or Source changed.",
          ),
        )
      const events = yield* eventsFor(library, original)
      const state = yield* checked(() => verifyEvent(original, events, true))
      yield* verifyRestoreSource(library, original, state, index)
      const response = yield* completeResponse(
        yield* (yield* Notion).request(`v1/pages/${original.page_id}/markdown?markdown_version=v2`),
        original,
      )
      if ((yield* sha256(response.markdown)) !== input.acceptedObservedSha256)
        return yield* Effect.fail(
          fail(
            "SHARED_CURRENT_ACCEPTANCE_HASH_MISMATCH",
            "The current exact response differs from the explicitly reviewed SHA-256.",
          ),
        )
      decision = yield* validateDecision(
        {
          version: 1,
          kind: "body_write_current_acceptance",
          operation_id: id,
          original_operation_id: original.operation_id,
          original_plan_sha256: yield* originalHash(original),
          original_write_outcome: "unknown",
          decision: "accepted_current",
          library_id: original.library_id,
          skill_page_id: original.skill_page_id,
          skill_id: original.skill_id,
          file_id: original.file_id,
          page_id: original.page_id,
          event_sha256: yield* sha256(canonicalSharedJson(original.event)),
          accepted_observed_sha256: input.acceptedObservedSha256,
          candidate_sha256: original.candidate.content.sha256,
          observation_basis: "post_failure_current_read",
          response,
        },
        original,
      )
    }
    if (input.dryRun)
      return {
        ...reviewed(decision, original),
        status: "planned" as const,
        dry_run: true as const,
        decision_record: decision,
      }
    if (saved === undefined)
      yield* store.writeJson(key, { version: 1, scope: input.scope, original, decision })
    yield* appendSharedRecord(library, {
      mode: saved === undefined ? "create" : "reconcile",
      recordId: id,
      operationId: id,
      skillPageId: original.skill_page_id,
      kind: "operation",
      entityId: original.file_id,
      payload: decision,
      payloadContainsBody: true,
    })
    const result = yield* completedSharedBodyCurrentAcceptance(library, original)
    if (result === undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_CURRENT_ACCEPTANCE_UNRESOLVED",
          "The acceptance is not yet visible; preserve the dispatch and reconcile the same decision.",
        ),
      )
    return result
  })
}
