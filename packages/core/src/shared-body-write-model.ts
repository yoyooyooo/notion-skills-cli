import { Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { normalizePath, pageId } from "./ref.ts"
import {
  BodyFingerprintSchema,
  FileEventSchema,
  normalizeObservedBody,
  RetainedContentSchema,
  type FileEvent,
  type RetainedContent,
} from "./shared-file-state.ts"
import { canonicalSharedJson, validateSharedRecordEnvelope } from "./shared-records.ts"
import { sha256 } from "./store.ts"

const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
export const BodyWriteActionSchema = Schema.Literals(["write", "restore_follow"])
export const FrozenWriteBodySchema = Schema.Struct({
  page_id: Schema.String,
  /** Exact complete v2 response: this is the one matching string sent to Notion. */
  raw_markdown: Schema.String,
  markdown: Schema.String,
  fingerprint: BodyFingerprintSchema,
  bytes: Schema.Number,
  downloaded_at: Schema.Number,
})
export type FrozenWriteBody = typeof FrozenWriteBodySchema.Type
export const RestoreSourceSchema = Schema.Struct({
  source_id: Schema.String,
  revision: Identity,
  path: Schema.String,
})
export type RestoreSource = typeof RestoreSourceSchema.Type
export const SharedBodyWritePlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("body_write"),
  operation_id: Schema.String.check(
    Schema.isPattern(/^body-write-(?:adopt|follow)-[a-f0-9]{64}\.[a-f0-9]{64}$/u),
  ),
  library_id: Identity,
  skill_page_id: Schema.String,
  skill_id: Identity,
  file_id: Identity,
  page_id: Schema.String,
  path: Schema.String,
  source_id: Schema.String,
  action: BodyWriteActionSchema,
  restore_source: Schema.optional(RestoreSourceSchema),
  before: FrozenWriteBodySchema,
  candidate: Schema.Struct({ markdown: Schema.String, content: RetainedContentSchema }),
  event: FileEventSchema,
})
export type SharedBodyWritePlan = typeof SharedBodyWritePlanSchema.Type

/** No page CAS is claimed. Unmatched external text can remain after the request. */
export const sharedBodyWriteProtection = {
  strategy: "single_full_body_match",
  conditional_body_replace: false,
  nonempty_complete_old_body: true,
  exact_postcondition_required: true,
  automatic_retry: false,
} as const

export const bodyWriteOutcomesEntity = "body-write-outcomes-v1"
export const bodyWriteOutcomeId = (operationId: string) => `outcome-${operationId}`
export const bodyWriteObservationId = (operationId: string) => `observed-${operationId}`

export function bodyWriteChecked<A>(action: () => A) {
  return Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_BODY_WRITE_INVALID", "The frozen whole-file write is invalid."),
  })
}

export function retainedMarkdownPayload(markdown: string) {
  return {
    version: 1 as const,
    kind: "normalized_markdown" as const,
    normalization_version: 1 as const,
    markdown,
  }
}

export function bodyWriteEventDescription(event: FileEvent) {
  if (event.kind === "adopted")
    return { version: 1, file_id: event.file_id, parents: event.parents, content: event.content }
  if (event.kind === "following_restored")
    return {
      version: 1,
      file_id: event.file_id,
      parents: event.parents,
      source_revision: event.source_revision,
      projection: event.projection,
      retained: event.retained,
    }
  throw fail(
    "SHARED_BODY_WRITE_INVALID",
    "A body write can only adopt a whole file or explicitly restore following.",
  )
}

export function plannedBodyWriteEventId(operationId: string): string | undefined {
  const match = /^body-write-(adopt|follow)-([a-f0-9]{64})\.[a-f0-9]{64}$/u.exec(operationId)
  return match ? `${match[1]}-${match[2]}` : undefined
}

function description(plan: Omit<SharedBodyWritePlan, "operation_id">) {
  return {
    version: plan.version,
    kind: plan.kind,
    library_id: plan.library_id,
    skill_page_id: plan.skill_page_id,
    skill_id: plan.skill_id,
    file_id: plan.file_id,
    page_id: plan.page_id,
    path: plan.path,
    source_id: plan.source_id,
    action: plan.action,
    ...(plan.restore_source === undefined ? {} : { restore_source: plan.restore_source }),
    before: plan.before,
    candidate: plan.candidate,
    event: plan.event,
  }
}

