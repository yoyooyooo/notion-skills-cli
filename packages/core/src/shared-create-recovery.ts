import {
  reviewSharedCreatePrefixRecovery,
  applySharedCreatePrefixRecovery,
  reconcileSharedCreatePrefixRecovery,
} from "./shared-create-recovery-prefix.ts"
import {
  reviewSharedCreateAcknowledgedContinuation,
  applySharedCreateAcknowledgedContinuation,
} from "./shared-create-continuation-acknowledged.ts"
import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { invalidateSnapshotCache, invalidateSubscriptionCatalog } from "./cache.ts"
import { fail, property, type Source } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { sharedRecordFromPage, sharedSkillId } from "./shared-content.ts"
import { consumeSharedCreation } from "./shared-create-consumption.ts"
import {
  createChecked,
  sharedCreateBodyPayload,
  sharedCreateManifestEntity,
  sharedCreateOutcomesEntity,
  sharedCreateProtection,
} from "./shared-create-model.ts"
import {
  decodeSharedCreateOutcome,
  sharedCreateManifestRecordHash,
  sharedCreateOutcomeId,
  type SharedCreateBinding,
} from "./shared-create-outcome.ts"
import {
  SharedCreateRecoveryOutcomeSchema,
  sharedCreateRecoveryReviewEntity,
  sharedCreateRecoveryOutcomesEntity,
  sharedCreateRecoveryReviewId,
  sharedCreateRecoveryOutcomeId,
  type SharedCreateRecoveryOutcome,
  validateSharedCreateContinuationCompletion,
  assertSharedCreateRecoveryNotContinued,
} from "./shared-create-recovery-completion.ts"
import {
  makeSharedCreateRecoveryFiles,
  makeSharedCreateRecoveryReview,
  validateSharedCreateRecoveryReview,
  type SharedCreateRecoveryReview,
} from "./shared-create-recovery-model.ts"
import {
  SharedCreateContinuationReviewSchema,
  makeSharedCreateContinuationReview,
  makeSharedCreateRecoveryTerminal,
  sharedCreateContinuationReviewEntity,
  sharedCreateContinuationReviewId,
  sharedCreateRecoveryTerminalsEntity,
  sharedCreateRecoveryTerminalId,
  validateSharedCreateContinuationReview,
  validateSharedCreateRecoveryTerminal,
  type SharedCreateContinuationReview,
  type SharedCreateRecoveryTerminal,
} from "./shared-create-continuation-model.ts"
import {
  loadSharedCreatePlan,
  prepareSharedMigrationReview,
  sharedCreateJournalKey,
  sharedCreateMemberIds,
} from "./shared-create.ts"
import { FileEventSchema, normalizeObservedBody, type FileEvent } from "./shared-file-state.ts"
import { loadSharedLibrary, type SharedLibrary } from "./shared-library.ts"
import { validateSharedMigrationConversion } from "./shared-migration-conversion.ts"
import { sharedNotionMarkdownWire } from "./shared-notion-projection.ts"
import { querySharedOperationIndex } from "./shared-operation-index.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  validateSharedRecordEnvelope,
} from "./shared-records.ts"
import { querySharedSkillIndex } from "./shared-skill-index.ts"
import { resolveSourceBinding } from "./shared-source-binding.ts"
import { sha256, Store } from "./store.ts"

const recoveryReceiptsEntity = "skill-create-recovery-receipts-v1"
const MarkdownSchema = Schema.Struct({
  id: Schema.String,
  markdown: Schema.String,
  truncated: Schema.Boolean,
  unknown_block_ids: Schema.Array(Schema.String),
  warnings: Schema.optional(Schema.Array(Schema.Unknown)),
})
type RecoveryFile = Effect.Success<ReturnType<typeof makeSharedCreateRecoveryFiles>>[number]
type OwnershipFile = { readonly file_id: string; readonly event: FileEvent }
type Original = Effect.Success<ReturnType<typeof originalFacts>>
const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const refused = (message: string) => fail("SHARED_CREATE_RECOVERY_REQUIRED", message)

function originalFacts(entry: string, operationId: string, target: string) {
  return Effect.gen(function* () {
    const targetPage = pageId(target)
    if (!targetPage || !/^skill-create-[a-f0-9]{64}$/u.test(operationId))
      return yield* Effect.fail(
        fail(
          "INVALID_ARGUMENT",
          "Select the exact original create operation and existing Skill page.",
        ),
      )
    const library = yield* loadSharedLibrary(entry)
    const plan = yield* loadSharedCreatePlan(library, {
      skillPageId: targetPage,
      operationId,
    })
    if (plan.version !== 2)
      return yield* Effect.fail(refused("This recovery requires a retained migration origin."))
    const rows = yield* querySharedRecords(library, {
      skillPageId: targetPage,
      kind: "operation",
      entityId: sharedCreateOutcomesEntity,
      recordId: sharedCreateOutcomeId(operationId),
    })
    const row = rows[0]
    if (rows.length !== 1 || row === undefined)
      return yield* Effect.fail(
        refused("An exact known original failure is required; unknown creation is never replayed."),
      )
    const outcome = yield* createChecked(() => decodeSharedCreateOutcome(row))
    const manifestHash = yield* sharedCreateManifestRecordHash(plan)
    if (
      outcome.version !== 2 ||
      outcome.status !== "needs_review" ||
      outcome.reason_code !== "SHARED_CREATE_BODY_MISMATCH" ||
      outcome.operation_id !== plan.operation_id ||
      outcome.skill_id !== plan.skill_id ||
      outcome.skill_page_id !== targetPage ||
      outcome.manifest_record_hash !== manifestHash ||
      outcome.migration_candidate_id !== plan.origin.candidate.candidate_id
    )
      return yield* Effect.fail(
        refused("Only the exact retained body-mismatch outcome can enter this recovery."),
      )
    const ordered = [
      ...plan.files.filter((file) => file.path === plan.entrypoint),
      ...plan.files.filter((file) => file.path !== plan.entrypoint),
    ]
    if (
      outcome.bindings.length === 0 ||
      outcome.bindings.length > ordered.length ||
      outcome.bindings[0]?.page_id !== targetPage ||
      new Set(outcome.bindings.map((binding) => binding.page_id)).size !==
        outcome.bindings.length ||
      outcome.bindings.some((binding, index) => {
        const file = ordered[index]
        return (
          file === undefined ||
          binding.file_id !== file.file_id ||
          binding.path !== file.path ||
          binding.event_id !== file.event.event_id
        )
      })
    )
      return yield* Effect.fail(
        refused("The original outcome does not retain an exact created-page prefix."),
      )
    return { library, plan, page: targetPage, outcome, outcomeHash: row.hash, manifestHash }
  })
}

