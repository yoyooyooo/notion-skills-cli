import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { fail, property } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { pageId } from "./ref.ts"
import {
  createChecked,
  sharedCreateManifestEntity,
  sharedCreateOutcomesEntity,
  type SharedCreatePlan,
} from "./shared-create-model.ts"
import {
  sharedCreateMainRequest,
  verifySharedCreateRecoveryScope,
  verifySharedCreateRecoveryIndex,
} from "./shared-create.ts"
import { originalNativeMainAllocation } from "./shared-create-recovery-native-authority.ts"
import {
  assertSharedCreateAcknowledgedMetadata,
  observeSharedCreatePrefixBody,
} from "./shared-create-recovery-prefix-model.ts"
import {
  prepareSharedNativeAllocationProof,
  retainSharedNativeAllocationProofs,
  readSharedNativeAllocationProofs,
} from "./shared-create-recovery-acknowledgements.ts"
import {
  SharedNativeAllocationProofSchema,
  SharedNativeAllocationReferenceSchema,
} from "./shared-create-recovery-acknowledgement-model.ts"
import { sharedCreateDispatch } from "./shared-create-dispatch.ts"
import { guardedSourceMutation } from "./shared-source-definitions.ts"
import { withSourceUpdateLock } from "./shared-source-policy.ts"
import { selectOriginalSourceRecoveryPlan, sourceRecoveryError } from "./shared-source-recovery.ts"
import { SourceMutationAcknowledgementSchema } from "./shared-sources-model.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import { preservesSharedLibraryBindings, type SharedLibrary } from "./shared-library-model.ts"
import {
  assertImportedMarkdownContent,
  assertImportedTablePlusRepairable,
} from "./shared-import-markdown.ts"
import { knownImportTablePlusReadback } from "./shared-import-table-literals.ts"
import {
  projectSharedNotionMarkdown,
  sharedNotionMarkdownWire,
} from "./shared-notion-projection.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  validateSharedRecordEnvelope,
} from "./shared-records.ts"
import { Store, sha256 } from "./store.ts"
import type { SharedCreateProjectionRepairProof } from "./shared-create-outcome.ts"
import type { SharedOperationHeader } from "./shared-operation-index.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Id = Schema.String.check(Schema.isPattern(/^source-projection-repair-[a-f0-9]{64}$/u))
const ReviewV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("source_main_projection_repair"),
  review_id: Id,
  decision: Schema.Literal("repair_original_table_literal_plus"),
  operation_id: Schema.String,
  plan_sha256: Hash,
  permission_scope: Schema.String,
  library_id: Schema.String,
  skill_id: Schema.String,
  skill_page_id: Schema.String,
  file_id: Schema.String,
  path: Schema.Literal("SKILL.md"),
  original_journal_sha256: Hash,
  allocation: SharedNativeAllocationProofSchema,
  allocation_ref: SharedNativeAllocationReferenceSchema,
  before: Schema.Struct({ markdown: Schema.String, sha256: Hash, bytes: Schema.Number }),
  candidate: Schema.Struct({
    policy: Schema.Literal(16),
    wire_sha256: Hash,
    wire_bytes: Schema.Number,
    source_sha256: Hash,
    changed_literals: Schema.Number,
  }),
})
const { response: _responseSchema, ...AckMetadataFields } =
  SourceMutationAcknowledgementSchema.fields
const UnchangedBodyAckSchema = Schema.Struct({
  ...AckMetadataFields,
  response_metadata: Schema.Unknown,
})
const PreviousSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("acknowledged_unchanged_v16"),
    review_id: Id,
    review_record_hash: Hash,
    body_ack: UnchangedBodyAckSchema,
  }),
])
const ReviewV2Schema = Schema.Struct({
  ...ReviewV1Schema.fields,
  version: Schema.Literal(2),
  candidate: Schema.Struct({
    ...ReviewV1Schema.fields.candidate.fields,
    policy: Schema.Literal(17),
  }),
  previous: PreviousSchema,
})
const ReviewSchema = Schema.Union([ReviewV1Schema, ReviewV2Schema])
export type SourceProjectionRepairReview = typeof ReviewSchema.Type
const CompletionSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("source_main_projection_repair_completion"),
  review_id: Id,
  original_operation_id: Schema.String,
  skill_page_id: Schema.String,
  body_operation_id: Schema.String,
  body_ack: SourceMutationAcknowledgementSchema,
  after_sha256: Hash,
  after_bytes: Schema.Number,
})
const reviewsEntity = "source-projection-repair-reviews-v1"
const completionsEntity = "source-projection-repair-completions-v1"
const reviewRecord = (operation: string, policy: 16 | 17) =>
  "source-projection-review-" + (policy === 17 ? "v17-" : "") + operation
