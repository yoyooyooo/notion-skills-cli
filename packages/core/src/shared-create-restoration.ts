import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { fail, property, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { pageId } from "./ref.ts"
import {
  createChecked,
  validateSharedCreatePlan,
  sharedCreateManifest,
  SharedCreateJournalSchema,
  sharedCreateOutcomesEntity,
  sharedCreateManifestEntity,
  sharedCreateEnabled,
  sharedCreateFiles,
  type SharedCreatePlan,
} from "./shared-create-model.ts"
import {
  SharedCreateOutcomeSchema,
  decodeSharedCreateOutcome,
  sharedCreateOutcomeId,
  sharedCreateManifestRecordHash,
  type SharedCreateOutcome,
  type SharedCreateBinding,
} from "./shared-create-outcome.ts"
import {
  executeSharedCreate,
  reconcileSharedCreate,
  loadSharedCreatePlan,
  sharedCreateJournalKey,
  sharedCreateMainRequest,
  sharedCreateFileRequest,
  verifySharedCreateRecoveryScope,
  verifySharedCreateRecoveryIndex,
} from "./shared-create.ts"
import { sharedCreateDispatch } from "./shared-create-dispatch.ts"
import { originalKnownCreateBootstrap } from "./shared-create-recovery-known-bootstrap.ts"
import { SharedCreateKnownBootstrapSchema } from "./shared-create-recovery-acknowledgement-model.ts"
import {
  observeSharedCreatePrefixBody,
  assertSharedCreateAcknowledgedMetadata,
} from "./shared-create-recovery-prefix-model.ts"
import { sourceField } from "./shared-source-definitions.ts"
import {
  SharedCreateRecoveryBindingSchema,
  SharedCreateKnownRecoveryObservationSchema,
} from "./shared-create-recovery-proof-model.ts"
import { prepareSharedNativeAllocationProof } from "./shared-create-recovery-acknowledgements.ts"
import { sharedCreateRecoveryJournalKey } from "./shared-create-recovery-prefix.ts"
import { FileEventSchema, normalizeObservedBody, type FileEvent } from "./shared-file-state.ts"
import {
  assertImportedMarkdownContent,
  assertImportedTablePlusRepairable,
} from "./shared-import-markdown.ts"
import { restoreNativeImportReadbacks } from "./shared-create-import-readback.ts"
import { withObservedBody } from "./shared-create-import-readback.ts"
import { querySharedSkillIndex } from "./shared-skill-index.ts"
import {
  sharedCreateLocalLinks,
  assertCreateLocalLinkPreimage,
  assertCreateBodyRepairPreimage,
  SharedCreateTablePlusRepairSchema,
  repairSharedCreateLinkFile,
  observeSharedCreateLinkFile,
  readSharedCreateLinkRepair,
  sharedCreateLinkRepairProofsEntity,
  SharedCreateLinkRepairReferenceSchema,
  type SharedCreateLinkRepairReference,
} from "./shared-create-link-repair.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import { preservesSharedLibraryBindings, type SharedLibrary } from "./shared-library-model.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  validateSharedRecordEnvelope,
} from "./shared-records.ts"
import { sha256, Store } from "./store.ts"
import { querySharedOperationIndex, type SharedOperationHeader } from "./shared-operation-index.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const OriginalId = Schema.String.check(Schema.isPattern(/^skill-create-[a-f0-9]{64}$/u))
const ReviewId = Schema.String.check(Schema.isPattern(/^create-restore-[a-f0-9]{64}$/u))
const ReviewFields = {
  kind: Schema.Literal("skill_create_restoration_review"),
  review_id: ReviewId,
  original_operation_id: OriginalId,
  original_plan_sha256: Hash,
  original_manifest_sha256: Hash,
  library_id: Schema.String,
  skill_id: Schema.String,
  skill_page_id: Schema.String,
  bootstrap: SharedCreateKnownBootstrapSchema,
  bindings: Schema.Array(SharedCreateRecoveryBindingSchema),
  observations: Schema.Array(SharedCreateKnownRecoveryObservationSchema),
}
const ReviewSchema = Schema.Union([
  Schema.Struct({
    ...ReviewFields,
    version: Schema.Literal(1),
    original_outcome_sha256: Hash,
    decision: Schema.Literal("resume_exact_original_candidate"),
  }),
  Schema.Struct({
    ...ReviewFields,
    version: Schema.Literal(2),
    original_outcome_sha256: Schema.Union([Hash, Schema.Null]),
    decision: Schema.Literal("resume_reviewed_import_readback"),
  }),
  Schema.Struct({
    ...ReviewFields,
    version: Schema.Literal(3),
    original_outcome_sha256: Hash,
    decision: Schema.Literal("repair_reviewed_local_links_and_resume"),
    local_links: Schema.Array(
      Schema.Struct({ from: Schema.String, href: Schema.String, target: Schema.String }),
    ),
  }),
  Schema.Struct({
    ...ReviewFields,
    version: Schema.Literal(4),
    original_outcome_sha256: Hash,
    decision: Schema.Literal("repair_reviewed_table_plus_and_resume"),
    table_plus: SharedCreateTablePlusRepairSchema,
  }),
])
export type SharedCreateRestorationReview = typeof ReviewSchema.Type
type BodyRepairReview = Extract<SharedCreateRestorationReview, { version: 3 | 4 }>
const isBodyRepairReview = (review: SharedCreateRestorationReview): review is BodyRepairReview =>
  review.version === 3 || review.version === 4
