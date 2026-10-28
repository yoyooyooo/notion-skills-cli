import { Clock, Crypto, Effect, Schema } from "effect"
import { authScope, explicitSource } from "./catalog.ts"
import { withLocalLocks } from "./local-locks.ts"
import { fail, property } from "./model.ts"
import { Notion } from "./notion.ts"
import { createPortable, executePublicationDocument } from "./mutation.ts"
import { beginPublication, publicationSession } from "./publication.ts"
import { PublicationReceiptSchema, type Receipt } from "./publication-model.ts"
import {
  canonical,
  copy,
  keyFor,
  observation,
  publicationGuardRoles,
} from "./publication-observation.ts"
import { reconcilePublication } from "./publication-reconcile.ts"
import { bindPublicationSource } from "./publication-source.ts"
import { discoverPublicationCreate } from "./publication-create-discovery.ts"
import { CreationDiscoverySchema } from "./publication-create-identity.ts"
import {
  publicationMarker,
  publicationProperties,
  preparedPublicationMarker,
  PublicationReadOperation,
} from "./publication-integrity.ts"
import { IntegrityIntentSchema } from "./publication-integrity-state.ts"
import { openSkill } from "./snapshot.ts"
import { sha256, Store } from "./store.ts"
import { BindingSchema, UpstreamOperationSchema, UpstreamPlanSchema } from "./upstream-model.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Id = Schema.String.check(Schema.isPattern(/^p_[a-zA-Z0-9-]{1,100}$/))
const MappingSchema = Schema.Struct({
  operation: UpstreamOperationSchema,
  plan: UpstreamPlanSchema,
  item_index: Schema.Number,
  binding: Schema.optional(BindingSchema),
})
export const PublicationSupersedePlanSchema = Schema.Struct({
  format: Schema.Literal(1),
  plan_id: Schema.String,
  guard_hash: Hash,
  operator_intent: Schema.String,
  created_at_ms: Schema.Number,
  expires_at_ms: Schema.Number,
  old_operation_id: Id,
  old_intent_index: Schema.Number,
  old_operation_digest: Hash,
  old_intent_digest: Hash,
  original: PublicationReceiptSchema,
  original_integrity: IntegrityIntentSchema,
  target_kind: Schema.Literals(["root", "child"]),
  parent_id: Schema.String,
  scope: Schema.String,
  database_id: Schema.String,
  data_source_id: Schema.String,
  frozen_files: Schema.Array(Schema.Struct({ path: Schema.String, sha256: Hash })),
  expected_guards: Schema.Record(Schema.String, Schema.Unknown),
  owned_known_siblings: Schema.Array(Schema.String),
  discovery: CreationDiscoverySchema,
  discovery_observations: Schema.Record(Schema.String, Schema.Unknown),
  upstream_mappings: Schema.Array(MappingSchema),
  new_operation_id: Id,
  risk: Schema.Literal(
    "A complete query proves only current API-visible absence. The original POST may have succeeded and its object may appear later. This is one new creation request, not recovery or proof of non-existence; the old unknown remains under review.",
  ),
})
export type PublicationSupersedePlan = typeof PublicationSupersedePlanSchema.Type
const AttemptSchema = Schema.Struct({
  plan: PublicationSupersedePlanSchema,
  state: Schema.Literals(["planned", "applying", "verified", "needs_review"]),
  result: Schema.optional(Schema.Unknown),
})
const risk: PublicationSupersedePlan["risk"] =
  "A complete query proves only current API-visible absence. The original POST may have succeeded and its object may appear later. This is one new creation request, not recovery or proof of non-existence; the old unknown remains under review."
const planKey = (id: string) => `publication-supersede:plan:${id}`
const lineageKey = (id: string) => `publication-supersede:new:${id}`
const originalKey = (id: string, index: number) => `publication-supersede:original:${id}:${index}`
const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => fail("STATE_CORRUPT", "Invalid supersede state or strict plan schema.")),
  )
const digest = (value: unknown) => sha256(canonical(value))
const refusal = (message: string) => Effect.fail(fail("PUBLICATION_SUPERSEDE_REFUSED", message))

