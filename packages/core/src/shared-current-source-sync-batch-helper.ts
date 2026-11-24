import { Schema } from "effect"
import { fail } from "./model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import type { CurrentSourceSyncItem } from "./shared-current-source-sync-model.ts"
import {
  CurrentSourceSyncBatchSchema,
  preservesCurrentSourceSyncBatch,
  type CurrentSourceSyncBatch,
  type CurrentSourceSyncBatchReference,
} from "./shared-current-source-sync-batch-model.ts"

export { matchesCurrentSourceSyncBatch } from "./shared-current-source-sync-batch-model.ts"

function snapshot(input: unknown): CurrentSourceSyncBatch {
  try {
    return Schema.decodeUnknownSync(CurrentSourceSyncBatchSchema)(
      JSON.parse(canonicalSharedJson(input)),
      { onExcessProperty: "error" },
    )
  } catch {
    throw fail("STATE_CONFLICT", "The full Source batch has an invalid frozen input or prefix.")
  }
}

export function makeCurrentSourceSyncBatch(
  input: Omit<CurrentSourceSyncBatch, "version" | "kind" | "results">,
): CurrentSourceSyncBatch {
  return snapshot({ ...input, version: 2, kind: "current_source_sync_batch", results: [] })
}

export function appendCurrentSourceSyncBatchResult(
  batch: CurrentSourceSyncBatch,
  item: CurrentSourceSyncItem,
): CurrentSourceSyncBatch {
  const next = snapshot({ ...batch, results: [...batch.results, item] })
  if (!preservesCurrentSourceSyncBatch(batch, next))
    throw fail("STATE_CONFLICT", "Only the exact next completed Source may advance this batch.")
  return next
}

export function currentSourceSyncBatchReference(
  batch: CurrentSourceSyncBatch,
): CurrentSourceSyncBatchReference {
  return { scope: batch.scope, batch_id: batch.batch_id }
}

export const currentSourceSyncBatchKey = (scope: string) =>
  `operations/current-source-sync-batch/${scope}/pending.json`
