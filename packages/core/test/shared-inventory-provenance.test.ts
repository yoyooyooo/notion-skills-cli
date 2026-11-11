import { expect, test } from "bun:test"
import {
  inventoryCanonicalAssetId,
  localInventoryProvenance,
} from "../src/shared-inventory-provenance.ts"

const commit = "a".repeat(40)
const config = {
  path: "/repo/.ak/assets.yaml",
  value: {
    version: 1,
    assets: {
      skills: {
        name: "auto",
        path: "skills/auto",
        layout: "skill-dir",
        roots: [{ name: "matt", path: "skills/matt", layout: "skill-dir" }],
      },
    },
  },
}

test("registered installation paths use configured mode plus the exact key without duplicating into", () => {
  const result = localInventoryProvenance([
    config,
    {
      path: "/repo/.ak/install-sources.json",
      value: {
        version: 1,
        skills: {
          "engineering/tool": {
            type: "git",
            mode: "matt",
            into: "engineering",
            installedName: "tool",
            cloneUrl: "https://github.com/example/source.git",
            sourcePath: "skills/tool",
            resolvedRef: commit,
          },
          agentcookie: {
            type: "git",
            installedName: "agentcookie",
            source: "example/cookie",
            sourcePath: "skills/cookie",
            resolvedRef: commit,
          },
        },
      },
    },
    {
      path: "/repo/.ak/upstreams.json",
      value: {
        version: 1,
        skills: {
          "engineering/tool": {
            mode: "fork",
            cloneUrl: "https://github.com/example/source.git",
            sourcePath: "skills/tool",
            baseRef: "main",
          },
        },
      },
    },
  ])
  expect(result.entries.map((entry) => entry.path)).toEqual([
    "/repo/skills/matt/engineering/tool",
    "/repo/skills/auto/agentcookie",
    "/repo/skills/matt/engineering/tool",
  ])
  expect(result.entries[0]?.identity.commit).toBe(commit)
  expect(result.entries[2]?.identity.commit).toBeNull()
  expect(result.entries[2]?.identity.authority).toBe("unverified")
  expect(result.findings).toEqual([])
})

test("missing modes and paths escaping configured roots remain unresolved", () => {
  const result = localInventoryProvenance([
    config,
    {
      path: "/repo/.ak/install-sources.json",
      value: {
        version: 1,
        skills: {
          "../../outside": { type: "git", installedName: "outside", resolvedRef: commit },
          missing: { type: "git", mode: "unknown", installedName: "missing", resolvedRef: commit },
        },
      },
    },
  ])
  expect(result.entries).toEqual([])
  expect(result.findings.map((finding) => finding.code)).toEqual([
    "INSTALL_PROVENANCE_OUTSIDE_MODE_ROOT",
    "INSTALL_MODE_ROOT_UNESTABLISHED",
  ])
})

test("view asset codec accepts only exact round trips and rejects malformed UTF-16 or base64", () => {
  expect(inventoryCanonicalAssetId("engineering__tool")).toBe("engineering/tool")
  const special = "literal__name/渲染"
  expect(inventoryCanonicalAssetId(`_ak1_${Buffer.from(special).toString("base64url")}`)).toBe(
    special,
  )
  expect(inventoryCanonicalAssetId("_ak1_%%%")).toBeUndefined()
  expect(inventoryCanonicalAssetId("_ak1__w")).toBeUndefined()
  expect(inventoryCanonicalAssetId("bad\ud800")).toBeUndefined()
  expect(
    inventoryCanonicalAssetId(`_ak1_${Buffer.from("simple").toString("base64url")}`),
  ).toBeUndefined()
})
