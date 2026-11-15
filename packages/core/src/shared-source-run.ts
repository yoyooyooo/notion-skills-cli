import { Clock, Crypto, Effect, Schema } from "effect"
import { HttpClient } from "effect/http"
import { fail, property, SnapshotSchema, type SkillsError } from "./model.ts"
import { authScope } from "./catalog.ts"
import { maintenanceResult } from "./shared-maintenance-result.ts"
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
  reconcileSourceRefresh,
  prepareSourceRefresh,
  reviewSourceMembers,
  SourceRefreshPlanSchema,
  type SourceRefreshPlan,
  type SourceRefreshStorage,
} from "./shared-source-refresh.ts"
import {
  publishSourceCheck,
  sharedSourceCheckPolicy,
  sourceRunDecision,
  withSourceUpdateLock,
  type SourceRunMode,
} from "./shared-source-policy.ts"
import { Store } from "./store.ts"
import {
  SourceDisplayFileSchema,
  sourceDisplayComplete,
  updateSourceDisplay,
} from "./shared-source-display.ts"

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
  display: Schema.optional(Schema.Array(SourceDisplayFileSchema)),
})
const RequestScopeSchema = Schema.Array(
  Schema.Struct({
    skill_page_id: Schema.String,
    skill_id: Schema.String,
    file_id: Schema.String,
    page_id: Schema.String,
    path: Schema.String,
    kind: Schema.Literals(["main", "supporting"]),
    request_id: Schema.String,
  }),
)
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
  update_following: Schema.optional(Schema.Boolean),
  auth_scope: Schema.optional(Schema.String),
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
  request_scope: Schema.optional(RequestScopeSchema),
  source_feedback: Schema.Unknown,
  error: Schema.NullOr(RunErrorSchema),
  continuations: Schema.optional(
    Schema.Array(
      Schema.Struct({
        updated_at: Schema.Number,
        execution: Schema.String,
        phase: Schema.String,
        mode: Schema.String,
        error: Schema.NullOr(RunErrorSchema),
        application: Schema.Array(ApplicationSchema),
        request_results: Schema.Array(Schema.Unknown),
        source_feedback: Schema.Unknown,
        budget: Schema.Unknown,
      }),
    ),
  ),
  empty_scope: Schema.optional(
    Schema.Struct({
      reason: Schema.Literals(["no_bound_members", "no_enabled_members"]),
      bound_members: Schema.Number,
      next: Schema.Struct({ read_only: Schema.Literal(true), argv: Schema.Array(Schema.String) }),
    }),
  ),
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
  readonly updateFollowing?: boolean
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