const outcomeRecord = (operation: string, policy: 16 | 17) =>
  "source-projection-outcome-" + (policy === 17 ? "v17-" : "") + operation
const same = (a: unknown, b: unknown) => canonicalSharedJson(a) === canonicalSharedJson(b)
const hash = (value: unknown) => sha256(canonicalSharedJson(value))
const refusal = (message: string) => Effect.fail(fail("SOURCE_PROJECTION_REPAIR_REQUIRED", message))
type OriginalInput = {
  readonly entry: string
  readonly plan: unknown
  readonly operationId?: string
}

function repairContext(plan: SharedCreatePlan, library: SharedLibrary) {
  return Effect.gen(function* () {
    if (
      plan.version !== 1 ||
      plan.source_projection?.version !== 2 ||
      plan.content_kind !== "skill" ||
      plan.enabled !== false ||
      plan.default_context !== false ||
      plan.entrypoint !== "SKILL.md" ||
      plan.files.some(
        (file) =>
          file.projection.version !== 14 ||
          file.event.kind !== "source_projection_pending" ||
          file.event.parents.length !== 0 ||
          file.ancestors !== undefined,
      )
    )
      return yield* refusal(
        "Select an original disabled retained-source policy14 import, before its first manifest.",
      )
    if (!preservesSharedLibraryBindings(plan.library, library))
      return yield* refusal("The original input belongs to another registered library.")
    const main = plan.files.find((file) => file.path === plan.entrypoint)
    if (!main) return yield* refusal("The original main file is missing.")
    const previous = yield* createChecked(() =>
      knownImportTablePlusReadback(main.projection.markdown),
    )
    if (previous.changed === 0)
      return yield* refusal("The original main has no supported table-literal plus repair.")
    return { plan, library, main, previous }
  })
}

function candidateWire(context: Effect.Success<ReturnType<typeof repairContext>>, policy: 16 | 17) {
  return createChecked(() =>
    sharedNotionMarkdownWire(
      projectSharedNotionMarkdown(context.main.projection.input_markdown, {
        version: policy,
        purpose: "data_source_create",
      }),
    ),
  )
}

function repairPlan(input: OriginalInput) {
  return Effect.gen(function* () {
    return yield* repairContext(
      yield* selectOriginalSourceRecoveryPlan(input.plan, input.operationId),
      yield* loadSharedLibrary(input.entry),
    )
  })
}

/** A separate body-repair request owns its unresolved state even when a fresh
 * page happens to match the original candidate. The original creator cannot
 * bypass that request by using a different command or a cold author runtime. */
