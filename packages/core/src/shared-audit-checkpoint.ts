import { Effect, Schema } from "effect"
import { decode, fail, property } from "./model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256, Store } from "./store.ts"
import {
  AuditCheckpointSchema,
  AuditInventorySchema,
  AuditRunSchema,
  type AuditInventory,
  type AuditRun,
} from "./shared-audit-model.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const PartSchema = Schema.Struct({ value: Schema.Unknown })
const InventorySchema = Schema.Struct({
  ...AuditInventorySchema.fields,
  skills: Hash,
  files: Hash,
  records: Hash,
  sources: Hash,
})
const ObservationSchema = Schema.Struct({
  task_key: Schema.String,
  path: Schema.String,
  outcome: Schema.Literals(["success", "failure"]),
  observed_at: Schema.Number,
  response_sha256: Hash,
  value_sha256: Hash,
})
const StoredRunSchema = Schema.Struct({
  ...AuditRunSchema.fields,
  observations: Schema.Record(Schema.String, ObservationSchema),
  inventory: InventorySchema,
  census: InventorySchema,
})
const CheckpointSchema = Schema.Struct({
  version: Schema.Literal(2),
  sha256: Hash,
  run: StoredRunSchema,
})
const tables = ["skills", "files", "records", "sources"] as const
export const auditCheckpointKey = (id: string) => `audit/runs/${id}.json`
export const auditPartPrefix = (id: string) => `audit/parts/${id}/`
const partKey = (id: string, hash: string) => `${auditPartPrefix(id)}${hash}.json`

// Memoize only deeply frozen audit-owned values. A response is captured before
// the caller receives it; changing a later provider object cannot alter a receipt.
const frozen = new WeakSet<object>()
function freeze(value: unknown): void {
  if (value === null || typeof value !== "object" || frozen.has(value)) return
  for (const child of Object.values(value)) freeze(child)
  Object.freeze(value)
  frozen.add(value)
}
export function captureAuditValue(value: unknown): unknown {
  const captured = structuredClone(value)
  freeze(captured)
  return captured
}
const saved = new WeakMap<Store["Service"], WeakMap<object, Map<string, string>>>()
function memo(store: Store["Service"]) {
  let values = saved.get(store)
  if (values === undefined) {
    values = new WeakMap()
    saved.set(store, values)
  }
  return values
}
function remember(store: Store["Service"], runId: string, value: unknown, hash: string) {
  if (value === null || typeof value !== "object") return
  freeze(value)
  const values = memo(store)
  const runs = values.get(value) ?? new Map<string, string>()
  runs.set(runId, hash)
  values.set(value, runs)
}

/** Commit immutable response/table parts before advancing the small checkpoint.
 * Repeated pagination writes never serialize or hash a prior frozen response. */
export function saveAuditCheckpoint(run: AuditRun) {
  return Effect.gen(function* () {
    const store = yield* Store
    const part = (value: unknown) =>
      Effect.gen(function* () {
        const prior =
          value !== null && typeof value === "object"
            ? memo(store).get(value)?.get(run.run_id)
            : undefined
        if (prior !== undefined) return prior
        freeze(value)
        const hash = yield* sha256(canonicalSharedJson(value))
        yield* store.writeJson(partKey(run.run_id, hash), { value })
        remember(store, run.run_id, value, hash)
        return hash
      })
    const inventory = (value: AuditInventory) =>
      Effect.gen(function* () {
        return {
          ...value,
          skills: yield* part(value.skills),
          files: yield* part(value.files),
          records: yield* part(value.records),
          sources: yield* part(value.sources),
        }
      })
    const observations: Record<string, typeof ObservationSchema.Type> = {}
    for (const [identity, observation] of Object.entries(run.observations)) {
      const { value, ...metadata } = observation
      const value_sha256 = yield* part(value)
      if (value_sha256 !== observation.response_sha256)
        return yield* Effect.fail(
          fail("AUDIT_CHECKPOINT_CORRUPT", "The confirmed audit response differs from its digest."),
        )
      observations[identity] = { ...metadata, value_sha256 }
    }
    const stored = {
      ...run,
      observations,
      inventory: yield* inventory(run.inventory),
      census: yield* inventory(run.census),
    }
    const hash = yield* sha256(canonicalSharedJson(stored))
    yield* store.writeJson(auditCheckpointKey(run.run_id), {
      version: 2,
      sha256: hash,
      run: stored,
    })
  })
}

/** Old complete checkpoints remain readable. V2 rehydrates and verifies every
 * referenced part before any resumed request or offline report can use it. */
export function readAuditCheckpoint(runId: string) {
  return Effect.gen(function* () {
    const store = yield* Store
    const raw = yield* store.readJson(auditCheckpointKey(runId), Schema.Unknown)
    if (raw === undefined) return undefined
    const checkpoint = yield* Effect.try({
      try: () =>
        property(raw).version === 2
          ? decode(CheckpointSchema, raw)
          : decode(AuditCheckpointSchema, raw),
      catch: () => fail("AUDIT_CHECKPOINT_CORRUPT", "The audit checkpoint has an invalid format."),
    })
    if (
      checkpoint.run.run_id !== runId ||
      (yield* sha256(canonicalSharedJson(checkpoint.run))) !== checkpoint.sha256
    )
      return yield* Effect.fail(
        fail("AUDIT_CHECKPOINT_CORRUPT", "The audit checkpoint integrity check failed."),
      )
    if (!("version" in checkpoint)) return checkpoint.run
    const loaded = new Map<string, unknown>()
    const part = (hash: string) =>
      Effect.gen(function* () {
        if (loaded.has(hash)) return loaded.get(hash)
        const record = yield* store.readJson(partKey(runId, hash), PartSchema)
        if (record === undefined || (yield* sha256(canonicalSharedJson(record.value))) !== hash)
          return yield* Effect.fail(
            fail("AUDIT_CHECKPOINT_CORRUPT", "A retained audit part is missing or corrupt.", {
              run_id: runId,
              part_sha256: hash,
            }),
          )
        remember(store, runId, record.value, hash)
        loaded.set(hash, record.value)
        return record.value
      })
    const inventory = (value: typeof InventorySchema.Type) =>
      Effect.gen(function* () {
        const result: Record<string, unknown> = { ...value }
        for (const table of tables) result[table] = yield* part(value[table])
        return result
      })
    const observations: Record<string, unknown> = {}
    for (const [identity, observation] of Object.entries(checkpoint.run.observations)) {
      const { value_sha256, ...metadata } = observation
      if (value_sha256 !== metadata.response_sha256)
        return yield* Effect.fail(
          fail(
            "AUDIT_CHECKPOINT_CORRUPT",
            "The retained response reference differs from its digest.",
          ),
        )
      observations[identity] = { ...metadata, value: yield* part(value_sha256) }
    }
    const complete = {
      ...checkpoint.run,
      observations,
      inventory: yield* inventory(checkpoint.run.inventory),
      census: yield* inventory(checkpoint.run.census),
    }
    return yield* Effect.try({
      try: () => decode(AuditRunSchema, complete),
      catch: () =>
        fail("AUDIT_CHECKPOINT_CORRUPT", "The retained audit parts have invalid content."),
    })
  })
}