function frozen(receipt: Receipt) {
  return Effect.gen(function* () {
    const store = yield* Store
    const files = []
    for (const file of receipt.portable.files) {
      const bytes = yield* store.readBytes(`objects/${file.sha256}`)
      if ((yield* sha256(bytes)) !== file.sha256)
        return yield* refusal("An original frozen source object changed or is corrupt.")
      files.push({ path: file.path, bytes })
    }
    return { ...receipt.portable, files }
  })
}

function inspectOriginal(id: string, index: number) {
  return Effect.gen(function* () {
    const store = yield* Store
    const receipt = yield* store.readJson(keyFor(id), PublicationReceiptSchema)
    if (
      !receipt ||
      !receipt.scope ||
      !receipt.database_id ||
      !receipt.data_source_id ||
      receipt.conflict ||
      receipt.owner
    )
      return yield* refusal("A bound, unchanged original publication is required.")
    if (yield* store.upstream.command(lineageKey(id)))
      return yield* refusal(
        "A superseding attempt cannot itself be superseded; inspect its unknown outcome.",
      )
    const intent = receipt.intents[index]
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      !intent ||
      intent.path !== "v1/pages" ||
      intent.method !== "POST" ||
      !["pending", "unknown"].includes(intent.status) ||
      property(intent.response).id
    )
      return yield* refusal(
        "Select exactly one original unresolved page creation without a known response ID.",
      )
    if (
      receipt.intents.some(
        (other, i) => i !== index && ["pending", "unknown"].includes(other.status),
      )
    )
      return yield* refusal("Another unresolved mutation requires review before supersede.")
    if ((yield* authScope) !== receipt.scope)
      return yield* refusal("The current authentication scope differs from the original intent.")
    const source = yield* explicitSource(receipt.database_id)
    if (!source.data_source_ids.includes(receipt.data_source_id))
      return yield* refusal("The original data source no longer belongs to its bound database.")
    const parent = property(property(intent.body).parent)
    const child = typeof parent.page_id === "string"
    if (
      child
        ? parent.page_id !== receipt.page_id
        : parent.data_source_id !== receipt.data_source_id || !!receipt.page_id
    )
      return yield* refusal(
        "The selected creation does not have its exact original parent identity.",
      )
    const integrity = yield* store.integrity.inspect(id)
    if (!integrity || integrity.marker.state !== "writing")
      return yield* refusal("Original writing intent and frozen intended hash are required.")
    const portable = yield* frozen(receipt)
    const files: Array<readonly [string, number, string]> = []
    for (const file of [...portable.files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ))
      files.push([file.path, file.bytes.length, yield* sha256(file.bytes)])
    if (
      (yield* digest([
        portable.kind,
        portable.name,
        portable.description,
        portable.main,
        files,
      ])) !== integrity.intended_hash
    )
      return yield* refusal(
        "The complete original input no longer matches its frozen intended hash.",
      )
    const api = yield* Notion
    for (const [path, expected] of Object.entries(receipt.guards)) {
      const actual = observation(path, yield* api.request(path))
      if (canonical(actual) !== canonical(expected))
        return yield* refusal(`The original guarded state changed: ${path}`)
    }
    const roles = publicationGuardRoles(receipt)
    const known = [...roles.ownedMutationTargets]
      .map((path) => path.slice("v1/pages/".length))
      .sort()
    const acknowledged = new Set(
      receipt.intents
        .filter((item) => item.path === "v1/pages" && item.status === "completed")
        .map((item) => String(property(item.response).id)),
    )
    if (child && known.some((page) => page !== receipt.page_id && !acknowledged.has(page)))
      return yield* refusal(
        "A child inventory alone cannot confer ownership; every sibling needs an original acknowledged creation identity.",
      )
    if (child) {
      const root = property(receipt.guards[`v1/pages/${receipt.page_id}`])
      const marker = publicationMarker(root)
      if (
        marker?.state !== "writing" ||
        marker.operation_id !== id ||
        marker.intended_hash !== integrity.intended_hash
      )
        return yield* refusal(
          "The owned parent's current marker differs from the original writing intent.",
        )
      for (const page of known) {
        if (
          !(`v1/pages/${page}` in receipt.guards) ||
          !(`v1/pages/${page}/markdown` in receipt.guards)
        )
          return yield* refusal(
            "Every owned root and sibling requires retained metadata and full body guards.",
          )
      }
      if (!(`v1/blocks/${receipt.page_id}/children?page_size=100` in receipt.guards))
        return yield* refusal("The known parent requires a retained complete child inventory.")
      for (const [path, raw] of Object.entries(receipt.guards)) {
        if (!path.startsWith(`v1/blocks/${receipt.page_id}/children?`)) continue
        const inventory = property(raw)
        if (
          inventory.has_more === true &&
          (typeof inventory.next_cursor !== "string" ||
            !(
              `${path.split("&start_cursor=")[0]}&start_cursor=${encodeURIComponent(inventory.next_cursor)}` in
              receipt.guards
            ))
        )
          return yield* refusal("The retained parent inventory has incomplete pagination.")
        for (const row of Array.isArray(inventory.results) ? inventory.results : []) {
          const page = property(row)
          if (
            page.type === "child_page" &&
            (!known.includes(String(page.id)) ||
              !(`v1/pages/${page.id}` in receipt.guards) ||
              !(`v1/pages/${page.id}/markdown` in receipt.guards))
          )
            return yield* refusal("An unguarded child cannot be adopted by its name.")
        }
      }
    }
    const discovery = yield* discoverPublicationCreate(receipt, index)
    if (
      !discovery.evidence.complete ||
      discovery.evidence.candidate_count !== 0 ||
      discovery.candidate
    )
      return yield* refusal(
        "Supersede requires a fresh complete query with zero exact original candidates; recover a known original instead.",
      )
    const mappings: Array<typeof MappingSchema.Type> = []
    for (const operation of yield* store.upstream.scopedOperations(receipt.scope)) {
      for (const [itemIndex, item] of operation.items.entries()) {
        const publication = item.publication_operation_id
        if (!publication) continue
        const resolved = /^p_[a-zA-Z0-9-]{1,100}$/.test(publication)
          ? publication
          : `p_${yield* sha256(publication)}`
        if (resolved !== id) continue
        const plan = yield* store.upstream.plan(operation.plan_id)
        if (
          !plan ||
          !plan.items[itemIndex] ||
          !["unknown", "running", "failed"].includes(item.status)
        )
          return yield* refusal(
            "The upstream publication pointer is not an unresolved frozen item.",
          )
        const binding = (yield* store.upstream.bindings(operation.subscription_id)).find(
          (value) => value.member_key === item.member_key,
        )
        if (!child && (item.page_id || binding || plan.items[itemIndex]!.page_id))
          return yield* refusal(
            "Root supersede requires an original upstream mapping with no page identity.",
          )
        mappings.push({ operation, plan, item_index: itemIndex, ...(binding ? { binding } : {}) })
      }
    }
    if (mappings.length > 1)
      return yield* refusal(
        "More than one upstream publication pointer requires separate operator review.",
      )
    return {
      receipt,
      integrity,
      child,
      known,
      discovery,
      mappings,
      parent: String(child ? parent.page_id : parent.data_source_id),
    }
  })
}