const CompletionFields = {
  kind: Schema.Literal("skill_create_restoration_outcome"),
  review_id: ReviewId,
  outcome: SharedCreateOutcomeSchema,
}
const CompletionSchema = Schema.Union([
  Schema.Struct({ ...CompletionFields, version: Schema.Literal(1), original_outcome_sha256: Hash }),
  Schema.Struct({
    ...CompletionFields,
    version: Schema.Literal(2),
    original_outcome_sha256: Schema.Union([Hash, Schema.Null]),
  }),
  Schema.Struct({
    ...CompletionFields,
    version: Schema.Literal(3),
    original_outcome_sha256: Hash,
    link_repair_proofs: Schema.Array(SharedCreateLinkRepairReferenceSchema),
  }),
  Schema.Struct({
    ...CompletionFields,
    version: Schema.Literal(4),
    original_outcome_sha256: Hash,
    table_plus_repair_proofs: Schema.Array(SharedCreateLinkRepairReferenceSchema),
  }),
])
const reviewEntity = "skill-create-restoration-reviews-v1"
export const sharedCreateRestorationOutcomesEntity = "skill-create-restoration-outcomes-v1"
const reviewRecordId = (operation: string) => "restoration-review-" + operation
const completionRecordId = (operation: string) => "restoration-outcome-" + operation
/** Metadata classification only; full completion still validates the retained review and ACK. */
export function sharedCreateRestorationOriginal(
  header: SharedOperationHeader,
  operations: readonly SharedOperationHeader[],
) {
  const prefix =
    header.entity_id === reviewEntity
      ? "restoration-review-"
      : header.entity_id === sharedCreateRestorationOutcomesEntity
        ? "restoration-outcome-"
        : undefined
  if (prefix === undefined || !header.record_id.startsWith(prefix)) return undefined
  const operation = header.record_id.slice(prefix.length)
  return /^skill-create-[a-f0-9]{64}$/u.test(operation) &&
    operations.some(
      (original) =>
        original.entity_id === sharedCreateManifestEntity && original.record_id === operation,
    )
    ? operation
    : undefined
}
const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const hash = (value: unknown) => sha256(canonicalSharedJson(value))
const refusal = (message: string) =>
  Effect.fail(fail("SHARED_CREATE_RESTORATION_REQUIRED", message))

function restorationPlan(input: unknown, allowLinks = false, allowTablePlus = false) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedCreatePlan(input)
    const completeMain =
      plan.complete_resources === 1 &&
      plan.content_kind === "skill" &&
      plan.files.length === 1 &&
      plan.files[0]?.path === plan.entrypoint &&
      plan.files[0]?.projection.version === 15 &&
      plan.default_context === false &&
      plan.members.length === 0 &&
      (plan.requires?.length ?? 0) === 0
    const completeLinks =
      allowLinks &&
      plan.complete_resources === 1 &&
      plan.content_kind === "skill" &&
      plan.files.length > 1 &&
      plan.files.every(
        (file) => file.projection.version === 14 || file.projection.version === 15,
      ) &&
      plan.default_context === false &&
      plan.members.length === 0 &&
      (plan.requires?.length ?? 0) === 0 &&
      sharedCreateLocalLinks(plan).length > 0
    const completeTablePlus =
      allowTablePlus &&
      plan.complete_resources === 1 &&
      plan.content_kind === "skill" &&
      plan.enabled === false &&
      plan.files.length > 1 &&
      plan.files.every((file) => file.projection.version === 14) &&
      plan.default_context === false &&
      plan.members.length === 0 &&
      (plan.requires?.length ?? 0) === 0
    if (
      plan.version !== 1 ||
      plan.source_projection !== undefined ||
      (!completeMain &&
        !completeLinks &&
        !completeTablePlus &&
        (plan.complete_resources !== undefined || (plan.resources?.length ?? 0) !== 0)) ||
      plan.files.some((file) => file.event.kind !== "adopted" || file.event.parents.length !== 0)
    )
      return yield* refusal(
        "Select the unchanged ordinary native create, or its complete v15 sole-main create with original raw resources and no relations.",
      )
    return plan
  })
}

