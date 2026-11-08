import { Clock, Crypto, Effect, Schema } from "effect"
import { HttpClient } from "effect/http"
import { fail, SnapshotSchema, type SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { makeRequestBudget, RequestBudget, type RequestBudgetLimits } from "./request-budget.ts"
import { requestBudgetHttpClient } from "./request-budget-http.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import { discoverSourceDefinition } from "./shared-source-adapters.ts"
import { listSourceMembers, readSourceDefinition } from "./shared-source-definitions.ts"
import { prepareSourceRefreshBatch, SourceRefreshBatchSchema } from "./shared-source-batch.ts"
import {
  applySourceRefresh,
  prepareSourceRefresh,
  reviewSourceMembers,
  SourceRefreshPlanSchema,
  type SourceRefreshPlan,
  type SourceRefreshStorage,
} from "./shared-source-refresh.ts"
import {
  publishSourceCheck,
  sourceRunDecision,
  withSourceUpdateLock,
  type SourceRunMode,
} from "./shared-source-policy.ts"
import { Store } from "./store.ts"

const FrozenPlanSchema = Schema.Union([SourceRefreshPlanSchema, SourceRefreshBatchSchema])
const RunErrorSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
})
const ApplicationSchema = Schema.Struct({
  target_page_id: Schema.String,
  plan_id: Schema.String,
  status: Schema.Literals(["confirmed", "blocked", "unknown", "failed"]),
  details: Schema.Unknown,
})
export const SourceUpdateRunSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("source_update_run"),
  run_id: Schema.String,
  entry: Schema.String,
  source: Schema.String,
  library_id: Schema.NullOr(Schema.String),
  source_page_id: Schema.NullOr(Schema.String),
  source_fingerprint: Schema.NullOr(Schema.String),
  mode: Schema.Literals(["check", "prepare", "policy"]),
  scope: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("all_bound") }),
    Schema.Struct({ kind: Schema.Literal("skill"), target: Schema.String }),
  ]),
  execution: Schema.Literals(["running", "completed", "paused", "failed"]),
  phase: Schema.Literals([
    "resolving",
    "checking",
    "prepared",
    "applying",
    "requests",
    "completed",
  ]),
  started_at: Schema.Number,
  updated_at: Schema.Number,
  decision: Schema.Unknown,
  check: Schema.Union([
    Schema.Struct({ status: Schema.Literal("not_started") }),
    Schema.Struct({
      status: Schema.Literal("completed"),
      revision: Schema.String,
      committed_at: Schema.NullOr(Schema.String),
      checked_at: Schema.Number,
      member_review: Schema.Unknown,
    }),
  ]),
  plan: Schema.NullOr(FrozenPlanSchema),
  application: Schema.Array(ApplicationSchema),
  request_results: Schema.Array(Schema.Unknown),
  source_feedback: Schema.Unknown,
  error: Schema.NullOr(RunErrorSchema),
  budget: Schema.Unknown,
  deployment: Schema.Literal(
    "one_writer_per_shared_library; local_fence_requires_the_same_state_root",
  ),
  git_budget: Schema.Literal(
    "child_process_timeout_and_invocation_deadline; git_protocol_bytes_are_not_http_budget_bytes",
  ),
  original_operations: Schema.Literal(
    "retain_frozen_plan_and_reconcile; unknown_dispatches_are_not_replayed",
  ),
})
export type SourceUpdateRun = typeof SourceUpdateRunSchema.Type
export type SourceUpdateInput = {
  readonly entry: string
  readonly source: string
  readonly scope:
    | { readonly kind: "all_bound" }
    | { readonly kind: "skill"; readonly target: string }
  readonly mode?: SourceRunMode
  readonly dueOnly?: boolean
  readonly storage?: SourceRefreshStorage
  readonly output?: string
  readonly budget?: Partial<RequestBudgetLimits>
}
const unknownCodes = new Set([
  "WRITE_OUTCOME_UNKNOWN",
  "SHARED_RECORD_UNRESOLVED",
  "SHARED_METADATA_WRITE_UNRESOLVED",
  "SOURCE_SELECTION_UNRESOLVED",
  "SOURCE_WRITE_UNKNOWN",
  "SOURCE_WRITE_PENDING",
])
const errorDetails = (error: SkillsError) => ({
  code: error.code,
  message: error.message,
  ...(error.details === undefined ? {} : { details: error.details }),
})
const runKey = (runId: string) => `operations/shared-source-runs/${runId}.json`

