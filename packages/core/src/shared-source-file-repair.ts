import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { fail, property } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { pageId } from "./ref.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import { preservesSharedLibraryBindings, type SharedLibrary } from "./shared-library-model.ts"
import {
  createChecked,
  sharedCreateManifestEntity,
  sharedCreateOutcomesEntity,
  type SharedCreatePlan,
} from "./shared-create-model.ts"
import {
  decodeSharedCreateOutcome,
  sharedCreateOutcomeId,
  sharedCreateManifestRecordHash,
} from "./shared-create-outcome.ts"
import { selectOriginalSourceRecoveryPlan, sourceRecoveryError } from "./shared-source-recovery.ts"
import { inspectRetainedImportFileRepairPrefix } from "./shared-create-retained-recovery.ts"
import { SharedCreateRecoveryBindingSchema } from "./shared-create-recovery-proof-model.ts"
import { SharedNativeAllocationReferenceSchema } from "./shared-create-recovery-acknowledgement-model.ts"
import {
  retainSharedNativeAllocationProofs,
  readSharedNativeAllocationProofs,
} from "./shared-create-recovery-acknowledgements.ts"
import { resolveSharedCreateSource } from "./shared-create-source.ts"
import { sharedCreateDispatch } from "./shared-create-dispatch.ts"
import { SourceMutationAcknowledgementSchema } from "./shared-sources-model.ts"
import { guardedSourceMutation } from "./shared-source-definitions.ts"
import { withSourceUpdateLock } from "./shared-source-policy.ts"
import {
  assertImportedMarkdownContent,
  deriveImportedTableCodePaddingRepair,
} from "./shared-import-markdown.ts"
import {
  RepairTableRowSchema,
  nativeRepairTableRow,
  deriveNativeTableCodePatch,
  sameNativeRepairRow,
  assertPhysicalCodeRepairReadback,
  type SourceFileRepairProof,
} from "./shared-native-table-code-repair.ts"
import { normalizeObservedBody } from "./shared-file-state.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  validateSharedRecordEnvelope,
} from "./shared-records.ts"
import {
  retainSharedCreateText,
  readSharedCreateTextPayload,
} from "./shared-create-text-retention.ts"
import { sha256, Store } from "./store.ts"
import type { SharedOperationHeader } from "./shared-operation-index.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Id = Schema.String.check(Schema.isPattern(/^source-file-repair-[a-f0-9]{64}$/u))
const BodyRef = Schema.Struct({ sha256: Hash, bytes: Schema.Number })
const ReviewSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("source_file_code_repair_review"),
  review_id: Id,
  decision: Schema.Literal("restore_one_physical_table_code_marker"),
  operation_id: Schema.String,
  plan_sha256: Hash,
  manifest_sha256: Hash,
  failure_sha256: Hash,
  journal_sha256: Hash,
  permission_scope: Schema.String,
  library_id: Schema.String,
  skill_id: Schema.String,
  skill_page_id: Schema.String,
  file_id: Schema.String,
  file_page_id: Schema.String,
  path: Schema.String,
  bindings: Schema.Array(SharedCreateRecoveryBindingSchema),
  allocations: Schema.Array(SharedNativeAllocationReferenceSchema),
  other_bodies: Schema.Array(
    Schema.Struct({
      file_id: Schema.String,
      page_id: Schema.String,
      body_sha256: Hash,
      body_bytes: Schema.Number,
      event_id: Schema.String,
    }),
  ),
  before_body: BodyRef,
  candidate_body: BodyRef,
  before_row: RepairTableRowSchema,
})
const PlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("source_file_code_repair_plan"),
  review: ReviewSchema,
  before_markdown: Schema.String,
})
export type SourceFileRepairPlan = typeof PlanSchema.Type
const CompletionSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("source_file_code_repair_completion"),
  review_id: Id,
  operation_id: Schema.String,
  skill_page_id: Schema.String,
  file_id: Schema.String,
  row_ack: SourceMutationAcknowledgementSchema,
  after_body: BodyRef,
  readback_policy: Schema.optionalKey(Schema.Literal("physical_row_root_url_v1")),
})
const reviewsEntity = "source-file-code-repair-reviews-v1"
const outcomesEntity = "source-file-code-repair-outcomes-v1"
const reviewRecord = (operation: string, file: string) =>
  `source-file-repair-review-${operation}-${file}`
