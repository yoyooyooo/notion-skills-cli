import { Clock, Crypto, Effect, Exit } from "effect"
import { HttpClient } from "effect/http"
import { fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { pageId } from "./ref.ts"
import { RequestBudget, makeRequestBudget, type RequestBudgetLimits } from "./request-budget.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256, Store } from "./store.ts"
import {
  AUDIT_RULES_VERSION,
  auditFinding,
  auditReport,
  emptyAuditInventory,
  fairAuditOrder,
  type AuditDepth,
  type AuditRun,
  type AuditSelector,
  type AuditTask,
} from "./shared-audit-model.ts"
import {
  auditFailureCoverage,
  auditRowId,
  auditSkillSignature,
  inspectAuditInventory,
  readAuditInventory,
} from "./shared-audit-inventory.ts"
import { inspectAuditSkill } from "./shared-audit-inspect.ts"
import {
  publishAuditSummary,
  readAuditRun,
  readPreviousAuditRun,
  reportSharedAudit,
  saveAuditRun,
} from "./shared-audit-store.ts"
import { auditJournalNotion } from "./shared-audit-transport.ts"
import { requestBudgetHttpClient } from "./request-budget-http.ts"
import { AuditEvidence, auditEvidenceService } from "./shared-audit-evidence.ts"
import { withLocalLocks } from "./local-locks.ts"
import { inspectGraphRelease } from "./shared-graph-release.ts"
import { auditRetainedHistory } from "./shared-audit-history.ts"

export { reportSharedAudit, listSharedAudits } from "./shared-audit-store.ts"
export const DEFAULT_AUDIT_BUDGET: RequestBudgetLimits = {
  requests: 500,
  bytes: 64 * 1024 * 1024,
  duration_ms: 120_000,
}
export type StartSharedAuditInput = {
  readonly entry: string
  readonly selector: AuditSelector
  readonly depth?: AuditDepth
  readonly pin_id?: string
  readonly graph_id?: string
  readonly incremental?: boolean
  readonly recheck_after_ms?: number
  readonly retain_runs?: number
  readonly budget?: Partial<RequestBudgetLimits>
}
const inventoryTasks = (
  phase: "initial" | "final",
  round = 0,
  sources = false,
): readonly AuditTask[] =>
  (["skills", "files", "records", ...(sources ? ["sources" as const] : [])] as const).map(
    (table) => ({ key: `${phase}:${round}:${table}`, kind: "inventory", table, phase }),
  )
const limitsFor = (value?: Partial<RequestBudgetLimits>) => ({ ...DEFAULT_AUDIT_BUDGET, ...value })
const withAuditRunLock = <A, E, R>(runId: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const store = yield* Store
    return yield* withLocalLocks(store.root, [`audit-run:${runId}`], effect)
  })
const auditEndpointScope = (api: Notion["Service"]) =>
  Effect.gen(function* () {
    if (api.apiOrigin === undefined)
      return yield* Effect.fail(
        fail(
          "AUDIT_SCOPE_UNESTABLISHED",
          "The Notion adapter does not expose its exact API endpoint identity.",
        ),
      )
    return yield* sha256(canonicalSharedJson([api.apiOrigin, yield* api.version]))
  })

