import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { fail, property, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { pageId } from "./ref.ts"
import { sharedCreateDispatch } from "./shared-create-dispatch.ts"
import { retainSharedCreateText } from "./shared-create-text-retention.ts"
import {
  createChecked,
  sharedCreateFiles,
  sharedCreateManifestEntity,
  validateSharedCreatePlan,
  type SharedCreatePlan,
} from "./shared-create-model.ts"
import {
  decodeSharedCreateOutcome,
  sharedCreateManifestRecordHash,
  sharedCreateOutcomeId,
  SharedCreateOutcomeSchema,
} from "./shared-create-outcome.ts"
import { observeSharedCreatePrefixBody } from "./shared-create-recovery-prefix-model.ts"
import {
  equivalentResourceNote,
  sharedCreateResourceDescription,
} from "./shared-create-resources.ts"
import {
  loadSharedCreatePlan,
  verifySharedCreateRecoveryIndex,
  verifySharedCreateRecoveryScope,
} from "./shared-create.ts"
import { FileEventSchema, normalizeObservedBody, type FileEvent } from "./shared-file-state.ts"
import { readSharedFileSourceContext } from "./shared-file-source-context.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import { preservesSharedLibraryBindings, type SharedLibrary } from "./shared-library-model.ts"
import { assertImportedMarkdownContent } from "./shared-import-markdown.ts"
import { projectSharedNotionMarkdown } from "./shared-notion-projection.ts"
import { querySharedOperationIndex, type SharedOperationHeader } from "./shared-operation-index.ts"
import {
  pendingFileOperations,
  sharedPendingObservationPrefix,
} from "./shared-pending-file-operations.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  validateSharedRecordEnvelope,
} from "./shared-records.ts"
import { loadSharedResourceContent } from "./shared-resource-content.ts"
import { sourceField } from "./shared-source-definitions.ts"
import { sha256 } from "./store.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const OperationId = Schema.String.check(Schema.isPattern(/^create-accept-[a-f0-9]{64}$/u))
const Review = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("skill_create_current_tree_review"),
  operation_id: OperationId,
  review_id: Schema.String.check(Schema.isPattern(/^create-tree-review-[a-f0-9]{64}$/u)),
  decision: Schema.Literal("accept_complete_current_tree"),
  original_operation_id: Schema.String,
  original_plan_sha256: Hash,
  original_manifest_sha256: Hash,
  original_outcome_sha256: Hash,
  original_status: Schema.Literal("needs_review"),
  original_completion: Schema.Literal("unproven"),
  library_id: Schema.String,
  skill_id: Schema.String,
  skill_page_id: Schema.String,
  metadata_sha256: Hash,
  bindings: SharedCreateOutcomeSchema.members[0].fields.bindings,
  observations: Schema.Array(
    Schema.Struct({
      file_id: Schema.String,
      page_id: Schema.String,
      raw_sha256: Hash,
      raw_bytes: Schema.Number,
      normalized_sha256: Hash,
    }),
  ),
  events: Schema.Array(FileEventSchema),
})
export type SharedCreateCurrentTreeReview = typeof Review.Type
const Completion = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("skill_create_current_tree_acceptance"),
  operation_id: OperationId,
  original_operation_id: Schema.String,
  original_status: Schema.Literal("needs_review"),
  original_completion: Schema.Literal("unproven"),
  decision: Schema.Literal("accepted_complete_current_tree"),
  review_id: Schema.String,
  review_record_sha256: Hash,
  event_records: Schema.Array(Schema.Struct({ event_id: Schema.String, sha256: Hash })),
})
export const sharedCreateCurrentReviewsEntity = "skill-create-current-reviews-v1"
export const sharedCreateCurrentAcceptancesEntity = "skill-create-current-acceptances-v1"
const same = (a: unknown, b: unknown) => canonicalSharedJson(a) === canonicalSharedJson(b)
const hash = (value: unknown) => sha256(canonicalSharedJson(value))
const refusal = (message: string) =>
  Effect.fail(fail("SHARED_CREATE_CURRENT_TREE_REQUIRED", message))
