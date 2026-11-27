import { Notion } from "../src/notion.ts"
import { sourceRich } from "../src/shared-source-definitions.ts"
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { property, text } from "../src/model.ts"
import { trashPath } from "../src/local-locks.ts"
import { queryCurrentSkillIndex } from "../src/shared-current-index.ts"
import { inspectSourceSkillAdoption } from "../src/shared-current-source-adoption.ts"
import { writePreparedCurrentSource } from "../src/shared-current-source-write.ts"
import {
  sourceRegistrationDigest,
  readMaterializationRegistration,
} from "../src/shared-source-materialization-registration.ts"
import { resolveCurrentSourceContributions } from "../src/shared-current-source-input.ts"
import {
  library,
  materializationFixture,
  sourceId,
} from "./shared-source-materialization-fixture.ts"

const root = mkdtempSync(join(tmpdir(), "source-materialization-unit-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
})
const field = (row: unknown, name: string) => property(property(property(row).properties)[name])

test("legacy adoption preserves page, Main File ID and manual flags", async () => {
  const f = await materializationFixture(root)
  const request = await f.request()
  const receipt = await f.materialize(request)
  expect(receipt).toMatchObject({
    status: "ready",
    effects: { remote_writes: "management", projection: "none" },
  })
  expect(receipt.records.map((record) => record.name).sort()).toEqual(["required", "root"])
  const index = await f.run(queryCurrentSkillIndex(library, f.owners.get("root")!))
  expect(index.main.file_id).toBe("legacy-main-root")
  expect(index.page_id).toBe(f.owners.get("root")!)
  expect(field(f.pages.get(index.page_id), "日用").checkbox).toBe(false)
  expect(field(f.pages.get(index.page_id), "期望删除").checkbox).toBe(false)
  expect(f.table("skills")).toHaveLength(3)
  expect(
    f.calls.filter((call) => /markdown|blocks/.test(call.path) && call.method !== "GET"),
  ).toEqual([])
  f.clearCalls()
  const before = f.preparedCount()
  expect(await f.materialize({ ...request, request_id: "new-session" })).toMatchObject({
    status: "already_ready",
    effects: { remote_writes: "none" },
  })
  expect(f.mutations()).toEqual([])
  expect(f.preparedCount()).toBe(before)
})

test("additive scope retains unrequested legacy members without initializing them", async () => {
  const f = await materializationFixture(root, "legacy-members")
  expect(await f.materialize(await f.request())).toMatchObject({ status: "ready" })
  const source = await f.run(readMaterializationRegistration(library, sourceId))
  expect(source.contributions).toHaveLength(3)
  const sibling = f.pages.get(f.owners.get("sibling")!)
  expect(text(field(sibling, library.skills.property_ids.Content!).rich_text)).toBe("")
  expect(field(sibling, library.skills.property_ids["Current State"]!).select).toBeNull()
  expect(field(sibling, library.skills.property_ids.Enabled!).checkbox).toBe(false)
})

test("source-only first use preserves manifest and creates one exact member", async () => {
  const f = await materializationFixture(root, "source-only")
  const assigned = await f.run(
    resolveCurrentSourceContributions({
      source_id: sourceId,
      members: ["skills/root"],
      overrides: [],
    }),
  )
  const receipt = await f.materialize(await f.request("use", assigned[0]!.skill_id))
  expect(receipt).toMatchObject({ status: "ready" })
  expect(f.table("skills")).toHaveLength(1)
  const source = await f.run(readMaterializationRegistration(library, sourceId))
  expect(source.current?.revision).toBe(f.full.prepared_source.revision)
  expect(source.contributions.map((entry) => entry.member_key)).toEqual(["skills/root"])
})

test("inspect materializes only its exact root and leaves Requires uninitialized", async () => {
  const f = await materializationFixture(root)
  const receipt = await f.materialize(await f.request("inspect"))
  expect(receipt).toMatchObject({ status: "ready" })
  expect(receipt.records.map((record) => record.name)).toEqual(["root"])
  expect(
    text(
      field(f.pages.get(f.owners.get("required")!), library.skills.property_ids.Content!).rich_text,
    ),
  ).toBe("")
})

test("materialization refuses changed registration before any semantic write", async () => {
  const f = await materializationFixture(root)
  const request = await f.request()
  const receipt = await f.materialize({
    ...request,
    target: { ...request.target, registration_digest: "f".repeat(64) },
  })
  expect(receipt).toMatchObject({
    status: "blocked",
    reason: "SOURCE_REGISTRATION_CHANGED",
    effects: { remote_writes: "none" },
  })
  expect(f.mutations()).toEqual([])
})

