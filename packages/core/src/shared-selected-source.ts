import { Effect } from "effect"
import { localContentRestrictedHashes } from "./content-restrictions.ts"
import { fail, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { resolveSourceBinding } from "./shared-source-binding.ts"
import { loadSharedSourceOptions } from "./shared-source-config.ts"
import { materializeFixedGithubSource } from "./shared-source-materialization.ts"
import { resolveSourcePlanBinding } from "./shared-source-plan-binding.ts"
import {
  inspectSharedSnapshotHistory,
  materializeSharedSnapshotSource,
} from "./shared-snapshot-history.ts"
import { inspectRetainedSource, materializeRetainedSource } from "./shared-retained-source.ts"
import {
  inspectSharedSourcePlan,
  materializeSharedSourcePlan,
  type SharedSourcePlanOptions,
} from "./shared-source-plan.ts"

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

/** Complete source bytes for one exact registered revision; acquisition never selects or uploads a source. */
export function resolveSelectedSharedSource(
  library: SharedLibrary,
  skillPageId: string,
  sourceId: string,
  sourceOptions?: SharedSourcePlanOptions,
) {
  return Effect.gen(function* () {
    const selected = yield* resolveSelectedSharedSourceReference(library, { skillPageId, sourceId })
    const metrics = (yield* Notion).metrics ?? sourceOptions?.metrics
    if (selected.kind === "retained_bundle") {
      const files = yield* materializeRetainedSource(library, {
        skillPageId,
        sourceId,
        source: selected.binding,
      })
      return {
        source_id: sourceId,
        revision: sourceId,
        paths: selected.paths,
        files,
        local_paths: [] as string[],
      }
    }
    if (selected.kind === "snapshot") {
      const files = yield* materializeSharedSnapshotSource(library, {
        skillPageId,
        pinId: sourceId,
        manifest: selected.binding.manifest,
      })
      return {
        source_id: sourceId,
        revision: selected.revision,
        paths: selected.paths,
        files,
        local_paths: [] as string[],
      }
    }
    if (selected.kind === "git") {
      const materialized = yield* materializeFixedGithubSource(selected.binding, { metrics })
      const restricted = new Set(
        yield* localContentRestrictedHashes(materialized.map((file) => file.sha256)),
      )
      return {
        source_id: selected.source_id,
        revision: selected.revision,
        paths: selected.paths,
        files: materialized.map((file) => ({ path: file.path, bytes: file.bytes })),
        local_paths: materialized
          .filter((file) => restricted.has(file.sha256))
          .map((file) => file.path),
      }
    }
    const plan = selected.binding.plan
    const localRequired =
      plan.base?.kind === "local" || plan.mounts.some((mount) => mount.resource.kind === "local")
    const options = sourceOptions ?? (yield* loadSharedSourceOptions({ localRequired }))
    const materialized = yield* materializeSharedSourcePlan(plan, { ...options, metrics })
    if (
      materialized.source_plan_id !== selected.source_id ||
      JSON.stringify(materialized.paths) !== JSON.stringify(selected.paths)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_SOURCE_CONFLICT",
          "The complete materialized source differs from its selected immutable layout.",
        ),
      )
    return {
      source_id: selected.source_id,
      revision: selected.revision,
      paths: materialized.paths,
      files: materialized.files,
      local_paths: materialized.local_paths,
    }
  })
}
