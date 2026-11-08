import { Effect } from "effect"
import { fail, property, text } from "./model.ts"
import { withLocalLocks } from "./local-locks.ts"
import { Notion } from "./notion.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import {
  guardedSourceMutation,
  readSourceDefinition,
  sourceField,
  sourceRich,
  sourceTable,
} from "./shared-source-definitions.ts"
import type { SourceDefinition } from "./shared-sources-model.ts"
import { Store } from "./store.ts"

export type SourceRunMode = "check" | "prepare" | "policy"

/** Scheduling reads native policy; it never turns a display field into a write fence. */
export function sourceRunDecision(
  definition: SourceDefinition,
  now: number,
  mode: SourceRunMode,
  dueOnly: boolean,
) {
  if (!definition.enabled) return { kind: "skip" as const, reason: "disabled" as const }
  if (mode === "policy" && definition.policy === "pinned")
    return { kind: "skip" as const, reason: "pinned" as const }
  const interval = definition.options.check_interval_ms
  if (
    dueOnly &&
    (typeof interval !== "number" || !Number.isSafeInteger(interval) || interval < 60_000)
  )
    return { kind: "skip" as const, reason: "no_check_interval" as const }
  const dueAt =
    definition.last_checked === null || typeof interval !== "number"
      ? null
      : definition.last_checked + interval
  if (dueOnly && dueAt !== null && dueAt > now && definition.last_checked! <= now)
    return { kind: "skip" as const, reason: "not_due" as const, due_at: dueAt }
  return {
    kind: "check" as const,
    apply: mode === "policy" && definition.policy === "auto",
    due_at: dueAt,
  }
}

/** Same state root, same library, same fence for manual and scheduled source writers. */
export function withSourceUpdateLock<A, E, R>(
  library: SharedLibrary,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const store = yield* Store
    return yield* withLocalLocks(store.root, [`shared-source-update:${library.library_id}`], effect)
  })
}

export type SourceCheckSummary = {
  readonly run_id: string
  readonly checked_at: number
  readonly revision: string
  readonly committed_at: string | null
  readonly scope:
    | { readonly kind: "all_bound" }
    | { readonly kind: "skill"; readonly target: string }
  readonly candidate_id: string | null
  readonly application:
    | "not_requested"
    | "awaiting_confirmation"
    | "applied"
    | "partial"
    | "blocked"
  readonly confirmed: number
  readonly total: number
  readonly custom_files_preserved: readonly string[]
}

/** Only a completed provider observation advances Last Checked. Apply is a separate fact. */
export function publishSourceCheck(
  library: SharedLibrary,
  definition: SourceDefinition,
  summary: SourceCheckSummary,
) {
  return Effect.gen(function* () {
    const current = yield* readSourceDefinition(library, definition.page_id)
    if (current.fingerprint !== definition.fingerprint)
      return yield* Effect.fail(
        fail("SOURCE_DEFINITION_CHANGED", "Source configuration changed before check feedback."),
      )
    if (current.last_checked !== null && current.last_checked > summary.checked_at)
      return {
        status: "superseded" as const,
        current_checked_at: current.last_checked,
        remote_writes: 0,
      }
    const checkedAt = Math.floor(summary.checked_at / 60_000) * 60_000
    const status =
      summary.application === "applied"
        ? "applied"
        : summary.application === "blocked" || summary.application === "partial"
          ? "blocked"
          : "checked"
    const application = {
      not_requested: "仅检查",
      awaiting_confirmation: "候选待确认",
      applied: "已核对选定版本",
      partial: "部分完成，需要核对",
      blocked: "受阻，需要核对",
    }[summary.application]
    const serialized = [
      `最后成功检查：${new Date(checkedAt).toISOString()}`,
      `上游修订：${summary.revision}`,
      `上游提交日期：${summary.committed_at ?? "该来源未提供"}`,
      `应用：${application}；已确认 ${summary.confirmed}/${summary.total}；保留自定义文件 ${summary.custom_files_preserved.length}`,
      `范围：${summary.scope.kind === "all_bound" ? "全部已启用绑定 Skill" : summary.scope.target}`,
      `候选：${summary.candidate_id ?? "无"}`,
      `运行：${summary.run_id}`,
      "页面正文和本页展示基线分别核对。此处是检查摘要，不是写入锁或完整同步证明。",
    ].join("\n")
    const ids = sourceTable(library).property_ids
    const api = yield* Notion
    const properties = {
      [ids.Status!]: { select: { name: status } },
      [ids["Last Checked"]!]: { date: { start: new Date(checkedAt).toISOString() } },
      [ids["Last Revision"]!]: { rich_text: sourceRich(summary.revision) },
      [ids["Last Result"]!]: { rich_text: sourceRich(serialized) },
    }
    return yield* guardedSourceMutation(
      library,
      {
        identity: `source-check:${definition.source_id}`,
        path: `v1/pages/${definition.page_id}`,
        method: "PATCH",
        body: { properties },
      },
      Effect.gen(function* () {
        const row = yield* api.request(`v1/pages/${definition.page_id}`)
        return property(sourceField(row, ids.Status!).select).name === status &&
          text(sourceField(row, ids["Last Revision"]!).rich_text) === summary.revision &&
          Date.parse(String(property(sourceField(row, ids["Last Checked"]!).date).start)) ===
            checkedAt &&
          text(sourceField(row, ids["Last Result"]!).rich_text) === serialized
          ? {
              status,
              checked_at: checkedAt,
              revision: summary.revision,
              application: summary.application,
            }
          : undefined
      }),
    )
  })
}
