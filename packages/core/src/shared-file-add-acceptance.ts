import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { validateSnapshotManifest } from "./cache.ts"
import { ContentRecordSchema, SnapshotSchema, fail, type Snapshot, type Source } from "./model.ts"
import { Notion, withNotionRequestAttribution } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { canonicalMain } from "./portable.ts"
import { pageId } from "./ref.ts"
import { sharedRecordFromPage } from "./shared-content.ts"
import { sharedCreateDispatch } from "./shared-create-dispatch.ts"
import {
  decodeSharedFileManagementOutcome,
  fileManagementOutcomeId,
  fileManagementOutcomesEntity,
  managementChecked as checked,
  retainedFileManagementPayload,
  validateSharedFileManagementPlan,
  type SharedFileManagementPlan,
} from "./shared-file-management-model.ts"
import { assertSharedFileReferences } from "./shared-file-references.ts"
import {
  FileEventSchema,
  nativeMetadataForOwnership,
  normalizeObservedBody,
  resolveFileState,
  type FileEvent,
} from "./shared-file-state.ts"
import { readSharedFileSourceContext } from "./shared-file-source-context.ts"
import { SharedFileSourceContextSchema } from "./shared-file-source-context-model.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { materializeSharedNativeFile } from "./shared-native-file-content.ts"
import { nativeSupportingMarkdown } from "./shared-native-file-metadata.ts"
import {
  pendingFileOperations,
  sharedPendingObservationPrefix,
} from "./shared-pending-file-operations.ts"
import { querySharedOperationIndex, type SharedOperationHeader } from "./shared-operation-index.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  validateSharedRecordEnvelope,
  type SharedRecord,
} from "./shared-records.ts"
import { querySharedSkillRelation } from "./shared-router-members.ts"
import { querySharedSkillIndex } from "./shared-skill-index.ts"
import { sharedSnapshotVersion } from "./shared-snapshot-identity.ts"
import { sha256, Store } from "./store.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Response = Schema.Struct({
  id: Schema.String,
  markdown: Schema.String,
  truncated: Schema.Boolean,
  unknown_block_ids: Schema.Array(Schema.String),
  warnings: Schema.optional(Schema.Array(Schema.Unknown)),
})
const Binding = Schema.Struct({
  file_id: Schema.String,
  page_id: Schema.String,
  path: Schema.String,
})
const Review = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("file_add_current_review"),
  review_id: Schema.String,
  operation_id: Schema.String,
  original_operation_id: Schema.String,
  original_plan_sha256: Hash,
  original_outcome_sha256: Hash,
  original_status: Schema.Literal("needs_review"),
  original_complete_ack: Schema.Literal("not_retained"),
  decision: Schema.Literal("accept_current_file"),
  library_id: Schema.String,
  skill_id: Schema.String,
  skill_page_id: Schema.String,
  file_id: Schema.String,
  page_id: Schema.String,
  path: Schema.String,
  accepted_observed_sha256: Hash,
  baseline: SnapshotSchema,
  record: ContentRecordSchema,
  bindings: Schema.Array(Binding),
  source_context: SharedFileSourceContextSchema,
  prior_events: Schema.Array(FileEventSchema),
  observations: Schema.Array(Schema.Struct({ file_id: Schema.String, response: Response })),
  event: FileEventSchema,
})
export type SharedFileAddAcceptanceReview = typeof Review.Type
const Completion = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("file_add_current_acceptance"),
  operation_id: Schema.String,
  original_operation_id: Schema.String,
  original_status: Schema.Literal("needs_review"),
  original_completion: Schema.Literal("unproven"),
  decision: Schema.Literal("accepted_current_file"),
  review_id: Schema.String,
  review_record_sha256: Hash,
  event_id: Schema.String,
  event_record_sha256: Hash,
})
export const fileAddAcceptanceReviewsEntity = "file-add-current-reviews-v1"
export const fileAddAcceptanceOutcomesEntity = "file-add-current-acceptances-v1"
const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const hash = (value: unknown) => sha256(canonicalSharedJson(value))
const refusal = (message: string) =>
  Effect.fail(fail("SHARED_FILE_ADD_ACCEPTANCE_REQUIRED", message))
