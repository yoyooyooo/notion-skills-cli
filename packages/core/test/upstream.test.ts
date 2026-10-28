import { expect, test } from "bun:test"
import { Effect } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { importAkCensus } from "../src/upstream-census.ts"
import { mergeSharedDelta, contentDeltas } from "../src/upstream-content.ts"
import { strictDecode, UpstreamPlanSchema } from "../src/upstream-model.ts"
import type { FrozenPortable } from "../src/upstream-model.ts"
import { decodePublishedMembers } from "../src/upstream-subscription.ts"

const frozen = (files: Readonly<Record<string, string>>, name = "Alpha"): FrozenPortable => ({
  kind: "skill",
  name,
  description: "Use for controlled upstream tests",
  main: "SKILL.md",
  files: Object.entries(files).map(([path, hash]) => ({ path, hash })),
})
test("shared contributor delta preserves independently accepted peer files and reports overlapping edits", () => {
  const base = frozen({ "SKILL.md": "base", "peer.txt": "old", "retired.txt": "retired" })
  const current = frozen({
    "SKILL.md": "base",
    "peer.txt": "peer-new",
    "retired.txt": "retired",
    "peer-only.bin": "peer",
  })
  const candidate = frozen({ "SKILL.md": "contributor-new", "peer.txt": "old", "new.bin": "new" })
  const merged = mergeSharedDelta(base, current, candidate)
  expect(Object.fromEntries(merged.files.map((f) => [f.path, f.hash]))).toEqual({
    "SKILL.md": "contributor-new",
    "peer.txt": "peer-new",
    "peer-only.bin": "peer",
    "new.bin": "new",
  })
  expect(contentDeltas(base, candidate).map((d) => d.path)).toEqual([
    "SKILL.md",
    "new.bin",
    "retired.txt",
  ])
  expect(() =>
    mergeSharedDelta(base, frozen({ "SKILL.md": "peer-changed", "peer.txt": "old" }), candidate),
  ).toThrow("Contributors changed")
})
test("shared unchanged source never replaces accepted peer changes; entry deletion fails", () => {
  const base = frozen({ "SKILL.md": "base" }),
    current = frozen({ "SKILL.md": "peer", "peer.bin": "asset" })
  expect(
    Object.fromEntries(mergeSharedDelta(base, current, base).files.map((f) => [f.path, f.hash])),
  ).toEqual(Object.fromEntries(current.files.map((f) => [f.path, f.hash])))
  expect(() => mergeSharedDelta(base, base, frozen({}))).toThrow("entrypoint")
})
test("published active map rejects candidates, duplicate identity and excess configuration fields", () => {
  const member = {
    member_key: "skills/alpha",
    page_id: "11111111-1111-4111-8111-111111111111",
    content_hash: "a".repeat(64),
  }
  const doc = {
    version: 1,
    revision: "fixed-commit",
    plan_hash: "b".repeat(64),
    publisher_subscription_id: "22222222-2222-4222-8222-222222222222",
    members: [member],
  }
  expect(decodePublishedMembers(JSON.stringify(doc))?.members).toEqual([member])
  expect(decodePublishedMembers("")).toBeNull()
  expect(() =>
    decodePublishedMembers(JSON.stringify({ ...doc, members: [member, member] })),
  ).toThrow()
  expect(() => decodePublishedMembers(JSON.stringify({ ...doc, config: {} }))).toThrow()
  expect(() => strictDecode(UpstreamPlanSchema, { version: 1, candidate: true })).toThrow()
})
test("frozen AK census preserves registration classes, shared baselines and registry provenance", async () => {
  // Census input is portable; frames can end in the middle of a JSON line.
  const artifact = (rows: readonly Record<string, unknown>[]) => {
    const text = rows.map((row) => JSON.stringify(row)).join("\r\n")
    return {
      normalized_result: { frames: [{ data: text.slice(0, 19) }, { data: text.slice(19) }] },
    }
  }
  const individuals = [
    { name: "tracked-skill", mode: "tracked" },
    { name: "forked-skill", mode: "fork" },
    { name: "local-skill", mode: "local" },
    { name: "default-skill", mode: "local-default" },
  ] as const
  const shared = {
    file: ".ak/upstreams.json",
    section: "sources",
    mode: "tracked",
    cloneUrl: "https://example.invalid/shared.git",
    paths: ["skills/shared"],
    sharedTargetSet: "fixture-shared",
  }
  const provenance = {
    file: ".ak/install-sources.json",
    name: "registry-only",
    type: "registry",
    version: "1.2.3",
  }
  const registrations = artifact([
    ...individuals.map(({ name, mode }) => ({
      file: ".ak/upstreams.json",
      section: "skills",
      name,
      mode,
      cloneUrl: `https://example.invalid/${name}.git`,
      sourcePath: `skills/${name}`,
      ...(mode === "tracked" ? { patchPath: ".ak/patches/links.json" } : {}),
    })),
    { ...shared, name: "shared-left", acceptedRef: "1".repeat(40) },
    { ...shared, name: "shared-right", acceptedRef: "2".repeat(40) },
    provenance,
  ])
  const bodies = artifact([
    ...individuals.map(({ name, mode }) => ({
      path: `skills/${name}/SKILL.md`,
      line: 1,
      root: `skills/${name}`,
      name,
      mode,
      groups: [],
      provenance: false,
    })),
    ...["alpha", "beta"].map((name) => ({
      path: `skills/shared/${name}/SKILL.md`,
      line: 1,
      root: `skills/shared/${name}`,
      name,
      mode: "tracked",
      groups: ["shared-left", "shared-right"],
      provenance: false,
    })),
    {
      path: "skills/registry-only/SKILL.md",
      line: 1,
      root: "skills/registry-only",
      name: "registry-only",
      mode: "local",
      groups: [],
      provenance: true,
    },
  ])
  const patch = {
    version: 1 as const,
    files: [{ path: "SKILL.md", replacements: [{ from: "./old-guide.md", to: "./guide.md" }] }],
  }
  const manifest = await Effect.runPromise(
    importAkCensus({
      registrations,
      bodies,
      target_database_id: "11111111-1111-4111-8111-111111111111",
      shared_publishers: { "fixture-shared": "22222222-2222-4222-8222-222222222222" },
      patches: { ".ak/patches/links.json": patch },
    }).pipe(Effect.provide(NodeServices.layer)),
  )
  expect(manifest.counts).toEqual({ tracked_bodies: 3, individual: 4, source_groups: 2 })
  expect(manifest.uncovered).toEqual([])
  expect(manifest.migration_ready).toBe(true)
  expect(manifest.sources.map((s) => [s.registration, s.lifecycle])).toEqual([
    ["skill:tracked-skill", "tracked"],
    ["skill:forked-skill", "fork"],
    ["skill:local-skill", "local"],
    ["skill:default-skill", "local-default"],
    ["source:shared-left", "tracked"],
    ["source:shared-right", "tracked"],
  ])
  const left = manifest.sources.find((s) => s.registration === "source:shared-left")!,
    right = manifest.sources.find((s) => s.registration === "source:shared-right")!
  for (const [source, acceptedRef] of [
    [left, "1".repeat(40)],
    [right, "2".repeat(40)],
  ] as const) {
    expect(source.config?.source).toMatchObject({
      shared_target_set: "fixture-shared",
      publisher_subscription_id: "22222222-2222-4222-8222-222222222222",
      accepted_ref: acceptedRef,
    })
    expect(source.members.map((m) => m.path)).toEqual([
      "skills/shared/alpha/SKILL.md",
      "skills/shared/beta/SKILL.md",
    ])
  }
  expect(manifest.provenance).toEqual([provenance])
  expect(manifest.sources.some((s) => s.registration === "skill:registry-only")).toBe(false)
  expect(
    manifest.sources.find((s) => s.registration === "skill:tracked-skill")?.config?.source.patch,
  ).toEqual(patch)
  expect(
    manifest.sources.filter((s) => s.lifecycle !== "tracked").every((s) => s.config === null),
  ).toBe(true)
})
