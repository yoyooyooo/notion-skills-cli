import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { fail, SkillsError } from "./model.ts"
import { CreationProofSchema } from "./publication-create-identity.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const MarkerCommon = {
  version: Schema.Literal(2),
  operation_id: Schema.String,
  intended_hash: Hash,
}
export const PublicationMarkerSchema = Schema.Union([
  Schema.Struct({
    ...MarkerCommon,
    state: Schema.Literal("writing"),
    base_revision: Schema.optional(Hash),
    creation: Schema.optional(CreationProofSchema),
  }),
  Schema.Struct({
    ...MarkerCommon,
    state: Schema.Literal("committed"),
    revision: Hash,
    manifest_hash: Hash,
    ownership_hash: Hash,
    creation: Schema.optional(CreationProofSchema),
  }),
])
export type PublicationMarker = typeof PublicationMarkerSchema.Type
export type WritingMarker = Extract<PublicationMarker, { state: "writing" }>
export type CommittedMarker = Extract<PublicationMarker, { state: "committed" }>
export const IntegrityIntentSchema = Schema.Struct({
  version: Schema.Literal(1),
  operation_id: Schema.String,
  intended_hash: Hash,
  marker: PublicationMarkerSchema,
  page_id: Schema.optional(Schema.String),
})
export type IntegrityIntent = typeof IntegrityIntentSchema.Type
export const BaselineIntentSchema = Schema.Struct({
  version: Schema.Literal(1),
  operation_id: Schema.String,
  parent_page_id: Schema.String,
  hash: Hash,
  payload: Schema.String,
  page_id: Schema.optional(Schema.String),
  state: Schema.Literals(["prepared", "unknown", "created", "complete"]),
})
export type BaselineIntent = typeof BaselineIntentSchema.Type
export interface PublicationIntegrityRepository {
  readonly prepare: (intent: IntegrityIntent) => Effect.Effect<void, SkillsError>
  readonly update: (intent: IntegrityIntent) => Effect.Effect<void, SkillsError>
  readonly inspect: (operationId: string) => Effect.Effect<IntegrityIntent | undefined, SkillsError>
  readonly saveBaseline: (intent: BaselineIntent) => Effect.Effect<void, SkillsError>
  readonly baseline: (operationId: string) => Effect.Effect<BaselineIntent | undefined, SkillsError>
  readonly baselines: (
    parentPageId: string,
  ) => Effect.Effect<readonly BaselineIntent[], SkillsError>
}