const ordered = <A extends { readonly file_id: string }>(values: readonly A[]) =>
  [...values].sort((a, b) => (a.file_id < b.file_id ? -1 : a.file_id > b.file_id ? 1 : 0))
const sortedEvents = (values: readonly FileEvent[]) =>
  [...values].sort((a, b) => (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0))
const identity = (operation: string) =>
  hash([1, "file_add_current_acceptance", operation]).pipe(
    Effect.map((value) => "file-add-accept-" + value),
  )
const reviewRecordId = (id: string) => "review-" + id
const completionRecordId = (id: string) => "outcome-" + id

function original(library: SharedLibrary, skill: string, operation: string) {
  return Effect.gen(function* () {
    const rows = yield* querySharedRecords(library, {
      skillPageId: skill,
      kind: "operation",
      recordId: operation,
      payloadContainsBody: true,
    })
    const row = rows[0]
    if (rows.length !== 1 || row === undefined)
      return yield* refusal(
        "The complete original shared add plan is required; a current page cannot replace it.",
      )
    const plan = yield* validateSharedFileManagementPlan(row.payload)
    if (
      plan.action !== "add" ||
      plan.source_id !== "" ||
      plan.source_revision !== "" ||
      plan.library_id !== library.library_id ||
      plan.skill_page_id !== skill ||
      plan.operation_id !== operation ||
      row.operation_id !== operation ||
      row.entity_id !== plan.file_id
    )
      return yield* refusal(
        "Select one exact ordinary native add in its original library and Skill.",
      )
    const outcomes = yield* querySharedRecords(library, {
      skillPageId: skill,
      kind: "operation",
      recordId: fileManagementOutcomeId(operation),
      entityId: fileManagementOutcomesEntity,
    })
    const outcomeRow = outcomes[0]
    if (outcomes.length !== 1 || outcomeRow === undefined)
      return yield* refusal(
        "Unknown or missing original add outcomes cannot authorize current-file acceptance.",
      )
    const outcome = yield* checked(() => decodeSharedFileManagementOutcome(outcomeRow))
    if (
      outcome.operation_id !== operation ||
      outcome.file_id !== plan.file_id ||
      outcome.status !== "needs_review" ||
      outcome.reason_code !== "SHARED_FILE_MANAGEMENT_BODY_MISMATCH" ||
      outcome.page_id === undefined ||
      pageId(outcome.page_id) !== outcome.page_id
    )
      return yield* refusal(
        "Only the known original complete-body mismatch with its retained exact page reference is eligible; invalid responses and unknown writes remain unresolved.",
      )
    yield* appendSharedRecord(library, {
      mode: "reconcile",
      recordId: plan.content.retained.object_id,
      operationId: "retain-" + plan.content.retained.sha256,
      skillPageId: skill,
      kind: "object",
      entityId: plan.content.retained.object_id,
      payload: retainedFileManagementPayload(plan.content.markdown),
    })
    return { plan, row, outcomeRow, page: outcome.page_id }
  })
}
type Original = Effect.Success<ReturnType<typeof original>>

function completeResponse(value: unknown, page: string) {
  return Effect.gen(function* () {
    const response = yield* checked(() => Schema.decodeUnknownSync(Response)(value))
    if (
      response.id !== page ||
      response.truncated ||
      response.unknown_block_ids.length !== 0 ||
      (response.warnings?.length ?? 0) !== 0 ||
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        new TextEncoder().encode(response.markdown),
      ) !== response.markdown
    )
      return yield* refusal(
        "Every current native file requires its exact complete warning-free UTF-8 response.",
      )
    return response
  })
}