const identity = (plan: SharedCreatePlan) =>
  hash([1, "complete_current_tree", plan.library.library_id, plan.operation_id]).pipe(
    Effect.map((value) => "create-accept-" + value),
  )
const reviewRecordId = (id: string) => "review-" + id
const completionRecordId = (id: string) => "outcome-" + id
const recordHash = (operation: string, payload: unknown) =>
  hash({ version: 1, operation_id: operation, payload })

function eligiblePlan(input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedCreatePlan(input)
    if (
      plan.version !== 1 ||
      plan.complete_resources !== 1 ||
      plan.content_kind !== "skill" ||
      plan.enabled !== false ||
      plan.default_context ||
      plan.source_projection !== undefined ||
      plan.members.length !== 0 ||
      (plan.requires?.length ?? 0) !== 0 ||
      plan.files.some(
        (file) => file.projection.version !== 13 || file.projection.normalization_version !== 1,
      ) ||
      sharedCreateFiles(plan).some(
        (file) =>
          file.event.kind !== "adopted" ||
          file.event.parents.length !== 0 ||
          file.ancestors !== undefined,
      )
    )
      return yield* refusal(
        "Select only a disabled ordinary complete policy-13 native tree, with no Source, membership or prior ownership.",
      )
    return plan
  })
}

/** Full original shared input and a known failure, never a local ACK inference. */
function original(library: SharedLibrary, input: SharedCreatePlan, page: string) {
  return Effect.gen(function* () {
    const plan = yield* eligiblePlan(input)
    if (!preservesSharedLibraryBindings(plan.library, library) || pageId(page) !== page)
      return yield* refusal("The original owner and library must be exact.")
    const retained = yield* loadSharedCreatePlan(library, {
      skillPageId: page,
      operationId: plan.operation_id,
    })
    if (!same(retained, plan))
      return yield* refusal("The retained complete original input differs from the selected plan.")
    for (const file of plan.files)
      yield* retainSharedCreateText(library, page, file.projection.markdown, "body", "reconcile")
    const rows = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      recordId: sharedCreateOutcomeId(plan.operation_id),
    })
    const row = rows[0]
    if (rows.length !== 1 || row === undefined)
      return yield* refusal(
        "An absent or unknown original outcome cannot authorize current-tree acceptance.",
      )
    const outcome = yield* createChecked(() => decodeSharedCreateOutcome(row))
    const all = sharedCreateFiles(plan)
    if (
      outcome.version !== 1 ||
      outcome.status !== "needs_review" ||
      outcome.reason_code !== "SHARED_CREATE_BODY_MISMATCH" ||
      outcome.skill_page_id !== page ||
      outcome.skill_id !== plan.skill_id ||
      outcome.operation_id !== plan.operation_id ||
      outcome.projection_repair !== undefined ||
      outcome.source_projection !== undefined ||
      outcome.bindings.length !== all.length ||
      new Set(outcome.bindings.map((item) => item.page_id)).size !== all.length ||
      all.some(
        (file) =>
          !outcome.bindings.some(
            (binding) =>
              binding.file_id === file.file_id &&
              binding.path === file.path &&
              binding.event_id === file.event.event_id &&
              (file.path === plan.entrypoint ? binding.page_id === page : binding.page_id !== page),
          ),
      )
    )
      return yield* refusal(
        "The known original mismatch must identify every unique original File/page, including all raw resources.",
      )
    return { plan, row, outcome, manifestHash: yield* sharedCreateManifestRecordHash(plan) }
  })
}
type Original = Effect.Success<ReturnType<typeof original>>

function adoptionEvents(plan: SharedCreatePlan, operation: string) {
  return Effect.forEach(sharedCreateFiles(plan), (file) =>
    Effect.gen(function* () {
      const fields = {
        kind: "adopted" as const,
        file_id: file.file_id,
        parents: [],
        content: file.content,
      }
      return {
        ...fields,
        event_id: "adopt-" + (yield* hash({ version: 1, operation_id: operation, ...fields })),
      }
    }),
  )
}