/** Registered by sqlite-state; these durable operations are outside cache retirement. */
export const publicationIntegrityMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE integrity_operations (operation_id TEXT PRIMARY KEY, publication_operation_id TEXT NOT NULL UNIQUE, intended_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('writing','committed')), page_id TEXT, payload TEXT NOT NULL)`
  yield* sql`CREATE TABLE upstream_baselines (operation_id TEXT PRIMARY KEY, parent_page_id TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','unknown','created','complete')), page_id TEXT, payload TEXT NOT NULL)`
  const previous = yield* sql<{
    key: string
    payload: string
  }>`SELECT key,payload FROM publication_integrity_ledgers`
  for (const row of previous) {
    if (row.key.startsWith("publication-integrity/")) {
      const historical = yield* Effect.try({
        try: () => JSON.parse(row.payload) as unknown,
        catch: () => fail("STATE_CORRUPT", "Publication integrity ledger contains invalid JSON."),
      })
      if (
        historical &&
        typeof historical === "object" &&
        "marker" in historical &&
        historical.marker &&
        typeof historical.marker === "object" &&
        "version" in historical.marker &&
        historical.marker.version === 1
      )
        return yield* Effect.fail(
          fail(
            "PUBLICATION_UPGRADE_REQUIRED",
            "Retained interim integrity ledger uses remote proof version 1; preserve its raw evidence for explicit state migration. Remote proof conversion does not rewrite this local ledger.",
            { audit_ref: row.key, proof_version: 1, required_proof_version: 2 },
          ),
        )
      const intent = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(IntegrityIntentSchema),
      )(row.payload)
      yield* sql`INSERT INTO integrity_operations ${sql.insert({ operation_id: intent.operation_id, publication_operation_id: intent.operation_id, intended_hash: intent.intended_hash, state: intent.marker.state, page_id: intent.page_id ?? null, payload: JSON.stringify(intent) })}`
    } else if (row.key.startsWith("upstream-baselines/")) {
      const intent = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(BaselineIntentSchema))(
        row.payload,
      )
      yield* sql`INSERT INTO upstream_baselines ${sql.insert({ operation_id: intent.operation_id, parent_page_id: intent.parent_page_id, hash: intent.hash, state: intent.state, page_id: intent.page_id ?? null, payload: JSON.stringify(intent) })}`
    } else if (!row.key.startsWith("upstream-publication/"))
      return yield* Effect.fail(
        fail("STATE_CORRUPT", "Unknown interim publication integrity ledger row."),
      )
  }
  yield* sql`DROP TABLE publication_integrity_ledgers`
})
export function makePublicationIntegrityRepository(
  sql: SqlClient.SqlClient,
): PublicationIntegrityRepository {
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((error) =>
        error instanceof SkillsError
          ? error
          : fail("INTEGRITY_STATE_ERROR", "Publication integrity SQL operation failed."),
      ),
    )
  const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
    Effect.try({
      try: () => Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" }),
      catch: () => fail("STATE_CORRUPT", "Publication integrity state failed its strict schema."),
    })
  const inspect = (id: string) =>
    run(
      Effect.gen(function* () {
        const rows = yield* sql<{
          payload: string
        }>`SELECT payload FROM integrity_operations WHERE operation_id=${id}`
        return rows[0]
          ? yield* Effect.gen(function* () {
              const raw = yield* Effect.try({
                try: () => JSON.parse(rows[0]!.payload) as unknown,
                catch: () =>
                  fail("STATE_CORRUPT", "Publication integrity state contains invalid JSON."),
              })
              if (
                raw &&
                typeof raw === "object" &&
                "marker" in raw &&
                raw.marker &&
                typeof raw.marker === "object" &&
                "version" in raw.marker &&
                raw.marker.version === 1
              )
                return yield* Effect.fail(
                  fail(
                    "PUBLICATION_UPGRADE_REQUIRED",
                    "Retained publication intent uses remote proof version 1; inspect its independent conversion evidence before starting a new version-2 publication.",
                    { operation_id: id, proof_version: 1, required_proof_version: 2 },
                  ),
                )
              return yield* decode(IntegrityIntentSchema, raw)
            })
          : undefined
      }),
    )
  return {
    inspect,
    prepare: (value) =>
      run(
        sql.withTransaction(
          Effect.gen(function* () {
            const intent = yield* decode(IntegrityIntentSchema, value)
            if (
              intent.marker.operation_id !== intent.operation_id ||
              intent.marker.intended_hash !== intent.intended_hash ||
              intent.marker.state !== "writing"
            )
              return yield* Effect.fail(
                fail("PUBLICATION_INTENT_CONFLICT", "Prepared intent and remote marker disagree."),
              )
            const existing = yield* inspect(intent.operation_id)
            if (existing) {
              if (existing.intended_hash !== intent.intended_hash)
                return yield* Effect.fail(
                  fail(
                    "PUBLICATION_INTENT_CONFLICT",
                    "Publication identity already has another intended revision.",
                  ),
                )
              return
            }
            yield* sql`INSERT INTO integrity_operations ${sql.insert({ operation_id: intent.operation_id, publication_operation_id: intent.operation_id, intended_hash: intent.intended_hash, state: intent.marker.state, page_id: intent.page_id ?? null, payload: JSON.stringify(intent) })}`
          }),
        ),
      ),
    update: (value) =>
      run(
        sql.withTransaction(
          Effect.gen(function* () {
            const intent = yield* decode(IntegrityIntentSchema, value)
            const previous = yield* inspect(intent.operation_id)
            if (
              !previous ||
              previous.intended_hash !== intent.intended_hash ||
              intent.marker.operation_id !== intent.operation_id ||
              intent.marker.intended_hash !== intent.intended_hash ||
              (previous.page_id && previous.page_id !== intent.page_id)
            )
              return yield* Effect.fail(
                fail(
                  "PUBLICATION_INTENT_CONFLICT",
                  "Publication identity or exact target changed.",
                ),
              )
            if (
              previous.marker.state === "committed" &&
              JSON.stringify(previous.marker) !== JSON.stringify(intent.marker)
            )
              return yield* Effect.fail(
                fail(
                  "PUBLICATION_INTENT_CONFLICT",
                  "An intended commit cannot be replaced or downgraded.",
                ),
              )
            yield* sql`UPDATE integrity_operations SET state=${intent.marker.state},page_id=${intent.page_id ?? null},payload=${JSON.stringify(intent)} WHERE operation_id=${intent.operation_id}`
          }),
        ),
      ),
    baseline: (id) =>
      run(
        Effect.gen(function* () {
          const rows = yield* sql<{
            payload: string
          }>`SELECT payload FROM upstream_baselines WHERE operation_id=${id}`
          return rows[0]
            ? yield* decode(Schema.fromJsonString(BaselineIntentSchema), rows[0].payload)
            : undefined
        }),
      ),
    baselines: (parentPageId) =>
      run(
        Effect.gen(function* () {
          const rows = yield* sql<{
            payload: string
          }>`SELECT payload FROM upstream_baselines WHERE parent_page_id=${parentPageId} ORDER BY operation_id`
          return yield* Effect.forEach(rows, (row) =>
            decode(Schema.fromJsonString(BaselineIntentSchema), row.payload),
          )
        }),
      ),
    saveBaseline: (value) =>
      run(
        sql.withTransaction(
          Effect.gen(function* () {
            const intent = yield* decode(BaselineIntentSchema, value)
            const rows = yield* sql<{
              payload: string
            }>`SELECT payload FROM upstream_baselines WHERE operation_id=${intent.operation_id}`
            if (rows[0]) {
              const previous = yield* decode(
                Schema.fromJsonString(BaselineIntentSchema),
                rows[0].payload,
              )
              const ranks = { prepared: 0, unknown: 1, created: 2, complete: 3 }
              if (
                previous.parent_page_id !== intent.parent_page_id ||
                previous.hash !== intent.hash ||
                previous.payload !== intent.payload ||
                (previous.page_id && previous.page_id !== intent.page_id) ||
                ranks[intent.state] < ranks[previous.state]
              )
                return yield* Effect.fail(
                  fail("BASELINE_INTENT_CONFLICT", "Baseline identity, target or payload changed."),
                )
            }
            yield* sql`INSERT INTO upstream_baselines ${sql.insert({ operation_id: intent.operation_id, parent_page_id: intent.parent_page_id, hash: intent.hash, state: intent.state, page_id: intent.page_id ?? null, payload: JSON.stringify(intent) })} ON CONFLICT(operation_id) DO UPDATE SET state=excluded.state,page_id=excluded.page_id,payload=excluded.payload`
          }),
        ),
      ),
  }
}
