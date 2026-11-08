import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { invalidateSnapshotCache, invalidateSubscriptionCatalog } from "./cache.ts"
import { fail, property } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { pageId } from "./ref.ts"
import { sharedNotionMarkdownWire } from "./shared-notion-projection.ts"
import { sharedSkillId } from "./shared-content.ts"
import {
  createChecked,
  SharedCreateJournalSchema,
  sharedCreateBodyPayload,
  sharedCreateEnabled,
  sharedCreateManifestEntity,
} from "./shared-create-model.ts"
import { sharedCreateDispatch } from "./shared-create-dispatch.ts"
import { saveSharedCreateOwnership } from "./shared-create-ownership.ts"
import {
  loadSharedCreatePlan,
  sharedCreateJournalKey,
  sharedCreateMainRequest,
  retainSharedCreateInputs,
  retainSharedCreateManifest,
  verifySharedCreateRecoveryScope,
  verifySharedCreateRecoveryIndex,
} from "./shared-create.ts"
import {
  sharedCreateRecoveryReviewId,
  sharedCreateRecoveryReviewEntity,
  sharedCreateRecoveryOutcomeId,
  sharedCreateRecoveryOutcomesEntity,
} from "./shared-create-recovery-completion.ts"
import { readSharedCreatePrefixCompletion } from "./shared-create-recovery-prefix-completion.ts"
import {
  makeSharedCreatePrefixRecoveryFiles,
  makeSharedCreatePrefixRecoveryReview,
  observeSharedCreatePrefixBody,
  prefixRecoveryPlan,
  prefixRecoveryRequired,
  SharedCreatePrefixBootstrapSchema,
  validateSharedCreatePrefixRecoveryReview,
  type SharedCreatePrefixRecoveryReview,
  type SharedCreatePrefixRecoveryOutcome,
} from "./shared-create-recovery-prefix-model.ts"
import { FileEventSchema, type FileEvent } from "./shared-file-state.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { querySharedOperationIndex } from "./shared-operation-index.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  validateSharedRecordEnvelope,
} from "./shared-records.ts"
import { registerSourceBinding, resolveSourceBinding } from "./shared-source-binding.ts"
import { sha256, Store } from "./store.ts"
import type { SharedCreateBinding } from "./shared-create-outcome.ts"

type Plan = Effect.Success<ReturnType<typeof prefixRecoveryPlan>>
type Files = Effect.Success<ReturnType<typeof makeSharedCreatePrefixRecoveryFiles>>
const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const refusal = (message: string) => Effect.fail(prefixRecoveryRequired(message))
const jsonHash = (value: unknown) => sha256(canonicalSharedJson(value))
function recoveryKey(scope: string, libraryId: string, operation: string) {
  return jsonHash([scope, libraryId]).pipe(
    Effect.map((hash) => "operations/shared-native-recovery/" + hash + "/" + operation + ".json"),
  )
}