export function validateSharedCreateRestorationReview(
  input: unknown,
  planInput: unknown,
  expectedId?: string,
) {
  return Effect.gen(function* () {
    const review = yield* createChecked(() =>
      Schema.decodeUnknownSync(ReviewSchema)(input, { onExcessProperty: "error" }),
    )
    const plan = yield* restorationPlan(planInput, review.version === 3, review.version === 4)
    const { review_id, ...fields } = review
    const main = plan.files.find((file) => file.path === plan.entrypoint)!
    const binding = review.bindings[0],
      observation = review.observations[0]
    if (
      review_id !== "create-restore-" + (yield* hash(fields)) ||
      (expectedId !== undefined && review_id !== expectedId) ||
      review.original_operation_id !== plan.operation_id ||
      review.original_plan_sha256 !== (yield* hash(plan)) ||
      review.original_manifest_sha256 !== (yield* hash(sharedCreateManifest(plan))) ||
      review.library_id !== plan.library.library_id ||
      review.skill_id !== plan.skill_id ||
      (review.version === 2 || isBodyRepairReview(review)) !== (plan.complete_resources === 1) ||
      pageId(review.skill_page_id) !== review.skill_page_id ||
      review.bootstrap.kind !==
        (review.original_outcome_sha256 === null
          ? "acknowledged_main_before_manifest"
          : "known_needs_review") ||
      (isBodyRepairReview(review)
        ? review.bootstrap.allocations.length !== review.bindings.length
        : review.bootstrap.allocations.length !== 1) ||
      (isBodyRepairReview(review)
        ? review.bindings.length < 1 || review.bindings.length > plan.files.length
        : review.bindings.length !== 1) ||
      !binding ||
      binding.file_id !== main.file_id ||
      binding.path !== main.path ||
      (!isBodyRepairReview(review) && binding.event_id !== main.event.event_id) ||
      binding.page_id !== review.skill_page_id ||
      review.observations.length !== review.bindings.length ||
      !observation ||
      observation.file_id !== main.file_id ||
      observation.page_id !== review.skill_page_id ||
      (review.version === 1 &&
        (observation.body_sha256 !== main.content.sha256 ||
          observation.body_bytes !== main.content.bytes)) ||
      review.bootstrap.allocations[0]?.file_id !== main.file_id
    )
      return yield* refusal(
        "The restoration review no longer binds the exact original main, complete input and unchanged candidate.",
      )
    const ordered = [main, ...plan.files.filter((file) => file.path !== plan.entrypoint)]
    for (const [at, current] of review.bindings.entries()) {
      const file = ordered[at],
        observed = review.observations[at],
        allocation = review.bootstrap.allocations[at]
      if (
        !file ||
        !observed ||
        !allocation ||
        current.file_id !== file.file_id ||
        current.path !== file.path ||
        observed.file_id !== current.file_id ||
        observed.page_id !== current.page_id ||
        allocation.file_id !== current.file_id ||
        pageId(current.page_id) !== current.page_id
      )
        return yield* refusal(
          "The restoration does not bind one exact original acknowledged file prefix.",
        )
      yield* prepareSharedNativeAllocationProof(
        plan,
        review.skill_page_id,
        current,
        allocation.acknowledgement,
        { attemptId: plan.operation_id, file },
      )
    }
    if (
      review.version === 3 &&
      (!same(review.local_links, sharedCreateLocalLinks(plan)) ||
        review.local_links.length === 0 ||
        new Set(review.bindings.map((item) => item.page_id)).size !== review.bindings.length)
    )
      return yield* refusal(
        "The local-link review changed the original declared destinations or allocated pages.",
      )
    if (review.version === 4) {
      const selected = review.table_plus
      const file = plan.files.find((item) => item.file_id === selected.file_id)
      const original = review.bindings.at(-1)
      const observed = review.observations.at(-1)
      const normalized = normalizeObservedBody(selected.before_markdown)
      if (
        !file ||
        !original ||
        !observed ||
        file.path === plan.entrypoint ||
        original.file_id !== file.file_id ||
        selected.path !== file.path ||
        selected.input_sha256 !== file.input.sha256 ||
        selected.mode !== (file.input.mode ?? null) ||
        selected.before_sha256 !== (yield* sha256(selected.before_markdown)) ||
        selected.before_bytes !== new TextEncoder().encode(selected.before_markdown).length ||
        observed.body_sha256 !== (yield* sha256(normalized)) ||
        observed.body_bytes !== new TextEncoder().encode(normalized).length ||
        !Number.isSafeInteger(selected.changed_literals) ||
        selected.changed_literals < 1
      )
        return yield* refusal(
          "The table-literal review must bind the exact last acknowledged supporting file and its full original preimage.",
        )
      yield* createChecked(() =>
        assertCreateBodyRepairPreimage(plan, file, selected.before_markdown, review),
      )
    }
    yield* createChecked(() => validateSharedRecordEnvelope(review.review_id, review, "operation"))
    return { plan, review }
  })
}

function originalOutcome(library: SharedLibrary, plan: SharedCreatePlan, page: string) {
  return Effect.gen(function* () {
    const rows = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      entityId: sharedCreateOutcomesEntity,
      recordId: sharedCreateOutcomeId(plan.operation_id),
    })
    if (rows.length !== 1)
      return yield* refusal("The immutable original creation failure is required.")
    const row = rows[0]!
    const outcome = yield* createChecked(() => decodeSharedCreateOutcome(row))
    if (
      outcome.version !== 1 ||
      outcome.status !== "needs_review" ||
      outcome.reason_code !== "SHARED_CREATE_BODY_MISMATCH" ||
      outcome.operation_id !== plan.operation_id ||
      outcome.skill_id !== plan.skill_id ||
      outcome.skill_page_id !== page ||
      outcome.source_projection !== undefined
    )
      return yield* refusal(
        "Only the original ordinary native body-mismatch failure can be restored.",
      )
    return { row, outcome }
  })
}

function observeRestoredMain(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  page: string,
  bindings: readonly SharedCreateBinding[],
  initial: boolean,
  review?: SharedCreateRestorationReview,
) {
  return Effect.gen(function* () {
    yield* verifySharedCreateRecoveryScope(library, plan, page)
    if (initial) yield* verifySharedCreateRecoveryIndex(library, plan, page, bindings, false, true)
    const raw = yield* (yield* Notion).request("v1/pages/" + page)
    if (initial)
      yield* createChecked(() =>
        assertSharedCreateAcknowledgedMetadata(sharedCreateMainRequest(plan.library, plan), raw),
      )
    const origin = library.skills.property_ids.Origin
    if (origin !== undefined) {
      const relation = sourceField(raw, origin)
      if (
        relation.has_more === true ||
        !Array.isArray(relation.relation) ||
        relation.relation.length !== 0
      )
        return yield* refusal("The original native main acquired a Source origin.")
    }
    const sourceMember = library.skills.property_ids["Source Member"]
    if (sourceMember !== undefined && text(sourceField(raw, sourceMember).rich_text) !== "")
      return yield* refusal("The original native main acquired a Source member.")
    const main = plan.files.find((file) => file.path === plan.entrypoint)!
    const body = yield* (yield* Notion).request(
      "v1/pages/" + page + "/markdown?markdown_version=v2",
    )
    const observed = yield* observeSharedCreatePrefixBody(main.file_id, page, body)
    if (plan.complete_resources === 1) {
      yield* createChecked(() =>
        assertImportedMarkdownContent(
          main.projection.markdown,
          normalizeObservedBody(String(property(body).markdown)),
        ),
      )
      if (
        review !== undefined &&
        (review.version !== 2 ||
          review.observations[0]?.body_sha256 !== observed.body_sha256 ||
          review.observations[0]?.body_bytes !== observed.body_bytes)
      )
        return yield* refusal(
          "The complete current main changed after the explicit readback review.",
        )
    } else if (
      observed.body_sha256 !== main.content.sha256 ||
      observed.body_bytes !== main.content.bytes
    )
      return yield* refusal(
        "The complete current main body does not equal the exact original frozen candidate.",
      )
    return {
      file_id: observed.file_id,
      page_id: observed.page_id,
      format: "notion_markdown_v2" as const,
      normalization_version: 1 as const,
      response_sha256: observed.response_sha256,
      body_sha256: observed.body_sha256,
      body_bytes: observed.body_bytes,
      truncated: false as const,
      unknown_block_count: 0 as const,
      warning_count: 0 as const,
      has_more: false as const,
      next_cursor: null,
    }
  }).pipe(withReadOnlyNotion)
}

