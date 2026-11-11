import { Crypto, Effect, FileSystem, Path } from "effect"
import type { HttpClient } from "effect/http"
import { localContentRestrictedHashes } from "./content-restrictions.ts"
import { fail, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import type { CompositionFile } from "./shared-composition.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { resolveSourceBinding } from "./shared-source-binding.ts"
import { loadSharedSourceOptions } from "./shared-source-config.ts"
import {
  materializeFixedGithubSource,
  validateFixedGithubMaterializationSource,
} from "./shared-source-materialization.ts"
import { resolveSourcePlanBinding } from "./shared-source-plan-binding.ts"
import {
  inspectSharedSnapshotHistory,
  materializeSharedSnapshotFiles,
} from "./shared-snapshot-history.ts"
import { inspectRetainedSource, materializeRetainedSource } from "./shared-retained-source.ts"
import {
  admitSharedSourcePlan,
  inspectSharedSourcePlan,
  materializeSharedSourcePlan,
  type SourcePlanFile,
  type SharedSourcePlanOptions,
} from "./shared-source-plan.ts"
import { Store } from "./store.ts"

export type PlannedSharedSourceFile = SourcePlanFile

export type PlannedSharedSource = {
  readonly source_id: string
  readonly revision: string
  /** Complete immutable directory, independent of the local object cache. */
  readonly manifest: readonly PlannedSharedSourceFile[]
  /** All declared local paths and known SHA-256 aliases, including unrequested source paths. */
  readonly local_paths: readonly string[]
  readonly materialize: (
    paths: readonly string[],
  ) => Effect.Effect<
    { readonly files: readonly CompositionFile[]; readonly local_paths: readonly string[] },
    SkillsError,
    Notion | Store | Crypto.Crypto | HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
  >
}

/** Exact immutable metadata only. No provider requests, current page bodies, or local file reads. */
export function resolveSelectedSharedSourceReference(
  library: SharedLibrary,
  input: { readonly skillPageId: string; readonly sourceId: string },
) {
  return Effect.gen(function* () {
    if (/^bundle-[a-f0-9]{64}$/u.test(input.sourceId)) {
      const binding = yield* inspectRetainedSource(library, input)
      return {
        kind: "retained_bundle" as const,
        source_id: input.sourceId,
        revision: input.sourceId,
        paths: binding.files.map((file) => file.path),
        binding,
      }
    }
    if (/^snapshot-[a-f0-9]{64}$/u.test(input.sourceId)) {
      const binding = yield* inspectSharedSnapshotHistory(library, {
        skillPageId: input.skillPageId,
        pinId: input.sourceId,
      })
      return {
        kind: "snapshot" as const,
        source_id: binding.pin_id,
        revision: binding.pin_id,
        paths: binding.manifest.files.map((file) => file.path),
        binding,
      }
    }
    if (/^source-[a-f0-9]{64}$/u.test(input.sourceId)) {
      const binding = yield* resolveSourceBinding(library, input)
      return {
        kind: "git" as const,
        source_id: binding.source_id,
        revision: binding.commit,
        paths: binding.files.map((file) => file.path),
        binding,
      }
    }
    if (/^source-plan-[a-f0-9]{64}$/u.test(input.sourceId)) {
      const binding = yield* resolveSourcePlanBinding(library, {
        skillPageId: input.skillPageId,
        sourcePlanId: input.sourceId,
      })
      const inspected = yield* Effect.try({
        try: () => inspectSharedSourcePlan(binding.plan),
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail("INVALID_SHARED_SOURCE", "The selected source layout is invalid."),
      })
      return {
        kind: "composition" as const,
        source_id: binding.source_plan_id,
        revision: binding.source_plan_id,
        paths: inspected.paths,
        binding,
      }
    }
    return yield* Effect.fail(
      fail(
        "INVALID_SHARED_SOURCE",
        "Select one exact immutable source or source-plan ID; aliases and current upstream versions cannot substitute for it.",
      ),
    )
  })
}

/** Admit one complete immutable source, retaining its binding for subsequent path-only acquisition. */
export function planSelectedSharedSource(
  library: SharedLibrary,
  skillPageId: string,
  sourceId: string,
  sourceOptions?: SharedSourcePlanOptions,
): Effect.Effect<
  PlannedSharedSource,
  SkillsError,
  Notion | Store | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const selected = yield* resolveSelectedSharedSourceReference(library, { skillPageId, sourceId })
    const metrics = (yield* Notion).metrics ?? sourceOptions?.metrics
    if (selected.kind === "retained_bundle") {
      return {
        source_id: selected.source_id,
        revision: selected.revision,
        manifest: selected.binding.files.map((file) => ({
          path: file.path,
          bytes: file.bytes,
          identity: { kind: "sha256" as const, sha256: file.sha256 },
          ...(file.mode === undefined ? {} : { mode: file.mode }),
        })),
        local_paths: [],
        materialize: (paths: readonly string[]) =>
          materializeRetainedSource(library, {
            skillPageId,
            sourceId: selected.source_id,
            source: selected.binding,
            paths,
          }).pipe(Effect.map((files) => ({ files, local_paths: [] }))),
      }
    }
    if (selected.kind === "snapshot") {
      return {
        source_id: selected.source_id,
        revision: selected.revision,
        manifest: selected.binding.manifest.files.map((file) => ({
          path: file.path,
          bytes: file.bytes,
          identity: { kind: "sha256" as const, sha256: file.sha256 },
          ...(file.mode === undefined ? {} : { mode: file.mode }),
        })),
        local_paths: [],
        materialize: (paths: readonly string[]) =>
          materializeSharedSnapshotFiles(library, {
            skillPageId,
            pinId: selected.source_id,
            manifest: selected.binding.manifest,
            paths,
          }).pipe(Effect.map((files) => ({ files, local_paths: [] }))),
      }
    }
    if (selected.kind === "git") {
      const binding = yield* Effect.try({
        try: () => validateFixedGithubMaterializationSource(selected.binding),
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail("INVALID_SHARED_SOURCE", "The selected fixed Git directory is invalid."),
      })
      return {
        source_id: selected.source_id,
        revision: selected.revision,
        manifest: binding.files.map((file) => ({
          path: file.path,
          bytes: file.bytes,
          identity: {
            kind: "git" as const,
            git_oid: file.git_oid,
            ...(file.sha256 === undefined ? {} : { sha256: file.sha256 }),
          },
          ...(file.mode === undefined ? {} : { mode: file.mode }),
        })),
        local_paths: [],
        materialize: (paths: readonly string[]) =>
          Effect.gen(function* () {
            const materialized = yield* materializeFixedGithubSource(binding, { metrics }, paths)
            const restricted = new Set(
              yield* localContentRestrictedHashes(materialized.map((file) => file.sha256)),
            )
            return {
              files: materialized.map((file) => ({
                path: file.path,
                bytes: file.bytes,
                ...(file.mode === undefined ? {} : { mode: file.mode }),
              })),
              local_paths: materialized
                .filter((file) => restricted.has(file.sha256))
                .map((file) => file.path),
            }
          }),
      }
    }
    const plan = selected.binding.plan
    const localRequired =
      plan.base?.kind === "local" || plan.mounts.some((mount) => mount.resource.kind === "local")
    const options = sourceOptions ?? (yield* loadSharedSourceOptions({ localRequired }))
    const admittedOptions = { ...options, metrics }
    const inspection = yield* admitSharedSourcePlan(plan, admittedOptions)
    return {
      source_id: selected.source_id,
      revision: selected.revision,
      manifest: inspection.manifest,
      local_paths: inspection.local_paths,
      materialize: (paths: readonly string[]) =>
        Effect.gen(function* () {
          const materialized = yield* materializeSharedSourcePlan(
            inspection.plan,
            admittedOptions,
            paths,
          )
          if (
            materialized.source_plan_id !== selected.source_id ||
            JSON.stringify(materialized.paths) !== JSON.stringify(selected.paths)
          )
            return yield* Effect.fail(
              fail(
                "SHARED_SOURCE_CONFLICT",
                "The materialized source differs from its selected immutable layout.",
              ),
            )
          return { files: materialized.files, local_paths: materialized.local_paths }
        }),
    }
  })
}

/** Complete bytes remain available for authoring and explicit source refresh. */
export function resolveSelectedSharedSource(
  library: SharedLibrary,
  skillPageId: string,
  sourceId: string,
  sourceOptions?: SharedSourcePlanOptions,
) {
  return Effect.gen(function* () {
    const planned = yield* planSelectedSharedSource(library, skillPageId, sourceId, sourceOptions)
    const paths = planned.manifest.map((file) => file.path)
    const materialized = yield* planned.materialize(paths)
    return {
      source_id: planned.source_id,
      revision: planned.revision,
      paths,
      files: materialized.files,
      local_paths: materialized.local_paths,
    }
  })
}