/** Readable native projections need a proven overwrite primitive before auto refresh. */
export function automaticSourceStops(plan: SourceRefreshPlan) {
  return Effect.gen(function* () {
    const snapshot = yield* (yield* Store).readJson(
      `snapshots/${plan.current_snapshot}.json`,
      SnapshotSchema,
    )
    if (snapshot === undefined || snapshot.snapshot_id !== plan.current_snapshot)
      return yield* Effect.fail(
        fail(
          "SOURCE_BASELINE_UNAVAILABLE",
          "The exact prepared snapshot is unavailable; prepare again without dispatching this candidate.",
        ),
      )
    const custom = new Set(plan.custom_files_preserved)
    const bindings = new Set((snapshot.file_bindings ?? []).map((file) => file.path))
    return plan.projected_files
      .filter((file) => /\.md$/iu.test(file.path) && !custom.has(file.path))
      .flatMap((file) => {
        const current = snapshot.files.find((item) => item.path === file.path)
        if (current?.sha256 === file.sha256) return []
        return [
          {
            path: file.path,
            code: bindings.has(file.path)
              ? "BODY_REPLACEMENT_UNSAFE"
              : "INITIAL_PROJECTION_REQUIRED",
            protection: "atomic_content_precondition_unavailable",
            body_writes: 0,
          },
        ]
      })
  })
}

/** Offline status never recreates, resumes or clears an original operation. */
export function reportSourceUpdateRun(runId: string) {
  return Effect.gen(function* () {
    if (!/^source-run-[0-9a-f-]{36}$/u.test(runId))
      return yield* Effect.fail(fail("INVALID_ARGUMENT", "Use an exact source-run UUID."))
    const result = yield* (yield* Store).readJson(runKey(runId), SourceUpdateRunSchema)
    if (result === undefined || result.run_id !== runId)
      return yield* Effect.fail(
        fail(
          "SOURCE_RUN_NOT_FOUND",
          "The original source run is not available in this state root.",
        ),
      )
    return {
      ...result,
      offline: true,
      remote_writes: 0,
      checkpoint_status:
        result.execution === "running"
          ? ("possibly_running_or_interrupted" as const)
          : ("terminal" as const),
      metrics_completeness:
        result.execution === "running"
          ? ("lower_bound_since_last_checkpoint" as const)
          : ("completed_invocation" as const),
    }
  })
}

/** Recover run IDs after lost stdout without contacting a provider or starting work. */
export function listSourceUpdateRuns() {
  return Effect.gen(function* () {
    const store = yield* Store
    const keys = yield* store.listKeys("operations/shared-source-runs/")
    const items = []
    for (const key of [...keys].sort()) {
      const match = /^operations\/shared-source-runs\/(source-run-[0-9a-f-]{36})\.json$/u.exec(key)
      if (match === null) continue
      const run = yield* reportSourceUpdateRun(match[1]!)
      items.push({
        run_id: run.run_id,
        entry: run.entry,
        source: run.source,
        library_id: run.library_id,
        source_page_id: run.source_page_id,
        mode: run.mode,
        scope: run.scope,
        execution: run.execution,
        phase: run.phase,
        started_at: run.started_at,
        updated_at: run.updated_at,
        plan_id: run.plan?.plan_id ?? null,
        checkpoint_status: run.checkpoint_status,
        metrics_completeness: run.metrics_completeness,
      })
    }
    return {
      items: items.sort((a, b) => b.started_at - a.started_at || a.run_id.localeCompare(b.run_id)),
      offline: true,
      remote_writes: 0,
    }
  })
}

