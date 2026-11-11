import { Schema } from "effect"

export const INVENTORY_RULES = "resource-inventory-v1"
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const NullableText = Schema.NullOr(Schema.String)
export const InventoryFindingSchema = Schema.Struct({
  code: Schema.String,
  path: Schema.String,
  severity: Schema.Literals(["review", "blocked"]),
  details: Schema.Unknown,
})
export type InventoryFinding = typeof InventoryFindingSchema.Type
export const LocalInventoryFileSchema = Schema.Struct({
  path: Schema.String,
  real_path: Schema.String,
  bytes: Schema.Number,
  mode: Schema.Literals(["100644", "100755"]),
  sha256: Schema.NullOr(Hash),
  git_oid: NullableText,
  status: Schema.Literals(["verified", "unavailable", "changed", "budget_limited"]),
  sensitive: Schema.Boolean,
  metadata_identity: Schema.String,
})
export type LocalInventoryFile = typeof LocalInventoryFileSchema.Type
export const LocalInventoryIdentitySchema = Schema.Struct({
  page_id: NullableText,
  library_id: NullableText,
  skill_id: NullableText,
  source_id: NullableText,
  member: NullableText,
  repository: NullableText,
  commit: NullableText,
  source_path: NullableText,
  authority: Schema.Literals([
    "notion_handoff",
    "fixed_install_provenance",
    "explicit_identity",
    "unverified",
  ]),
  evidence_file: NullableText,
  declared_path: Schema.optional(Schema.String),
})
export type LocalInventoryIdentity = typeof LocalInventoryIdentitySchema.Type
export const LocalInventoryEntitySchema = Schema.Struct({
  entity_id: Schema.String,
  real_root: Schema.String,
  aliases: Schema.Array(Schema.String),
  name: Schema.String,
  main: Schema.String,
  manifest_sha256: Hash,
  input_content_sha256: Schema.optional(Schema.NullOr(Hash)),
  files: Schema.Array(LocalInventoryFileSchema),
  discovery_identity: Schema.optional(
    Schema.Struct({ mode: NullableText, canonical_name: NullableText, config_file: NullableText }),
  ),
  derived_origin: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        canonical_name: Schema.String,
        candidate_entity_ids: Schema.Array(Schema.String),
        config_file: Schema.String,
        verification: Schema.Literal("configuration_codec_candidate"),
        body_comparison: Schema.Literals(["exact", "different", "unobserved"]),
      }),
    ),
  ),
  identities: Schema.Array(LocalInventoryIdentitySchema),
  git: Schema.Struct({
    repository_root: NullableText,
    head: NullableText,
    dirty: Schema.NullOr(Schema.Boolean),
    changed_paths: Schema.Array(Schema.String),
  }),
  classification: Schema.Literals([
    "managed_candidate",
    "upstream_candidate",
    "local_custom",
    "derived_projection",
    "review_required",
  ]),
  findings: Schema.Array(InventoryFindingSchema),
})
export type LocalInventoryEntity = typeof LocalInventoryEntitySchema.Type
export const LocalSkillInventorySchema = Schema.Struct({
  version: Schema.Literal(1),
  rules_version: Schema.Literal(INVENTORY_RULES),
  manifest_id: Schema.String,
  scope: Schema.Struct({
    roots: Schema.Array(Schema.String),
    allow_targets: Schema.Array(Schema.String),
    provenance_files: Schema.Array(Schema.String),
    discovery: Schema.Literal("first_entrypoint_per_branch"),
  }),
  observation_interval: Schema.Struct({
    from: Schema.Number,
    to: Schema.Number,
    atomic_snapshot: Schema.Literal(false),
  }),
  coverage: Schema.Literals(["full", "partial"]),
  entities: Schema.Array(LocalInventoryEntitySchema),
  unassigned_files: Schema.Array(LocalInventoryFileSchema),
  aliases: Schema.Array(
    Schema.Struct({
      logical_path: Schema.String,
      real_path: NullableText,
      boundary: Schema.Literals(["allowed", "outside_scope", "broken", "cycle_or_alias"]),
    }),
  ),
  findings: Schema.Array(InventoryFindingSchema),
  provenance: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      sha256: Schema.NullOr(Hash),
      status: Schema.Literals(["verified", "unavailable", "invalid", "changed"]),
    }),
  ),
  metrics: Schema.Struct({
    entries: Schema.Number,
    files: Schema.Number,
    bytes: Schema.Number,
    elapsed_ms: Schema.Number,
    limit: NullableText,
    byte_overshoot: Schema.Number,
    byte_policy: Schema.Literal("at_most_one_probe_byte"),
    duration_policy: Schema.Literal("between_filesystem_operations"),
  }),
  source_writes: Schema.Literal(0),
  remote_writes: Schema.Literal(0),
})
export type LocalSkillInventory = typeof LocalSkillInventorySchema.Type
export const InventoryArtifactSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literals(["local", "remote", "reconciliation"]),
  sha256: Hash,
  payload: Schema.Unknown,
})

export const emptyLocalIdentity = (): LocalInventoryIdentity => ({
  page_id: null,
  library_id: null,
  skill_id: null,
  source_id: null,
  member: null,
  repository: null,
  commit: null,
  source_path: null,
  authority: "unverified",
  evidence_file: null,
})
