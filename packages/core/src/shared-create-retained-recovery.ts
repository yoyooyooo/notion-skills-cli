import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { fail, property } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { pageId } from "./ref.ts"
import {
  createChecked,
  SharedCreateJournalSchema,
  sharedCreateOutcomesEntity,
  validateSharedCreatePlan,
  type SharedCreatePlan,
} from "./shared-create-model.ts"
import {
  decodeSharedCreateOutcome,
  SharedCreateOutcomeSchema,
  sharedCreateOutcomeId,
  sharedCreateManifestRecordHash,
  type SharedCreateBinding,
  type SharedCreateOutcome,
  type SharedCreateProjectionRepairProof,
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
import {
  observeNativeImportFile,
  restoreNativeImportReadbacks,
} from "./shared-create-import-readback.ts"
import { resolveSharedCreateSource } from "./shared-create-source.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import { preservesSharedLibraryBindings, type SharedLibrary } from "./shared-library-model.ts"
import { SharedCreateRecoveryBindingSchema } from "./shared-create-recovery-proof-model.ts"
import {
  SharedCreateKnownBootstrapSchema,
  SharedNativeAllocationReferenceSchema,
} from "./shared-create-recovery-acknowledgement-model.ts"
import {
  prepareSharedNativeAllocationProof,
  retainSharedNativeAllocationProofs,
  readSharedNativeAllocationProofs,
} from "./shared-create-recovery-acknowledgements.ts"
import { sharedCreateRecoveryJournalKey } from "./shared-create-recovery-prefix.ts"
import { SourceMutationAcknowledgementSchema } from "./shared-sources-model.ts"
import { sharedCreateRestorationOutcomesEntity } from "./shared-create-restoration.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  validateSharedRecordEnvelope,
} from "./shared-records.ts"
import { Store, sha256 } from "./store.ts"
import type { SharedOperationHeader } from "./shared-operation-index.ts"
import { sharedCreateManifestEntity } from "./shared-create-model.ts"
import { sharedCreateManifest } from "./shared-create-model.ts"
import { querySharedSkillIndex } from "./shared-skill-index.ts"
import { observeSharedCreatePrefixBody } from "./shared-create-recovery-prefix-model.ts"
import { SourceFileRepairProofSchema } from "./shared-native-table-code-repair.ts"
import { assertSourceFileRepairsComplete } from "./shared-source-file-repair.ts"
import {
  SourceFileResubmissionCompletionReferenceSchema,
  type VerifiedNativeFileSubstitution,
} from "./shared-source-file-resubmission-model.ts"
import { loadCompletedSourceFileResubmissions } from "./shared-source-file-resubmission.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const ReviewId = Schema.String.check(Schema.isPattern(/^retained-readback-[a-f0-9]{64}$/u))
const ReviewSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("retained_create_readback_review"),
  review_id: ReviewId,
  original_operation_id: Schema.String,
  permission_scope: Schema.String,
  library_id: Schema.String,
  skill_id: Schema.String,
  skill_page_id: Schema.String,
  source_id: Schema.String,
  original_plan_sha256: Hash,
  original_manifest_sha256: Hash,
  original_failure_sha256: Hash,
  decision: Schema.Literal("resume_semantically_verified_original_import"),
  bootstrap: SharedCreateKnownBootstrapSchema,
  bindings: Schema.Array(SharedCreateRecoveryBindingSchema),
  allocations: Schema.Array(SharedNativeAllocationReferenceSchema),
  observations: Schema.Array(
    Schema.Struct({
      file_id: Schema.String,
      page_id: Schema.String,
      body_sha256: Hash,
      body_bytes: Schema.Number,
      event_id: Schema.String,
    }),
  ),
  file_repair_proofs: Schema.optionalKey(Schema.Array(SourceFileRepairProofSchema)),
})
export type SharedRetainedImportRecoveryReview = typeof ReviewSchema.Type
const CompletionFields = {
  kind: Schema.Literal("retained_create_readback_completion"),
  review_id: ReviewId,
  original_failure_sha256: Hash,
  outcome: SharedCreateOutcomeSchema,
}
const CompletionSchema = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), ...CompletionFields }),
  Schema.Struct({
    version: Schema.Literal(2),
    ...CompletionFields,
    file_resubmissions: Schema.Array(SourceFileResubmissionCompletionReferenceSchema),
  }),
])
export const retainedImportRecoveryReviewsEntity = "retained-create-readback-reviews-v1"
const reviewRecordId = (operation: string) => "retained-readback-review-" + operation
const completionRecordId = (operation: string) => "retained-readback-outcome-" + operation
/** Metadata classification only; the original create reader still verifies the
 * full review, old failure, native ACKs and immutable completion at content depth. */
export function retainedImportRecoveryOriginal(
  header: SharedOperationHeader,
  operations: readonly SharedOperationHeader[],
) {
  const prefix =
    header.entity_id === retainedImportRecoveryReviewsEntity
      ? "retained-readback-review-"
      : header.entity_id === sharedCreateRestorationOutcomesEntity
        ? "retained-readback-outcome-"
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
const same = (a: unknown, b: unknown) => canonicalSharedJson(a) === canonicalSharedJson(b)
const hash = (value: unknown) => sha256(canonicalSharedJson(value))
function completionOperationId(completion: typeof CompletionSchema.Type) {
  return Effect.gen(function* () {
    if (completion.version === 1) return completion.review_id
    // The parent fact itself records that independent allocation proof is mandatory.
    // Removing the other proof indexes cannot turn this envelope into a legacy completion.
    return (
      "retained-readback-resubmitted-" +
      (yield* hash({
        review_id: completion.review_id,
        file_resubmissions: completion.file_resubmissions,
      }))
    )
  })
}
const refusal = (message: string) =>
  Effect.fail(fail("SHARED_CREATE_RETAINED_REVIEW_REQUIRED", message))

function retainedPlan(input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedCreatePlan(input)
    if (
      plan.version !== 1 ||
      plan.source_projection?.version !== 2 ||
      plan.enabled !== false ||
      plan.default_context !== false ||
      plan.content_kind !== "skill" ||
      (plan.resources?.length ?? 0) !== 0 ||
      plan.files.length === 0 ||
      plan.files.some(
        (file) =>
          file.projection.version !== 14 ||
          file.event.kind !== "source_projection_pending" ||
          file.event.parents.length !== 0 ||
          file.ancestors !== undefined,
      )
    )
      return yield* refusal(
        "Select the original disabled retained-source native import with unchanged complete input and policy 14.",
      )
    return plan
  })
}

