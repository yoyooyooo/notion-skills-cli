import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { invalidateSnapshotCache, invalidateSubscriptionCatalog } from "./cache.ts"
import { fail, property, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { pageId } from "./ref.ts"
import { sharedSkillId } from "./shared-content.ts"
import {
  createChecked,
  sharedCreateBodyPayload,
  sharedCreateEnabled,
  sharedCreateManifestEntity,
  sharedCreateOutcomesEntity,
} from "./shared-create-model.ts"
import { sharedCreateOutcomeId } from "./shared-create-outcome.ts"
import { sharedCreateDispatch } from "./shared-create-dispatch.ts"
import { saveSharedCreateOwnership } from "./shared-create-ownership.ts"
import {
  sharedCreateFileRequest,
  sharedCreateJournalKey,
  verifySharedCreateRecoveryIndex,
  verifySharedCreateRecoveryScope,
} from "./shared-create.ts"
import {
  sharedCreateRecoveryReviewId,
  sharedCreateRecoveryReviewEntity,
  sharedCreateRecoveryOutcomeId,
  sharedCreateRecoveryOutcomesEntity,
} from "./shared-create-recovery-completion.ts"
import {
  sharedCreateContinuationReviewId,
  sharedCreateContinuationReviewEntity,
} from "./shared-create-continuation-model.ts"
import {
  originalKnownCreateBootstrap,
  assertSharedCreateFrozenRecordRequest,
  type SharedCreateFrozenFact,
} from "./shared-create-recovery-known-bootstrap.ts"
import {
  knownRecoveryPlan,
  makeSharedCreateKnownRecoveryFiles,
  makeSharedCreateKnownRecoveryReview,
  validateSharedCreateKnownRecoveryReview,
  compactSharedCreateRecoveryObservation,
  prepareSharedCreateKnownAllocationProofs,
} from "./shared-create-recovery-known-model.ts"
import {
  observeSharedCreatePrefixBody,
  assertSharedCreateAcknowledgedMetadata,
} from "./shared-create-recovery-prefix-model.ts"
import { SharedCreateFrozenPostSchema } from "./shared-create-recovery-acknowledgement-model.ts"
import { reconcileSharedCreatePrefixRecovery } from "./shared-create-recovery-prefix.ts"
import { prefixRecoveryRequired } from "./shared-create-recovery-errors.ts"
import { projectSharedRecoveryFiles } from "./shared-create-recovery-projection.ts"
import {
  prepareSharedNativeAllocationProof,
  retainSharedNativeAllocationProofs,
} from "./shared-create-recovery-acknowledgements.ts"
import {
  makeSharedCreateAcknowledgedContinuationReview,
  validateSharedCreateAcknowledgedContinuationReview,
  type SharedCreateAcknowledgedContinuationReview,
  type SharedCreateAcknowledgedContinuationOutcome,
} from "./shared-create-continuation-acknowledged-model.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import { querySharedOperationIndex } from "./shared-operation-index.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  validateSharedRecordEnvelope,
} from "./shared-records.ts"
import { SourceMutationAcknowledgementSchema } from "./shared-sources-model.ts"
import { sha256, Store } from "./store.ts"

const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const hash = (value: unknown) => sha256(canonicalSharedJson(value))
const refusal = (message: string) => Effect.fail(prefixRecoveryRequired(message))
function journalKey(scope: string, library: string, operation: string, continuation = false) {
  return hash([scope, library]).pipe(
    Effect.map(
      (id) =>
        `operations/shared-native-${continuation ? "continuation" : "recovery"}/${id}/${operation}.json`,
    ),
  )
}
function originalRequest(attempt: string, body: unknown) {
  return Effect.gen(function* () {
    const request = {
      identity: attempt + ":" + (yield* hash(["v1/pages", "POST", body])),
      path: "v1/pages" as const,
      method: "POST" as const,
      body,
    }
    return { version: 1 as const, operation: "source-op-" + (yield* hash(request)), ...request }
  })
}
const baseline = (file: Effect.Success<ReturnType<typeof projectSharedRecoveryFiles>>[number]) => ({
  ...file.event.projection,
  source_revision: file.event.source_revision,
})
function rich(value: string) {
  const points = Array.from(value),
    rich_text = []
  for (let at = 0; at < points.length; at += 2000)
    rich_text.push({ type: "text", text: { content: points.slice(at, at + 2000).join("") } })
  return { rich_text }
}