function baseline(file: Pick<OwnershipFile, "event">) {
  return file.event.kind === "projected"
    ? { ...file.event.projection, source_revision: file.event.source_revision }
    : null
}

function verifyIndex(
  original: Original,
  files: readonly OwnershipFile[],
  bindings: readonly SharedCreateBinding[],
  enabled: boolean,
) {
  return Effect.gen(function* () {
    const { library, plan, page } = original
    const index = yield* querySharedSkillIndex(library, page)
    if (
      index.skill_id !== plan.skill_id ||
      index.name !== plan.name ||
      index.description !== plan.description ||
      index.kind !== plan.content_kind ||
      index.enabled !== enabled ||
      index.default_context !== plan.default_context ||
      index.source_reference !== (plan.origin.candidate.source?.source_id ?? "")
    )
      return yield* Effect.fail(
        refused("The exact Skill metadata or enabled state changed after the original creation."),
      )
    const actual = [index.main, ...index.files]
    const mapped = actual
      .map(({ file_id, path, page_id }) => ({ file_id, path, page_id }))
      .sort((a, b) => a.file_id.localeCompare(b.file_id))
    const expected = bindings
      .map(({ event_id: _event, ...binding }) => binding)
      .sort((a, b) => a.file_id.localeCompare(b.file_id))
    if (!same(mapped, expected))
      return yield* Effect.fail(
        refused(
          "A created page, File identity, path or complete inventory changed; no pages are inferred from absence.",
        ),
      )
    for (const binding of actual) {
      const file = files.find((item) => item.file_id === binding.file_id)
      const supporting = index.files.find((item) => item.file_id === binding.file_id)
      if (
        file === undefined ||
        !same(binding.baseline ?? null, baseline(file)) ||
        (supporting !== undefined &&
          supporting.display_status !== (file.event.kind === "projected" ? "following" : "custom"))
      )
        return yield* Effect.fail(
          refused("An existing file's projection baseline or ownership display changed."),
        )
    }
    if (
      plan.content_kind === "router" &&
      !same(yield* sharedCreateMemberIds(library, page), plan.members)
    )
      return yield* Effect.fail(
        refused("The existing Router Members differ from the original reviewed relation."),
      )
    return index
  })
}

function verifySource(original: Original) {
  return Effect.gen(function* () {
    const source = original.plan.origin.candidate.source
    if (source !== null) {
      const current = yield* resolveSourceBinding(original.library, {
        skillPageId: original.page,
        sourceId: source.source_id,
      })
      if (!same(source, current))
        return yield* Effect.fail(
          refused(
            "The selected fixed Source changed; recovery cannot replace its original origin.",
          ),
        )
    }
  })
}

function verifyEvents(original: Original, files: readonly OwnershipFile[]) {
  return Effect.gen(function* () {
    const rows = yield* querySharedRecords(original.library, {
      skillPageId: original.page,
      kind: "file_event",
    })
    const events = yield* createChecked(() =>
      rows.map((row) => {
        const event = Schema.decodeUnknownSync(FileEventSchema)(row.payload, {
          onExcessProperty: "error",
        })
        if (
          row.record_id !== event.event_id ||
          row.operation_id !== event.event_id ||
          row.entity_id !== event.file_id
        )
          throw refused("A file event has a foreign record identity.")
        return event
      }),
    )
    if (
      !same(
        events.toSorted((a, b) => a.file_id.localeCompare(b.file_id)),
        files.map((file) => file.event).toSorted((a, b) => a.file_id.localeCompare(b.file_id)),
      )
    )
      return yield* Effect.fail(
        refused("The complete ownership history differs from this recovery's exact event set."),
      )
  })
}

function verifyOperations(original: Original, recoveryId?: string, continuationId?: string) {
  return Effect.gen(function* () {
    const headers = yield* querySharedOperationIndex(original.library, original.page)
    for (const header of headers) {
      if (
        header.record_id === original.plan.operation_id &&
        header.entity_id === sharedCreateManifestEntity &&
        header.hash === original.manifestHash
      )
        continue
      if (
        header.record_id === sharedCreateOutcomeId(original.plan.operation_id) &&
        header.entity_id === sharedCreateOutcomesEntity &&
        header.hash === original.outcomeHash
      )
        continue
      if (
        recoveryId !== undefined &&
        ((header.record_id === sharedCreateRecoveryReviewId(original.plan.operation_id) &&
          header.entity_id === sharedCreateRecoveryReviewEntity) ||
          (header.record_id.startsWith("create-recovery-receipt-") &&
            header.entity_id === recoveryReceiptsEntity) ||
          (header.record_id === sharedCreateRecoveryTerminalId(recoveryId) &&
            header.entity_id === sharedCreateRecoveryTerminalsEntity))
      )
        continue
      if (
        continuationId !== undefined &&
        header.record_id === sharedCreateContinuationReviewId(original.plan.operation_id) &&
        header.entity_id === sharedCreateContinuationReviewEntity
      )
        continue
      return yield* Effect.fail(
        refused(
          "Another operation is visible on the partial Skill; retain it before attempting a new recovery.",
        ),
      )
    }
  })
}

function observeBody(fileId: string, page: string, raw: unknown) {
  return Effect.gen(function* () {
    const body = yield* createChecked(() => Schema.decodeUnknownSync(MarkdownSchema)(raw))
    if (
      body.id !== page ||
      body.truncated ||
      body.unknown_block_ids.length !== 0 ||
      (body.warnings?.length ?? 0) !== 0
    )
      return yield* Effect.fail(
        fail(
          "BODY_INCOMPLETE",
          "The recovery observation must contain the complete exact current page body.",
        ),
      )
    const normalized = yield* createChecked(() => normalizeObservedBody(body.markdown))
    const response = canonicalSharedJson(raw)
    return {
      file_id: fileId,
      page_id: page,
      response_json: response,
      response_sha256: yield* sha256(response),
      body_sha256: yield* sha256(normalized),
      body_bytes: new TextEncoder().encode(normalized).length,
    }
  })
}

