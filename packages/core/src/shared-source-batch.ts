import { Clock, Crypto, Effect, Schema } from "effect"
import { fail } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { discoverSourceDefinition } from "./shared-source-adapters.ts"
import {
  listSourceMembers,
  readSourceDefinition,
  sourceChecked,
  sourceTable,
} from "./shared-source-definitions.ts"
import {
  applySourceRefresh,
  MemberReviewSchema,
  prepareSourceRefreshFromSnapshot,
  reconcileSourceRefresh,
  reviewSourceMembers,
  SourceRefreshPlanSchema,
  validateSourceRefresh,
  type SourceRefreshStorage,
} from "./shared-source-refresh.ts"
import { sha256, Store } from "./store.ts"

const MembershipSchema = Schema.Struct({
  page_id: Schema.String,
  skill_id: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  enabled: Schema.Boolean,
  member: Schema.String,
  selected_version: Schema.String,
})
export const SourceRefreshBatchSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("source_refresh_batch"),
  plan_id: Schema.String,
  library_id: Schema.String,
  sources_data_source_id: Schema.String,
  source_id: Schema.String,
  source_page_id: Schema.String,
  source_fingerprint: Schema.String,
  provider_revision: Schema.String,
  provider_committed_at: Schema.optional(Schema.String),
  created_at: Schema.Number,
  membership: Schema.Array(MembershipSchema),
  member_review: MemberReviewSchema,
  plans: Schema.Array(SourceRefreshPlanSchema),
})
export type SourceRefreshBatch = typeof SourceRefreshBatchSchema.Type

const eligible = (item: typeof MembershipSchema.Type) => item.kind === "skill" && item.enabled
const orderedMembership = (items: readonly (typeof MembershipSchema.Type)[]) =>
  [...items].sort((a, b) => a.page_id.localeCompare(b.page_id))

/** A complete candidate shares one provider observation; it never publishes a partial set. */
export function prepareSourceRefreshBatch(
  library: SharedLibrary,
  source: string,
  acquire: typeof discoverSourceDefinition = discoverSourceDefinition,
  storage: SourceRefreshStorage = "auto",
) {
  return Effect.gen(function* () {
    const definition = yield* readSourceDefinition(library, source)
    if (!definition.enabled || definition.options.shared_target_set !== undefined)
      return yield* Effect.fail(
        fail("SOURCE_BATCH_UNAVAILABLE", "Choose an enabled single-origin Source definition."),
      )
    const membership = yield* listSourceMembers(library, definition.page_id)
    const targets = orderedMembership(membership.items).filter(eligible)
    if (targets.length === 0 || targets.some((item) => !item.member))
      return yield* Effect.fail(
        fail("SOURCE_BATCH_EMPTY", "Every selected enabled Skill needs an exact Source Member."),
      )
    const acquired = yield* acquire(definition, { metrics: (yield* Notion).metrics })
    if (!acquired.revision || (acquired.unavailable?.length ?? 0) !== 0)
      return yield* Effect.fail(
        fail("SOURCE_BATCH_INCOMPLETE", "The provider observation has unresolved resources."),
      )
    const memberReview = yield* reviewSourceMembers(
      library,
      definition.page_id,
      acquired,
      membership,
    )
    const plans = yield* Effect.forEach(targets, (target) =>
      prepareSourceRefreshFromSnapshot(library, {
        definition,
        acquired,
        memberReview,
        target: target.page_id,
        storage,
      }),
    )
    const latest = yield* readSourceDefinition(library, definition.page_id)
    const latestMembership = yield* listSourceMembers(library, definition.page_id)
    if (
      latest.fingerprint !== definition.fingerprint ||
      canonicalSharedJson(orderedMembership(latestMembership.items)) !==
        canonicalSharedJson(orderedMembership(membership.items))
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_BATCH_CHANGED",
          "Source configuration or complete Origin membership changed during preparation.",
        ),
      )
    const contents = {
      version: 1 as const,
      kind: "source_refresh_batch" as const,
      library_id: library.library_id,
      sources_data_source_id: sourceTable(library).data_source_id,
      source_id: definition.source_id,
      source_page_id: definition.page_id,
      source_fingerprint: definition.fingerprint,
      provider_revision: acquired.revision,
      ...(acquired.provenance.committed_at === undefined
        ? {}
        : { provider_committed_at: acquired.provenance.committed_at }),
      created_at: yield* Clock.currentTimeMillis,
      membership: orderedMembership(membership.items),
      member_review: memberReview,
      plans,
    }
    return {
      ...contents,
      plan_id: `source-batch-${yield* sha256(canonicalSharedJson(contents))}`,
    } satisfies SourceRefreshBatch
  }).pipe(withReadOnlyNotion)
}

