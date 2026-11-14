import { Effect } from "effect"
import { validateSnapshot } from "./cache.ts"
import { fail, SnapshotSchema } from "./model.ts"
import { Store, sha256 } from "./store.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { composeSharedFiles, type CompositionFile } from "./shared-composition.ts"
import { assertSharedFileReferences } from "./shared-file-references.ts"
import type { SharedSkillApplyPlan } from "./shared-skill-apply-model.ts"

/** Reconstruct the frozen reference-check tree from exact baseline objects and
 * the retained child candidates. Hash labels are never substituted for bytes. */
export function loadSharedApplyReferenceTree(plan: Extract<SharedSkillApplyPlan, { version: 2 }>) {
  return Effect.gen(function* () {
    const store = yield* Store
    const snapshot = yield* store.readJson(`snapshots/${plan.snapshot_id}.json`, SnapshotSchema)
    if (
      snapshot === undefined ||
      snapshot.scope !== plan.snapshot_scope ||
      snapshot.version_id !== plan.snapshot_version_id ||
      snapshot.record.locator.type !== "shared_skill" ||
      snapshot.record.locator.page_id !== plan.skill_page_id ||
      snapshot.record.locator.library_id !== plan.library_id ||
      (yield* sha256(canonicalSharedJson(snapshot.files))) !== plan.baseline_tree_sha256
    )
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_BASELINE_UNAVAILABLE",
          "The original complete tree is unavailable or belongs to another parent intent.",
        ),
      )
    yield* validateSnapshot(snapshot)
    const tree = new Map<string, CompositionFile>()
    for (const file of snapshot.files)
      tree.set(file.path, {
        path: file.path,
        bytes: yield* store.readBytes(`objects/${file.sha256}`),
        ...(file.mode === undefined ? {} : { mode: file.mode }),
      })
    const encode = new TextEncoder()
    for (const child of plan.layout) {
      const before = tree.get(child.path)
      if (child.action === "add" || child.action === "undelete") {
        if (before !== undefined)
          return yield* Effect.fail(
            fail(
              "SHARED_APPLY_FINAL_TREE",
              "A layout child would replace a path already in the frozen tree.",
            ),
          )
        tree.set(child.path, {
          path: child.path,
          bytes: encode.encode(child.content.markdown),
          ...(child.content.retained.mode == null ? {} : { mode: child.content.retained.mode }),
        })
      } else {
        if (before === undefined)
          return yield* Effect.fail(
            fail(
              "SHARED_APPLY_FINAL_TREE",
              "A layout child names a path absent from the original tree.",
            ),
          )
        tree.delete(child.path)
        if (child.action === "move") {
          if (!child.destination_path || tree.has(child.destination_path))
            return yield* Effect.fail(
              fail("SHARED_APPLY_FINAL_TREE", "A move collides with a frozen destination."),
            )
          tree.set(child.destination_path, { ...before, path: child.destination_path })
        }
      }
    }
    for (const child of plan.bodies) {
      const before = tree.get(child.path)
      if (before === undefined)
        return yield* Effect.fail(
          fail("SHARED_APPLY_FINAL_TREE", "A body child names a path outside the final layout."),
        )
      tree.set(child.path, { ...before, bytes: encode.encode(child.candidate.markdown) })
    }
    const files = yield* Effect.try({
      try: () =>
        composeSharedFiles({
          base: [...tree.values()],
          mounts: [],
          overrides: [],
          entrypoint: snapshot.entrypoint,
        }).files,
      catch: () =>
        fail("SHARED_APPLY_FINAL_TREE", "The complete frozen target tree is structurally invalid."),
    })
    const manifest = yield* Effect.forEach(files, (file) =>
      sha256(file.bytes).pipe(
        Effect.map((hash) => ({
          path: file.path,
          sha256: hash,
          bytes: file.bytes.byteLength,
          ...(file.mode === undefined ? {} : { mode: file.mode }),
        })),
      ),
    )
    if (
      canonicalSharedJson(manifest) !== canonicalSharedJson(plan.final_files) ||
      (yield* sha256(canonicalSharedJson(manifest))) !== plan.target_tree_sha256
    )
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_FINAL_TREE",
          "The retained child bytes do not reproduce the frozen full target manifest.",
          { operation_id: plan.operation_id, expected: plan.final_files, reconstructed: manifest },
        ),
      )
    const checked = yield* Effect.try({
      try: () => assertSharedFileReferences(files),
      catch: () =>
        fail(
          "SHARED_REFERENCE_INVALID",
          "The reconstructed final tree has an unresolved local reference.",
        ),
    })
    if (canonicalSharedJson(checked) !== canonicalSharedJson(plan.reference_check))
      return yield* Effect.fail(
        fail(
          "SHARED_REFERENCE_INVALID",
          "The original full reference check does not match the exact reconstructed bytes.",
        ),
      )
    return files
  })
}