export function assertOriginalSourceProjectionRepairComplete(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  page: string,
  expected?: SharedCreateProjectionRepairProof,
) {
  return Effect.gen(function* () {
    if (plan.version !== 1 || plan.source_projection?.version !== 2) {
      if (expected !== undefined)
        return yield* refusal("A projection repair proof cannot attach to another creation family.")
      return
    }
    const rows = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      entityIds: [reviewsEntity, completionsEntity],
      payloadContainsBody: true,
    })
    if (rows.length === 0 && expected === undefined) return
    const context = yield* repairContext(plan, library)
    const reviews = rows.filter((row) => row.entity_id === reviewsEntity)
    const completions = rows.filter((row) => row.entity_id === completionsEntity)
    if ((reviews.length !== 1 && reviews.length !== 2) || completions.length !== 1)
      return yield* Effect.fail(
        fail(
          "SOURCE_PROJECTION_REPAIR_PENDING",
          "An original-page repair lacks its complete acknowledged outcome; keep the original import stopped.",
          { native_create_operation_id: plan.operation_id, skill_page_id: page },
        ),
      )
    const candidate = property(completions[0]!.payload).review_id
    if (typeof candidate !== "string")
      return yield* refusal("The original repair record has no exact review identity.")
    const selected = reviews.find((row) => property(row.payload).review_id === candidate)
    if (selected === undefined)
      return yield* refusal("The final repair has no matching full review.")
    const proof = yield* validateReview(context, selected.payload, candidate)
    const expectedReviews =
      proof.review.version === 2 && proof.review.previous.kind === "acknowledged_unchanged_v16"
        ? 2
        : 1
    if (
      proof.review.skill_page_id !== page ||
      reviews.length !== expectedReviews ||
      selected.record_id !== reviewRecord(plan.operation_id, proof.review.candidate.policy) ||
      completions[0]!.record_id !== outcomeRecord(plan.operation_id, proof.review.candidate.policy)
    )
      return yield* refusal("The repair evidence belongs to another original operation or page.")
    if ((yield* completion(context, proof.review, proof)) === undefined)
      return yield* Effect.fail(
        fail(
          "SOURCE_PROJECTION_REPAIR_PENDING",
          "The independent original-page repair has not completed.",
        ),
      )
    const commitment = {
      review_id: candidate,
      review_record_hash: selected.hash,
      outcome_record_hash: completions[0]!.hash,
    }
    if (expected !== undefined && !same(commitment, expected))
      return yield* refusal(
        "The original completion refers to different independent repair evidence.",
      )
    return commitment
  }).pipe(withReadOnlyNotion)
}

/** Header routing only. The original create's outcome commits the complete
 * proof hashes; content consumers still verify every retained fact. */
export function sourceProjectionRepairOriginal(
  header: SharedOperationHeader,
  operations: readonly SharedOperationHeader[],
) {
  const prefix =
    header.entity_id === reviewsEntity
      ? "source-projection-review-"
      : header.entity_id === completionsEntity
        ? "source-projection-outcome-"
        : undefined
  if (prefix === undefined || !header.record_id.startsWith(prefix)) return undefined
  const original = header.record_id.slice(prefix.length).replace(/^v17-/u, "")
  return /^skill-create-[a-f0-9]{64}$/u.test(original) &&
    operations.some(
      (item) => item.record_id === original && item.entity_id === sharedCreateManifestEntity,
    )
    ? original
    : undefined
}

function readBody(page: string, fileId: string) {
  return Effect.gen(function* () {
    const raw = yield* (yield* Notion).request(`v1/pages/${page}/markdown?markdown_version=v2`)
    const observed = yield* observeSharedCreatePrefixBody(fileId, page, raw)
    const markdown = property(raw).markdown
    if (typeof markdown !== "string")
      return yield* refusal("The complete original body is unavailable.")
    return {
      markdown,
      sha256: yield* sha256(markdown),
      bytes: new TextEncoder().encode(markdown).length,
      observed_sha256: observed.body_sha256,
    }
  })
}

/** This narrow repair never assumes a persisted terminal from a CLI failure.
 * Any manifest, later original dispatch, ownership event or altered metadata
 * moves the operation outside the supported sole-main repair state. */
function originalMain(context: Effect.Success<ReturnType<typeof repairPlan>>, page: string) {
  return Effect.gen(function* () {
    const { plan, library } = context
    yield* verifySharedCreateRecoveryScope(library, plan, page)
    const rows = yield* querySharedRecords(library, { skillPageId: page, kind: "operation" })
    if (
      rows.some(
        (row) =>
          row.entity_id === sharedCreateManifestEntity ||
          row.entity_id === sharedCreateOutcomesEntity,
      ) ||
      (yield* querySharedRecords(library, { skillPageId: page, kind: "file_event" })).length !== 0
    )
      return yield* refusal(
        "The original create already has a manifest, terminal or published ownership; use its own supported recovery.",
      )
    const allocation = yield* originalNativeMainAllocation(plan, page)
    yield* verifySharedCreateRecoveryIndex(
      library,
      plan,
      page,
      [allocation.binding],
      false,
      true,
      "",
    )
    const raw = yield* (yield* Notion).request(`v1/pages/${page}`)
    yield* createChecked(() =>
      assertSharedCreateAcknowledgedMetadata(sharedCreateMainRequest(library, plan), raw),
    )
    return allocation
  }).pipe(withReadOnlyNotion)
}