const outcomeRecord = (operation: string, file: string) =>
  `source-file-repair-outcome-${operation}-${file}`
const same = (a: unknown, b: unknown) => canonicalSharedJson(a) === canonicalSharedJson(b)
const hash = (value: unknown) => sha256(canonicalSharedJson(value))
const refusal = (message: string) => Effect.fail(fail("SOURCE_FILE_REPAIR_REQUIRED", message))
type OriginalInput = {
  readonly entry: string
  readonly plan: unknown
  readonly operationId?: string
}

function context(input: OriginalInput) {
  return Effect.gen(function* () {
    const plan = yield* selectOriginalSourceRecoveryPlan(input.plan, input.operationId),
      library = yield* loadSharedLibrary(input.entry)
    if (
      plan.version !== 1 ||
      plan.source_projection?.version !== 2 ||
      plan.enabled !== false ||
      !preservesSharedLibraryBindings(plan.library, library)
    )
      return yield* refusal(
        "Select the exact original disabled retained import and registered library.",
      )
    return { plan, library }
  })
}
const bodyRef = (markdown: string) =>
  Effect.gen(function* () {
    return { sha256: yield* sha256(markdown), bytes: new TextEncoder().encode(markdown).length }
  })

function children(parent: string) {
  return Effect.gen(function* () {
    const rows: unknown[] = [],
      ids = new Set<string>(),
      cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const value = property(
        yield* (yield* Notion).request(
          `v1/blocks/${parent}/children?page_size=100${cursor === undefined ? "" : "&start_cursor=" + encodeURIComponent(cursor)}`,
        ),
      )
      if (
        value.object !== "list" ||
        !Array.isArray(value.results) ||
        typeof value.has_more !== "boolean" ||
        (value.has_more
          ? typeof value.next_cursor !== "string" || value.next_cursor.length === 0
          : value.next_cursor !== null)
      )
        return yield* refusal("The original block inventory is incomplete.")
      for (const item of value.results) {
        const row = property(item)
        if (typeof row.id !== "string" || pageId(row.id) !== row.id || ids.has(row.id))
          return yield* refusal("The block inventory has invalid or duplicate identities.")
        ids.add(row.id)
        rows.push(item)
      }
      if (rows.length > 2000)
        return yield* refusal("The explicit file block inventory exceeds the bounded repair scope.")
      cursor = value.has_more ? String(value.next_cursor) : undefined
      if (cursor !== undefined) {
        if (cursors.has(cursor)) return yield* refusal("The block inventory repeated a cursor.")
        cursors.add(cursor)
      }
    } while (cursor !== undefined)
    return rows
  })
}

function physicalRow(filePage: string) {
  return Effect.gen(function* () {
    const roots = yield* children(filePage),
      matches = []
    for (const raw of roots) {
      const table = property(raw)
      if (table.type !== "table") continue
      const parent = property(table.parent)
      if (
        parent.type !== "page_id" ||
        parent.page_id !== filePage ||
        table.has_children !== true ||
        table.archived === true ||
        table.in_trash === true
      )
        return yield* refusal("A candidate table has another parent or is archived.")
      for (const row of yield* children(String(table.id))) {
        const value = property(row),
          cells = property(value.table_row).cells
        if (
          !Array.isArray(cells) ||
          !cells.some(
            (cell) =>
              Array.isArray(cell) &&
              cell.some(
                (span) =>
                  property(property(span).annotations).code === true &&
                  property(property(span).text).content === "  • ",
              ),
          )
        )
          continue
        const view = yield* createChecked(() => nativeRepairTableRow(row))
        if (view.table_id !== table.id)
          return yield* refusal("The table row changed its exact parent.")
        yield* createChecked(() => deriveNativeTableCodePatch(view))
        matches.push(view)
      }
    }
    if (matches.length !== 1)
      return yield* refusal(
        "The complete file must contain exactly one physical padded code-marker row.",
      )
    return matches[0]!
  })
}