/** This branch proves a complete acknowledged allocation set, not an inferred unattempted suffix. */
function acknowledgedContext(entry: string, input: unknown, target: string) {
  return Effect.gen(function* () {
    const plan = yield* knownRecoveryPlan(input),
      page = pageId(target)
    if (plan.files[0]?.projection.version !== 9 || !page)
      return yield* refusal("Select the exact original v9 admission and acknowledged main.")
    const library = yield* loadSharedLibrary(entry),
      store = yield* Store,
      scope = yield* authScope,
      api = yield* Notion
    const rows = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      recordId: sharedCreateRecoveryReviewId(plan.operation_id),
      payloadContainsBody: true,
    })
    const row = rows[0]
    if (rows.length !== 1 || !row || row.entity_id !== sharedCreateRecoveryReviewEntity)
      return yield* refusal("The exact original recovery review is required.")
    const review = yield* validateSharedCreateKnownRecoveryReview(row.payload)
    if (
      review.version !== 3 ||
      review.bootstrap.kind !== "known_needs_review" ||
      review.original_outcome_sha256 === null ||
      review.original_operation_id !== plan.operation_id ||
      review.skill_page_id !== page ||
      row.operation_id !== review.review_id
    )
      return yield* refusal(
        "Only an acknowledged known-failure v3/v10 recovery can use this continuation.",
      )
    const key = yield* journalKey(scope, library.library_id, plan.operation_id)
    if (
      (yield* store.listKeys("operations/shared-native-recovery/")).some(
        (item) => item !== key && item.endsWith("/" + plan.operation_id + ".json"),
      )
    )
      return yield* refusal("The recovery belongs to another original credential namespace.")
    const journal = yield* store.readJson(key, Schema.Unknown)
    if (!same(journal, { version: 2, scope, library_id: library.library_id, review }))
      return yield* refusal("The complete original local recovery journal is missing or changed.")
    const original = yield* originalKnownCreateBootstrap(library, plan, page, {
      review,
      hash: row.hash,
    })
    const rebuilt = yield* makeSharedCreateKnownRecoveryReview({
      plan,
      ...original,
      skillPageId: page,
      observations: review.observations,
    })
    if (!same(rebuilt, review))
      return yield* refusal(
        "The original reviewed recovery changed its complete input or ACK prefix.",
      )
    const oldFiles = yield* makeSharedCreateKnownRecoveryFiles(plan),
      projectedFiles = yield* projectSharedRecoveryFiles(plan, 11)
    const files = [
      ...projectedFiles.filter((file) => file.path === plan.entrypoint),
      ...projectedFiles.filter((file) => file.path !== plan.entrypoint),
    ]
    const originalIds = new Set(review.bindings.map((binding) => binding.file_id))
    const originalBodies = new Set(plan.files.map((file) => file.content.object_id))
    const facts = new Map<string, SharedCreateFrozenFact>()
    const addFact = (
      record_id: string,
      operation_id: string,
      entity_id: string,
      kind: SharedCreateFrozenFact["kind"],
      payload: unknown,
    ) =>
      Effect.gen(function* () {
        const fact = {
          record_id,
          operation_id,
          entity_id,
          kind,
          payload,
          hash: yield* hash({ version: 1, operation_id, payload }),
        }
        const prior = facts.get(record_id)
        if (prior && !same(prior, fact))
          return yield* refusal("Recovery facts collide under one immutable identity.")
        facts.set(record_id, fact)
      })
    yield* addFact(
      sharedCreateRecoveryReviewId(plan.operation_id),
      review.review_id,
      sharedCreateRecoveryReviewEntity,
      "operation",
      review,
    )
    for (const file of oldFiles)
      if (!originalBodies.has(file.content.object_id))
        yield* addFact(
          file.content.object_id,
          "retain-" + file.content.sha256,
          file.content.object_id,
          "object",
          sharedCreateBodyPayload(file.projection.markdown),
        )
    const expectedNative = new Map<
      string,
      {
        dispatch: Effect.Success<ReturnType<typeof originalRequest>>
        file: (typeof oldFiles)[number]
      }
    >()
    for (const file of oldFiles)
      if (!originalIds.has(file.file_id)) {
        const dispatch = yield* originalRequest(
          review.review_id,
          sharedCreateFileRequest(plan.library, page, file),
        )
        expectedNative.set(dispatch.operation, { dispatch, file })
      }
    const namespace = yield* hash([
      yield* api.credentialIdentity,
      library.library_id,
      library.sources?.data_source_id ?? null,
    ])
    const root = "operations/shared-sources/" + namespace + "/"
    const proofs = yield* prepareSharedCreateKnownAllocationProofs(
      plan,
      page,
      original.bindings,
      original.bootstrap,
    )
    const byFile = new Map(proofs.map((proof) => [proof.reference.file_id, proof]))
    const bindings = new Map(
      review.bindings.map((binding) => [
        binding.file_id,
        {
          ...binding,
          event_id: oldFiles.find((file) => file.file_id === binding.file_id)!.event.event_id,
        },
      ]),
    )
    const seenFacts = new Set<string>(),
      seenNative = new Set<string>(),
      seenPages = new Set(review.bindings.map((binding) => binding.page_id)),
      retained = []
    for (const candidate of yield* store.listKeys("operations/shared-sources/")) {
      if (!/\/source-op-[a-f0-9]{64}\.json$/u.test(candidate)) continue
      const saved = yield* store.readJson(candidate, Schema.Unknown),
        identity = property(saved).identity
      if (typeof identity !== "string" || !identity.startsWith(review.review_id + ":")) continue
      if (!candidate.startsWith(root))
        return yield* refusal("A recovery dispatch belongs to another credential namespace.")
      const dispatch = yield* createChecked(() =>
        Schema.decodeUnknownSync(SharedCreateFrozenPostSchema)(saved, {
          onExcessProperty: "error",
        }),
      )
      if (
        !same(dispatch, yield* originalRequest(review.review_id, dispatch.body)) ||
        candidate !== root + dispatch.operation + ".json"
      )
        return yield* refusal("The recovery contains a changed, extra or metadata dispatch.")
      const rawAck = yield* store.readJson(
        candidate.replace("/source-op-", "/source-ack-"),
        Schema.Unknown,
      )
      if (rawAck === undefined)
        return yield* refusal(
          "A recovery dispatch lacks its original durable ACK; current equality cannot replace it.",
        )
      const ack = yield* createChecked(() =>
        Schema.decodeUnknownSync(SourceMutationAcknowledgementSchema)(rawAck, {
          onExcessProperty: "error",
        }),
      )
      const response = property(ack.response)
      if (
        ack.operation_id !== dispatch.operation ||
        ack.request_hash !== (yield* hash(dispatch)) ||
        ack.response_hash !== (yield* hash(ack.response)) ||
        !Number.isSafeInteger(ack.acknowledged_at) ||
        ack.acknowledged_at < 0 ||
        response.object !== "page" ||
        typeof response.id !== "string" ||
        pageId(response.id) !== response.id ||
        response.archived === true ||
        response.is_archived === true ||
        response.in_trash === true ||
        seenPages.has(response.id) ||
        property(response.parent).data_source_id !==
          property(property(dispatch.body).parent).data_source_id
      )
        return yield* refusal(
          "The recovery ACK changed its request, response, unique page or parent.",
        )
      yield* createChecked(() =>
        assertSharedCreateAcknowledgedMetadata(dispatch.body, ack.response),
      )
      seenPages.add(response.id)
      const native = expectedNative.get(dispatch.operation)
      if (native) {
        if (!same(native.dispatch, dispatch) || seenNative.has(dispatch.operation))
          return yield* refusal(
            "The recovery native allocation differs from its exact reviewed POST.",
          )
        const binding = {
          file_id: native.file.file_id,
          path: native.file.path,
          page_id: response.id,
          event_id: native.file.event.event_id,
        }
        const proof = yield* prepareSharedNativeAllocationProof(plan, page, binding, ack, {
          attemptId: review.review_id,
          file: native.file,
        })
        bindings.set(binding.file_id, binding)
        byFile.set(binding.file_id, proof)
        seenNative.add(dispatch.operation)
      } else {
        const fields = property(property(dispatch.body).properties),
          recordId = text(property(fields[library.records.property_ids["Record ID"]!]).rich_text),
          fact = facts.get(recordId)
        if (!fact || seenFacts.has(recordId))
          return yield* refusal("The recovery contains another or repeated Record dispatch.")
        yield* createChecked(() =>
          assertSharedCreateFrozenRecordRequest(library, page, dispatch.body, fact),
        )
        const observed = yield* querySharedRecords(library, {
          skillPageId: page,
          kind: fact.kind,
          recordId,
          entityId: fact.entity_id,
          payloadContainsBody: true,
        })
        const actual = observed[0]
        if (
          observed.length !== 1 ||
          !actual ||
          actual.page_id !== response.id ||
          actual.hash !== fact.hash ||
          actual.operation_id !== fact.operation_id ||
          !same(actual.payload, fact.payload)
        )
          return yield* refusal(
            "A recovery Record no longer binds its exact acknowledged page and payload.",
          )
        seenFacts.add(recordId)
      }
      retained.push({ dispatch, acknowledgement: ack })
    }
    if (
      seenNative.size !== expectedNative.size ||
      seenFacts.size !== facts.size ||
      retained.length !== expectedNative.size + facts.size ||
      bindings.size !== files.length
    )
      return yield* refusal(
        "The recovery does not prove the complete original all-allocated request and ACK set.",
      )
    const orderedBindings = files.map((file) => bindings.get(file.file_id)!)
    const orderedProofs = files.map((file) => byFile.get(file.file_id)!)
    if (orderedBindings.some((item) => !item) || orderedProofs.some((item) => !item))
      return yield* refusal("A declared file lacks its exact original allocation.")
    return {
      plan,
      page,
      library,
      review,
      reviewHash: row.hash,
      scope,
      oldFiles,
      files,
      originalIds,
      bindings: orderedBindings,
      proofs: orderedProofs,
      recoveryJournalHash: yield* hash(journal),
      recoveryDispatchesHash: yield* hash(
        retained.sort((left, right) =>
          left.dispatch.operation.localeCompare(right.dispatch.operation),
        ),
      ),
    }
  }).pipe(withReadOnlyNotion)
}
type Context = Effect.Success<ReturnType<typeof acknowledgedContext>>

