import { expect, test } from "bun:test"
import { Effect } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { readFile } from "node:fs/promises"
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
test("actual frozen AK census preserves all registration classes, shared baselines and registry provenance", async () => {
  const root = "/Users/yoyo/.omp/state/orchestrate/ntn-skills-20261017/evidence/ak-census"
  const registrations = JSON.parse(await readFile(`${root}/artifact-137.json`, "utf8"))
  const bodies = JSON.parse(await readFile(`${root}/artifact-140.json`, "utf8"))
  const patch = JSON.parse(
    await readFile(
      "/Users/yoyo/Documents/code/ags/agent-kit/.ak/patches/cloudflare-links.json",
      "utf8",
    ),
  )
  const manifest = await Effect.runPromise(
    importAkCensus({
      registrations,
      bodies,
      target_database_id: "11111111-1111-4111-8111-111111111111",
      shared_publishers: { "ai-coding-os-core": "22222222-2222-4222-8222-222222222222" },
      patches: { ".ak/patches/cloudflare-links.json": patch },
    }).pipe(Effect.provide(NodeServices.layer)),
  )
  expect(manifest.counts).toEqual({ tracked_bodies: 379, individual: 45, source_groups: 13 })
  expect(manifest.uncovered).toEqual([])
  expect(
    manifest.sources.filter(
      (s) => s.lifecycle === "tracked" && s.registration.startsWith("skill:"),
    ),
  ).toHaveLength(37)
  const smip = manifest.sources.find((s) => s.registration === "source:smip")!,
    synpraxis = manifest.sources.find((s) => s.registration === "source:synpraxis")!
  expect(smip.config!.source.accepted_ref).not.toBe(synpraxis.config!.source.accepted_ref)
  expect(smip.members.map((m) => m.path)).toEqual(synpraxis.members.map((m) => m.path))
  expect(manifest.provenance.find((p) => p.name === "getnote")).toMatchObject({
    type: "registry",
    version: "1.8.8",
  })
  expect(manifest.sources.some((s) => s.registration === "skill:getnote")).toBe(false)
  expect(
    manifest.sources.find((s) => s.registration === "skill:cloudflare")!.config!.source.patch?.files
      .length,
  ).toBeGreaterThan(0)
  expect(
    manifest.sources.filter((s) => s.lifecycle !== "tracked").every((s) => s.config === null),
  ).toBe(true)
})