function validateReview(input: unknown, retained: Original, expectedId?: string) {
  return Effect.gen(function* () {
    const review = yield* createChecked(() =>
      Schema.decodeUnknownSync(Review)(input, { onExcessProperty: "error" }),
    )
    const { review_id, ...fields } = review
    const { plan, row, outcome, manifestHash } = retained
    if (
      (expectedId !== undefined && review_id !== expectedId) ||
      review_id !== "create-tree-review-" + (yield* hash(fields)) ||
      review.operation_id !== (yield* identity(plan)) ||
      review.original_operation_id !== plan.operation_id ||
      review.original_plan_sha256 !== (yield* hash(plan)) ||
      review.original_manifest_sha256 !== manifestHash ||
      review.original_outcome_sha256 !== row.hash ||
      review.library_id !== plan.library.library_id ||
      review.skill_id !== plan.skill_id ||
      review.skill_page_id !== outcome.skill_page_id ||
      !same(review.bindings, outcome.bindings) ||
      !same(review.events, yield* adoptionEvents(plan, review.operation_id)) ||
      review.observations.length !== review.bindings.length ||
      review.observations.some(
        (item, index) =>
          item.file_id !== review.bindings[index]?.file_id ||
          item.page_id !== review.bindings[index]?.page_id,
      )
    )
      return yield* refusal(
        "The independent review must bind its complete original input, known failure, pages and distinct ownership facts.",
      )
    yield* createChecked(() => validateSharedRecordEnvelope(review.operation_id, review))
    return review
  })
}

function eventRecords(library: SharedLibrary, page: string) {
  return querySharedRecords(library, { skillPageId: page, kind: "file_event" }).pipe(
    Effect.flatMap((rows) =>
      createChecked(() =>
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
              "SHARED_CREATE_CURRENT_TREE_REQUIRED",
              "A current ownership fact has a foreign identity.",
            )
          return { row, event }
        }),
      ),
    ),
  )
}

