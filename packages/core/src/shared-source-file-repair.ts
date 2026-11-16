import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { fail, property, SkillsError } from "./model.ts"
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
import {
  deriveTableLiteralRepair,
  patchTableLiteralRow,
  bindTableLiteralRows,
  assertTableLiteralProgress,
  type TableLiteralRepair,
} from "./shared-native-table-literal-repair.ts"
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
const ReviewV1Schema = Schema.Struct({
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
const {
  version: _version,
  kind: _kind,
  decision: _decision,
  before_row: _beforeRow,
  ...CommonReviewFields
} = ReviewV1Schema.fields
const ReviewV2Schema = Schema.Struct({
  ...CommonReviewFields,
  version: Schema.Literal(2),
  kind: Schema.Literal("source_file_table_literal_repair_review"),
  decision: Schema.Literal("restore_exact_physical_table_literals"),
  before_rows: Schema.Array(RepairTableRowSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
  ),
})
const ReviewSchema = Schema.Union([ReviewV1Schema, ReviewV2Schema])
const PlanV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("source_file_code_repair_plan"),
  review: ReviewV1Schema,
  before_markdown: Schema.String,
})
const PlanV2Schema = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literal("source_file_table_literal_repair_plan"),
  review: ReviewV2Schema,
  before_markdown: Schema.String,
})
const PlanSchema = Schema.Union([PlanV1Schema, PlanV2Schema])
export type SourceFileRepairPlan = typeof PlanSchema.Type
const CompletionV1Schema = Schema.Struct({
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
const CompletionSchema = Schema.Union([
  CompletionV1Schema,
  Schema.Struct({
    version: Schema.Literal(2),
    kind: Schema.Literal("source_file_table_literal_repair_completion"),
    review_id: Id,
    operation_id: Schema.String,
    skill_page_id: Schema.String,
    file_id: Schema.String,
    row_acks: Schema.Array(SourceMutationAcknowledgementSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(32),
    ),
    after_body: BodyRef,
    readback_policy: Schema.Literal("physical_table_literals_v1"),
  }),
])
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
type RepairReview = typeof ReviewSchema.Type
const originalRows = (review: RepairReview) =>
  review.version === 1 ? [review.before_row] : review.before_rows

function proposal(expected: string, before: string) {
  try {
    return { version: 1 as const, ...deriveImportedTableCodePaddingRepair(expected, before) }
  } catch (error) {
    if (
      !(error instanceof SkillsError) ||
      !["SOURCE_FILE_REPAIR_UNSUPPORTED", "SHARED_CREATE_BODY_MISMATCH"].includes(error.code)
    )
      throw error
    return { version: 2 as const, ...deriveTableLiteralRepair(expected, before) }
  }
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

function physicalLiteralRows(filePage: string, candidate: TableLiteralRepair, bindBefore = true) {
  return Effect.gen(function* () {
    const tables = (yield* children(filePage)).filter((raw) => property(raw).type === "table")
    const loaded = new Map<number, readonly unknown[]>()
    const rows: (typeof RepairTableRowSchema.Type)[] = []
    for (const target of candidate.rows) {
      const table = property(tables[target.table_index])
      if (
        typeof table.id !== "string" ||
        pageId(table.id) !== table.id ||
        table.has_children !== true ||
        table.archived === true ||
        table.in_trash === true ||
        property(table.parent).type !== "page_id" ||
        property(table.parent).page_id !== filePage
      )
        return yield* refusal(
          "The complete physical table inventory differs from the reviewed file.",
        )
      let entries = loaded.get(target.table_index)
      if (entries === undefined) {
        entries = yield* children(table.id)
        loaded.set(target.table_index, entries)
      }
      const row = yield* createChecked(() => nativeRepairTableRow(entries[target.row_index]))
      if (row.table_id !== table.id)
        return yield* refusal("The literal row has another table parent.")
      rows.push(row)
    }
    if (bindBefore) yield* createChecked(() => bindTableLiteralRows(candidate, rows))
    return rows
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
      candidate = yield* createChecked(() => proposal(original.file.projection.markdown, before))
    const shape =
      candidate.version === 1
        ? {
            version: 1 as const,
            kind: "source_file_code_repair_review" as const,
            decision: "restore_one_physical_table_code_marker" as const,
            before_row: yield* physicalRow(original.target.page_id),
          }
        : {
            version: 2 as const,
            kind: "source_file_table_literal_repair_review" as const,
            decision: "restore_exact_physical_table_literals" as const,
            before_rows: yield* physicalLiteralRows(original.target.page_id, candidate),
          }
    const fields = {
      ...shape,
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
      candidate_body: yield* bodyRef(candidate.markdown),
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
    return review.version === 1
      ? {
          version: 1 as const,
          kind: "source_file_code_repair_plan" as const,
          review,
          before_markdown: before,
        }
      : {
          version: 2 as const,
          kind: "source_file_table_literal_repair_plan" as const,
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
    if (new Set(originalRows(review).map((row) => row.row_id)).size !== originalRows(review).length)
      return yield* refusal("The physical repair repeats a row identity.")
    const afterRows = yield* createChecked(() =>
      review.version === 1
        ? [deriveNativeTableCodePatch(review.before_row)]
        : review.before_rows.map(patchTableLiteralRow),
    )
    return { review, file, afterRows }
  })
}

function validatePlan(plan: SharedCreatePlan, input: unknown, expected: string) {
  return Effect.gen(function* () {
    const saved = yield* createChecked(() =>
      Schema.decodeUnknownSync(PlanSchema)(input, { onExcessProperty: "error" }),
    )
    const decoded = yield* validateReview(plan, saved.review, expected)
    const candidate = yield* createChecked(() =>
      decoded.review.version === 1
        ? {
            version: 1 as const,
            ...deriveImportedTableCodePaddingRepair(
              decoded.file.projection.markdown,
              saved.before_markdown,
            ),
          }
        : {
            version: 2 as const,
            ...deriveTableLiteralRepair(decoded.file.projection.markdown, saved.before_markdown),
          },
    )
    if (candidate.version === 2) {
      const after = yield* createChecked(() =>
        bindTableLiteralRows(candidate, originalRows(decoded.review)),
      )
      if (!same(after, decoded.afterRows))
        return yield* refusal("The physical literal rows differ from the complete source proposal.")
    }
    if (
      !same(yield* bodyRef(saved.before_markdown), decoded.review.before_body) ||
      !same(yield* bodyRef(candidate.markdown), decoded.review.candidate_body)
    )
      return yield* refusal("The complete original preimage or exact proposed correction changed.")
    return {
      ...decoded,
      before: saved.before_markdown,
      candidate: candidate.markdown,
      literal: candidate.version === 2 ? candidate : undefined,
    }
  })
}

function rowRequest(review: typeof ReviewSchema.Type, after: typeof RepairTableRowSchema.Type) {
  return {
    identity: review.review_id + ":table-row" + (review.version === 1 ? "" : ":" + after.row_id),
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
    const physical =
      decoded.literal === undefined
        ? [yield* currentRow(review.file_page_id, originalRows(review)[0]!)]
        : yield* physicalLiteralRows(review.file_page_id, decoded.literal, false)
    if (!same(physical, decoded.afterRows))
      return yield* refusal(
        "The complete ordered physical rows differ from their acknowledged candidates.",
      )
    const after = normalizeObservedBody(observed.markdown)
    yield* createChecked(() => {
      if (review.version === 1)
        assertPhysicalCodeRepairReadback({
          expected: decoded.file.projection.markdown,
          before: decoded.before,
          after,
          row: review.before_row,
        })
      else {
        if (decoded.literal === undefined)
          throw fail("SOURCE_FILE_REPAIR_REQUIRED", "Missing literal proposal.")
        assertTableLiteralProgress(
          decoded.literal,
          new Set(decoded.afterRows.map((_, at) => at)),
          after,
        )
        assertImportedMarkdownContent(decoded.file.projection.markdown, after)
      }
    })
    yield* verifyRetainedRepairInput(library, decoded)
    return after
  }).pipe(withReadOnlyNotion)
}

function verifyRetainedRepairInput(
  library: SharedLibrary,
  decoded: Effect.Success<ReturnType<typeof validatePlan>>,
) {
  return Effect.gen(function* () {
    const review = decoded.review
    const saved = yield* querySharedRecords(library, {
      skillPageId: review.skill_page_id,
      kind: "operation",
      entityId: reviewsEntity,
      recordId: reviewRecord(review.operation_id, review.file_id),
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
  }).pipe(withReadOnlyNotion)
}

type RowAcknowledgement = typeof SourceMutationAcknowledgementSchema.Type
function acknowledgedRows(
  library: SharedLibrary,
  review: RepairReview,
  afterRows: readonly (typeof RepairTableRowSchema.Type)[],
) {
  return Effect.gen(function* () {
    const acks: (RowAcknowledgement | undefined)[] = []
    let missing = false
    for (const row of afterRows) {
      const ack = yield* localRowAcknowledgement(library, review, row)
      if (ack === undefined) missing = true
      else if (missing)
        return yield* refusal("The acknowledged physical repair prefix is not contiguous.")
      acks.push(ack)
    }
    return acks
  })
}

function verifyRepairProgress(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  decoded: Effect.Success<ReturnType<typeof validatePlan>>,
  acks: readonly (RowAcknowledgement | undefined)[],
) {
  return Effect.gen(function* () {
    const review = decoded.review
    const current = yield* inspectRetainedImportFileRepairPrefix(
      library,
      plan,
      review.skill_page_id,
      review.path,
    )
    if (
      current.original.row.hash !== review.failure_sha256 ||
      (yield* hash(current.journal.journal)) !== review.journal_sha256 ||
      !same(current.bindings, review.bindings) ||
      !same(
        current.proofs.map((p) => p.reference),
        review.allocations,
      ) ||
      !same(current.observations, review.other_bodies)
    )
      return yield* refusal("The original allocation or untouched prefix changed after review.")
    const body = normalizeObservedBody(current.markdown)
    if (decoded.literal !== undefined)
      yield* createChecked(() =>
        assertTableLiteralProgress(
          decoded.literal!,
          new Set(acks.flatMap((ack, at) => (ack === undefined ? [] : [at]))),
          body,
        ),
      )
    else if (body !== decoded.before)
      return yield* refusal("The complete original file body changed after review.")
    const physical =
      decoded.literal === undefined
        ? [yield* currentRow(review.file_page_id, originalRows(review)[0]!)]
        : yield* physicalLiteralRows(review.file_page_id, decoded.literal, false)
    for (const [at, row] of originalRows(review).entries()) {
      const expected = acks[at] === undefined ? row : decoded.afterRows[at]!
      if (!sameNativeRepairRow(physical[at]!, expected))
        return yield* refusal("A physical row differs from its exact acknowledged repair prefix.")
    }
    return current
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
      outcome.version !== review.version ||
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
      review.version === 1
        ? {
            version: 1 as const,
            ...deriveImportedTableCodePaddingRepair(checked.file.projection.markdown, before),
          }
        : {
            version: 2 as const,
            ...deriveTableLiteralRepair(checked.file.projection.markdown, before),
          },
    )
    if (!same(yield* bodyRef(candidate.markdown), review.candidate_body))
      return yield* refusal(
        "The complete repaired body differs from the single authorized code change.",
      )
    if (candidate.version === 2) {
      yield* createChecked(() => bindTableLiteralRows(candidate, originalRows(review)))
      yield* createChecked(() =>
        assertTableLiteralProgress(candidate, new Set(candidate.rows.map((_, at) => at)), after),
      )
    } else if (review.version === 1 && outcome.readback_policy === "physical_row_root_url_v1")
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
    const rowAcks = outcome.version === 1 ? [outcome.row_ack] : outcome.row_acks
    if (rowAcks.length !== checked.afterRows.length)
      return yield* refusal("The completion lacks its full ordered physical row ACK set.")
    for (const [at, row] of checked.afterRows.entries())
      yield* verifyRowAck(review, row, rowAcks[at])
    return {
      status: "reconciled" as const,
      verified: true as const,
      review_id: review.review_id,
      operation_id: plan.operation_id,
      page_id: review.skill_page_id,
      file_page_id: review.file_page_id,
      file_id: review.file_id,
      path: review.path,
      ...(outcome.version === 1
        ? { row_operation_id: outcome.row_ack.operation_id }
        : { row_operation_ids: outcome.row_acks.map((ack) => ack.operation_id) }),
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

type RepairProofCache = Map<string, SourceFileRepairProof>

function inspectSourceFileRepairsComplete(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  page: string,
  expected?: readonly SourceFileRepairProof[],
  cache?: RepairProofCache,
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
      const matching = outcomes.filter(
        (outcome) => outcome.record_id === outcomeRecord(plan.operation_id, review.file_id),
      )
      if (matching.length !== 1 || matching[0]!.operation_id !== review.review_id)
        return yield* refusal(
          "A repair outcome is missing, duplicated or belongs to another review.",
        )
      const cached = cache?.get(review.file_id)
      if (
        cached !== undefined &&
        cached.review_record_hash === row.hash &&
        cached.outcome_record_hash === matching[0]!.hash
      ) {
        proofs.push(cached)
        continue
      }
      const result = yield* completion(library, plan, review)
      if (!result)
        return yield* Effect.fail(
          fail("SOURCE_FILE_REPAIR_PENDING", "The exact original file repair is unresolved."),
        )
      if (
        result.proof.review_record_hash !== row.hash ||
        result.proof.outcome_record_hash !== matching[0]!.hash
      )
        return yield* refusal("The immutable repair records changed during complete verification.")
      cache?.set(review.file_id, result.proof)
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

export function assertSourceFileRepairsComplete(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  page: string,
  expected?: readonly SourceFileRepairProof[],
) {
  return inspectSourceFileRepairsComplete(library, plan, page, expected)
}

/** One original producer invocation owns this bounded memo. Every call still
 * fetches the complete repair index and validates its immutable hashes;
 * pending, removed or changed records never disappear behind cached bytes.
 * Current page, Source and owner checks are separate from historical proof. */
export function sourceFileRepairProofVerifier(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  page: string,
) {
  const cache: RepairProofCache = new Map()
  let scope: string | undefined
  return () =>
    Effect.gen(function* () {
      const current = yield* authScope
      if (scope !== current) {
        cache.clear()
        scope = current
      }
      return yield* inspectSourceFileRepairsComplete(library, plan, page, undefined, cache)
    })
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
      const acks = yield* acknowledgedRows(library, review, decoded.afterRows)
      const previouslyAcknowledged = acks.filter((ack) => ack !== undefined).length
      if (previouslyAcknowledged > 0) yield* verifyRetainedRepairInput(library, decoded)
      const before = verifyRepairProgress(library, plan, decoded, acks)
      if (input.dryRun) {
        if (previouslyAcknowledged < decoded.afterRows.length) yield* before
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
          table_row_patches: decoded.afterRows.length - previouslyAcknowledged,
          acknowledged_row_reused: previouslyAcknowledged > 0,
          acknowledged_rows: previouslyAcknowledged,
          native_pages_created: 0,
        }
      }
      // An already verified exact request/ACK resumes only proof publication.
      // Do not route it through a new mutation call or synthesize a verified
      // source result from current row equality.
      for (const [at, afterRow] of decoded.afterRows.entries()) {
        if (acks[at] !== undefined) continue
        acks[at] = yield* Effect.gen(function* () {
          const facts = yield* sharedCreateDispatch(
            library,
            { operation_id: review.review_id, skill_id: review.skill_id },
            before.pipe(Effect.asVoid),
          )
          const retain = Effect.gen(function* () {
            const current = yield* before
            // Once a real row ACK exists, the original full review must already
            // be retained. Never regenerate it from a partly repaired body.
            if (acks.some((ack) => ack !== undefined)) {
              yield* verifyRetainedRepairInput(library, decoded)
              return
            }
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
              ...rowRequest(review, afterRow),
              repeat: "never",
              beforeDispatch: retain,
              observeAcknowledged: (raw) =>
                createChecked(() =>
                  sameNativeRepairRow(nativeRepairTableRow(raw), afterRow)
                    ? { row_id: afterRow.row_id }
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
          return yield* verifyRowAck(review, afterRow, ack)
        })
      }
      const exactAcks: RowAcknowledgement[] = []
      for (const ack of acks) {
        if (ack === undefined) return yield* refusal("A physical row ACK is missing at completion.")
        exactAcks.push(ack)
      }
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
            ...(review.version === 1
              ? {
                  version: 1,
                  kind: "source_file_code_repair_completion",
                  row_ack: exactAcks[0],
                  readback_policy: "physical_row_root_url_v1",
                }
              : {
                  version: 2,
                  kind: "source_file_table_literal_repair_completion",
                  row_acks: exactAcks,
                  readback_policy: "physical_table_literals_v1",
                }),
            review_id: review.review_id,
            operation_id: plan.operation_id,
            skill_page_id: review.skill_page_id,
            file_id: review.file_id,
            after_body: yield* bodyRef(after),
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
        acknowledged_row_reused: previouslyAcknowledged > 0,
        acknowledged_rows_reused: previouslyAcknowledged,
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
    const acks = yield* acknowledgedRows(library, decoded.review, decoded.afterRows)
    const known = acks.flatMap((ack) => (ack === undefined ? [] : [ack]))
    if (known.length === 0)
      return yield* refusal(
        "No exact original row acknowledgement is retained; do not repeat the row write.",
      )
    const pending = known.length < decoded.afterRows.length
    if (pending) {
      yield* verifyRetainedRepairInput(library, decoded)
      yield* verifyRepairProgress(library, plan, decoded, acks)
    } else yield* verifiedAfterBody(library, plan, decoded)
    return {
      status: pending ? ("repair_pending" as const) : ("completion_pending" as const),
      verified: false as const,
      review_id: decoded.review.review_id,
      operation_id: plan.operation_id,
      page_id: decoded.review.skill_page_id,
      file_page_id: decoded.review.file_page_id,
      file_id: decoded.review.file_id,
      path: decoded.review.path,
      ...(decoded.review.version === 1
        ? { row_operation_id: known[0]!.operation_id }
        : { row_operation_ids: known.map((ack) => ack.operation_id) }),
      acknowledged_row_reused: true,
      table_row_patches: decoded.afterRows.length - known.length,
      acknowledged_rows: known.length,
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