/** Read-only remotely; saves an exact local plan for explicit operator review. */
export function supersedePlanOperation(
  id: string,
  options: { readonly intentIndex: number; readonly operatorIntent: string },
) {
  return Effect.gen(function* () {
    if (!/^p_[a-zA-Z0-9-]{1,100}$/.test(id) || !options.operatorIntent.trim())
      return yield* refusal(
        "Provide the exact original publication and an explicit new operator creation intent.",
      )
    const store = yield* Store
    return yield* withLocalLocks(
      store.root,
      [`publication:${id}`],
      Effect.gen(function* () {
        const prior = yield* store.upstream.command(originalKey(id, options.intentIndex))
        if (prior && property(prior).state !== "planned")
          return yield* refusal(
            "This original intent has already consumed its one superseding attempt.",
          )
        const inspected = yield* inspectOriginal(id, options.intentIndex)
        const crypto = yield* Crypto.Crypto
        const token = yield* crypto
          .randomUUIDv4()
          .pipe(
            Effect.mapError(() => fail("CRYPTO_ERROR", "Could not allocate a supersede identity.")),
          )
        const now = yield* Clock.currentTimeMillis
        const unsigned = {
          format: 1 as const,
          plan_id: `ps_${token}`,
          operator_intent: options.operatorIntent.trim(),
          created_at_ms: now,
          expires_at_ms: now + 300_000,
          old_operation_id: id,
          old_intent_index: options.intentIndex,
          old_operation_digest: yield* digest(inspected.receipt),
          old_intent_digest: yield* digest(inspected.receipt.intents[options.intentIndex]),
          original: inspected.receipt,
          original_integrity: inspected.integrity,
          target_kind: inspected.child ? ("child" as const) : ("root" as const),
          parent_id: inspected.parent,
          scope: inspected.receipt.scope!,
          database_id: inspected.receipt.database_id!,
          data_source_id: inspected.receipt.data_source_id!,
          frozen_files: inspected.receipt.portable.files,
          expected_guards: inspected.receipt.guards,
          owned_known_siblings: inspected.known,
          discovery: inspected.discovery.evidence,
          discovery_observations: {
            ...inspected.discovery.inventories,
            ...inspected.discovery.queryObservations,
          },
          upstream_mappings: inspected.mappings,
          new_operation_id: `p_${token}`,
          risk,
        }
        const plan = yield* decode(PublicationSupersedePlanSchema, {
          ...unsigned,
          guard_hash: yield* digest(unsigned),
        })
        yield* store.upstream.saveCommand(planKey(plan.plan_id), { plan, state: "planned" })
        yield* store.upstream.saveCommand(originalKey(id, options.intentIndex), {
          plan_id: plan.plan_id,
          state: "planned",
        })
        return plan
      }),
    )
  })
}

