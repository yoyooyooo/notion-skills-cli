import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Notion } from "../src/notion.ts"
import { property } from "../src/model.ts"
import { trashPath } from "../src/local-locks.ts"
import { discoverRegisteredSourceMembers } from "../src/shared-source-member-discovery.ts"
import { sourceRich } from "../src/shared-source-definitions.ts"
import { library, materializationFixture } from "./shared-source-materialization-fixture.ts"

const root = mkdtempSync(join(tmpdir(), "source-member-discovery-unit-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
})
async function nativeRouter(f: Awaited<ReturnType<typeof materializationFixture>>) {
  const p = library.skills.property_ids
  const raw = await f.run(
    Effect.flatMap(Notion, (api) =>
      api.request(
        "v1/pages",
        {
          parent: { type: "data_source_id", data_source_id: library.skills.data_source_id },
          properties: {
            [p.Name!]: { title: sourceRich("Native router") },
            [p.Description!]: { rich_text: sourceRich("Native root with source dependency") },
            [p.Kind!]: { select: { name: "router" } },
            [p.Enabled!]: { checkbox: true },
            [p["Default Context"]!]: { checkbox: false },
            [p["Skill ID"]!]: { rich_text: sourceRich("native-router") },
            [p["Main File ID"]!]: { rich_text: sourceRich("native-router-main") },
            [p.Content!]: {
              rich_text: sourceRich(
                JSON.stringify({ kind: "native", mode: "100644", frontmatter: "" }),
              ),
            },
            [p["Current State"]!]: { select: { name: "ready" } },
            [p.Operation!]: { rich_text: [] },
            [p.Origin!]: { relation: [] },
            [p.Requires!]: { relation: [{ id: f.owners.get("required") }] },
            [p.Members!]: { relation: [{ id: f.owners.get("sibling") }] },
          },
        },
        { method: "POST" },
      ),
    ),
  )
  f.clearCalls()
  return String(property(raw).id)
}

test("exact legacy discovery is read-only and retains physical identity without fake locator", async () => {
  const f = await materializationFixture(root)
  const result = await f.run(discoverRegisteredSourceMembers(library, { query: "legacy-root" }))
  expect(result).toMatchObject({ coverage: "complete", effects: { remote_writes: "none" } })
  expect(result.candidates).toHaveLength(1)
  expect(result.candidates[0]).toMatchObject({
    type: "source_member",
    expected_skill_id: "legacy-root",
    readiness: "materializable",
    record: { locator: { type: "shared_skill", page_id: f.owners.get("root")! } },
  })
  expect(f.mutations()).toEqual([])
})

test("native Router Requires grants only an exact revalidated dependency capability", async () => {
  const f = await materializationFixture(root)
  const page = await nativeRouter(f)
  const found = await f.run(
    discoverRegisteredSourceMembers(library, { requires_of: "native-router" }),
  )
  expect(found).toMatchObject({
    coverage: "complete",
    authorization_root: { skill_id: "native-router", page_id: page },
    root: { kind: "router" },
  })
  expect(found.candidates.map((candidate) => candidate.expected_skill_id)).toEqual([
    "legacy-required",
  ])
  expect(f.mutations()).toEqual([])
  const candidate = found.candidates[0]!
  const {
    source_id,
    member_key,
    expected_skill_id,
    registration_digest,
    expected_source_revision,
    expected_source_commit,
  } = candidate
  const receipt = await f.materialize({
    version: 1,
    library: library.library_id,
    request_id: "native-router-dependency",
    purpose: "use",
    target: {
      source_id,
      member_key,
      expected_skill_id,
      registration_digest,
      ...(expected_source_revision === undefined ? {} : { expected_source_revision }),
      ...(expected_source_commit === undefined ? {} : { expected_source_commit }),
    },
    authorization_root: found.authorization_root!,
  })
  expect(receipt).toMatchObject({ status: "ready", authorization_root: found.authorization_root })
  expect(receipt.records.map((record) => record.name)).toEqual(["required"])
})

test("changed native Requires authorization blocks before management writes", async () => {
  const f = await materializationFixture(root)
  const page = await nativeRouter(f)
  const found = await f.run(
    discoverRegisteredSourceMembers(library, { requires_of: "native-router" }),
  )
  await f.run(
    Effect.flatMap(Notion, (api) =>
      api.request(
        `v1/pages/${page}`,
        { properties: { [library.skills.property_ids.Requires!]: { relation: [] } } },
        { method: "PATCH" },
      ),
    ),
  )
  f.clearCalls()
  const candidate = found.candidates[0]!
  const receipt = await f.materialize({
    version: 1,
    library: library.library_id,
    request_id: "changed-native-closure",
    purpose: "use",
    target: {
      source_id: candidate.source_id,
      member_key: candidate.member_key,
      expected_skill_id: candidate.expected_skill_id,
      registration_digest: candidate.registration_digest,
    },
    authorization_root: found.authorization_root!,
  })
  expect(receipt).toMatchObject({
    status: "blocked",
    reason: "SOURCE_MATERIALIZATION_AUTHORITY_CHANGED",
    effects: { remote_writes: "none" },
  })
  expect(f.mutations()).toEqual([])
})

test("duplicate physical legacy identity never grants a materialization candidate", async () => {
  const f = await materializationFixture(root)
  const original = f.pages.get(f.owners.get("root")!)!
  const copy = structuredClone(original)
  copy.id = "00000000-0000-4000-8000-00000000ffff"
  f.pages.set(String(copy.id), copy)
  await expect(
    f.run(discoverRegisteredSourceMembers(library, { query: "legacy-root" })),
  ).rejects.toMatchObject({ code: "SOURCE_MEMBER_IDENTITY_AMBIGUOUS" })
  expect(f.mutations()).toEqual([])
})
