import { Effect, Schema } from "effect"
import { fail, PageSchema, property, recordFromPage, SkillsError } from "./model.ts"
import { pageId } from "./ref.ts"
import type { SharedMigrationEntry } from "./shared-migration-plan.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Size = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const RetainedJsonSchema = Schema.Struct({
  json: Schema.String,
  sha256: Hash,
  bytes: Size,
  retention_ref: Schema.String,
})
const LegacyCatalogActivityV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  policy: Schema.Literal("legacy_catalog_active_page_v1"),
  catalog_row: RetainedJsonSchema,
  data_source_schema: RetainedJsonSchema,
})
const LegacyCatalogActivityV2Schema = Schema.Struct({
  version: Schema.Literal(2),
  policy: Schema.Literal("legacy_catalog_active_page_v2"),
  api_version: Schema.Literal("2026-03-11"),
  catalog_row: RetainedJsonSchema,
  data_source_schema: RetainedJsonSchema,
})
export const LegacyCatalogActivitySchema = Schema.Union([
  LegacyCatalogActivityV1Schema,
  LegacyCatalogActivityV2Schema,
])
const RetentionSchema = Schema.Struct({ sha256: Hash, bytes: Size, retention_ref: Schema.String })
const ActivationFields = {
  enabled: Schema.Literal(true),
  original_enabled: Schema.Literal("absent"),
  page_id: Schema.String,
  database_id: Schema.String,
  data_source_id: Schema.String,
  catalog_row: RetentionSchema,
  data_source_schema: RetentionSchema,
}
export const SharedMigrationActivationSchema = Schema.Union([
  Schema.Struct({ policy: Schema.Literal("legacy_catalog_active_page_v1"), ...ActivationFields }),
  Schema.Struct({
    policy: Schema.Literal("legacy_catalog_active_page_v2"),
    api_version: Schema.Literal("2026-03-11"),
    ...ActivationFields,
  }),
])
export type SharedMigrationActivation = typeof SharedMigrationActivationSchema.Type
export type MigrationConversionPolicy = "legacy_page_to_native_v1" | "legacy_page_to_native_v2"

const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail(
            "SHARED_MIGRATION_ACTIVATION_INVALID",
            "The retained legacy catalog activity evidence is invalid.",
          ),
  })
function reject(message: string): never {
  throw fail("SHARED_MIGRATION_ACTIVATION_INVALID", message)
}
function retained(value: typeof RetainedJsonSchema.Type) {
  return Effect.gen(function* () {
    if (
      !value.retention_ref ||
      new TextEncoder().encode(value.json).length !== value.bytes ||
      (yield* sha256(value.json)) !== value.sha256
    )
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_ACTIVATION_INVALID",
          "A complete retained catalog row or data-source schema differs from its frozen bytes.",
        ),
      )
    return yield* checked(() => {
      const decoded: unknown = JSON.parse(value.json)
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded))
        reject("Retain a complete original object, not a selected field summary.")
      return property(decoded)
    })
  })
}
function retention(value: typeof RetainedJsonSchema.Type) {
  const { json: _json, ...identity } = value
  return identity
}

/** The old ordinary-page catalog has no Enabled switch. Preserve its absence
 * and derive target activity only from the original complete row and schema.
 * This policy does not apply to shared records or generated/ordinary Routers. */