export function sourceRunResult(run: SourceUpdateRun) {
  const requests = run.request_results
    .map(property)
    .filter((item) => item.result !== undefined || item.error !== undefined)
  const unknown =
    run.execution === "running" ||
    run.execution === "paused" ||
    run.application.some((item) => item.status === "unknown") ||
    requests.some(
      (item) =>
        ["unknown", "processing"].includes(String(property(item.result).status)) ||
        unknownCodes.has(String(property(item.error).code)),
    ) ||
    property(run.source_feedback).original_outcome === "unknown" ||
    (run.error !== null && unknownCodes.has(run.error.code))
  const blocked =
    run.application.some((item) => item.status === "blocked" || item.status === "failed") ||
    requests.some(
      (item) =>
        item.error !== undefined ||
        ["blocked", "needs_review"].includes(String(property(item.result).status)),
    )
  const pendingCandidate =
    run.plan !== null && run.application.length === 0 && run.mode === "policy"
  const completion = unknown
    ? "unknown"
    : run.execution === "failed" || blocked
      ? "partial"
      : pendingCandidate
        ? "needs_decision"
        : run.plan === null && requests.length === 0 && run.check.status === "not_started"
          ? "no_op"
          : "complete"
  const readOnly = run.mode === "check" || run.mode === "prepare"
  const changedDisplay =
    run.application.some((item) => item.display?.some((file) => file.status === "applied")) ||
    requests.some((item) => property(item.result).status === "verified_applied")
  const frozenContinuation =
    run.auth_scope !== undefined &&
    (run.plan !== null || run.request_scope !== undefined) &&
    !readOnly &&
    run.execution !== "running"
  const recoverablePartial =
    frozenContinuation &&
    completion === "partial" &&
    (run.error?.code === "SOURCE_WRITE_NOT_APPLIED" ||
      requests.some((item) => property(item.error).code === "SOURCE_WRITE_NOT_APPLIED") ||
      run.application.some(
        (item) =>
          item.status !== "confirmed" &&
          item.display !== undefined &&
          item.display.length > 0 &&
          item.display.every((file) =>
            ["applied", "unchanged", "custom_preserved"].includes(file.status),
          ),
      ))
  const resume = {
    argv: ["ntn-skills", "ctl", "library", "sources", "run-resume", run.run_id],
    read_only: false,
    reason:
      "Continue this exact frozen task. Existing body requests are reconciled, never replayed; original scope and current premises are checked again.",
  }
  const unknownBody = run.application.flatMap((item) =>
    (item.display ?? [])
      .filter((file) => file.status === "unknown" && file.operation_id !== null)
      .map((file) => ({ target: item.target_page_id, operation_id: file.operation_id! })),
  )[0]
  const next = recoverablePartial
    ? resume
    : unknownBody !== undefined
      ? {
          argv: [
            "ntn-skills",
            "ctl",
            "operation",
            "show",
            unknownBody.operation_id,
            "--target",
            unknownBody.target,
            "--entry",
            run.entry,
          ],
          read_only: true,
          reason:
            "Inspect the exact original body operation. The source task has not completed and current equality cannot authorize replay.",
        }
      : (run.empty_scope?.next ?? {
          argv: ["ntn-skills", "ctl", "library", "sources", "run-status", run.run_id],
          read_only: true,
          reason: "Inspect this original frozen task; unknown requests must not be recreated.",
        })
  return {
    ...run,
    outcome: maintenanceResult({
      completion,
      verifiedScope:
        completion === "complete"
          ? readOnly
            ? "current_observation"
            : "original_operation"
          : "not_verified",
      authorContent:
        readOnly || completion === "no_op"
          ? "none"
          : changedDisplay
            ? "confirmed"
            : unknown
              ? "unknown"
              : "none",
      retainedRemote:
        readOnly || completion === "no_op"
          ? "none"
          : run.application.some((item) => item.status === "confirmed")
            ? "confirmed"
            : "unknown",
      message: pendingCandidate
        ? "The fixed candidate is prepared. Selection and native display updates still need an explicit decision."
        : "Check, selection, native display and file-request feedback have separate results; a selected version alone does not prove display completion.",
    }),
    next,
    ...(frozenContinuation &&
    !pendingCandidate &&
    completion !== "complete" &&
    completion !== "no_op"
      ? { continuation: { ...resume, original_outcomes_may_remain_unknown: unknown } }
      : {}),
    ...(pendingCandidate
      ? {
          decision: {
            original: run.decision,
            argv: [
              "ntn-skills",
              "ctl",
              "library",
              "sources",
              "run-resume",
              run.run_id,
              "--update-following",
            ],
            requires_decision: true,
            read_only: false,
            reason:
              "Authorize the already retained candidate and only its still-following native files.",
          },
        }
      : {}),
  }
}

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
      ...sourceRunResult(result),
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
    if (input.updateFollowing && mode !== "policy")
      return yield* Effect.fail(
        fail(
          "INVALID_ARGUMENT",
          "Explicit display updates require policy mode; check and prepare remain read-only.",
        ),
      )
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
      ...(input.updateFollowing ? { update_following: true } : {}),
      auth_scope: yield* authScope,
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
        let decision = sourceRunDecision(
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
        if (input.scope.kind === "skill" && targets.length !== 1)
          return yield* Effect.fail(
            fail("SOURCE_RUN_SCOPE", "Choose an exact enabled Skill bound to this Source."),
          )
        if (input.dueOnly) {
          decision = sourceRunDecision(
            definition,
            yield* Clock.currentTimeMillis,
            mode,
            true,
            yield* sharedSourceCheckPolicy(
              library,
              definition,
              targets.map((item) => item.skill_id),
            ),
          )
          yield* checkpoint({ decision })
        }
        if (targets.length === 0) {
          yield* checkpoint({
            empty_scope: {
              reason: members.items.length === 0 ? "no_bound_members" : "no_enabled_members",
              bound_members: members.items.length,
              next: {
                read_only: true,
                argv: [
                  "ntn-skills",
                  "ctl",
                  "library",
                  "sources",
                  members.items.length === 0 ? "check" : "members",
                  definition.page_id,
                  "--entry",
                  library.skills.database_id,
                ],
              },
            },
          })
          if (mode !== "check") return
        }
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
            if (decision.apply || input.updateFollowing) {
              yield* checkpoint({ phase: "applying" })
              const plans = plan.kind === "source_refresh_batch" ? plan.plans : [plan]
              for (const member of plans) {
                yield* budget.check
                const automaticStops = yield* automaticSourceStops(member)
                const stops = input.updateFollowing
                  ? automaticStops.filter((stop) => stop.code !== "BODY_REPLACEMENT_UNSAFE")
                  : automaticStops
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
                if (input.updateFollowing && item.status === "confirmed") {
                  const currentItem = item
                  const prefix = [...receipt.application]
                  const display = yield* updateSourceDisplay({
                    library,
                    plan: member,
                    checkpoint: (display) =>
                      checkpoint({
                        application: [...prefix, { ...currentItem, status: "unknown", display }],
                      }),
                  }).pipe(Effect.result)
                  const retainedDisplay = receipt.application.find(
                    (entry) => entry.plan_id === member.plan_id,
                  )?.display
                  item =
                    display._tag === "Failure"
                      ? {
                          ...currentItem,
                          ...(retainedDisplay === undefined ? {} : { display: retainedDisplay }),
                          status: unknownCodes.has(display.failure.code) ? "unknown" : "blocked",
                          details: {
                            selection: currentItem.details,
                            display_error: errorDetails(display.failure),
                          },
                        }
                      : {
                          ...currentItem,
                          display: display.success,
                          status: display.success.some(
                            (file) => file.status === "unknown" || file.status === "pending",
                          )
                            ? "unknown"
                            : display.success.some((file) => file.status === "blocked")
                              ? "blocked"
                              : "confirmed",
                        }
                  receipt = { ...receipt, application: prefix }
                }
                yield* checkpoint({ application: [...receipt.application, item] })
              }
            }
          }
        }
        if (targets.length === 0) return
        yield* checkpoint({ phase: "requests" })
        const { listSharedFileRequests, processSharedFileRequest, readSharedFileRequest } =
          yield* Effect.promise(() => import("./shared-file-request.ts"))
        const requests = yield* listSharedFileRequests(
          library,
          targets.map((item) => item.page_id),
        )
        const requestScope = yield* Effect.forEach(requests.requests, (request) =>
          readSharedFileRequest({
            library,
            skillPageId: request.skill_page_id,
            path: request.path,
          }).pipe(Effect.map((observed) => ({ ...request, request_id: observed.request_id }))),
        )
        yield* checkpoint({
          request_scope: requestScope,
          request_results: [{ inventory: requests }],
        })
        for (const request of requestScope) {
          yield* budget.check
          const requestInput = { library, skillPageId: request.skill_page_id, path: request.path }
          const result =
            mode === "policy"
              ? yield* processSharedFileRequest({
                  ...requestInput,
                  reconcileRecorded: true,
                  expectedRequest: request,
                }).pipe(Effect.result)
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
            decision.kind !== "check" || (!decision.apply && !input.updateFollowing)
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
    return sourceRunResult(receipt)
  })
}