function readOriginalFailure(library: SharedLibrary, plan: SharedCreatePlan, page: string) {
  return Effect.gen(function* () {
    const rows = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      entityId: sharedCreateOutcomesEntity,
      recordId: sharedCreateOutcomeId(plan.operation_id),
    })
    if (rows.length !== 1)
      return yield* refusal("The immutable original known failure is missing or duplicated.")
    const row = rows[0]!,
      outcome = yield* createChecked(() => decodeSharedCreateOutcome(row))
    const resolved = yield* resolveSharedCreateSource(plan, page)
    const selection = resolved.selection
    const ordered = [
      plan.files.find((file) => file.path === plan.entrypoint)!,
      ...plan.files.filter((file) => file.path !== plan.entrypoint),
    ]
    if (
      !selection ||
      outcome.version !== 1 ||
      outcome.operation_id !== plan.operation_id ||
      outcome.skill_id !== plan.skill_id ||
      outcome.skill_page_id !== page ||
      outcome.status !== "needs_review" ||
      outcome.reason_code !== "SHARED_CREATE_BODY_MISMATCH" ||
      !same(outcome.source_projection, {
        source_id: selection.source_id,
        revision: selection.revision,
        manifest_record_hash: yield* sharedCreateManifestRecordHash(plan),
      }) ||
      outcome.bindings.length < 1 ||
      outcome.bindings.length > ordered.length ||
      outcome.bindings[0]?.page_id !== page ||
      new Set(outcome.bindings.map((item) => item.page_id)).size !== outcome.bindings.length ||
      outcome.bindings.some(
        (binding, index) =>
          binding.file_id !== ordered[index]?.file_id ||
          binding.path !== ordered[index]?.path ||
          pageId(binding.page_id) !== binding.page_id,
      )
    )
      return yield* refusal(
        "Only a known original semantic readback failure with its exact acknowledged native prefix is eligible.",
      )
    return { row, outcome, resolved }
  })
}

function readOriginalJournal(plan: SharedCreatePlan) {
  return Effect.gen(function* () {
    const scope = yield* authScope,
      store = yield* Store
    const key = yield* sharedCreateJournalKey(scope, plan.library.library_id, plan.operation_id)
    const journal = yield* store.readJson(key, SharedCreateJournalSchema)
    if (
      !journal ||
      journal.scope !== scope ||
      journal.library_id !== plan.library.library_id ||
      journal.dispatch_receipt_version !== 1 ||
      journal.ownership_receipt_version !== 1 ||
      !same(journal.plan, plan)
    )
      return yield* refusal(
        "The original credential-scoped journal and unchanged full plan are required.",
      )
    return { scope, journal }
  })
}

function originalJournal(
  plan: SharedCreatePlan,
  substitutions: readonly VerifiedNativeFileSubstitution[] = [],
) {
  return Effect.gen(function* () {
    const original = yield* readOriginalJournal(plan)
    const dispatch = yield* sharedCreateDispatch(plan.library, plan, undefined, substitutions)
    if (!(yield* dispatch.canResume))
      return yield* refusal(
        "An original native write lacks its durable acknowledgement; do not replay it.",
      )
    return { ...original, dispatch }
  })
}

function allocationProof(
  plan: SharedCreatePlan,
  page: string,
  binding: SharedCreateBinding,
  file: SharedCreatePlan["files"][number],
) {
  return Effect.gen(function* () {
    const api = yield* Notion,
      store = yield* Store
    const body =
      binding.page_id === page
        ? sharedCreateMainRequest(plan.library, plan)
        : sharedCreateFileRequest(plan.library, page, file)
    const request = {
      identity: plan.operation_id + ":" + (yield* hash(["v1/pages", "POST", body])),
      path: "v1/pages",
      method: "POST",
      body,
    }
    const dispatch = { version: 1, operation: "source-op-" + (yield* hash(request)), ...request }
    const namespace = yield* hash([
      yield* api.credentialIdentity,
      plan.library.library_id,
      plan.library.sources?.data_source_id ?? null,
    ])
    const key = `operations/shared-sources/${namespace}/${dispatch.operation}.json`
    const recorded = yield* store.readJson(key, Schema.Unknown)
    const ack = yield* store.readJson(
      `operations/shared-sources/${namespace}/source-ack-${dispatch.operation.slice("source-op-".length)}.json`,
      SourceMutationAcknowledgementSchema,
    )
    if (!same(recorded, dispatch) || ack === undefined)
      return yield* refusal(
        "The exact original native POST and durable ACK are required for every preserved page.",
      )
    return yield* prepareSharedNativeAllocationProof(plan, page, binding, ack, {
      attemptId: plan.operation_id,
      file,
    })
  })
}

