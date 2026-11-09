import { Effect } from "effect"
import { fail } from "./model.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { InventoryImportPlanSchema, validateInventoryImport } from "./shared-inventory-import.ts"
import {
  reviewSharedCreateNativeRecovery,
  applySharedCreateNativeRecovery,
  reconcileSharedCreateNativeRecovery,
} from "./shared-create-recovery-native.ts"
import { nativeMainRecoveryPlan } from "./shared-create-recovery-native-plan.ts"
import type { SharedNativeRecoveryOrigin } from "./shared-create-recovery-native-model.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import { preservesSharedLibraryBindings } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256, Store } from "./store.ts"

const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
/** This adapter preserves the original inventory authority; it has no mutation engine. */
function selection(entry: string, input: unknown, requireOriginal: boolean) {
  return Effect.gen(function* () {
    const outer = yield* validateInventoryImport(input)
    const library = yield* loadSharedLibrary(entry)
    if (
      !preservesSharedLibraryBindings(outer.library, library) ||
      outer.action.kind !== "create" ||
      outer.action.input_class !== "native" ||
      outer.action.baseline_revision !== null ||
      outer.action.selected_revision !== null
    )
      return yield* Effect.fail(
        fail(
          "INVENTORY_IMPORT_SCOPE",
          "Choose the unchanged original native inventory import for this exact library.",
        ),
      )
    const plan = yield* nativeMainRecoveryPlan(outer.action.creation)
    const file = plan.files[0]!,
      original = outer.local_entity.files[0]
    if (
      !preservesSharedLibraryBindings(plan.library, library) ||
      outer.local_entity.files.length !== 1 ||
      original === undefined ||
      original.path !== file.input_path ||
      original.sha256 !== file.input.sha256 ||
      original.bytes !== file.input.bytes ||
      original.mode !== file.input.mode ||
      original.status !== "verified" ||
      original.sensitive ||
      outer.local_entity.main !== file.input_path ||
      !same(outer.action.custom_paths, [file.input_path])
    )
      return yield* Effect.fail(
        fail(
          "INVENTORY_IMPORT_INVALID",
          "The complete original native import no longer binds its sole approved input bytes, mode and main path.",
        ),
      )
    if (requireOriginal) {
      const store = yield* Store
      for (const prefix of [
        "plans/shared-inventory-imports/",
        "operations/shared-inventory-imports/",
      ]) {
        const saved = yield* store.readJson(
          prefix + outer.plan_id + ".json",
          InventoryImportPlanSchema,
        )
        if (saved === undefined || !same(saved, outer))
          return yield* Effect.fail(
            fail(
              "INVENTORY_IMPORT_NOT_PREPARED",
              "Native recovery requires both the exact original prepared import and its original executed operation; copied or rehashed input grants no write authority.",
            ),
          )
      }
    }
    const origin: SharedNativeRecoveryOrigin = {
      kind: "inventory_native_import",
      plan_id: outer.plan_id,
      plan_sha256: yield* sha256(canonicalSharedJson(outer)),
      approved_manifest: outer.approved_manifest,
      local_entity_id: outer.local_entity.entity_id,
      permissions: outer.permissions,
    }
    return { library, outer, plan, origin }
  })
}
export function reviewInventoryNativeRecovery(input: {
  readonly entry: string
  readonly plan: unknown
  readonly target: string
}) {
  return Effect.gen(function* () {
    const original = yield* selection(input.entry, input.plan, true)
    return yield* reviewSharedCreateNativeRecovery({
      entry: input.entry,
      plan: original.plan,
      origin: original.origin,
      target: input.target,
    })
  }).pipe(withReadOnlyNotion)
}
export function applyInventoryNativeRecovery(input: {
  readonly entry: string
  readonly plan: unknown
  readonly review: unknown
  readonly reviewId: string
  readonly dryRun?: boolean
}) {
  const work = Effect.gen(function* () {
    const original = yield* selection(input.entry, input.plan, true)
    return yield* applySharedCreateNativeRecovery({
      ...input,
      plan: original.plan,
      origin: original.origin,
    })
  })
  return input.dryRun ? work.pipe(withReadOnlyNotion) : work
}
export function reconcileInventoryNativeRecovery(input: {
  readonly entry: string
  readonly plan: unknown
  readonly target: string
}) {
  return Effect.gen(function* () {
    const original = yield* selection(input.entry, input.plan, false)
    return yield* reconcileSharedCreateNativeRecovery({
      entry: input.entry,
      plan: original.plan,
      target: input.target,
    })
  }).pipe(withReadOnlyNotion)
}