function currentRow(filePage: string, expected: typeof RepairTableRowSchema.Type) {
  return Effect.gen(function* () {
    const api = yield* Notion,
      table = property(yield* api.request(`v1/blocks/${expected.table_id}`)),
      parent = property(table.parent)
    if (
      table.object !== "block" ||
      table.id !== expected.table_id ||
      table.type !== "table" ||
      table.archived === true ||
      table.in_trash === true ||
      parent.type !== "page_id" ||
      parent.page_id !== filePage
    )
      return yield* refusal("The original table no longer belongs to the exact supporting file.")
    const raw = yield* api.request(`v1/blocks/${expected.row_id}`)
    return yield* createChecked(() => nativeRepairTableRow(raw))
  })
}

export function reviewSharedSourceFileRepair(
  input: OriginalInput & { readonly target: string; readonly path: string },
) {
  return Effect.gen(function* () {
    const { plan, library } = yield* context(input),
      page = pageId(input.target)
    if (page !== input.target || !page) return yield* refusal("Use the exact original Skill page.")
    const original = yield* inspectRetainedImportFileRepairPrefix(library, plan, page, input.path)
    const before = normalizeObservedBody(original.markdown),
      proposal = yield* createChecked(() =>
        deriveImportedTableCodePaddingRepair(original.file.projection.markdown, before),
      )
    const row = yield* physicalRow(original.target.page_id)
    const fields = {
      version: 1 as const,
      kind: "source_file_code_repair_review" as const,
      decision: "restore_one_physical_table_code_marker" as const,
      operation_id: plan.operation_id,
      plan_sha256: yield* hash(plan),
      manifest_sha256: yield* sharedCreateManifestRecordHash(plan),
      failure_sha256: original.original.row.hash,
      journal_sha256: yield* hash(original.journal.journal),
      permission_scope: original.journal.scope,
      library_id: library.library_id,
      skill_id: plan.skill_id,
      skill_page_id: page,
      file_id: original.target.file_id,
      file_page_id: original.target.page_id,
      path: input.path,
      bindings: original.bindings,
      allocations: original.proofs.map((proof) => proof.reference),
      other_bodies: original.observations,
      before_body: yield* bodyRef(before),
      candidate_body: yield* bodyRef(proposal.markdown),
      before_row: row,
    }
    const review = { ...fields, review_id: "source-file-repair-" + (yield* hash(fields)) }
    yield* createChecked(() => validateSharedRecordEnvelope(review.review_id, review, "operation"))
    const prior = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      entityId: reviewsEntity,
      recordId: reviewRecord(plan.operation_id, review.file_id),
    })
    if (prior.length > 1 || (prior.length === 1 && !same(prior[0]!.payload, review)))
      return yield* refusal(
        "An earlier exact file repair already owns this operation; do not replace its unresolved decision.",
      )
    return {
      version: 1 as const,
      kind: "source_file_code_repair_plan" as const,
      review,
      before_markdown: before,
    }
  }).pipe(withReadOnlyNotion)
}

function validateReview(plan: SharedCreatePlan, input: unknown, expected: string) {
  return Effect.gen(function* () {
    const review = yield* createChecked(() =>
        Schema.decodeUnknownSync(ReviewSchema)(input, { onExcessProperty: "error" }),
      ),
      { review_id, ...fields } = review
    const file = plan.files.find(
      (file) => file.file_id === review.file_id && file.path === review.path,
    )
    if (
      review_id !== expected ||
      review_id !== "source-file-repair-" + (yield* hash(fields)) ||
      review.operation_id !== plan.operation_id ||
      review.plan_sha256 !== (yield* hash(plan)) ||
      review.manifest_sha256 !== (yield* sharedCreateManifestRecordHash(plan)) ||
      review.library_id !== plan.library.library_id ||
      review.skill_id !== plan.skill_id ||
      !file ||
      file.path === plan.entrypoint ||
      pageId(review.skill_page_id) !== review.skill_page_id ||
      pageId(review.file_page_id) !== review.file_page_id ||
      review.file_page_id === review.skill_page_id ||
      review.bindings.length !== review.allocations.length ||
      review.other_bodies.length !== review.bindings.length - 1 ||
      review.bindings.filter(
        (binding) =>
          binding.file_id === review.file_id &&
          binding.page_id === review.file_page_id &&
          binding.path === review.path,
      ).length !== 1
    )
      return yield* refusal("The reviewed original input, exact file or prefix proof changed.")
    const afterRow = yield* createChecked(() => deriveNativeTableCodePatch(review.before_row))
    return { review, file, afterRow }
  })
}