function observe(
  context: Context,
  projected = new Set<string>(),
  enabled = false,
  continuation?: SharedCreateAcknowledgedContinuationReview,
  allowEvents = false,
) {
  return Effect.gen(function* () {
    const { plan, page, library, files, review } = context
    yield* verifySharedCreateRecoveryScope(library, plan, page)
    const initial = files.map((file) =>
      projected.has(file.file_id)
        ? file
        : context.originalIds.has(file.file_id)
          ? plan.files.find((old) => old.file_id === file.file_id)!
          : context.oldFiles.find((old) => old.file_id === file.file_id)!,
    )
    yield* verifySharedCreateRecoveryIndex(
      library,
      { ...plan, files: initial },
      page,
      context.bindings,
      enabled,
      true,
    )
    const permitted = new Map([
      [
        plan.operation_id,
        { entity: sharedCreateManifestEntity, hash: review.original_manifest_sha256 },
      ],
      [
        sharedCreateOutcomeId(plan.operation_id),
        { entity: sharedCreateOutcomesEntity, hash: review.original_outcome_sha256 },
      ],
      [
        sharedCreateRecoveryReviewId(plan.operation_id),
        { entity: sharedCreateRecoveryReviewEntity, hash: context.reviewHash },
      ],
    ])
    if (continuation)
      permitted.set(sharedCreateContinuationReviewId(plan.operation_id), {
        entity: sharedCreateContinuationReviewEntity,
        hash: yield* hash({
          version: 1,
          operation_id: continuation.continuation_id,
          payload: continuation,
        }),
      })
    const headers = yield* querySharedOperationIndex(library, page)
    if (
      headers.length !== permitted.size ||
      headers.some(
        (header) =>
          !permitted.has(header.record_id) ||
          permitted.get(header.record_id)!.entity !== header.entity_id ||
          permitted.get(header.record_id)!.hash !== header.hash,
      )
    )
      return yield* refusal("The continuation found a missing, changed or foreign operation.")
    const events = yield* querySharedRecords(library, { skillPageId: page, kind: "file_event" })
    if (
      (!allowEvents && events.length !== 0) ||
      events.some((row) => {
        const file = files.find((item) => item.event.event_id === row.record_id)
        return (
          !file ||
          row.operation_id !== file.event.event_id ||
          row.entity_id !== file.file_id ||
          !same(row.payload, file.event)
        )
      })
    )
      return yield* refusal(
        "The continuation cannot replace existing or foreign initial ownership.",
      )
    const observations = []
    for (const binding of context.bindings) {
      const raw = yield* (yield* Notion).request(
        `v1/pages/${binding.page_id}/markdown?markdown_version=v2`,
      )
      const observed = yield* observeSharedCreatePrefixBody(binding.file_id, binding.page_id, raw),
        file = files.find((item) => item.file_id === binding.file_id)!
      if (
        observed.body_sha256 !== file.content.sha256 ||
        observed.body_bytes !== file.content.bytes
      )
        return yield* refusal(
          "An acknowledged native body differs from the exact reviewed v11 prediction; preserve it.",
        )
      observations.push(compactSharedCreateRecoveryObservation(observed))
    }
    return observations
  }).pipe(withReadOnlyNotion)
}

