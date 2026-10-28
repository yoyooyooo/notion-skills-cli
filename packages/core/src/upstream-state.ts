import { createHash } from "node:crypto"
import { Context, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { fail, property, SkillsError } from "./model.ts"
import { PublicationReceiptSchema, type Receipt } from "./publication-model.ts"
import { IntegrityIntentSchema, type IntegrityIntent } from "./publication-integrity-state.ts"
import {
  AdoptedMapCheckpointSchema,
  MapCheckpointAdoptionPlanSchema,
  MapCheckpointAdoptionReceiptSchema,
  mapCheckpointAdoptionPlanKey,
  mapCheckpointAdoptionReceipt,
  mapCheckpointAdoptionReceiptKey,
} from "./upstream-map-checkpoint-adoption-model.ts"
import {
  BindingSchema,
  strictJson,
  UpstreamCommandOperationSchema,
  UpstreamOperationSchema,
  UpstreamPlanSchema,
  type UpstreamCommandOperation,
  type UpstreamBinding,
  type UpstreamOperation,
  type UpstreamPlan,
  type PublishedMembers,
} from "./upstream-model.ts"

/** Registered by the single sqlite-state owner in the existing database. */
export const upstreamMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE upstream_plans (plan_id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, plan_hash TEXT NOT NULL, payload TEXT NOT NULL)`
  yield* sql`CREATE TABLE upstream_operations (operation_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL UNIQUE REFERENCES upstream_plans(plan_id), state TEXT NOT NULL, payload TEXT NOT NULL)`
  yield* sql`CREATE TABLE upstream_bindings (subscription_id TEXT NOT NULL, member_key TEXT NOT NULL, target_key TEXT NOT NULL, page_id TEXT NOT NULL, generation INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(subscription_id,member_key))`
  yield* sql`CREATE TABLE upstream_targets (target_key TEXT PRIMARY KEY, page_id TEXT NOT NULL UNIQUE, publisher_subscription_id TEXT NOT NULL)`
  yield* sql`CREATE TABLE upstream_commands (operation_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`
})
export interface MapCheckpointAdoptionCommit {
  readonly adoption_id: string
  readonly adoption_plan: unknown
  readonly receipt: unknown
  readonly original_plan: UpstreamPlan
  readonly original_operation: UpstreamOperation
  readonly bindings: readonly UpstreamBinding[]
  readonly targets: readonly {
    readonly target_key: string
    readonly claim: {
      readonly page_id: string
      readonly publisher_subscription_id: string
    } | null
  }[]
  readonly commands: {
    readonly saved: unknown
    readonly intended: unknown
    readonly accepted_config: unknown | null
    readonly checkpoint: unknown | null
    readonly projection: unknown | null
  }
  readonly publications: readonly {
    readonly operation_id: string
    readonly receipt: Receipt
    readonly integrity: IntegrityIntent
  }[]
  readonly checkpoint: {
    readonly subscription_id: string
    readonly version: string
    readonly published: PublishedMembers
  }
}
export interface UpstreamRepository {
  readonly commitMapCheckpointAdoption: (
    input: MapCheckpointAdoptionCommit,
  ) => Effect.Effect<{ readonly reused: boolean }, SkillsError>
  readonly contentAdoptionClaims: (
    pageId: string,
    targetKey: string,
    originalId: string,
    oldId: string,
  ) => Effect.Effect<
    {
      readonly original_intent_count: number
      readonly publication_ids: readonly string[]
      readonly integrity_ids: readonly string[]
      readonly upstream_operation_ids: readonly string[]
      readonly bindings: readonly UpstreamBinding[]
      readonly targets: readonly {
        readonly target_key: string
        readonly page_id: string
        readonly publisher_subscription_id: string
      }[]
    },
    SkillsError
  >
  readonly savePlan: (plan: UpstreamPlan) => Effect.Effect<void, SkillsError>
  readonly plan: (planId: string) => Effect.Effect<UpstreamPlan | undefined, SkillsError>
  readonly bindings: (
    subscriptionId: string,
  ) => Effect.Effect<readonly UpstreamBinding[], SkillsError>
  readonly target: (
    key: string,
  ) => Effect.Effect<
    { readonly page_id: string; readonly publisher_subscription_id: string } | undefined,
    SkillsError
  >
  readonly operation: (planId: string) => Effect.Effect<UpstreamOperation | undefined, SkillsError>
  readonly saveOperation: (operation: UpstreamOperation) => Effect.Effect<void, SkillsError>
  readonly replacePublicationPointer: (
    expected: UpstreamOperation,
    itemIndex: number,
    expectedBinding: UpstreamBinding | undefined,
    publicationId: string,
    pageId: string,
  ) => Effect.Effect<void, SkillsError>
  readonly commitRebuild: (
    binding: UpstreamBinding,
    expectedBinding: UpstreamBinding | undefined,
    expectedTarget:
      | { readonly page_id: string; readonly publisher_subscription_id: string }
      | undefined,
    publisher: string,
    publicationId: string,
    ownerMemberKey: string,
  ) => Effect.Effect<void, SkillsError>
  readonly advance: (
    binding: UpstreamBinding,
    expectedGeneration: number,
    publisher: string,
    operation: UpstreamOperation,
  ) => Effect.Effect<void, SkillsError>
  readonly setMode: (
    binding: UpstreamBinding,
    expectedGeneration: number,
  ) => Effect.Effect<void, SkillsError>
  readonly command: (operationId: string) => Effect.Effect<unknown | undefined, SkillsError>
  readonly saveCommand: (operationId: string, payload: unknown) => Effect.Effect<void, SkillsError>
  readonly createCommand: (
    operationId: string,
    payload: unknown,
  ) => Effect.Effect<void, SkillsError>
  readonly sourceRichTextRepairClaims: (
    pageId: string,
    targetKey: string,
  ) => Effect.Effect<
    readonly { readonly operation_id: string; readonly value: unknown }[],
    SkillsError
  >
  readonly sourceRootCompletionClaims: (
    pageId: string,
    targetKey: string,
  ) => Effect.Effect<
    readonly { readonly operation_id: string; readonly value: unknown }[],
    SkillsError
  >
  readonly sourceRootFidelityClaims: (
    pageId: string,
    targetKey: string,
  ) => Effect.Effect<
    readonly { readonly operation_id: string; readonly value: unknown }[],
    SkillsError
  >
  readonly contentAdoptionPlanClaims: (
    pageId: string,
    targetKey: string,
  ) => Effect.Effect<readonly string[], SkillsError>
  readonly claimCommand: (
    operationId: string,
    expected: unknown,
    payload: unknown,
    guard?: { readonly operation_id: string; readonly expected: unknown },
  ) => Effect.Effect<void, SkillsError>
  readonly operations: (
    subscriptionId: string,
  ) => Effect.Effect<readonly UpstreamOperation[], SkillsError>
  readonly hasScopedHistory: () => Effect.Effect<boolean, SkillsError>
  readonly scopedOperations: (
    scope: string,
    databaseId?: string,
  ) => Effect.Effect<readonly UpstreamOperation[], SkillsError>
  readonly scopedCommands: (
    scope: string,
    databaseId?: string,
  ) => Effect.Effect<readonly UpstreamCommandOperation[], SkillsError>
}
export class UpstreamState extends Context.Service<UpstreamState, UpstreamRepository>()(
  "ntn-skills/UpstreamState",
) {}
export function makeUpstreamRepository(sql: SqlClient.SqlClient): UpstreamRepository {
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((error) =>
        error instanceof SkillsError
          ? error
          : fail("UPSTREAM_STATE_ERROR", "Upstream SQL transaction failed."),
      ),
    )
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
    if (value && typeof value === "object")
      return `{${Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`
    return JSON.stringify(value) ?? "null"
  }
  const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex")
  const payload = (row: { readonly payload: string } | undefined) =>
    Effect.try({
      try: () => (row ? (JSON.parse(row.payload) as unknown) : undefined),
      catch: () => fail("STATE_CORRUPT", "Invalid map adoption native snapshot."),
    })
  const saveOperation = (operation: UpstreamOperation) =>
    run(
      Effect.gen(function* () {
        const previous = yield* sql<{
          operation_id: string
        }>`SELECT operation_id FROM upstream_operations WHERE plan_id=${operation.plan_id}`
        if (previous[0] && previous[0].operation_id !== operation.operation_id)
          return yield* Effect.fail(
            fail("UPSTREAM_OPERATION_EXISTS", "A plan has one durable operation identity."),
          )
        yield* sql`INSERT INTO upstream_operations ${sql.insert({ operation_id: operation.operation_id, plan_id: operation.plan_id, state: operation.state, payload: JSON.stringify(operation) })} ON CONFLICT(operation_id) DO UPDATE SET state=excluded.state,payload=excluded.payload`
      }),
    )
  const writeBinding = (binding: UpstreamBinding, expected: number) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        generation: number
      }>`SELECT generation FROM upstream_bindings WHERE subscription_id=${binding.subscription_id} AND member_key=${binding.member_key}`
      if ((rows[0]?.generation ?? 0) !== expected || binding.generation !== expected + 1)
        return yield* Effect.fail(
          fail("UPSTREAM_PLAN_STALE", "The accepted member baseline changed."),
        )
      yield* sql`INSERT INTO upstream_bindings ${sql.insert({ subscription_id: binding.subscription_id, member_key: binding.member_key, target_key: binding.target_key, page_id: binding.page_id, generation: binding.generation, payload: JSON.stringify(binding) })} ON CONFLICT(subscription_id,member_key) DO UPDATE SET target_key=excluded.target_key,page_id=excluded.page_id,generation=excluded.generation,payload=excluded.payload`
    })
  return {
    commitMapCheckpointAdoption: (input) =>
      run(
        sql.withTransaction(
          Effect.gen(function* () {
            const {
              adoption,
              receipt,
              publications: publicationSnapshots,
            } = yield* Effect.try({
              try: () => {
                const adoption = Schema.decodeUnknownSync(MapCheckpointAdoptionPlanSchema)(
                  JSON.parse(JSON.stringify(input.adoption_plan)),
                  { onExcessProperty: "error" },
                )
                const receipt = mapCheckpointAdoptionReceipt(adoption)
                const submittedReceipt = Schema.decodeUnknownSync(
                  MapCheckpointAdoptionReceiptSchema,
                )(input.receipt, { onExcessProperty: "error" })
                const publications = input.publications.map((publication) => ({
                  operation_id: publication.operation_id,
                  receipt: Schema.decodeUnknownSync(PublicationReceiptSchema)(
                    JSON.parse(JSON.stringify(publication.receipt)),
                    { onExcessProperty: "error" },
                  ),
                  integrity: Schema.decodeUnknownSync(IntegrityIntentSchema)(
                    JSON.parse(JSON.stringify(publication.integrity)),
                    { onExcessProperty: "error" },
                  ),
                }))
                const native = {
                  original_plan: input.original_plan,
                  original_operation: input.original_operation,
                  bindings: input.bindings,
                  targets: input.targets,
                  commands: input.commands,
                  publications: publications.map((publication) => ({
                    operation_id: publication.operation_id,
                    receipt_sha256: digest(publication.receipt),
                    integrity_sha256: digest(publication.integrity),
                  })),
                }
                const { plan_id: _id, plan_hash: _hash, ...body } = adoption
                const plan = adoption.native_inputs.original_plan
                const operation = adoption.native_inputs.original_operation
                if (
                  !/^mca_[a-f0-9]{64}$/.test(input.adoption_id) ||
                  adoption.plan_id !== input.adoption_id ||
                  adoption.plan_hash !== input.adoption_id.slice(4) ||
                  digest(body) !== adoption.plan_hash ||
                  digest(adoption.native_inputs) !== adoption.native_inputs_sha256 ||
                  digest({ capture: adoption.capture, remote: adoption.remote_evidence }) !==
                    adoption.evidence_sha256 ||
                  canonical(native) !== canonical(adoption.native_inputs) ||
                  canonical(input.checkpoint) !== canonical(adoption.checkpoint) ||
                  canonical(submittedReceipt) !== canonical(receipt) ||
                  adoption.scope !== plan.scope ||
                  adoption.capture.input.original_plan_id !== plan.plan_id ||
                  operation.plan_id !== plan.plan_id ||
                  operation.subscription_id !== plan.subscription_id ||
                  operation.scope !== plan.scope ||
                  adoption.checkpoint.subscription_id !== plan.subscription_id ||
                  !adoption.checkpoint.version ||
                  adoption.remote_evidence.subscription.subscription_id !== plan.subscription_id ||
                  adoption.remote_evidence.subscription.version !== adoption.checkpoint.version ||
                  canonical(adoption.remote_evidence.subscription.published) !==
                    canonical(adoption.checkpoint.published)
                )
                  throw fail(
                    "INVALID_ARGUMENT",
                    "Every map adoption input must match the complete frozen plan and its hashes.",
                  )
                return { adoption, receipt, publications }
              },
              catch: (error) =>
                error instanceof SkillsError
                  ? error
                  : fail(
                      "INVALID_ARGUMENT",
                      "Map adoption requires a valid frozen plan and its exact derived receipt.",
                    ),
            })
            const native = adoption.native_inputs
            const plan = native.original_plan
            const planKey = mapCheckpointAdoptionPlanKey(adoption.plan_id)
            const receiptKey = mapCheckpointAdoptionReceiptKey(adoption.plan_id)
            const mapKey = `${plan.plan_id}:subscription-map`
            const adoptionRows = yield* sql<{
              payload: string
            }>`SELECT payload FROM upstream_commands WHERE operation_id=${planKey}`
            if (canonical(yield* payload(adoptionRows[0])) !== canonical(adoption))
              return yield* Effect.fail(
                fail("UPSTREAM_PLAN_STALE", "The frozen map adoption plan changed."),
              )
            const receiptRows = yield* sql<{
              payload: string
            }>`SELECT payload FROM upstream_commands WHERE operation_id=${receiptKey}`
            if (receiptRows[0]) {
              if (canonical(yield* payload(receiptRows[0])) !== canonical(receipt))
                return yield* Effect.fail(
                  fail("STATE_CORRUPT", "Map adoption identity already has another receipt."),
                )
              const checkpointRows = yield* sql<{
                payload: string
              }>`SELECT payload FROM upstream_commands WHERE operation_id=${`${mapKey}:checkpoint`}`
              const checkpoint = yield* Effect.try({
                try: () =>
                  Schema.decodeUnknownSync(AdoptedMapCheckpointSchema)(
                    checkpointRows[0] ? JSON.parse(checkpointRows[0].payload) : undefined,
                    { onExcessProperty: "error" },
                  ),
                catch: () =>
                  fail(
                    "STATE_CORRUPT",
                    "The retained adoption receipt has no valid forward checkpoint.",
                  ),
              })
              if (checkpoint.subscription_id !== plan.subscription_id || !checkpoint.version)
                return yield* Effect.fail(
                  fail(
                    "STATE_CORRUPT",
                    "The retained adoption checkpoint has another subscription identity.",
                  ),
                )
              // The original upstream run may have advanced since this atomic commit.
              // Replaying its adoption never rolls a newer checkpoint back.
              return { reused: true }
            }
            const stale = () =>
              fail("UPSTREAM_PLAN_STALE", "Native map adoption inputs changed after planning.")
            const plans = yield* sql<{
              payload: string
              plan_id: string
              subscription_id: string
              plan_hash: string
            }>`SELECT payload,plan_id,subscription_id,plan_hash FROM upstream_plans WHERE plan_id=${plan.plan_id}`
            if (
              plans[0]?.plan_id !== plan.plan_id ||
              plans[0]?.subscription_id !== plan.subscription_id ||
              plans[0]?.plan_hash !== plan.plan_hash ||
              canonical(yield* payload(plans[0])) !== canonical(plan)
            )
              return yield* Effect.fail(stale())
            const operations = yield* sql<{
              payload: string
              operation_id: string
              plan_id: string
              state: string
            }>`SELECT payload,operation_id,plan_id,state FROM upstream_operations WHERE plan_id=${plan.plan_id}`
            if (
              operations[0]?.operation_id !== native.original_operation.operation_id ||
              operations[0]?.plan_id !== native.original_operation.plan_id ||
              operations[0]?.state !== native.original_operation.state ||
              canonical(yield* payload(operations[0])) !== canonical(native.original_operation)
            )
              return yield* Effect.fail(stale())
            const bindingRows = yield* sql<{
              payload: string
              subscription_id: string
              member_key: string
              target_key: string
              page_id: string
              generation: number
            }>`SELECT payload,subscription_id,member_key,target_key,page_id,generation FROM upstream_bindings WHERE subscription_id=${plan.subscription_id} ORDER BY member_key`
            if (bindingRows.length !== native.bindings.length) return yield* Effect.fail(stale())
            for (let index = 0; index < bindingRows.length; index++) {
              const row = bindingRows[index]!
              const expected = native.bindings[index]!
              if (
                row.subscription_id !== expected.subscription_id ||
                row.member_key !== expected.member_key ||
                row.target_key !== expected.target_key ||
                row.page_id !== expected.page_id ||
                row.generation !== expected.generation ||
                canonical(yield* payload(row)) !== canonical(expected)
              )
                return yield* Effect.fail(stale())
            }
            const targetKeys = [...new Set(plan.items.map((item) => item.target_key))].sort()
            const expectedKeys = native.targets.map((entry) => entry.target_key).sort()
            if (canonical(targetKeys) !== canonical(expectedKeys))
              return yield* Effect.fail(
                fail(
                  "INVALID_ARGUMENT",
                  "Map adoption must compare every original target claim exactly once.",
                ),
              )
            for (const target of native.targets) {
              const rows = yield* sql<{
                page_id: string
                publisher_subscription_id: string
              }>`SELECT page_id,publisher_subscription_id FROM upstream_targets WHERE target_key=${target.target_key}`
              if (canonical(rows[0] ?? null) !== canonical(target.claim))
                return yield* Effect.fail(stale())
            }
            for (const [key, expected] of [
              [mapKey, native.commands.saved],
              [`${mapKey}:intended`, native.commands.intended],
              [`${plan.plan_id}:accepted-config`, native.commands.accepted_config],
              [`${mapKey}:checkpoint`, native.commands.checkpoint],
              [`${native.original_operation.operation_id}:projections`, native.commands.projection],
            ] as const) {
              const rows = yield* sql<{
                payload: string
              }>`SELECT payload FROM upstream_commands WHERE operation_id=${key}`
              if (
                expected === null
                  ? rows.length !== 0
                  : !rows[0] || canonical(yield* payload(rows[0])) !== canonical(expected)
              )
                return yield* Effect.fail(stale())
            }
            if (
              publicationSnapshots.length !== adoption.checkpoint.published.members.length ||
              new Set(publicationSnapshots.map((entry) => entry.operation_id)).size !==
                publicationSnapshots.length ||
              new Set(publicationSnapshots.map((entry) => entry.receipt.page_id)).size !==
                publicationSnapshots.length
            )
              return yield* Effect.fail(
                fail(
                  "INVALID_ARGUMENT",
                  "Each adopted member requires one original publication snapshot.",
                ),
              )
            for (const publication of publicationSnapshots) {
              const member = adoption.checkpoint.published.members.find(
                (entry) => entry.page_id === publication.receipt.page_id,
              )
              if (
                !member ||
                publication.receipt.operation_id !== publication.operation_id ||
                publication.receipt.state !== "completed" ||
                publication.receipt.result?.verified !== true ||
                publication.receipt.result.operation_id !== publication.operation_id ||
                publication.receipt.scope !== plan.scope ||
                publication.integrity.operation_id !== publication.operation_id ||
                publication.integrity.marker.operation_id !== publication.operation_id ||
                publication.integrity.marker.intended_hash !==
                  publication.integrity.intended_hash ||
                publication.integrity.marker.state !== "committed" ||
                publication.integrity.page_id !== member.page_id
              )
                return yield* Effect.fail(
                  fail(
                    "UPSTREAM_UNVERIFIED",
                    "Map adoption requires original completed publications and committed integrity.",
                  ),
                )
              const publications = yield* sql<{
                payload: string
                id: string
                operation: string
                state: string
                scope: string | null
                page_id: string | null
              }>`SELECT payload,id,operation,state,scope,page_id FROM publications WHERE id=${publication.operation_id}`
              const integrity = yield* sql<{
                payload: string
                operation_id: string
                publication_operation_id: string
                intended_hash: string
                state: string
                page_id: string | null
              }>`SELECT payload,operation_id,publication_operation_id,intended_hash,state,page_id FROM integrity_operations WHERE operation_id=${publication.operation_id}`
              if (
                publications[0]?.id !== publication.receipt.operation_id ||
                publications[0]?.operation !== publication.receipt.operation ||
                publications[0]?.scope !== publication.receipt.scope ||
                publications[0]?.state !== "completed" ||
                publications[0]?.page_id !== member.page_id ||
                canonical(yield* payload(publications[0])) !== canonical(publication.receipt) ||
                integrity[0]?.operation_id !== publication.integrity.operation_id ||
                integrity[0]?.publication_operation_id !== publication.integrity.operation_id ||
                integrity[0]?.intended_hash !== publication.integrity.intended_hash ||
                integrity[0]?.state !== "committed" ||
                integrity[0]?.page_id !== member.page_id ||
                canonical(yield* payload(integrity[0])) !== canonical(publication.integrity)
              )
                return yield* Effect.fail(stale())
            }
            yield* sql`INSERT INTO upstream_commands ${sql.insert({ operation_id: receiptKey, payload: JSON.stringify(receipt) })}`
            yield* sql`INSERT INTO upstream_commands ${sql.insert({ operation_id: `${mapKey}:checkpoint`, payload: JSON.stringify(adoption.checkpoint) })}`
            return { reused: false }
          }),
        ),
      ),
    contentAdoptionClaims: (pageId, targetKey, originalId, oldId) =>
      run(
        sql.withTransaction(
          Effect.gen(function* () {
            const publications = yield* sql<{
              id: string
            }>`SELECT id FROM publications WHERE page_id=${pageId} OR id IN (${originalId},${oldId}) ORDER BY id`
            const integrity = yield* sql<{
              operation_id: string
            }>`SELECT operation_id FROM integrity_operations WHERE page_id=${pageId} OR operation_id IN (${originalId},${oldId}) ORDER BY operation_id`
            const intents = yield* sql<{
              count: number
            }>`SELECT COUNT(*) AS count FROM publication_intents WHERE operation_id IN (${originalId},${oldId})`
            const operations = yield* sql<{
              operation_id: string
            }>`SELECT operation_id FROM upstream_operations WHERE EXISTS (SELECT 1 FROM json_each(upstream_operations.payload,'$.items') AS member WHERE json_extract(member.value,'$.page_id')=${pageId}) ORDER BY operation_id`
            const bindings = yield* sql<{
              payload: string
            }>`SELECT payload FROM upstream_bindings WHERE page_id=${pageId} OR target_key=${targetKey} ORDER BY subscription_id,member_key`
            const targets = yield* sql<{
              target_key: string
              page_id: string
              publisher_subscription_id: string
            }>`SELECT target_key,page_id,publisher_subscription_id FROM upstream_targets WHERE page_id=${pageId} OR target_key=${targetKey} ORDER BY target_key`
            const decoded = yield* Effect.try({
              try: () => bindings.map((row) => strictJson(BindingSchema, row.payload)),
              catch: () => fail("STATE_CORRUPT", "Invalid content-adoption page or target claim."),
            })
            return {
              original_intent_count: intents[0]?.count ?? 0,
              publication_ids: publications.map((row) => row.id),
              integrity_ids: integrity.map((row) => row.operation_id),
              upstream_operation_ids: operations.map((row) => row.operation_id),
              bindings: decoded,
              targets,
            }
          }),
        ),
      ),
    command: (id) =>
      run(
        sql<{
          payload: string
        }>`SELECT payload FROM upstream_commands WHERE operation_id=${id}`.pipe(
          Effect.flatMap((rows) =>
            Effect.try({
              try: () => (rows[0] ? (JSON.parse(rows[0].payload) as unknown) : undefined),
              catch: () => fail("STATE_CORRUPT", "Invalid upstream command operation."),
            }),
          ),
        ),
      ),
    saveCommand: (id, payload) =>
      run(
        sql`INSERT INTO upstream_commands ${sql.insert({ operation_id: id, payload: JSON.stringify(payload) })} ON CONFLICT(operation_id) DO UPDATE SET payload=excluded.payload WHERE json_extract(excluded.payload,'$.phase') IS NOT 'preparing' OR (json_extract(upstream_commands.payload,'$.intent') IS NULL AND json_extract(upstream_commands.payload,'$.state') IS NOT 'verified')`.pipe(
          Effect.asVoid,
        ),
      ),
    sourceRichTextRepairClaims: (pageId, targetKey) =>
      run(
        Effect.gen(function* () {
          const rows = yield* sql<{
            operation_id: string
            payload: string
          }>`SELECT operation_id,payload FROM upstream_commands WHERE operation_id LIKE 'source-rich-text-repair:member:%' AND (json_extract(payload,'$.plan.input.page_id')=${pageId} OR json_extract(payload,'$.plan.target_key')=${targetKey}) ORDER BY operation_id`
          return yield* Effect.forEach(rows, (row) =>
            payload(row).pipe(Effect.map((value) => ({ operation_id: row.operation_id, value }))),
          )
        }),
      ),
    sourceRootCompletionClaims: (pageId, targetKey) =>
      run(
        Effect.gen(function* () {
          const rows = yield* sql<{
            operation_id: string
            payload: string
          }>`SELECT operation_id,payload FROM upstream_commands WHERE operation_id LIKE 'source-root-completion:member:%' AND (json_extract(payload,'$.plan.input.page_id')=${pageId} OR json_extract(payload,'$.plan.target_key')=${targetKey}) ORDER BY operation_id`
          return yield* Effect.forEach(rows, (row) =>
            payload(row).pipe(Effect.map((value) => ({ operation_id: row.operation_id, value }))),
          )
        }),
      ),
    sourceRootFidelityClaims: (pageId, targetKey) =>
      run(
        Effect.gen(function* () {
          const rows = yield* sql<{
            operation_id: string
            payload: string
          }>`SELECT operation_id,payload FROM upstream_commands WHERE operation_id LIKE 'source-root-fidelity:member:%' AND (json_extract(payload,'$.plan.page_id')=${pageId} OR json_extract(payload,'$.plan.target_key')=${targetKey}) ORDER BY operation_id`
          return yield* Effect.forEach(rows, (row) =>
            payload(row).pipe(Effect.map((value) => ({ operation_id: row.operation_id, value }))),
          )
        }),
      ),
    contentAdoptionPlanClaims: (pageId, targetKey) =>
      run(
        Effect.gen(function* () {
          const rows = yield* sql<{
            operation_id: string
          }>`SELECT operation_id FROM upstream_commands WHERE operation_id LIKE 'content-adoption:plan:%' AND (json_extract(payload,'$.plan.page_id')=${pageId} OR json_extract(payload, '$.plan.original_plan.items[' || json_extract(payload,'$.plan.item_index') || '].target_key')=${targetKey}) ORDER BY operation_id`
          return rows.map((row) => row.operation_id)
        }),
      ),
    createCommand: (id, payload) =>
      run(
        Effect.gen(function* () {
          const rows = yield* sql<{
            operation_id: string
          }>`INSERT INTO upstream_commands ${sql.insert({ operation_id: id, payload: JSON.stringify(payload) })} ON CONFLICT(operation_id) DO NOTHING RETURNING operation_id`
          if (rows.length !== 1)
            return yield* Effect.fail(
              fail(
                "UPSTREAM_OPERATION_BUSY",
                "A durable command already claims this identity; load and reconcile its exact retained plan.",
              ),
            )
        }),
      ),
    claimCommand: (id, expected, payload, guard) =>
      run(
        Effect.gen(function* () {
          const current = yield* sql<{
            payload: string
          }>`SELECT payload FROM upstream_commands WHERE operation_id=${id}`
          const canonical = (value: unknown): string =>
            JSON.stringify(value, (_key, item) =>
              item && typeof item === "object" && !Array.isArray(item)
                ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
                : item,
            )
          if (!current[0] || canonical(JSON.parse(current[0].payload)) !== canonical(expected))
            return yield* Effect.fail(
              fail(
                "UPSTREAM_OPERATION_BUSY",
                "The exact command intent was already claimed or changed; reconcile its saved evidence.",
              ),
            )
          let guardedPayload: string | undefined
          if (guard !== undefined) {
            const guarded = yield* sql<{
              payload: string
            }>`SELECT payload FROM upstream_commands WHERE operation_id=${guard.operation_id}`
            if (
              guard.operation_id === id ||
              !guarded[0] ||
              canonical(JSON.parse(guarded[0].payload)) !== canonical(guard.expected)
            )
              return yield* Effect.fail(
                fail(
                  "UPSTREAM_OPERATION_BUSY",
                  "The exact retained parent command changed before the child claim.",
                ),
              )
            guardedPayload = guarded[0].payload
          }
          // The same UPDATE checks both raw payloads. It advances only the
          // child row; the acknowledged parent is never rewritten or relabelled.
          const fidelity = id.startsWith("source-root-fidelity:member:")
          const memberSuffix = id.slice("source-root-fidelity:member:".length)
          if (
            fidelity &&
            guard !== undefined &&
            guard.operation_id !== `source-root-completion:member:${memberSuffix}`
          )
            return yield* Effect.fail(
              fail(
                "UPSTREAM_OPERATION_BUSY",
                "A fidelity child must guard its exact original completion row.",
              ),
            )
          const adoptionMember = `content-adoption:member:${memberSuffix}`
          const frozen = property(property(JSON.parse(current[0].payload)).plan)
          const pageId = typeof frozen.page_id === "string" ? frozen.page_id : ""
          const targetKey = typeof frozen.target_key === "string" ? frozen.target_key : ""
          if (fidelity && guard !== undefined && (!pageId || !targetKey))
            return yield* Effect.fail(
              fail(
                "UPSTREAM_OPERATION_BUSY",
                "A fidelity child lacks its retained page and target identity.",
              ),
            )
          const rows =
            fidelity && guard !== undefined && guardedPayload !== undefined
              ? yield* sql<{ operation_id: string }>`
              UPDATE upstream_commands SET payload=${JSON.stringify(payload)}
              WHERE operation_id=${id} AND payload=${current[0].payload}
                AND EXISTS (SELECT 1 FROM upstream_commands AS parent
                  WHERE parent.operation_id=${guard.operation_id} AND parent.payload=${guardedPayload})
                AND NOT EXISTS (
                  SELECT 1 FROM upstream_commands AS claim WHERE claim.operation_id=${adoptionMember}
                  OR (claim.operation_id LIKE 'source-root-completion:member:%' AND claim.operation_id<>${guard.operation_id}
                    AND (json_extract(claim.payload,'$.plan.input.page_id')=${pageId}
                      OR json_extract(claim.payload,'$.plan.target_key')=${targetKey}))
                  OR (claim.operation_id LIKE 'source-root-fidelity:member:%' AND claim.operation_id<>${id}
                    AND (json_extract(claim.payload,'$.plan.page_id')=${pageId}
                      OR json_extract(claim.payload,'$.plan.target_key')=${targetKey}))
                  OR (claim.operation_id LIKE 'source-rich-text-repair:member:%'
                    AND (json_extract(claim.payload,'$.plan.input.page_id')=${pageId}
                      OR json_extract(claim.payload,'$.plan.target_key')=${targetKey}))
                  OR (claim.operation_id LIKE 'content-adoption:plan:%'
                    AND (json_extract(claim.payload,'$.plan.page_id')=${pageId}
                      OR json_extract(claim.payload,'$.plan.original_plan.items[' || json_extract(claim.payload,'$.plan.item_index') || '].target_key')=${targetKey}))
                ) RETURNING operation_id`
              : guard !== undefined && guardedPayload !== undefined
                ? yield* sql<{
                    operation_id: string
                  }>`UPDATE upstream_commands SET payload=${JSON.stringify(payload)} WHERE operation_id=${id} AND payload=${current[0].payload} AND EXISTS (SELECT 1 FROM upstream_commands AS parent WHERE parent.operation_id=${guard.operation_id} AND parent.payload=${guardedPayload}) RETURNING operation_id`
                : yield* sql<{
                    operation_id: string
                  }>`UPDATE upstream_commands SET payload=${JSON.stringify(payload)} WHERE operation_id=${id} AND payload=${current[0].payload} RETURNING operation_id`
          if (rows.length !== 1)
            return yield* Effect.fail(
              fail(
                "UPSTREAM_OPERATION_BUSY",
                "The exact command intent was already claimed or changed; reconcile its saved evidence.",
              ),
            )
        }),
      ),
    savePlan: (plan) =>
      run(
        sql`INSERT INTO upstream_plans ${sql.insert({ plan_id: plan.plan_id, subscription_id: plan.subscription_id, plan_hash: plan.plan_hash, payload: JSON.stringify(plan) })}`.pipe(
          Effect.asVoid,
        ),
      ),
    plan: (id) =>
      run(
        sql<{ payload: string }>`SELECT payload FROM upstream_plans WHERE plan_id=${id}`.pipe(
          Effect.flatMap((rows) =>
            Effect.try({
              try: () => (rows[0] ? strictJson(UpstreamPlanSchema, rows[0].payload) : undefined),
              catch: () => fail("STATE_CORRUPT", "Invalid frozen upstream plan."),
            }),
          ),
        ),
      ),
    bindings: (id) =>
      run(
        sql<{
          payload: string
        }>`SELECT payload FROM upstream_bindings WHERE subscription_id=${id} ORDER BY member_key`.pipe(
          Effect.flatMap((rows) =>
            Effect.try({
              try: () => rows.map((row) => strictJson(BindingSchema, row.payload)),
              catch: () => fail("STATE_CORRUPT", "Invalid upstream baseline."),
            }),
          ),
        ),
      ),
    target: (key) =>
      run(
        sql<{
          page_id: string
          publisher_subscription_id: string
        }>`SELECT page_id,publisher_subscription_id FROM upstream_targets WHERE target_key=${key}`.pipe(
          Effect.map((rows) => rows[0]),
        ),
      ),
    operation: (id) =>
      run(
        sql<{ payload: string }>`SELECT payload FROM upstream_operations WHERE plan_id=${id}`.pipe(
          Effect.flatMap((rows) =>
            Effect.try({
              try: () =>
                rows[0] ? strictJson(UpstreamOperationSchema, rows[0].payload) : undefined,
              catch: () => fail("STATE_CORRUPT", "Invalid upstream operation."),
            }),
          ),
        ),
      ),
    operations: (id) =>
      run(
        sql<{
          payload: string
        }>`SELECT payload FROM upstream_operations WHERE json_extract(payload,'$.subscription_id')=${id} ORDER BY operation_id`.pipe(
          Effect.flatMap((rows) =>
            Effect.try({
              try: () => rows.map((row) => strictJson(UpstreamOperationSchema, row.payload)),
              catch: () => fail("STATE_CORRUPT", "Invalid upstream operation history."),
            }),
          ),
        ),
      ),
    hasScopedHistory: () =>
      run(
        sql<{
          present: number
        }>`SELECT EXISTS(SELECT 1 FROM upstream_operations WHERE json_extract(payload,'$.scope') IS NOT NULL UNION ALL SELECT 1 FROM upstream_commands WHERE json_extract(payload,'$.scope') IS NOT NULL AND json_extract(payload,'$.domain') IN ('subscription_add','subscription_update','subscription_remove','upstream_fork','upstream_track')) AS present`.pipe(
          Effect.map((rows) => rows[0]?.present === 1),
        ),
      ),
    scopedOperations: (scope, databaseId) =>
      run(
        sql<{
          payload: string
        }>`SELECT payload FROM upstream_operations WHERE json_extract(payload,'$.scope')=${scope} AND (${databaseId ?? null} IS NULL OR json_extract(payload,'$.database_id')=${databaseId ?? null}) ORDER BY operation_id`.pipe(
          Effect.flatMap((rows) =>
            Effect.try({
              try: () => rows.map((row) => strictJson(UpstreamOperationSchema, row.payload)),
              catch: () => fail("STATE_CORRUPT", "Invalid scoped upstream operation history."),
            }),
          ),
        ),
      ),
    scopedCommands: (scope, databaseId) =>
      run(
        sql<{
          payload: string
        }>`SELECT payload FROM upstream_commands WHERE json_extract(payload,'$.scope')=${scope} AND (${databaseId ?? null} IS NULL OR json_extract(payload,'$.database_id')=${databaseId ?? null}) AND json_extract(payload,'$.domain') IN ('subscription_add','subscription_update','subscription_remove','upstream_fork','upstream_track') ORDER BY operation_id`.pipe(
          Effect.flatMap((rows) =>
            Effect.try({
              try: () => rows.map((row) => strictJson(UpstreamCommandOperationSchema, row.payload)),
              catch: () => fail("STATE_CORRUPT", "Invalid scoped upstream command history."),
            }),
          ),
        ),
      ),
    saveOperation,
    replacePublicationPointer: (expected, itemIndex, expectedBinding, publicationId, pageId) =>
      run(
        sql.withTransaction(
          Effect.gen(function* () {
            const canonical = (value: unknown): string =>
              JSON.stringify(value, (_key, item) =>
                item && typeof item === "object" && !Array.isArray(item)
                  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
                  : item,
              )
            const current = yield* sql<{
              payload: string
            }>`SELECT payload FROM upstream_operations WHERE operation_id=${expected.operation_id}`
            const item = expected.items[itemIndex]
            if (
              !current[0] ||
              canonical(JSON.parse(current[0].payload)) !== canonical(expected) ||
              !item ||
              !["unknown", "running", "failed", "pending"].includes(item.status)
            )
              return yield* Effect.fail(
                fail("UPSTREAM_PLAN_STALE", "The exact original publication pointer changed."),
              )
            const bindings = yield* sql<{
              payload: string
            }>`SELECT payload FROM upstream_bindings WHERE subscription_id=${expected.subscription_id} AND member_key=${item.member_key}`
            if (
              (bindings[0] ? canonical(JSON.parse(bindings[0].payload)) : undefined) !==
                (expectedBinding ? canonical(expectedBinding) : undefined) ||
              (item.page_id && item.page_id !== pageId) ||
              (expectedBinding && expectedBinding.page_id !== pageId)
            )
              return yield* Effect.fail(
                fail(
                  "UPSTREAM_PLAN_STALE",
                  "The original member mapping generation or page changed.",
                ),
              )
            const receipt = yield* sql<{
              state: string
              page_id: string | null
            }>`SELECT state,page_id FROM publications WHERE id=${publicationId}`
            const integrity = yield* sql<{
              state: string
              page_id: string | null
            }>`SELECT state,page_id FROM integrity_operations WHERE operation_id=${publicationId}`
            if (
              receipt[0]?.state !== "completed" ||
              receipt[0].page_id !== pageId ||
              integrity[0]?.state !== "committed" ||
              integrity[0].page_id !== pageId
            )
              return yield* Effect.fail(
                fail(
                  "UPSTREAM_UNVERIFIED",
                  "Only a fully committed replacement publication can replace an unresolved pointer.",
                ),
              )
            const replacement = {
              ...expected,
              items: expected.items.map((entry, index) =>
                index === itemIndex
                  ? { ...entry, publication_operation_id: publicationId, page_id: pageId }
                  : entry,
              ),
            }
            const rows = yield* sql<{
              operation_id: string
            }>`UPDATE upstream_operations SET payload=${JSON.stringify(replacement)} WHERE operation_id=${expected.operation_id} AND payload=${current[0].payload} RETURNING operation_id`
            if (rows.length !== 1)
              return yield* Effect.fail(
                fail(
                  "UPSTREAM_PLAN_STALE",
                  "The original publication pointer lost its version comparison.",
                ),
              )
          }),
        ),
      ),
    advance: (binding, expected, publisher, operation) =>
      run(
        sql.withTransaction(
          Effect.gen(function* () {
            if (
              !operation.items.some(
                (item) =>
                  item.member_key === binding.member_key &&
                  (item.status === "verified" || item.status === "retained"),
              )
            )
              return yield* Effect.fail(
                fail("UPSTREAM_UNVERIFIED", "Only a verified member can advance its baseline."),
              )
            const targets = yield* sql<{
              page_id: string
              publisher_subscription_id: string
            }>`SELECT page_id,publisher_subscription_id FROM upstream_targets WHERE target_key=${binding.target_key}`
            if (
              targets[0] &&
              (targets[0].page_id !== binding.page_id ||
                targets[0].publisher_subscription_id !== publisher)
            )
              return yield* Effect.fail(
                fail(
                  "UPSTREAM_TARGET_CONFLICT",
                  "Shared target already has another publication authority.",
                ),
              )
            yield* sql`INSERT INTO upstream_targets ${sql.insert({ target_key: binding.target_key, page_id: binding.page_id, publisher_subscription_id: publisher })} ON CONFLICT(target_key) DO NOTHING`
            yield* writeBinding(binding, expected)
            if (
              binding.active &&
              operation.items.some(
                (item) => item.member_key === binding.member_key && item.status === "verified",
              )
            )
              yield* sql`INSERT INTO upstream_commands ${sql.insert({ operation_id: `materialized:${binding.target_key}`, payload: JSON.stringify({ portable: binding.materialized, content_hash: binding.published_hash, revision: binding.revision }) })} ON CONFLICT(operation_id) DO UPDATE SET payload=excluded.payload`
            yield* saveOperation(operation)
          }),
        ),
      ),
    setMode: (binding, expected) => run(sql.withTransaction(writeBinding(binding, expected))),
    commitRebuild: (
      binding,
      expectedBinding,
      expectedTarget,
      publisher,
      publicationId,
      ownerMemberKey,
    ) =>
      run(
        sql.withTransaction(
          Effect.gen(function* () {
            const currentBinding = yield* sql<{
              payload: string
            }>`SELECT payload FROM upstream_bindings WHERE subscription_id=${binding.subscription_id} AND member_key=${binding.member_key}`
            const currentTarget = yield* sql<{
              page_id: string
              publisher_subscription_id: string
            }>`SELECT page_id,publisher_subscription_id FROM upstream_targets WHERE target_key=${binding.target_key}`
            const observedBinding = currentBinding[0]
              ? strictJson(BindingSchema, currentBinding[0].payload)
              : undefined
            const observedTarget = currentTarget[0]
            const already =
              canonical(observedBinding) === canonical(binding) &&
              canonical(observedTarget) ===
                canonical({ page_id: binding.page_id, publisher_subscription_id: publisher })
            if (
              !already &&
              (canonical(observedBinding) !== canonical(expectedBinding) ||
                canonical(observedTarget) !== canonical(expectedTarget))
            )
              return yield* Effect.fail(
                fail("UPSTREAM_PLAN_STALE", "The accepted member baseline changed."),
              )
            const publication = yield* sql<{
              payload: string
              state: string
              page_id: string | null
            }>`SELECT payload,state,page_id FROM publications WHERE id=${publicationId}`
            const integrity = yield* sql<{
              payload: string
              state: string
              page_id: string | null
            }>`SELECT payload,state,page_id FROM integrity_operations WHERE operation_id=${publicationId}`
            const receipt = publication[0]
              ? strictJson(PublicationReceiptSchema, publication[0].payload)
              : undefined
            const committed = integrity[0]
              ? strictJson(IntegrityIntentSchema, integrity[0].payload)
              : undefined
            const ownership = receipt?.context?.ownership
            const source = receipt?.context?.source_intent
            const publishedFiles = new Map(
              binding.materialized.files.map((file) => [file.path, file.hash]),
            )
            const receiptFiles = new Map(
              receipt?.portable.files.map((file) => [file.path, file.sha256]) ?? [],
            )
            const filesMatch =
              receipt?.portable.kind === binding.materialized.kind &&
              receipt.portable.name === binding.materialized.name &&
              receipt.portable.description === binding.materialized.description &&
              receipt?.portable.main === binding.materialized.main &&
              receiptFiles.size === publishedFiles.size &&
              [...publishedFiles].every(([path, hash]) => receiptFiles.get(path) === hash)
            if (
              publication[0]?.state !== "completed" ||
              publication[0].page_id !== binding.page_id ||
              receipt?.state !== "completed" ||
              receipt.page_id !== binding.page_id ||
              receipt.operation_id !== publicationId ||
              source?.mode !== "set" ||
              source.value.type !== "upstream" ||
              !filesMatch ||
              ownership?.subscription_id !== publisher ||
              ownership.subscription_id !== binding.subscription_id ||
              ownership.member_key !== ownerMemberKey ||
              ownership.mode !== binding.mode ||
              ownership.published_hash !== binding.published_hash ||
              ownership.revision !== binding.revision ||
              canonical(ownership.fork_baseline) !== canonical(binding.fork_baseline) ||
              integrity[0]?.state !== "committed" ||
              integrity[0].page_id !== binding.page_id ||
              committed?.page_id !== binding.page_id ||
              committed.operation_id !== publicationId ||
              committed.marker.state !== "committed" ||
              committed.marker.operation_id !== publicationId ||
              committed.marker.intended_hash !== committed.intended_hash
            )
              return yield* Effect.fail(
                fail(
                  "UPSTREAM_UNVERIFIED",
                  "Only the completed upstream publication and committed integrity can replace this member.",
                ),
              )
            if (already) return
            if (
              (expectedBinding?.generation ?? 0) + 1 !== binding.generation ||
              (expectedTarget !== undefined &&
                expectedTarget.publisher_subscription_id !== publisher)
            )
              return yield* Effect.fail(
                fail("UPSTREAM_PLAN_STALE", "The rebuild generation or publisher changed."),
              )
            if (
              observedTarget &&
              (observedTarget.page_id !== binding.page_id ||
                observedTarget.publisher_subscription_id !== publisher)
            ) {
              const replaced = yield* sql<{
                target_key: string
              }>`UPDATE upstream_targets SET page_id=${binding.page_id},publisher_subscription_id=${publisher} WHERE target_key=${binding.target_key} AND page_id=${expectedTarget?.page_id ?? null} AND publisher_subscription_id=${expectedTarget?.publisher_subscription_id ?? null} RETURNING target_key`
              if (replaced.length !== 1)
                return yield* Effect.fail(
                  fail(
                    "UPSTREAM_TARGET_CONFLICT",
                    "Shared target already has another publication authority.",
                  ),
                )
            } else
              yield* sql`INSERT INTO upstream_targets ${sql.insert({ target_key: binding.target_key, page_id: binding.page_id, publisher_subscription_id: publisher })} ON CONFLICT(target_key) DO NOTHING`
            yield* writeBinding(binding, expectedBinding?.generation ?? 0)
            yield* sql`INSERT INTO upstream_commands ${sql.insert({ operation_id: `materialized:${binding.target_key}`, payload: JSON.stringify({ portable: binding.materialized, content_hash: binding.published_hash, revision: binding.revision }) })} ON CONFLICT(operation_id) DO UPDATE SET payload=excluded.payload`
          }),
        ),
      ),
  }
}