export function validateSharedBodyWritePlan(input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* bodyWriteChecked(() =>
      Schema.decodeUnknownSync(SharedBodyWritePlanSchema)(input, { onExcessProperty: "error" }),
    )
    yield* bodyWriteChecked(() => {
      for (const id of [plan.skill_page_id, plan.page_id, plan.before.page_id])
        if (pageId(id) !== id)
          throw fail(
            "SHARED_BODY_WRITE_INVALID",
            "Body writes require canonical Notion identities.",
          )
      if (
        plan.page_id !== plan.before.page_id ||
        plan.event.file_id !== plan.file_id ||
        plan.file_id === bodyWriteOutcomesEntity
      )
        throw fail(
          "SHARED_BODY_WRITE_INVALID",
          "The plan's body, event and file identities disagree.",
        )
      if (normalizePath(plan.path) !== plan.path || plan.path === "" || plan.path === ".")
        throw fail("SHARED_BODY_WRITE_INVALID", "The frozen file path must be canonical.")
      if (plan.before.raw_markdown.length === 0)
        throw fail(
          "SHARED_BODY_WRITE_UNSUPPORTED",
          "An empty old body cannot provide a unique complete match. Retain a candidate; no existing page is overwritten.",
        )
      // The Markdown update matcher omits meeting transcripts; its rendered
      // placeholder is not a complete retained preimage of that content.
      if (/<meeting-notes-section-transcript(?:\s|>)/iu.test(plan.before.raw_markdown))
        throw fail(
          "SHARED_BODY_WRITE_UNSUPPORTED",
          "Meeting transcripts are omitted by Markdown update matching; this whole-body path cannot retain their complete preimage.",
        )
      if (
        normalizeObservedBody(plan.before.raw_markdown) !== plan.before.markdown ||
        normalizeObservedBody(plan.candidate.markdown) !== plan.candidate.markdown
      )
        throw fail(
          "SHARED_BODY_WRITE_INVALID",
          "Frozen bodies do not use the declared normalization.",
        )
      if (
        !Number.isSafeInteger(plan.before.bytes) ||
        plan.before.bytes < 0 ||
        !Number.isSafeInteger(plan.before.downloaded_at) ||
        plan.before.downloaded_at < 0
      )
        throw fail(
          "SHARED_BODY_WRITE_INVALID",
          "Body size and observation time must be nonnegative safe integers.",
        )
      if (
        new Set(plan.event.parents).size !== plan.event.parents.length ||
        plan.event.parents.length === 0 ||
        canonicalSharedJson(plan.event.parents) !==
          canonicalSharedJson([...plan.event.parents].sort()) ||
        plan.event.parents.includes(plan.event.event_id)
      )
        throw fail(
          "SHARED_BODY_WRITE_INVALID",
          "A write requires its complete sorted prior event frontier.",
        )
      if (
        plan.action === "write" &&
        (plan.restore_source !== undefined || plan.event.kind !== "adopted")
      )
        throw fail(
          "SHARED_BODY_WRITE_INVALID",
          "An ordinary write must adopt the candidate without changing source selection.",
        )
      if (plan.action === "restore_follow") {
        const source = plan.restore_source
        if (
          !source ||
          source.source_id === "" ||
          source.source_id !== plan.source_id ||
          source.path !== plan.path ||
          plan.event.kind !== "following_restored" ||
          plan.event.source_revision !== source.revision
        )
          throw fail(
            "SHARED_BODY_WRITE_INVALID",
            "Restore-follow requires the exact frozen selected source and file path.",
          )
      }
    })
    const previousHash = yield* sha256(plan.before.markdown)
    const candidateHash = yield* sha256(plan.candidate.markdown)
    const previous: RetainedContent = {
      object_id: `body-${previousHash}`,
      sha256: previousHash,
      bytes: new TextEncoder().encode(plan.before.markdown).byteLength,
    }
    if (
      previousHash !== plan.before.fingerprint.sha256 ||
      previous.bytes !== plan.before.bytes ||
      plan.candidate.content.sha256 !== candidateHash ||
      plan.candidate.content.object_id !== `body-${candidateHash}` ||
      plan.candidate.content.bytes !== new TextEncoder().encode(plan.candidate.markdown).byteLength
    )
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_WRITE_INVALID",
          "Frozen complete body bytes differ from their hashes or lengths.",
        ),
      )
    if (plan.event.kind === "adopted") {
      if (canonicalSharedJson(plan.event.content) !== canonicalSharedJson(plan.candidate.content))
        return yield* Effect.fail(
          fail("SHARED_BODY_WRITE_INVALID", "The adoption does not retain the exact candidate."),
        )
    } else if (plan.event.kind === "following_restored") {
      if (
        plan.event.projection.sha256 !== candidateHash ||
        canonicalSharedJson(plan.event.retained) !== canonicalSharedJson(previous)
      )
        return yield* Effect.fail(
          fail(
            "SHARED_BODY_WRITE_INVALID",
            "Restoring following must retain the old complete body and confirm the candidate projection.",
          ),
        )
    }
    const eventHash = yield* sha256(canonicalSharedJson(bodyWriteEventDescription(plan.event)))
    const tag = plan.action === "write" ? "adopt" : "follow"
    const planHash = yield* sha256(canonicalSharedJson(description(plan)))
    if (
      plan.event.event_id !== `${tag}-${eventHash}` ||
      plan.operation_id !== `body-write-${tag}-${eventHash}.${planHash}`
    )
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_WRITE_INVALID",
          "The frozen event or operation identity does not match its complete content.",
        ),
      )
    yield* bodyWriteChecked(() => {
      validateSharedRecordEnvelope(plan.operation_id, plan)
      validateSharedRecordEnvelope(
        `retain-${previousHash}`,
        retainedMarkdownPayload(plan.before.markdown),
      )
      validateSharedRecordEnvelope(
        `retain-${candidateHash}`,
        retainedMarkdownPayload(plan.candidate.markdown),
      )
      validateSharedRecordEnvelope(plan.event.event_id, plan.event)
    })
    return plan
  })
}

