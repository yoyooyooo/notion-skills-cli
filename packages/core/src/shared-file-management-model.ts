import { Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { normalizePath, pageId } from "./ref.ts"
import { FrozenWriteBodySchema } from "./shared-body-write-model.ts"
import {
  FileEventSchema,
  normalizeObservedBody,
  RetainedContentSchema,
  nativeFileMetadata,
  type FileEvent,
} from "./shared-file-state.ts"
import {
  canonicalSharedJson,
  validateSharedRecordEnvelope,
  type SharedRecord,
} from "./shared-records.ts"
import { sha256 } from "./store.ts"
import {
  SharedNotionMarkdownProjectionSchema,
  validateSharedNotionMarkdownProjection,
} from "./shared-notion-projection.ts"
import { splitNativeSupportingMarkdown } from "./shared-native-file-metadata.ts"

const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const SharedFileManagementPlanV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("file_management"),
  action: Schema.Literals(["add", "delete", "move", "undelete"]),
  operation_id: Schema.String.check(
    Schema.isPattern(/^file-management-(?:add|delete|move|undelete)-[a-f0-9]{64}\.[a-f0-9]{64}$/u),
  ),
  library_id: Identity,
  skill_page_id: Schema.String,
  skill_id: Identity,
  file_id: Identity,
  page_id: Schema.NullOr(Schema.String),
  path: Schema.String,
  destination_path: Schema.NullOr(Schema.String),
  entrypoint: Schema.String,
  source_id: Schema.String,
  source_revision: Schema.String,
  snapshot_id: Schema.String,
  snapshot_version_id: Schema.String,
  snapshot_scope: Hash,
  tree_sha256: Hash,
  metadata_sha256: Hash,
  events_sha256: Hash,
  reference_check: Schema.Struct({
    checked_files: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    local_references: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  }),
  before: Schema.NullOr(FrozenWriteBodySchema),
  creation_projection: Schema.NullOr(SharedNotionMarkdownProjectionSchema),
  creation_mode: Schema.optional(Schema.Literals(["100644", "100755"])),
  content: Schema.Struct({ markdown: Schema.String, retained: RetainedContentSchema }),
  event: FileEventSchema,
})
export const SharedFileManagementPlanSchema = Schema.Union([
  SharedFileManagementPlanV1Schema,
  Schema.Struct({
    ...SharedFileManagementPlanV1Schema.fields,
    version: Schema.Literal(2),
    action: Schema.Literal("add"),
    creation_input: Schema.String,
  }),
])
export type SharedFileManagementPlan = typeof SharedFileManagementPlanSchema.Type
export const fileManagementOutcomesEntity = "file-management-outcomes-v1"
export const fileManagementOutcomeId = (operationId: string) => `outcome-${operationId}`
export const SharedFileManagementOutcomeSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("file_management_outcome"),
  operation_id: Schema.String,
  file_id: Schema.String,
  status: Schema.Literals(["applied", "not_sent", "rejected", "needs_review"]),
  reason_code: Schema.String,
  page_id: Schema.optional(Schema.String),
  event_id: Schema.optional(Schema.String),
})
export type SharedFileManagementOutcome = typeof SharedFileManagementOutcomeSchema.Type

export function decodeSharedFileManagementOutcome(row: SharedRecord): SharedFileManagementOutcome {
  const value = Schema.decodeUnknownSync(SharedFileManagementOutcomeSchema)(row.payload, {
    onExcessProperty: "error",
  })
  const event = plannedFileManagementEventId(value.operation_id)
  if (
    event === undefined ||
    row.kind !== "operation" ||
    row.entity_id !== fileManagementOutcomesEntity ||
    row.record_id !== fileManagementOutcomeId(value.operation_id) ||
    row.operation_id !== value.operation_id ||
    (value.page_id !== undefined && pageId(value.page_id) !== value.page_id) ||
    (value.status === "applied"
      ? value.event_id !== event || value.page_id === undefined
      : value.event_id !== undefined)
  )
    throw fail(
      "SHARED_FILE_MANAGEMENT_INVALID",
      "The lifecycle outcome does not identify its exact original operation.",
    )
  return value
}
export const fileManagementProtection = {
  preserves_page_and_body: true,
  move_strategy: "single_path_property_patch",
  conditional_metadata_replace: false,
  exact_postcondition_required: true,
  automatic_retry: false,
  relative_references: "complete_tree_markdown_links_and_images",
} as const

export const managementChecked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_FILE_MANAGEMENT_INVALID", "Invalid frozen file operation."),
  })