export function reviewSharedCreateAcknowledgedContinuation(input: {
  readonly entry: string
  readonly operationId: string
  readonly target: string
  readonly plan: unknown
}) {
  return Effect.gen(function* () {
    const context = yield* acknowledgedContext(input.entry, input.plan, input.target)
    if (context.plan.operation_id !== input.operationId)
      return yield* refusal("Select the exact original continuation operation.")
    const observations = yield* observe(context)
    return yield* makeSharedCreateAcknowledgedContinuationReview({
      ...context,
      originalReview: context.review,
      originalReviewHash: context.reviewHash,
      allocations: context.proofs.map((proof) => proof.reference),
      observations,
    })
  }).pipe(withReadOnlyNotion)
}

export function applySharedCreateAcknowledgedContinuation(input: {
  readonly entry?: string
  readonly plan: unknown
  readonly review: unknown
  readonly reviewId: string
  readonly dryRun?: boolean
}) {
  return Effect.gen(function* () {
    const accepted = yield* validateSharedCreateAcknowledgedContinuationReview(
        input.review,
        input.reviewId,
      ),
      plan = yield* knownRecoveryPlan(input.plan)
    const entry = input.entry ?? accepted.library.skills.database_id,
      library = yield* loadSharedLibrary(entry),
      scope = yield* authScope,
      store = yield* Store
    const key = yield* journalKey(scope, library.library_id, plan.operation_id, true)
    const shared = yield* querySharedRecords(library, {
      skillPageId: accepted.skill_page_id,
      kind: "operation",
      recordId: sharedCreateContinuationReviewId(plan.operation_id),
      payloadContainsBody: true,
    })
    if ((yield* store.readJson(key, Schema.Unknown)) !== undefined || shared.length !== 0)
      return yield* reconcileSharedCreatePrefixRecovery({
        entry,
        operationId: plan.operation_id,
        target: accepted.skill_page_id,
        plan,
      })
    const context = yield* acknowledgedContext(entry, plan, accepted.skill_page_id)
    const rebuilt = yield* makeSharedCreateAcknowledgedContinuationReview({
      ...context,
      originalReview: context.review,
      originalReviewHash: context.reviewHash,
      allocations: context.proofs.map((proof) => proof.reference),
      observations: accepted.observations,
    })
    if (!same(rebuilt, accepted))
      return yield* refusal(
        "The accepted continuation no longer binds the complete original proof set.",
      )
    yield* observe(context)
    const metadata = context.files.filter((file) => {
      const previous = context.originalIds.has(file.file_id)
        ? plan.files.find((old) => old.file_id === file.file_id)!
        : context.oldFiles.find((old) => old.file_id === file.file_id)!
      return (
        previous.event.kind !== "projected" ||
        !same(
          { ...previous.event.projection, source_revision: previous.event.source_revision },
          baseline(file),
        )
      )
    })
    const previousBodies = new Set(
      [...plan.files, ...context.oldFiles].map((file) => file.content.object_id),
    )
    const newBodies = context.files.filter((file) => !previousBodies.has(file.content.object_id))
    yield* createChecked(() => {
      for (const file of newBodies)
        validateSharedRecordEnvelope(
          "retain-" + file.content.sha256,
          sharedCreateBodyPayload(file.projection.markdown),
          "object",
        )
      for (const file of context.files)
        validateSharedRecordEnvelope(file.event.event_id, file.event, "file_event")
    })
    const recordIds = new Set([
      sharedCreateContinuationReviewId(plan.operation_id),
      sharedCreateRecoveryOutcomeId(plan.operation_id),
      ...context.proofs.map((proof) => proof.reference.record_id),
      ...newBodies.map((file) => file.content.object_id),
      ...context.files.map((file) => file.event.event_id),
    ])
    if (input.dryRun)
      return {
        status: "planned" as const,
        dry_run: true as const,
        verified: false as const,
        original_operation_id: plan.operation_id,
        recovery_operation_id: context.review.review_id,
        continuation_operation_id: accepted.continuation_id,
        original_write_outcome: "acknowledged" as const,
        existing_pages: context.bindings.length,
        remaining_pages: 0,
        write_plan: {
          record_ids: [...recordIds].sort(),
          maximum_record_creates: recordIds.size,
          native_page_creates: 0,
          existing_body_patches: 0,
          metadata_patches: metadata.length + (sharedCreateEnabled(plan) ? 1 : 0),
          notion_write_upper_bound:
            recordIds.size + metadata.length + (sharedCreateEnabled(plan) ? 1 : 0),
        },
        review: accepted,
      }
    yield* store.writeJson(key, {
      version: 2,
      scope,
      library_id: library.library_id,
      review: context.review,
      continuation: accepted,
    })
    const projected = new Set<string>(),
      bindings = accepted.bindings
    let enabled = false,
      stage = "continuation_review",
      checkedStage: string | undefined,
      retainedReview = false,
      allowEvents = false
    const guard = Effect.gen(function* () {
      if (checkedStage === stage) return
      yield* observe(
        context,
        projected,
        enabled,
        retainedReview ? accepted : undefined,
        allowEvents,
      )
      checkedStage = stage
    })
    const dispatch = yield* sharedCreateDispatch(
      library,
      {
        operation_id: accepted.continuation_id,
        skill_id: plan.skill_id,
        recovery_file_projections: metadata
          .filter((file) => file.path !== plan.entrypoint)
          .map((file) => ({
            page_id: bindings.find((binding) => binding.file_id === file.file_id)!.page_id,
            file_id: file.file_id,
            path: file.path,
            skill_page_id: context.page,
            projection: canonicalSharedJson(baseline(file)),
          })),
      },
      guard,
    )
    return yield* Effect.gen(function* () {
      const record = yield* appendSharedRecord(library, {
        mode: "create",
        recordId: sharedCreateContinuationReviewId(plan.operation_id),
        operationId: accepted.continuation_id,
        skillPageId: context.page,
        kind: "operation",
        entityId: sharedCreateContinuationReviewEntity,
        payload: accepted,
        payloadContainsBody: true,
      })
      retainedReview = true
      stage = "allocation_proofs"
      yield* retainSharedNativeAllocationProofs(library, context.page, context.proofs)
      stage = "corrected_bodies"
      for (const file of newBodies)
        yield* appendSharedRecord(library, {
          mode: "create",
          recordId: file.content.object_id,
          operationId: "retain-" + file.content.sha256,
          skillPageId: context.page,
          kind: "object",
          entityId: file.content.object_id,
          payload: sharedCreateBodyPayload(file.projection.markdown),
        })
      const api = yield* Notion
      for (const file of metadata) {
        stage = "projection:" + file.file_id
        const binding = bindings.find((item) => item.file_id === file.file_id)!,
          id =
            file.path === plan.entrypoint
              ? library.skills.property_ids.Projection!
              : library.files.property_ids.Projection!
        const response = property(
          yield* api.request(
            "v1/pages/" + binding.page_id,
            { properties: { [id]: rich(canonicalSharedJson(baseline(file))) } },
            { method: "PATCH" },
          ),
        )
        if (response.id !== binding.page_id)
          return yield* refusal("The original metadata ACK belongs to another allocation.")
        projected.add(file.file_id)
      }
      stage = "file_events"
      allowEvents = true
      for (const file of context.files)
        yield* appendSharedRecord(library, {
          mode: "create",
          recordId: file.event.event_id,
          operationId: file.event.event_id,
          skillPageId: context.page,
          kind: "file_event",
          entityId: file.file_id,
          payload: file.event,
        })
      yield* observe(context, projected, false, accepted, true)
      const published = yield* querySharedRecords(library, {
        skillPageId: context.page,
        kind: "file_event",
      })
      if (
        !same(
          published.map((row) => row.record_id).sort(),
          context.files.map((file) => file.event.event_id).sort(),
        )
      )
        return yield* refusal("The continuation lacks its complete exact initial event set.")
      if (sharedCreateEnabled(plan)) {
        stage = "enable"
        const response = property(
          yield* api.request(
            "v1/pages/" + context.page,
            { properties: { [library.skills.property_ids.Enabled!]: { checkbox: true } } },
            { method: "PATCH" },
          ),
        )
        if (response.id !== context.page)
          return yield* refusal("The enable ACK belongs to another original Skill.")
        enabled = true
      }
      yield* observe(context, projected, enabled, accepted, true)
      const outcome: SharedCreateAcknowledgedContinuationOutcome = {
        version: 6,
        kind: "skill_create_recovery_outcome",
        status: "applied",
        original_operation_id: plan.operation_id,
        original_manifest_sha256: context.review.original_manifest_sha256,
        original_plan_sha256: context.review.original_plan_sha256,
        original_outcome_sha256: accepted.original_outcome_sha256,
        bootstrap_sha256: yield* hash(context.review.bootstrap),
        recovery_id: context.review.review_id,
        skill_id: plan.skill_id,
        skill_page_id: context.page,
        review_record_hash: context.reviewHash,
        continuation_id: accepted.continuation_id,
        continuation_review_record_hash: record.hash,
        bindings,
      }
      stage = "completion"
      yield* appendSharedRecord(library, {
        mode: "create",
        recordId: sharedCreateRecoveryOutcomeId(plan.operation_id),
        operationId: accepted.continuation_id,
        skillPageId: context.page,
        kind: "operation",
        entityId: sharedCreateRecoveryOutcomesEntity,
        payload: outcome,
      })
      yield* saveSharedCreateOwnership(scope, plan, bindings)
      yield* invalidateSubscriptionCatalog(scope, library.skills.database_id)
      yield* invalidateSnapshotCache(sharedSkillId(library.library_id, plan.skill_id), scope)
      yield* store.retireKeys([
        key,
        yield* journalKey(scope, library.library_id, plan.operation_id),
        yield* sharedCreateJournalKey(scope, library.library_id, plan.operation_id),
      ])
      return {
        status: "recovered" as const,
        original_operation_id: plan.operation_id,
        recovery_operation_id: context.review.review_id,
        continuation_operation_id: accepted.continuation_id,
        skill_page_id: context.page,
        original_status: "needs_review" as const,
        original_write_outcome: "acknowledged" as const,
        verified: true as const,
        current_snapshot_verified: false as const,
        requires_fresh_read: true as const,
        reused: false as const,
        existing_pages_preserved: bindings.length,
        created_pages: 0,
      }
    }).pipe(
      Effect.provideService(Notion, dispatch.api),
      Effect.mapError((error) =>
        fail(error.code, error.message, {
          ...property(error.details),
          original_operation_id: plan.operation_id,
          recovery_operation_id: context.review.review_id,
          continuation_operation_id: accepted.continuation_id,
          skill_page_id: context.page,
          stage,
          next: {
            command: "ctl library sources recovery reconcile",
            original_plan_required: true,
            target: context.page,
          },
        }),
      ),
    )
  })
}
