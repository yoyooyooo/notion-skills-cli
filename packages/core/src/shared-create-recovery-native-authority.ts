import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { property, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { createChecked, SharedCreateJournalSchema } from "./shared-create-model.ts"
import {
  sharedCreateJournalKey,
  sharedCreateMainRequest,
  verifySharedCreateRecoveryScope,
  verifySharedCreateRecoveryIndex,
} from "./shared-create.ts"
import {
  assertSharedCreateAcknowledgedMetadata,
  observeSharedCreatePrefixBody,
} from "./shared-create-recovery-prefix-model.ts"
import { prepareSharedNativeAllocationProof } from "./shared-create-recovery-acknowledgements.ts"
import { prefixRecoveryRequired } from "./shared-create-recovery-errors.ts"
import {
  nativeMainRecoveryPlan,
  makeSharedCreateNativeRecoveryFile,
} from "./shared-create-recovery-native-plan.ts"
import type { SharedCreateNativeRecoveryReview } from "./shared-create-recovery-native-model.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson, querySharedRecords, type SharedRecord } from "./shared-records.ts"
import { sourceField } from "./shared-source-definitions.ts"
import { sha256, Store } from "./store.ts"

type Plan = Effect.Success<ReturnType<typeof nativeMainRecoveryPlan>>
const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const hash = (value: unknown) => sha256(canonicalSharedJson(value))
const refusal = (message: string) => Effect.fail(prefixRecoveryRequired(message))

/** The original dispatcher and ACK, not a later page GET, establish allocation. */
export function originalNativeMainAllocation(plan: Plan, page: string) {
  return Effect.gen(function* () {
    const store = yield* Store,
      scope = yield* authScope,
      api = yield* Notion
    const key = yield* sharedCreateJournalKey(scope, plan.library.library_id, plan.operation_id)
    if (
      (yield* store.listKeys("operations/shared-native-create/")).some(
        (item) => item !== key && item.endsWith("/" + plan.operation_id + ".json"),
      )
    )
      return yield* refusal(
        "The original create has retained evidence in another credential scope.",
      )
    const raw = yield* store.readJson(key, Schema.Unknown)
    if (raw === undefined) return yield* refusal("The exact original create journal is required.")
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
      return yield* refusal("The complete original native journal or dispatch contract changed.")
    const namespace = yield* hash([
      yield* api.credentialIdentity,
      plan.library.library_id,
      plan.library.sources?.data_source_id ?? null,
    ])
    const root = "operations/shared-sources/" + namespace + "/"
    const body = sharedCreateMainRequest(plan.library, plan)
    const request = {
      identity: plan.operation_id + ":" + (yield* hash(["v1/pages", "POST", body])),
      path: "v1/pages" as const,
      method: "POST" as const,
      body,
    }
    const dispatch = {
      version: 1 as const,
      operation: "source-op-" + (yield* hash(request)),
      ...request,
    }
    const expected = root + dispatch.operation + ".json"
    const matches: Array<{ key: string; value: unknown }> = []
    // Foreign payloads are not read. Exact journal/request key traces still block another scope.
    for (const item of yield* store.listKeys("operations/shared-sources/")) {
      if (!/\/source-op-[a-f0-9]{64}\.json$/u.test(item)) continue
      if (!item.startsWith(root)) {
        if (item.endsWith("/" + dispatch.operation + ".json"))
          return yield* refusal(
            "The exact original main dispatch is retained in another credential scope.",
          )
        continue
      }
      const retained = yield* store.readJson(item, Schema.Unknown)
      const identity = property(retained).identity
      if (typeof identity === "string" && identity.startsWith(plan.operation_id + ":"))
        matches.push({ key: item, value: retained })
    }
    if (matches.length !== 1 || matches[0]?.key !== expected || !same(matches[0]?.value, dispatch))
      return yield* refusal(
        "The complete original dispatch set must be exactly one main POST with no later, extra or unknown request.",
      )
    const ack = yield* store.readJson(
      root + "source-ack-" + dispatch.operation.slice("source-op-".length) + ".json",
      Schema.Unknown,
    )
    if (ack === undefined)
      return yield* refusal(
        "The original main lacks its durable ACK; current equality cannot replace it.",
      )
    const file = plan.files[0]!
    const binding = {
      file_id: file.file_id,
      path: file.path,
      page_id: page,
      event_id: file.event.event_id,
    }
    const proof = yield* prepareSharedNativeAllocationProof(plan, page, binding, ack, {
      attemptId: plan.operation_id,
      file,
    })
    const bootstrap: SharedCreateNativeRecoveryReview["bootstrap"] = {
      kind: "acknowledged_main_before_manifest",
      original_journal_sha256: yield* hash(raw),
      original_dispatches_sha256: yield* hash([
        { dispatch, acknowledgement: proof.payload.acknowledgement },
      ]),
      allocations: [proof.reference],
    }
    return { bootstrap, proof, binding }
  })
}

export type NativeRecoveryFact = {
  readonly record_id: string
  readonly operation_id: string
  readonly entity_id: string
  readonly kind: SharedRecord["kind"]
  readonly payload: unknown
  readonly hash: string
}

/** A complete fresh stage check permits only the already acknowledged exact fact prefix. */
export function observeNativeMainRecovery(
  library: SharedLibrary,
  plan: Plan,
  page: string,
  expectedFacts: readonly NativeRecoveryFact[] = [],
) {
  return Effect.gen(function* () {
    const file = yield* makeSharedCreateNativeRecoveryFile(plan),
      old = plan.files[0]!
    const binding = {
      file_id: old.file_id,
      path: old.path,
      page_id: page,
      event_id: old.event.event_id,
    }
    yield* verifySharedCreateRecoveryScope(library, plan, page)
    yield* verifySharedCreateRecoveryIndex(library, plan, page, [binding], false)
    const api = yield* Notion,
      raw = yield* api.request("v1/pages/" + page),
      row = property(raw)
    if (
      row.object !== "page" ||
      row.id !== page ||
      row.in_trash === true ||
      row.archived === true ||
      row.is_archived === true ||
      property(row.parent).data_source_id !== library.skills.data_source_id
    )
      return yield* refusal(
        "The acknowledged native page no longer has its original owner and identity.",
      )
    yield* createChecked(() =>
      assertSharedCreateAcknowledgedMetadata(sharedCreateMainRequest(plan.library, plan), raw),
    )
    const ids = library.skills.property_ids
    for (const field of ["Origin", "Members", "Requires"] as const) {
      const id = ids[field]
      if (id === undefined) continue
      const value = sourceField(raw, id)
      if (value.has_more === true || !Array.isArray(value.relation) || value.relation.length !== 0)
        return yield* refusal(
          "The native main acquired another Source or relation after its original create.",
        )
    }
    for (const field of ["Source", "Source Member", "Projection", "References"] as const) {
      const id = ids[field]
      if (id !== undefined && text(sourceField(raw, id).rich_text) !== "")
        return yield* refusal(
          "The native main acquired another Source, projection or reference binding.",
        )
    }
    // This bounded branch has at most eight facts. Query every kind for the exact owner,
    // without Payload; an incomplete first page already exceeds its allowed denominator.
    const recordIds = library.records.property_ids,
      parameters = new URLSearchParams()
    for (const field of ["Record ID", "Entity ID", "Kind", "Hash", "Skill"] as const)
      parameters.append("filter_properties", recordIds[field]!)
    const census = property(
      yield* api.request(
        "v1/data_sources/" + library.records.data_source_id + "/query?" + parameters,
        { page_size: 100, filter: { property: recordIds.Skill!, relation: { contains: page } } },
        { method: "POST" },
      ),
    )
    if (
      census.object !== "list" ||
      census.has_more !== false ||
      census.next_cursor !== null ||
      (census.request_status !== undefined &&
        property(census.request_status).type !== "complete") ||
      !Array.isArray(census.results) ||
      census.results.length !== expectedFacts.length
    )
      return yield* refusal(
        "The complete all-kind Records census is incomplete or differs from the exact recovery prefix.",
      )
    const seen = new Set<string>()
    for (const rawRecord of census.results) {
      const row = property(rawRecord),
        owner = sourceField(rawRecord, recordIds.Skill!),
        recordId = text(sourceField(rawRecord, recordIds["Record ID"]!).rich_text),
        wanted = expectedFacts.find((fact) => fact.record_id === recordId)
      if (
        !wanted ||
        seen.has(recordId) ||
        row.object !== "page" ||
        row.archived === true ||
        row.is_archived === true ||
        row.in_trash === true ||
        property(row.parent).data_source_id !== library.records.data_source_id ||
        owner.has_more !== false ||
        !Array.isArray(owner.relation) ||
        owner.relation.length !== 1 ||
        property(owner.relation[0]).id !== page ||
        property(sourceField(rawRecord, recordIds.Kind!).select).name !== wanted.kind ||
        text(sourceField(rawRecord, recordIds["Entity ID"]!).rich_text) !== wanted.entity_id ||
        text(sourceField(rawRecord, recordIds.Hash!).rich_text) !== wanted.hash
      )
        return yield* refusal(
          "The native recovery Records census contains a foreign, duplicate or changed fact.",
        )
      seen.add(recordId)
      const records = yield* querySharedRecords(library, {
        skillPageId: page,
        kind: wanted.kind,
        recordId,
        entityId: wanted.entity_id,
        payloadContainsBody: true,
      })
      const actual = records[0]
      if (
        records.length !== 1 ||
        actual === undefined ||
        actual.page_id !== row.id ||
        actual.operation_id !== wanted.operation_id ||
        actual.hash !== wanted.hash ||
        !same(actual.payload, wanted.payload)
      )
        return yield* refusal(
          "A native recovery fact no longer equals its complete immutable payload.",
        )
    }
    const body = yield* api.request("v1/pages/" + page + "/markdown?markdown_version=v2")
    const observed = yield* observeSharedCreatePrefixBody(old.file_id, page, body)
    if (observed.body_sha256 !== file.content.sha256 || observed.body_bytes !== file.content.bytes)
      return yield* refusal(
        "The complete current native body differs from the frozen v12 prediction; preserve it without replacement.",
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