function validatePlan(plan: SharedCreatePlan, input: unknown, expected: string) {
  return Effect.gen(function* () {
    const saved = yield* createChecked(() =>
      Schema.decodeUnknownSync(PlanSchema)(input, { onExcessProperty: "error" }),
    )
    const decoded = yield* validateReview(plan, saved.review, expected)
    const proposal = yield* createChecked(() =>
      deriveImportedTableCodePaddingRepair(decoded.file.projection.markdown, saved.before_markdown),
    )
    if (
      !same(yield* bodyRef(saved.before_markdown), decoded.review.before_body) ||
      !same(yield* bodyRef(proposal.markdown), decoded.review.candidate_body)
    )
      return yield* refusal("The complete original preimage or exact proposed correction changed.")
    return { ...decoded, before: saved.before_markdown, candidate: proposal.markdown }
  })
}

function rowRequest(review: typeof ReviewSchema.Type, after: typeof RepairTableRowSchema.Type) {
  return {
    identity: review.review_id + ":table-row",
    path: `v1/blocks/${after.row_id}`,
    method: "PATCH" as const,
    body: { table_row: { cells: after.cells } },
  }
}
function verifyRowAck(
  review: typeof ReviewSchema.Type,
  after: typeof RepairTableRowSchema.Type,
  input: unknown,
) {
  return Effect.gen(function* () {
    const ack = yield* createChecked(() =>
      Schema.decodeUnknownSync(SourceMutationAcknowledgementSchema)(input, {
        onExcessProperty: "error",
      }),
    )
    const request = rowRequest(review, after),
      operation = "source-op-" + (yield* hash(request))
    const row = yield* createChecked(() => nativeRepairTableRow(ack.response))
    if (
      ack.operation_id !== operation ||
      ack.request_hash !== (yield* hash({ version: 1, operation, ...request })) ||
      ack.response_hash !== (yield* hash(ack.response)) ||
      !Number.isSafeInteger(ack.acknowledged_at) ||
      ack.acknowledged_at < 0 ||
      !sameNativeRepairRow(row, after)
    )
      return yield* refusal(
        "The exact original table-row ACK is missing or belongs to another request.",
      )
    return ack
  })
}

/** Observe this exact local request/ACK pair, never infer it from a current
 * physical row. An unresolved dispatch cannot become a new dry-run permission. */
function localRowAcknowledgement(
  library: SharedLibrary,
  review: typeof ReviewSchema.Type,
  after: typeof RepairTableRowSchema.Type,
) {
  return Effect.gen(function* () {
    const request = rowRequest(review, after),
      operation = "source-op-" + (yield* hash(request))
    const namespace = yield* hash([
      yield* (yield* Notion).credentialIdentity,
      library.library_id,
      library.sources?.data_source_id ?? null,
    ])
    const root = `operations/shared-sources/${namespace}/`,
      store = yield* Store
    const dispatch = yield* store.readJson(root + operation + ".json", Schema.Unknown)
    const ack = yield* store.readJson(
      root + "source-ack-" + operation.slice("source-op-".length) + ".json",
      SourceMutationAcknowledgementSchema,
    )
    if (dispatch === undefined && ack === undefined) return undefined
    if (!same(dispatch, { version: 1, operation, ...request }) || ack === undefined)
      return yield* refusal(
        "The exact original table-row request has no complete durable ACK; do not repeat it or infer completion from current content.",
      )
    return yield* verifyRowAck(review, after, ack)
  })
}