/** Complete bytes, binding, prior ownership and original snapshot are checked together. */
function validateReview(input: unknown, retained: Original, expectedId?: string) {
  return Effect.gen(function* () {
    const review = yield* checked(() =>
      Schema.decodeUnknownSync(Review)(input, { onExcessProperty: "error" }),
    )
    const { plan } = retained,
      { review_id, ...fields } = review
    const id = yield* identity(plan.operation_id)
    if (
      review_id !== "file-add-review-" + (yield* hash(fields)) ||
      (expectedId !== undefined && review_id !== expectedId) ||
      review.operation_id !== id ||
      review.original_operation_id !== plan.operation_id ||
      review.original_plan_sha256 !== retained.row.hash ||
      review.original_outcome_sha256 !== retained.outcomeRow.hash ||
      review.library_id !== plan.library_id ||
      review.skill_id !== plan.skill_id ||
      review.skill_page_id !== plan.skill_page_id ||
      review.file_id !== plan.file_id ||
      review.page_id !== retained.page ||
      review.path !== plan.path ||
      review.source_context.selected_version !== "" ||
      review.source_context.definition !== null
    )
      return yield* refusal(
        "The independently reviewed decision differs from its exact original scope, failure or current-file identity.",
      )
    const baseline = review.baseline,
      locator = baseline.record.locator
    // The full native observations below reconstruct every file byte. Cold proof
    // verification therefore needs no writer-local snapshot/object cache.
    yield* validateSnapshotManifest(baseline)
    if (
      baseline.snapshot_id !== plan.snapshot_id ||
      baseline.version_id !== plan.snapshot_version_id ||
      baseline.scope !== plan.snapshot_scope ||
      (yield* hash(baseline.files)) !== plan.tree_sha256 ||
      locator.type !== "shared_skill" ||
      locator.library_id !== plan.library_id ||
      locator.skill_id !== plan.skill_id ||
      locator.page_id !== plan.skill_page_id ||
      !same(baseline.record, review.record) ||
      review.record.enabled !== true ||
      review.record.kind !== "skill" ||
      (baseline.members ?? baseline.router_members ?? []).length !== 0
    )
      return yield* refusal(
        "Acceptance requires the exact original complete enabled native Skill snapshot and unchanged owner metadata.",
      )
    const priorBindings = review.bindings.filter((binding) => binding.file_id !== plan.file_id)
    const target = review.bindings.find((binding) => binding.file_id === plan.file_id)
    if (
      target?.page_id !== retained.page ||
      target.path !== plan.path ||
      !same(ordered(priorBindings), ordered(baseline.file_bindings ?? [])) ||
      review.bindings.length !== priorBindings.length + 1 ||
      new Set(review.bindings.map((binding) => binding.file_id)).size !== review.bindings.length ||
      new Set(review.bindings.map((binding) => binding.page_id)).size !== review.bindings.length ||
      new Set(review.bindings.map((binding) => binding.path)).size !== review.bindings.length ||
      review.observations.length !== review.bindings.length ||
      new Set(review.observations.map((value) => value.file_id)).size !== review.bindings.length ||
      review.prior_events.some((event) => event.file_id === plan.file_id) ||
      (yield* hash(sortedEvents(review.prior_events))) !== plan.events_sha256
    )
      return yield* refusal(
        "The complete old binding set or shared frontier changed; a foreign page or existing event cannot be adopted through this decision.",
      )
    const ownership = priorBindings.map((binding) => ({
      file_id: binding.file_id,
      path: binding.path,
      state: resolveFileState(
        binding.file_id,
        review.prior_events.filter((event) => event.file_id === binding.file_id),
      ),
    }))
    const version = yield* sharedSnapshotVersion({ ...baseline, source: null, ownership })
    if (version !== plan.snapshot_version_id)
      return yield* refusal(
        "The complete original snapshot and retained prior ownership do not reconstruct the frozen version.",
      )
    const candidate = {
      file_id: plan.file_id,
      parents: [] as readonly string[],
      content: plan.content.retained,
    }
    const event = {
      kind: "adopted" as const,
      ...candidate,
      event_id: "adopt-" + (yield* hash({ version: 1, ...candidate })),
    }
    if (!same(review.event, event) || event.event_id === plan.event.event_id)
      return yield* refusal(
        "Current acceptance must use its own exact adopted event, never the original add event.",
      )
    const tree: ReturnType<typeof canonicalMain>[] = []
    for (const binding of review.bindings) {
      const observation = review.observations.find((value) => value.file_id === binding.file_id)
      if (observation === undefined)
        return yield* refusal("A current native body observation is missing.")
      const response = yield* completeResponse(observation.response, binding.page_id)
      const body = yield* checked(() => normalizeObservedBody(response.markdown))
      const state = ownership.find((value) => value.file_id === binding.file_id)?.state
      if (binding.file_id !== plan.file_id && state?.ownership.kind !== "custom")
        return yield* refusal(
          "This acceptance is limited to a complete native custom-file tree; source projections and tombstones require their existing lifecycle.",
        )
      const content =
        binding.file_id === plan.file_id
          ? plan.content.retained
          : state!.ownership.kind === "custom"
            ? state!.ownership.content
            : undefined
      if (
        content === undefined ||
        (yield* sha256(body)) !== content.sha256 ||
        new TextEncoder().encode(body).byteLength !== content.bytes
      )
        return yield* refusal(
          "A complete native body differs from the exact accepted candidate or original file frontier.",
        )
      if (
        binding.file_id === plan.file_id &&
        ((yield* sha256(response.markdown)) !== review.accepted_observed_sha256 ||
          body !== plan.content.markdown)
      )
        return yield* refusal(
          "The explicitly selected complete target body differs from the original candidate; link changes are not normalized into equivalence.",
        )
      const metadata = nativeMetadataForOwnership({ kind: "custom", content })
      const materialized = materializeSharedNativeFile(body, binding.path, review.bindings)
      const file =
        binding.path === baseline.entrypoint
          ? canonicalMain(review.record.name, review.record.description, materialized, {
              path: binding.path,
              mode: "100644",
              bytes: new TextEncoder().encode(metadata.frontmatter ?? ""),
            })
          : {
              path: binding.path,
              mode: "100644" as const,
              bytes: new TextEncoder().encode(nativeSupportingMarkdown(materialized, metadata)),
            }
      if (binding.file_id !== plan.file_id) {
        const frozen = baseline.files.find((value) => value.path === binding.path)
        if (
          frozen === undefined ||
          frozen.sha256 !== (yield* sha256(file.bytes)) ||
          frozen.bytes !== file.bytes.byteLength ||
          (frozen.mode ?? "100644") !== file.mode
        )
          return yield* refusal(
            "The complete original file bytes do not match the frozen author snapshot.",
          )
      }
      tree.push(file)
    }
    if (baseline.files.length !== priorBindings.length)
      return yield* refusal(
        "The original snapshot contains non-native resources outside this acceptance boundary.",
      )
    yield* checked(() => assertSharedFileReferences(tree))
    yield* checked(() => validateSharedRecordEnvelope(id, review, "operation"))
    return review
  })
}