/** One new request, durably claimed before the publication engine may issue its POST. */
export function supersedeApplyOperation(planId: string, options: { readonly guardHash: string }) {
  return Effect.gen(function* () {
    const store = yield* Store
    const raw = yield* store.upstream.command(planKey(planId))
    if (!raw) return yield* refusal("No exact supersede plan exists.")
    const saved = yield* decode(AttemptSchema, raw)
    const plan = saved.plan
    if (options.guardHash !== plan.guard_hash)
      return yield* refusal("The supplied guard hash differs from the reviewed plan.")
    const { guard_hash: _hash, ...unsigned } = plan
    if ((yield* digest(unsigned)) !== plan.guard_hash)
      return yield* refusal("The frozen supersede plan digest changed.")
    return yield* withLocalLocks(
      store.root,
      [
        `publication:${plan.old_operation_id}`,
        ...plan.upstream_mappings.flatMap((mapping) => [
          `upstream-subscription:${mapping.operation.subscription_id}`,
          ...mapping.plan.items.map((item) => `upstream-target:${item.target_key}`),
        ]),
      ],
      Effect.gen(function* () {
        const current = yield* decode(AttemptSchema, yield* store.upstream.command(planKey(planId)))
        if (current.state === "verified") return current
        if (current.state !== "planned") {
          const receipt = yield* store.readJson(
            keyFor(plan.new_operation_id),
            PublicationReceiptSchema,
          )
          const observation = receipt
            ? yield* reconcilePublication(plan.new_operation_id)
            : undefined
          return {
            ...current,
            state: "needs_review" as const,
            ...(observation ? { observation } : {}),
          }
        }
        const now = yield* Clock.currentTimeMillis
        if (now < plan.created_at_ms || now > plan.expires_at_ms)
          return yield* refusal(
            "This plan is stale; issue a new explicit plan after complete discovery.",
          )
        const original = yield* store.upstream.command(
          originalKey(plan.old_operation_id, plan.old_intent_index),
        )
        if (property(original).plan_id !== planId || property(original).state !== "planned")
          return yield* refusal("The original intent's accepted plan or single-use state changed.")
        const inspected = yield* inspectOriginal(plan.old_operation_id, plan.old_intent_index)
        if (
          (yield* digest(inspected.receipt)) !== plan.old_operation_digest ||
          (yield* digest(inspected.integrity)) !== (yield* digest(plan.original_integrity)) ||
          (yield* digest(inspected.mappings)) !== (yield* digest(plan.upstream_mappings))
        )
          return yield* refusal(
            "Original intent, frozen source, marker, mapping generation or owned sibling state changed.",
          )
        if (yield* store.readJson(keyFor(plan.new_operation_id), PublicationReceiptSchema))
          return yield* refusal(
            "The new creation identity already has a durable publication intent.",
          )
        yield* store.upstream.claimCommand(planKey(planId), current, { plan, state: "applying" })
        yield* store.upstream.claimCommand(
          originalKey(plan.old_operation_id, plan.old_intent_index),
          original,
          { plan_id: planId, state: "applying" },
        )
        yield* store.upstream.saveCommand(lineageKey(plan.new_operation_id), {
          plan_id: planId,
          old_operation_id: plan.old_operation_id,
          old_intent_index: plan.old_intent_index,
        })
        const portable = yield* frozen(inspected.receipt)
        const publicationOptions = {
          operationId: plan.new_operation_id,
          supersedePlanId: plan.plan_id,
          retainedSource: {
            intent: inspected.receipt.context?.source_intent,
            binding: inspected.receipt.source_binding,
          },
          ...(inspected.receipt.context?.ownership
            ? { ownership: inspected.receipt.context.ownership }
            : {}),
        }
        const execution = yield* withLocalLocks(
          store.root,
          [`publication:${plan.new_operation_id}`],
          Effect.gen(function* () {
            let result: unknown
            if (plan.target_kind === "root") {
              result = yield* createPortable(portable, {
                ...publicationOptions,
                database: plan.database_id,
                ...(inspected.receipt.context?.members
                  ? { members: inspected.receipt.context.members }
                  : {}),
              })
            } else {
              yield* beginPublication(
                portable,
                inspected.receipt.operation,
                publicationOptions,
                inspected.receipt.context,
              )
              const replacement: Receipt = {
                ...copy(inspected.receipt),
                operation_id: plan.new_operation_id,
                state: "prepared",
                intents: copy(
                  inspected.receipt.intents.filter((intent) => intent.status === "completed"),
                ),
                stages: [],
                guards: copy(inspected.receipt.guards),
              }
              delete replacement.result
              delete replacement.failure
              delete replacement.owner
              delete replacement.creation_discovery
              const session = yield* publicationSession(replacement, {
                ...publicationOptions,
                supersedePlanId: plan.plan_id,
              })
              const marker = yield* preparedPublicationMarker(plan.new_operation_id)
              const integrity = yield* store.integrity.inspect(plan.new_operation_id)
              yield* store.integrity.update({
                ...integrity!,
                page_id: replacement.page_id!,
                marker,
              })
              result = yield* session.finish(
                Effect.gen(function* () {
                  yield* bindPublicationSource(replacement, plan.data_source_id, session.notion)
                  yield* session.notion.request(
                    `v1/pages/${replacement.page_id}`,
                    { properties: publicationProperties(marker) },
                    { method: "PATCH" },
                  )
                  const baseline = yield* openSkill(replacement.page_id!, {
                    database: plan.database_id,
                    refresh: true,
                  })
                  return yield* executePublicationDocument(
                    portable,
                    {
                      ...publicationOptions,
                      database: plan.database_id,
                      ...(replacement.context?.members
                        ? { members: replacement.context.members }
                        : {}),
                    },
                    replacement.operation,
                    session,
                    baseline,
                  )
                }).pipe(
                  Effect.provideService(Notion, session.notion),
                  Effect.provideService(PublicationReadOperation, plan.new_operation_id),
                ),
              )
            }
            const completed = yield* store.readJson(
              keyFor(plan.new_operation_id),
              PublicationReceiptSchema,
            )
            if (!completed?.page_id || completed.state !== "completed")
              return yield* refusal("New publication has not completed formal readback and commit.")
            for (const mapping of plan.upstream_mappings)
              yield* store.upstream.replacePublicationPointer(
                mapping.operation,
                mapping.item_index,
                mapping.binding,
                plan.new_operation_id,
                completed.page_id,
              )
            const finished = { plan, state: "verified" as const, result }
            yield* store.upstream.saveCommand(planKey(planId), finished)
            yield* store.upstream.saveCommand(
              originalKey(plan.old_operation_id, plan.old_intent_index),
              { plan_id: planId, state: "verified", new_operation_id: plan.new_operation_id },
            )
            return finished
          }),
        ).pipe(Effect.result)
        if (execution._tag === "Failure") {
          yield* store.upstream.saveCommand(planKey(planId), {
            plan,
            state: "needs_review",
            result: { code: execution.failure.code, message: execution.failure.message },
          })
          return yield* Effect.fail(execution.failure)
        }
        return execution.success
      }),
    )
  })
}