function observeExisting(original: Original, files: readonly RecoveryFile[], recoveryId?: string) {
  return Effect.gen(function* () {
    const prepared = yield* prepareSharedMigrationReview(
      original.library,
      original.plan.origin.candidate,
    )
    if (!same(prepared, original.plan))
      return yield* Effect.fail(refused("The original scope or Router member bindings changed."))
    yield* verifyIndex(original, original.plan.files, original.outcome.bindings, false)
    yield* verifySource(original)
    yield* verifyEvents(original, [])
    yield* verifyOperations(original, recoveryId)
    const observations = []
    for (const binding of original.outcome.bindings) {
      const raw = yield* (yield* Notion).request(
        `v1/pages/${binding.page_id}/markdown?markdown_version=v2`,
      )
      const observation = yield* observeBody(binding.file_id, binding.page_id, raw)
      const file = files.find((item) => item.file_id === binding.file_id)
      if (
        !file ||
        observation.body_sha256 !== file.content.sha256 ||
        observation.body_bytes !== file.content.bytes
      )
        return yield* Effect.fail(
          refused(
            "The current body does not exactly match the new frozen projection; retain the user's current content.",
          ),
        )
      observations.push(observation)
    }
    return observations
  })
}

/** A new current observation authorizes only a separately reviewed continuation. */
type RecoverySelection = {
  readonly entry: string
  readonly operationId: string
  readonly target: string
}
export function reviewSharedCreateRecovery(
  input: RecoverySelection & { readonly plan: unknown },
): ReturnType<typeof reviewSharedCreatePrefixRecovery>
export function reviewSharedCreateRecovery(
  input: RecoverySelection & { readonly plan?: undefined },
): ReturnType<typeof reviewMigrationCreateRecovery>
export function reviewSharedCreateRecovery(input: RecoverySelection & { readonly plan?: unknown }) {
  return Effect.gen(function* () {
    if (input.plan !== undefined)
      return yield* reviewSharedCreatePrefixRecovery({ ...input, plan: input.plan })
    return yield* reviewMigrationCreateRecovery(input)
  })
}
function reviewMigrationCreateRecovery(input: RecoverySelection) {
  return Effect.gen(function* () {
    const original = yield* originalFacts(input.entry, input.operationId, input.target)
    const files = yield* makeSharedCreateRecoveryFiles(original.plan)
    const observations = yield* observeExisting(original, files)
    return yield* makeSharedCreateRecoveryReview(original.plan, {
      originalManifestHash: original.manifestHash,
      originalOutcomeHash: original.outcomeHash,
      skillPageId: original.page,
      bindings: original.outcome.bindings,
      observations,
    })
  })
}

function journalKey(scope: string, libraryId: string, operation: string, continuation = false) {
  return sha256(canonicalSharedJson([scope, libraryId])).pipe(
    Effect.map(
      (hash) =>
        `operations/shared-native-${continuation ? "continuation" : "recovery"}/${hash}/${operation}.json`,
    ),
  )
}

function retireRecovery(original: Original, continuation = false) {
  return Effect.gen(function* () {
    const scope = yield* authScope
    yield* invalidateSubscriptionCatalog(scope, original.library.skills.database_id)
    yield* invalidateSnapshotCache(
      sharedSkillId(original.library.library_id, original.plan.skill_id),
      scope,
    )
    yield* (yield* Store).retireKeys([
      yield* sharedCreateJournalKey(scope, original.library.library_id, original.plan.operation_id),
      yield* journalKey(scope, original.library.library_id, original.plan.operation_id),
      ...(continuation
        ? [yield* journalKey(scope, original.library.library_id, original.plan.operation_id, true)]
        : []),
    ])
  })
}

function recoveryError(
  error: { readonly code: string; readonly message: string; readonly details?: unknown },
  review: SharedCreateRecoveryReview,
  stage: string,
  continuationId?: string,
) {
  return fail(error.code, error.message, {
    ...property(error.details),
    original_operation_id: review.original_operation_id,
    recovery_operation_id: review.review_id,
    ...(continuationId === undefined ? {} : { continuation_operation_id: continuationId }),
    original_status: "needs_review",
    skill_page_id: review.skill_page_id,
    stage,
    next: {
      argv: [
        "ntn-skills",
        "ctl",
        "library",
        "migration",
        "recovery",
        "reconcile",
        "--entry",
        review.library.skills.database_id,
        "--operation",
        review.original_operation_id,
        "--target",
        review.skill_page_id,
      ],
    },
  })
}

function retainedResponse(
  review: SharedCreateRecoveryReview,
  key: string,
  action: string,
  request: unknown,
  response: unknown,
) {
  return Effect.gen(function* () {
    const digest = yield* sha256(canonicalSharedJson([review.review_id, key]))
    const payload = {
      version: 1,
      kind: "skill_create_recovery_response",
      recovery_id: review.review_id,
      original_operation_id: review.original_operation_id,
      action,
      request,
      response,
    }
    yield* (yield* Store).writeJson(
      `operations/shared-native-recovery-responses/${review.review_id}/${digest}.json`,
      payload,
    )
    yield* appendSharedRecord(review.library, {
      mode: "create",
      recordId: `create-recovery-receipt-${digest}`,
      operationId: review.review_id,
      skillPageId: review.skill_page_id,
      kind: "operation",
      entityId: recoveryReceiptsEntity,
      payload,
      payloadContainsBody: true,
    })
  })
}

function pageReceipt(raw: unknown) {
  const row = property(raw)
  if (
    row.object !== "page" ||
    typeof row.id !== "string" ||
    pageId(row.id) !== row.id ||
    row.in_trash === true ||
    row.archived === true
  )
    throw fail(
      "SHARED_CREATE_RECEIPT_INVALID",
      "The recovery write has no exact page receipt; preserve it without replay.",
    )
  return row.id
}
function spans(text: string) {
  const points = Array.from(text),
    output = []
  for (let offset = 0; offset < points.length; offset += 2000)
    output.push({ type: "text", text: { content: points.slice(offset, offset + 2000).join("") } })
  return output
}
const rich = (text: string) => ({ rich_text: spans(text) })

function fileCreateRequest(original: Original, file: RecoveryFile) {
  const ids = original.library.files.property_ids
  return {
    parent: { type: "data_source_id", data_source_id: original.library.files.data_source_id },
    properties: {
      [ids.Name!]: { title: spans(file.path.split("/").at(-1) ?? file.path) },
      [ids["File ID"]!]: rich(file.file_id),
      [ids.Path!]: rich(file.path),
      [ids.Projection!]: rich(baseline(file) === null ? "" : canonicalSharedJson(baseline(file))),
      [ids.Status!]: { select: { name: file.event.kind === "projected" ? "following" : "custom" } },
      [ids.Skill!]: { relation: [{ id: original.page }] },
    },
    markdown: sharedNotionMarkdownWire(file.projection),
    markdown_version: "v2",
  }
}

