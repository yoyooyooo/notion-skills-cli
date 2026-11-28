import { ByteSize, Clock, Effect, FileSystem, Option, Path, Schema } from "effect"
import { fail, property, SkillsError } from "./model.ts"
import { Store } from "./store.ts"
import { sha256 } from "./store.ts"
import {
  cacheCapacity,
  cacheRecordOwner,
  cacheRecordProtection,
  rebuildableCacheKey,
  REBUILDABLE_CACHE_PREFIXES,
} from "./cache-retention-model.ts"

const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("CACHE_CAPACITY_INVALID", "Invalid capacity input."),
  })
export const effectiveCacheCapacity = Effect.gen(function* () {
  const raw = yield* (yield* Store).readJson("config.json", Schema.Unknown)
  return yield* checked(() => cacheCapacity(property(raw).cache_capacity))
})

export function configureCacheCapacity(input: {
  readonly maxBytes?: number
  readonly retentionMs?: number
}) {
  return Effect.gen(function* () {
    const store = yield* Store
    const raw = property(yield* store.readJson("config.json", Schema.Unknown))
    const previous = yield* effectiveCacheCapacity
    const policy = yield* checked(() =>
      cacheCapacity({
        max_bytes: input.maxBytes ?? previous.max_bytes,
        retention_ms: input.retentionMs ?? previous.retention_ms,
      }),
    )
    if (input.maxBytes !== undefined || input.retentionMs !== undefined)
      yield* store.writeJson("config.json", { ...raw, cache_capacity: policy })
    return {
      policy,
      scope: REBUILDABLE_CACHE_PREFIXES,
      admission: "new_runtime_skips_over_budget_optional_indexes",
      automatic_deletion: false,
      physical_disk_limit: false,
    }
  })
}

/** Offline inventory. Logical payloads, unique immutable objects and allocated
 * SQLite files are separate quantities; unknown external references stay protected. */
export function cacheRetentionReport() {
  return Effect.gen(function* () {
    const store = yield* Store
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const now = yield* Clock.currentTimeMillis
    const policy = yield* effectiveCacheCapacity
    const keys = new Set<string>()
    for (const prefix of [
      "cache",
      "snapshots",
      "operations",
      "plans",
      "sync",
      "publications",
      "operation-reviews",
      "database-init",
      "content-restrictions",
      "audit",
    ])
      for (const key of yield* store.listKeys(prefix)) keys.add(key)
    const retained = new Map(
      (yield* store.rebuildableCacheRecords?.() ?? Effect.succeed([])).map((row) => [row.key, row]),
    )
    for (const key of retained.keys()) keys.add(key)
    const entries = []
    const objectOwners = new Map<
      string,
      { owners: Set<string>; snapshots: Set<string>; reasons: Set<string> }
    >()
    for (const key of [...keys].sort()) {
      const stored = retained.get(key)
      const value =
        stored === undefined
          ? yield* store.readJson(key, Schema.Unknown)
          : yield* Effect.try({
              try: () => JSON.parse(stored.payload) as unknown,
              catch: () =>
                fail("STATE_CORRUPT", "A retained cache payload is not valid JSON.", { key }),
            })
      if (value === undefined) continue
      const payload = stored?.payload ?? JSON.stringify(value)
      const row = property(value)
      const owner = cacheRecordOwner(value)
      const reasons = cacheRecordProtection(key, value)
      const observed = [row.validated_at, row.fetched_at, row.updated_at, row.created_at].find(
        (value) => typeof value === "number" && Number.isFinite(value),
      )
      const observedAt = typeof observed === "number" ? observed : null
      const retainedSince = stored?.admitted_at ?? observedAt
      entries.push({
        key,
        owner,
        logical_bytes: new TextEncoder().encode(payload).length,
        sha256: yield* sha256(payload),
        reconstructible: rebuildableCacheKey(key),
        retired: stored?.retired === 1,
        protected_by: reasons,
        observed_at: observedAt,
        retained_since_ms: retainedSince,
        age_ms: retainedSince === null || now < retainedSince ? null : now - retainedSince,
      })
      for (const match of payload.matchAll(/(?:objects\/)?([a-f0-9]{64})/gu)) {
        const hash = match[1]!
        const group = objectOwners.get(hash) ?? {
          owners: new Set<string>(),
          snapshots: new Set<string>(),
          reasons: new Set<string>(),
        }
        if (typeof owner.record_id === "string") group.owners.add(owner.record_id)
        if (typeof owner.snapshot_id === "string") group.snapshots.add(owner.snapshot_id)
        for (const reason of reasons) group.reasons.add(reason)
        objectOwners.set(hash, group)
      }
    }
    const objects = []
    const objectRoot = path.join(store.root, "objects")
    if (yield* fs.exists(objectRoot))
      for (const hash of (yield* fs.readDirectory(objectRoot))
        .filter((name) => /^[a-f0-9]{64}$/u.test(name))
        .sort()) {
        const info = yield* fs.stat(path.join(objectRoot, hash))
        const refs = objectOwners.get(hash)
        const reasons = refs === undefined ? ["reference_coverage_unknown"] : [...refs.reasons]
        if (reasons.length === 0) reasons.push("immutable_bytes_outside_capacity_scope")
        if ((refs?.owners.size ?? 0) > 1) reasons.push("shared_object")
        objects.push({
          sha256: hash,
          bytes: Number(ByteSize.toBigInt(info.size)),
          allocated_bytes: Option.isSome(info.blocks) ? Number(info.blocks.value * 512n) : null,
          owners: [...(refs?.owners ?? [])].sort(),
          snapshots: [...(refs?.snapshots ?? [])].sort(),
          protected_by: reasons,
        })
      }
    const database = []
    for (const suffix of ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"]) {
      const location = path.join(store.root, suffix)
      if (!(yield* fs.exists(location))) continue
      const info = yield* fs.stat(location)
      database.push({
        file: suffix,
        bytes: Number(ByteSize.toBigInt(info.size)),
        allocated_bytes: Option.isSome(info.blocks) ? Number(info.blocks.value * 512n) : null,
      })
    }
    const eligible = entries.filter(
      (entry) => entry.reconstructible && entry.protected_by.length === 0,
    )
    const protectedEntries = entries.filter(
      (entry) => !entry.reconstructible || entry.protected_by.length > 0,
    )
    const bytes = eligible.reduce((sum, row) => sum + row.logical_bytes, 0)
    return {
      version: 1 as const,
      operation: "cache_retention_report" as const,
      policy,
      scope: REBUILDABLE_CACHE_PREFIXES,
      entries,
      objects,
      database,
      totals: {
        rebuildable_logical_bytes: bytes,
        active_rebuildable_logical_bytes: eligible
          .filter((row) => !row.retired)
          .reduce((sum, row) => sum + row.logical_bytes, 0),
        retired_rebuildable_logical_bytes: eligible
          .filter((row) => row.retired)
          .reduce((sum, row) => sum + row.logical_bytes, 0),
        protected_logical_bytes: protectedEntries.reduce((sum, row) => sum + row.logical_bytes, 0),
        unique_object_bytes: objects.reduce((sum, row) => sum + row.bytes, 0),
        object_count: objects.length,
        over_budget: bytes > policy.max_bytes,
      },
      unknown: [
        "external_broker_materializations_and_active_sessions",
        ...(store.rebuildableCacheRecords === undefined ? ["retired_sqlite_payload_bytes"] : []),
      ],
      remote_requests: 0,
      remote_writes: 0,
      physical_disk_limit: false,
    }
  }).pipe(
    Effect.mapError((error) =>
      error instanceof SkillsError
        ? error
        : fail("STORAGE_ERROR", "Could not inspect local cache retention."),
    ),
  )
}