function verifiedAfterBody(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  decoded: Effect.Success<ReturnType<typeof validatePlan>>,
) {
  return Effect.gen(function* () {
    const review = decoded.review
    const observed = yield* inspectRetainedImportFileRepairPrefix(
      library,
      plan,
      review.skill_page_id,
      review.path,
    )
    if (
      observed.original.row.hash !== review.failure_sha256 ||
      !same(observed.bindings, review.bindings) ||
      !same(
        observed.proofs.map((proof) => proof.reference),
        review.allocations,
      ) ||
      !same(observed.observations, review.other_bodies)
    )
      return yield* refusal(
        "The original failure, native allocation or untouched prefix changed after the exact row update.",
      )
    if (
      !sameNativeRepairRow(
        yield* currentRow(review.file_page_id, review.before_row),
        decoded.afterRow,
      )
    )
      return yield* refusal(
        "The exact original physical row differs from its acknowledged candidate.",
      )
    const after = normalizeObservedBody(observed.markdown)
    yield* createChecked(() =>
      assertPhysicalCodeRepairReadback({
        expected: decoded.file.projection.markdown,
        before: decoded.before,
        after,
        row: review.before_row,
      }),
    )
    const saved = yield* querySharedRecords(library, {
      skillPageId: review.skill_page_id,
      kind: "operation",
      entityId: reviewsEntity,
      recordId: reviewRecord(plan.operation_id, review.file_id),
    })
    if (
      saved.length !== 1 ||
      saved[0]!.operation_id !== review.review_id ||
      !same(saved[0]!.payload, review) ||
      (yield* readBody(library, review.skill_page_id, review.before_body)) !== decoded.before
    )
      return yield* refusal(
        "The original independent review or complete preimage is unavailable; do not regenerate missing proof after a body write.",
      )
    return after
  }).pipe(withReadOnlyNotion)
}

function readBody(library: SharedLibrary, page: string, ref: typeof BodyRef.Type) {
  return Effect.gen(function* () {
    const rows = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "object",
      entityId: "body-" + ref.sha256,
      recordId: "body-" + ref.sha256,
    })
    if (rows.length !== 1 || rows[0]!.operation_id !== "retain-" + ref.sha256)
      return yield* refusal("The exact complete body proof is missing.")
    return yield* readSharedCreateTextPayload(
      library,
      page,
      { kind: "body", sha256: ref.sha256, bytes: ref.bytes },
      rows[0]!.payload,
    )
  })
}