function observePrefix(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  page: string,
  bindings: readonly SharedCreateBinding[],
  inspectionScope: "full" | "allocated" = "full",
) {
  return Effect.gen(function* () {
    yield* verifySharedCreateRecoveryScope(library, plan, page, inspectionScope)
    const resolved = yield* resolveSharedCreateSource(plan, page),
      scope = yield* authScope
    const files = [...resolved.facts.files],
      observations: SharedRetainedImportRecoveryReview["observations"][number][] = []
    for (const binding of bindings) {
      const index = files.findIndex(
        (file) => file.file_id === binding.file_id && file.path === binding.path,
      )
      if (index < 0) return yield* refusal("A reviewed page is not an exact original file.")
      const file = yield* observeNativeImportFile(
        resolved.facts,
        files[index]!,
        scope,
        page,
        binding.page_id,
        { retainObservation: false },
      )
      files[index] = file
      observations.push({
        file_id: binding.file_id,
        page_id: binding.page_id,
        body_sha256: file.content.sha256,
        body_bytes: file.content.bytes,
        event_id: file.event.event_id,
      })
    }
    return { facts: { ...resolved.facts, files }, original: resolved.facts, observations, resolved }
  }).pipe(withReadOnlyNotion)
}

/** Read the original known-failure authority for one already allocated file.
 * Every other allocated prefix member must remain semantically intact. The
 * target's actual full body is returned without pretending it already passed.
 * A later acknowledged suffix is allowed, but never a missing/unknown native
 * allocation, a replacement page, or published ownership events. */
export function inspectRetainedImportFileRepairPrefix(
  library: SharedLibrary,
  input: unknown,
  page: string,
  filePath: string,
) {
  return Effect.gen(function* () {
    const plan = yield* retainedPlan(input)
    if (!preservesSharedLibraryBindings(plan.library, library))
      return yield* refusal("The original library binding changed.")
    const original = yield* readOriginalFailure(library, plan, page)
    const manifests = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      entityId: sharedCreateManifestEntity,
      recordId: plan.operation_id,
    })
    if (
      manifests.length !== 1 ||
      manifests[0]!.hash !== (yield* sharedCreateManifestRecordHash(plan)) ||
      !same(manifests[0]!.payload, sharedCreateManifest(plan)) ||
      (yield* querySharedRecords(library, { skillPageId: page, kind: "file_event" })).length !== 0
    )
      return yield* refusal(
        "This file repair requires the complete original manifest and an unpublished initial tree.",
      )
    const journal = yield* originalJournal(plan)
    yield* verifySharedCreateRecoveryScope(library, plan, page)
    const index = yield* querySharedSkillIndex(library, page)
    const allocated = [index.main, ...index.files]
    const ordered = [
      plan.files.find((file) => file.path === plan.entrypoint)!,
      ...plan.files.filter((file) => file.path !== plan.entrypoint),
    ]
    if (allocated.length < original.outcome.bindings.length || allocated.length > ordered.length)
      return yield* refusal("The current allocation is not one original file prefix.")
    const bindings: SharedCreateBinding[] = []
    for (const file of ordered.slice(0, allocated.length)) {
      const matches = allocated.filter(
        (row) => row.file_id === file.file_id && row.path === file.path,
      )
      if (matches.length !== 1)
        return yield* refusal("The exact original file allocation is missing or ambiguous.")
      const prior = original.outcome.bindings.find((row) => row.file_id === file.file_id)
      if (prior !== undefined && prior.page_id !== matches[0]!.page_id)
        return yield* refusal("An original acknowledged page was replaced.")
      bindings.push(
        prior ?? {
          file_id: file.file_id,
          path: file.path,
          page_id: matches[0]!.page_id,
          event_id: file.event.event_id,
        },
      )
    }
    const target = bindings.find((binding) => binding.path === filePath)
    if (!target || target.page_id === page)
      return yield* refusal(
        "Select one already acknowledged supporting file, not the original main or an unissued suffix.",
      )
    const files = [...original.resolved.facts.files]
    const observations: SharedRetainedImportRecoveryReview["observations"][number][] = []
    const proofs = []
    for (const binding of bindings) {
      const at = files.findIndex((file) => file.file_id === binding.file_id)
      const native = original.resolved.facts.files.find((file) => file.file_id === binding.file_id)!
      proofs.push(yield* allocationProof(plan, page, binding, native))
      if (binding.file_id === target.file_id) continue
      const observed = yield* observeNativeImportFile(
        original.resolved.facts,
        native,
        journal.scope,
        page,
        binding.page_id,
        { retainObservation: false },
      )
      files[at] = observed
      observations.push({
        file_id: binding.file_id,
        page_id: binding.page_id,
        body_sha256: observed.content.sha256,
        body_bytes: observed.content.bytes,
        event_id: observed.event.event_id,
      })
    }
    yield* verifySharedCreateRecoveryIndex(
      library,
      { ...original.resolved.facts, files },
      page,
      bindings,
      false,
      true,
      undefined,
      original.resolved.facts,
    )
    const raw = yield* (yield* Notion).request(
      `v1/pages/${target.page_id}/markdown?markdown_version=v2`,
    )
    const body = yield* observeSharedCreatePrefixBody(target.file_id, target.page_id, raw)
    const markdown = property(raw).markdown
    if (typeof markdown !== "string")
      return yield* refusal("The original supporting body is incomplete.")
    return {
      plan,
      original,
      journal,
      target,
      bindings,
      proofs,
      observations,
      markdown,
      body,
      file: original.resolved.facts.files.find((file) => file.file_id === target.file_id)!,
    }
  }).pipe(withReadOnlyNotion)
}