function expectations(
  original: Original,
  files: readonly RecoveryFile[],
  bindings: readonly SharedCreateBinding[],
) {
  const plan = original.plan
  return {
    expected_files: files.map((file) => ({
      file_id: file.file_id,
      path: file.path,
      page_id: bindings.find((binding) => binding.file_id === file.file_id)!.page_id,
      sha256: file.content.sha256,
    })),
    expected_migration: {
      candidate_id: plan.origin.candidate.candidate_id,
      source_id: plan.origin.candidate.source?.source_id ?? "",
      source_revision: plan.origin.candidate.source?.commit ?? "",
      consumed_paths: [
        ...new Set([
          ...plan.origin.candidate.source_files.map((file) => file.path),
          ...files.map((file) => file.path),
        ]),
      ].sort(),
      events: files.map((file) => ({ file_id: file.file_id, event_id: file.event.event_id })),
    },
    expected_metadata: {
      name: plan.name,
      description: plan.description,
      kind: plan.content_kind,
      enabled: true as const,
      default_context: plan.default_context,
      ...(plan.content_kind === "router" || plan.members.length > 0
        ? { members: plan.members }
        : {}),
      ...(plan.requires === undefined ? {} : { requires: plan.requires }),
    },
  }
}

function createdResult(
  original: Original,
  review: SharedCreateRecoveryReview,
  files: readonly RecoveryFile[],
  bindings: readonly SharedCreateBinding[],
  reused: boolean,
) {
  return Effect.gen(function* () {
    const library = original.library
    const raw = yield* (yield* Notion).request(`v1/pages/${original.page}`)
    const source: Source = {
      alias: library.library_id,
      title: "",
      role: "content",
      database_id: library.skills.database_id,
      data_source_ids: [library.skills.data_source_id],
      shared_library: library,
    }
    const record = yield* createChecked(() =>
      sharedRecordFromPage(raw, source, library.skills.data_source_id),
    )
    if (
      record.locator.skill_id !== original.plan.skill_id ||
      record.locator.page_id !== original.page
    )
      return yield* Effect.fail(
        refused("The completed recovery no longer has its exact Skill identity."),
      )
    return {
      status: "created" as const,
      operation: "create" as const,
      action: "created" as const,
      skill_page_id: original.page,
      page_id: original.page,
      skill_id: original.plan.skill_id,
      entrypoint: original.plan.entrypoint,
      record,
      ref: record.ref,
      operation_id: review.review_id,
      verified: true as const,
      reused,
      requires_fresh_read: true as const,
      protection: sharedCreateProtection,
      ...expectations(original, files, bindings),
    }
  })
}

function retainedRecoveryReview(original: Original) {
  return Effect.gen(function* () {
    const rows = yield* querySharedRecords(original.library, {
      skillPageId: original.page,
      kind: "operation",
      recordId: sharedCreateRecoveryReviewId(original.plan.operation_id),
      entityId: sharedCreateRecoveryReviewEntity,
      payloadContainsBody: true,
    })
    const row = rows[0]
    if (rows.length !== 1 || row === undefined)
      return yield* Effect.fail(refused("The exact original recovery review is not visible."))
    const review = yield* validateSharedCreateRecoveryReview(row.payload, row.operation_id)
    const rebuilt = yield* makeSharedCreateRecoveryReview(original.plan, {
      originalManifestHash: original.manifestHash,
      originalOutcomeHash: original.outcomeHash,
      skillPageId: original.page,
      bindings: original.outcome.bindings,
      observations: review.observations,
    })
    if (!same(review, rebuilt))
      return yield* Effect.fail(refused("The recovery review differs from its retained origin."))
    return { review, hash: row.hash }
  })
}

function retainedRecoveryTerminal(
  original: Original,
  review: SharedCreateRecoveryReview,
  hash: string,
) {
  return Effect.gen(function* () {
    const rows = yield* querySharedRecords(original.library, {
      skillPageId: original.page,
      kind: "operation",
      recordId: sharedCreateRecoveryTerminalId(review.review_id),
      entityId: sharedCreateRecoveryTerminalsEntity,
    })
    const row = rows[0]
    if (rows.length !== 1 || row === undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_CONTINUATION_EVIDENCE_REQUIRED",
          "The original recovery has no retained terminal execution record. Current pages and retrospective summaries cannot prove which later creates were never dispatched.",
          {
            original_operation_id: original.plan.operation_id,
            recovery_operation_id: review.review_id,
            skill_page_id: original.page,
            original_write_outcome: "unknown",
            required_evidence: "original_serial_dispatch_terminal",
            apply_allowed: false,
          },
        ),
      )
    if (row.operation_id !== review.review_id)
      return yield* Effect.fail(refused("The terminal record belongs to another dispatch."))
    const terminal = yield* validateSharedCreateRecoveryTerminal(row.payload, review, hash)
    return { terminal, hash: row.hash }
  })
}

function continuationResponses(
  original: Original,
  review: SharedCreateRecoveryReview,
  terminal: SharedCreateRecoveryTerminal,
  files: readonly RecoveryFile[],
) {
  return Effect.gen(function* () {
    const records = []
    for (const binding of terminal.bindings) {
      if (review.bindings.some((item) => item.file_id === binding.file_id)) continue
      const file = files.find((item) => item.file_id === binding.file_id)!
      const digest = yield* sha256(
        canonicalSharedJson([review.review_id, `create:${file.file_id}`]),
      )
      const recordId = `create-recovery-receipt-${digest}`
      const rows = yield* querySharedRecords(original.library, {
        skillPageId: original.page,
        kind: "operation",
        recordId,
        entityId: recoveryReceiptsEntity,
        payloadContainsBody: true,
      })
      const row = rows[0]
      if (rows.length !== 1 || row === undefined || row.operation_id !== review.review_id)
        return yield* Effect.fail(refused("A preceding create lacks its exact retained response."))
      const payload = property(row.payload)
      if (
        payload.version !== 1 ||
        payload.kind !== "skill_create_recovery_response" ||
        payload.recovery_id !== review.review_id ||
        payload.original_operation_id !== review.original_operation_id ||
        payload.action !== "create_file_response" ||
        !same(payload.request, {
          path: "v1/pages",
          method: "POST",
          body: fileCreateRequest(original, file),
        }) ||
        (yield* createChecked(() => pageReceipt(payload.response))) !== binding.page_id
      )
        return yield* Effect.fail(
          refused("A retained create response has another page or request."),
        )
      records.push({
        file_id: file.file_id,
        page_id: binding.page_id,
        record_id: recordId,
        hash: row.hash,
      })
    }
    const expected = new Set<string>()
    for (const receipt of records) {
      expected.add(receipt.record_id)
      const digest = yield* sha256(
        canonicalSharedJson([review.review_id, `body:${receipt.file_id}`]),
      )
      expected.add(`create-recovery-receipt-${digest}`)
    }
    const headers = yield* querySharedOperationIndex(original.library, original.page)
    const receipts = headers.filter((header) => header.entity_id === recoveryReceiptsEntity)
    if (
      receipts.length !== expected.size ||
      receipts.some((header) => !expected.has(header.record_id))
    )
      return yield* Effect.fail(
        refused(
          "Recovery responses contradict the terminal's exact stopped prefix; no later create is inferred to be unattempted.",
        ),
      )
    return records
  })
}