export function reviewSharedSourceProjectionRepair(
  input: OriginalInput & { readonly target: string },
) {
  return Effect.gen(function* () {
    const context = yield* repairPlan(input),
      page = pageId(input.target)
    if (!page || page !== input.target)
      return yield* refusal("Select the exact original main page.")
    const allocation = yield* originalMain(context, page)
    const before = yield* readBody(page, context.main.file_id)
    // Only the known table mutation is repairable here. All surrounding text,
    // code and explicit destinations must still have their original meaning.
    yield* createChecked(() =>
      assertImportedTablePlusRepairable(context.main.projection.markdown, before.markdown),
    )
    if (
      (yield* createChecked(() =>
        assertImportedMarkdownContent(context.main.projection.markdown, before.markdown),
      ).pipe(Effect.result))._tag === "Success"
    )
      return yield* refusal(
        "The original body is already semantically intact; no repair is authorized.",
      )
    const previous = yield* inspectPreviousAttempt(context, page, before.markdown)
    const wire = yield* candidateWire(context, 17)
    const fields = {
      version: 2 as const,
      kind: "source_main_projection_repair" as const,
      decision: "repair_original_table_literal_plus" as const,
      operation_id: context.plan.operation_id,
      plan_sha256: yield* hash(context.plan),
      permission_scope: yield* authScope,
      library_id: context.library.library_id,
      skill_id: context.plan.skill_id,
      skill_page_id: page,
      file_id: context.main.file_id,
      path: "SKILL.md" as const,
      original_journal_sha256: allocation.bootstrap.original_journal_sha256,
      allocation: allocation.proof.payload,
      allocation_ref: allocation.proof.reference,
      before: { markdown: before.markdown, sha256: before.sha256, bytes: before.bytes },
      previous,
      candidate: {
        policy: 17 as const,
        wire_sha256: yield* sha256(wire),
        wire_bytes: new TextEncoder().encode(wire).length,
        source_sha256: context.main.input.sha256,
        changed_literals: context.previous.changed,
      },
    }
    const review = { ...fields, review_id: "source-projection-repair-" + (yield* hash(fields)) }
    yield* createChecked(() => validateSharedRecordEnvelope(review.review_id, review, "operation"))
    const current = yield* querySharedRecords(context.library, {
      skillPageId: page,
      kind: "operation",
      entityId: reviewsEntity,
      recordId: reviewRecord(context.plan.operation_id, 17),
    })
    if (current.length > 1 || (current.length === 1 && !same(current[0]!.payload, review)))
      return yield* refusal(
        "Another v17 repair already owns this original page; do not replace an unresolved review.",
      )
    return review
  }).pipe(withReadOnlyNotion)
}

function validateReview(
  context: Effect.Success<ReturnType<typeof repairPlan>>,
  input: unknown,
  expected: string,
) {
  return Effect.gen(function* () {
    const review = yield* createChecked(() =>
      Schema.decodeUnknownSync(ReviewSchema)(input, { onExcessProperty: "error" }),
    )
    const { review_id, ...fields } = review
    const wire = yield* candidateWire(context, review.candidate.policy)
    if (
      review_id !== expected ||
      review_id !== "source-projection-repair-" + (yield* hash(fields)) ||
      review.operation_id !== context.plan.operation_id ||
      review.plan_sha256 !== (yield* hash(context.plan)) ||
      review.library_id !== context.library.library_id ||
      review.skill_id !== context.plan.skill_id ||
      pageId(review.skill_page_id) !== review.skill_page_id ||
      review.file_id !== context.main.file_id ||
      review.candidate.wire_sha256 !== (yield* sha256(wire)) ||
      review.candidate.wire_bytes !== new TextEncoder().encode(wire).length ||
      review.candidate.source_sha256 !== context.main.input.sha256 ||
      review.candidate.changed_literals !== context.previous.changed ||
      review.before.sha256 !== (yield* sha256(review.before.markdown)) ||
      review.before.bytes !== new TextEncoder().encode(review.before.markdown).length
    )
      return yield* refusal("The complete reviewed input, preimage or candidate digest changed.")
    yield* createChecked(() =>
      assertImportedTablePlusRepairable(context.main.projection.markdown, review.before.markdown),
    )
    const binding = {
      file_id: context.main.file_id,
      path: context.main.path,
      page_id: review.skill_page_id,
      event_id: context.main.event.event_id,
    }
    const proof = yield* prepareSharedNativeAllocationProof(
      context.plan,
      review.skill_page_id,
      binding,
      review.allocation.acknowledgement,
      { attemptId: context.plan.operation_id, file: context.main },
    )
    if (!same(proof.payload, review.allocation) || !same(proof.reference, review.allocation_ref))
      return yield* refusal("The reviewed original main allocation proof changed.")
    return { review, proof, binding, wire }
  })
}