function completion(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  review: typeof ReviewSchema.Type,
) {
  return Effect.gen(function* () {
    const rows = yield* querySharedRecords(library, {
      skillPageId: review.skill_page_id,
      kind: "operation",
      entityId: outcomesEntity,
      recordId: outcomeRecord(plan.operation_id, review.file_id),
    })
    if (rows.length === 0) return undefined
    if (rows.length !== 1) return yield* refusal("The file repair outcome is duplicated.")
    const outcome = yield* createChecked(() =>
      Schema.decodeUnknownSync(CompletionSchema)(rows[0]!.payload, { onExcessProperty: "error" }),
    )
    const proofs = yield* querySharedRecords(library, {
      skillPageId: review.skill_page_id,
      kind: "operation",
      entityId: reviewsEntity,
      recordId: reviewRecord(plan.operation_id, review.file_id),
    })
    if (
      proofs.length !== 1 ||
      proofs[0]!.operation_id !== review.review_id ||
      rows[0]!.operation_id !== review.review_id ||
      !same(proofs[0]!.payload, review) ||
      outcome.review_id !== review.review_id ||
      outcome.operation_id !== plan.operation_id ||
      outcome.file_id !== review.file_id ||
      outcome.skill_page_id !== review.skill_page_id
    )
      return yield* refusal("The completion does not bind its full original file repair review.")
    const checked = yield* validateReview(plan, review, review.review_id)
    const failures = yield* querySharedRecords(library, {
      skillPageId: review.skill_page_id,
      kind: "operation",
      entityId: sharedCreateOutcomesEntity,
      recordId: sharedCreateOutcomeId(plan.operation_id),
    })
    if (failures.length !== 1 || failures[0]!.hash !== review.failure_sha256)
      return yield* refusal("The immutable original failure is missing or changed.")
    const failure = yield* createChecked(() => decodeSharedCreateOutcome(failures[0]!))
    if (
      failure.status !== "needs_review" ||
      failure.reason_code !== "SHARED_CREATE_BODY_MISMATCH" ||
      failure.operation_id !== plan.operation_id ||
      failure.skill_page_id !== review.skill_page_id
    )
      return yield* refusal("The original failure is outside this repair family.")
    const resolved = yield* resolveSharedCreateSource(plan, review.skill_page_id)
    yield* readSharedNativeAllocationProofs(
      library,
      plan,
      review.skill_page_id,
      review.bindings,
      review.allocations,
      (binding) => ({
        attemptId: plan.operation_id,
        file: resolved.facts.files.find((file) => file.file_id === binding.file_id)!,
      }),
    )
    const before = yield* readBody(library, review.skill_page_id, review.before_body),
      after = yield* readBody(library, review.skill_page_id, outcome.after_body)
    const candidate = yield* createChecked(() =>
      deriveImportedTableCodePaddingRepair(checked.file.projection.markdown, before),
    )
    if (!same(yield* bodyRef(candidate.markdown), review.candidate_body))
      return yield* refusal(
        "The complete repaired body differs from the single authorized code change.",
      )
    if (outcome.readback_policy === "physical_row_root_url_v1")
      yield* createChecked(() =>
        assertPhysicalCodeRepairReadback({
          expected: checked.file.projection.markdown,
          before,
          after,
          row: review.before_row,
        }),
      )
    else if (!same(outcome.after_body, review.candidate_body) || after !== candidate.markdown)
      return yield* refusal(
        "The earlier completion policy requires its exact reviewed candidate bytes.",
      )
    yield* createChecked(() =>
      assertImportedMarkdownContent(checked.file.projection.markdown, after),
    )
    yield* verifyRowAck(review, checked.afterRow, outcome.row_ack)
    return {
      status: "reconciled" as const,
      verified: true as const,
      review_id: review.review_id,
      operation_id: plan.operation_id,
      page_id: review.skill_page_id,
      file_page_id: review.file_page_id,
      file_id: review.file_id,
      path: review.path,
      row_operation_id: outcome.row_ack.operation_id,
      original_creation_completed: false,
      remote_writes: 0 as const,
      requires_fresh_read: true,
      proof: {
        review_id: review.review_id,
        file_id: review.file_id,
        review_record_hash: proofs[0]!.hash,
        outcome_record_hash: rows[0]!.hash,
      },
    }
  }).pipe(withReadOnlyNotion)
}

export function assertSourceFileRepairsComplete(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  page: string,
  expected?: readonly SourceFileRepairProof[],
) {
  return Effect.gen(function* () {
    if (plan.version !== 1 || plan.source_projection?.version !== 2) {
      if ((expected?.length ?? 0) > 0)
        return yield* refusal("File-repair proof belongs to another creation family.")
      return []
    }
    const records = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      entityIds: [reviewsEntity, outcomesEntity],
    })
    const reviews = records.filter((row) => row.entity_id === reviewsEntity),
      outcomes = records.filter((row) => row.entity_id === outcomesEntity)
    if (reviews.length !== outcomes.length)
      return yield* Effect.fail(
        fail(
          "SOURCE_FILE_REPAIR_PENDING",
          "An independent file repair has no complete original ACK proof; do not continue the original import.",
        ),
      )
    const proofs: SourceFileRepairProof[] = []
    for (const row of reviews) {
      const review = yield* createChecked(() =>
        Schema.decodeUnknownSync(ReviewSchema)(row.payload, { onExcessProperty: "error" }),
      )
      if (
        review.operation_id !== plan.operation_id ||
        review.skill_page_id !== page ||
        row.record_id !== reviewRecord(plan.operation_id, review.file_id) ||
        proofs.some((x) => x.file_id === review.file_id)
      )
        return yield* refusal("The file repair has a foreign or duplicate operation identity.")
      const result = yield* completion(library, plan, review)
      if (!result)
        return yield* Effect.fail(
          fail("SOURCE_FILE_REPAIR_PENDING", "The exact original file repair is unresolved."),
        )
      proofs.push(result.proof)
    }
    proofs.sort((a, b) => a.file_id.localeCompare(b.file_id))
    if (expected !== undefined && !same(proofs, expected))
      return yield* refusal(
        "The retained import review does not bind the complete file-repair proof set.",
      )
    return proofs
  }).pipe(withReadOnlyNotion)
}