/** The exact local original namespace is required. Current equality is never an ACK. */
function originalBootstrap(plan: Plan, target: string) {
  return Effect.gen(function* () {
    const store = yield* Store,
      scope = yield* authScope,
      api = yield* Notion
    const key = yield* sharedCreateJournalKey(scope, plan.library.library_id, plan.operation_id)
    const allOriginals = yield* store.listKeys("operations/shared-native-create/")
    if (
      allOriginals.some((item) => item !== key && item.endsWith("/" + plan.operation_id + ".json"))
    )
      return yield* refusal(
        "The original creation belongs to another credential scope; no new bootstrap is allowed.",
      )
    const raw = yield* store.readJson(key, Schema.Unknown)
    if (raw === undefined)
      return yield* refusal("The exact original local create journal is required.")
    const journal = yield* createChecked(() =>
      Schema.decodeUnknownSync(SharedCreateJournalSchema)(raw, { onExcessProperty: "error" }),
    )
    if (
      journal.scope !== scope ||
      journal.library_id !== plan.library.library_id ||
      journal.dispatch_receipt_version !== 1 ||
      journal.ownership_receipt_version !== 1 ||
      !same(journal.plan, plan)
    )
      return yield* refusal(
        "The original local journal does not prove this complete frozen creation intent.",
      )
    const namespace = yield* jsonHash([
      yield* api.credentialIdentity,
      plan.library.library_id,
      plan.library.sources?.data_source_id ?? null,
    ])
    const root = "operations/shared-sources/" + namespace + "/"
    const body = sharedCreateMainRequest(plan.library, plan)
    const request = {
      identity: plan.operation_id + ":" + (yield* jsonHash(["v1/pages", "POST", body])),
      path: "v1/pages" as const,
      method: "POST" as const,
      body,
    }
    const operation = "source-op-" + (yield* jsonHash(request))
    const dispatch = { version: 1 as const, operation, ...request }
    const expectedKey = root + operation + ".json"
    const operations = []
    for (const item of yield* store.listKeys("operations/shared-sources/")) {
      if (!/\/source-op-[a-f0-9]{64}\.json$/u.test(item)) continue
      if (!item.startsWith(root)) {
        if (item.endsWith("/" + operation + ".json"))
          return yield* refusal("The original page request is also retained in another scope.")
        continue
      }
      const retained = yield* store.readJson(item, Schema.Unknown)
      const identity = property(retained).identity
      if (typeof identity === "string" && identity.startsWith(plan.operation_id + ":"))
        operations.push({ key: item, value: retained })
    }
    if (
      operations.length !== 1 ||
      operations[0]?.key !== expectedKey ||
      !same(operations[0]?.value, dispatch)
    )
      return yield* refusal(
        "The original dispatcher must retain exactly the acknowledged main prefix, with no later or unknown attempt.",
      )
    const acknowledgement = yield* store.readJson(
      root + "source-ack-" + operation.slice("source-op-".length) + ".json",
      Schema.Unknown,
    )
    if (acknowledgement === undefined)
      return yield* refusal(
        "The original main POST has no durable ACK; it cannot be accepted from a current page.",
      )
    const originalJournalHash = yield* jsonHash(raw)
    const bootstrap = yield* createChecked(() =>
      Schema.decodeUnknownSync(SharedCreatePrefixBootstrapSchema)(
        {
          kind: "acknowledged_main_before_manifest",
          original_journal_sha256: originalJournalHash,
          dispatch,
          acknowledgement,
        },
        { onExcessProperty: "error" },
      ),
    )
    if (property(bootstrap.acknowledgement.response).id !== target)
      return yield* refusal("The original ACK belongs to another page.")
    return bootstrap
  })
}

function baseline(file: Files[number]) {
  return { ...file.event.projection, source_revision: file.event.source_revision }
}
function spans(value: string) {
  const points = Array.from(value),
    result = []
  for (let at = 0; at < points.length; at += 2000)
    result.push({ type: "text", text: { content: points.slice(at, at + 2000).join("") } })
  return result
}
const rich = (value: string) => ({ rich_text: spans(value) })

function fileRequest(library: SharedLibrary, page: string, file: Files[number]) {
  const ids = library.files.property_ids
  return {
    parent: { type: "data_source_id", data_source_id: library.files.data_source_id },
    properties: {
      [ids.Name!]: { title: spans(file.path.split("/").at(-1) ?? file.path) },
      [ids["File ID"]!]: rich(file.file_id),
      [ids.Path!]: rich(file.path),
      [ids.Projection!]: rich(canonicalSharedJson(baseline(file))),
      [ids.Status!]: { select: { name: "following" } },
      [ids.Skill!]: { relation: [{ id: page }] },
    },
    // v9 has independently proved byte equality to the original v8 wire.
    markdown: sharedNotionMarkdownWire(file.projection),
    markdown_version: "v2",
  }
}
function receipt(raw: unknown) {
  const value = property(raw)
  if (
    value.object !== "page" ||
    typeof value.id !== "string" ||
    pageId(value.id) !== value.id ||
    value.in_trash === true ||
    value.archived === true
  )
    throw prefixRecoveryRequired("The recovery mutation has no exact page acknowledgement.")
  return value.id
}