function bodyRequest(review: SourceProjectionRepairReview, wire: string) {
  return {
    identity: review.review_id + ":body",
    path: `v1/pages/${review.skill_page_id}/markdown`,
    method: "PATCH" as const,
    body: {
      type: "update_content",
      markdown_version: "v2",
      update_content: { content_updates: [{ old_str: review.before.markdown, new_str: wire }] },
    },
  }
}

function verifyBodyAck(review: SourceProjectionRepairReview, wire: string, input: unknown) {
  return Effect.gen(function* () {
    const ack = yield* createChecked(() =>
      Schema.decodeUnknownSync(SourceMutationAcknowledgementSchema)(input, {
        onExcessProperty: "error",
      }),
    )
    const request = bodyRequest(review, wire),
      operation = "source-op-" + (yield* hash(request))
    const body = property(ack.response)
    if (
      ack.operation_id !== operation ||
      ack.request_hash !== (yield* hash({ version: 1, operation, ...request })) ||
      ack.response_hash !== (yield* hash(ack.response)) ||
      !Number.isSafeInteger(ack.acknowledged_at) ||
      ack.acknowledged_at < 0
    )
      return yield* refusal(
        "The body result lacks its exact independent request and durable acknowledgement.",
      )
    yield* observeSharedCreatePrefixBody(review.file_id, review.skill_page_id, body)
    if (typeof body.markdown !== "string")
      return yield* refusal("The acknowledged complete body is missing.")
    return {
      ack,
      markdown: body.markdown,
      sha256: yield* sha256(body.markdown),
      bytes: new TextEncoder().encode(body.markdown).length,
    }
  })
}

/** Lossless evidence codec for a specifically proven no-op: the old review
 * already retains the exact response Markdown. Hashes still commit the complete
 * original ACK; never alter the original response or raise ordinary fact limits. */
function compactUnchangedAck(
  ack: typeof SourceMutationAcknowledgementSchema.Type,
  markdown: string,
) {
  const response = property(ack.response)
  if (response.markdown !== markdown)
    throw fail(
      "SOURCE_PROJECTION_REPAIR_REQUIRED",
      "Only an exact unchanged response can use this proof codec.",
    )
  const { markdown: _body, ...response_metadata } = response
  const { response: _response, ...metadata } = ack
  return { ...metadata, response_metadata }
}
function expandUnchangedAck(proof: typeof UnchangedBodyAckSchema.Type, markdown: string) {
  const value = proof.response_metadata
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.hasOwn(value, "markdown")
  )
    throw fail(
      "SOURCE_PROJECTION_REPAIR_REQUIRED",
      "The no-op response metadata cannot replace its exact retained Markdown.",
    )
  const { response_metadata: _metadata, ...ack } = proof
  return { ...ack, response: { ...property(value), markdown } }
}

function oldAttemptRecords(
  context: Effect.Success<ReturnType<typeof repairContext>>,
  page: string,
) {
  return querySharedRecords(context.library, {
    skillPageId: page,
    kind: "operation",
    entityIds: [reviewsEntity, completionsEntity],
    payloadContainsBody: true,
  }).pipe(
    Effect.map((rows) =>
      rows.filter(
        (row) =>
          row.record_id === reviewRecord(context.plan.operation_id, 16) ||
          row.record_id === outcomeRecord(context.plan.operation_id, 16),
      ),
    ),
  )
}

/** The sole supported successor is a known acknowledged v16 no-op. An absent
 * response, a changed current page or a successful/other predecessor cannot
 * become a new permission by regenerating a review. */
