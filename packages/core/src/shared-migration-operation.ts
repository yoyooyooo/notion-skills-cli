/** Original SQL provenance is separate from any current remote operation outcome. */
export type MigrationOperationTable =
  | "upstream_commands"
  | "upstream_operations"
  | "integrity_operations"
export type MigrationOperationOrigin = {
  readonly version: 1
  readonly table: MigrationOperationTable
  readonly row_key: string
  readonly database_sha256: string
  readonly payload_sha256: string
  readonly payload_bytes: number
  readonly row_metadata: unknown
  readonly verified: boolean
  readonly receipt_ref: string
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0
const hash = (value: unknown): value is string => text(value) && /^[a-f0-9]{64}$/u.test(value)
const optionalText = (value: Record<string, unknown>, key: string) =>
  value[key] === undefined || text(value[key])
const strings = (value: unknown) => Array.isArray(value) && value.every(text)
const member = (value: unknown, values: readonly string[]) =>
  typeof value === "string" && values.includes(value)

function commandIdentity(raw: Record<string, unknown>) {
  if (
    !text(raw.scope) ||
    !text(raw.database_id) ||
    !member(raw.state, ["running", "unknown", "failed", "verified"]) ||
    (raw.phase !== undefined &&
      !member(raw.phase, ["preparing", "mutation_intended", "response_received"])) ||
    !optionalText(raw, "page_id")
  )
    return false
  // CommandFields.phase is optional in the original schema, including member commands.
  switch (raw.domain) {
    case "subscription_add":
      return text(raw.input_hash) && Object.keys(object(raw.input)).length > 0
    case "subscription_update":
      return (
        text(raw.page_id) && text(raw.expected_version) && Object.keys(object(raw.input)).length > 0
      )
    case "subscription_remove":
      return text(raw.page_id) && text(raw.expected_version)
    case "upstream_fork":
    case "upstream_track":
      return (
        text(raw.page_id) &&
        text(raw.subscription_id) &&
        text(raw.member_key) &&
        text(raw.expected_version) &&
        typeof raw.publication_required === "boolean" &&
        strings(raw.baseline_operation_ids) &&
        (raw.domain === "upstream_fork"
          ? strings(raw.baseline_before_ids) && text(raw.publisher_subscription_id)
          : text(raw.content_hash) && text(raw.revision))
      )
    default:
      return false
  }
}

function batchIdentity(raw: Record<string, unknown>, row: Record<string, unknown>) {
  return (
    text(raw.plan_id) &&
    raw.plan_id === row.plan_id &&
    raw.state === row.state &&
    text(raw.subscription_id) &&
    member(raw.state, ["running", "partial", "verified", "unknown"]) &&
    optionalText(raw, "scope") &&
    optionalText(raw, "database_id") &&
    optionalText(raw, "target_database_id") &&
    Array.isArray(raw.items) &&
    raw.items.every((value) => {
      const item = object(value)
      return (
        text(item.member_key) &&
        member(item.status, [
          "pending",
          "running",
          "verified",
          "retained",
          "fork",
          "conflict",
          "failed",
          "unknown",
        ]) &&
        optionalText(item, "page_id") &&
        optionalText(item, "publication_operation_id") &&
        optionalText(item, "error_code")
      )
    })
  )
}

function integrityIdentity(raw: Record<string, unknown>, row: Record<string, unknown>) {
  const marker = object(raw.marker)
  return (
    raw.version === 1 &&
    marker.version === 2 &&
    hash(raw.intended_hash) &&
    raw.operation_id === row.publication_operation_id &&
    raw.intended_hash === row.intended_hash &&
    marker.operation_id === raw.operation_id &&
    marker.intended_hash === raw.intended_hash &&
    marker.state === row.state &&
    optionalText(raw, "page_id") &&
    (raw.page_id ?? null) === (row.page_id ?? null) &&
    (marker.state === "writing"
      ? marker.base_revision === undefined || hash(marker.base_revision)
      : marker.state === "committed" &&
        hash(marker.revision) &&
        hash(marker.manifest_hash) &&
        hash(marker.ownership_hash))
  )
}

/** Validate only original family identity; local verified/committed never settles the operation. */
export function inspectMigrationOperation(input: {
  readonly legacy_id: string
  readonly raw: unknown
  readonly retention_verified?: boolean
  readonly retention_ref?: string
  readonly operation_origin?: MigrationOperationOrigin
}) {
  const raw = object(input.raw),
    origin = input.operation_origin
  if (origin === undefined)
    return {
      identity_verified:
        raw.operation_id === input.legacy_id &&
        text(raw.state) &&
        text(raw.phase) &&
        text(raw.scope),
      local_state: raw.state ?? null,
      state_field: "state" as const,
    }
  const row = object(origin.row_metadata)
  const provenance =
    origin.version === 1 &&
    origin.verified &&
    input.retention_verified === true &&
    text(input.retention_ref) &&
    text(origin.receipt_ref) &&
    text(input.legacy_id) &&
    origin.row_key === input.legacy_id &&
    raw.operation_id === input.legacy_id &&
    row.operation_id === input.legacy_id &&
    hash(origin.database_sha256) &&
    hash(origin.payload_sha256) &&
    Number.isSafeInteger(origin.payload_bytes) &&
    origin.payload_bytes > 0
  const identity =
    origin.table === "upstream_commands"
      ? commandIdentity(raw)
      : origin.table === "upstream_operations"
        ? batchIdentity(raw, row)
        : origin.table === "integrity_operations"
          ? integrityIdentity(raw, row)
          : false
  return {
    identity_verified: provenance && identity,
    local_state:
      origin.table === "integrity_operations"
        ? (object(raw.marker).state ?? null)
        : (raw.state ?? null),
    state_field:
      origin.table === "integrity_operations" ? ("marker.state" as const) : ("state" as const),
    table: origin.table,
  }
}
