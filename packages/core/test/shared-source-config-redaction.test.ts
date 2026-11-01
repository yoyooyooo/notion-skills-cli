import { expect, test } from "bun:test"
import { Schema } from "effect"
import {
  publicSourceResourceConfiguration,
  SourceResourceConfigurationSchema,
} from "../src/shared-source-config-model.ts"

test("generic configuration output cannot echo secrets from malformed origin/manifest fields", () => {
  const config = Schema.decodeUnknownSync(SourceResourceConfigurationSchema)({
    version: 1,
    machine_scope: "machine-test",
    workspaces: [
      {
        workspace_scope: "workspace-test",
        absolute_root: "/private/workspace",
        bindings: [{ binding_key: "assets", absolute_root: "/private/assets" }],
      },
    ],
    http: {
      allowed_origins: [
        "https://resources.example.com",
        "https://resources.example.com/object?signature=secret-query",
        "https://user:secret-password@resources.example.com",
      ],
      locations_by_manifest: {
        "https://resources.example.com/object?signature=secret-key": [
          {
            sha256: "1".repeat(64),
            url: "https://resources.example.com/object?signature=secret-location",
          },
        ],
      },
    },
  })
  const output = publicSourceResourceConfiguration(config),
    serialized = JSON.stringify(output)
  expect(output.http.allowed_origins).toEqual([
    "https://resources.example.com",
    "[invalid origin]",
    "[invalid origin]",
  ])
  expect(output.http.location_overrides).toEqual([
    { manifest_id: "[invalid manifest]", object_count: 1 },
  ])
  for (const excluded of [
    "/private",
    "secret-query",
    "secret-password",
    "secret-key",
    "secret-location",
  ])
    expect(serialized).not.toContain(excluded)
})