/** Every first new Record dispatch re-observes the whole current tree. */
function currentReview(
  library: SharedLibrary,
  retained: Original,
  existing?: SharedCreateCurrentTreeReview,
) {
  return Effect.gen(function* () {
    const { plan, row, outcome, manifestHash } = retained,
      page = outcome.skill_page_id
    yield* verifySharedCreateRecoveryScope(library, plan, page, "allocated")
    const index = yield* verifySharedCreateRecoveryIndex(
      library,
      plan,
      page,
      outcome.bindings,
      false,
    )
    const api = yield* Notion,
      raw = yield* api.request(`v1/pages/${page}`)
    if (
      index.file_links !== "" ||
      index.main.baseline !== undefined ||
      index.files.some((file) => file.baseline !== undefined || file.display_status !== "custom") ||
      !same(yield* readSharedFileSourceContext(library, page, raw), {
        selected_version: "",
        definition: null,
      })
    )
      return yield* refusal(
        "The current tree must retain its original native binding without a Source or projection.",
      )
    const properties = Object.values(property(property(raw).properties)).map(property)
    // The reverse Files relation is an allocation binding, not Source ancestry.
    // Registered source/membership relations must stay empty; a complete Files
    // relation, when exposed, must contain exactly the same supporting pages.
    const filePages = index.files.map((file) => file.page_id).sort()
    for (const value of properties.filter((item) => item.type === "relation")) {
      if (value.has_more === true || !Array.isArray(value.relation))
        return yield* refusal("A current native relation is incomplete.")
      const ids = value.relation.map((item) => property(item).id).sort()
      const sourceRelation = ["Origin", "Members", "Requires"].some(
        (name) => library.skills.property_ids[name] === value.id,
      )
      if (sourceRelation ? ids.length !== 0 : ids.length !== 0 && !same(ids, filePages))
        return yield* refusal("Only the exact complete Files relation may be nonempty.")
    }
    for (const name of ["Source", "References", "Projection", "Source Member"]) {
      const id = library.skills.property_ids[name]
      if (id === undefined) continue
      const field = sourceField(raw, id)
      if (
        field.has_more === true ||
        field.type !== "rich_text" ||
        !Array.isArray(field.rich_text) ||
        text(field.rich_text) !== ""
      )
        return yield* refusal(
          "The original native source, projection and reference fields must remain complete and empty.",
        )
    }
    const scope = yield* authScope
    if (
      (yield* pendingFileOperations({
        scope,
        library_id: library.library_id,
        skill_id: plan.skill_id,
        skill_page_id: page,
        prefix: yield* sharedPendingObservationPrefix(scope, library.library_id, plan.skill_id),
      })).length !== 0
    )
      return yield* refusal("Another local author operation is pending for this tree.")
    const operation = yield* identity(plan),
      events = yield* adoptionEvents(plan, operation)
    const headers = yield* querySharedOperationIndex(library, page)
    const allowed = new Map([
      [plan.operation_id, manifestHash],
      [row.record_id, row.hash],
    ])
    if (existing !== undefined)
      allowed.set(reviewRecordId(operation), yield* recordHash(operation, existing))
    if (
      headers.some((header) => allowed.get(header.record_id) !== header.hash) ||
      !headers.some(
        (header) =>
          header.record_id === plan.operation_id &&
          header.entity_id === sharedCreateManifestEntity &&
          header.hash === manifestHash,
      ) ||
      !headers.some((header) => header.record_id === row.record_id && header.hash === row.hash)
    )
      return yield* refusal(
        "A third operation, changed original fact or unrelated acceptance blocks this decision.",
      )
    const actualEvents = yield* eventRecords(library, page)
    if (
      actualEvents.length > 0 &&
      (existing === undefined ||
        !headers.some((header) => header.record_id === reviewRecordId(operation)) ||
        actualEvents.some(({ event }) => !events.some((expected) => same(expected, event))))
    )
      return yield* refusal(
        "Only this independent review's exact initial events may already exist; original create events are never supplied.",
      )
    const observations = []
    for (const binding of outcome.bindings) {
      const response = yield* api.request(
        `v1/pages/${binding.page_id}/markdown?markdown_version=v2`,
      )
      const observed = yield* observeSharedCreatePrefixBody(
        binding.file_id,
        binding.page_id,
        response,
      )
      const rawBody = String(property(response).markdown),
        markdown = normalizeObservedBody(rawBody)
      const file = plan.files.find((item) => item.file_id === binding.file_id)
      if (file !== undefined) {
        if (markdown !== file.projection.markdown)
          return yield* refusal(
            "An authored Markdown file differs from its exact frozen policy-13 prediction.",
          )
        yield* createChecked(() =>
          assertImportedMarkdownContent(file.projection.input_markdown, markdown),
        )
      } else {
        const resource = plan.resources!.find((item) => item.file_id === binding.file_id)!
        const expected = projectSharedNotionMarkdown(sharedCreateResourceDescription(resource), {
          version: 13,
          purpose: "data_source_create",
        })
        if (!equivalentResourceNote(markdown, expected.markdown))
          return yield* refusal(
            "A generated resource note differs beyond the existing heading-autolink rule.",
          )
        // Always resolve the remote manifest and every chunk; a warm local byte
        // object, editable note or matching SHA label is not resource authority.
        yield* loadSharedResourceContent(library, {
          skillPageId: page,
          content: resource.prepared.content,
        })
      }
      observations.push({
        file_id: binding.file_id,
        page_id: binding.page_id,
        raw_sha256: yield* sha256(rawBody),
        raw_bytes: new TextEncoder().encode(rawBody).length,
        normalized_sha256: observed.body_sha256,
      })
    }
    const fields = {
      version: 1 as const,
      kind: "skill_create_current_tree_review" as const,
      operation_id: operation,
      decision: "accept_complete_current_tree" as const,
      original_operation_id: plan.operation_id,
      original_plan_sha256: yield* hash(plan),
      original_manifest_sha256: manifestHash,
      original_outcome_sha256: row.hash,
      original_status: "needs_review" as const,
      original_completion: "unproven" as const,
      library_id: library.library_id,
      skill_id: plan.skill_id,
      skill_page_id: page,
      metadata_sha256: yield* hash({
        name: index.name,
        description: index.description,
        kind: index.kind,
        enabled: index.enabled,
        default_context: index.default_context,
        bindings: outcome.bindings,
        registered_properties: Object.fromEntries(
          Object.entries(library.skills.property_ids).map(([name, id]) => [
            name,
            sourceField(raw, id),
          ]),
        ),
      }),
      bindings: outcome.bindings,
      observations,
      events,
    }
    return yield* validateReview(
      { ...fields, review_id: "create-tree-review-" + (yield* hash(fields)) },
      retained,
    )
  })
}