function inspectPreviousAttempt(
  context: Effect.Success<ReturnType<typeof repairContext>>,
  page: string,
  before: string,
) {
  return Effect.gen(function* () {
    const records = yield* oldAttemptRecords(context, page)
    if (records.length === 0) return { kind: "none" as const }
    if (
      records.length !== 1 ||
      records[0]!.record_id !== reviewRecord(context.plan.operation_id, 16) ||
      records[0]!.entity_id !== reviewsEntity
    )
      return yield* refusal("The predecessor is not a single unresolved v16 review.")
    const row = records[0]!,
      legacy = yield* createChecked(() =>
        Schema.decodeUnknownSync(ReviewV1Schema)(row.payload, { onExcessProperty: "error" }),
      )
    const proof = yield* validateReview(context, legacy, legacy.review_id)
    if (
      row.operation_id !== legacy.review_id ||
      legacy.skill_page_id !== page ||
      legacy.before.markdown !== before
    )
      return yield* refusal(
        "The current page or predecessor review changed; no new submission is authorized.",
      )
    const request = bodyRequest(legacy, proof.wire),
      operation = "source-op-" + (yield* hash(request))
    const namespace = yield* hash([
      yield* (yield* Notion).credentialIdentity,
      context.library.library_id,
      context.library.sources?.data_source_id ?? null,
    ])
    const store = yield* Store,
      prefix = `operations/shared-sources/${namespace}/`
    const dispatched = yield* store.readJson(prefix + operation + ".json", Schema.Unknown)
    const ack = yield* store.readJson(
      prefix + "source-ack-" + operation.slice("source-op-".length) + ".json",
      SourceMutationAcknowledgementSchema,
    )
    if (!same(dispatched, { version: 1, operation, ...request }) || ack === undefined)
      return yield* refusal(
        "The prior body write has no complete original dispatch and durable ACK; never supersede an unknown write.",
      )
    const acknowledged = yield* verifyBodyAck(legacy, proof.wire, ack)
    if (acknowledged.markdown !== legacy.before.markdown)
      return yield* refusal(
        "The prior write did not acknowledge the exact unchanged body; this successor does not authorize another case.",
      )
    return {
      kind: "acknowledged_unchanged_v16" as const,
      review_id: legacy.review_id,
      review_record_hash: row.hash,
      body_ack: yield* createChecked(() =>
        compactUnchangedAck(acknowledged.ack, legacy.before.markdown),
      ),
    }
  }).pipe(withReadOnlyNotion)
}

/** Shared immutable predecessor evidence, independent of the author Store. */
function verifyPreviousAttempt(
  context: Effect.Success<ReturnType<typeof repairContext>>,
  review: typeof ReviewV2Schema.Type,
) {
  return Effect.gen(function* () {
    const records = yield* oldAttemptRecords(context, review.skill_page_id)
    if (review.previous.kind === "none") {
      if (records.length !== 0)
        return yield* refusal(
          "A prior original repair exists but is missing from the successor review.",
        )
      return
    }
    const prior = review.previous
    if (
      records.length !== 1 ||
      records[0]!.record_id !== reviewRecord(context.plan.operation_id, 16) ||
      records[0]!.entity_id !== reviewsEntity ||
      records[0]!.hash !== prior.review_record_hash ||
      records[0]!.operation_id !== prior.review_id
    )
      return yield* refusal(
        "The complete exact preceding repair review is missing or differs from the successor.",
      )
    const legacy = yield* createChecked(() =>
      Schema.decodeUnknownSync(ReviewV1Schema)(records[0]!.payload, { onExcessProperty: "error" }),
    )
    const proof = yield* validateReview(context, legacy, prior.review_id)
    const exactAck = yield* createChecked(() =>
      expandUnchangedAck(prior.body_ack, legacy.before.markdown),
    )
    const acknowledged = yield* verifyBodyAck(legacy, proof.wire, exactAck)
    if (
      legacy.skill_page_id !== review.skill_page_id ||
      !same(legacy.allocation, review.allocation) ||
      legacy.original_journal_sha256 !== review.original_journal_sha256 ||
      !same(legacy.before, review.before) ||
      acknowledged.markdown !== legacy.before.markdown
    )
      return yield* refusal(
        "The predecessor ACK does not prove the unchanged exact original page and preimage.",
      )
  }).pipe(withReadOnlyNotion)
}