function noForeignFacts(
  library: SharedLibrary,
  plan: Plan,
  page: string,
  files: Files,
  review?: SharedCreatePrefixRecoveryReview,
) {
  return Effect.gen(function* () {
    const headers = yield* querySharedOperationIndex(library, page)
    const reviewHash =
      review === undefined
        ? undefined
        : yield* jsonHash({ version: 1, operation_id: review.review_id, payload: review })
    for (const header of headers) {
      if (
        review !== undefined &&
        ((header.record_id === sharedCreateRecoveryReviewId(plan.operation_id) &&
          header.entity_id === sharedCreateRecoveryReviewEntity &&
          header.hash === reviewHash) ||
          (header.record_id === plan.operation_id &&
            header.entity_id === sharedCreateManifestEntity &&
            header.hash === review.original_manifest_sha256))
      )
        continue
      return yield* refusal(
        "The partial Skill has another operation; this bounded prefix cannot replace it.",
      )
    }
    const rows = yield* querySharedRecords(library, { skillPageId: page, kind: "file_event" })
    for (const row of rows) {
      const event = yield* createChecked(() =>
        Schema.decodeUnknownSync(FileEventSchema)(row.payload, { onExcessProperty: "error" }),
      )
      const wanted =
        review === undefined
          ? undefined
          : files.find((file) => file.event.event_id === event.event_id)
      if (
        !wanted ||
        !same(event, wanted.event) ||
        row.record_id !== event.event_id ||
        row.operation_id !== event.event_id ||
        row.entity_id !== event.file_id
      )
        return yield* refusal("The partial Skill has foreign or changed ownership facts.")
    }
    const sources = yield* querySharedRecords(library, { skillPageId: page, kind: "source" })
    if (sources.length > (review === undefined ? 0 : 1))
      return yield* refusal(
        "The partial Skill has a Source fact outside the original fixed binding.",
      )
    if (sources.length === 1) {
      const current = yield* resolveSourceBinding(library, {
        skillPageId: page,
        sourceId: plan.source_projection.binding.source_id,
      })
      if (!same(current, plan.source_projection.binding))
        return yield* refusal("The retained Source differs from the exact original fixed revision.")
    }
    return rows.map((row) => Schema.decodeUnknownSync(FileEventSchema)(row.payload))
  })
}

function observeAllocated(
  library: SharedLibrary,
  plan: Plan,
  page: string,
  files: Files,
  bindings: readonly SharedCreateBinding[],
  projected: boolean,
  enabled: boolean,
  review?: SharedCreatePrefixRecoveryReview,
) {
  return Effect.gen(function* () {
    yield* verifySharedCreateRecoveryScope(library, plan, page)
    const currentFiles = files.map((file) =>
      file.path === plan.entrypoint && !projected
        ? plan.files.find((old) => old.file_id === file.file_id)!
        : file,
    )
    yield* verifySharedCreateRecoveryIndex(
      library,
      { ...plan, files: currentFiles },
      page,
      bindings,
      enabled,
      true,
    )
    yield* noForeignFacts(library, plan, page, files, review)
    const observations = []
    for (const binding of bindings) {
      const raw = yield* (yield* Notion).request(
        "v1/pages/" + binding.page_id + "/markdown?markdown_version=v2",
      )
      const observed = yield* observeSharedCreatePrefixBody(binding.file_id, binding.page_id, raw)
      const expected = files.find((file) => file.file_id === binding.file_id)
      if (
        !expected ||
        observed.body_sha256 !== expected.content.sha256 ||
        observed.body_bytes !== expected.content.bytes
      )
        return yield* refusal(
          "The complete current body differs from the independently frozen v9 prediction; preserve that content.",
        )
      observations.push(observed)
    }
    return observations
  }).pipe(withReadOnlyNotion)
}

export function reviewSharedCreatePrefixRecovery(input: {
  readonly entry: string
  readonly operationId: string
  readonly target: string
  readonly plan: unknown
}) {
  return Effect.gen(function* () {
    const plan = yield* prefixRecoveryPlan(input.plan)
    const page = pageId(input.target)
    if (!page || plan.operation_id !== input.operationId)
      return yield* refusal("Select the exact original operation and acknowledged target.")
    const library = yield* loadSharedLibrary(input.entry)
    const bootstrap = yield* originalBootstrap(plan, page)
    const files = yield* makeSharedCreatePrefixRecoveryFiles(plan)
    const main = plan.files.find((file) => file.path === plan.entrypoint)!
    const bindings = [
      { file_id: main.file_id, path: main.path, page_id: page, event_id: main.event.event_id },
    ]
    const observations = yield* observeAllocated(library, plan, page, files, bindings, false, false)
    return yield* makeSharedCreatePrefixRecoveryReview({
      plan,
      bootstrap,
      skillPageId: page,
      bindings,
      observations,
    })
  }).pipe(withReadOnlyNotion)
}