/** Continue the same frozen task, without provider discovery or a new candidate. */
export function resumeSourceUpdateRun(
  input: {
    readonly runId: string
    readonly updateFollowing?: boolean
    readonly budget?: Partial<RequestBudgetLimits>
  },
  resolveLibrary: typeof loadSharedLibrary = loadSharedLibrary,
) {
  return Effect.gen(function* () {
    const store = yield* Store
    // Report validates the ID while leaving the saved original checkpoint untouched.
    yield* reportSourceUpdateRun(input.runId)
    const saved = yield* store.readJson(runKey(input.runId), SourceUpdateRunSchema)
    if (
      saved === undefined ||
      (saved.plan === null && saved.request_scope === undefined) ||
      saved.mode === "check"
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_PLAN_UNAVAILABLE",
          "This original run has no complete fixed candidate or request inventory to continue.",
        ),
      )
    let receipt: SourceUpdateRun = saved
    if (receipt.auth_scope !== (yield* authScope))
      return yield* Effect.fail(
        fail(
          "SOURCE_RUN_SCOPE",
          "The original authenticated run journal is unavailable in this scope. Inspect it without inferring an unsent request.",
        ),
      )
    const authorization = receipt.update_following === true || input.updateFollowing === true
    const original = receipt
    if (original.mode === "prepare" && !authorization)
      return yield* Effect.fail(
        fail(
          "SOURCE_RUN_DECISION_REQUIRED",
          "Continuing a read-only prepared candidate requires the explicit --update-following decision.",
        ),
      )
    if (
      sourceRunResult(original).outcome.task_completed &&
      !(input.updateFollowing && !original.update_following)
    )
      return sourceRunResult(original)
    if ((original.continuations?.length ?? 0) >= 64)
      return yield* Effect.fail(
        fail(
          "SOURCE_RUN_CONTINUATION_LIMIT",
          "This task reached its bounded continuation history; preserve it and inspect the original operations.",
        ),
      )
    const library = yield* resolveLibrary(original.entry)
    const budget = yield* makeRequestBudget(`${original.run_id}:resume`, {
      requests: input.budget?.requests ?? 2000,
      bytes: input.budget?.bytes ?? 128 * 1024 * 1024,
      duration_ms: input.budget?.duration_ms ?? 300_000,
    })
    const client = yield* HttpClient.HttpClient
    const checkpoint = (patch: Partial<SourceUpdateRun>) =>
      Effect.gen(function* () {
        receipt = {
          ...original,
          ...receipt,
          ...patch,
          updated_at: yield* Clock.currentTimeMillis,
          budget: yield* budget.snapshot,
        }
        yield* store.writeJson(runKey(original.run_id), receipt)
      })
    const work = Effect.gen(function* () {
      const definition = yield* readSourceDefinition(
        library,
        original.source_page_id ?? original.source,
      )
      if (
        !definition.enabled ||
        definition.fingerprint !== original.source_fingerprint ||
        library.library_id !== original.library_id
      )
        return yield* Effect.fail(
          fail(
            "SOURCE_DEFINITION_CHANGED",
            "The original source scope changed; no retained task may widen or rebind itself.",
          ),
        )
      const plan = original.plan
      const members =
        plan === null ? [] : plan.kind === "source_refresh_batch" ? plan.plans : [plan]
      const applications: SourceUpdateRun["application"][number][] = []
      yield* checkpoint({
        execution: "running",
        phase: "applying",
        mode: "policy",
        error: null,
        update_following: authorization,
        continuations: [
          ...(original.continuations ?? []),
          {
            updated_at: original.updated_at,
            execution: original.execution,
            phase: original.phase,
            mode: original.mode,
            error: original.error,
            application: original.application,
            request_results: original.request_results,
            source_feedback: original.source_feedback,
            budget: original.budget,
          },
        ],
      })
      for (const member of members) {
        yield* budget.check
        const prior = original.application.find((item) => item.plan_id === member.plan_id)
        if (
          prior?.status === "confirmed" &&
          (!authorization || sourceDisplayComplete(member, prior.display))
        ) {
          applications.push(prior)
          continue
        }
        const stops = yield* automaticSourceStops(member)
        const refused = authorization
          ? stops.filter((stop) => stop.code !== "BODY_REPLACEMENT_UNSAFE")
          : stops
        if (refused.length || (!authorization && prior === undefined)) {
          applications.push({
            target_page_id: member.target_page_id,
            plan_id: member.plan_id,
            status: "blocked",
            details: {
              stops: refused,
              reason:
                "Explicit bounded display authorization is required for this retained candidate.",
            },
          })
          continue
        }
        const selection =
          prior?.status === "unknown" || prior?.display !== undefined
            ? yield* reconcileSourceRefresh(library, member).pipe(Effect.result)
            : yield* applySourceRefresh(library, member, false, false).pipe(Effect.result)
        if (selection._tag === "Failure") {
          applications.push({
            target_page_id: member.target_page_id,
            plan_id: member.plan_id,
            status: unknownCodes.has(selection.failure.code) ? "unknown" : "blocked",
            details: errorDetails(selection.failure),
            ...(prior?.display === undefined ? {} : { display: prior.display }),
          })
          yield* checkpoint({ application: [...applications] })
          continue
        }
        let item: typeof ApplicationSchema.Type = {
          target_page_id: member.target_page_id,
          plan_id: member.plan_id,
          status: "confirmed",
          details: selection.success,
        }
        const selectionVerified =
          "verified" in selection.success
            ? selection.success.verified === true
            : ["applied", "unchanged"].includes(
                String(property(property(selection.success).selection).status),
              )
        if (!selectionVerified) item = { ...item, status: "unknown" }
        else if (authorization) {
          const base = item
          const display = yield* updateSourceDisplay({
            library,
            plan: member,
            prior: prior?.display,
            checkpoint: (display) =>
              checkpoint({
                application: [...applications, { ...base, status: "unknown", display }],
              }),
          }).pipe(Effect.result)
          const retainedDisplay = receipt.application.find(
            (entry) => entry.plan_id === member.plan_id,
          )?.display
          item =
            display._tag === "Failure"
              ? {
                  ...base,
                  ...(retainedDisplay === undefined ? {} : { display: retainedDisplay }),
                  status: "unknown",
                  details: {
                    selection: base.details,
                    display_error: errorDetails(display.failure),
                  },
                }
              : {
                  ...base,
                  display: display.success,
                  status: display.success.some(
                    (file) => file.status === "pending" || file.status === "unknown",
                  )
                    ? "unknown"
                    : display.success.some((file) => file.status === "blocked")
                      ? "blocked"
                      : "confirmed",
                }
        }
        applications.push(item)
        yield* checkpoint({ application: [...applications] })
      }
      yield* checkpoint({ application: applications, phase: "requests" })
      const { listSharedFileRequests, processSharedFileRequest, readSharedFileRequest } =
        yield* Effect.promise(() => import("./shared-file-request.ts"))
      let requestScope = original.request_scope
      if (requestScope === undefined) {
        const inventory = yield* listSharedFileRequests(
          library,
          members.map((member) => member.target_page_id),
        )
        requestScope = yield* Effect.forEach(inventory.requests, (request) =>
          readSharedFileRequest({
            library,
            skillPageId: request.skill_page_id,
            path: request.path,
          }).pipe(Effect.map((observed) => ({ ...request, request_id: observed.request_id }))),
        )
        yield* checkpoint({ request_scope: requestScope, request_results: [{ inventory }] })
      } else
        yield* checkpoint({
          request_results: original.request_results.filter(
            (item) => property(item).inventory !== undefined,
          ),
        })
      for (const request of requestScope) {
        yield* budget.check
        const result = yield* processSharedFileRequest({
          library,
          skillPageId: request.skill_page_id,
          path: request.path,
          reconcileRecorded: true,
          expectedRequest: request,
        }).pipe(Effect.result)
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
      if (original.check.status === "completed") {
        const confirmed = applications.filter((item) => item.status === "confirmed").length
        const feedback = yield* publishSourceCheck(library, definition, {
          run_id: original.run_id,
          checked_at: original.check.checked_at,
          revision: original.check.revision,
          committed_at: original.check.committed_at,
          scope: original.scope,
          candidate_id: original.plan?.plan_id ?? null,
          application:
            confirmed === members.length ? "applied" : confirmed === 0 ? "blocked" : "partial",
          confirmed,
          total: members.length,
          custom_files_preserved: [
            ...new Set(members.flatMap((member) => member.custom_files_preserved)),
          ].sort(),
        })
        yield* checkpoint({ source_feedback: feedback })
      }
      yield* checkpoint({ execution: "completed", phase: "completed" })
    })
    const result = yield* withSourceUpdateLock(library, work).pipe(
      Effect.provideService(RequestBudget, budget),
      Effect.provideService(HttpClient.HttpClient, requestBudgetHttpClient(client, budget)),
      Effect.timeout(input.budget?.duration_ms ?? 300_000),
      Effect.catchTag("TimeoutError", () => Effect.fail(budget.exhaust("duration"))),
      Effect.result,
    )
    if (result._tag === "Failure")
      yield* checkpoint({
        execution: (yield* budget.snapshot).exhausted !== null ? "paused" : "failed",
        error: errorDetails(result.failure),
      })
    return sourceRunResult(receipt)
  })
}