export function resolveMigrationActivation(
  entry: SharedMigrationEntry,
  policy: MigrationConversionPolicy,
) {
  return Effect.gen(function* () {
    if (policy === "legacy_page_to_native_v1") return undefined
    const evidence = yield* checked(() =>
      Schema.decodeUnknownSync(LegacyCatalogActivitySchema)(
        property(entry.metadata).legacy_catalog_activity,
        { onExcessProperty: "error" },
      ),
    )
    const row = yield* retained(evidence.catalog_row),
      schema = yield* retained(evidence.data_source_schema)
    return yield* checked(() => {
      const record = property(entry.record),
        locator = property(record.locator)
      if (
        entry.legacy_layout !== "ordinary_page" ||
        locator.type !== "notion_page" ||
        !["skill", "prompt"].includes(String(record.kind)) ||
        Object.hasOwn(record, "enabled")
      )
        reject(
          "The absent-switch policy is limited to ordinary legacy Skill/Prompt pages whose original record has no Enabled field. Explicit values, shared pages and Routers keep their original semantics.",
        )
      for (const value of [locator.page_id, locator.database_id, locator.data_source_id])
        if (typeof value !== "string" || pageId(value) !== value)
          reject(
            "The original catalog page and database/data-source identities must be exact canonical UUIDs.",
          )
      // API 2026-03-11 removed archived in favor of in_trash. Only the
      // explicitly versioned new evidence uses that contract; saved v1
      // evidence continues to require its original archived:false field.
      const invalidArchive =
        evidence.version === 1
          ? row.archived !== false
          : row.archived !== undefined && row.archived !== false
      if (
        row.object !== "page" ||
        row.id !== locator.page_id ||
        invalidArchive ||
        row.in_trash !== false ||
        (row.is_archived !== undefined && row.is_archived !== false)
      )
        reject(
          "The full original catalog row must affirm the same page is neither archived nor in trash; missing or contradictory activity flags remain unresolved.",
        )
      const parent = property(row.parent)
      if (
        parent.type !== "data_source_id" ||
        parent.data_source_id !== locator.data_source_id ||
        (parent.database_id !== undefined && parent.database_id !== locator.database_id)
      )
        reject("The original row belongs to another data source or database.")
      if (
        schema.object !== "data_source" ||
        schema.id !== locator.data_source_id ||
        property(schema.parent).type !== "database_id" ||
        property(schema.parent).database_id !== locator.database_id ||
        schema.in_trash === true
      )
        reject("The retained complete schema does not belong to the original legacy data source.")
      const schemaProperties = property(schema.properties),
        rowProperties = property(row.properties)
      const names = Object.keys(schemaProperties).sort(),
        rowNames = Object.keys(rowProperties).sort()
      if (names.length === 0 || canonicalSharedJson(names) !== canonicalSharedJson(rowNames))
        reject(
          "The complete original page and data-source property sets must agree; a filtered row cannot prove an absent switch.",
        )
      if (
        names.some(
          (name) => name === "Enabled" || property(schemaProperties[name]).name === "Enabled",
        )
      )
        reject(
          "An explicit Enabled property cannot be interpreted as the old absent-switch protocol.",
        )
      for (const name of names) {
        const definition = property(schemaProperties[name]),
          value = property(rowProperties[name])
        if (
          typeof definition.id !== "string" ||
          definition.id !== value.id ||
          typeof definition.type !== "string" ||
          definition.type !== value.type
        )
          reject("Original property IDs and types must match the retained data-source schema.")
      }
      const source = {
        alias: "",
        title: "",
        database_id: String(locator.database_id),
        data_source_ids: [String(locator.data_source_id)],
      }
      const reconstructed = recordFromPage(
        Schema.decodeUnknownSync(PageSchema)(row),
        source,
        String(locator.data_source_id),
      )
      // Catalog may append its known upstream label after recordFromPage; keep
      // that original field in legacy_entry while comparing the full core row.
      const { upstream: _upstream, ...original } = record
      if (canonicalSharedJson(reconstructed) !== canonicalSharedJson(original))
        reject(
          "The retained row does not reconstruct the exact original catalog metadata and identity.",
        )
      const facts = {
        enabled: true as const,
        original_enabled: "absent" as const,
        page_id: String(locator.page_id),
        database_id: String(locator.database_id),
        data_source_id: String(locator.data_source_id),
        catalog_row: retention(evidence.catalog_row),
        data_source_schema: retention(evidence.data_source_schema),
      }
      return evidence.version === 1
        ? ({ policy: evidence.policy, ...facts } satisfies SharedMigrationActivation)
        : ({
            policy: evidence.policy,
            api_version: evidence.api_version,
            ...facts,
          } satisfies SharedMigrationActivation)
    })
  })
}

/** Fresh intentions opt into the new policy only with explicit frozen evidence.
 * Existing v1 candidates are always validated under their saved policy. */
export function migrationConversionPolicy(entry: SharedMigrationEntry): MigrationConversionPolicy {
  return !Object.hasOwn(property(entry.record), "enabled") &&
    property(entry.metadata).legacy_catalog_activity !== undefined
    ? "legacy_page_to_native_v2"
    : "legacy_page_to_native_v1"
}