function existingCompletion(plan: Plan, library: SharedLibrary, page: string) {
  return Effect.gen(function* () {
    const headers = yield* querySharedOperationIndex(library, page)
    const manifest = headers.find(
      (header) =>
        header.record_id === plan.operation_id && header.entity_id === sharedCreateManifestEntity,
    )
    if (!manifest)
      return yield* refusal(
        "No exact recovery completion is visible; original page writes are never replayed.",
      )
    const events = (yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "file_event",
    })).map((row) => Schema.decodeUnknownSync(FileEventSchema)(row.payload))
    const result = yield* readSharedCreatePrefixCompletion(library, {
      skillPageId: page,
      originalManifestHeader: manifest,
      events,
      headers,
    })
    if (!result)
      return yield* refusal(
        "The recovery has no exact completion. Retain all original attempts and reconcile without replay.",
      )
    const restored = yield* loadSharedCreatePlan(library, {
      skillPageId: page,
      operationId: plan.operation_id,
    })
    if (!same(restored, plan))
      return yield* refusal(
        "The shared original inputs differ from the supplied complete original plan.",
      )
    const rebuilt = yield* makeSharedCreatePrefixRecoveryReview({
      plan,
      bootstrap: result.review.bootstrap,
      skillPageId: page,
      bindings: result.review.bindings,
      observations: result.review.observations,
    })
    if (!same(rebuilt, result.review))
      return yield* refusal(
        "The retained recovery differs from the exact original input projection.",
      )
    return result
  })
}
export function reconcileSharedCreatePrefixRecovery(input: {
  readonly entry: string
  readonly operationId: string
  readonly target: string
  readonly plan: unknown
}) {
  return Effect.gen(function* () {
    const plan = yield* prefixRecoveryPlan(input.plan)
    const page = pageId(input.target)
    if (!page || input.operationId !== plan.operation_id)
      return yield* refusal("Select the exact original create and acknowledged Skill.")
    const library = yield* loadSharedLibrary(input.entry)
    const result = yield* existingCompletion(plan, library, page)
    return {
      status: "recovered" as const,
      original_operation_id: plan.operation_id,
      recovery_operation_id: result.review.review_id,
      skill_page_id: page,
      original_status: "acknowledged_prefix" as const,
      original_outcome_recorded: false as const,
      verification: "original_recovery_outcome" as const,
      verified: true as const,
      current_snapshot_verified: false as const,
      requires_fresh_read: true as const,
      reused: true as const,
      existing_pages_preserved: 1,
      created_pages: plan.files.length - 1,
    }
  }).pipe(withReadOnlyNotion)
}