export function validateSharedRetainedImportRecoveryReview(
  input: unknown,
  planInput: unknown,
  expectedId?: string,
) {
  return Effect.gen(function* () {
    const plan = yield* retainedPlan(planInput)
    const review = yield* createChecked(() =>
      Schema.decodeUnknownSync(ReviewSchema)(input, { onExcessProperty: "error" }),
    )
    const { review_id, ...fields } = review
    const { selection, facts } = yield* resolveSharedCreateSource(plan, review.skill_page_id)
    if (
      review_id !== "retained-readback-" + (yield* hash(fields)) ||
      (expectedId !== undefined && review_id !== expectedId) ||
      review.original_operation_id !== plan.operation_id ||
      review.library_id !== plan.library.library_id ||
      review.skill_id !== plan.skill_id ||
      pageId(review.skill_page_id) !== review.skill_page_id ||
      review.original_plan_sha256 !== (yield* hash(plan)) ||
      review.original_manifest_sha256 !== (yield* sharedCreateManifestRecordHash(plan)) ||
      review.source_id !== selection?.source_id ||
      review.bootstrap.kind !== "known_needs_review" ||
      review.bindings.length === 0 ||
      review.observations.length !== review.bindings.length ||
      review.bootstrap.allocations.length !== review.bindings.length ||
      review.allocations.length !== review.bindings.length
    )
      return yield* refusal(
        "The independently reviewed digest, original source or prefix no longer agrees with the unchanged plan.",
      )
    const proofs = []
    for (const [index, binding] of review.bindings.entries()) {
      const file = facts.files.find(
        (file) => file.file_id === binding.file_id && file.path === binding.path,
      )
      const original = review.bootstrap.allocations[index],
        observation = review.observations[index]
      if (
        !file ||
        !original ||
        original.file_id !== binding.file_id ||
        observation?.file_id !== binding.file_id ||
        observation.page_id !== binding.page_id ||
        !Number.isSafeInteger(observation.body_bytes) ||
        observation.body_bytes < 0
      )
        return yield* refusal("The reviewed native prefix is incomplete or changed.")
      const proof = yield* prepareSharedNativeAllocationProof(
        plan,
        review.skill_page_id,
        binding,
        original.acknowledgement,
        { attemptId: plan.operation_id, file },
      )
      if (!same(proof.reference, review.allocations[index]))
        return yield* refusal("The frozen native ACK differs from its immutable proof reference.")
      proofs.push(proof)
    }
    if (
      review.bootstrap.original_dispatches_sha256 !==
      (yield* hash(proofs.map((proof) => proof.payload.dispatch)))
    )
      return yield* refusal(
        "The original dispatch commitment does not match the complete native acknowledgement proofs.",
      )
    yield* createChecked(() => validateSharedRecordEnvelope(review.review_id, review, "operation"))
    return { plan, review, proofs }
  })
}

/** Immutable authority shared by rejected-file review and cold completion readers.
 * Reading the original journal never grants permission to replay its rejected POST. */
export function readRetainedImportResubmissionAuthority(
  library: SharedLibrary,
  input: unknown,
  page: string,
) {
  return Effect.gen(function* () {
    const plan = yield* retainedPlan(input)
    if (!preservesSharedLibraryBindings(plan.library, library))
      return yield* refusal("The original library binding changed.")
    const original = yield* readOriginalFailure(library, plan, page)
    const manifests = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      entityId: sharedCreateManifestEntity,
      recordId: plan.operation_id,
    })
    const reviews = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      entityId: retainedImportRecoveryReviewsEntity,
      recordId: reviewRecordId(plan.operation_id),
    })
    if (
      manifests.length !== 1 ||
      manifests[0]!.hash !== (yield* sharedCreateManifestRecordHash(plan)) ||
      !same(manifests[0]!.payload, sharedCreateManifest(plan)) ||
      reviews.length !== 1
    )
      return yield* refusal(
        "The complete original manifest and authorized retained review are required.",
      )
    const validated = yield* validateSharedRetainedImportRecoveryReview(reviews[0]!.payload, plan)
    const review = validated.review
    if (
      reviews[0]!.operation_id !== review.review_id ||
      review.skill_page_id !== page ||
      review.original_failure_sha256 !== original.row.hash ||
      !same(review.bindings, original.outcome.bindings)
    )
      return yield* refusal("The retained recovery review does not preserve the original failure.")
    yield* assertSourceFileRepairsComplete(library, plan, page, review.file_repair_proofs ?? [])
    yield* readSharedNativeAllocationProofs(
      library,
      plan,
      page,
      review.bindings,
      review.allocations,
      (binding) => ({
        attemptId: plan.operation_id,
        file: original.resolved.facts.files.find((file) => file.file_id === binding.file_id)!,
      }),
    )
    return { plan, original, review, reviewRecord: reviews[0]! }
  }).pipe(withReadOnlyNotion)
}

/** Inspect a rejected, unallocated next file, or the exact independently ACKed
 * replacement while publishing its proof. The original dispatcher stays closed. */