/** All deterministic validation, including exact envelope budgets, precedes dispatch. */
export function makeSharedBodyWritePlan(
  input: Omit<SharedBodyWritePlan, "operation_id" | "event" | "candidate" | "version" | "kind"> & {
    readonly candidateMarkdown: string
    readonly parents: readonly string[]
  },
) {
  return Effect.gen(function* () {
    const markdown = yield* bodyWriteChecked(() => normalizeObservedBody(input.candidateMarkdown))
    const hash = yield* sha256(markdown)
    const content = {
      object_id: `body-${hash}`,
      sha256: hash,
      bytes: new TextEncoder().encode(markdown).byteLength,
    }
    const parents = [...input.parents].sort()
    const base =
      input.action === "write"
        ? { file_id: input.file_id, parents, kind: "adopted" as const, content }
        : {
            file_id: input.file_id,
            parents,
            kind: "following_restored" as const,
            source_revision: input.restore_source?.revision ?? "",
            projection: { normalization_version: 1 as const, sha256: hash },
            retained: {
              object_id: `body-${input.before.fingerprint.sha256}`,
              sha256: input.before.fingerprint.sha256,
              bytes: input.before.bytes,
            },
          }
    const provisional = { ...base, event_id: "pending" } satisfies FileEvent
    const tag = input.action === "write" ? "adopt" : "follow"
    const eventHash = yield* sha256(canonicalSharedJson(bodyWriteEventDescription(provisional)))
    const event = { ...base, event_id: `${tag}-${eventHash}` }
    const plan = {
      version: 1 as const,
      kind: "body_write" as const,
      library_id: input.library_id,
      skill_page_id: input.skill_page_id,
      skill_id: input.skill_id,
      file_id: input.file_id,
      page_id: input.page_id,
      path: input.path,
      source_id: input.source_id,
      action: input.action,
      ...(input.restore_source === undefined ? {} : { restore_source: input.restore_source }),
      before: input.before,
      candidate: { markdown, content },
      event,
    }
    const planHash = yield* sha256(canonicalSharedJson(plan))
    return yield* validateSharedBodyWritePlan({
      ...plan,
      operation_id: `body-write-${tag}-${eventHash}.${planHash}`,
    })
  })
}