/** Current rows identify only the original ordered prefix. Native allocation
 * authority still comes from the original dispatch ACKs, never these rows. */
export function currentSharedCreateLinkBindings(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  page: string,
) {
  return Effect.gen(function* () {
    const index = yield* querySharedSkillIndex(library, page),
      allocated = [index.main, ...index.files]
    const ordered = [
      ...plan.files.filter((file) => file.path === plan.entrypoint),
      ...plan.files.filter((file) => file.path !== plan.entrypoint),
      ...(plan.resources ?? []),
    ]
    if (allocated.length > ordered.length)
      return yield* refusal("The original linked owner contains an undeclared file.")
    const bindings: SharedCreateBinding[] = []
    for (const file of ordered.slice(0, allocated.length)) {
      const matches = allocated.filter(
        (row) => row.file_id === file.file_id && row.path === file.path,
      )
      if (matches.length !== 1 || !matches[0])
        return yield* refusal("The linked owner no longer contains one exact original file prefix.")
      bindings.push({
        file_id: file.file_id,
        path: file.path,
        page_id: matches[0].page_id,
        event_id: file.event.event_id,
      })
    }
    if (
      bindings[0]?.page_id !== page ||
      new Set(bindings.map((item) => item.page_id)).size !== bindings.length
    )
      return yield* refusal("The original linked owner has a changed or duplicate page binding.")
    return bindings
  })
}
function linkObservation(
  observed: Effect.Success<ReturnType<typeof observeSharedCreatePrefixBody>>,
) {
  return {
    file_id: observed.file_id,
    page_id: observed.page_id,
    format: "notion_markdown_v2" as const,
    normalization_version: 1 as const,
    response_sha256: observed.response_sha256,
    body_sha256: observed.body_sha256,
    body_bytes: observed.body_bytes,
    truncated: false as const,
    unknown_block_count: 0 as const,
    warning_count: 0 as const,
    has_more: false as const,
    next_cursor: null,
  }
}
/** A resumed v4 journal cannot authorize a second operation on this owner.
 * Headers are only commitments: a repair header also needs its complete ACK proof. */
export function verifySharedTablePlusRestorationOperations(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  review: Extract<SharedCreateRestorationReview, { version: 4 }>,
) {
  return Effect.gen(function* () {
    const allowed = new Map([
      [
        plan.operation_id,
        {
          entity_id: sharedCreateManifestEntity,
          hash: yield* sharedCreateManifestRecordHash(plan),
        },
      ],
      [
        sharedCreateOutcomeId(plan.operation_id),
        {
          entity_id: sharedCreateOutcomesEntity,
          hash: review.original_outcome_sha256,
        },
      ],
      [
        reviewRecordId(plan.operation_id),
        {
          entity_id: reviewEntity,
          hash: yield* hash({ version: 1, operation_id: review.review_id, payload: review }),
        },
      ],
    ])
    const proof = yield* readSharedCreateLinkRepair(
      library,
      plan,
      review,
      plan.files.find((file) => file.file_id === review.table_plus.file_id)!,
      review.bindings,
    )
    if (proof !== undefined)
      allowed.set(proof.reference.record_id, {
        entity_id: sharedCreateLinkRepairProofsEntity,
        hash: proof.reference.hash,
      })
    const headers = yield* querySharedOperationIndex(library, review.skill_page_id)
    const seen = new Set<string>()
    for (const header of headers) {
      const expected = allowed.get(header.record_id)
      if (
        !expected ||
        seen.has(header.record_id) ||
        header.entity_id !== expected.entity_id ||
        header.hash !== expected.hash
      )
        return yield* refusal(
          "Another operation or changed original fact now owns this incomplete table-literal restoration.",
        )
      seen.add(header.record_id)
    }
    if (
      !seen.has(plan.operation_id) ||
      !seen.has(sharedCreateOutcomeId(plan.operation_id)) ||
      (proof !== undefined && !seen.has(reviewRecordId(plan.operation_id)))
    )
      return yield* refusal("The exact original table-literal manifest or failure disappeared.")
  }).pipe(withReadOnlyNotion)
}

function observeRestoredLinkPrefix(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  review: BodyRepairReview,
  initial: boolean,
) {
  return Effect.gen(function* () {
    if (review.version === 4)
      yield* verifySharedTablePlusRestorationOperations(library, plan, review)
    yield* verifySharedCreateRecoveryScope(library, plan, review.skill_page_id)
    const bindings = yield* currentSharedCreateLinkBindings(library, plan, review.skill_page_id)
    if (
      bindings.length < review.bindings.length ||
      (initial && bindings.length !== review.bindings.length)
    )
      return yield* refusal("The original linked allocation prefix changed after review.")
    for (const expected of review.bindings) {
      const binding = bindings.find(
        (item) => item.file_id === expected.file_id && item.path === expected.path,
      )
      if (!binding || binding.page_id !== expected.page_id)
        return yield* refusal("An original linked page was removed or replaced.")
    }
    yield* verifySharedCreateRecoveryIndex(
      library,
      plan,
      review.skill_page_id,
      bindings,
      false,
      true,
    )
    for (const expected of review.bindings) {
      const file = plan.files.find((item) => item.file_id === expected.file_id)!
      const current = yield* observeSharedCreateLinkFile(
        library,
        plan,
        review,
        file,
        expected.page_id,
        bindings,
        false,
      )
      const original = review.observations.find((item) => item.file_id === expected.file_id)!
      if (
        current.phase === "before" &&
        (current.observation.body_sha256 !== original.body_sha256 ||
          current.observation.body_bytes !== original.body_bytes)
      )
        return yield* refusal("The exact reviewed original link preimage changed before repair.")
    }
  }).pipe(withReadOnlyNotion)
}

