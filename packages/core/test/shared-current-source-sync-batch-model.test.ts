import { expect, test } from "bun:test"
import { Schema } from "effect"
import {
  CurrentSourceSyncBatchSchema,
  matchesCurrentSourceSyncBatch,
  preservesCurrentSourceSyncBatch,
} from "../src/shared-current-source-sync-batch-model.ts"
import {
  appendCurrentSourceSyncBatchResult,
  currentSourceSyncBatchReference,
  makeCurrentSourceSyncBatch,
} from "../src/shared-current-source-sync-batch-helper.ts"
import type { CurrentSourceSyncItem } from "../src/shared-current-source-sync-model.ts"

const selection = {
  scope: "a".repeat(64),
  batch_id: "00000000-0000-4000-8000-000000000001",
  library_id: "79f7ff18-edd5-5870-8278-2630acd0211c",
  sources_data_source_id: "00000000-0000-4000-8000-000000000002",
  manager_id: "batch-manager",
  execution_id: "batch-generation",
  source_ids: ["alpha", "beta"],
  projection: "markdown" as const,
  started_at: 100,
}

function completed(sourceId: string): CurrentSourceSyncItem {
  return {
    source_id: sourceId,
    operation_id: "source-" + sourceId,
    content: {
      status: "published",
      resolved_commit: "b".repeat(40),
      revision: "c".repeat(64),
      configuration_sha256: "d".repeat(64),
    },
    projection: { status: "complete", skill_ids: [sourceId] },
    status: "applied",
    retryable: false,
    error: null,
  }
}

test("a full batch preserves its immutable identity and exact result prefix across one-step advances", () => {
  const initial = makeCurrentSourceSyncBatch(selection)
  const first = appendCurrentSourceSyncBatchResult(initial, completed("alpha"))
  const second = appendCurrentSourceSyncBatchResult(first, completed("beta"))
  expect(preservesCurrentSourceSyncBatch(initial, first)).toBe(true)
  expect(preservesCurrentSourceSyncBatch(first, first)).toBe(true)
  expect(preservesCurrentSourceSyncBatch(first, second)).toBe(true)
  expect(preservesCurrentSourceSyncBatch(initial, second)).toBe(false)
  expect(preservesCurrentSourceSyncBatch(second, first)).toBe(false)
  expect(preservesCurrentSourceSyncBatch(first, { ...first, started_at: 99 })).toBe(false)
  expect(
    preservesCurrentSourceSyncBatch(first, {
      ...first,
      batch_id: "00000000-0000-4000-8000-000000000099",
    }),
  ).toBe(false)
  expect(matchesCurrentSourceSyncBatch(initial, { ...selection, execution_id: "other" })).toBe(
    false,
  )
  expect(matchesCurrentSourceSyncBatch(initial, { ...selection, source_ids: ["alpha"] })).toBe(
    false,
  )
  expect(
    preservesCurrentSourceSyncBatch(first, {
      ...first,
      results: [{ ...completed("alpha"), operation_id: "rewritten" }],
    }),
  ).toBe(false)
  expect(currentSourceSyncBatchReference(first)).toEqual({
    scope: selection.scope,
    batch_id: selection.batch_id,
  })
})

test("only a terminal exact-next Source can enter the persisted prefix", () => {
  const initial = makeCurrentSourceSyncBatch(selection)
  expect(() => appendCurrentSourceSyncBatchResult(initial, completed("beta"))).toThrow()
  const retryable: CurrentSourceSyncItem = {
    source_id: "alpha",
    operation_id: null,
    content: { status: "not_started" },
    projection: { status: "not_started" },
    status: "pending",
    retryable: true,
    error: { code: "REQUEST_BUDGET_EXHAUSTED", message: "Retry after allowance renewal." },
  }
  expect(() => appendCurrentSourceSyncBatchResult(initial, retryable)).toThrow()
  expect(() =>
    appendCurrentSourceSyncBatchResult(initial, {
      ...retryable,
      status: "not_started",
      retryable: false,
    }),
  ).toThrow()
  expect(() =>
    appendCurrentSourceSyncBatchResult(initial, {
      ...completed("alpha"),
      status: "update_available",
      retryable: false,
      error: null,
    }),
  ).toThrow()
  const hardFailure: CurrentSourceSyncItem = {
    ...retryable,
    status: "blocked",
    retryable: false,
    error: {
      code: "CURRENT_SOURCE_SYNC_CONFLICT",
      message: "Foreign owner.",
      details: { operation_id: "foreign" },
    },
  }
  const first = appendCurrentSourceSyncBatchResult(initial, hardFailure)
  const final = appendCurrentSourceSyncBatchResult(first, completed("beta"))
  expect(final.results[0]).toEqual(hardFailure)
  expect(() => appendCurrentSourceSyncBatchResult(final, completed("beta"))).toThrow()
})

test("persisted batches reject noncanonical selection, malformed results and unknown state fields", () => {
  const decode = Schema.decodeUnknownSync(CurrentSourceSyncBatchSchema)
  const initial = makeCurrentSourceSyncBatch(selection)
  for (const value of [
    { ...initial, source_ids: ["beta", "alpha"] },
    { ...initial, source_ids: ["alpha", "alpha"] },
    { ...initial, source_ids: [] },
    { ...initial, results: [{ source_id: "alpha", status: "applied" }] },
    {
      ...initial,
      results: [{ ...completed("alpha"), content: { status: "published", revision: "bad" } }],
    },
    { ...initial, source_ids: ["snapshot-retired"] },
    { ...initial, started_at: Number.MAX_SAFE_INTEGER + 1 },
    { ...initial, next_index: 1 },
  ])
    expect(() => decode(value, { onExcessProperty: "error" })).toThrow()
})