function accepted(review: SharedCreateCurrentTreeReview) {
  return {
    status: "accepted" as const,
    decision: "accepted_complete_current_tree" as const,
    operation_id: review.operation_id,
    review_id: review.review_id,
    page_id: review.skill_page_id,
    original_operation_id: review.original_operation_id,
    original_status: "needs_review" as const,
    original_completion: "unproven" as const,
    original_failure_preserved: true as const,
    verified: true as const,
    requires_fresh_read: true as const,
  }
}

/** Historical independent facts, not a replacement outcome for the old create. */
export function completedSharedCreateCurrentTree(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  page: string,
  observed?: {
    readonly headers: readonly SharedOperationHeader[]
    readonly events: readonly FileEvent[]
  },
) {
  return Effect.gen(function* () {
    const operation = yield* identity(plan),
      completionId = completionRecordId(operation)
    const header = observed?.headers.find((item) => item.record_id === completionId)
    if (observed !== undefined && header === undefined) return undefined
    const rows = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      recordId: completionId,
    })
    const row = rows[0]
    if (row === undefined && header === undefined) return undefined
    if (
      row === undefined ||
      rows.length !== 1 ||
      row.operation_id !== operation ||
      row.entity_id !== sharedCreateCurrentAcceptancesEntity ||
      (header !== undefined && (header.hash !== row.hash || header.entity_id !== row.entity_id))
    )
      return yield* refusal("The independent current-tree completion has a conflicting identity.")
    const completion = yield* createChecked(() =>
      Schema.decodeUnknownSync(Completion)(row.payload, { onExcessProperty: "error" }),
    )
    const retained = yield* original(library, plan, page)
    const reviews = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      recordId: reviewRecordId(operation),
    })
    const reviewRow = reviews[0]
    if (
      reviews.length !== 1 ||
      reviewRow === undefined ||
      reviewRow.operation_id !== operation ||
      reviewRow.entity_id !== sharedCreateCurrentReviewsEntity
    )
      return yield* refusal("The complete independent author review is missing.")
    const review = yield* validateReview(reviewRow.payload, retained)
    if (
      completion.operation_id !== operation ||
      completion.original_operation_id !== plan.operation_id ||
      completion.review_id !== review.review_id ||
      completion.review_record_sha256 !== reviewRow.hash ||
      completion.event_records.length !== review.events.length ||
      (observed !== undefined &&
        !observed.headers.some(
          (item) => item.record_id === reviewRow.record_id && item.hash === reviewRow.hash,
        ))
    )
      return yield* refusal(
        "The independent completion does not bind the complete original decision.",
      )
    const actual = yield* eventRecords(library, page)
    for (const [at, event] of review.events.entries()) {
      const fact = actual.find((item) => item.event.event_id === event.event_id)
      if (
        fact === undefined ||
        !same(fact.event, event) ||
        completion.event_records[at]?.event_id !== event.event_id ||
        completion.event_records[at]?.sha256 !== fact.row.hash ||
        (observed !== undefined && !observed.events.some((item) => same(item, event)))
      )
        return yield* refusal(
          "A complete independent ownership fact is missing or differs; the original event is not a substitute.",
        )
    }
    return accepted(review)
  })
}

export function reviewSharedCreateCurrentTree(input: {
  readonly entry: string
  readonly plan: unknown
  readonly target: string
}) {
  return Effect.gen(function* () {
    const plan = yield* eligiblePlan(input.plan),
      library = yield* loadSharedLibrary(input.entry)
    const retained = yield* original(library, plan, input.target)
    return yield* currentReview(library, retained)
  }).pipe(withReadOnlyNotion)
}