export function reviewSharedCreateRestoration(input: {
  readonly entry: string
  readonly plan: unknown
  readonly target: string
  readonly acceptedObservedSha256?: string
  readonly repairLocalLinks?: boolean
  readonly repairTablePlus?: string
}) {
  return Effect.gen(function* () {
    if (input.repairLocalLinks === true && input.repairTablePlus !== undefined)
      return yield* refusal("Select one original body-repair mode.")
    const plan = yield* restorationPlan(
        input.plan,
        input.repairLocalLinks === true,
        input.repairTablePlus !== undefined,
      ),
      page = pageId(input.target)
    if (!page) return yield* refusal("Select the exact original main page.")
    const library = yield* loadSharedLibrary(input.entry)
    if (!preservesSharedLibraryBindings(plan.library, library))
      return yield* refusal("The original create belongs to another library.")
    const original = yield* originalKnownCreateBootstrap(library, plan, page, undefined, {
      nativeBodyRecovery: input.repairLocalLinks === true || input.repairTablePlus !== undefined,
    })
    if (input.repairLocalLinks === true || input.repairTablePlus !== undefined) {
      if (
        input.acceptedObservedSha256 !== undefined ||
        original.originalOutcomeHash === null ||
        plan.files.length < 2
      )
        return yield* refusal(
          "Local-link restoration requires the original known complete multi-file failure and its own explicit review.",
        )
      const tableFile =
        input.repairTablePlus === undefined
          ? undefined
          : plan.files.find((file) => file.path === input.repairTablePlus)
      if (
        input.repairTablePlus !== undefined &&
        (!tableFile ||
          tableFile.path === plan.entrypoint ||
          original.bindings.at(-1)?.file_id !== tableFile.file_id)
      )
        return yield* refusal(
          "Select only the original failed supporting file at the end of its acknowledged prefix.",
        )
      yield* verifySharedCreateRecoveryScope(library, plan, page)
      yield* verifySharedCreateRecoveryIndex(library, plan, page, original.bindings, false, true)
      const observations = []
      let changes = 0
      let tablePlus: typeof SharedCreateTablePlusRepairSchema.Type | undefined
      for (const binding of original.bindings) {
        const file = plan.files.find((item) => item.file_id === binding.file_id)!
        const row = yield* (yield* Notion).request(`v1/pages/${binding.page_id}`)
        yield* createChecked(() =>
          assertSharedCreateAcknowledgedMetadata(
            binding.page_id === page
              ? sharedCreateMainRequest(plan.library, plan)
              : sharedCreateFileRequest(plan.library, page, file),
            row,
          ),
        )
        const raw = yield* (yield* Notion).request(
          `v1/pages/${binding.page_id}/markdown?markdown_version=v2`,
        )
        const observed = yield* observeSharedCreatePrefixBody(file.file_id, binding.page_id, raw)
        const markdown = normalizeObservedBody(String(property(raw).markdown))
        const changed = yield* createChecked(() => {
          if (input.repairTablePlus === undefined)
            return assertCreateLocalLinkPreimage(plan, file, markdown)
          if (file.file_id === tableFile!.file_id)
            return assertImportedTablePlusRepairable(file.projection.markdown, markdown)
          assertImportedMarkdownContent(file.projection.markdown, markdown)
          return 0
        })
        if (tableFile !== undefined && file.file_id === tableFile.file_id) {
          const before = String(property(raw).markdown)
          tablePlus = {
            file_id: file.file_id,
            path: file.path,
            input_sha256: file.input.sha256,
            mode: file.input.mode ?? null,
            before_markdown: before,
            before_sha256: yield* sha256(before),
            before_bytes: new TextEncoder().encode(before).length,
            changed_literals: changed,
          }
        }
        changes += changed
        const expectedEvent =
          changed === 0 && file.projection.version === 14
            ? (yield* withObservedBody(file, markdown)).event.event_id
            : file.event.event_id
        if (binding.event_id !== expectedEvent)
          return yield* refusal(
            "The original prefix event differs from its acknowledged pre-repair body.",
          )
        observations.push(linkObservation(observed))
      }
      if (changes === 0)
        return yield* refusal(
          "The original prefix has no proven local hostname conversion to repair.",
        )
      const fields = {
        kind: "skill_create_restoration_review" as const,
        original_operation_id: plan.operation_id,
        original_plan_sha256: yield* hash(plan),
        original_manifest_sha256: yield* hash(sharedCreateManifest(plan)),
        original_outcome_sha256: original.originalOutcomeHash,
        library_id: library.library_id,
        skill_id: plan.skill_id,
        skill_page_id: page,
        bootstrap: original.bootstrap,
        bindings: original.bindings,
        observations,
        ...(tablePlus === undefined
          ? {
              version: 3 as const,
              decision: "repair_reviewed_local_links_and_resume" as const,
              local_links: sharedCreateLocalLinks(plan),
            }
          : {
              version: 4 as const,
              decision: "repair_reviewed_table_plus_and_resume" as const,
              table_plus: tablePlus,
            }),
      }
      return (yield* validateSharedCreateRestorationReview(
        { ...fields, review_id: "create-restore-" + (yield* hash(fields)) },
        plan,
      )).review
    }
    const readback = plan.complete_resources === 1
    if ((!readback && original.originalOutcomeHash === null) || original.bindings.length !== 1)
      return yield* refusal("This restoration requires the original known one-main failure.")
    const observed = yield* observeRestoredMain(library, plan, page, original.bindings, true)
    if (
      readback &&
      (!/^[a-f0-9]{64}$/u.test(input.acceptedObservedSha256 ?? "") ||
        input.acceptedObservedSha256 !== observed.body_sha256)
    )
      return yield* refusal(
        "Explicitly accept the exact complete observed main SHA-256; a changed or unspecified readback is not authorized.",
      )
    if (!readback && input.acceptedObservedSha256 !== undefined)
      return yield* refusal(
        "Observed readback acceptance requires the complete sole-main v15 create.",
      )
    const fields = {
      version: readback ? (2 as const) : (1 as const),
      kind: "skill_create_restoration_review" as const,
      original_operation_id: plan.operation_id,
      original_plan_sha256: yield* hash(plan),
      original_manifest_sha256: yield* hash(sharedCreateManifest(plan)),
      original_outcome_sha256: original.originalOutcomeHash,
      library_id: library.library_id,
      skill_id: plan.skill_id,
      skill_page_id: page,
      decision: readback
        ? ("resume_reviewed_import_readback" as const)
        : ("resume_exact_original_candidate" as const),
      bootstrap: original.bootstrap,
      bindings: original.bindings,
      observations: [observed],
    }
    const review = { ...fields, review_id: "create-restore-" + (yield* hash(fields)) }
    return (yield* validateSharedCreateRestorationReview(review, plan)).review
  }).pipe(withReadOnlyNotion)
}