function observeContinuation(
  original: Original,
  review: SharedCreateRecoveryReview,
  terminal: SharedCreateRecoveryTerminal,
  files: readonly RecoveryFile[],
  accepted?: SharedCreateContinuationReview,
  dispatched = false,
) {
  return Effect.gen(function* () {
    const prepared = yield* prepareSharedMigrationReview(
      original.library,
      original.plan.origin.candidate,
    )
    if (!same(prepared, original.plan))
      return yield* Effect.fail(refused("The original Source or Router selection changed."))
    const index = yield* querySharedSkillIndex(original.library, original.page)
    const file = files.find((item) => item.file_id === terminal.failed_file_id)!
    const observed = [index.main, ...index.files].find((item) => item.file_id === file.file_id)
    if (observed === undefined)
      return yield* Effect.fail(
        refused("The unknown create has no exact visible allocation. Its POST is never repeated."),
      )
    const bindings = [
      ...terminal.bindings,
      {
        file_id: file.file_id,
        path: file.path,
        page_id: observed.page_id,
        event_id: file.event.event_id,
      },
    ]
    if (accepted !== undefined && !same(bindings, accepted.bindings))
      return yield* Effect.fail(
        refused("An accepted page allocation changed after the continuation review."),
      )
    yield* verifyIndex(
      original,
      files.map((item) =>
        original.outcome.bindings.some((binding) => binding.file_id === item.file_id)
          ? original.plan.files.find((prior) => prior.file_id === item.file_id)!
          : item,
      ),
      bindings,
      false,
    )
    yield* verifySource(original)
    yield* verifyEvents(original, [])
    yield* verifyOperations(
      original,
      review.review_id,
      dispatched ? accepted?.continuation_id : undefined,
    )
    const observations = []
    for (const binding of bindings) {
      const raw = yield* (yield* Notion).request(
        `v1/pages/${binding.page_id}/markdown?markdown_version=v2`,
      )
      const observation = yield* observeBody(binding.file_id, binding.page_id, raw)
      const selected = files.find((item) => item.file_id === binding.file_id)!
      if (
        observation.body_sha256 !== selected.content.sha256 ||
        observation.body_bytes !== selected.content.bytes
      )
        return yield* Effect.fail(
          refused(
            "A current allocation's complete body differs from the frozen recovery projection.",
          ),
        )
      observations.push(observation)
    }
    return { bindings, observations }
  })
}

/** A current allocation is accepted separately; the original POST remains unknown. */
type ContinuationSelection = {
  readonly entry: string
  readonly operationId: string
  readonly target: string
}
export function reviewSharedCreateContinuation(
  input: ContinuationSelection & { readonly plan: unknown },
): ReturnType<typeof reviewSharedCreateAcknowledgedContinuation>
export function reviewSharedCreateContinuation(
  input: ContinuationSelection & { readonly plan?: undefined },
): ReturnType<typeof reviewMigrationContinuation>
export function reviewSharedCreateContinuation(
  input: ContinuationSelection & { readonly plan?: unknown },
) {
  return input.plan === undefined
    ? reviewMigrationContinuation(input)
    : reviewSharedCreateAcknowledgedContinuation({ ...input, plan: input.plan })
}
function reviewMigrationContinuation(input: ContinuationSelection) {
  return Effect.gen(function* () {
    const original = yield* originalFacts(input.entry, input.operationId, input.target)
    const retained = yield* retainedRecoveryReview(original)
    const stopped = yield* retainedRecoveryTerminal(original, retained.review, retained.hash)
    const files = yield* makeSharedCreateRecoveryFiles(original.plan)
    const successfulResponseRecords = yield* continuationResponses(
      original,
      retained.review,
      stopped.terminal,
      files,
    )
    const observed = yield* observeContinuation(original, retained.review, stopped.terminal, files)
    return yield* makeSharedCreateContinuationReview({
      review: retained.review,
      reviewRecordHash: retained.hash,
      terminal: stopped.terminal,
      terminalRecordHash: stopped.hash,
      ...observed,
      successfulResponseRecords,
    })
  })
}

/** This record is emitted only after a page POST has returned unknown and the serial loop stopped. */
function retainRecoveryTerminal(
  original: Original,
  review: SharedCreateRecoveryReview,
  reviewRecordHash: string,
  attemptId: string,
  failedFileId: string,
  bindings: readonly SharedCreateBinding[],
  error: { readonly code: string; readonly message: string; readonly details?: unknown },
) {
  return Effect.gen(function* () {
    const terminal = yield* makeSharedCreateRecoveryTerminal({
      review,
      reviewRecordHash,
      attemptId,
      failedFileId,
      bindings,
      error,
    })
    const digest = yield* sha256(canonicalSharedJson([attemptId, "terminal"]))
    yield* (yield* Store).writeJson(
      `operations/shared-native-recovery-responses/${attemptId}/${digest}.json`,
      terminal,
    )
    yield* appendSharedRecord(original.library, {
      mode: "create",
      recordId: sharedCreateRecoveryTerminalId(attemptId),
      operationId: attemptId,
      skillPageId: original.page,
      kind: "operation",
      entityId: sharedCreateRecoveryTerminalsEntity,
      payload: terminal,
    })
  })
}

