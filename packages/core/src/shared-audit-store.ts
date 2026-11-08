import { Effect, Schema } from "effect"
import { decode, fail } from "./model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256, Store } from "./store.ts"
import { pageId } from "./ref.ts"
import {
  AUDIT_RULES_VERSION,
  AuditCheckpointSchema,
  AuditRunIdSchema,
  auditReport,
  type AuditRun,
} from "./shared-audit-model.ts"

const key = (id: string) => `audit/runs/${id}.json`
const PointerSchema = Schema.Struct({ run_id: AuditRunIdSchema })

export function saveAuditRun(run: AuditRun) {
  return Effect.gen(function* () {
    const sha = yield* sha256(canonicalSharedJson(run))
    yield* (yield* Store).writeJson(key(run.run_id), { sha256: sha, run })
  }).pipe(Effect.uninterruptible)
}

export function readAuditRun(runId: string, entryId?: string) {
  return Effect.gen(function* () {
    yield* Effect.try({
      try: () => decode(AuditRunIdSchema, runId),
      catch: () => fail("INVALID_ARGUMENT", "Use one exact audit run ID, not a filesystem path."),
    })
    const checkpoint = yield* (yield* Store).readJson(key(runId), AuditCheckpointSchema).pipe(
      Effect.mapError(() =>
        fail("AUDIT_CHECKPOINT_CORRUPT", "The audit checkpoint is corrupt or unsupported.", {
          run_id: runId,
        }),
      ),
    )
    if (checkpoint === undefined)
      return yield* Effect.fail(
        fail("AUDIT_RUN_NOT_FOUND", "The exact audit run does not exist in this local state.", {
          run_id: runId,
        }),
      )
    if (
      checkpoint.run.run_id !== runId ||
      (yield* sha256(canonicalSharedJson(checkpoint.run))) !== checkpoint.sha256
    )
      return yield* Effect.fail(
        fail("AUDIT_CHECKPOINT_CORRUPT", "The audit checkpoint integrity check failed.", {
          run_id: runId,
        }),
      )
    if (checkpoint.run.rules_version !== AUDIT_RULES_VERSION)
      return yield* Effect.fail(
        fail(
          "AUDIT_RULES_UNSUPPORTED",
          "Resume/report requires the checkpoint's supported audit rules version.",
          { run_id: runId, rules_version: checkpoint.run.rules_version },
        ),
      )
    if (entryId !== undefined && checkpoint.run.entry_id !== entryId)
      return yield* Effect.fail(
        fail("AUDIT_SCOPE_MISMATCH", "The run belongs to a different exact library entry."),
      )
    return checkpoint.run
  })
}

export function auditHistoryKey(run: AuditRun) {
  return sha256(
    canonicalSharedJson([
      run.entry_id,
      run.permission_scope,
      run.rules_version,
      run.selector,
      run.depth,
      run.pin_id,
      run.graph_id,
    ]),
  ).pipe(Effect.map((hash) => `audit/latest/${hash}.json`))
}

export function readPreviousAuditRun(run: AuditRun) {
  return Effect.gen(function* () {
    const pointer = yield* (yield* Store).readJson(yield* auditHistoryKey(run), PointerSchema)
    if (pointer === undefined || pointer.run_id === run.run_id) return undefined
    const result = yield* readAuditRun(pointer.run_id).pipe(Effect.result)
    if (result._tag === "Success") return result.success
    if (result.failure.code === "AUDIT_RUN_NOT_FOUND") return undefined
    return yield* Effect.fail(result.failure)
  })
}

/** Only audit-derived run keys are eligible. Store retirement is recoverable;
 * ordinary object caches and all original-operation receipts are out of scope. */
export function publishAuditSummary(run: AuditRun) {
  return Effect.gen(function* () {
    const store = yield* Store
    const pointer = yield* auditHistoryKey(run)
    yield* store.writeJson(pointer, { run_id: run.run_id })
    const retained: AuditRun[] = []
    for (const candidate of yield* store.listKeys("audit/runs/")) {
      const match = /^audit\/runs\/(audit-[a-f0-9-]{36})\.json$/u.exec(candidate)
      if (!match?.[1]) continue
      const result = yield* readAuditRun(match[1]).pipe(Effect.result)
      if (
        result._tag === "Success" &&
        result.success.execution === "completed" &&
        (yield* auditHistoryKey(result.success)) === pointer
      )
        retained.push(result.success)
    }
    retained.sort((a, b) => b.updated_at - a.updated_at || a.run_id.localeCompare(b.run_id))
    const obsolete = retained.slice(Math.max(1, run.retain_runs)).map((value) => key(value.run_id))
    if (obsolete.length) yield* store.retireKeys(obsolete)
  })
}

/** Deliberately has no Notion requirement or authentication call. */
export function reportSharedAudit(runId: string, entryId?: string) {
  return Effect.gen(function* () {
    const run = yield* readAuditRun(runId, entryId)
    const previous =
      run.baseline_run_id === null
        ? undefined
        : yield* readAuditRun(run.baseline_run_id).pipe(
            Effect.catchIf(
              (error) => error.code === "AUDIT_RUN_NOT_FOUND",
              () => Effect.succeed(undefined),
            ),
          )
    return auditReport(run, previous)
  })
}

/** Discover interrupted runs without requiring a final stdout receipt or auth. */
export function listSharedAudits(input: { readonly entry?: string; readonly limit?: number } = {}) {
  return Effect.gen(function* () {
    const entry = input.entry === undefined ? undefined : pageId(input.entry)
    const limit = input.limit ?? 20
    if (
      (input.entry !== undefined && entry === undefined) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      return yield* Effect.fail(
        fail(
          "INVALID_ARGUMENT",
          "Use an exact optional entry and a run-list limit from 1 to 1000.",
        ),
      )
    const runs: AuditRun[] = []
    const unreadable: Array<{ run_id: string; code: string }> = []
    for (const candidate of yield* (yield* Store).listKeys("audit/runs/")) {
      const id = /^audit\/runs\/(audit-[a-f0-9-]{36})\.json$/u.exec(candidate)?.[1]
      if (id === undefined) continue
      const result = yield* readAuditRun(id).pipe(Effect.result)
      if (result._tag === "Failure") unreadable.push({ run_id: id, code: result.failure.code })
      else if (entry === undefined || result.success.entry_id === entry) runs.push(result.success)
    }
    runs.sort((a, b) => b.updated_at - a.updated_at || a.run_id.localeCompare(b.run_id))
    return {
      entry_id: entry ?? null,
      rules_version: AUDIT_RULES_VERSION,
      remote_writes: 0,
      matching_runs: runs.length,
      unreadable,
      runs: runs.slice(0, limit).map((run) => ({
        run_id: run.run_id,
        entry_id: run.entry_id,
        selector: run.selector,
        depth: run.depth,
        execution: run.execution,
        pause_reason: run.pause_reason,
        updated_at: run.updated_at,
        remaining_tasks: run.tasks.length,
        confirmed_read_outcomes: run.totals.confirmed_requests,
      })),
    }
  })
}