export function saveSharedCreateRestorationCompletion(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  review: SharedCreateRestorationReview,
  bindings: readonly SharedCreateBinding[],
  linkRepairProofs: readonly SharedCreateLinkRepairReference[] = [],
) {
  const outcome: SharedCreateOutcome = {
    version: 1,
    kind: "skill_create_outcome",
    operation_id: plan.operation_id,
    skill_id: plan.skill_id,
    skill_page_id: review.skill_page_id,
    status: "applied",
    reason_code:
      review.version === 4
        ? "REPAIRED_ORIGINAL_TABLE_PLUS_AND_COMPLETE_RESOURCES_VERIFIED"
        : review.version === 3
          ? "REPAIRED_ORIGINAL_LOCAL_LINKS_AND_COMPLETE_RESOURCES_VERIFIED"
          : review.version === 2
            ? "REVIEWED_ORIGINAL_READBACK_AND_RESOURCES_VERIFIED"
            : "EXACT_ORIGINAL_CANDIDATE_RESTORED_AND_TREE_VERIFIED",
    bindings,
  }
  return appendSharedRecord(library, {
    mode: "create",
    recordId: completionRecordId(plan.operation_id),
    operationId: review.review_id,
    skillPageId: review.skill_page_id,
    kind: "operation",
    entityId: sharedCreateRestorationOutcomesEntity,
    payload: {
      version: review.version,
      kind: "skill_create_restoration_outcome",
      review_id: review.review_id,
      original_outcome_sha256: review.original_outcome_sha256,
      outcome,
      ...(review.version === 3 ? { link_repair_proofs: linkRepairProofs } : {}),
      ...(review.version === 4 ? { table_plus_repair_proofs: linkRepairProofs } : {}),
    },
  })
}