export function applySharedCreateCurrentTree(input: {
  readonly entry: string
  readonly plan: unknown
  readonly review: unknown
  readonly reviewId: string
  readonly dryRun?: boolean
}) {
  return Effect.gen(function* () {
    const plan = yield* eligiblePlan(input.plan),
      library = yield* loadSharedLibrary(input.entry)
    const parsed = yield* createChecked(() =>
      Schema.decodeUnknownSync(Review)(input.review, { onExcessProperty: "error" }),
    )
    const retained = yield* original(library, plan, parsed.skill_page_id)
    const review = yield* validateReview(parsed, retained, input.reviewId)
    const complete = yield* completedSharedCreateCurrentTree(library, plan, review.skill_page_id)
    if (complete !== undefined) {
      if (complete.review_id !== review.review_id)
        return yield* refusal("Another review completed this independent decision.")
      return { ...complete, reused: true }
    }
    const revalidate = Effect.gen(function* () {
      const fresh = yield* original(library, plan, review.skill_page_id)
      if (!same(yield* currentReview(library, fresh, review), review))
        return yield* refusal(
          "The complete current tree changed after review; no new Record is authorized.",
        )
    })
    yield* revalidate
    if (input.dryRun)
      return {
        ...accepted(review),
        status: "planned" as const,
        verified: false as const,
        dry_run: true,
        write_plan: {
          native_page_creates: 0,
          native_body_patches: 0,
          native_property_patches: 0,
          immutable_records: review.events.length + 2,
          original_create_events: "not_dispatched",
          original_outcome: "needs_review",
        },
      }
    const dispatch = yield* sharedCreateDispatch(
      library,
      { operation_id: review.operation_id, skill_id: review.skill_id },
      revalidate,
    )
    if (!(yield* dispatch.canResume))
      return yield* refusal(
        "An independent Record remains unknown. Reconcile its exact fact without resending.",
      )
    yield* Effect.gen(function* () {
      const retainedReview = yield* appendSharedRecord(library, {
        mode: "create",
        kind: "operation",
        recordId: reviewRecordId(review.operation_id),
        operationId: review.operation_id,
        entityId: sharedCreateCurrentReviewsEntity,
        skillPageId: review.skill_page_id,
        payload: review,
      })
      const records = []
      for (const event of review.events) {
        const row = yield* appendSharedRecord(library, {
          mode: "create",
          kind: "file_event",
          recordId: event.event_id,
          operationId: event.event_id,
          entityId: event.file_id,
          skillPageId: review.skill_page_id,
          payload: event,
        })
        records.push({ event_id: event.event_id, sha256: row.hash })
      }
      yield* appendSharedRecord(library, {
        mode: "create",
        kind: "operation",
        recordId: completionRecordId(review.operation_id),
        operationId: review.operation_id,
        entityId: sharedCreateCurrentAcceptancesEntity,
        skillPageId: review.skill_page_id,
        payload: {
          version: 1,
          kind: "skill_create_current_tree_acceptance",
          operation_id: review.operation_id,
          original_operation_id: plan.operation_id,
          original_status: "needs_review",
          original_completion: "unproven",
          decision: "accepted_complete_current_tree",
          review_id: review.review_id,
          review_record_sha256: retainedReview.hash,
          event_records: records,
        },
      })
    }).pipe(Effect.provideService(Notion, dispatch.api))
    const result = yield* completedSharedCreateCurrentTree(library, plan, review.skill_page_id)
    if (result === undefined)
      return yield* refusal(
        "The independent completion is not yet visible. Reconcile; never replace the old failed outcome.",
      )
    return result
  })
}

export function reconcileSharedCreateCurrentTree(input: {
  readonly entry: string
  readonly plan: unknown
  readonly target: string
}) {
  return Effect.gen(function* () {
    const plan = yield* eligiblePlan(input.plan),
      library = yield* loadSharedLibrary(input.entry)
    const result = yield* completedSharedCreateCurrentTree(library, plan, input.target)
    if (result === undefined)
      return yield* refusal(
        "No complete independent current-tree acceptance is visible. Reconcile never writes missing facts or supplies an old ACK.",
      )
    return result
  }).pipe(withReadOnlyNotion)
}