/** An existing dispatch always reconciles. It never restarts its page writes. */
type RecoveryApplyInput = {
  readonly entry?: string
  readonly review: unknown
  readonly reviewId: string
  readonly migrationInput?: unknown
  readonly plan?: unknown
  readonly dryRun?: boolean
}
export function applySharedCreateRecovery(
  input: RecoveryApplyInput & { readonly plan: unknown },
): ReturnType<typeof applySharedCreatePrefixRecovery>
export function applySharedCreateRecovery(
  input: RecoveryApplyInput & { readonly plan?: undefined },
): ReturnType<typeof applyRecovery>
export function applySharedCreateRecovery(input: RecoveryApplyInput) {
  return Effect.gen(function* () {
    if (input.plan !== undefined)
      return yield* applySharedCreatePrefixRecovery({ ...input, plan: input.plan })
    return yield* applyRecovery(input, false)
  })
}

export function applySharedCreateContinuation(
  input: RecoveryApplyInput & { readonly plan: unknown },
): ReturnType<typeof applySharedCreateAcknowledgedContinuation>
export function applySharedCreateContinuation(
  input: RecoveryApplyInput & { readonly plan?: undefined },
): ReturnType<typeof applyRecovery>
export function applySharedCreateContinuation(input: RecoveryApplyInput) {
  return input.plan === undefined
    ? applyRecovery(input, true)
    : applySharedCreateAcknowledgedContinuation({ ...input, plan: input.plan })
}

