import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { property, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import {
  createChecked,
  SharedCreateJournalSchema,
  sharedCreateBodyPayload,
  sharedCreateInputPayload,
  sharedCreateManifest,
  sharedCreateManifestEntity,
  sharedCreateOutcomesEntity,
} from "./shared-create-model.ts"
import {
  decodeSharedCreateOutcome,
  sharedCreateManifestRecordHash,
  sharedCreateOutcomeId,
  type SharedCreateBinding,
} from "./shared-create-outcome.ts"
import {
  knownRecoveryPlan,
  SharedCreateKnownBootstrapSchema,
  type SharedCreateKnownBootstrap,
} from "./shared-create-recovery-known-model.ts"
import {
  assertSharedCreateAcknowledgedMetadata,
  prefixRecoveryRequired,
  SharedCreatePrefixBootstrapSchema,
} from "./shared-create-recovery-prefix-model.ts"
import {
  sharedCreateFileRequest,
  sharedCreateJournalKey,
  sharedCreateMainRequest,
} from "./shared-create.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import {
  canonicalSharedJson,
  canonicalSharedRecordEnvelope,
  querySharedRecords,
  type SharedRecord,
} from "./shared-records.ts"
import { SourceMutationAcknowledgementSchema } from "./shared-sources-model.ts"
import { sha256, Store } from "./store.ts"

type Plan = Effect.Success<ReturnType<typeof knownRecoveryPlan>>
type Dispatch = typeof SharedCreatePrefixBootstrapSchema.fields.dispatch.Type
type Acknowledgement = typeof SourceMutationAcknowledgementSchema.Type
const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const hash = (value: unknown) => sha256(canonicalSharedJson(value))
const refusal = (message: string) => Effect.fail(prefixRecoveryRequired(message))
type Fact = {
  readonly record_id: string
  readonly operation_id: string
  readonly entity_id: string
  readonly kind: "operation" | "object" | "source"
  readonly payload: unknown
  readonly hash: string
}
function originalRequest(plan: Plan, body: unknown) {
  return Effect.gen(function* () {
    const request = {
      identity: plan.operation_id + ":" + (yield* hash(["v1/pages", "POST", body])),
      path: "v1/pages" as const,
      method: "POST" as const,
      body,
    }
    return { version: 1 as const, operation: "source-op-" + (yield* hash(request)), ...request }
  })
}
function chunks(value: string) {
  const result: Array<{ type: "text"; text: { content: string } }> = []
  let current = ""
  for (const point of value) {
    if (current.length + point.length > 2000) {
      result.push({ type: "text", text: { content: current } })
      current = ""
    }
    current += point
  }
  if (current) result.push({ type: "text", text: { content: current } })
  return result
}
function assertRecordRequest(library: SharedLibrary, page: string, body: unknown, fact: Fact) {
  const ids = library.records.property_ids,
    fields = property(property(body).properties)
  const stored = text(property(fields[ids.Payload!]).rich_text)
  const wanted = canonicalSharedJson({
    version: 1,
    operation_id: fact.operation_id,
    payload: fact.payload,
  })
  if (canonicalSharedRecordEnvelope(fact.kind, stored) !== wanted)
    throw prefixRecoveryRequired("An original Record request has another complete logical payload.")
  const rich = (value: string) => ({ rich_text: chunks(value) })
  const expected = {
    parent: { type: "data_source_id", data_source_id: library.records.data_source_id },
    properties: {
      [ids.Name!]: { title: chunks(fact.kind + ": " + fact.entity_id) },
      [ids["Record ID"]!]: rich(fact.record_id),
      [ids.Kind!]: { select: { name: fact.kind } },
      [ids["Entity ID"]!]: rich(fact.entity_id),
      [ids.Hash!]: rich(fact.hash),
      [ids.Payload!]: rich(stored),
      [ids.Skill!]: { relation: [{ id: page }] },
    },
  }
  if (!same(body, expected))
    throw prefixRecoveryRequired(
      "An original Record request changed its exact declared fields or owner.",
    )
}
function matchesFact(row: SharedRecord, fact: Fact, page: string) {
  return (
    row.record_id === fact.record_id &&
    row.operation_id === fact.operation_id &&
    row.entity_id === fact.entity_id &&
    row.kind === fact.kind &&
    row.skill_page_id === page &&
    row.hash === fact.hash &&
    same(row.payload, fact.payload)
  )
}

