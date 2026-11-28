import { expect, test } from "bun:test"
import {
  cacheCapacity,
  cacheRecordProtection,
  rebuildableCacheKey,
} from "../src/cache-retention-model.ts"

test("the shared retention classifier accepts only exact reconstructible cache addresses", () => {
  expect(rebuildableCacheKey(`cache/shared-github-blobs/${"a".repeat(40)}.json`)).toBe(true)
  expect(
    rebuildableCacheKey(`cache/shared-record-payloads/${"a".repeat(64)}/${"b".repeat(64)}.json`),
  ).toBe(false)
  expect(
    rebuildableCacheKey(
      `cache/shared-derived-graphs/${"a".repeat(64)}/${"b".repeat(64)}/${"c".repeat(64)}.json`,
    ),
  ).toBe(true)
  for (const key of [
    "cache/shared-github-blobs/unknown.json",
    "cache/shared-github-blobs/../operations/a.json",
    "cache/shared-current-tree-validation/a.json",
    "cache/latest/a.json",
    "snapshots/s_a.json",
    "operations/shared-source-runs/a.json",
  ])
    expect(rebuildableCacheKey(key)).toBe(false)
})

test("multiple protection reasons survive instead of selecting just one", () => {
  expect(
    cacheRecordProtection("cache/latest/scope/skill.json", { access_denied: "ACCESS_DENIED" }),
  ).toEqual(["authorization_fact", "current_eligibility_or_tree_proof"])
  expect(
    cacheRecordProtection("operations/original.json", { access_denied: "ACCESS_DENIED" }),
  ).toEqual(["pending_intent", "authorization_fact"])
  expect(cacheRecordProtection("unrecognized/new-kind.json", {})).toEqual([
    "outside_rebuildable_capacity_scope",
  ])
})

test("capacity configuration rejects invalid values before changing storage", () => {
  for (const max_bytes of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
    expect(() => cacheCapacity({ max_bytes, retention_ms: 0 })).toThrow()
  expect(() => cacheCapacity({ max_bytes: 0, retention_ms: -1 })).toThrow()
  expect(() => cacheCapacity({ max_bytes: 0, retention_ms: 0, unknown: true })).toThrow()
  expect(cacheCapacity({ max_bytes: 0, retention_ms: 0 })).toEqual({
    max_bytes: 0,
    retention_ms: 0,
  })
})