function completion(
  context: Effect.Success<ReturnType<typeof repairPlan>>,
  review: SourceProjectionRepairReview,
  proof: Effect.Success<ReturnType<typeof validateReview>>,
) {
  return Effect.gen(function* () {
    if (review.version === 2) yield* verifyPreviousAttempt(context, review)
    const rows = yield* querySharedRecords(context.library, {
      skillPageId: review.skill_page_id,
      kind: "operation",
      entityId: completionsEntity,
      recordId: outcomeRecord(review.operation_id, review.candidate.policy),
    })
    if (rows.length === 0) return undefined
    if (rows.length !== 1) return yield* refusal("The repair completion is duplicated.")
    const outcome = yield* createChecked(() =>
      Schema.decodeUnknownSync(CompletionSchema)(rows[0]!.payload, { onExcessProperty: "error" }),
    )
    const reviews = yield* querySharedRecords(context.library, {
      skillPageId: review.skill_page_id,
      kind: "operation",
      entityId: reviewsEntity,
      recordId: reviewRecord(review.operation_id, review.candidate.policy),
    })
    if (
      reviews.length !== 1 ||
      !same(reviews[0]!.payload, review) ||
      reviews[0]!.operation_id !== review.review_id ||
      rows[0]!.operation_id !== review.review_id ||
      outcome.review_id !== review.review_id ||
      outcome.original_operation_id !== context.plan.operation_id ||
      outcome.skill_page_id !== review.skill_page_id
    )
      return yield* refusal("Repair completion does not bind the full original review and page.")
    yield* readSharedNativeAllocationProofs(
      context.library,
      context.plan,
      review.skill_page_id,
      [proof.binding],
      [review.allocation_ref],
      () => ({ attemptId: context.plan.operation_id, file: context.main }),
    )
    const body = yield* verifyBodyAck(review, proof.wire, outcome.body_ack)
    yield* createChecked(() =>
      assertImportedMarkdownContent(context.main.projection.markdown, body.markdown),
    )
    if (
      outcome.body_operation_id !== body.ack.operation_id ||
      outcome.after_sha256 !== body.sha256 ||
      outcome.after_bytes !== body.bytes
    )
      return yield* refusal("The completion differs from its full acknowledged native body.")
    return {
      status: "reconciled" as const,
      verified: true,
      review_id: review.review_id,
      operation_id: context.plan.operation_id,
      page_id: review.skill_page_id,
      file_id: review.file_id,
      body_operation_id: outcome.body_operation_id,
      original_creation_completed: false,
      current_body_verified: false,
      requires_fresh_read: true,
      remote_writes: 0 as const,
    }
  }).pipe(withReadOnlyNotion)
}