function readEvents(library: SharedLibrary, skill: string) {
  return Effect.gen(function* () {
    const rows = yield* querySharedRecords(library, { skillPageId: skill, kind: "file_event" })
    return yield* checked(() =>
      rows.map((row) => {
        const event = Schema.decodeUnknownSync(FileEventSchema)(row.payload, {
          onExcessProperty: "error",
        })
        if (
          row.record_id !== event.event_id ||
          row.operation_id !== event.event_id ||
          row.entity_id !== event.file_id
        )
          throw fail(
            "SHARED_FILE_ADD_ACCEPTANCE_REQUIRED",
            "A shared event has a foreign complete identity.",
          )
        return event
      }),
    )
  })
}

function currentReview(
  library: SharedLibrary,
  retained: Original,
  baseline: Snapshot,
  acceptedHash: string,
  existing?: SharedFileAddAcceptanceReview,
) {
  return Effect.gen(function* () {
    const { plan } = retained,
      api = yield* Notion
    const raw = yield* api.request(`v1/pages/${plan.skill_page_id}`)
    const source: Source = {
      alias: library.library_id,
      title: "",
      role: "content",
      database_id: library.skills.database_id,
      data_source_ids: [library.skills.data_source_id],
      shared_library: library,
    }
    const record = yield* checked(() =>
      sharedRecordFromPage(raw, source, library.skills.data_source_id),
    )
    const index = yield* querySharedSkillIndex(library, plan.skill_page_id, raw)
    if (
      index.skill_id !== plan.skill_id ||
      index.source_reference !== "" ||
      index.file_links !== ""
    )
      return yield* refusal("The current owner, Source or explicit file-link mapping changed.")
    const sourceContext = yield* readSharedFileSourceContext(library, plan.skill_page_id, raw)
    for (const [field, frozen] of [
      ["Members", baseline.members ?? baseline.router_members],
      ["Requires", baseline.required],
    ] as const) {
      const members =
        library.skills.property_ids[field] === undefined
          ? []
          : (yield* querySharedSkillRelation(library, { record, rawPage: raw, field })).map(
              ({ id, ref, metadata }) => ({ id, ref, metadata }),
            )
      if (!same(members, frozen ?? []))
        return yield* refusal(
          "A complete current Members or Requires relation differs from the original author snapshot.",
        )
    }
    const bindings = ordered(
      [index.main, ...index.files].map(({ file_id, page_id, path }) => ({
        file_id,
        page_id,
        path,
      })),
    )
    const selected = bindings.find((binding) => binding.file_id === plan.file_id)
    if (
      selected?.page_id !== retained.page ||
      selected.path !== plan.path ||
      !same(
        ordered(bindings.filter((binding) => binding.file_id !== plan.file_id)),
        ordered(baseline.file_bindings ?? []),
      ) ||
      !same(record, baseline.record)
    )
      return yield* refusal(
        "The exact original File/page or complete owner binding set changed before current-body inspection.",
      )
    let events = yield* readEvents(library, plan.skill_page_id)
    const targetEvents = events.filter((event) => event.file_id === plan.file_id)
    if (targetEvents.length !== 0) {
      if (
        existing === undefined ||
        targetEvents.length !== 1 ||
        !same(targetEvents[0], existing.event)
      )
        return yield* refusal(
          "The target already has a shared event; absence or current equality never authorizes replacing its history.",
        )
      const reviews = yield* querySharedRecords(library, {
        skillPageId: plan.skill_page_id,
        kind: "operation",
        recordId: reviewRecordId(existing.operation_id),
        entityId: fileAddAcceptanceReviewsEntity,
        payloadContainsBody: true,
      })
      if (reviews.length !== 1 || !same(reviews[0]?.payload, existing))
        return yield* refusal(
          "An interrupted acceptance event requires its exact preceding independent review.",
        )
      events = events.filter((event) => event.event_id !== existing.event.event_id)
    }
    const headers = yield* querySharedOperationIndex(library, plan.skill_page_id)
    if (
      headers.some(
        (header) => header.entity_id === plan.file_id && header.record_id !== plan.operation_id,
      )
    )
      return yield* refusal(
        "Another operation names the unaccepted File; preserve that history for its own workflow.",
      )
    const observations = yield* Effect.forEach(bindings, (binding) =>
      Effect.gen(function* () {
        return {
          file_id: binding.file_id,
          response: yield* completeResponse(
            yield* api.request(`v1/pages/${binding.page_id}/markdown?markdown_version=v2`),
            binding.page_id,
          ),
        }
      }),
    )
    const id = yield* identity(plan.operation_id)
    const description = {
      version: 1,
      file_id: plan.file_id,
      parents: [],
      content: plan.content.retained,
    }
    const fields = {
      version: 1 as const,
      kind: "file_add_current_review" as const,
      operation_id: id,
      original_operation_id: plan.operation_id,
      original_plan_sha256: retained.row.hash,
      original_outcome_sha256: retained.outcomeRow.hash,
      original_status: "needs_review" as const,
      original_complete_ack: "not_retained" as const,
      decision: "accept_current_file" as const,
      library_id: plan.library_id,
      skill_id: plan.skill_id,
      skill_page_id: plan.skill_page_id,
      file_id: plan.file_id,
      page_id: retained.page,
      path: plan.path,
      accepted_observed_sha256: acceptedHash,
      baseline,
      record,
      bindings,
      source_context: sourceContext,
      prior_events: sortedEvents(events),
      observations,
      event: {
        kind: "adopted" as const,
        file_id: plan.file_id,
        parents: [],
        content: plan.content.retained,
        event_id: "adopt-" + (yield* hash(description)),
      },
    }
    return yield* validateReview(
      { ...fields, review_id: "file-add-review-" + (yield* hash(fields)) },
      retained,
    )
  })
}