test("ready root still materializes its missing Requires and ignores Members", async () => {
  const f = await materializationFixture(root)
  expect(await f.materialize(await f.request("inspect"))).toMatchObject({ status: "ready" })
  const before = await f.run(queryCurrentSkillIndex(library, f.owners.get("root")!))
  expect(await f.materialize(await f.request("use"))).toMatchObject({ status: "ready" })
  const after = await f.run(queryCurrentSkillIndex(library, f.owners.get("root")!))
  expect(after.main.file_id).toBe(before.main.file_id)
  expect(after.main.content).toMatchObject({
    sha256: "sha256" in before.main.content ? before.main.content.sha256 : "invalid",
  })
  expect(after.main.content).not.toEqual(before.main.content)
  expect(
    text(
      field(f.pages.get(f.owners.get("sibling")!), library.skills.property_ids.Content!).rich_text,
    ),
  ).toBe("")
})

test("materialization refuses native authority at a contributed path without writes", async () => {
  const f = await materializationFixture(root)
  const p = library.files.property_ids
  await f.run(
    Effect.flatMap(Notion, (api) =>
      api.request(
        "v1/pages",
        {
          parent: { type: "data_source_id", data_source_id: library.files.data_source_id },
          properties: {
            [p.Name!]: { title: sourceRich("run.sh") },
            [p["File ID"]!]: { rich_text: sourceRich("human-script") },
            [p.Path!]: { rich_text: sourceRich("run.sh") },
            [p.Skill!]: { relation: [{ id: f.owners.get("root") }] },
            [p.Content!]: {
              rich_text: sourceRich(
                JSON.stringify({ kind: "native", mode: "100755", frontmatter: "" }),
              ),
            },
          },
        },
        { method: "POST" },
      ),
    ),
  )
  f.clearCalls()
  expect(await f.materialize(await f.request("inspect"))).toMatchObject({
    status: "blocked",
    reason: "CURRENT_SOURCE_WRITE_CONFLICT",
  })
  expect(f.mutations()).toEqual([])
})

test("a declared member with a missing physical owner is not recreated", async () => {
  const f = await materializationFixture(root, "legacy-members")
  const request = await f.request("inspect")
  f.pages.get(f.owners.get("root")!)!.in_trash = true
  f.clearCalls()
  expect(await f.materialize(request)).toMatchObject({
    status: "blocked",
    reason: "SOURCE_MEMBER_OWNER_MISSING",
    effects: { remote_writes: "none" },
  })
  expect(f.mutations()).toEqual([])
})

test("additive writer refuses a scope that omits an already materialized owner", async () => {
  const f = await materializationFixture(root)
  expect(await f.materialize(await f.request("inspect"))).toMatchObject({ status: "ready" })
  const registration = await f.run(readMaterializationRegistration(library, sourceId))
  const adoption = await f.run(
    inspectSourceSkillAdoption(library, f.pages.get(f.owners.get("required")!)),
  )
  const prepared = {
    ...f.full,
    targets: f.full.targets.filter((target) => target.skill_id === "legacy-required"),
  }
  f.clearCalls()
  const result = await f.runManaged(
    writePreparedCurrentSource(library, {
      operation_id: "omit-materialized-owner",
      prepared,
      materialization: {
        source_page_id: f.sourcePage,
        registration_digest: await f.run(sourceRegistrationDigest(registration)),
        skill_ids: ["legacy-required"],
        adoptions: [adoption],
      },
    }).pipe(Effect.result),
  )
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      code: "CURRENT_SOURCE_WRITE_CONFLICT",
      message: "A growing Source manifest must rebind every materialized owner.",
    },
  })
  expect(f.mutations()).toEqual([])
})

test("an unfinished legacy owner returns a pending receipt without writes", async () => {
  const f = await materializationFixture(root)
  await f.run(
    Effect.flatMap(Notion, (api) =>
      api.request(
        `v1/pages/${f.owners.get("root")}`,
        {
          properties: {
            [library.skills.property_ids["Current State"]!]: { select: { name: "applying" } },
            [library.skills.property_ids.Operation!]: {
              rich_text: sourceRich("earlier-operation"),
            },
          },
        },
        { method: "PATCH" },
      ),
    ),
  )
  f.clearCalls()
  expect(await f.materialize(await f.request("inspect"))).toMatchObject({
    status: "pending",
    reason: "CURRENT_OPERATION_PENDING",
    effects: { remote_writes: "none" },
  })
  expect(f.mutations()).toEqual([])
})
