import { Effect } from "effect"
import { fail } from "./model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256, Store } from "./store.ts"
import { InventoryArtifactSchema } from "./shared-inventory-model.ts"

export function saveInventoryArtifact(
  kind: typeof InventoryArtifactSchema.Type.kind,
  payload: unknown,
) {
  return Effect.gen(function* () {
    const hash = yield* sha256(canonicalSharedJson({ kind, payload }))
    const inventory_id = `inventory-${hash}`
    yield* (yield* Store).writeJson(`inventory/observations/${inventory_id}.json`, {
      version: 1,
      kind,
      sha256: hash,
      payload,
    })
    return inventory_id
  })
}

export function readInventoryArtifact(id: string, kind?: typeof InventoryArtifactSchema.Type.kind) {
  return Effect.gen(function* () {
    if (!/^inventory-[a-f0-9]{64}$/u.test(id))
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Use one exact inventory observation ID, not a path."),
      )
    const value = yield* (yield* Store).readJson(
      `inventory/observations/${id}.json`,
      InventoryArtifactSchema,
    )
    if (value === undefined)
      return yield* Effect.fail(
        fail("INVENTORY_NOT_FOUND", "The exact local inventory observation is unavailable.", {
          inventory_id: id,
        }),
      )
    if (
      (kind !== undefined && value.kind !== kind) ||
      `inventory-${value.sha256}` !== id ||
      (yield* sha256(canonicalSharedJson({ kind: value.kind, payload: value.payload }))) !==
        value.sha256
    )
      return yield* Effect.fail(
        fail(
          "INVENTORY_INVALID",
          "The inventory type, identity or digest does not match the retained observation.",
        ),
      )
    return value
  })
}