/** Prove the entire original request set. A current page never substitutes for an ACK. */
export function originalKnownCreateBootstrap(library: SharedLibrary, plan: Plan, page: string) {
  return Effect.gen(function* () {
    const store = yield* Store,
      scope = yield* authScope,
      api = yield* Notion
    const journalKey = yield* sharedCreateJournalKey(scope, library.library_id, plan.operation_id)
    if (
      (yield* store.listKeys("operations/shared-native-create/")).some(
        (key) => key !== journalKey && key.endsWith("/" + plan.operation_id + ".json"),
      )
    )
      return yield* refusal("The original create belongs to another credential namespace.")
    const raw = yield* store.readJson(journalKey, Schema.Unknown)
    if (raw === undefined)
      return yield* refusal("The exact original local create journal is required.")
    const journal = yield* createChecked(() =>
      Schema.decodeUnknownSync(SharedCreateJournalSchema)(raw, { onExcessProperty: "error" }),
    )
    if (
      journal.scope !== scope ||
      journal.library_id !== library.library_id ||
      journal.dispatch_receipt_version !== 1 ||
      journal.ownership_receipt_version !== 1 ||
      !same(journal.plan, plan)
    )
      return yield* refusal(
        "The original journal does not retain this complete frozen input and dispatch contract.",
      )

    const operations = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      payloadContainsBody: true,
    })
    const outcomeRow = operations.find(
      (row) => row.record_id === sharedCreateOutcomeId(plan.operation_id),
    )
    const sourceRows = yield* querySharedRecords(library, { skillPageId: page, kind: "source" })
    if (
      (yield* querySharedRecords(library, { skillPageId: page, kind: "file_event" })).length !== 0
    )
      return yield* refusal(
        "Initial ownership was already published; this recovery cannot replace it.",
      )
    const ordered = [
      ...plan.files.filter((file) => file.path === plan.entrypoint),
      ...plan.files.filter((file) => file.path !== plan.entrypoint),
    ]
    const main = ordered[0]!
    let bindings: readonly SharedCreateBinding[] = [
      { file_id: main.file_id, path: main.path, page_id: page, event_id: main.event.event_id },
    ]
    const facts = new Map<string, Fact>(),
      remoteFacts = new Map<string, SharedRecord>()
    const addFact = (
      record_id: string,
      operation_id: string,
      entity_id: string,
      kind: Fact["kind"],
      payload: unknown,
    ) =>
      Effect.gen(function* () {
        const fact: Fact = {
          record_id,
          operation_id,
          entity_id,
          kind,
          payload,
          hash: yield* hash({ version: 1, operation_id, payload }),
        }
        const prior = facts.get(record_id)
        if (prior && !same(prior, fact))
          return yield* refusal("Original retained objects collide under one immutable identity.")
        facts.set(record_id, fact)
      })
    if (outcomeRow === undefined) {
      if (operations.length !== 0 || sourceRows.length !== 0)
        return yield* refusal(
          "The sole-main branch requires no original manifest, outcome or Source record.",
        )
    } else {
      const outcome = yield* createChecked(() => decodeSharedCreateOutcome(outcomeRow))
      const manifestHash = yield* sharedCreateManifestRecordHash(plan)
      if (
        outcome.version !== 1 ||
        outcome.status !== "needs_review" ||
        outcome.reason_code !== "SHARED_CREATE_BODY_MISMATCH" ||
        outcome.operation_id !== plan.operation_id ||
        outcome.skill_id !== plan.skill_id ||
        outcome.skill_page_id !== page ||
        !same(outcome.source_projection, {
          source_id: plan.source_projection.binding.source_id,
          revision: plan.source_projection.binding.commit,
          manifest_record_hash: manifestHash,
        })
      )
        return yield* refusal(
          "Only the exact original fixed Git body-mismatch terminal can enter known-failure recovery.",
        )
      bindings = outcome.bindings
      if (
        bindings.length === 0 ||
        bindings.length > ordered.length ||
        bindings[0]?.page_id !== page ||
        new Set(bindings.map((binding) => binding.page_id)).size !== bindings.length ||
        bindings.some((binding, index) => {
          const file = ordered[index]
          return (
            !file ||
            pageId(binding.page_id) !== binding.page_id ||
            binding.file_id !== file.file_id ||
            binding.path !== file.path ||
            binding.event_id !== file.event.event_id
          )
        })
      )
        return yield* refusal(
          "The original known outcome is not the exact main-first created-page prefix.",
        )
      yield* addFact(
        plan.operation_id,
        plan.operation_id,
        sharedCreateManifestEntity,
        "operation",
        sharedCreateManifest(plan),
      )
      for (const file of plan.files) {
        yield* addFact(
          file.input.object_id,
          "retain-input-" + file.input.sha256,
          file.input.object_id,
          "object",
          sharedCreateInputPayload(file.input.text),
        )
        yield* addFact(
          file.content.object_id,
          "retain-" + file.content.sha256,
          file.content.object_id,
          "object",
          sharedCreateBodyPayload(file.projection.markdown),
        )
      }
      const source = plan.source_projection.binding
      yield* addFact(
        source.source_id,
        "register-" + source.source_id,
        source.source_id,
        "source",
        source,
      )
      yield* addFact(
        outcomeRow.record_id,
        plan.operation_id,
        sharedCreateOutcomesEntity,
        "operation",
        outcome,
      )
      const expectedOperations = [...facts.values()].filter((fact) => fact.kind === "operation")
      if (
        operations.length !== expectedOperations.length ||
        expectedOperations.some((fact) => !operations.some((row) => matchesFact(row, fact, page)))
      )
        return yield* refusal(
          "The exact original manifest and known terminal must remain the complete operation set.",
        )
      for (const row of operations) remoteFacts.set(row.record_id, row)
      const sourceFact = facts.get(source.source_id)!
      if (sourceRows.length !== 1 || !matchesFact(sourceRows[0]!, sourceFact, page))
        return yield* refusal("The original complete fixed Source binding is missing or changed.")
      remoteFacts.set(sourceRows[0]!.record_id, sourceRows[0]!)
      const objects = [...facts.values()].filter((fact) => fact.kind === "object")
      for (let offset = 0; offset < objects.length; offset += 80) {
        const selected = objects.slice(offset, offset + 80)
        const rows = yield* querySharedRecords(library, {
          skillPageId: page,
          kind: "object",
          entityIds: selected.map((fact) => fact.entity_id),
        })
        if (
          rows.length !== selected.length ||
          selected.some((fact) => !rows.some((row) => matchesFact(row, fact, page)))
        )
          return yield* refusal(
            "A complete retained original input or old projected body differs from the frozen plan.",
          )
        for (const row of rows) remoteFacts.set(row.record_id, row)
      }
    }

    const namespace = yield* hash([
      yield* api.credentialIdentity,
      library.library_id,
      library.sources?.data_source_id ?? null,
    ])
    const root = "operations/shared-sources/" + namespace + "/"
    const native = new Map<
      string,
      { readonly dispatch: Dispatch; readonly binding: SharedCreateBinding }
    >()
    for (const binding of bindings) {
      const file = plan.files.find((item) => item.file_id === binding.file_id)!
      const body =
        binding.page_id === page
          ? sharedCreateMainRequest(plan.library, plan)
          : sharedCreateFileRequest(plan.library, page, file)
      const dispatch = yield* originalRequest(plan, body)
      native.set(dispatch.operation, { dispatch, binding })
    }
    const retained: Array<{ dispatch: Dispatch; acknowledgement: Acknowledgement }> = []
    const seenFacts = new Set<string>(),
      seenNative = new Set<string>(),
      seenPages = new Set<string>()
    for (const key of yield* store.listKeys("operations/shared-sources/")) {
      if (!/\/source-op-[a-f0-9]{64}\.json$/u.test(key)) continue
      const saved = yield* store.readJson(key, Schema.Unknown)
      const identity = property(saved).identity
      if (typeof identity !== "string" || !identity.startsWith(plan.operation_id + ":")) continue
      if (!key.startsWith(root))
        return yield* refusal("An original dispatch exists in another credential namespace.")
      const dispatch = yield* createChecked(() =>
        Schema.decodeUnknownSync(SharedCreatePrefixBootstrapSchema.fields.dispatch)(saved, {
          onExcessProperty: "error",
        }),
      )
      if (
        !same(dispatch, yield* originalRequest(plan, dispatch.body)) ||
        key !== root + dispatch.operation + ".json"
      )
        return yield* refusal(
          "An original dispatch no longer has its exact immutable request identity.",
        )
      const ackRaw = yield* store.readJson(
        root + "source-ack-" + dispatch.operation.slice("source-op-".length) + ".json",
        Schema.Unknown,
      )
      if (ackRaw === undefined)
        return yield* refusal(
          "An original request has no durable ACK; unknown requests cannot be replayed.",
        )
      const ack = yield* createChecked(() =>
        Schema.decodeUnknownSync(SourceMutationAcknowledgementSchema)(ackRaw, {
          onExcessProperty: "error",
        }),
      )
      const response = property(ack.response),
        parent = property(response.parent)
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
        !same(parent.data_source_id, property(property(dispatch.body).parent).data_source_id)
      )
        return yield* refusal(
          "An original ACK no longer binds its exact request, unique page or parent.",
        )
      yield* createChecked(() =>
        assertSharedCreateAcknowledgedMetadata(dispatch.body, ack.response),
      )
      seenPages.add(response.id)
      const allocation = native.get(dispatch.operation)
      if (allocation !== undefined) {
        if (
          !same(dispatch, allocation.dispatch) ||
          response.id !== allocation.binding.page_id ||
          seenNative.has(dispatch.operation)
        )
          return yield* refusal(
            "An original native ACK does not preserve its exact page allocation.",
          )
        seenNative.add(dispatch.operation)
      } else {
        const fields = property(property(dispatch.body).properties)
        const recordId = text(
          property(fields[library.records.property_ids["Record ID"]!]).rich_text,
        )
        const fact = facts.get(recordId)
        if (!fact || seenFacts.has(recordId))
          return yield* refusal(
            "The original dispatch set contains an extra or repeated Record request.",
          )
        yield* createChecked(() => assertRecordRequest(library, page, dispatch.body, fact))
        const remote = remoteFacts.get(recordId)
        if (!remote || remote.page_id !== response.id)
          return yield* refusal("An original immutable Record is now allocated to another page.")
        seenFacts.add(recordId)
      }
      retained.push({ dispatch, acknowledgement: ack })
    }
    if (
      seenNative.size !== native.size ||
      seenFacts.size !== facts.size ||
      retained.length !== native.size + facts.size
    )
      return yield* refusal(
        "The exact complete original request and ACK set is missing, foreign or unknown.",
      )
    const allocations = bindings.map((binding) => {
      const allocation = [...native.values()].find(
        (item) => item.binding.file_id === binding.file_id,
      )!
      return {
        file_id: binding.file_id,
        acknowledgement: retained.find(
          (item) => item.dispatch.operation === allocation.dispatch.operation,
        )!.acknowledgement,
      }
    })
    const bootstrap: SharedCreateKnownBootstrap = {
      kind: outcomeRow ? "known_needs_review" : "acknowledged_main_before_manifest",
      original_journal_sha256: yield* hash(raw),
      original_dispatches_sha256: yield* hash(
        retained.sort((left, right) =>
          left.dispatch.operation.localeCompare(right.dispatch.operation),
        ),
      ),
      allocations,
    }
    yield* createChecked(() =>
      Schema.decodeUnknownSync(SharedCreateKnownBootstrapSchema)(bootstrap, {
        onExcessProperty: "error",
      }),
    )
    return { bootstrap, bindings, originalOutcomeHash: outcomeRow?.hash ?? null }
  })
}