type ApplyInput = OriginalInput & {
  readonly review: unknown
  readonly reviewId: string
  readonly dryRun?: boolean
}
export function applySharedSourceProjectionRepair(input: ApplyInput) {
  return Effect.gen(function* () {
    const context = yield* repairPlan(input)
    const action = Effect.gen(function* () {
      const proof = yield* validateReview(context, input.review, input.reviewId),
        review = proof.review
      const done = yield* completion(context, review, proof)
      if (done !== undefined) return done
      if (review.permission_scope !== (yield* authScope))
        return yield* refusal("The original scoped author runtime is required.")
      const assertBefore = Effect.gen(function* () {
        const original = yield* originalMain(context, review.skill_page_id)
        if (
          original.bootstrap.original_journal_sha256 !== review.original_journal_sha256 ||
          !same(original.proof.payload, review.allocation)
        )
          return yield* refusal("The original journal or allocation changed after review.")
        const current = yield* readBody(review.skill_page_id, review.file_id)
        if (current.markdown !== review.before.markdown || current.sha256 !== review.before.sha256)
          return yield* refusal(
            "The exact full original page changed after review; no body write is authorized.",
          )
        if (review.version === 2) {
          const prior = yield* inspectPreviousAttempt(
            context,
            review.skill_page_id,
            current.markdown,
          )
          if (!same(prior, review.previous))
            return yield* refusal("The exact previous acknowledged no-op changed after review.")
        }
      }).pipe(withReadOnlyNotion)
      if (input.dryRun) {
        yield* assertBefore
        return {
          status: "reviewed" as const,
          verified: false,
          review_id: review.review_id,
          operation_id: context.plan.operation_id,
          page_id: review.skill_page_id,
          remote_writes: 0 as const,
          existing_page_body_patches: 1,
          native_pages_created: 0,
          candidate_policy: review.candidate.policy,
        }
      }
      const request = bodyRequest(review, proof.wire)
      const facts = yield* sharedCreateDispatch(
        context.library,
        { operation_id: review.review_id, skill_id: review.skill_id },
        assertBefore,
      )
      // Preserve the reviewed complete preimage and original ACK before the
      // single whole-body match; none of these facts grants another PATCH.
      const retainReview = Effect.gen(function* () {
        yield* assertBefore
        yield* retainSharedNativeAllocationProofs(context.library, review.skill_page_id, [
          proof.proof,
        ])
        yield* appendSharedRecord(context.library, {
          mode: "create",
          kind: "operation",
          skillPageId: review.skill_page_id,
          recordId: reviewRecord(review.operation_id, review.candidate.policy),
          entityId: reviewsEntity,
          operationId: review.review_id,
          payload: review,
          payloadContainsBody: true,
        })
      }).pipe(Effect.provideService(Notion, facts.api))
      const body = yield* guardedSourceMutation(
        context.library,
        {
          ...request,
          repeat: "never",
          beforeDispatch: retainReview,
          observeAcknowledged: (raw) =>
            Effect.gen(function* () {
              const value = property(raw)
              yield* observeSharedCreatePrefixBody(review.file_id, review.skill_page_id, raw)
              if (typeof value.markdown !== "string")
                return yield* refusal("Missing acknowledged full body.")
              const markdown = value.markdown
              yield* createChecked(() =>
                assertImportedMarkdownContent(context.main.projection.markdown, markdown),
              )
              return { page_id: review.skill_page_id, full_body_sha256: yield* sha256(markdown) }
            }),
        },
        Effect.succeed(undefined),
      )
      if (!("verified" in body) || body.verified !== true)
        return yield* refusal(
          "The original body request remains unknown; current equality cannot authorize replay.",
        )
      const namespace = yield* hash([
        yield* (yield* Notion).credentialIdentity,
        context.library.library_id,
        context.library.sources?.data_source_id ?? null,
      ])
      const savedAck = yield* (yield* Store).readJson(
        `operations/shared-sources/${namespace}/source-ack-${body.operation_id.slice("source-op-".length)}.json`,
        SourceMutationAcknowledgementSchema,
      )
      const acknowledged = yield* verifyBodyAck(review, proof.wire, savedAck)
      yield* createChecked(() =>
        assertImportedMarkdownContent(context.main.projection.markdown, acknowledged.markdown),
      )
      const outcome = {
        version: 1 as const,
        kind: "source_main_projection_repair_completion" as const,
        review_id: review.review_id,
        original_operation_id: context.plan.operation_id,
        skill_page_id: review.skill_page_id,
        body_operation_id: body.operation_id,
        body_ack: acknowledged.ack,
        after_sha256: acknowledged.sha256,
        after_bytes: acknowledged.bytes,
      }
      const afterDispatch = yield* sharedCreateDispatch(context.library, {
        operation_id: review.review_id,
        skill_id: review.skill_id,
      })
      yield* appendSharedRecord(context.library, {
        mode: "create",
        kind: "operation",
        skillPageId: review.skill_page_id,
        recordId: outcomeRecord(review.operation_id, review.candidate.policy),
        entityId: completionsEntity,
        operationId: review.review_id,
        payload: outcome,
        payloadContainsBody: true,
      }).pipe(Effect.provideService(Notion, afterDispatch.api))
      const confirmed = yield* completion(context, review, proof)
      if (confirmed === undefined)
        return yield* refusal("The repair completion has not been independently observed.")
      return {
        ...confirmed,
        status: "applied" as const,
        remote_writes: undefined,
        original_input_preserved: true,
      }
    }).pipe(Effect.mapError((error) => sourceRecoveryError(error, context.plan)))
    return yield* input.dryRun
      ? action.pipe(withReadOnlyNotion)
      : withSourceUpdateLock(context.library, action)
  })
}

export function reconcileSharedSourceProjectionRepair(input: ApplyInput) {
  return Effect.gen(function* () {
    const context = yield* repairPlan(input),
      proof = yield* validateReview(context, input.review, input.reviewId)
    const done = yield* completion(context, proof.review, proof)
    if (done === undefined)
      return yield* refusal(
        "No complete original repair acknowledgement is retained; do not replay the body request.",
      )
    return done
  }).pipe(withReadOnlyNotion)
}