export function inspectRetainedImportFileResubmissionPrefix(
  library: SharedLibrary,
  input: unknown,
  page: string,
  filePath: string,
  allocatedPage?: string,
) {
  return Effect.gen(function* () {
    const authority = yield* readRetainedImportResubmissionAuthority(library, input, page)
    const { plan, original, review } = authority
    if (
      (yield* querySharedRecords(library, { skillPageId: page, kind: "file_event" })).length !==
        0 ||
      (yield* querySharedRecords(library, {
        skillPageId: page,
        kind: "operation",
        entityId: sharedCreateRestorationOutcomesEntity,
        recordId: completionRecordId(plan.operation_id),
      })).length !== 0
    )
      return yield* refusal(
        "Rejected-file resubmission requires an unpublished, incomplete original import.",
      )
    const journal = yield* readOriginalJournal(plan)
    const key = yield* sharedCreateRecoveryJournalKey(
      journal.scope,
      library.library_id,
      plan.operation_id,
    )
    if (
      journal.scope !== review.permission_scope ||
      (yield* hash(journal.journal)) !== review.bootstrap.original_journal_sha256 ||
      !same(yield* (yield* Store).readJson(key, Schema.Unknown), {
        version: 6,
        scope: journal.scope,
        library_id: library.library_id,
        original_operation_id: plan.operation_id,
        review,
      })
    )
      return yield* refusal(
        "The original scoped recovery journal must retain the exact prior authorization.",
      )
    yield* verifySharedCreateRecoveryScope(library, plan, page)
    const index = yield* querySharedSkillIndex(library, page)
    const ordered = [
      original.resolved.facts.files.find((file) => file.path === plan.entrypoint)!,
      ...original.resolved.facts.files.filter((file) => file.path !== plan.entrypoint),
    ]
    const file = ordered.find((file) => file.path === filePath)
    if (!file || file.path === plan.entrypoint)
      return yield* refusal("Select one original supporting file.")
    const targetRows = index.files.filter(
      (row) => row.file_id === file.file_id || row.path === file.path,
    )
    if (
      allocatedPage === undefined
        ? targetRows.length !== 0
        : targetRows.length !== 1 ||
          targetRows[0]!.page_id !== allocatedPage ||
          targetRows[0]!.file_id !== file.file_id ||
          targetRows[0]!.path !== file.path
    )
      return yield* refusal(
        "The target allocation differs from its exact independent native acknowledgement.",
      )
    const allocated = [index.main, ...index.files.filter((row) => row.page_id !== allocatedPage)]
    if (
      allocated.length < original.outcome.bindings.length ||
      ordered[allocated.length]?.file_id !== file.file_id ||
      new Set(allocated.map((row) => row.page_id)).size !== allocated.length
    )
      return yield* refusal(
        "Only the next rejected file after the complete original acknowledged prefix is eligible.",
      )
    const bindings: SharedCreateBinding[] = []
    const proofs = []
    for (const native of ordered.slice(0, allocated.length)) {
      const matches = allocated.filter(
        (row) => row.file_id === native.file_id && row.path === native.path,
      )
      const prior = original.outcome.bindings.find((row) => row.file_id === native.file_id)
      if (matches.length !== 1 || (prior !== undefined && prior.page_id !== matches[0]!.page_id))
        return yield* refusal("An original prefix page is missing, duplicated or replaced.")
      const binding = prior ?? {
        file_id: native.file_id,
        path: native.path,
        page_id: matches[0]!.page_id,
        event_id: native.event.event_id,
      }
      bindings.push(binding)
      proofs.push(yield* allocationProof(plan, page, binding, native))
    }
    const observed = yield* observePrefix(library, plan, page, bindings, "allocated")
    if (review.observations.some((old) => !observed.observations.some((now) => same(old, now))))
      return yield* refusal("An originally reviewed complete prefix body changed.")
    const allBindings = [...bindings]
    let allocatedFile: Effect.Success<ReturnType<typeof observeNativeImportFile>> | undefined
    if (allocatedPage !== undefined) {
      allocatedFile = yield* observeNativeImportFile(
        original.resolved.facts,
        file,
        journal.scope,
        page,
        allocatedPage,
        { retainObservation: false },
      )
      observed.facts.files[
        observed.facts.files.findIndex((item) => item.file_id === file.file_id)
      ] = allocatedFile
      allBindings.push({
        file_id: file.file_id,
        path: file.path,
        page_id: allocatedPage,
        event_id: allocatedFile.event.event_id,
      })
    }
    yield* verifySharedCreateRecoveryIndex(
      library,
      observed.facts,
      page,
      allBindings,
      false,
      true,
      undefined,
      original.resolved.facts,
    )
    return {
      ...authority,
      journal,
      file,
      bindings,
      proofs,
      observations: observed.observations,
      facts: observed.facts,
      allocatedFile,
    }
  }).pipe(withReadOnlyNotion)
}

export function reviewSharedRetainedImportRecovery(input: {
  readonly entry: string
  readonly plan: unknown
  readonly target: string
}) {
  return Effect.gen(function* () {
    const plan = yield* retainedPlan(input.plan),
      page = pageId(input.target)
    if (!page) return yield* refusal("Select the exact original main page.")
    const library = yield* loadSharedLibrary(input.entry)
    if (!preservesSharedLibraryBindings(plan.library, library))
      return yield* refusal("The frozen plan belongs to another registered library.")
    const original = yield* readOriginalFailure(library, plan, page)
    const fileRepairProofs = yield* assertSourceFileRepairsComplete(library, plan, page)
    if (
      (yield* querySharedRecords(library, { skillPageId: page, kind: "file_event" })).length !== 0
    )
      return yield* refusal(
        "Initial ownership facts already exist; this bounded native-prefix review cannot replace them.",
      )
    if (
      !same(
        yield* loadSharedCreatePlan(library, { skillPageId: page, operationId: plan.operation_id }),
        plan,
      )
    )
      return yield* refusal("The complete shared inputs no longer reconstruct the original plan.")
    const journal = yield* originalJournal(plan)
    const observed = yield* observePrefix(library, plan, page, original.outcome.bindings)
    yield* verifySharedCreateRecoveryIndex(
      library,
      observed.facts,
      page,
      original.outcome.bindings,
      false,
      true,
      undefined,
      observed.original,
    )
    const proofs = yield* Effect.forEach(original.outcome.bindings, (binding) =>
      allocationProof(
        plan,
        page,
        binding,
        observed.original.files.find((file) => file.file_id === binding.file_id)!,
      ),
    )
    const fields = {
      version: 1 as const,
      kind: "retained_create_readback_review" as const,
      original_operation_id: plan.operation_id,
      permission_scope: journal.scope,
      library_id: library.library_id,
      skill_id: plan.skill_id,
      skill_page_id: page,
      source_id: observed.resolved.selection!.source_id,
      original_plan_sha256: yield* hash(plan),
      original_manifest_sha256: yield* sharedCreateManifestRecordHash(plan),
      original_failure_sha256: original.row.hash,
      decision: "resume_semantically_verified_original_import" as const,
      bootstrap: {
        kind: "known_needs_review" as const,
        original_journal_sha256: yield* hash(journal.journal),
        original_dispatches_sha256: yield* hash(proofs.map((proof) => proof.payload.dispatch)),
        allocations: proofs.map((proof) => ({
          file_id: proof.payload.file_id,
          acknowledgement: proof.payload.acknowledgement,
        })),
      },
      bindings: original.outcome.bindings,
      allocations: proofs.map((proof) => proof.reference),
      observations: observed.observations,
      ...(fileRepairProofs.length === 0 ? {} : { file_repair_proofs: fileRepairProofs }),
    }
    const review = { ...fields, review_id: "retained-readback-" + (yield* hash(fields)) }
    yield* validateSharedRetainedImportRecoveryReview(review, plan)
    return review
  }).pipe(withReadOnlyNotion)
}