function writerAuthority(library: SharedLibrary, plan: SharedFileManagementPlan) {
  return Effect.gen(function* () {
    const scope = yield* authScope
    if (scope !== plan.snapshot_scope)
      return yield* refusal(
        "Apply requires the original author credential and Store; a cold reader has no dispatch authority.",
      )
    const local = yield* pendingFileOperations({
      scope,
      library_id: library.library_id,
      skill_id: plan.skill_id,
      skill_page_id: plan.skill_page_id,
      prefix: yield* sharedPendingObservationPrefix(scope, library.library_id, plan.skill_id),
    })
    if (local.length !== 1 || !same(local[0]?.plan, plan))
      return yield* refusal(
        "Keep the exact original pending add in its original Store. Missing or additional pending intent cannot be bypassed.",
      )
  })
}

function reviewed(review: SharedFileAddAcceptanceReview) {
  return {
    status: "reviewed" as const,
    decision: "accepted_current_file" as const,
    operation_id: review.operation_id,
    original_operation_id: review.original_operation_id,
    original_status: "needs_review" as const,
    original_completion: "unproven" as const,
    page_id: review.page_id,
    file_id: review.file_id,
    event: review.event,
    review_id: review.review_id,
    accepted_observed_sha256: review.accepted_observed_sha256,
    verified: true as const,
    requires_fresh_read: true as const,
  }
}