/** Verify every frozen member before the first dispatch of any member. */
export function validateSourceRefreshBatch(library: SharedLibrary, input: unknown) {
  return Effect.gen(function* () {
    const batch = yield* sourceChecked(() =>
      Schema.decodeUnknownSync(SourceRefreshBatchSchema)(input, { onExcessProperty: "error" }),
    )
    const { plan_id, ...contents } = batch
    const targets = batch.membership.filter(eligible)
    if (
      batch.library_id !== library.library_id ||
      batch.sources_data_source_id !== sourceTable(library).data_source_id ||
      !Number.isSafeInteger(batch.created_at) ||
      batch.created_at < 0 ||
      batch.plans.length === 0 ||
      targets.length !== batch.plans.length ||
      new Set(batch.membership.map((item) => item.page_id)).size !== batch.membership.length ||
      new Set(batch.membership.map((item) => item.skill_id)).size !== batch.membership.length ||
      plan_id !== `source-batch-${yield* sha256(canonicalSharedJson(contents))}`
    )
      return yield* Effect.fail(fail("SOURCE_BATCH_INVALID", "Frozen batch identity differs."))
    const seen = new Set<string>()
    for (const item of batch.plans) {
      const { plan } = yield* validateSourceRefresh(library, item)
      const target = targets.find((row) => row.page_id === plan.target_page_id)
      if (
        !target ||
        seen.has(plan.target_page_id) ||
        plan.source_id !== batch.source_id ||
        plan.source_page_id !== batch.source_page_id ||
        plan.source_fingerprint !== batch.source_fingerprint ||
        plan.provider_revision !== batch.provider_revision ||
        plan.provider_committed_at !== batch.provider_committed_at ||
        plan.member !== target.member ||
        plan.previous_pin !== target.selected_version ||
        canonicalSharedJson(plan.member_review) !== canonicalSharedJson(batch.member_review)
      )
        return yield* Effect.fail(
          fail("SOURCE_BATCH_INVALID", "A member differs from the frozen complete Source batch."),
        )
      seen.add(plan.target_page_id)
    }
    return batch
  })
}

type MemberIdentity = { target_page_id: string; member: string; plan_id: string }
type MemberOutcome = MemberIdentity &
  (
    | { outcome: "confirmed" | "planned" | "observed" | "unresolved"; result: unknown }
    | { outcome: "failed" | "unknown"; error: { code: string; message: string; details?: unknown } }
  )
const unknownCodes = new Set([
  "WRITE_OUTCOME_UNKNOWN",
  "SHARED_RECORD_UNRESOLVED",
  "SHARED_METADATA_WRITE_UNRESOLVED",
  "SOURCE_SELECTION_UNRESOLVED",
])

/** Each member retains its original journal. There is no distributed or multi-page atomic commit. */
export function runSourceRefreshBatch(
  library: SharedLibrary,
  input: unknown,
  options: { readonly mode: "apply" | "reconcile"; readonly dryRun?: boolean },
) {
  const run = Effect.gen(function* () {
    const batch = yield* validateSourceRefreshBatch(library, input)
    const store = yield* Store
    const scope = yield* sha256(
      canonicalSharedJson([yield* (yield* Notion).credentialIdentity, library.library_id]),
    )
    const runId = yield* (yield* Crypto.Crypto)
      .randomUUIDv4()
      .pipe(Effect.mapError(() => fail("CRYPTO_ERROR", "Cannot identify this batch result.")))
    const key = `operations/shared-source-batches/${scope}/${batch.plan_id}/${runId}.json`
    const startedAt = yield* Clock.currentTimeMillis
    const items: MemberOutcome[] = []
    const checkpoint = (complete: boolean, active?: string) =>
      store.writeJson(key, {
        version: 1,
        kind: "source_batch_result",
        plan_id: batch.plan_id,
        run_id: runId,
        mode: options.mode,
        dry_run: options.dryRun ?? false,
        started_at: startedAt,
        execution_complete: complete,
        items: [...items],
        in_progress: active === undefined ? null : { plan_id: active, dispatch: "unobserved" },
        not_dispatched: batch.plans
          .slice(items.length + (active === undefined ? 0 : 1))
          .map((plan) => plan.plan_id),
      })
    yield* checkpoint(false)
    for (const plan of batch.plans) {
      yield* checkpoint(false, plan.plan_id)
      const identity = {
        target_page_id: plan.target_page_id,
        member: plan.member,
        plan_id: plan.plan_id,
      }
      const action =
        options.mode === "reconcile"
          ? reconcileSourceRefresh(library, plan).pipe(
              Effect.map((result): MemberOutcome => ({ ...identity, outcome: "observed", result })),
            )
          : applySourceRefresh(library, plan, options.dryRun ?? false, false).pipe(
              Effect.map(
                (result): MemberOutcome => ({
                  ...identity,
                  outcome:
                    options.dryRun === true
                      ? "planned"
                      : "verified" in result && result.verified === true
                        ? "confirmed"
                        : "unresolved",
                  result,
                }),
              ),
            )
      const result = yield* action.pipe(Effect.result)
      items.push(
        result._tag === "Success"
          ? result.success
          : {
              ...identity,
              outcome: unknownCodes.has(result.failure.code) ? "unknown" : "failed",
              error: {
                code: result.failure.code,
                message: result.failure.message,
                ...(result.failure.details === undefined
                  ? {}
                  : { details: result.failure.details }),
              },
            },
      )
      yield* checkpoint(false)
    }
    yield* checkpoint(true)
    const confirmed = items.filter((item) => item.outcome === "confirmed").length
    const failed = items.filter((item) => item.outcome === "failed").length
    const unknown = items.filter((item) => ["unknown", "unresolved"].includes(item.outcome)).length
    return {
      plan_id: batch.plan_id,
      run_id: runId,
      result_key: key,
      mode: options.mode,
      dry_run: options.dryRun ?? false,
      status:
        failed || unknown
          ? "partial"
          : options.mode === "reconcile"
            ? "observed"
            : options.dryRun
              ? "planned"
              : "applied",
      execution_complete: true,
      all_members_confirmed: confirmed === items.length,
      atomic: false,
      provider_revision: batch.provider_revision,
      counts: { total: items.length, confirmed, failed, unknown },
      items,
      source_status_updated: false,
      projection_writeback: false,
      ...(options.mode === "reconcile" || options.dryRun ? { remote_writes: 0 } : {}),
    }
  })
  return options.mode === "reconcile" || options.dryRun ? run.pipe(withReadOnlyNotion) : run
}