/** The only new execution permission is a separately persisted explicit review.
 * This never substitutes current values for the original native response. */
export function assertSharedRetainedImportRecovery(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  review: SharedRetainedImportRecoveryReview,
  substitutions: readonly VerifiedNativeFileSubstitution[] = [],
  inspectionScope: "full" | "allocated" = "full",
) {
  return Effect.gen(function* () {
    yield* assertSourceFileRepairsComplete(
      library,
      plan,
      review.skill_page_id,
      review.file_repair_proofs ?? [],
    )
    const local = yield* originalJournal(plan, substitutions)
    if (
      local.scope !== review.permission_scope ||
      (yield* hash(local.journal)) !== review.bootstrap.original_journal_sha256
    )
      return yield* refusal("Continue only from the original scoped journal and approved review.")
    const key = yield* sharedCreateRecoveryJournalKey(
      local.scope,
      library.library_id,
      plan.operation_id,
    )
    const authority = yield* (yield* Store).readJson(key, Schema.Unknown)
    if (
      !same(authority, {
        version: 6,
        scope: local.scope,
        library_id: library.library_id,
        original_operation_id: plan.operation_id,
        review,
      })
    )
      return yield* refusal(
        "The exact explicit retained-import recovery review has not been authorized in this Store.",
      )
    const original = yield* readOriginalFailure(library, plan, review.skill_page_id)
    if (
      original.row.hash !== review.original_failure_sha256 ||
      !same(original.outcome.bindings, review.bindings)
    )
      return yield* refusal("The original known failure or allocation prefix changed.")
    const observed = yield* observePrefix(
      library,
      plan,
      review.skill_page_id,
      review.bindings,
      inspectionScope,
    )
    if (!same(observed.observations, review.observations))
      return yield* refusal(
        "A reviewed complete native body changed; preserve the original review and pages.",
      )
    for (const binding of review.bindings)
      yield* allocationProof(
        plan,
        review.skill_page_id,
        binding,
        observed.original.files.find((file) => file.file_id === binding.file_id)!,
      )
    if (substitutions.length > 0) {
      const index = yield* querySharedSkillIndex(library, review.skill_page_id)
      const checks = new Map<
        string,
        {
          readonly observation: SharedRetainedImportRecoveryReview["observations"][number]
        }
      >()
      for (const replacement of substitutions) {
        if (
          replacement.original_operation_id !== plan.operation_id ||
          replacement.prefix_bindings.length !== replacement.prefix_observations.length
        )
          return yield* refusal(
            "A file substitution changed its original operation or acknowledged prefix.",
          )
        for (const [at, binding] of replacement.prefix_bindings.entries()) {
          const body = replacement.prefix_observations[at]!
          if (body.file_id !== binding.file_id || body.page_id !== binding.page_id)
            return yield* refusal(
              "The independent prefix body belongs to another original allocation.",
            )
          if (review.bindings.some((old) => old.file_id === binding.file_id)) continue
          const native = observed.original.files.find(
            (file) => file.file_id === binding.file_id && file.path === binding.path,
          )
          if (!native)
            return yield* refusal("The later acknowledged prefix is not an original file.")
          yield* allocationProof(plan, review.skill_page_id, binding, native)
          checks.set(binding.file_id, { observation: body })
        }
        checks.set(replacement.file_id, { observation: replacement.observation })
      }
      for (const [fileId, check] of checks) {
        const native = observed.original.files.find((file) => file.file_id === fileId)
        if (!native || native.path === plan.entrypoint)
          return yield* refusal(
            "Only exact supporting files may use independent resubmission evidence.",
          )
        const matching = index.files.filter(
          (row) =>
            row.file_id === fileId ||
            row.path === native.path ||
            row.page_id === check.observation.page_id,
        )
        const row = matching[0]
        if (
          matching.length !== 1 ||
          row?.file_id !== fileId ||
          row.path !== native.path ||
          row.page_id !== check.observation.page_id
        )
          return yield* refusal(
            "An independently reviewed native file changed its exact owner, path or page.",
          )
        const current = yield* observeNativeImportFile(
          original.resolved.facts,
          native,
          local.scope,
          review.skill_page_id,
          check.observation.page_id,
          { retainObservation: false },
        )
        if (
          current.content.sha256 !== check.observation.body_sha256 ||
          current.content.bytes !== check.observation.body_bytes ||
          current.event.event_id !== check.observation.event_id
        )
          return yield* refusal(
            "A later acknowledged prefix or independently created body changed before continuation.",
          )
        const baseline =
          current.event.kind === "projected"
            ? { ...current.event.projection, source_revision: current.event.source_revision }
            : null
        const originalBaseline =
          native.event.kind === "projected"
            ? { ...native.event.projection, source_revision: native.event.source_revision }
            : null
        if (
          (!same(row.baseline ?? null, baseline) &&
            !same(row.baseline ?? null, originalBaseline)) ||
          row.display_status !==
            (current.event.kind === "projected"
              ? "following"
              : current.event.kind === "deleted"
                ? "tombstone"
                : "custom")
        )
          return yield* refusal(
            "The reviewed native file no longer has its original or observed reading baseline.",
          )
      }
    }
  }).pipe(withReadOnlyNotion)
}