/** Historical independent acceptance; later legitimate author edits remain separate. */
export function completedSharedFileAddAcceptance(
  library: SharedLibrary,
  plan: SharedFileManagementPlan,
  observed?: {
    readonly headers: readonly SharedOperationHeader[]
    readonly events: readonly FileEvent[]
  },
) {
  return Effect.gen(function* () {
    if (plan.action !== "add") return undefined
    const id = yield* identity(plan.operation_id),
      completionId = completionRecordId(id)
    const header = observed?.headers.find((value) => value.record_id === completionId)
    if (observed !== undefined && header === undefined) return undefined
    const rows = yield* querySharedRecords(library, {
      skillPageId: plan.skill_page_id,
      kind: "operation",
      entityId: fileAddAcceptanceOutcomesEntity,
      recordId: completionId,
    })
    const row = rows[0]
    if (row === undefined && header === undefined) return undefined
    if (
      rows.length !== 1 ||
      row === undefined ||
      row.operation_id !== id ||
      (header !== undefined && header.hash !== row.hash)
    )
      return yield* refusal(
        "The indexed independent acceptance is missing or inconsistent; retain the original pending barrier.",
      )
    const retained = yield* original(library, plan.skill_page_id, plan.operation_id)
    if (!same(retained.plan, plan))
      return yield* refusal("The original full shared add plan changed.")
    const reviews = yield* querySharedRecords(library, {
      skillPageId: plan.skill_page_id,
      kind: "operation",
      entityId: fileAddAcceptanceReviewsEntity,
      recordId: reviewRecordId(id),
      payloadContainsBody: true,
    })
    const reviewRow = reviews[0]
    if (reviews.length !== 1 || reviewRow === undefined || reviewRow.operation_id !== id)
      return yield* refusal("The complete independent author review is unavailable.")
    const review = yield* validateReview(reviewRow.payload, retained)
    const events = observed?.events ?? (yield* readEvents(library, plan.skill_page_id))
    if (
      events.some((event) => event.event_id === plan.event.event_id) ||
      !events.some((event) => same(event, review.event))
    )
      return yield* refusal(
        "The independent adopted event is missing or the original add event was substituted.",
      )
    const eventRow = yield* appendSharedRecord(library, {
      mode: "reconcile",
      recordId: review.event.event_id,
      operationId: review.event.event_id,
      skillPageId: plan.skill_page_id,
      kind: "file_event",
      entityId: plan.file_id,
      payload: review.event,
    })
    const completion = yield* checked(() =>
      Schema.decodeUnknownSync(Completion)(row.payload, { onExcessProperty: "error" }),
    )
    const expected = {
      version: 1,
      kind: "file_add_current_acceptance",
      operation_id: id,
      original_operation_id: plan.operation_id,
      original_status: "needs_review",
      original_completion: "unproven",
      decision: "accepted_current_file",
      review_id: review.review_id,
      review_record_sha256: reviewRow.hash,
      event_id: review.event.event_id,
      event_record_sha256: eventRow.hash,
    }
    if (!same(completion, expected))
      return yield* refusal(
        "The independent acceptance does not bind its complete review and exact new ownership event.",
      )
    return reviewed(review)
  })
}