export function canonicalManagementPath(value: string): string {
  if (
    value === "" ||
    value === "." ||
    normalizePath(value) !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
    throw fail(
      "SHARED_FILE_MANAGEMENT_INVALID",
      "File operations require canonical relative paths.",
    )
  return value
}
function eventDescription(event: FileEvent) {
  const { event_id: _event, ...fields } = event
  return { version: 1, ...fields }
}
function description(plan: Omit<SharedFileManagementPlan, "operation_id">) {
  return { ...plan }
}
export function plannedFileManagementEventId(operationId: string): string | undefined {
  const matched = /^file-management-(add|delete|move|undelete)-([a-f0-9]{64})\.[a-f0-9]{64}$/u.exec(
    operationId,
  )
  return matched === null ? undefined : `${matched[1]}-${matched[2]}`
}
export function retainedFileManagementPayload(markdown: string) {
  return {
    version: 1 as const,
    kind: "normalized_markdown" as const,
    normalization_version: 1 as const,
    markdown,
  }
}

/** No I/O. Freeze complete exact event/body/identity semantics before any write. */
export function validateSharedFileManagementPlan(input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* managementChecked(() =>
      Schema.decodeUnknownSync(SharedFileManagementPlanSchema)(input, {
        onExcessProperty: "error",
      }),
    )
    yield* managementChecked(() => {
      if (
        pageId(plan.skill_page_id) !== plan.skill_page_id ||
        (plan.page_id !== null && pageId(plan.page_id) !== plan.page_id)
      )
        throw fail(
          "SHARED_FILE_MANAGEMENT_INVALID",
          "File operations require exact canonical Notion identities.",
        )
      if (plan.action !== "add" && plan.creation_mode !== undefined)
        throw fail("SHARED_FILE_MANAGEMENT_INVALID", "Only new file creation may nominate a mode.")
      canonicalManagementPath(plan.entrypoint)
      canonicalManagementPath(plan.path)
      if (plan.destination_path !== null) canonicalManagementPath(plan.destination_path)
      if (
        plan.path === plan.entrypoint ||
        plan.destination_path === plan.entrypoint ||
        plan.page_id === plan.skill_page_id
      )
        throw fail(
          "SHARED_MAIN_FILE_PROTECTED",
          "The main Skill body cannot be added over, moved or deleted.",
        )
      if (
        !/^s_[a-f0-9]{64}$/u.test(plan.snapshot_id) ||
        plan.snapshot_version_id === "" ||
        plan.event.file_id !== plan.file_id ||
        plan.file_id === fileManagementOutcomesEntity
      )
        throw fail(
          "SHARED_FILE_MANAGEMENT_INVALID",
          "The frozen operation has invalid snapshot or stable file identity.",
        )
      if ((plan.source_id === "") !== (plan.source_revision === ""))
        throw fail(
          "SHARED_FILE_MANAGEMENT_INVALID",
          "A selected immutable source requires the exact revision from its actual read-only observation.",
        )
      if (normalizeObservedBody(plan.content.markdown) !== plan.content.markdown)
        throw fail(
          "SHARED_FILE_MANAGEMENT_INVALID",
          "The frozen content must use normalization version 1.",
        )
      if (
        new Set(plan.event.parents).size !== plan.event.parents.length ||
        canonicalSharedJson(plan.event.parents) !==
          canonicalSharedJson([...plan.event.parents].sort())
      )
        throw fail(
          "SHARED_FILE_MANAGEMENT_INVALID",
          "A frozen event requires its complete sorted parent frontier.",
        )
      if (plan.action === "add") {
        if (
          plan.page_id !== null ||
          plan.before !== null ||
          plan.destination_path !== null ||
          plan.event.kind !== "adopted" ||
          plan.event.parents.length !== 0
        )
          throw fail(
            "SHARED_FILE_MANAGEMENT_INVALID",
            "New file creation must have no previous page or event frontier.",
          )
        if (
          plan.creation_projection === null ||
          (plan.creation_projection.version !== 1 &&
            plan.creation_projection.purpose !== "data_source_create") ||
          validateSharedNotionMarkdownProjection(plan.creation_projection).markdown !==
            plan.content.markdown
        )
          throw fail(
            "SHARED_FILE_MANAGEMENT_INVALID",
            "New file content must match its frozen explicit native Markdown projection; exact original input remains retained in this plan.",
          )
      } else {
        if (plan.creation_projection !== null)
          throw fail(
            "SHARED_FILE_MANAGEMENT_INVALID",
            "Moving or deleting preserves the exact observed body; it cannot reproject old bytes.",
          )
        if (
          plan.page_id === null ||
          plan.before === null ||
          plan.before.page_id !== plan.page_id ||
          plan.event.parents.length === 0
        )
          throw fail(
            "SHARED_FILE_MANAGEMENT_INVALID",
            "Moving or deleting needs an exact existing page and shared prior state.",
          )
        if (
          normalizeObservedBody(plan.before.raw_markdown) !== plan.before.markdown ||
          plan.before.markdown !== plan.content.markdown ||
          !Number.isSafeInteger(plan.before.downloaded_at) ||
          plan.before.downloaded_at < 0
        )
          throw fail(
            "SHARED_FILE_MANAGEMENT_INVALID",
            "The retained original body or observation time differs from the frozen preimage.",
          )
        if (/<meeting-notes-section-transcript(?:\s|>)/iu.test(plan.before.raw_markdown))
          throw fail(
            "SHARED_FILE_MANAGEMENT_UNSUPPORTED",
            "The default Markdown response omits meeting transcripts; their complete original bytes must be retained before lifecycle changes.",
          )
        if (
          plan.action === "delete" &&
          (plan.destination_path !== null || plan.event.kind !== "deleted")
        )
          throw fail(
            "SHARED_FILE_MANAGEMENT_INVALID",
            "Deletion records a tombstone without moving the underlying page.",
          )
        if (
          plan.action === "undelete" &&
          (plan.destination_path !== null ||
            plan.event.kind !== "undeleted" ||
            plan.page_id === null)
        )
          throw fail(
            "SHARED_FILE_MANAGEMENT_INVALID",
            "Undelete revives the same page and path. It does not create a row, move the file, or replace its bytes.",
          )
        if (
          plan.action === "move" &&
          (plan.destination_path === null ||
            plan.destination_path === plan.path ||
            plan.event.kind !== "moved" ||
            plan.event.from_path !== plan.path ||
            plan.event.to_path !== plan.destination_path)
        )
          throw fail(
            "SHARED_FILE_MANAGEMENT_INVALID",
            "A move must preserve the page and record its exact old/new logical paths.",
          )
      }
    })
    const hash = yield* sha256(plan.content.markdown)
    const inputMetadata =
      plan.version === 2
        ? yield* managementChecked(() => {
            const input = splitNativeSupportingMarkdown(plan.creation_input)
            if (
              input.frontmatter === undefined ||
              input.body !== plan.creation_projection?.input_markdown
            )
              throw fail(
                "SHARED_FILE_MANAGEMENT_INVALID",
                "The original supporting file must reconstruct its exact YAML header and projected body input.",
              )
            return { frontmatter: input.frontmatter }
          })
        : nativeFileMetadata(plan.before ?? {})
    const retained = {
      object_id: `body-${hash}`,
      sha256: hash,
      bytes: new TextEncoder().encode(plan.content.markdown).byteLength,
      ...inputMetadata,
      ...(plan.action === "add" && plan.creation_mode !== undefined
        ? { mode: plan.creation_mode }
        : {}),
    }
    if (
      canonicalSharedJson(retained) !== canonicalSharedJson(plan.content.retained) ||
      (plan.before !== null &&
        (plan.before.fingerprint.sha256 !== hash || plan.before.bytes !== retained.bytes))
    )
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_MANAGEMENT_INVALID",
          "The complete retained bytes disagree with their object identity.",
        ),
      )
    const eventContent =
      plan.event.kind === "adopted"
        ? plan.event.content
        : plan.event.kind === "deleted" ||
            plan.event.kind === "moved" ||
            plan.event.kind === "undeleted"
          ? plan.event.retained
          : undefined
    if (
      eventContent === undefined ||
      canonicalSharedJson(eventContent) !== canonicalSharedJson(retained)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_MANAGEMENT_INVALID",
          "The lifecycle event must retain the exact frozen complete body.",
        ),
      )
    const eventHash = yield* sha256(canonicalSharedJson(eventDescription(plan.event)))
    const { operation_id: _operation, ...frozen } = plan
    const planHash = yield* sha256(canonicalSharedJson(description(frozen)))
    if (
      plan.event.event_id !== `${plan.action}-${eventHash}` ||
      plan.operation_id !== `file-management-${plan.action}-${eventHash}.${planHash}`
    )
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_MANAGEMENT_INVALID",
          "The lifecycle event or original operation identity differs from its full frozen content.",
        ),
      )
    yield* managementChecked(() => {
      validateSharedRecordEnvelope(plan.operation_id, plan)
      validateSharedRecordEnvelope(
        `retain-${hash}`,
        retainedFileManagementPayload(plan.content.markdown),
      )
      validateSharedRecordEnvelope(plan.event.event_id, plan.event)
    })
    return plan
  })
}

export function makeSharedFileManagementPlan(
  input: Omit<
    typeof SharedFileManagementPlanV1Schema.Type,
    "operation_id" | "event" | "version" | "kind"
  > & {
    readonly creation_input?: string
    readonly event:
      | Omit<Extract<FileEvent, { kind: "adopted" }>, "event_id">
      | Omit<Extract<FileEvent, { kind: "deleted" }>, "event_id">
      | Omit<Extract<FileEvent, { kind: "undeleted" }>, "event_id">
      | Omit<Extract<FileEvent, { kind: "moved" }>, "event_id">
  },
) {
  return Effect.gen(function* () {
    const provisional = { ...input.event, event_id: "pending" } satisfies FileEvent
    const eventHash = yield* sha256(canonicalSharedJson(eventDescription(provisional)))
    const frozen = {
      ...input,
      version: input.creation_input === undefined ? (1 as const) : (2 as const),
      kind: "file_management" as const,
      event: { ...input.event, event_id: `${input.action}-${eventHash}` },
    }
    const planHash = yield* sha256(canonicalSharedJson(frozen))
    return yield* validateSharedFileManagementPlan({
      ...frozen,
      operation_id: `file-management-${input.action}-${eventHash}.${planHash}`,
    })
  })
}