export function readSharedCreateRestoration(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  page: string,
  failed: SharedCreateOutcome | undefined,
  failureHash: string | null,
  suppliedEvents?: readonly FileEvent[],
) {
  return Effect.gen(function* () {
    const completions = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      recordId: completionRecordId(plan.operation_id),
    })
    if (completions.length === 0) return undefined
    const completion = completions[0]!
    const payload = yield* createChecked(() =>
      Schema.decodeUnknownSync(CompletionSchema)(completion.payload, { onExcessProperty: "error" }),
    )
    const reviews = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      recordId: reviewRecordId(plan.operation_id),
    })
    if (completions.length !== 1 || reviews.length !== 1)
      return yield* refusal("The original restoration review and completion must be unique.")
    const reviewed = reviews[0]!
    const { review } = yield* validateSharedCreateRestorationReview(
      reviewed.payload,
      plan,
      payload.review_id,
    )
    const outcome = payload.outcome
    const originalPreserved =
      failed === undefined
        ? review.version === 2 &&
          review.original_outcome_sha256 === null &&
          failureHash === null &&
          review.bootstrap.kind === "acknowledged_main_before_manifest"
        : failed.version === 1 &&
          failed.status === "needs_review" &&
          failed.reason_code === "SHARED_CREATE_BODY_MISMATCH" &&
          failed.operation_id === plan.operation_id &&
          failed.skill_id === plan.skill_id &&
          failed.skill_page_id === page &&
          failed.source_projection === undefined &&
          same(failed.bindings, review.bindings) &&
          review.original_outcome_sha256 === failureHash
    if (
      !originalPreserved ||
      payload.version !== review.version ||
      payload.original_outcome_sha256 !== failureHash ||
      completion.entity_id !== sharedCreateRestorationOutcomesEntity ||
      completion.operation_id !== review.review_id ||
      reviewed.entity_id !== reviewEntity ||
      reviewed.operation_id !== review.review_id ||
      review.skill_page_id !== page ||
      outcome.version !== 1 ||
      outcome.status !== "applied" ||
      outcome.source_projection !== undefined ||
      outcome.operation_id !== plan.operation_id ||
      outcome.skill_id !== plan.skill_id ||
      outcome.skill_page_id !== page ||
      outcome.bindings.length !== sharedCreateFiles(plan).length ||
      new Set(outcome.bindings.map((binding) => binding.page_id)).size !== outcome.bindings.length
    )
      return yield* refusal(
        "The restoration completion does not preserve its exact original failure, page and review.",
      )
    const events =
      suppliedEvents ??
      (yield* querySharedRecords(library, { skillPageId: page, kind: "file_event" })).map((row) =>
        Schema.decodeUnknownSync(FileEventSchema)(row.payload, { onExcessProperty: "error" }),
      )
    const linkRepairs: Array<{ file_id: string; body_sha256: string }> = []
    if (isBodyRepairReview(review)) {
      if (payload.version !== 3 && payload.version !== 4)
        return yield* refusal("The body-repair completion has another version.")
      const references =
        payload.version === 3 ? payload.link_repair_proofs : payload.table_plus_repair_proofs
      const files = plan.files.filter((file) =>
        review.version === 3
          ? review.local_links.some((link) => link.from === file.path)
          : review.table_plus.file_id === file.file_id,
      )
      if (
        references.length !== files.length ||
        new Set(references.map((item) => item.file_id)).size !== files.length
      )
        return yield* refusal(
          "The linked completion lacks one exact PATCH proof for every linked body.",
        )
      for (const file of files) {
        const reference = references.find((item) => item.file_id === file.file_id)
        if (!reference)
          return yield* refusal("A final linked body has no original repair acknowledgement.")
        const proof = yield* readSharedCreateLinkRepair(
          library,
          plan,
          review,
          file,
          outcome.bindings,
          reference,
        )
        if (!proof) return yield* refusal("A final local-link proof is unavailable.")
        const initial = review.observations.find((item) => item.file_id === file.file_id)
        if (
          initial &&
          (initial.body_sha256 !== (yield* sha256(normalizeObservedBody(proof.before))) ||
            initial.body_bytes !==
              new TextEncoder().encode(normalizeObservedBody(proof.before)).length)
        )
          return yield* refusal(
            "The acknowledged PATCH replaced another reviewed original preimage.",
          )
        linkRepairs.push({
          file_id: file.file_id,
          body_sha256: yield* sha256(normalizeObservedBody(proof.markdown)),
        })
      }
    }
    const facts =
      review.version === 2 || isBodyRepairReview(review)
        ? yield* restoreNativeImportReadbacks(plan, page, outcome.bindings, [], linkRepairs)
        : plan
    if (
      review.version === 2 &&
      (facts.files[0]?.content.sha256 !== review.observations[0]?.body_sha256 ||
        facts.files[0]?.content.bytes !== review.observations[0]?.body_bytes)
    )
      return yield* refusal(
        "The retained completion does not contain the exact explicitly reviewed main bytes.",
      )
    for (const file of sharedCreateFiles(facts)) {
      const bindings = outcome.bindings.filter((binding) => binding.file_id === file.file_id)
      if (
        bindings.length !== 1 ||
        bindings[0]!.path !== file.path ||
        bindings[0]!.event_id !== file.event.event_id ||
        pageId(bindings[0]!.page_id) !== bindings[0]!.page_id ||
        (file.path === plan.entrypoint && bindings[0]!.page_id !== page) ||
        !events.some((event) => same(event, file.event))
      )
        return yield* refusal(
          "The restoration completion lacks the complete original file and initial event set.",
        )
    }
    return { review, outcome, facts }
  }).pipe(withReadOnlyNotion)
}

