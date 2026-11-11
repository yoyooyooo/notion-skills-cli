import { Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import type { PortableSkill } from "./portable.ts"
import { validateFixedFileManifest } from "./shared-fixed-resources.ts"
import { gitBlobOid } from "./shared-github-source.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import {
  prepareSharedResourceContent,
  validatePreparedSharedResource,
} from "./shared-resource-content.ts"
import { makeSourceBinding } from "./shared-source-binding.ts"
import type { SharedGitSourceBinding } from "./shared-source-binding-model.ts"
import { sha256 } from "./store.ts"

import {
  SharedCreateLocalSchema,
  type SharedCreateLocal,
  type SharedCreateLocalManifest,
} from "./shared-create-local-model.ts"

const checked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail(
            "SOURCE_LOCAL_IMPORT_INVALID",
            "The complete local input or its immutable original baseline is invalid.",
          ),
  })
const equal = (
  a: { readonly sha256?: string; readonly bytes: number; readonly mode?: string },
  b: { readonly sha256?: string; readonly bytes: number; readonly mode?: string },
) => a.sha256 === b.sha256 && a.bytes === b.bytes && a.mode === b.mode
export function sharedCreateLocalManifest(local: SharedCreateLocal): SharedCreateLocalManifest {
  return {
    baseline: local.baseline,
    manifest: local.manifest,
    baseline_inputs: local.baseline_inputs.map((file) => ({
      path: file.path,
      content: file.prepared.content,
    })),
  }
}

/** The local manifest records the authorized input. Only real differences become overrides. */
export function classifySharedCreateLocal(
  local: SharedCreateLocal,
  selected: SharedGitSourceBinding,
) {
  const baseline = new Map(local.baseline.files.map((file) => [file.path, file]))
  const current = new Map(local.manifest.map((file) => [file.path, file]))
  const selectedPaths = new Set(selected.files.map((file) => file.path))
  const changes = new Map<string, "custom" | "deleted">()
  for (const file of local.manifest) {
    const old = baseline.get(file.path)
    if (old === undefined || !equal(old, file)) changes.set(file.path, "custom")
    else if (!selectedPaths.has(file.path))
      throw fail(
        "SOURCE_LOCAL_BASELINE_REMOVED",
        "An unchanged local C1 file is absent from selected C2. Explicitly decide whether to retain it before creating the new Skill.",
        { path: file.path },
      )
  }
  for (const old of local.baseline.files)
    if (!current.has(old.path)) changes.set(old.path, "deleted")
  if (changes.get("SKILL.md") === "deleted")
    throw fail("SOURCE_ENTRYPOINT_CHANGED", "The complete local input must retain SKILL.md.")
  return changes
}

export function validateSharedCreateLocal(input: unknown, selected: SharedGitSourceBinding) {
  return Effect.gen(function* () {
    const local = yield* checked(() =>
      Schema.decodeUnknownSync(SharedCreateLocalSchema)(input, { onExcessProperty: "error" }),
    )
    const binding = yield* makeSourceBinding({
      url: local.baseline.url,
      commit: local.baseline.commit,
      tree: local.baseline.tree,
      root: local.baseline.root,
      files: local.baseline.files,
    })
    if (
      canonicalSharedJson(binding) !== canonicalSharedJson(local.baseline) ||
      binding.url !== selected.url ||
      binding.root !== selected.root ||
      binding.files.some((file) => file.sha256 === undefined)
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_LOCAL_BASELINE_INVALID",
          "Local changes require the complete immutable C1 of the same repository and exact source member.",
        ),
      )
    yield* checked(() => validateFixedFileManifest({ version: 1, files: local.manifest }))
    const changes = yield* checked(() => classifySharedCreateLocal(local, selected))
    const expected = binding.files
      .filter((file) => changes.has(file.path))
      .map((file) => file.path)
      .sort()
    if (
      canonicalSharedJson(local.baseline_inputs.map((file) => file.path)) !==
      canonicalSharedJson(expected)
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_LOCAL_BASELINE_INVALID",
          "Retain exactly each changed or deleted C1 file before publishing local ownership.",
        ),
      )
    const baselineBytes = new Map<string, Uint8Array>()
    for (const file of local.baseline_inputs) {
      const verified = yield* validatePreparedSharedResource(file.prepared),
        expected = binding.files.find((entry) => entry.path === file.path)!
      if (
        verified.prepared.content.sha256 !== expected.sha256 ||
        verified.bytes.length !== expected.bytes ||
        (verified.prepared.content.mode ?? undefined) !== expected.mode ||
        (yield* gitBlobOid(verified.bytes)) !== expected.git_oid
      )
        return yield* Effect.fail(
          fail(
            "SOURCE_LOCAL_BASELINE_INVALID",
            "A retained original C1 file differs from its frozen Git blob, SHA, size or mode.",
          ),
        )
      baselineBytes.set(file.path, verified.bytes)
    }
    return { local, changes, baselineBytes }
  })
}

export function prepareSharedCreateLocal(input: {
  readonly baseline: SharedGitSourceBinding
  readonly baselineFiles: PortableSkill["files"]
  readonly files: PortableSkill["files"]
  readonly selected: SharedGitSourceBinding
}) {
  return Effect.gen(function* () {
    const manifest = yield* Effect.forEach(
      [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      (file) =>
        Effect.gen(function* () {
          return {
            path: file.path,
            sha256: yield* sha256(file.bytes),
            bytes: file.bytes.length,
            ...(file.mode === undefined ? {} : { mode: file.mode }),
          }
        }),
    )
    const provisional: SharedCreateLocal = {
      baseline: input.baseline,
      manifest,
      baseline_inputs: [],
    }
    const changes = yield* checked(() => classifySharedCreateLocal(provisional, input.selected))
    const baselineInputs = []
    for (const file of input.baseline.files.filter((file) => changes.has(file.path))) {
      const bytes = input.baselineFiles.find((candidate) => candidate.path === file.path)?.bytes
      if (bytes === undefined)
        return yield* Effect.fail(
          fail("SOURCE_LOCAL_BASELINE_INVALID", "The original C1 bytes are incomplete."),
        )
      baselineInputs.push({
        path: file.path,
        prepared: yield* prepareSharedResourceContent(bytes, file.mode ?? null),
      })
    }
    return (yield* validateSharedCreateLocal(
      { ...provisional, baseline_inputs: baselineInputs },
      input.selected,
    )).local
  })
}
