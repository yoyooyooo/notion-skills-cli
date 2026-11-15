import { Clock, Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { fail, property } from "./model.ts"
import { SnapshotSchema } from "./model.ts"
import { Store } from "./store.ts"
import {
  restoreSelectedSharedFile,
  reconcileSelectedSharedFileRestore,
} from "./shared-file-restore.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { sourceRefreshPin, type SourceRefreshPlan } from "./shared-source-refresh.ts"
import { resolveSelectedSharedSource } from "./shared-selected-source.ts"
import { openSharedSnapshot } from "./shared-snapshot.ts"
import { canonicalSharedJson } from "./shared-records.ts"

export const SourceDisplayFileSchema = Schema.Struct({
  path: Schema.String,
  file_id: Schema.NullOr(Schema.String),
  status: Schema.Literals([
    "pending",
    "applied",
    "unchanged",
    "custom_preserved",
    "blocked",
    "unknown",
  ]),
  operation_id: Schema.NullOr(Schema.String),
  details: Schema.Unknown,
})
export type SourceDisplayFile = typeof SourceDisplayFileSchema.Type
export function sourceDisplayComplete(
  plan: SourceRefreshPlan,
  files: readonly SourceDisplayFile[] | undefined,
) {
  const paths = plan.projected_files
    .filter((file) => /\.md$/iu.test(file.path))
    .map((file) => file.path)
  return (
    files !== undefined &&
    files.length === paths.length &&
    new Set(files.map((file) => file.path)).size === files.length &&
    paths.every((path) =>
      files.some(
        (file) =>
          file.path === path && ["applied", "unchanged", "custom_preserved"].includes(file.status),
      ),
    )
  )
}

/** The source task owns orchestration. The existing restore owns all body authorization. */
export function updateSourceDisplay<R>(input: {
  readonly library: SharedLibrary
  readonly plan: SourceRefreshPlan
  readonly prior?: readonly SourceDisplayFile[]
  readonly checkpoint: (
    files: readonly SourceDisplayFile[],
  ) => Effect.Effect<void, import("./model.ts").SkillsError, R>
}) {
  return Effect.gen(function* () {
    const baseline = yield* (yield* Store).readJson(
      `snapshots/${input.plan.current_snapshot}.json`,
      SnapshotSchema,
    )
    if (baseline === undefined || baseline.snapshot_id !== input.plan.current_snapshot)
      return yield* Effect.fail(
        fail(
          "SOURCE_BASELINE_UNAVAILABLE",
          "The original complete display baseline is missing. Do not reconstruct it from current content.",
        ),
      )
    const evidence = input.plan.display_baseline
    if (evidence === undefined || evidence.selected_version !== input.plan.previous_pin)
      return yield* Effect.fail(
        fail(
          "SOURCE_BASELINE_UNAVAILABLE",
          "This original plan has no frozen following body/frontier baseline. Inspect it without reconstructing old authority from a new read.",
        ),
      )
    const files: SourceDisplayFile[] = []
    for (const candidate of input.plan.projected_files) {
      if (!/\.md$/iu.test(candidate.path)) continue
      const bound = evidence.files.find((file) => file.path === candidate.path)
      const prior = input.prior?.find((file) => file.path === candidate.path)
      if (
        prior !== undefined &&
        ["applied", "unchanged", "custom_preserved"].includes(prior.status)
      ) {
        files.push(prior)
        continue
      }
      const current = baseline.files.find((file) => file.path === candidate.path)
      let item: SourceDisplayFile = {
        path: candidate.path,
        file_id: bound?.file_id ?? null,
        operation_id: prior?.operation_id ?? null,
        status: input.plan.custom_files_preserved.includes(candidate.path)
          ? "custom_preserved"
          : current?.sha256 === candidate.sha256
            ? "unchanged"
            : "pending",
        details: null,
      }
      files.push(item)
      yield* input.checkpoint([...files])
      if (item.status !== "pending") continue
      if (bound === undefined) {
        item = {
          ...item,
          status: "blocked",
          details: {
            code: "INITIAL_PROJECTION_REQUIRED",
            message:
              "This path has no existing native File identity; selection does not create its display page.",
          },
        }
      } else {
        const result =
          item.operation_id !== null
            ? yield* reconcileSelectedSharedFileRestore({
                library: input.library,
                skillPageId: input.plan.target_page_id,
                path: candidate.path,
                operationId: item.operation_id,
              }).pipe(Effect.result)
            : yield* restoreSelectedSharedFile({
                library: input.library,
                skillPageId: input.plan.target_page_id,
                path: candidate.path,
                expectedFollowing: {
                  file_id: bound.file_id,
                  heads: bound.heads,
                  body_sha256: bound.body_sha256,
                  selected_version: sourceRefreshPin(input.plan),
                },
                afterRestorePlanRetained: (plan) => {
                  item = {
                    ...item,
                    operation_id: plan.operation_id,
                    details: { protection: "single_full_body_match; no atomic page CAS" },
                  }
                  files[files.length - 1] = item
                  return input.checkpoint([...files])
                },
              }).pipe(Effect.result)
        if (result._tag === "Success") {
          item = {
            ...item,
            status:
              result.success.status === "applied"
                ? "applied"
                : result.success.status === "unchanged"
                  ? "unchanged"
                  : "blocked",
            operation_id: result.success.operation_id,
            details: result.success,
          }
        } else {
          const details = property(result.failure.details)
          item = {
            ...item,
            status:
              result.failure.code.includes("UNKNOWN") ||
              result.failure.code.includes("UNRESOLVED") ||
              item.operation_id !== null
                ? "unknown"
                : "blocked",
            operation_id:
              typeof details.body_write_operation_id === "string"
                ? details.body_write_operation_id
                : item.operation_id,
            details: {
              code: result.failure.code,
              message: result.failure.message,
              details: result.failure.details,
            },
          }
        }
      }
      files[files.length - 1] = item
      yield* input.checkpoint([...files])
      if (item.status === "unknown") break
    }
    if (!sourceDisplayComplete(input.plan, files)) return files
    const selected = yield* resolveSelectedSharedSource(
      input.library,
      input.plan.target_page_id,
      sourceRefreshPin(input.plan),
    )
    const verified = yield* openSharedSnapshot({
      library: input.library,
      target: input.plan.target_page_id,
      scope: yield* authScope,
      startedAt: yield* Clock.currentTimeMillis,
      readOnly: true,
      forceFull: true,
      fixedSource: {
        source_id: selected.source_id,
        revision: selected.revision,
        files: selected.files,
        local_paths: selected.local_paths,
      },
    })
    if (
      verified.shared_authoring.source_id !== sourceRefreshPin(input.plan) ||
      canonicalSharedJson(verified.files) !== canonicalSharedJson(input.plan.projected_files)
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_DISPLAY_CHANGED",
          "The complete final file tree or selected version differs from the frozen task after display verification.",
        ),
      )
    const completed = files.map((file) => ({
      ...file,
      details: {
        ...property(file.details),
        task_snapshot_id: verified.snapshot_id,
        complete_tree_verified: true,
      },
    }))
    yield* input.checkpoint(completed)
    return completed
  })
}