type ApplyInput = OriginalInput & {
  readonly repair: unknown
  readonly reviewId: string
  readonly dryRun?: boolean
}
export function applySharedSourceFileRepair(input: ApplyInput) {
  return Effect.gen(function* () {
    const { library, plan } = yield* context(input)
    const action = Effect.gen(function* () {
      const decoded = yield* validatePlan(plan, input.repair, input.reviewId),
        review = decoded.review
      const done = yield* completion(library, plan, review)
      if (done) return done
      if (review.permission_scope !== (yield* authScope))
        return yield* refusal("Use the original credential-scoped author runtime.")
      const previousAck = yield* localRowAcknowledgement(library, review, decoded.afterRow)
      const inspect = () =>
        inspectRetainedImportFileRepairPrefix(library, plan, review.skill_page_id, review.path)
      const before = Effect.gen(function* () {
        const current = yield* inspect()
        if (
          current.original.row.hash !== review.failure_sha256 ||
          (yield* hash(current.journal.journal)) !== review.journal_sha256 ||
          !same(current.bindings, review.bindings) ||
          !same(
            current.proofs.map((p) => p.reference),
            review.allocations,
          ) ||
          !same(current.observations, review.other_bodies) ||
          normalizeObservedBody(current.markdown) !== decoded.before ||
          !sameNativeRepairRow(
            yield* currentRow(review.file_page_id, review.before_row),
            review.before_row,
          )
        )
          return yield* refusal(
            "The original allocation, untouched prefix, complete body or exact row changed after review.",
          )
        return current
      }).pipe(withReadOnlyNotion)
      if (input.dryRun) {
        if (previousAck === undefined) yield* before
        else yield* verifiedAfterBody(library, plan, decoded)
        return {
          status: "reviewed" as const,
          verified: false as const,
          review_id: review.review_id,
          operation_id: plan.operation_id,
          page_id: review.skill_page_id,
          file_page_id: review.file_page_id,
          path: review.path,
          remote_writes: 0 as const,
          table_row_patches: previousAck === undefined ? 1 : 0,
          acknowledged_row_reused: previousAck !== undefined,
          native_pages_created: 0,
        }
      }
      // An already verified exact request/ACK resumes only proof publication.
      // Do not route it through a new mutation call or synthesize a verified
      // source result from current row equality.
      const exactAck =
        previousAck ??
        (yield* Effect.gen(function* () {
          const facts = yield* sharedCreateDispatch(
            library,
            { operation_id: review.review_id, skill_id: review.skill_id },
            before.pipe(Effect.asVoid),
          )
          const retain = Effect.gen(function* () {
            const current = yield* before
            yield* retainSharedCreateText(
              library,
              review.skill_page_id,
              decoded.before,
              "body",
              "create",
            )
            yield* retainSharedNativeAllocationProofs(library, review.skill_page_id, current.proofs)
            yield* appendSharedRecord(library, {
              mode: "create",
              kind: "operation",
              skillPageId: review.skill_page_id,
              entityId: reviewsEntity,
              recordId: reviewRecord(plan.operation_id, review.file_id),
              operationId: review.review_id,
              payload: review,
            })
          }).pipe(Effect.provideService(Notion, facts.api))
          const result = yield* guardedSourceMutation(
            library,
            {
              ...rowRequest(review, decoded.afterRow),
              repeat: "never",
              beforeDispatch: retain,
              observeAcknowledged: (raw) =>
                createChecked(() =>
                  sameNativeRepairRow(nativeRepairTableRow(raw), decoded.afterRow)
                    ? { row_id: decoded.afterRow.row_id }
                    : undefined,
                ),
            },
            Effect.succeed(undefined),
          )
          if (!("verified" in result) || result.verified !== true)
            return yield* refusal(
              "The row mutation remains unknown; current equality cannot supply its missing ACK.",
            )
          const namespace = yield* hash([
            yield* (yield* Notion).credentialIdentity,
            library.library_id,
            library.sources?.data_source_id ?? null,
          ])
          const ack = yield* (yield* Store).readJson(
            `operations/shared-sources/${namespace}/source-ack-${result.operation_id.slice("source-op-".length)}.json`,
            SourceMutationAcknowledgementSchema,
          )
          return yield* verifyRowAck(review, decoded.afterRow, ack)
        }))
      const after = yield* verifiedAfterBody(library, plan, decoded)
      const commit = yield* sharedCreateDispatch(library, {
        operation_id: review.review_id,
        skill_id: review.skill_id,
      })
      yield* Effect.gen(function* () {
        yield* retainSharedCreateText(library, review.skill_page_id, after, "body", "create")
        yield* appendSharedRecord(library, {
          mode: "create",
          kind: "operation",
          skillPageId: review.skill_page_id,
          entityId: outcomesEntity,
          recordId: outcomeRecord(plan.operation_id, review.file_id),
          operationId: review.review_id,
          payload: {
            version: 1,
            kind: "source_file_code_repair_completion",
            review_id: review.review_id,
            operation_id: plan.operation_id,
            skill_page_id: review.skill_page_id,
            file_id: review.file_id,
            row_ack: exactAck,
            after_body: yield* bodyRef(after),
            readback_policy: "physical_row_root_url_v1",
          },
        })
      }).pipe(Effect.provideService(Notion, commit.api))
      const completed = yield* completion(library, plan, review)
      if (!completed)
        return yield* refusal(
          "The exact original file repair completion is not independently visible.",
        )
      return {
        ...completed,
        status: "applied" as const,
        remote_writes: undefined,
        acknowledged_row_reused: previousAck !== undefined,
      }
    }).pipe(Effect.mapError((error) => sourceRecoveryError(error, plan)))
    return yield* input.dryRun
      ? action.pipe(withReadOnlyNotion)
      : withSourceUpdateLock(library, action)
  })
}