export function runSharedAudit(input: StartSharedAuditInput) {
  return Effect.gen(function* () {
    const entry = pageId(input.entry)
    const target = input.selector.kind === "skill" ? pageId(input.selector.page_id) : undefined
    if (entry === undefined || (input.selector.kind === "skill" && target === undefined))
      return yield* Effect.fail(
        fail(
          "INVALID_ARGUMENT",
          "Audit requires an exact library entry and exact Skill page, or explicit --all.",
        ),
      )
    if (
      input.pin_id !== undefined &&
      (input.selector.kind !== "skill" ||
        input.depth !== "history" ||
        !/^snapshot-[a-f0-9]{64}$/u.test(input.pin_id))
    )
      return yield* Effect.fail(
        fail(
          "INVALID_ARGUMENT",
          "An exact --pin snapshot- ID requires one target and --depth history.",
        ),
      )
    if (
      input.graph_id !== undefined &&
      (input.depth !== "history" || !/^graph-[a-f0-9]{64}$/u.test(input.graph_id))
    )
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "An exact --graph graph- ID requires --depth history."),
      )
    const retain_runs = input.retain_runs ?? 20
    const recheck_after_ms = input.recheck_after_ms ?? 24 * 60 * 60 * 1000
    if (
      !Number.isSafeInteger(retain_runs) ||
      retain_runs < 1 ||
      retain_runs > 1000 ||
      !Number.isSafeInteger(recheck_after_ms) ||
      recheck_after_ms < 0
    )
      return yield* Effect.fail(
        fail(
          "INVALID_ARGUMENT",
          "History retention must be 1–1000 runs and recheck age must be nonnegative.",
        ),
      )
    const api = yield* Notion
    const credential_scope = yield* sha256(yield* api.credentialIdentity)
    const endpoint_scope = yield* auditEndpointScope(api)
    const now = yield* Clock.currentTimeMillis
    const run: AuditRun = {
      version: 1,
      rules_version: AUDIT_RULES_VERSION,
      run_id: `audit-${yield* (yield* Crypto.Crypto).randomUUIDv4()}`,
      entry_id: entry,
      credential_scope,
      endpoint_scope,
      permission_scope: null,
      library: null,
      selector: target === undefined ? { kind: "library" } : { kind: "skill", page_id: target },
      depth: input.depth ?? "metadata",
      pin_id: input.pin_id ?? null,
      incremental: input.incremental === true,
      graph_id: input.graph_id ?? null,
      graph_result: null,
      graph_findings: [],
      graph_history: [],
      retain_runs,
      recheck_after_ms,
      execution: "running",
      pause_reason: null,
      started_at: now,
      updated_at: now,
      tasks: [
        { key: "library", kind: "library" },
        { key: "identity", kind: "identity" },
        ...inventoryTasks("initial"),
        { key: "plan", kind: "plan" },
      ],
      completed_tasks: [],
      observations: {},
      inventory: emptyAuditInventory(),
      census: emptyAuditInventory(),
      items: [],
      findings: [],
      totals: {
        attempts: 0,
        request_bytes: 0,
        response_bytes: 0,
        elapsed_ms: 0,
        invocations: 0,
        confirmed_requests: 0,
        replayed_requests: 0,
      },
      invocation_open: false,
      unclean_invocations: 0,
      last_budget: null,
      baseline_run_id: null,
      validation_round: 0,
    }
    // Validate before publishing a run; invalid budgets do not create abandoned state.
    yield* makeRequestBudget(run.run_id, limitsFor(input.budget))
    return yield* withAuditRunLock(
      run.run_id,
      Effect.gen(function* () {
        yield* saveAuditRun(run)
        return yield* continueSharedAudit(run, limitsFor(input.budget))
      }),
    )
  }).pipe(withReadOnlyNotion)
}

export function resumeSharedAudit(
  runId: string,
  input: { readonly entry?: string; readonly budget?: Partial<RequestBudgetLimits> } = {},
) {
  return Effect.gen(function* () {
    const entry = input.entry === undefined ? undefined : pageId(input.entry)
    if (input.entry !== undefined && entry === undefined)
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Use an exact library entry for scope checking."),
      )
    const run = yield* readAuditRun(runId, entry)
    if (run.execution === "completed") return yield* reportSharedAudit(runId, entry)
    if (run.execution === "execution_failed")
      return yield* Effect.fail(
        fail(
          "AUDIT_RUN_NOT_RESUMABLE",
          "This run failed its execution contract; inspect its report before starting a new run.",
        ),
      )
    const api = yield* Notion
    if (run.endpoint_scope === undefined)
      return yield* Effect.fail(
        fail(
          "AUDIT_SCOPE_UNESTABLISHED",
          "This historical checkpoint has no exact API endpoint proof; inspect it offline and start a new run.",
        ),
      )
    if ((yield* auditEndpointScope(api)) !== run.endpoint_scope)
      return yield* Effect.fail(
        fail(
          "AUDIT_SCOPE_MISMATCH",
          "The Notion API origin or version differs from the checkpoint endpoint identity.",
        ),
      )
    const credential = yield* api.credentialIdentity
    if ((yield* sha256(credential)) !== run.credential_scope)
      return yield* Effect.fail(
        fail(
          "AUDIT_SCOPE_MISMATCH",
          "The selected credential differs from the checkpoint permission identity.",
        ),
      )
    return yield* continueSharedAudit(run, limitsFor(input.budget))
  }).pipe((effect) => withAuditRunLock(runId, effect), withReadOnlyNotion)
}

