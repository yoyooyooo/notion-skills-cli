import { Schema } from "effect"
import { CacheCapacitySchema, fail, property } from "./model.ts"

export { CacheCapacitySchema }
export type CacheCapacity = typeof CacheCapacitySchema.Type
export const DEFAULT_CACHE_CAPACITY: CacheCapacity = {
  max_bytes: 64 * 1024 * 1024,
  retention_ms: 7 * 86_400_000,
}
export const REBUILDABLE_CACHE_PREFIXES = [
  "cache/shared-github-blobs/",
  "cache/shared-derived-graphs/",
  "cache/current-source-sync/",
  "cache/shared-source-refs/",
  "cache/source-members/",
] as const

/** This one predicate owns admission, diagnostics and reclamation. */
export function rebuildableCacheKey(key: string): boolean {
  return (
    /^cache\/shared-github-blobs\/[a-f0-9]{40}\.json$/u.test(key) ||
    /^cache\/shared-derived-graphs\/[a-f0-9]{64}\/[a-f0-9]{64}\/[a-f0-9]{64}\.json$/u.test(key) ||
    /^cache\/current-source-sync\/[a-f0-9]{64}\/latest\.json$/u.test(key) ||
    /^cache\/shared-source-refs\/[a-f0-9]{64}\/latest\.json$/u.test(key) ||
    /^cache\/source-members\/[a-f0-9]{64}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/u.test(
      key,
    )
  )
}

export function cacheCapacity(input: unknown): CacheCapacity {
  if (input === undefined) return DEFAULT_CACHE_CAPACITY
  try {
    const value = Schema.decodeUnknownSync(CacheCapacitySchema)(input, {
      onExcessProperty: "error",
    })
    if (!Number.isSafeInteger(value.max_bytes) || !Number.isSafeInteger(value.retention_ms))
      throw new Error("range")
    return value
  } catch {
    throw fail(
      "CACHE_CAPACITY_INVALID",
      "Cache capacity and retention must be nonnegative safe integers.",
    )
  }
}

export function cacheRecordOwner(value: unknown) {
  const row = property(value)
  const record = property(row.record)
  const locator = property(record.locator)
  const field = (...values: unknown[]) => values.find((value) => typeof value === "string") ?? null
  return {
    skill_id: field(row.skill_id, locator.skill_id),
    skill_page_id: field(row.skill_page_id, locator.page_id),
    record_id: field(row.record_identity, record.id),
    snapshot_id: field(row.snapshot_id),
    version_id: field(row.version_id),
    operation_id: field(row.operation_id),
    scope: field(row.scope),
  }
}

export function cacheRecordProtection(key: string, value: unknown): readonly string[] {
  const row = property(value)
  const reasons: string[] = []
  if (key.startsWith("operations/")) reasons.push("pending_intent")
  if (key.startsWith("snapshots/")) reasons.push("fixed_local_bytes")
  if (key.startsWith("content-restrictions/")) reasons.push("custom_content_restriction")
  if (row.access_denied !== undefined || key.startsWith("cache/identities/"))
    reasons.push("authorization_fact")
  if (key.startsWith("cache/latest/") || key.startsWith("cache/shared-current-tree-validation/"))
    reasons.push("current_eligibility_or_tree_proof")
  if (!rebuildableCacheKey(key) && reasons.length === 0)
    reasons.push("outside_rebuildable_capacity_scope")
  return reasons
}