export function reconcileSharedSourceFileRepair(input: ApplyInput) {
  return Effect.gen(function* () {
    const { plan, library } = yield* context(input),
      decoded = yield* validatePlan(plan, input.repair, input.reviewId)
    const result = yield* completion(library, plan, decoded.review)
    if (result) return result
    if (decoded.review.permission_scope !== (yield* authScope))
      return yield* refusal("Unresolved repair inspection requires its original author scope.")
    const ack = yield* localRowAcknowledgement(library, decoded.review, decoded.afterRow)
    if (ack === undefined)
      return yield* refusal(
        "No exact original row acknowledgement is retained; do not repeat the row write.",
      )
    yield* verifiedAfterBody(library, plan, decoded)
    return {
      status: "completion_pending" as const,
      verified: false as const,
      review_id: decoded.review.review_id,
      operation_id: plan.operation_id,
      page_id: decoded.review.skill_page_id,
      file_page_id: decoded.review.file_page_id,
      file_id: decoded.review.file_id,
      path: decoded.review.path,
      row_operation_id: ack.operation_id,
      acknowledged_row_reused: true,
      table_row_patches: 0,
      remote_writes: 0 as const,
      original_creation_completed: false,
    }
  }).pipe(withReadOnlyNotion)
}

export function sourceFileRepairOriginal(
  header: SharedOperationHeader,
  operations: readonly SharedOperationHeader[],
) {
  if (header.entity_id !== reviewsEntity && header.entity_id !== outcomesEntity) return undefined
  const match =
    /^source-file-repair-(?:review|outcome)-(skill-create-[a-f0-9]{64})-file-[a-f0-9]{64}$/u.exec(
      header.record_id,
    )
  return match &&
    operations.some(
      (item) => item.record_id === match[1] && item.entity_id === sharedCreateManifestEntity,
    )
    ? match[1]
    : undefined
}