export function saveSharedRetainedImportCompletion(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  review: SharedRetainedImportRecoveryReview,
  bindings: readonly SharedCreateBinding[],
  projectionRepair?: SharedCreateProjectionRepairProof,
  substitutions: readonly VerifiedNativeFileSubstitution[] = [],
) {
  return Effect.gen(function* () {
    const selection = (yield* resolveSharedCreateSource(plan, review.skill_page_id)).selection!
    const outcome: SharedCreateOutcome = {
      version: 1,
      kind: "skill_create_outcome",
      operation_id: plan.operation_id,
      skill_id: plan.skill_id,
      skill_page_id: review.skill_page_id,
      status: "applied",
      reason_code: "retained_import_readback_verified",
      bindings,
      ...(projectionRepair === undefined ? {} : { projection_repair: projectionRepair }),
      source_projection: {
        source_id: selection.source_id,
        revision: selection.revision,
        manifest_record_hash: yield* sharedCreateManifestRecordHash(plan),
      },
    }
    const fields = {
      kind: "retained_create_readback_completion" as const,
      review_id: review.review_id,
      original_failure_sha256: review.original_failure_sha256,
      outcome,
    }
    const payload =
      substitutions.length === 0
        ? { version: 1 as const, ...fields }
        : {
            version: 2 as const,
            ...fields,
            file_resubmissions: substitutions.map((item) => item.completion_reference),
          }
    return yield* appendSharedRecord(library, {
      mode: "create",
      kind: "operation",
      skillPageId: review.skill_page_id,
      recordId: completionRecordId(plan.operation_id),
      entityId: sharedCreateRestorationOutcomesEntity,
      operationId: yield* completionOperationId(payload),
      payload,
    })
  })
}

/** Independent clients require the retained review, full original ACK facts and
 * complete immutable events; an output label alone never settles the failure. */
export function readSharedRetainedImportCompletion(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  page: string,
  failed: SharedCreateOutcome,
  failureHash: string,
) {
  return Effect.gen(function* () {
    if (plan.version !== 1 || plan.source_projection?.version !== 2) return undefined
    const rows = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      entityId: sharedCreateRestorationOutcomesEntity,
      recordId: completionRecordId(plan.operation_id),
    })
    if (rows.length === 0) return undefined
    if (rows.length !== 1) return yield* refusal("The retained import completion is duplicated.")
    const row = rows[0]!,
      completion = yield* createChecked(() =>
        Schema.decodeUnknownSync(CompletionSchema)(row.payload, { onExcessProperty: "error" }),
      )
    const reviews = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      entityId: retainedImportRecoveryReviewsEntity,
      recordId: reviewRecordId(plan.operation_id),
    })
    if (reviews.length !== 1)
      return yield* refusal("The independent retained recovery review is missing or duplicated.")
    const { review } = yield* validateSharedRetainedImportRecoveryReview(
      reviews[0]!.payload,
      plan,
      completion.review_id,
    )
    const original = yield* readOriginalFailure(library, plan, page)
    const outcome = completion.outcome,
      selection = original.resolved.selection!
    if (
      original.row.hash !== failureHash ||
      completion.original_failure_sha256 !== failureHash ||
      review.original_failure_sha256 !== failureHash ||
      !same(original.outcome, failed) ||
      !same(review.bindings, failed.bindings) ||
      review.skill_page_id !== page ||
      row.operation_id !== (yield* completionOperationId(completion)) ||
      reviews[0]!.operation_id !== review.review_id ||
      outcome.version !== 1 ||
      outcome.status !== "applied" ||
      outcome.operation_id !== plan.operation_id ||
      outcome.skill_id !== plan.skill_id ||
      outcome.skill_page_id !== page ||
      !same(outcome.source_projection, {
        source_id: selection.source_id,
        revision: selection.revision,
        manifest_record_hash: yield* sharedCreateManifestRecordHash(plan),
      }) ||
      outcome.bindings.length !== plan.files.length ||
      new Set(outcome.bindings.map((item) => item.file_id)).size !== plan.files.length ||
      new Set(outcome.bindings.map((item) => item.page_id)).size !== plan.files.length ||
      review.bindings.some(
        (old) =>
          !outcome.bindings.some(
            (current) =>
              current.file_id === old.file_id &&
              current.path === old.path &&
              current.page_id === old.page_id,
          ),
      )
    )
      return yield* refusal(
        "The recovery completion does not preserve its original failure, source, exact page prefix and complete file tree.",
      )
    yield* assertSourceFileRepairsComplete(library, plan, page, review.file_repair_proofs ?? [])
    yield* readSharedNativeAllocationProofs(
      library,
      plan,
      page,
      review.bindings,
      review.allocations,
      (binding) => ({
        attemptId: plan.operation_id,
        file: original.resolved.facts.files.find((file) => file.file_id === binding.file_id)!,
      }),
    )
    if (completion.version === 2 && completion.file_resubmissions.length === 0)
      return yield* refusal(
        "A resubmitted completion must carry its mandatory independent proof references.",
      )
    const substitutions = yield* loadCompletedSourceFileResubmissions(
      library,
      plan,
      page,
      completion.version === 2 ? completion.file_resubmissions : [],
    )
    const restored = yield* restoreNativeImportReadbacks(
      original.resolved.facts,
      page,
      outcome.bindings,
    )
    for (const observation of review.observations) {
      const file = restored.files.find((file) => file.file_id === observation.file_id)
      const binding = outcome.bindings.find((binding) => binding.file_id === observation.file_id)
      if (
        file?.content.sha256 !== observation.body_sha256 ||
        file.content.bytes !== observation.body_bytes ||
        file.event.event_id !== observation.event_id ||
        binding?.page_id !== observation.page_id ||
        binding.event_id !== observation.event_id
      )
        return yield* refusal(
          "The published original prefix differs from its independently reviewed complete bodies.",
        )
    }
    for (const substitution of substitutions) {
      const file = restored.files.find((file) => file.file_id === substitution.file_id)
      const binding = outcome.bindings.find((binding) => binding.file_id === substitution.file_id)
      if (
        !file ||
        binding?.path !== substitution.path ||
        binding.page_id !== substitution.page_id ||
        binding.event_id !== substitution.observation.event_id ||
        file.event.event_id !== substitution.observation.event_id ||
        file.content.sha256 !== substitution.observation.body_sha256 ||
        file.content.bytes !== substitution.observation.body_bytes
      )
        return yield* refusal(
          "The parent completion changed the independently acknowledged file, page or complete body event.",
        )
    }
    return outcome
  }).pipe(withReadOnlyNotion)
}

