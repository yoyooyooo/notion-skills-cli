import { Schema } from "effect"

const Scope = Schema.String.check(
  Schema.isPattern(
    /^[^\s/\\\u0000-\u001f\u007f-\u009f](?:[^/\\\u0000-\u001f\u007f-\u009f]{0,254}[^\s/\\\u0000-\u001f\u007f-\u009f])?$/u,
  ),
)
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
export const SourceResourceConfigurationSchema = Schema.Struct({
  version: Schema.Literal(1),
  machine_scope: Scope,
  workspaces: Schema.Array(
    Schema.Struct({
      workspace_scope: Scope,
      absolute_root: Schema.String,
      bindings: Schema.Array(Schema.Struct({ binding_key: Scope, absolute_root: Schema.String })),
    }),
  ),
  http: Schema.Struct({
    allowed_origins: Schema.Array(Schema.String),
    locations_by_manifest: Schema.Record(
      Schema.String,
      Schema.Array(Schema.Struct({ sha256: Hash, url: Schema.String })),
    ),
  }),
})
export type SourceResourceConfiguration = typeof SourceResourceConfigurationSchema.Type

function publicOrigin(value: string): string {
  try {
    const url = new URL(value)
    if (
      url.protocol === "https:" &&
      url.origin === value &&
      url.username === "" &&
      url.password === "" &&
      url.port === ""
    )
      return url.origin
  } catch {
    /* Malformed machine state must not echo a retrieval URL or credential. */
  }
  return "[invalid origin]"
}

/** Generic configuration output never reveals local roots or retrieval URLs/query credentials. */
export function publicSourceResourceConfiguration(config: SourceResourceConfiguration) {
  return {
    version: config.version,
    machine_scope: config.machine_scope,
    workspaces: config.workspaces.map((workspace) => ({
      workspace_scope: workspace.workspace_scope,
      bindings: workspace.bindings.map((binding) => ({ binding_key: binding.binding_key })),
    })),
    http: {
      allowed_origins: config.http.allowed_origins.map(publicOrigin),
      location_overrides: Object.entries(config.http.locations_by_manifest)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([manifest_id, locations]) => ({
          manifest_id: /^files-[a-f0-9]{64}$/u.test(manifest_id)
            ? manifest_id
            : "[invalid manifest]",
          object_count: locations.length,
        })),
    },
  }
}