export function previewCacheReclamation() {
  return Effect.gen(function* () {
    const store = yield* Store
    const report = yield* cacheRetentionReport()
    let remaining = report.totals.rebuildable_logical_bytes
    const candidates = []
    for (const item of report.entries
      .filter((row) => row.reconstructible && row.protected_by.length === 0)
      .sort((a, b) => (b.age_ms ?? -1) - (a.age_ms ?? -1) || a.key.localeCompare(b.key))) {
      const expired = item.age_ms !== null && item.age_ms >= report.policy.retention_ms
      if (remaining <= report.policy.max_bytes && !expired) continue
      candidates.push({
        key: item.key,
        sha256: item.sha256,
        logical_bytes: item.logical_bytes,
        retired: item.retired,
        reason: expired ? "retention_elapsed" : "capacity",
      })
      remaining -= item.logical_bytes
    }
    const planId = `cache-reclaim-${yield* sha256(JSON.stringify([store.root, report.policy, candidates]))}`
    return {
      ...report,
      operation: "cache_reclaim_preview" as const,
      plan_id: planId,
      candidates,
      expected_rebuildable_logical_bytes: remaining,
      file_objects: "protected",
      sqlite_allocation: "unchanged_until_database_reuses_pages",
    }
  })
}

export function reclaimCache(input: { readonly planId: string }) {
  return Effect.gen(function* () {
    const preview = yield* previewCacheReclamation()
    if (input.planId !== preview.plan_id)
      return yield* Effect.fail(
        fail(
          "CACHE_RECLAIM_STALE",
          "The exact preview changed; inspect a new preview before applying it.",
        ),
      )
    const store = yield* Store
    if (store.reclaimDerived === undefined)
      return yield* Effect.fail(
        fail(
          "RETENTION_UNAVAILABLE",
          "This Store cannot retain exact cache payloads in system Trash.",
        ),
      )
    const result = yield* store.reclaimDerived(
      preview.candidates.map(({ key, sha256 }) => ({ key, sha256 })),
    )
    return {
      operation: "cache_reclaim" as const,
      plan_id: preview.plan_id,
      ...result,
      protected_objects_unchanged: true,
      sqlite_allocation: "not_compacted",
      physical_disk_limit: false,
    }
  })
}