export function applySharedRetainedImportRecovery(input: {
  readonly entry: string
  readonly plan: unknown
  readonly review: unknown
  readonly reviewId: string
  readonly dryRun?: boolean
}) {
  return Effect.gen(function* () {
    const { plan, review, proofs } = yield* validateSharedRetainedImportRecoveryReview(
      input.review,
      input.plan,
      input.reviewId,
    )
    const library = yield* loadSharedLibrary(input.entry)
    if (!preservesSharedLibraryBindings(plan.library, library))
      return yield* refusal("The original recovery belongs to another library.")
    const scope = yield* authScope,
      store = yield* Store,
      key = yield* sharedCreateRecoveryJournalKey(scope, library.library_id, plan.operation_id)
    const expected = {
      version: 6,
      scope,
      library_id: library.library_id,
      original_operation_id: plan.operation_id,
      review,
    }
    const saved = yield* store.readJson(key, Schema.Unknown)
    if (saved !== undefined && !same(saved, expected))
      return yield* refusal("Another original recovery already owns this operation.")
    const complete = yield* reconcileSharedCreate(library, plan).pipe(Effect.result)
    if (complete._tag === "Success" && complete.success.verified) {
      const retained = yield* querySharedRecords(library, {
        skillPageId: review.skill_page_id,
        kind: "operation",
        entityId: retainedImportRecoveryReviewsEntity,
        recordId: reviewRecordId(plan.operation_id),
      })
      if (retained.length !== 1 || !same(retained[0]!.payload, review))
        return yield* refusal("The completed original belongs to a different reviewed recovery.")
      if (saved !== undefined) yield* store.retireKeys([key])
      return {
        ...complete.success,
        review_id: review.review_id,
        reused: true,
        remote_writes: 0 as const,
      }
    }
    const substitutions = yield* loadCompletedSourceFileResubmissions(
      library,
      plan,
      review.skill_page_id,
    )
    if (saved === undefined) {
      const current = yield* reviewSharedRetainedImportRecovery({
        entry: input.entry,
        plan,
        target: review.skill_page_id,
      })
      if (!same(current, review))
        return yield* refusal(
          "The original review drifted; do not apply another observation under its digest.",
        )
    } else yield* assertSharedRetainedImportRecovery(library, plan, review, substitutions)
    if (input.dryRun)
      return {
        status: "reviewed" as const,
        review_id: review.review_id,
        operation_id: plan.operation_id,
        skill_page_id: review.skill_page_id,
        verified: false,
        remote_writes: 0 as const,
        new_native_pages: plan.files.length - review.bindings.length,
      }
    if (saved === undefined) yield* store.writeJson(key, expected)
    yield* assertSharedRetainedImportRecovery(library, plan, review, substitutions)
    const dispatch = yield* sharedCreateDispatch(
      library,
      { operation_id: review.review_id, skill_id: plan.skill_id },
      assertSharedRetainedImportRecovery(library, plan, review, substitutions),
    )
    yield* Effect.gen(function* () {
      yield* retainSharedNativeAllocationProofs(library, review.skill_page_id, proofs)
      yield* appendSharedRecord(library, {
        mode: "create",
        kind: "operation",
        skillPageId: review.skill_page_id,
        recordId: reviewRecordId(plan.operation_id),
        entityId: retainedImportRecoveryReviewsEntity,
        operationId: review.review_id,
        payload: review,
      })
    }).pipe(Effect.provideService(Notion, dispatch.api))
    const result = yield* executeSharedCreate(library, {
      plan,
      mode: "create",
      retainedImportRecovery: review,
      fileResubmissions: substitutions,
    })
    if (result.verified) yield* store.retireKeys([key])
    return { ...result, review_id: review.review_id, original_failure_preserved: true }
  })
}

export function reconcileSharedRetainedImportRecovery(input: {
  readonly entry: string
  readonly plan: unknown
  readonly target: string
}) {
  return Effect.gen(function* () {
    const plan = yield* retainedPlan(input.plan),
      page = pageId(input.target),
      library = yield* loadSharedLibrary(input.entry)
    if (!page || !preservesSharedLibraryBindings(plan.library, library))
      return yield* refusal("Select the original registered library and main page.")
    const result = yield* reconcileSharedCreate(library, plan)
    if (result.skill_page_id !== page)
      return yield* refusal("The result belongs to another original allocation.")
    return { ...result, remote_writes: 0 as const, original_failure_preserved: true }
  }).pipe(withReadOnlyNotion)
}
