import { afterAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { trashPath } from "../src/local-locks.ts"
import { property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { queryCurrentSkillIndex } from "../src/shared-current-index.ts"
import {
  changeCurrentSourceEnabled,
  queryCurrentSourceReferences,
  removeCurrentSource,
} from "../src/shared-current-source-lifecycle.ts"
import {
  currentSourceWriteProperties,
  queryCurrentSourceManagement,
} from "../src/shared-current-source-management.ts"
import { prepareCurrentSharedSourceContent } from "../src/shared-current-source.ts"
import { currentOwnedResourceCreateRequest } from "../src/shared-current-records.ts"
import { prepareCurrentSharedResource } from "../src/shared-current-resource.ts"
import { prepareCurrentSkillWrite, writeCurrentSkill } from "../src/shared-current-write.ts"
import { sourceRich } from "../src/shared-source-definitions.ts"
import { currentWriteFixture, id, library, testBytes } from "./shared-current-write-fixture.ts"

const parent = mkdtempSync(join(tmpdir(), "ntn-current-source-lifecycle-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
const original = testBytes("# Exact source original\n")
type Fixture = ReturnType<typeof currentWriteFixture>
async function seedSource(f: Fixture, enabled = true) {
  return f.run(
    Effect.gen(function* () {
      const selected = yield* prepareCurrentSharedSourceContent({
        version: 1,
        kind: "composition",
        base: {
          kind: "http",
          manifest: {
            version: 1,
            files: [
              {
                path: "member/SKILL.md",
                sha256: digest(original),
                bytes: original.byteLength,
                mode: "100644",
              },
            ],
          },
          locations: [
            {
              sha256: digest(original),
              url: "https://raw.githubusercontent.com/example/skills/fixed/SKILL.md",
            },
          ],
        },
        mounts: [],
      })
      const properties = currentSourceWriteProperties(library, {
        declaration: {
          version: 1,
          definition: {
            version: 1,
            source_id: "managed",
            name: "Managed",
            description: "Current selected source",
            enabled,
            policy: "manual",
            adapter: { type: "git", url: "https://github.com/example/skills", ref: "main" },
            selection: { roots: ["member"], include: [], exclude: [], mapping: {} },
            options: {},
          },
          contributions: [
            { member_key: "member", skill_id: "human", mount_path: "", mapping: {}, exclude: [] },
          ],
        },
        content: selected.content,
        revision: selected.revision,
      })
      const raw = yield* (yield* Notion).request(
        "v1/pages",
        {
          parent: { type: "data_source_id", data_source_id: library.sources.data_source_id },
          properties: {
            ...properties,
            status: { select: { name: "ready" } },
            operation: { rich_text: [] },
          },
        },
        { method: "POST" },
      )
      return { page_id: String(property(raw).id), ...selected }
    }),
  )
}
async function seedSkill(f: Fixture) {
  const plan = await f.run(
    prepareCurrentSkillWrite({
      skill_id: "human",
      kind: "skill",
      name: "Human",
      description: "Keep author decisions",
      enabled: false,
      files: [
        {
          path: "SKILL.md",
          file_id: "human-main",
          bytes: testBytes("---\nname: Human\ndescription: Keep author decisions\n---\n# Author\n"),
          authority: { kind: "native" },
        },
        { path: "notes.md", file_id: "human-note", bytes: testBytes("# Supporting original\n") },
      ],
    }),
  )
  return f.run(writeCurrentSkill(library, { plan, operation_id: "seed-human" }))
}
const pendingKeys = (f: Fixture) =>
  [...f.json.keys()].filter((key) => key.startsWith("operations/current-write-pending/"))
const operations = (f: Fixture) =>
  f
    .table("records")
    .filter((row) => property(property(property(row.properties).kind).select).name === "operation")
const sourceContent = (revision: string) => ({
  kind: "source",
  source_id: "managed",
  revision,
  source_path: "member/SKILL.md",
  sha256: digest(original),
  bytes: original.byteLength,
  mode: "100644",
})

test("Source disable/enable preserves Skill metadata and exposes exact affected bindings; equal toggle writes nothing", async () => {
  const f = currentWriteFixture(parent)
  const skill = await seedSkill(f),
    source = await seedSource(f)
  f.clearCalls()
  const inspected = await f.run(
    changeCurrentSourceEnabled(library, {
      source_id: "managed",
      enabled: false,
      operation_id: "disable-check",
      dry_run: true,
    }),
  )
  expect(inspected.status).toBe("inspected")
  expect(f.mutations()).toHaveLength(0)
  const disabled = await f.run(
    changeCurrentSourceEnabled(library, {
      source_id: "managed",
      enabled: false,
      operation_id: "disable",
    }),
  )
  expect(disabled).toMatchObject({
    action: "enabled",
    enabled: false,
    status: "applied",
    state: "ready",
    affected_skill_ids: ["human"],
    targets: [{ skill_id: "human", skill_page_id: skill.page_id }],
  })
  expect(f.mutations().some((call) => call.path === `v1/pages/${skill.page_id}`)).toBe(false)
  expect((await f.run(queryCurrentSkillIndex(library, skill.page_id))).enabled).toBe(false)
  expect(
    (await f.run(queryCurrentSourceManagement(library, "managed")))?.declaration.definition.enabled,
  ).toBe(false)
  expect(pendingKeys(f)).toEqual([])
  expect(operations(f)).toEqual([])
  f.clearCalls()
  expect(
    (
      await f.run(
        changeCurrentSourceEnabled(library, {
          source_id: "managed",
          enabled: false,
          operation_id: "equal-disable",
        }),
      )
    ).status,
  ).toBe("unchanged")
  expect(f.mutations()).toHaveLength(0)
  expect(
    (
      await f.run(
        changeCurrentSourceEnabled(library, {
          source_id: "managed",
          enabled: true,
          operation_id: "enable",
        }),
      )
    ).source_page_id,
  ).toBe(source.page_id)
  expect((await f.run(queryCurrentSkillIndex(library, skill.page_id))).enabled).toBe(false)
})

for (const outcome of ["accepted", "absent"] as const)
  test(`Source enabled ${outcome} response loss resumes the same finite action`, async () => {
    const f = currentWriteFixture(parent)
    await seedSkill(f)
    await seedSource(f)
    f.failNext({ kind: "source-enabled", outcome })
    const input = { source_id: "managed", enabled: false, operation_id: `disable-${outcome}` }
    expect((await f.run(changeCurrentSourceEnabled(library, input).pipe(Effect.result)))._tag).toBe(
      "Failure",
    )
    expect(pendingKeys(f)).toHaveLength(1)
    expect(
      await f.run(changeCurrentSourceEnabled(library, { ...input, mode: "resume" })),
    ).toMatchObject({ state: "ready" })
    expect(pendingKeys(f)).toEqual([])
    expect(operations(f)).toEqual([])
  })

test("Source removal finds semantic Main/Files references even without Origin, and refuses stale Origin alone", async () => {
  const f = currentWriteFixture(parent)
  const skill = await seedSkill(f),
    source = await seedSource(f)
  const index = await f.run(queryCurrentSkillIndex(library, skill.page_id))
  for (const binding of [index.main, ...index.files]) {
    const fields = property(f.pages.get(binding.page_id)!.properties)
    const before = structuredClone(fields.content)
    fields.content = {
      id: "content",
      type: "rich_text",
      has_more: false,
      rich_text: sourceRich(
        JSON.stringify(sourceContent(source.revision)).replace('"managed"', '"man\\u0061ged"'),
      ),
    }
    f.clearCalls()
    const result = await f.run(
      removeCurrentSource(library, { source_id: "managed", operation_id: "blocked" }).pipe(
        Effect.result,
      ),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure.code).toBe("CURRENT_SOURCE_REFERENCED")
      expect(property(result.failure.details).files).toEqual([
        {
          skill_id: "human",
          skill_page_id: skill.page_id,
          file_id: binding.file_id,
          file_page_id: binding.page_id,
          path: binding.path,
        },
      ])
    }
    expect(f.mutations()).toHaveLength(0)
    fields.content = before
  }
  property(f.pages.get(skill.page_id)!.properties).origin = {
    id: "origin",
    type: "relation",
    relation: [{ id: source.page_id }],
    has_more: false,
  }
  f.clearCalls()
  const stale = await f.run(
    removeCurrentSource(library, { source_id: "managed", operation_id: "stale-origin" }).pipe(
      Effect.result,
    ),
  )
  expect(stale._tag).toBe("Failure")
  if (stale._tag === "Failure")
    expect(property(stale.failure.details).next).toBe("correct_current_origin")
  expect(f.mutations()).toHaveLength(0)
})

test("an explicit successor can change an interrupted enabled intent without replacing the Source or Skill", async () => {
  const f = currentWriteFixture(parent)
  const skill = await seedSkill(f),
    source = await seedSource(f)
  f.failNext({ kind: "source-enabled", outcome: "accepted" })
  expect(
    (
      await f.run(
        changeCurrentSourceEnabled(library, {
          source_id: "managed",
          enabled: false,
          operation_id: "old-disable",
        }).pipe(Effect.result),
      )
    )._tag,
  ).toBe("Failure")
  const record = operations(f)[0]!.id
  f.clearCalls()
  const successor = {
    source_id: "managed",
    enabled: true,
    operation_id: "new-enable",
    mode: { kind: "supersede", operation_id: "old-disable" },
  } satisfies Parameters<typeof changeCurrentSourceEnabled>[1]
  f.failNext({ kind: "source-enabled", outcome: "accepted" })
  expect(
    (await f.run(changeCurrentSourceEnabled(library, successor).pipe(Effect.result)))._tag,
  ).toBe("Failure")
  const result = await f.run(changeCurrentSourceEnabled(library, successor))
  expect(result).toMatchObject({
    action: "enabled",
    enabled: true,
    state: "ready",
    source_page_id: source.page_id,
    operation_id: "new-enable",
  })
  expect(f.calls.some((call) => call.path === "v1/pages" && call.method === "POST")).toBe(false)
  expect(f.pages.get(String(record))?.in_trash).toBe(true)
  expect(f.mutations().some((call) => call.path === `v1/pages/${skill.page_id}`)).toBe(false)
  expect(pendingKeys(f)).toEqual([])
  expect(operations(f)).toEqual([])
})

test("complete Source reference census catches an orphan File and paginates independent Files without body GETs", async () => {
  const f = currentWriteFixture(parent)
  const skill = await seedSkill(f)
  await seedSource(f)
  const source = (await f.run(queryCurrentSourceManagement(library, "managed")))!
  const first = f.table("files")[0]!
  for (let n = 0; n < 101; n++) {
    const copy = structuredClone(first),
      fields = property(copy.properties)
    copy.id = id(1000 + n)
    fields["file-id"] = {
      id: "file-id",
      type: "rich_text",
      rich_text: sourceRich(`extra-${n}`),
      has_more: false,
    }
    fields.path = {
      id: "path",
      type: "rich_text",
      rich_text: sourceRich(`extra-${n}.md`),
      has_more: false,
    }
    f.pages.set(String(copy.id), copy)
  }
  f.clearCalls()
  const inventory = await f.run(queryCurrentSourceReferences(library, source))
  expect(inventory.targets).toEqual([{ skill_id: "human", skill_page_id: skill.page_id }])
  expect(
    f.calls.filter((call) => call.path.includes(`${library.files.data_source_id}/query`)),
  ).toHaveLength(2)
  expect(f.calls.every((call) => call.method === "POST" && call.path.includes("/query"))).toBe(true)
  property(f.pages.get(id(1100))!.properties).skill = {
    id: "skill",
    type: "relation",
    relation: [{ id: id(9999) }],
    has_more: false,
  }
  f.clearCalls()
  const result = await f.run(
    removeCurrentSource(library, { source_id: "managed", operation_id: "orphan-block" }).pipe(
      Effect.result,
    ),
  )
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.code).toBe("CURRENT_INDEX_INVALID")
  expect(f.mutations()).toHaveLength(0)
})

test("Source resource retirement rechecks references after reading the candidate resource", async () => {
  const f = currentWriteFixture(parent)
  const skill = await seedSkill(f),
    source = await seedSource(f)
  const resourcePage = await f.run(
    Effect.gen(function* () {
      const resource = yield* prepareCurrentSharedResource(
        testBytes("selected current manifest"),
        "100644",
      )
      const request = yield* currentOwnedResourceCreateRequest(library, {
        owner: { kind: "source", page_id: source.page_id },
        objectId: resource.content.object_id,
        payload: resource.manifest,
      })
      return String(
        property(yield* (yield* Notion).request(request.path, request.body, request.options)).id,
      )
    }),
  )
  let introduced = false
  f.rewrite((path, response) => {
    if (!introduced && path === `v1/pages/${resourcePage}`) {
      introduced = true
      property(f.pages.get(skill.page_id)!.properties).content = {
        id: "content",
        type: "rich_text",
        has_more: false,
        rich_text: sourceRich(JSON.stringify(sourceContent(source.revision))),
      }
    }
    return response
  })
  f.clearCalls()
  const result = await f.run(
    removeCurrentSource(library, { source_id: "managed", operation_id: "late-reference" }).pipe(
      Effect.result,
    ),
  )
  expect(introduced).toBe(true)
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.code).toBe("CURRENT_SOURCE_REFERENCED")
  expect(f.pages.get(resourcePage)?.in_trash).toBe(false)
  expect(f.pages.get(source.page_id)?.in_trash).toBe(false)
  expect(
    f
      .mutations()
      .some(
        (call) =>
          [resourcePage, source.page_id].some((page) => call.path === `v1/pages/${page}`) &&
          property(call.body).in_trash === true,
      ),
  ).toBe(false)
})

for (const outcome of ["accepted", "absent"] as const)
  test(`unreferenced Source and owned resources retire; ${outcome} owner archive loss resumes without publishing ready`, async () => {
    const f = currentWriteFixture(parent)
    const skill = await seedSkill(f),
      source = await seedSource(f, false)
    await f.run(
      Effect.gen(function* () {
        const resource = yield* prepareCurrentSharedResource(
          testBytes("old unused manifest"),
          "100644",
        )
        const request = yield* currentOwnedResourceCreateRequest(library, {
          owner: { kind: "source", page_id: source.page_id },
          objectId: resource.content.object_id,
          payload: resource.manifest,
        })
        yield* (yield* Notion).request(request.path, request.body, request.options)
      }),
    )
    f.clearCalls()
    f.failNext({ kind: "source-owner-retirement", outcome })
    const input = { source_id: "managed", operation_id: `remove-${outcome}` }
    expect((await f.run(removeCurrentSource(library, input).pipe(Effect.result)))._tag).toBe(
      "Failure",
    )
    expect(pendingKeys(f)).toHaveLength(1)
    const result = await f.run(removeCurrentSource(library, { ...input, mode: "resume" }))
    expect(result).toMatchObject({
      action: "remove",
      state: "removed",
      status: "removed",
      source_page_id: source.page_id,
    })
    expect(f.table("sources")).toEqual([])
    expect(
      f.table("records").filter((row) => {
        const relation = property(property(row.properties).origin).relation
        return (
          Array.isArray(relation) && relation.some((entry) => property(entry).id === source.page_id)
        )
      }),
    ).toEqual([])
    expect(operations(f)).toEqual([])
    expect(pendingKeys(f)).toEqual([])
    expect((await f.run(queryCurrentSkillIndex(library, skill.page_id))).state).toEqual({
      state: "ready",
    })
    expect(
      f.calls
        .filter((call) => call.path === `v1/pages/${source.page_id}` && call.method === "PATCH")
        .some(
          (call) =>
            property(property(property(property(call.body).properties).status).select).name ===
            "ready",
        ),
    ).toBe(false)
  })