/** A finite invocation shared by interactive commands and external schedulers. */
export function runSourceUpdate(
  input: SourceUpdateInput,
  acquire: typeof discoverSourceDefinition = discoverSourceDefinition,
  resolveLibrary: typeof loadSharedLibrary = loadSharedLibrary,
) {
  return Effect.gen(function* () {
    const store = yield* Store
    const runId = `source-run-${yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(Effect.mapError(() => fail("CRYPTO_ERROR", "Cannot identify this source invocation.")))}`
    const mode = input.mode ?? "policy"
    const limits = {
      requests: input.budget?.requests ?? 2000,
      bytes: input.budget?.bytes ?? 128 * 1024 * 1024,
      duration_ms: input.budget?.duration_ms ?? 300_000,
    }
    const budget = yield* makeRequestBudget(runId, limits)
    const client = yield* HttpClient.HttpClient
    const started = yield* Clock.currentTimeMillis
    let receipt: SourceUpdateRun = {
      version: 1,
      kind: "source_update_run",
      run_id: runId,
      entry: input.entry,
      source: input.source,
      library_id: null,
      source_page_id: null,
      source_fingerprint: null,
      mode,
      scope: input.scope,
      execution: "running",
      phase: "resolving",
      started_at: started,
      updated_at: started,
      decision: { kind: "unobserved" },
      check: { status: "not_started" },
      plan: null,
      application: [],
      request_results: [],
      source_feedback: { status: "not_requested" },
      error: null,
      budget: yield* budget.snapshot,
      deployment: "one_writer_per_shared_library; local_fence_requires_the_same_state_root",
      git_budget:
        "child_process_timeout_and_invocation_deadline; git_protocol_bytes_are_not_http_budget_bytes",
      original_operations: "retain_frozen_plan_and_reconcile; unknown_dispatches_are_not_replayed",
    }
    const checkpoint = (patch: Partial<SourceUpdateRun>) =>
      Effect.gen(function* () {
        receipt = {
          ...receipt,
          ...patch,
          updated_at: yield* Clock.currentTimeMillis,
          budget: yield* budget.snapshot,
        }
        yield* store.writeJson(runKey(runId), receipt)
      })
    yield* checkpoint({})
    const work = Effect.gen(function* () {
      const library = yield* resolveLibrary(input.entry)
      yield* checkpoint({ library_id: library.library_id })
      const execute = Effect.gen(function* () {
        const definition = yield* readSourceDefinition(library, input.source)
        const decision = sourceRunDecision(
          definition,
          yield* Clock.currentTimeMillis,
          mode,
          input.dueOnly ?? false,
        )
        yield* checkpoint({
          source_page_id: definition.page_id,
          source_fingerprint: definition.fingerprint,
          decision,
        })
        if (!definition.enabled) return
        const members = yield* listSourceMembers(library, definition.page_id)
        const eligible = members.items.filter((item) => item.kind === "skill" && item.enabled)
        const target = input.scope.kind === "skill" ? input.scope.target : undefined
        const targets =
          target === undefined ? eligible : eligible.filter((item) => item.page_id === target)
        if (targets.length === 0 || (input.scope.kind === "skill" && targets.length !== 1))
          return yield* Effect.fail(
            fail(
              "SOURCE_RUN_SCOPE",
              "Choose an exact enabled Skill in this Source, or a nonempty all-bound scope.",
            ),
          )
        if (decision.kind === "check") {
          yield* checkpoint({ phase: "checking" })
          if (mode === "check") {
            const acquired = yield* acquire(definition, { metrics: (yield* Notion).metrics })
            if (!acquired.revision || (acquired.unavailable?.length ?? 0) !== 0)
              return yield* Effect.fail(
                fail(
                  "SOURCE_BATCH_INCOMPLETE",
                  "The provider check is incomplete; Last Checked remains unchanged.",
                ),
              )
            const review = yield* reviewSourceMembers(
              library,
              definition.page_id,
              acquired,
              members,
            )
            yield* checkpoint({
              check: {
                status: "completed",
                revision: acquired.revision,
                committed_at: acquired.provenance.committed_at ?? null,
                checked_at: yield* Clock.currentTimeMillis,
                member_review: review,
              },
            })
          } else {
            const plan =
              input.scope.kind === "all_bound"
                ? yield* prepareSourceRefreshBatch(
                    library,
                    definition.page_id,
                    acquire,
                    input.storage,
                  )
                : yield* prepareSourceRefresh(
                    library,
                    definition.page_id,
                    input.scope.target,
                    acquire,
                    input.storage,
                  )
            yield* checkpoint({
              phase: "prepared",
              plan,
              check: {
                status: "completed",
                revision: plan.provider_revision,
                committed_at: plan.provider_committed_at ?? null,
                checked_at: yield* Clock.currentTimeMillis,
                member_review: plan.member_review ?? null,
              },
            })
            if (input.output !== undefined)
              yield* store.output(
                input.output,
                new TextEncoder().encode(JSON.stringify(plan, null, 2) + "\n"),
              )
            if (decision.apply) {
              yield* checkpoint({ phase: "applying" })
              const plans = plan.kind === "source_refresh_batch" ? plan.plans : [plan]
              for (const member of plans) {
                yield* budget.check
                const stops = yield* automaticSourceStops(member)
                let item: typeof ApplicationSchema.Type
                if (stops.length > 0)
                  item = {
                    target_page_id: member.target_page_id,
                    plan_id: member.plan_id,
                    status: "blocked",
                    details: { stops, custom_files_preserved: member.custom_files_preserved },
                  }
                else {
                  const applied = yield* applySourceRefresh(library, member, false, false).pipe(
                    Effect.result,
                  )
                  item =
                    applied._tag === "Failure"
                      ? {
                          target_page_id: member.target_page_id,
                          plan_id: member.plan_id,
                          status: unknownCodes.has(applied.failure.code) ? "unknown" : "failed",
                          details: errorDetails(applied.failure),
                        }
                      : {
                          target_page_id: member.target_page_id,
                          plan_id: member.plan_id,
                          status:
                            "verified" in applied.success && applied.success.verified
                              ? "confirmed"
                              : "unknown",
                          details: applied.success,
                        }
                }
                yield* checkpoint({ application: [...receipt.application, item] })
              }
            }
          }
        }
        yield* checkpoint({ phase: "requests" })
        const { listSharedFileRequests, processSharedFileRequest, readSharedFileRequest } =
          yield* Effect.promise(() => import("./shared-file-request.ts"))
        const requests = yield* listSharedFileRequests(
          library,
          targets.map((item) => item.page_id),
        )
        yield* checkpoint({ request_results: [{ inventory: requests }] })
        for (const request of requests.requests) {
          yield* budget.check
          const requestInput = { library, skillPageId: request.skill_page_id, path: request.path }
          const result =
            mode === "policy"
              ? yield* processSharedFileRequest(requestInput).pipe(Effect.result)
              : yield* readSharedFileRequest(requestInput).pipe(Effect.result)
          yield* checkpoint({
            request_results: [
              ...receipt.request_results,
              {
                ...request,
                ...(result._tag === "Success"
                  ? { result: result.success }
                  : { error: errorDetails(result.failure) }),
              },
            ],
          })
        }
        if (mode === "policy" && receipt.check.status === "completed") {
          const plans =
            receipt.plan?.kind === "source_refresh_batch"
              ? receipt.plan.plans
              : receipt.plan === null
                ? []
                : [receipt.plan]
          const confirmed = receipt.application.filter((item) => item.status === "confirmed").length
          const application =
            decision.kind !== "check" || !decision.apply
              ? "awaiting_confirmation"
              : confirmed === plans.length
                ? "applied"
                : confirmed === 0
                  ? "blocked"
                  : "partial"
          const feedback = yield* publishSourceCheck(library, definition, {
            run_id: runId,
            checked_at: receipt.check.checked_at,
            revision: receipt.check.revision,
            committed_at: receipt.check.committed_at,
            scope: input.scope,
            candidate_id: receipt.plan?.plan_id ?? null,
            application,
            confirmed,
            total: plans.length,
            custom_files_preserved: [
              ...new Set(plans.flatMap((item) => item.custom_files_preserved)),
            ].sort(),
          })
          yield* checkpoint({ source_feedback: feedback })
        }
      })
      yield* withSourceUpdateLock(
        library,
        mode === "check" || mode === "prepare" ? execute.pipe(withReadOnlyNotion) : execute,
      )
    }).pipe(
      Effect.provideService(RequestBudget, budget),
      Effect.provideService(HttpClient.HttpClient, requestBudgetHttpClient(client, budget)),
      Effect.timeout(limits.duration_ms),
      Effect.catchTag("TimeoutError", () => Effect.fail(budget.exhaust("duration"))),
    )
    const outcome = yield* work.pipe(Effect.result)
    if (outcome._tag === "Failure") {
      const usage = yield* budget.snapshot
      yield* checkpoint({
        execution: usage.exhausted !== null ? "paused" : "failed",
        error: errorDetails(outcome.failure),
      })
    } else yield* checkpoint({ execution: "completed", phase: "completed" })
    return receipt
  })
}