export function applySharedCreateRestoration(input: {
  readonly entry: string
  readonly plan: unknown
  readonly review: unknown
  readonly reviewId: string
  readonly dryRun?: boolean
}) {
  const work = Effect.gen(function* () {
    const { plan, review } = yield* validateSharedCreateRestorationReview(
      input.review,
      input.plan,
      input.reviewId,
    )
    const library = yield* loadSharedLibrary(input.entry)
    if (!preservesSharedLibraryBindings(plan.library, library))
      return yield* refusal("The restoration belongs to another exact library.")
    const completed = yield* reconcileSharedCreate(library, plan).pipe(Effect.result)
    if (completed._tag === "Success") return completed.success
    if (review.original_outcome_sha256 === null) {
      const outcomes = yield* querySharedRecords(library, {
        skillPageId: review.skill_page_id,
        kind: "operation",
        entityId: sharedCreateOutcomesEntity,
        recordId: sharedCreateOutcomeId(plan.operation_id),
      })
      if (outcomes.length !== 0)
        return yield* refusal(
          "The reviewed original main unexpectedly acquired another terminal outcome.",
        )
    } else {
      const failure = yield* originalOutcome(library, plan, review.skill_page_id)
      if (
        failure.row.hash !== review.original_outcome_sha256 ||
        !same(failure.outcome.bindings, review.bindings)
      )
        return yield* refusal("The immutable original body-mismatch outcome changed.")
    }
    const store = yield* Store,
      scope = yield* authScope
    const key = yield* sharedCreateRecoveryJournalKey(scope, library.library_id, plan.operation_id)
    const journal = yield* store.readJson(key, Schema.Unknown)
    const expectedJournal = {
      version: review.version === 4 ? 8 : review.version === 3 ? 7 : review.version === 2 ? 5 : 4,
      scope,
      library_id: library.library_id,
      review,
    }
    const namespace = yield* hash([
      yield* (yield* Notion).credentialIdentity,
      plan.library.library_id,
      plan.library.sources?.data_source_id ?? null,
    ])
    for (const [at, binding] of review.bindings.entries()) {
      const file = plan.files.find((item) => item.file_id === binding.file_id)!
      const allocation = yield* prepareSharedNativeAllocationProof(
        plan,
        review.skill_page_id,
        binding,
        review.bootstrap.allocations[at]!.acknowledgement,
        { attemptId: plan.operation_id, file },
      )
      const acknowledgementKey = `operations/shared-sources/${namespace}/source-ack-${allocation.payload.dispatch.operation.slice("source-op-".length)}.json`
      if (
        !same(
          yield* store.readJson(acknowledgementKey, Schema.Unknown),
          review.bootstrap.allocations[at]!.acknowledgement,
        )
      )
        return yield* refusal(
          "An original prefix page's complete durable ACK is missing or changed.",
        )
    }
    if (
      (yield* store.listKeys("operations/shared-native-recovery/")).some(
        (other) => other !== key && other.endsWith("/" + plan.operation_id + ".json"),
      )
    )
      return yield* refusal(
        "This original restoration already belongs to another credential scope.",
      )
    if (journal === undefined) {
      const original = yield* originalKnownCreateBootstrap(
        library,
        plan,
        review.skill_page_id,
        undefined,
        { nativeBodyRecovery: isBodyRepairReview(review) },
      )
      if (
        !same(original.bootstrap, review.bootstrap) ||
        original.originalOutcomeHash !== review.original_outcome_sha256
      )
        return yield* refusal("The original request and durable ACK set changed after review.")
    } else {
      if (!same(journal, expectedJournal))
        return yield* refusal("The original restoration journal changed.")
      const originalKey = yield* sharedCreateJournalKey(
        scope,
        library.library_id,
        plan.operation_id,
      )
      const original = yield* store.readJson(originalKey, SharedCreateJournalSchema)
      if (
        original === undefined ||
        (yield* hash(original)) !== review.bootstrap.original_journal_sha256 ||
        !same(original.plan, plan)
      )
        return yield* refusal("The original create journal is missing or changed.")
      const restored = yield* loadSharedCreatePlan(library, {
        skillPageId: review.skill_page_id,
        operationId: plan.operation_id,
      })
      if (!same(restored, plan))
        return yield* refusal("The complete retained original input changed.")
    }
    if (
      isBodyRepairReview(review) &&
      !(yield* (yield* sharedCreateDispatch(plan.library, plan)).canResume)
    )
      return yield* refusal(
        "An original native or link PATCH request remains unknown; preserve it without any new write.",
      )
    if (isBodyRepairReview(review))
      yield* observeRestoredLinkPrefix(library, plan, review, journal === undefined)
    else
      yield* observeRestoredMain(
        library,
        plan,
        review.skill_page_id,
        review.bindings,
        journal === undefined,
        review,
      )
    if (input.dryRun)
      return {
        status: "planned" as const,
        dry_run: true as const,
        verified: false as const,
        original_operation_id: plan.operation_id,
        restoration_operation_id: review.review_id,
        skill_page_id: review.skill_page_id,
        original_status:
          review.original_outcome_sha256 === null
            ? ("acknowledged_main_before_manifest" as const)
            : ("needs_review" as const),
        original_failure_preserved: true as const,
        write_plan: {
          original_native_file_suffix: sharedCreateFiles(plan)
            .filter((file) => !review.bindings.some((binding) => binding.file_id === file.file_id))
            .map((file) => ({ file_id: file.file_id, path: file.path })),
          maximum_native_page_creates: sharedCreateFiles(plan).length - review.bindings.length,
          existing_body_patches:
            review.version === 4
              ? 1
              : review.version === 3
                ? new Set(review.local_links.map((link) => link.from)).size
                : 0,
          enabled: sharedCreateEnabled(plan),
          record_ids: [
            reviewRecordId(plan.operation_id),
            ...sharedCreateFiles(plan)
              .filter((file) => review.version === 1 || file.path !== plan.entrypoint)
              .map((file) => file.event.event_id),
            completionRecordId(plan.operation_id),
          ],
          ...(review.version === 2
            ? { reviewed_main_sha256: review.observations[0]!.body_sha256 }
            : {}),
        },
        review,
      }
    if (journal === undefined) yield* store.writeJson(key, expectedJournal)
    const dispatch = yield* sharedCreateDispatch(
      plan.library,
      {
        operation_id: review.review_id,
        skill_id: plan.skill_id,
      },
      isBodyRepairReview(review)
        ? observeRestoredLinkPrefix(library, plan, review, journal === undefined)
        : observeRestoredMain(
            library,
            plan,
            review.skill_page_id,
            review.bindings,
            true,
            review,
          ).pipe(Effect.asVoid),
    )
    yield* appendSharedRecord(library, {
      mode: "create",
      recordId: reviewRecordId(plan.operation_id),
      operationId: review.review_id,
      skillPageId: review.skill_page_id,
      kind: "operation",
      entityId: reviewEntity,
      payload: review,
    }).pipe(Effect.provideService(Notion, dispatch.api))
    if (review.version === 4) {
      const file = plan.files.find((item) => item.file_id === review.table_plus.file_id)!
      const binding = review.bindings.find((item) => item.file_id === file.file_id)!
      yield* observeSharedCreateLinkFile(
        library,
        plan,
        review,
        file,
        binding.page_id,
        review.bindings,
      )
      yield* repairSharedCreateLinkFile(
        library,
        plan,
        review,
        file,
        binding.page_id,
        review.bindings,
        observeRestoredLinkPrefix(library, plan, review, true),
        () => {},
      )
    }
    const result = yield* executeSharedCreate(library, {
      plan,
      mode: "create",
      restoration: review,
    })
    yield* store.retireKeys([key])
    return {
      ...result,
      restoration_operation_id: review.review_id,
      original_failure_preserved: true as const,
    }
  })
  return input.dryRun ? work.pipe(withReadOnlyNotion) : work
}

export function reconcileSharedCreateRestoration(input: {
  readonly entry: string
  readonly plan: unknown
  readonly target: string
}) {
  return Effect.gen(function* () {
    const plan = yield* restorationPlan(input.plan, true, true),
      library = yield* loadSharedLibrary(input.entry)
    const result = yield* reconcileSharedCreate(library, plan)
    if (result.skill_page_id !== pageId(input.target))
      return yield* refusal("The original restoration belongs to another page.")
    return {
      ...result,
      original_failure_preserved: true as const,
      current_snapshot_verified: false as const,
    }
  }).pipe(withReadOnlyNotion)
}