/** A cold index cannot hide an orphan acceptance by omitting its old plan. */
export function loadCompletedSharedFileAddAcceptances(
  library: SharedLibrary,
  input: {
    readonly skillPageId: string
    readonly headers: readonly SharedOperationHeader[]
    readonly events: readonly FileEvent[]
  },
) {
  return Effect.gen(function* () {
    const relevant = input.headers.filter(
      (header) =>
        header.entity_id === fileAddAcceptanceReviewsEntity ||
        header.entity_id === fileAddAcceptanceOutcomesEntity,
    )
    const completed = new Set<string>()
    if (relevant.length === 0) return completed
    const reviews = yield* querySharedRecords(library, {
      skillPageId: input.skillPageId,
      kind: "operation",
      entityId: fileAddAcceptanceReviewsEntity,
      payloadContainsBody: true,
    })
    const reviewHeaders = relevant.filter(
      (header) => header.entity_id === fileAddAcceptanceReviewsEntity,
    )
    if (
      reviews.length !== reviewHeaders.length ||
      reviews.some(
        (row) =>
          !reviewHeaders.some(
            (header) => header.record_id === row.record_id && header.hash === row.hash,
          ),
      )
    )
      return yield* refusal("An indexed complete independent review is missing or changed.")
    const expectedOutcomes = new Set<string>()
    for (const row of reviews) {
      const parsed = yield* checked(() =>
        Schema.decodeUnknownSync(Review)(row.payload, { onExcessProperty: "error" }),
      )
      const retained = yield* original(library, input.skillPageId, parsed.original_operation_id)
      const review = yield* validateReview(parsed, retained)
      if (
        row.record_id !== reviewRecordId(review.operation_id) ||
        row.operation_id !== review.operation_id ||
        !input.headers.some(
          (header) =>
            header.record_id === retained.plan.operation_id && header.hash === retained.row.hash,
        ) ||
        !input.headers.some(
          (header) =>
            header.record_id === retained.outcomeRow.record_id &&
            header.hash === retained.outcomeRow.hash,
        )
      )
        return yield* refusal(
          "The independent review is orphaned from its exact original indexed plan or failure.",
        )
      expectedOutcomes.add(completionRecordId(review.operation_id))
      const result = yield* completedSharedFileAddAcceptance(library, retained.plan, input)
      if (result !== undefined) completed.add(retained.plan.operation_id)
    }
    if (
      relevant.some(
        (header) =>
          header.entity_id === fileAddAcceptanceOutcomesEntity &&
          !expectedOutcomes.has(header.record_id),
      )
    )
      return yield* refusal("An independent acceptance has no complete indexed author review.")
    return completed
  })
}

export function reviewSharedFileAddAcceptance(input: {
  readonly library: SharedLibrary
  readonly skillPageId: string
  readonly originalOperationId: string
  readonly acceptedObservedSha256: string
}) {
  return Effect.gen(function* () {
    const retained = yield* original(input.library, input.skillPageId, input.originalOperationId)
    yield* writerAuthority(input.library, retained.plan)
    const baseline = yield* (yield* Store).readJson(
      `snapshots/${retained.plan.snapshot_id}.json`,
      SnapshotSchema,
    )
    if (baseline === undefined)
      return yield* refusal(
        "The original complete author snapshot is required for a new independent decision.",
      )
    return yield* currentReview(input.library, retained, baseline, input.acceptedObservedSha256)
  }).pipe(withReadOnlyNotion, (effect) =>
    withNotionRequestAttribution(effect, {
      phase: "author_preflight",
      skill_page_id: input.skillPageId,
      operation_id: input.originalOperationId,
    }),
  )
}