function continueSharedAudit(initial: AuditRun, limits: RequestBudgetLimits) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const store = yield* Store
    const crypto = yield* Crypto.Crypto
    const http = yield* HttpClient.HttpClient
    const budget = yield* makeRequestBudget(
      `${initial.run_id}:${initial.totals.invocations + 1}`,
      limits,
    )
    let current: AuditRun = {
      ...initial,
      execution: "running",
      pause_reason: null,
      invocation_open: true,
      unclean_invocations: initial.unclean_invocations + (initial.invocation_open ? 1 : 0),
    }
    const owner = {
      get: () => current,
      set: (run: AuditRun) => {
        current = run
      },
    }
    const patch = (value: Partial<AuditRun>) => {
      current = { ...current, ...value }
    }
    yield* saveAuditRun(current)
    const previous =
      initial.baseline_run_id === null
        ? undefined
        : yield* readAuditRun(initial.baseline_run_id).pipe(
            Effect.catchIf(
              (error) => error.code === "AUDIT_RUN_NOT_FOUND",
              () => Effect.succeed(undefined),
            ),
          )
    let baseline = previous
    const library = () => {
      if (current.library === null)
        throw fail("AUDIT_CHECKPOINT_CORRUPT", "The audit task has no registered library.")
      return current.library
    }
    const resolveInventoryFindings = () =>
      Effect.gen(function* () {
        const findings = [...inspectAuditInventory(library(), current.inventory)]
        for (const [index, finding] of findings.entries()) {
          if (
            finding.code !== "OWNER_NOT_IN_INVENTORY" &&
            finding.code !== "REQUIRES_TARGET_UNAVAILABLE"
          )
            continue
          const evidence = property(finding.evidence)
          const id = String(evidence.owner_page_id ?? evidence.target_page_id)
          const result = yield* (yield* Notion).request(`v1/pages/${id}`).pipe(Effect.result)
          if (result._tag === "Failure") {
            if (
              result.failure.code === "REQUEST_BUDGET_EXHAUSTED" ||
              result.failure.code === "AUTH_REQUIRED"
            )
              return yield* Effect.fail(result.failure)
            continue
          }
          const row = property(result.success)
          if (
            row.in_trash === true ||
            row.archived === true ||
            property(row.parent).data_source_id !== library().skills.data_source_id
          )
            findings[index] = auditFinding({
              ...finding,
              code:
                row.in_trash === true || row.archived === true
                  ? "OWNER_CONFIRMED_IN_TRASH"
                  : "RELATION_OUTSIDE_LIBRARY",
              coverage: "full",
              message:
                row.in_trash === true || row.archived === true
                  ? "The exact related page is confirmed in trash."
                  : "The exact related page belongs to another registered scope.",
              evidence: { ...evidence, observed_page: result.success },
            })
        }
        if (baseline !== undefined)
          for (const table of ["skills", "files", "records"] as const) {
            const present = new Set(current.inventory[table].map(auditRowId))
            for (const old of baseline.inventory[table]) {
              const id = auditRowId(old)
              if (present.has(id)) continue
              const response = yield* (yield* Notion).request(`v1/pages/${id}`).pipe(Effect.result)
              if (
                response._tag === "Failure" &&
                ["REQUEST_BUDGET_EXHAUSTED", "AUTH_REQUIRED"].includes(response.failure.code)
              )
                return yield* Effect.fail(response.failure)
              const trashed =
                response._tag === "Success" &&
                (property(response.success).in_trash === true ||
                  property(response.success).archived === true)
              findings.push(
                auditFinding({
                  code: trashed ? "PREVIOUS_ROW_IN_TRASH" : "PREVIOUS_ROW_UNAVAILABLE",
                  severity: "warning",
                  object_id: id,
                  scope_key: "inventory",
                  location: table,
                  message: "A physical row from the previous comparable census is absent now.",
                  evidence: { previous_run_id: baseline.run_id, confirmed_in_trash: trashed },
                  coverage: trashed ? "full" : "permission_limited",
                }),
              )
            }
          }
        return findings
      })
    const execute = (task: AuditTask) =>
      Effect.gen(function* () {
        switch (task.kind) {
          case "library": {
            patch({ library: yield* loadSharedLibrary(current.entry_id) })
            if (library().sources !== undefined)
              patch({
                tasks: current.tasks.flatMap((next): readonly AuditTask[] =>
                  next.kind === "plan"
                    ? [
                        {
                          key: "initial:0:sources",
                          kind: "inventory",
                          table: "sources",
                          phase: "initial",
                        },
                        next,
                      ]
                    : [next],
                ),
              })
            return
          }
          case "identity": {
            const identity = yield* (yield* Notion).request("v1/users/me")
            const principal = property(identity).id
            if (
              property(identity).object !== "user" ||
              typeof principal !== "string" ||
              pageId(principal) === undefined
            )
              return yield* Effect.fail(
                fail("INVALID_RESPONSE", "The audit permission identity is unavailable."),
              )
            patch({
              permission_scope: yield* sha256(
                canonicalSharedJson([
                  current.credential_scope,
                  current.endpoint_scope,
                  principal,
                  property(property(identity).bot).workspace_id ?? null,
                  current.entry_id,
                ]),
              ),
            })
            return
          }
          case "inventory": {
            const rows = yield* readAuditInventory(library(), task.table)
            const field = task.phase === "initial" ? "inventory" : "census"
            const observed = current[field]
            patch({
              [field]: {
                ...observed,
                [task.table]: rows,
                complete: [...new Set([...observed.complete, task.table])],
              },
            })
            return
          }
          case "plan": {
            baseline = yield* readPreviousAuditRun(current)
            patch({ baseline_run_id: baseline?.run_id ?? null })
            patch({ findings: yield* resolveInventoryFindings() })
            const pages =
              current.selector.kind === "skill"
                ? [current.selector.page_id]
                : [...new Set(current.inventory.skills.map(auditRowId))].filter(
                    (id) => pageId(id) === id,
                  )
            const work: Array<{ page_id: string; changed: boolean; checked_at: number }> = []
            const reused: AuditRun["items"][number][] = []
            const now = yield* Clock.currentTimeMillis
            for (const id of pages) {
              const signature = yield* auditSkillSignature(library(), current.inventory, id)
              const prior = baseline?.items.find((item) => item.page_id === id)
              const valid =
                current.depth !== "history" &&
                prior !== undefined &&
                prior.signature === signature &&
                prior.coverage === "full" &&
                now - prior.checked_at < current.recheck_after_ms
              if (current.incremental && valid)
                reused.push({ ...prior, reused_from: baseline?.run_id ?? null })
              else
                work.push({
                  page_id: id,
                  changed: prior?.signature !== signature,
                  checked_at: prior?.checked_at ?? 0,
                })
            }
            patch({
              items: reused,
              tasks: [
                ...current.tasks,
                ...fairAuditOrder(work).map(
                  (id): AuditTask => ({ key: `skill:0:${id}`, kind: "skill", page_id: id }),
                ),
                ...(current.graph_id === null
                  ? []
                  : [{ key: `graph:${current.graph_id}`, kind: "graph" as const }]),
                ...inventoryTasks("final", 0, library().sources !== undefined),
                { key: "finish:0", kind: "finish" },
              ],
            })
            return
          }
          case "graph": {
            if (current.graph_id === null)
              return yield* Effect.fail(
                fail(
                  "AUDIT_CHECKPOINT_CORRUPT",
                  "An explicit graph task has no fixed graph identity.",
                ),
              )
            const graphId = current.graph_id
            const inspected = yield* inspectGraphRelease(graphId, { entry: current.entry_id }).pipe(
              Effect.result,
            )
            if (inspected._tag === "Failure") {
              if (
                [
                  "REQUEST_BUDGET_EXHAUSTED",
                  "AUTH_REQUIRED",
                  "RATE_LIMITED",
                  "NOTION_READ_ONLY",
                ].includes(inspected.failure.code)
              )
                return yield* Effect.fail(inspected.failure)
              patch({
                graph_findings: [
                  auditFinding({
                    code: "GRAPH_HISTORY_UNAVAILABLE",
                    severity: "warning",
                    object_id: graphId,
                    scope_key: `graph:${graphId}`,
                    location: "graph",
                    message:
                      "The exact graph closure could not be verified; current names or versions were not substituted.",
                    evidence: {
                      code: inspected.failure.code,
                      details: inspected.failure.details ?? null,
                    },
                    coverage: auditFailureCoverage(inspected.failure),
                  }),
                ],
              })
              return
            }
            const history: AuditRun["graph_history"][number][] = []
            const findings: AuditRun["graph_findings"][number][] = []
            for (const node of inspected.success.nodes) {
              const locator = node.binding.record.locator
              if (locator.type !== "shared_skill")
                return yield* Effect.fail(
                  fail(
                    "AUDIT_CHECKPOINT_CORRUPT",
                    "A validated graph node has no exact shared owner.",
                  ),
                )
              const checked = yield* auditRetainedHistory(library(), {
                skill_page_id: locator.page_id,
                events: [],
                pins: [node.pin_id],
                bundles: [],
                operations: [],
              })
              history.push(...checked.history)
              findings.push(
                ...checked.findings.map((finding) =>
                  auditFinding({ ...finding, scope_key: `graph:${graphId}` }),
                ),
              )
            }
            patch({
              graph_result: {
                graph_id: graphId,
                manifest: inspected.success.manifest,
                manifest_complete: true,
              },
              graph_history: history,
              graph_findings: findings,
            })
            return
          }
          case "skill": {
            const result = yield* inspectAuditSkill(library(), {
              page_id: task.page_id,
              inventory: current.inventory,
              depth: current.depth,
              observed_from: current.started_at,
              ...(current.pin_id === null ? {} : { pin_id: current.pin_id }),
            }).pipe(Effect.result)
            if (result._tag === "Failure") {
              if (
                [
                  "REQUEST_BUDGET_EXHAUSTED",
                  "AUTH_REQUIRED",
                  "RATE_LIMITED",
                  "NOTION_READ_ONLY",
                  "STORAGE_ERROR",
                  "AUDIT_CHECKPOINT_CORRUPT",
                ].includes(result.failure.code)
              )
                return yield* Effect.fail(result.failure)
              const finding = auditFinding({
                code: "SKILL_AUDIT_INCOMPLETE",
                severity: "warning",
                object_id: task.page_id,
                scope_key: `skill:${task.page_id}`,
                location: "skill",
                message: result.failure.message,
                evidence: { code: result.failure.code, details: result.failure.details ?? null },
                coverage: auditFailureCoverage(result.failure),
              })
              const item = {
                scope_key: finding.scope_key,
                page_id: task.page_id,
                skill_id: null,
                signature: yield* auditSkillSignature(library(), current.inventory, task.page_id),
                checked_at: yield* Clock.currentTimeMillis,
                observed_from: current.started_at,
                coverage: finding.coverage,
                findings: [finding],
                tree: [],
                history: [],
                requires: [],
                state: null,
                reused_from: null,
              }
              patch({
                items: [...current.items.filter((item) => item.page_id !== task.page_id), item],
              })
            } else
              patch({
                items: [
                  ...current.items.filter((item) => item.page_id !== task.page_id),
                  result.success,
                ],
              })
            return
          }
          case "finish": {
            const descriptor = yield* loadSharedLibrary(current.entry_id)
            if (canonicalSharedJson(descriptor) !== canonicalSharedJson(library()))
              return yield* Effect.fail(
                fail(
                  "AUDIT_SCOPE_MISMATCH",
                  "The registered library descriptor changed during this run.",
                ),
              )
            const selected = current.selector
            const ids =
              selected.kind === "skill"
                ? [selected.page_id]
                : [
                    ...new Set([
                      ...current.census.skills.map(auditRowId),
                      ...current.items.map((item) => item.page_id),
                    ]),
                  ]
            const changed: string[] = []
            for (const id of ids) {
              const signature = yield* auditSkillSignature(library(), current.census, id)
              if (current.items.find((item) => item.page_id === id)?.signature !== signature)
                changed.push(id)
            }
            if (changed.length && current.validation_round < 2) {
              const round = current.validation_round + 1
              patch({
                inventory: current.census,
                census: emptyAuditInventory(),
                validation_round: round,
                items: current.items.filter((item) => !changed.includes(item.page_id)),
                tasks: [
                  ...current.tasks,
                  ...changed.sort().map(
                    (id): AuditTask => ({
                      key: `skill:${round}:${id}`,
                      kind: "skill",
                      page_id: id,
                    }),
                  ),
                  ...inventoryTasks("final", round, library().sources !== undefined),
                  { key: `finish:${round}`, kind: "finish" },
                ],
              })
              return
            }
            patch({ inventory: current.census })
            patch({ findings: yield* resolveInventoryFindings() })
            if (changed.length)
              patch({
                findings: [
                  ...current.findings,
                  ...changed.map((id) =>
                    auditFinding({
                      code: "OBSERVATION_CHANGED_DURING_AUDIT",
                      severity: "warning",
                      object_id: id,
                      scope_key: `skill:${id}`,
                      location: "observation_interval",
                      message:
                        "This object continued changing while the finite audit observed it; the previous result is not a current health verdict.",
                      evidence: { validation_rounds: current.validation_round },
                      coverage: "partial",
                    }),
                  ),
                ],
              })
            patch({ execution: "completed" })
            return
          }
        }
      })
    const loop = Effect.gen(function* () {
      while (current.tasks.length && current.execution === "running") {
        const task = current.tasks[0]!
        yield* execute(task).pipe(
          Effect.provideService(
            Notion,
            auditJournalNotion(api, owner, task.key, { crypto, store }),
          ),
          Effect.provideService(
            AuditEvidence,
            auditEvidenceService(owner, task.key, { crypto, store }),
          ),
        )
        const used = yield* budget.snapshot
        if (used.exhausted !== null) return yield* Effect.fail(budget.exhaust(used.exhausted))
        patch({
          tasks: current.tasks.filter((pending) => pending.key !== task.key),
          completed_tasks: [...new Set([...current.completed_tasks, task.key])],
          updated_at: yield* Clock.currentTimeMillis,
        })
        yield* saveAuditRun(current)
      }
    }).pipe(
      Effect.provideService(RequestBudget, budget),
      Effect.provideService(HttpClient.HttpClient, requestBudgetHttpClient(http, budget)),
      Effect.timeout(limits.duration_ms),
      Effect.mapError((error) =>
        error instanceof SkillsError ? error : budget.exhaust("duration"),
      ),
    )
    const finalize = (interrupted: boolean) =>
      Effect.gen(function* () {
        const used = yield* budget.snapshot
        if (interrupted) patch({ execution: "paused", pause_reason: "cancelled" })
        patch({
          updated_at: yield* Clock.currentTimeMillis,
          last_budget: used,
          invocation_open: false,
          totals: {
            ...current.totals,
            attempts: initial.totals.attempts + used.attempts,
            request_bytes: initial.totals.request_bytes + used.request_bytes,
            response_bytes: initial.totals.response_bytes + used.response_bytes,
            elapsed_ms: initial.totals.elapsed_ms + used.elapsed_ms,
            invocations: initial.totals.invocations + 1,
          },
        })
        yield* saveAuditRun(current)
      }).pipe(Effect.uninterruptible)
    const outcome = yield* loop.pipe(
      Effect.onExit((exit) => (Exit.hasInterrupts(exit) ? finalize(true) : Effect.void)),
      Effect.result,
    )
    if (outcome._tag === "Failure") {
      const error = outcome.failure
      const paused = [
        "REQUEST_BUDGET_EXHAUSTED",
        "AUTH_REQUIRED",
        "ACCESS_DENIED",
        "NOT_FOUND",
        "RATE_LIMITED",
        "NOTION_UNAVAILABLE",
      ].includes(error.code)
      patch({
        execution: paused ? "paused" : "execution_failed",
        pause_reason: error.code,
        findings: [
          ...current.findings.filter((finding) => finding.code !== "AUDIT_EXECUTION_INTERRUPTED"),
          auditFinding({
            code: "AUDIT_EXECUTION_INTERRUPTED",
            severity: "warning",
            object_id: current.run_id,
            scope_key: "execution",
            location: current.tasks[0]?.key ?? "run",
            message: error.message,
            evidence: { code: error.code, details: error.details ?? null },
            coverage: auditFailureCoverage(error),
          }),
        ],
      })
    }
    yield* finalize(false)
    if (current.execution === "completed") yield* publishAuditSummary(current)
    return auditReport(current, baseline)
  })
}