export function applySharedCreatePrefixRecovery(input: {
  readonly entry?: string
  readonly plan: unknown
  readonly review: unknown
  readonly reviewId: string
  readonly dryRun?: boolean
}) {
  return Effect.gen(function* () {
    const plan = yield* prefixRecoveryPlan(input.plan)
    const review = yield* validateSharedCreatePrefixRecoveryReview(input.review, input.reviewId)
    const page = review.skill_page_id,
      library = yield* loadSharedLibrary(input.entry ?? review.library.skills.database_id)
    const reconstructed = yield* makeSharedCreatePrefixRecoveryReview({
      plan,
      bootstrap: review.bootstrap,
      skillPageId: page,
      bindings: review.bindings,
      observations: review.observations,
    })
    if (!same(reconstructed, review))
      return yield* refusal(
        "The reviewed decision does not preserve the complete original approved input.",
      )
    const scope = yield* authScope,
      store = yield* Store
    const key = yield* recoveryKey(scope, library.library_id, plan.operation_id)
    const sharedReview = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      recordId: sharedCreateRecoveryReviewId(plan.operation_id),
      payloadContainsBody: true,
    })
    if ((yield* store.readJson(key, Schema.Unknown)) !== undefined || sharedReview.length !== 0)
      return yield* reconcileSharedCreatePrefixRecovery({
        entry: library.skills.database_id,
        operationId: plan.operation_id,
        target: page,
        plan,
      })
    const bootstrap = yield* originalBootstrap(plan, page)
    if (!same(bootstrap, review.bootstrap))
      return yield* refusal("The original local journal or ACK changed after recovery review.")
    const files = yield* makeSharedCreatePrefixRecoveryFiles(plan)
    yield* observeAllocated(library, plan, page, files, review.bindings, false, false)
    const plannedRecords = new Set([
      sharedCreateRecoveryReviewId(plan.operation_id),
      plan.operation_id,
      plan.source_projection.binding.source_id,
      sharedCreateRecoveryOutcomeId(plan.operation_id),
      ...plan.files.flatMap((file) => [file.input.object_id, file.content.object_id]),
      ...files.flatMap((file) => [file.content.object_id, file.event.event_id]),
    ])
    if (input.dryRun)
      return {
        status: "planned" as const,
        dry_run: true as const,
        verified: false as const,
        original_operation_id: plan.operation_id,
        recovery_operation_id: review.review_id,
        original_status: "acknowledged_prefix" as const,
        original_outcome_recorded: false as const,
        existing_pages: 1,
        remaining_pages: files.length - 1,
        write_plan: {
          record_ids: [...plannedRecords].sort(),
          maximum_record_creates: plannedRecords.size,
          native_page_creates: files.length - 1,
          existing_body_patches: 0,
          metadata_patches: 1 + (sharedCreateEnabled(plan) ? 1 : 0),
          notion_write_upper_bound:
            plannedRecords.size + files.length + (sharedCreateEnabled(plan) ? 1 : 0),
        },
        review,
      }
    yield* createChecked(() => {
      validateSharedRecordEnvelope(review.review_id, review, "operation")
      for (const file of files) {
        validateSharedRecordEnvelope(
          "retain-" + file.content.sha256,
          sharedCreateBodyPayload(file.projection.markdown),
        )
        validateSharedRecordEnvelope(file.event.event_id, file.event)
      }
    })
    yield* store.writeJson(key, { version: 2, scope, library_id: library.library_id, review })
    const main = files.find((file) => file.path === plan.entrypoint)!
    const bindings: SharedCreateBinding[] = [
      { ...review.bindings[0]!, event_id: main.event.event_id },
    ]
    let stage = "review",
      checkedStage: string | undefined,
      projected = false,
      enabled = false
    const beforeDispatch = Effect.gen(function* () {
      if (checkedStage === stage) return
      yield* observeAllocated(library, plan, page, files, bindings, projected, enabled, review)
      checkedStage = stage
    })
    const dispatch = yield* sharedCreateDispatch(
      plan.library,
      { operation_id: review.review_id, skill_id: plan.skill_id },
      beforeDispatch,
    )
    return yield* Effect.gen(function* () {
      const record = yield* appendSharedRecord(library, {
        mode: "create",
        recordId: sharedCreateRecoveryReviewId(plan.operation_id),
        operationId: review.review_id,
        skillPageId: page,
        kind: "operation",
        entityId: sharedCreateRecoveryReviewEntity,
        payload: review,
        payloadContainsBody: true,
      })
      stage = "original_manifest"
      yield* retainSharedCreateManifest(library, plan, page, "create")
      stage = "original_inputs"
      yield* retainSharedCreateInputs(library, plan, page, "create")
      stage = "source"
      yield* registerSourceBinding(library, {
        skillPageId: page,
        mode: "create",
        fixedSource: plan.source_projection.binding,
      })
      stage = "recovery_bodies"
      for (const file of files)
        yield* appendSharedRecord(library, {
          mode: "create",
          recordId: file.content.object_id,
          operationId: "retain-" + file.content.sha256,
          skillPageId: page,
          kind: "object",
          entityId: file.content.object_id,
          payload: sharedCreateBodyPayload(file.projection.markdown),
        })
      const api = yield* Notion
      for (const file of files) {
        if (file.file_id === main.file_id) continue
        stage = "create_file:" + file.file_id
        const raw = yield* api.request("v1/pages", fileRequest(library, page, file), {
          method: "POST",
        })
        const created = yield* createChecked(() => receipt(raw))
        bindings.push({
          file_id: file.file_id,
          path: file.path,
          page_id: created,
          event_id: file.event.event_id,
        })
      }
      stage = "main_projection"
      const raw = yield* api.request(
        "v1/pages/" + page,
        {
          properties: {
            [library.skills.property_ids.Projection!]: rich(canonicalSharedJson(baseline(main))),
          },
        },
        { method: "PATCH" },
      )
      if ((yield* createChecked(() => receipt(raw))) !== page)
        return yield* refusal("The projection metadata ACK belongs to another original page.")
      projected = true
      stage = "file_events"
      for (const file of files)
        yield* appendSharedRecord(library, {
          mode: "create",
          recordId: file.event.event_id,
          operationId: file.event.event_id,
          skillPageId: page,
          kind: "file_event",
          entityId: file.file_id,
          payload: file.event,
        })
      yield* observeAllocated(library, plan, page, files, bindings, projected, false, review)
      const published = yield* noForeignFacts(library, plan, page, files, review)
      if (
        !same(
          published.map((event) => event.event_id).sort(),
          files.map((file) => file.event.event_id).sort(),
        )
      )
        return yield* refusal("The complete original recovery event set is not published.")
      if (sharedCreateEnabled(plan)) {
        stage = "enable"
        const response = yield* api.request(
          "v1/pages/" + page,
          {
            properties: { [library.skills.property_ids.Enabled!]: { checkbox: true } },
          },
          { method: "PATCH" },
        )
        if ((yield* createChecked(() => receipt(response))) !== page)
          return yield* refusal("The enable ACK belongs to another original page.")
        enabled = true
      }
      yield* observeAllocated(library, plan, page, files, bindings, true, enabled, review)
      const completion: SharedCreatePrefixRecoveryOutcome = {
        version: 3,
        kind: "skill_create_recovery_outcome",
        status: "applied",
        original_operation_id: plan.operation_id,
        original_manifest_sha256: review.original_manifest_sha256,
        original_plan_sha256: review.original_plan_sha256,
        original_outcome_sha256: null,
        bootstrap_sha256: yield* jsonHash(review.bootstrap),
        recovery_id: review.review_id,
        skill_id: plan.skill_id,
        skill_page_id: page,
        review_record_hash: record.hash,
        bindings,
      }
      stage = "completion"
      yield* appendSharedRecord(library, {
        mode: "create",
        recordId: sharedCreateRecoveryOutcomeId(plan.operation_id),
        operationId: review.review_id,
        skillPageId: page,
        kind: "operation",
        entityId: sharedCreateRecoveryOutcomesEntity,
        payload: completion,
      })
      yield* saveSharedCreateOwnership(scope, plan, bindings)
      yield* invalidateSubscriptionCatalog(scope, library.skills.database_id)
      yield* invalidateSnapshotCache(sharedSkillId(library.library_id, plan.skill_id), scope)
      yield* store.retireKeys([
        key,
        yield* sharedCreateJournalKey(scope, library.library_id, plan.operation_id),
      ])
      return {
        status: "recovered" as const,
        original_operation_id: plan.operation_id,
        recovery_operation_id: review.review_id,
        skill_page_id: page,
        original_status: "acknowledged_prefix" as const,
        original_outcome_recorded: false as const,
        verified: true as const,
        current_snapshot_verified: false as const,
        requires_fresh_read: true as const,
        reused: false as const,
        existing_pages_preserved: 1,
        created_pages: files.length - 1,
      }
    }).pipe(
      Effect.provideService(Notion, dispatch.api),
      Effect.mapError((error) =>
        fail(error.code, error.message, {
          ...property(error.details),
          original_operation_id: plan.operation_id,
          recovery_operation_id: review.review_id,
          skill_page_id: page,
          stage,
          original_status: "acknowledged_prefix",
          next: {
            command: "ctl library sources recovery reconcile",
            original_plan_required: true,
            target: page,
          },
        }),
      ),
    )
  })
}