export function applySharedFileAddAcceptance(input: {
  readonly library: SharedLibrary
  readonly review: unknown
  readonly reviewId: string
  readonly dryRun?: boolean
}) {
  return Effect.gen(function* () {
    const parsed = yield* checked(() =>
      Schema.decodeUnknownSync(Review)(input.review, { onExcessProperty: "error" }),
    )
    const retained = yield* original(
      input.library,
      parsed.skill_page_id,
      parsed.original_operation_id,
    )
    const review = yield* validateReview(parsed, retained, input.reviewId)
    const complete = yield* completedSharedFileAddAcceptance(input.library, retained.plan)
    if (complete !== undefined) {
      if (complete.review_id !== review.review_id)
        return yield* refusal(
          "Another immutable review already completed this independent decision.",
        )
      return { ...complete, reused: true }
    }
    const revalidate = Effect.gen(function* () {
      yield* writerAuthority(input.library, retained.plan)
      const freshOriginal = yield* original(
        input.library,
        parsed.skill_page_id,
        parsed.original_operation_id,
      )
      const fresh = yield* currentReview(
        input.library,
        freshOriginal,
        review.baseline,
        review.accepted_observed_sha256,
        review,
      )
      if (!same(fresh, review))
        return yield* refusal(
          "The complete reviewed current tree changed before an independent acceptance dispatch.",
        )
    }).pipe((effect) =>
      withNotionRequestAttribution(effect, {
        phase: "author_preflight",
        skill_page_id: review.skill_page_id,
        operation_id: review.operation_id,
      }),
    )
    yield* revalidate
    if (input.dryRun)
      return {
        ...reviewed(review),
        status: "planned" as const,
        verified: false as const,
        dry_run: true as const,
        write_plan: {
          native_page_creates: 0,
          native_body_patches: 0,
          original_add_event: "not_dispatched",
          immutable_records: 3,
          original_outcome: "needs_review",
        },
      }
    const dispatch = yield* sharedCreateDispatch(
      input.library,
      { operation_id: review.operation_id, skill_id: review.skill_id },
      revalidate,
    )
    if (!(yield* dispatch.canResume))
      return yield* refusal(
        "A prior independent Record dispatch remains unknown; observe it without sending it again.",
      )
    const apply = Effect.gen(function* () {
      const retainedReview = yield* appendSharedRecord(input.library, {
        mode: "create",
        recordId: reviewRecordId(review.operation_id),
        operationId: review.operation_id,
        skillPageId: review.skill_page_id,
        kind: "operation",
        entityId: fileAddAcceptanceReviewsEntity,
        payload: review,
        payloadContainsBody: true,
      })
      const eventRow = yield* appendSharedRecord(input.library, {
        mode: "create",
        recordId: review.event.event_id,
        operationId: review.event.event_id,
        skillPageId: review.skill_page_id,
        kind: "file_event",
        entityId: review.file_id,
        payload: review.event,
      })
      yield* appendSharedRecord(input.library, {
        mode: "create",
        recordId: completionRecordId(review.operation_id),
        operationId: review.operation_id,
        skillPageId: review.skill_page_id,
        kind: "operation",
        entityId: fileAddAcceptanceOutcomesEntity,
        payload: {
          version: 1,
          kind: "file_add_current_acceptance",
          operation_id: review.operation_id,
          original_operation_id: review.original_operation_id,
          original_status: "needs_review",
          original_completion: "unproven",
          decision: "accepted_current_file",
          review_id: review.review_id,
          review_record_sha256: retainedReview.hash,
          event_id: review.event.event_id,
          event_record_sha256: eventRow.hash,
        },
      })
    }).pipe(Effect.provideService(Notion, dispatch.api), (effect) =>
      withNotionRequestAttribution(effect, {
        phase: "author_apply",
        skill_page_id: review.skill_page_id,
        operation_id: review.operation_id,
      }),
    )
    yield* apply
    const result = yield* withNotionRequestAttribution(
      completedSharedFileAddAcceptance(input.library, retained.plan),
      {
        phase: "author_verify",
        skill_page_id: review.skill_page_id,
        operation_id: review.operation_id,
      },
    )
    if (result === undefined)
      return yield* refusal(
        "The independent decision is not yet completely visible; reconcile its exact facts without replay.",
      )
    return result
  })
}

export function reconcileSharedFileAddAcceptance(input: {
  readonly library: SharedLibrary
  readonly skillPageId: string
  readonly originalOperationId: string
}) {
  return Effect.gen(function* () {
    const retained = yield* original(input.library, input.skillPageId, input.originalOperationId)
    const result = yield* completedSharedFileAddAcceptance(input.library, retained.plan)
    if (result === undefined)
      return yield* refusal(
        "No complete independent acceptance is retained. Reconcile never writes or supplies a missing original ACK.",
      )
    return result
  }).pipe(withReadOnlyNotion, (effect) =>
    withNotionRequestAttribution(effect, {
      phase: "reconcile",
      skill_page_id: input.skillPageId,
      operation_id: input.originalOperationId,
    }),
  )
}