function applyRecovery(input: RecoveryApplyInput, continuing: boolean) {
  return Effect.gen(function* () {
    const continuationInput = continuing
      ? yield* createChecked(() =>
          Schema.decodeUnknownSync(SharedCreateContinuationReviewSchema)(input.review, {
            onExcessProperty: "error",
          }),
        )
      : undefined
    const firstReview = continuing
      ? undefined
      : yield* validateSharedCreateRecoveryReview(input.review, input.reviewId)
    const selection = continuationInput ?? firstReview!
    const original = yield* originalFacts(
      selection.library.skills.database_id,
      selection.original_operation_id,
      selection.skill_page_id,
    )
    // The retained origin and a continuation decision never replace original approval.
    yield* validateSharedMigrationConversion(input.migrationInput, original.plan.origin.candidate)
    const retained = continuing ? yield* retainedRecoveryReview(original) : undefined
    const review = retained?.review ?? firstReview!
    const reconstructed = yield* makeSharedCreateRecoveryReview(original.plan, {
      originalManifestHash: original.manifestHash,
      originalOutcomeHash: original.outcomeHash,
      skillPageId: original.page,
      bindings: original.outcome.bindings,
      observations: review.observations,
    })
    if (!same(reconstructed, review))
      return yield* Effect.fail(
        refused("The saved recovery review differs from its original immutable facts."),
      )
    const files = yield* makeSharedCreateRecoveryFiles(original.plan)
    let continuation: SharedCreateContinuationReview | undefined
    let terminal: SharedCreateRecoveryTerminal | undefined
    if (continuationInput !== undefined) {
      const stopped = yield* retainedRecoveryTerminal(original, review, retained!.hash)
      terminal = stopped.terminal
      continuation = yield* validateSharedCreateContinuationReview(
        continuationInput,
        review,
        retained!.hash,
        terminal,
        stopped.hash,
        input.reviewId,
      )
    }
    const attemptId = continuation?.continuation_id ?? review.review_id
    const attemptReview = { ...review, review_id: attemptId }
    const scope = yield* authScope,
      store = yield* Store
    const key = yield* journalKey(
      scope,
      original.library.library_id,
      original.plan.operation_id,
      continuing,
    )
    const previous = yield* store.readJson(key, Schema.Unknown)
    const shared = yield* querySharedRecords(original.library, {
      skillPageId: original.page,
      kind: "operation",
      recordId: continuing
        ? sharedCreateContinuationReviewId(original.plan.operation_id)
        : sharedCreateRecoveryReviewId(original.plan.operation_id),
      payloadContainsBody: true,
    })
    if (previous !== undefined || shared.length !== 0)
      return yield* reconcileSharedCreateRecovery({
        entry: original.library.skills.database_id,
        operationId: original.plan.operation_id,
        target: original.page,
      })
    if (continuation !== undefined) {
      const responses = yield* continuationResponses(original, review, terminal!, files)
      if (!same(responses, continuation.successful_response_records))
        return yield* Effect.fail(refused("The continuation's retained response evidence changed."))
      yield* observeContinuation(original, review, terminal!, files, continuation)
    } else yield* observeExisting(original, files)
    const existingPages = continuation?.bindings.length ?? original.outcome.bindings.length
    if (input.dryRun)
      return {
        status: "planned" as const,
        dry_run: true as const,
        verified: false as const,
        original_operation_id: original.plan.operation_id,
        recovery_operation_id: review.review_id,
        original_status: "needs_review" as const,
        ...(continuation === undefined
          ? {}
          : {
              continuation_operation_id: continuation.continuation_id,
              original_write_outcome: "unknown" as const,
            }),
        existing_pages: existingPages,
        remaining_pages: files.length - existingPages,
        review: continuation ?? review,
      }
    yield* createChecked(() => {
      for (const file of files) {
        validateSharedRecordEnvelope(
          `retain-${file.content.sha256}`,
          sharedCreateBodyPayload(file.projection.markdown),
        )
        validateSharedRecordEnvelope(file.event.event_id, file.event)
      }
    })
    yield* store.writeJson(key, {
      version: 1,
      scope,
      library_id: original.library.library_id,
      review,
      ...(continuation === undefined ? {} : { continuation }),
    })
    let stage = "review"
    const bindings =
      continuation === undefined
        ? original.outcome.bindings.map((binding) => ({
            ...binding,
            event_id: files.find((file) => file.file_id === binding.file_id)!.event.event_id,
          }))
        : continuation.bindings.map((binding) => ({ ...binding }))
    return yield* Effect.gen(function* () {
      const reviewRecord = yield* appendSharedRecord(original.library, {
        mode: "create",
        recordId: sharedCreateRecoveryReviewId(original.plan.operation_id),
        operationId: review.review_id,
        skillPageId: original.page,
        kind: "operation",
        entityId: sharedCreateRecoveryReviewEntity,
        payload: review,
        payloadContainsBody: true,
      })
      let continuationRecordHash: string | undefined
      if (continuation !== undefined) {
        stage = "continuation_review"
        const continuationRecord = yield* appendSharedRecord(original.library, {
          mode: "create",
          recordId: sharedCreateContinuationReviewId(original.plan.operation_id),
          operationId: continuation.continuation_id,
          skillPageId: original.page,
          kind: "operation",
          entityId: sharedCreateContinuationReviewEntity,
          payload: continuation,
          payloadContainsBody: true,
        })
        continuationRecordHash = continuationRecord.hash
      }
      stage = "pre_dispatch"
      if (continuation !== undefined)
        yield* observeContinuation(original, review, terminal!, files, continuation, true)
      else yield* observeExisting(original, files, review.review_id)
      for (const file of files) {
        stage = `retain:${file.file_id}`
        yield* appendSharedRecord(original.library, {
          mode: "create",
          recordId: file.content.object_id,
          operationId: `retain-${file.content.sha256}`,
          skillPageId: original.page,
          kind: "object",
          entityId: file.content.object_id,
          payload: sharedCreateBodyPayload(file.projection.markdown),
        })
      }
      const api = yield* Notion
      for (const file of files) {
        if (bindings.some((binding) => binding.file_id === file.file_id)) continue
        stage = `create_file:${file.file_id}`
        const request = fileCreateRequest(original, file)
        const response = yield* api.request("v1/pages", request, { method: "POST" }).pipe(
          Effect.tapError((error) =>
            error.code === "WRITE_OUTCOME_UNKNOWN"
              ? retainRecoveryTerminal(
                  original,
                  review,
                  reviewRecord.hash,
                  attemptId,
                  file.file_id,
                  bindings,
                  error,
                ).pipe(
                  // A lost terminal publication cannot replace or resolve the original error.
                  Effect.catch(() => Effect.void),
                )
              : Effect.void,
          ),
        )
        yield* retainedResponse(
          attemptReview,
          `create:${file.file_id}`,
          "create_file_response",
          { path: "v1/pages", method: "POST", body: request },
          response,
        )
        const page = yield* createChecked(() => pageReceipt(response))
        bindings.push({
          file_id: file.file_id,
          path: file.path,
          page_id: page,
          event_id: file.event.event_id,
        })
        stage = `read_created:${file.file_id}`
        const path = `v1/pages/${page}/markdown?markdown_version=v2`
        const raw = yield* api.request(path)
        yield* retainedResponse(
          attemptReview,
          `body:${file.file_id}`,
          "post_create_current_read",
          { path, method: "GET" },
          raw,
        )
        const observed = yield* observeBody(file.file_id, page, raw)
        if (
          observed.body_sha256 !== file.content.sha256 ||
          observed.body_bytes !== file.content.bytes
        )
          return yield* Effect.fail(
            refused(
              "A newly created page differs from the reviewed projection; its original response and later read remain retained.",
            ),
          )
      }
      stage = "complete_disabled_tree"
      yield* verifyIndex(
        original,
        files.map((file) =>
          original.outcome.bindings.some((binding) => binding.file_id === file.file_id)
            ? original.plan.files.find((item) => item.file_id === file.file_id)!
            : file,
        ),
        bindings,
        false,
      )
      yield* verifyEvents(original, [])
      yield* verifySource(original)
      for (const binding of original.outcome.bindings) {
        const file = files.find((item) => item.file_id === binding.file_id)!
        const prior = original.plan.files.find((item) => item.file_id === binding.file_id)!
        if (same(baseline(prior), baseline(file))) continue
        stage = `projection:${file.file_id}`
        const path = `v1/pages/${binding.page_id}`
        const ids =
          binding.page_id === original.page
            ? original.library.skills.property_ids
            : original.library.files.property_ids
        const request = {
          properties: {
            [ids.Projection!]: rich(
              baseline(file) === null ? "" : canonicalSharedJson(baseline(file)),
            ),
          },
        }
        const response = yield* api.request(path, request, { method: "PATCH" })
        yield* retainedResponse(
          attemptReview,
          `projection:${file.file_id}`,
          "projection_metadata_response",
          { path, method: "PATCH", body: request },
          response,
        )
        if ((yield* createChecked(() => pageReceipt(response))) !== binding.page_id)
          return yield* Effect.fail(
            refused("The projection update returned another page identity."),
          )
      }
      stage = "file_events"
      for (const file of files)
        yield* appendSharedRecord(original.library, {
          mode: "create",
          recordId: file.event.event_id,
          operationId: file.event.event_id,
          skillPageId: original.page,
          kind: "file_event",
          entityId: file.file_id,
          payload: file.event,
        })
      stage = "pre_enable"
      yield* verifyIndex(original, files, bindings, false)
      yield* verifySource(original)
      yield* verifyEvents(original, files)
      yield* verifyOperations(original, review.review_id, continuation?.continuation_id)
      // Metadata cannot substitute for a complete, current body comparison.
      for (const file of files) {
        const binding = bindings.find((item) => item.file_id === file.file_id)!
        const raw = yield* api.request(`v1/pages/${binding.page_id}/markdown?markdown_version=v2`)
        const observed = yield* observeBody(file.file_id, binding.page_id, raw)
        if (
          observed.body_sha256 !== file.content.sha256 ||
          observed.body_bytes !== file.content.bytes
        )
          return yield* Effect.fail(
            refused("A current body changed before enable; preserve the disabled recovered tree."),
          )
      }
      stage = "enable"
      const enablePath = `v1/pages/${original.page}`
      const enableRequest = {
        properties: { [original.library.skills.property_ids.Enabled!]: { checkbox: true } },
      }
      const enabled = yield* api.request(enablePath, enableRequest, { method: "PATCH" })
      yield* retainedResponse(
        attemptReview,
        "enable",
        "enable_response",
        { path: enablePath, method: "PATCH", body: enableRequest },
        enabled,
      )
      if ((yield* createChecked(() => pageReceipt(enabled))) !== original.page)
        return yield* Effect.fail(refused("The enable response belongs to another page."))
      stage = "post_enable"
      yield* verifyIndex(original, files, bindings, true)
      yield* verifyEvents(original, files)
      const commonCompletion = {
        kind: "skill_create_recovery_outcome" as const,
        status: "applied" as const,
        original_operation_id: original.plan.operation_id,
        original_manifest_sha256: original.manifestHash,
        original_outcome_sha256: original.outcomeHash,
        recovery_id: review.review_id,
        skill_id: original.plan.skill_id,
        skill_page_id: original.page,
        review_record_hash: reviewRecord.hash,
        bindings,
      }
      const completion: SharedCreateRecoveryOutcome =
        continuation === undefined
          ? { ...commonCompletion, version: 1 }
          : {
              ...commonCompletion,
              version: 2,
              continuation_id: continuation.continuation_id,
              continuation_review_record_hash: continuationRecordHash!,
            }
      yield* createChecked(() =>
        Schema.decodeUnknownSync(SharedCreateRecoveryOutcomeSchema)(completion, {
          onExcessProperty: "error",
        }),
      )
      stage = "completion"
      yield* appendSharedRecord(original.library, {
        mode: "create",
        recordId: sharedCreateRecoveryOutcomeId(original.plan.operation_id),
        operationId: attemptId,
        skillPageId: original.page,
        kind: "operation",
        entityId: sharedCreateRecoveryOutcomesEntity,
        payload: completion,
      })
      yield* retireRecovery(original, continuing)
      stage = "current_snapshot"
      const created = yield* createdResult(original, attemptReview, files, bindings, false)
      return {
        ...(yield* consumeSharedCreation(original.library, created, { readOnly: true })),
        status: "recovered" as const,
        original_operation_id: original.plan.operation_id,
        recovery_operation_id: review.review_id,
        original_status: "needs_review" as const,
        skill_page_id: original.page,
        ...(continuation === undefined
          ? {}
          : {
              continuation_operation_id: continuation.continuation_id,
              original_write_outcome: "unknown" as const,
            }),
        existing_pages_preserved: existingPages,
        created_pages: files.length - existingPages,
      }
    }).pipe(
      Effect.mapError((error) =>
        recoveryError(error, review, stage, continuation?.continuation_id),
      ),
    )
  })
}

/** Historical recovery proof only: no current body adoption and no write replay. */
export function reconcileSharedCreateRecovery(
  input: RecoverySelection & { readonly plan: unknown },
): ReturnType<typeof reconcileSharedCreatePrefixRecovery>
export function reconcileSharedCreateRecovery(
  input: RecoverySelection & { readonly plan?: undefined },
): ReturnType<typeof reconcileMigrationCreateRecovery>
export function reconcileSharedCreateRecovery(
  input: RecoverySelection & { readonly plan?: unknown },
) {
  return Effect.gen(function* () {
    if (input.plan !== undefined)
      return yield* reconcileSharedCreatePrefixRecovery({ ...input, plan: input.plan })
    return yield* reconcileMigrationCreateRecovery(input)
  })
}
function reconcileMigrationCreateRecovery(input: RecoverySelection) {
  return Effect.gen(function* () {
    const original = yield* originalFacts(input.entry, input.operationId, input.target)
    const retained = yield* retainedRecoveryReview(original)
    const review = retained.review
    const outcomes = yield* querySharedRecords(original.library, {
      skillPageId: original.page,
      kind: "operation",
      recordId: sharedCreateRecoveryOutcomeId(original.plan.operation_id),
      entityId: sharedCreateRecoveryOutcomesEntity,
    })
    const record = outcomes[0]
    if (outcomes.length !== 1 || record === undefined)
      return yield* Effect.fail(
        recoveryError(
          refused(
            "No exact recovery completion is visible. Keep every created page and original response; reconcile never repeats a POST or PATCH.",
          ),
          review,
          "completion",
        ),
      )
    const outcome = yield* createChecked(() =>
      Schema.decodeUnknownSync(SharedCreateRecoveryOutcomeSchema)(record.payload, {
        onExcessProperty: "error",
      }),
    )
    const files = yield* makeSharedCreateRecoveryFiles(original.plan)
    if (outcome.version === 2)
      yield* validateSharedCreateContinuationCompletion(original.library, outcome, review)
    else yield* assertSharedCreateRecoveryNotContinued(original.library, review)
    const fields = {
      version: outcome.version,
      kind: "skill_create_recovery_outcome",
      status: "applied",
      original_operation_id: original.plan.operation_id,
      original_manifest_sha256: original.manifestHash,
      original_outcome_sha256: original.outcomeHash,
      recovery_id: review.review_id,
      skill_id: original.plan.skill_id,
      skill_page_id: original.page,
      review_record_hash: retained.hash,
      bindings: outcome.bindings,
      ...(outcome.version === 2
        ? {
            continuation_id: outcome.continuation_id,
            continuation_review_record_hash: outcome.continuation_review_record_hash,
          }
        : {}),
    }
    if (
      !same(outcome, fields) ||
      record.operation_id !==
        (outcome.version === 2 ? outcome.continuation_id : review.review_id) ||
      outcome.bindings.length !== files.length ||
      new Set(outcome.bindings.map((binding) => binding.page_id)).size !== files.length ||
      !same(
        outcome.bindings
          .map(({ file_id, path, event_id }) => ({ file_id, path, event_id }))
          .toSorted((a, b) => a.file_id.localeCompare(b.file_id)),
        files
          .map((file) => ({
            file_id: file.file_id,
            path: file.path,
            event_id: file.event.event_id,
          }))
          .toSorted((a, b) => a.file_id.localeCompare(b.file_id)),
      ) ||
      original.outcome.bindings.some(
        (binding) =>
          outcome.bindings.find((item) => item.file_id === binding.file_id)?.page_id !==
          binding.page_id,
      )
    )
      return yield* Effect.fail(
        refused(
          "The recovery completion does not bind the exact original pages, full file set and new events.",
        ),
      )
    // Later edits can add descendants. Only the retained initial events are checked here.
    for (const file of files)
      yield* appendSharedRecord(original.library, {
        mode: "reconcile",
        recordId: file.event.event_id,
        operationId: file.event.event_id,
        skillPageId: original.page,
        kind: "file_event",
        entityId: file.file_id,
        payload: file.event,
      })
    yield* retireRecovery(original, outcome.version === 2)
    return {
      status: "recovered" as const,
      verified: true as const,
      verification:
        outcome.version === 2
          ? ("reviewed_continuation_outcome" as const)
          : ("original_recovery_outcome" as const),
      ...(outcome.version === 2
        ? {
            continuation_operation_id: outcome.continuation_id,
            original_write_outcome: "unknown" as const,
          }
        : {}),
      original_operation_id: original.plan.operation_id,
      recovery_operation_id: review.review_id,
      original_status: "needs_review" as const,
      skill_page_id: original.page,
      skill_id: original.plan.skill_id,
      bindings: outcome.bindings,
      reused: true as const,
      current_snapshot_verified: false as const,
      requires_fresh_read: true as const,
    }
  })
}
