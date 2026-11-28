import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { trashPath } from "../src/local-locks.ts"
import { fail, property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { withCurrentOperation } from "../src/shared-current-operation.ts"
import { removeCurrentNotionSkill } from "../src/shared-current-skill-remove.ts"
import { prepareCurrentSkillWrite, writeCurrentSkill } from "../src/shared-current-write.ts"
import { sourceRich } from "../src/shared-source-definitions.ts"
import {
  currentWriteFixture,
  id,
  library,
  pauseAfterCurrentActionAcknowledgement,
  testBytes,
} from "./shared-current-write-fixture.ts"

const parent = mkdtempSync(join(tmpdir(), "ntn-current-skill-remove-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})
type Fixture = ReturnType<typeof currentWriteFixture>
async function seed(f: Fixture, skillId = "remove-me", count = 2) {
  const plan = await f.run(
    prepareCurrentSkillWrite({
      skill_id: skillId,
      kind: "skill",
      name: skillId,
      description: "A dedicated Notion-owned Skill",
      files: [
        {
          path: "SKILL.md",
          file_id: `${skillId}-main`,
          bytes: testBytes("# Native main"),
          authority: { kind: "native" },
        },
        ...Array.from({ length: count }, (_, n) => ({
          path: `notes/${n}.md`,
          file_id: `${skillId}-note-${n}`,
          bytes: testBytes(`# Native note ${n}`),
          authority: { kind: "native" as const },
        })),
        {
          path: "assets/original.txt",
          file_id: `${skillId}-resource`,
          bytes: testBytes("Exact original\n"),
        },
      ],
    }),
  )
  return f.run(writeCurrentSkill(library, { plan, operation_id: `seed-${skillId}` }))
}
function setRelations(f: Fixture, page: string, field: "Members" | "Requires", values: string[]) {
  property(f.pages.get(page)?.properties)[library.skills.property_ids[field]!] = {
    id: library.skills.property_ids[field],
    type: "relation",
    relation: values.map((id) => ({ id })),
    has_more: false,
  }
}
function relations(f: Fixture, page: string, field: "Members" | "Requires") {
  const value = property(
    property(f.pages.get(page)?.properties)[library.skills.property_ids[field]!],
  ).relation
  return Array.isArray(value) ? value.map((item) => property(item).id) : []
}
function pending(f: Fixture) {
  return [...f.json.keys()].filter((key) => key.startsWith("operations/current-write-pending/"))
}
function operationRows(f: Fixture) {
  return f
    .table("records")
    .filter((row) => property(property(property(row.properties).kind).select).name === "operation")
}

// Captured Notion behavior: GET page relations also omit trashed targets.
function hideTrashedRelations(f: Fixture) {
  f.rewrite((_path, response) => {
    const visible = (raw: unknown): Record<string, unknown> => {
      const row = property(structuredClone(raw))
      if (row.object === "list" && Array.isArray(row.results))
        row.results = row.results.map(visible)
      if (row.object === "page")
        for (const field of Object.values(property(row.properties))) {
          const value = property(field)
          if (value.type === "relation" && Array.isArray(value.relation))
            value.relation = value.relation.filter(
              (item) => f.pages.get(String(property(item).id))?.in_trash !== true,
            )
        }
      return row
    }
    return visible(response)
  })
}

test("remove inspects with zero writes, unlinks complete relations, retires only its tree, and repeats with zero writes", async () => {
  const f = currentWriteFixture(parent)
  const target = await seed(f),
    other = await seed(f, "keep-me", 0)
  const kept = Array.from({ length: 27 }, (_, n) => id(10000 + n))
  setRelations(f, other.page_id, "Members", [...kept, target.page_id])
  setRelations(f, other.page_id, "Requires", [target.page_id, kept[0]!])
  const originalOther = structuredClone(f.pages.get(other.page_id))
  const ownedFiles = f
    .table("files")
    .filter(
      (row) =>
        property(property(row.properties).skill).relation &&
        JSON.stringify(property(property(row.properties).skill).relation).includes(target.page_id),
    )
    .map((row) => String(row.id))
  const ownedResources = f
    .table("records")
    .filter((row) =>
      JSON.stringify(property(property(row.properties).skill).relation).includes(target.page_id),
    )
    .map((row) => String(row.id))
  f.clearCalls()
  const inspected = await f.run(
    removeCurrentNotionSkill(library, { target: "remove-me", dry_run: true }),
  )
  expect(inspected.status).toBe("inspected")
  expect(f.mutations()).toHaveLength(0)
  const removed = await f.run(
    removeCurrentNotionSkill(library, {
      target: `https://www.notion.so/${target.page_id.replaceAll("-", "")}`,
    }),
  )
  expect(removed).toMatchObject({
    status: "removed",
    state: "removed",
    cleanup_verified: true,
    page_id: target.page_id,
    skill_id: "remove-me",
  })
  expect(f.pages.get(target.page_id)?.in_trash).toBe(true)
  for (const page of [...ownedFiles, ...ownedResources])
    expect(f.pages.get(page)?.in_trash).toBe(true)
  expect(relations(f, other.page_id, "Members")).toEqual(kept.sort())
  expect(relations(f, other.page_id, "Requires")).toEqual([kept[0]])
  expect(f.pages.get(other.page_id)?.in_trash).toBe(false)
  const current = property(f.pages.get(other.page_id)?.properties),
    before = property(originalOther?.properties)
  for (const [key, value] of Object.entries(before))
    if (key !== "members" && key !== "requires") expect(current[key]).toEqual(value)
  expect(f.table("files").every((row) => !ownedFiles.includes(String(row.id)))).toBe(true)
  expect(f.table("records").every((row) => !ownedResources.includes(String(row.id)))).toBe(true)
  const trashCalls = f.mutations().filter((call) => property(call.body).in_trash === true)
  const ownerIndex = trashCalls.findIndex((call) => call.path === `v1/pages/${target.page_id}`)
  expect(ownerIndex).toBe(ownedFiles.length + ownedResources.length)
  expect(pending(f)).toEqual([])
  expect(operationRows(f)).toEqual([])
  f.clearCalls()
  expect((await f.run(removeCurrentNotionSkill(library, { target: target.page_id }))).status).toBe(
    "already_trashed",
  )
  expect((await f.run(removeCurrentNotionSkill(library, { target: "remove-me" }))).status).toBe(
    "not_found",
  )
  expect(f.mutations()).toHaveLength(0)
})

test("remove exhausts Files pagination before freezing every owned File", async () => {
  const f = currentWriteFixture(parent),
    target = await seed(f, "many-files", 103)
  f.clearCalls()
  const result = await f.run(removeCurrentNotionSkill(library, { target: target.page_id }))
  expect(result.status).toBe("removed")
  expect(f.table("files")).toEqual([])
  expect(
    f.calls.some(
      (call) =>
        call.path.includes(`/data_sources/${library.files.data_source_id}/query`) &&
        property(call.body).start_cursor !== undefined,
    ),
  ).toBe(true)
  expect(pending(f)).toEqual([])
})

for (const [kind, prefix] of [
  ["relations", "remove:relation:"],
  ["retire-file", "remove:file:"],
  ["retire-resource", "remove:resource:"],
  ["owner retirement", "$owner.retired"],
] as const)
  test(`automatic removal resumes the same finite intent after acknowledged ${kind}`, async () => {
    const f = pauseAfterCurrentActionAcknowledgement(currentWriteFixture(parent), (key) =>
      key.startsWith(prefix),
    )
    const target = await seed(f),
      other = await seed(f, "referrer", 0)
    setRelations(f, other.page_id, "Members", [target.page_id])
    await expect(
      f.run(removeCurrentNotionSkill(library, { target: target.page_id })),
    ).rejects.toMatchObject({ code: "REQUEST_BUDGET_EXHAUSTED" })
    expect(f.paused()).toBe(true)
    expect(pending(f)).toHaveLength(1)
    const stored = property(f.json.get(pending(f)[0]!)),
      original = property(stored.intent)
    expect(property(original.skill_action).kind).toBe("remove")
    expect(String(property(stored.settled_action).key).startsWith(prefix)).toBe(true)
    const acknowledgedWrites = f
      .mutations()
      .filter((call) =>
        kind === "relations"
          ? call.path === `v1/pages/${other.page_id}`
          : property(call.body).in_trash === true,
      )
    const acknowledged = acknowledgedWrites.at(-1)!
    expect(acknowledged).toBeDefined()
    f.clearCalls()
    expect(await f.run(removeCurrentNotionSkill(library, { target: "remove-me" }))).toMatchObject({
      status: "removed",
      operation_id: original.operation_id,
    })
    expect(
      f
        .mutations()
        .filter(
          (call) =>
            call.path === acknowledged.path &&
            JSON.stringify(call.body) === JSON.stringify(acknowledged.body),
        ),
    ).toEqual([])
    expect(pending(f)).toEqual([])
    expect(operationRows(f)).toEqual([])
    expect(relations(f, other.page_id, "Members")).toEqual([])
    expect(f.pages.get(target.page_id)?.in_trash).toBe(true)
    f.clearCalls()
    await f.run(removeCurrentNotionSkill(library, { target: target.page_id }))
    expect(f.mutations()).toHaveLength(0)
  })

for (const kind of ["relations", "retire-file", "retire-resource"] as const)
  for (const outcome of ["accepted", "absent"] as const)
    test(`automatic removal preserves an unknown ${kind} ${outcome} without replaying it`, async () => {
      const f = currentWriteFixture(parent),
        target = await seed(f),
        other = await seed(f, "referrer", 0)
      setRelations(f, other.page_id, "Members", [target.page_id])
      f.failNext({ kind, outcome })
      await expect(
        f.run(removeCurrentNotionSkill(library, { target: target.page_id })),
      ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
      expect(pending(f)).toHaveLength(1)
      const key = pending(f)[0]!,
        original = structuredClone(property(f.json.get(key)).intent)
      expect(property(property(original).skill_action).kind).toBe("remove")
      f.clearCalls()
      await expect(
        f.run(removeCurrentNotionSkill(library, { target: "remove-me" })),
      ).rejects.toMatchObject({ code: "CURRENT_OPERATION_UNRESOLVED" })
      expect(f.mutations()).toHaveLength(0)
      expect(property(f.json.get(key)).intent).toEqual(original)
      expect(pending(f)).toHaveLength(1)
      expect(operationRows(f)).toHaveLength(1)
      expect(f.pages.get(target.page_id)?.in_trash).toBe(false)
    })

test("removal reconciles the uniquely observed retirement of its exact operation Record", async () => {
  const f = currentWriteFixture(parent),
    target = await seed(f)
  f.failNext({ kind: "operation-retirement", outcome: "accepted" })
  await expect(
    f.run(removeCurrentNotionSkill(library, { target: target.page_id })),
  ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
  const original = property(property(f.json.get(pending(f)[0]!)).intent)
  expect(f.pages.get(target.page_id)?.in_trash).toBe(true)
  f.clearCalls()
  expect(await f.run(removeCurrentNotionSkill(library, { target: "remove-me" }))).toMatchObject({
    status: "removed",
    operation_id: original.operation_id,
  })
  expect(f.mutations()).toEqual([])
  expect(pending(f)).toEqual([])
  expect(operationRows(f)).toEqual([])
})

test("removal retains an unobserved operation Record retirement without replay", async () => {
  const f = currentWriteFixture(parent),
    target = await seed(f)
  f.failNext({ kind: "operation-retirement", outcome: "absent" })
  await expect(
    f.run(removeCurrentNotionSkill(library, { target: target.page_id })),
  ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
  const key = pending(f)[0]!,
    original = structuredClone(property(f.json.get(key)).intent)
  expect(f.pages.get(target.page_id)?.in_trash).toBe(true)
  f.clearCalls()
  await expect(
    f.run(removeCurrentNotionSkill(library, { target: "remove-me" })),
  ).rejects.toMatchObject({ code: "CURRENT_OPERATION_UNRESOLVED" })
  expect(f.mutations()).toEqual([])
  expect(property(f.json.get(key)).intent).toEqual(original)
  expect(pending(f)).toHaveLength(1)
  expect(operationRows(f)).toHaveLength(1)
})

for (const outcome of ["accepted", "absent"] as const)
  test(`unknown owner retirement ${outcome} retains the original intent without replay`, async () => {
    const f = currentWriteFixture(parent),
      target = await seed(f)
    const api = await f.run(Notion)
    let fired = false
    const faulty: Notion["Service"] = {
      ...api,
      request: (path, body, options) => {
        if (!fired && path === `v1/pages/${target.page_id}` && property(body).in_trash === true) {
          fired = true
          return (
            outcome === "accepted" ? api.request(path, body, options) : Effect.succeed(undefined)
          ).pipe(
            Effect.andThen(
              Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Lost owner retirement response.")),
            ),
          )
        }
        return api.request(path, body, options)
      },
    }
    await expect(
      f.run(
        removeCurrentNotionSkill(library, { target: target.page_id }).pipe(
          Effect.provideService(Notion, faulty),
        ),
      ),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    expect(fired).toBe(true)
    expect(pending(f)).toHaveLength(1)
    const key = pending(f)[0]!,
      original = structuredClone(property(f.json.get(key)).intent)
    f.clearCalls()
    await expect(
      f.run(removeCurrentNotionSkill(library, { target: "remove-me" })),
    ).rejects.toMatchObject({ code: "CURRENT_OPERATION_UNRESOLVED" })
    expect(f.mutations()).toEqual([])
    expect(property(f.json.get(key)).intent).toEqual(original)
    expect(pending(f)).toHaveLength(1)
    expect(f.pages.get(target.page_id)?.in_trash).toBe(outcome === "accepted")
  })

test("more than 100 remaining relation targets is rejected before any mutation", async () => {
  const f = currentWriteFixture(parent),
    target = await seed(f),
    other = await seed(f, "referrer", 0)
  setRelations(f, other.page_id, "Members", [
    target.page_id,
    ...Array.from({ length: 101 }, (_, n) => id(20000 + n)),
  ])
  f.clearCalls()
  await expect(
    f.run(removeCurrentNotionSkill(library, { target: target.page_id })),
  ).rejects.toMatchObject({ code: "CURRENT_SKILL_REMOVE_CONFLICT" })
  expect(f.mutations()).toHaveLength(0)
  expect(pending(f)).toEqual([])
})

test("an external relation edit after interruption is preserved and blocks resume", async () => {
  const f = pauseAfterCurrentActionAcknowledgement(currentWriteFixture(parent), (key) =>
    key.startsWith("remove:relation:"),
  )
  const target = await seed(f),
    other = await seed(f, "referrer", 0)
  setRelations(f, other.page_id, "Members", [target.page_id])
  await expect(
    f.run(removeCurrentNotionSkill(library, { target: target.page_id })),
  ).rejects.toMatchObject({ code: "REQUEST_BUDGET_EXHAUSTED" })
  expect(f.paused()).toBe(true)
  const key = pending(f)[0]!,
    saved = property(f.json.get(key)),
    originalIntent = structuredClone(saved.intent),
    originalFiles = structuredClone(f.table("files", false)),
    recordPage = property(saved.lifecycle).record_page_id
  expect(typeof recordPage).toBe("string")
  setRelations(f, other.page_id, "Members", [id(30000)])
  f.clearCalls()
  await expect(
    f.run(removeCurrentNotionSkill(library, { target: target.page_id })),
  ).rejects.toMatchObject({ code: "CURRENT_SKILL_REMOVE_CONFLICT" })
  expect(relations(f, other.page_id, "Members")).toEqual([id(30000)])
  expect(
    f
      .mutations()
      .every(
        (call) =>
          call.method === "PATCH" &&
          [target.page_id, recordPage].some((page) => call.path === `v1/pages/${page}`) &&
          !("in_trash" in property(call.body)),
      ),
  ).toBe(true)
  expect(property(f.json.get(key)).intent).toEqual(originalIntent)
  expect(f.table("files", false)).toEqual(originalFiles)
  expect(f.pages.get(target.page_id)?.in_trash).toBe(false)
  expect(pending(f)).toHaveLength(1)
})

test("a new owned File after interruption cannot be adopted into the frozen deletion", async () => {
  const f = pauseAfterCurrentActionAcknowledgement(currentWriteFixture(parent), (key) =>
    key.startsWith("remove:file:"),
  )
  const target = await seed(f)
  await expect(
    f.run(removeCurrentNotionSkill(library, { target: target.page_id })),
  ).rejects.toMatchObject({ code: "REQUEST_BUDGET_EXHAUSTED" })
  expect(f.paused()).toBe(true)
  const original = f.table("files")[0]!
  const extra = structuredClone(original),
    properties = property(extra.properties)
  extra.id = id(40000)
  properties["file-id"] = {
    id: "file-id",
    type: "rich_text",
    rich_text: sourceRich("new-human-file"),
  }
  properties.path = { id: "path", type: "rich_text", rich_text: sourceRich("human-new.md") }
  f.pages.set(String(extra.id), extra)
  f.clearCalls()
  await expect(
    f.run(removeCurrentNotionSkill(library, { target: target.page_id })),
  ).rejects.toMatchObject({ code: "CURRENT_SKILL_REMOVE_CONFLICT" })
  expect(extra.in_trash).toBe(false)
  expect(f.pages.get(target.page_id)?.in_trash).toBe(false)
  expect(f.mutations()).toHaveLength(0)
})

for (const scenario of [
  "main-source",
  "mixed-file",
  "origin",
  "contribution",
  "foreign-resource",
  "duplicate",
  "foreign-page",
] as const)
  test(`remove rejects ${scenario} before mutation`, async () => {
    const f = currentWriteFixture(parent),
      target = await seed(f)
    const sourceContent = {
      kind: "source",
      source_id: "upstream",
      revision: "a".repeat(64),
      source_path: "member/SKILL.md",
      sha256: "b".repeat(64),
      bytes: 1,
      mode: "100644",
    }
    const owner = f.pages.get(target.page_id)!,
      props = property(owner.properties)
    if (scenario === "main-source")
      props.content = {
        id: "content",
        type: "rich_text",
        rich_text: sourceRich(JSON.stringify(sourceContent)),
      }
    if (scenario === "mixed-file")
      property(f.table("files")[0]!.properties).content = {
        id: "content",
        type: "rich_text",
        rich_text: sourceRich(JSON.stringify(sourceContent)),
      }
    if (scenario === "origin")
      props.origin = {
        id: "origin",
        type: "relation",
        relation: [{ id: id(50000) }],
        has_more: false,
      }
    if (scenario === "contribution")
      await f.run(
        Effect.flatMap(Notion, (api) =>
          api.request(
            "v1/pages",
            {
              parent: { type: "data_source_id", data_source_id: library.sources.data_source_id },
              properties: {
                contributions: {
                  rich_text: sourceRich(
                    JSON.stringify([
                      {
                        member_key: "member",
                        skill_id: "remove-me",
                        mount_path: "",
                        mapping: {},
                        exclude: [],
                      },
                    ]),
                  ),
                },
              },
            },
            { method: "POST" },
          ),
        ),
      )
    if (scenario === "foreign-resource")
      property(f.table("records")[0]!.properties).skill = {
        id: "skill",
        type: "relation",
        relation: [{ id: id(50001) }],
        has_more: false,
      }
    if (scenario === "duplicate") {
      const duplicate = structuredClone(owner)
      duplicate.id = id(50002)
      f.pages.set(String(duplicate.id), duplicate)
    }
    if (scenario === "foreign-page")
      owner.parent = { type: "data_source_id", data_source_id: id(50003) }
    f.clearCalls()
    await expect(
      f.run(removeCurrentNotionSkill(library, { target: target.page_id })),
    ).rejects.toBeDefined()
    expect(f.mutations()).toHaveLength(0)
    expect(pending(f)).toEqual([])
  })

for (const selected of ["owner", "referrer"] as const)
  test(`remove refuses another unfinished ${selected} operation`, async () => {
    const f = currentWriteFixture(parent),
      target = await seed(f),
      other = await seed(f, "referrer", 0)
    setRelations(f, other.page_id, "Members", [target.page_id])
    const page = selected === "owner" ? target.page_id : other.page_id
    const skillId = selected === "owner" ? "remove-me" : "referrer"
    await expect(
      f.run(
        withCurrentOperation(library, {
          intent: {
            owner: { kind: "skill", id: skillId },
            operation_id: "another-writer",
            input_sha256: "c".repeat(64),
          },
          ownerPageId: page,
          run: (session) =>
            session
              .activate()
              .pipe(Effect.andThen(Effect.fail(fail("TEST_STOP", "Keep the original intent.")))),
          verify: () => Effect.void,
        }),
      ),
    ).rejects.toMatchObject({ code: "TEST_STOP" })
    f.clearCalls()
    await expect(
      f.run(removeCurrentNotionSkill(library, { target: target.page_id })),
    ).rejects.toBeDefined()
    expect(f.mutations()).toHaveLength(0)
    expect(pending(f)).toHaveLength(1)
    expect(text(property(property(f.pages.get(page)?.properties).operation).rich_text)).toBe(
      "another-writer",
    )
  })

test("an externally trashed owner does not certify cleanup of its live children", async () => {
  const f = currentWriteFixture(parent),
    target = await seed(f)
  f.pages.get(target.page_id)!.in_trash = true
  f.clearCalls()
  expect(await f.run(removeCurrentNotionSkill(library, { target: target.page_id }))).toMatchObject({
    status: "already_trashed",
    cleanup_verified: false,
    remote_writes: 0,
  })
  expect(f.mutations()).toHaveLength(0)
})

test("terminal resume tolerates Notion hiding only the retired owner's relation on frozen retired children", async () => {
  const f = pauseAfterCurrentActionAcknowledgement(
    currentWriteFixture(parent),
    (key) => key === "$owner.retired",
  )
  const target = await seed(f)
  hideTrashedRelations(f)
  await expect(
    f.run(removeCurrentNotionSkill(library, { target: target.page_id })),
  ).rejects.toMatchObject({ code: "REQUEST_BUDGET_EXHAUSTED" })
  expect(f.paused()).toBe(true)
  expect(f.pages.get(target.page_id)?.in_trash).toBe(true)
  expect(pending(f)).toHaveLength(1)
  expect((await f.run(removeCurrentNotionSkill(library, { target: target.page_id }))).status).toBe(
    "removed",
  )
  expect(pending(f)).toEqual([])
  expect(operationRows(f)).toEqual([])
})

test("hidden relations cannot make an externally trashed ready owner appear completely removed", async () => {
  const f = currentWriteFixture(parent),
    target = await seed(f)
  f.pages.get(target.page_id)!.in_trash = true
  hideTrashedRelations(f)
  f.clearCalls()
  expect(await f.run(removeCurrentNotionSkill(library, { target: target.page_id }))).toMatchObject({
    status: "already_trashed",
    cleanup_verified: false,
    remote_writes: 0,
  })
  expect(f.mutations()).toHaveLength(0)
})

for (const table of ["files", "records"] as const)
  test(`terminal resume never accepts a foreign owner on a frozen retired ${table} page`, async () => {
    const f = pauseAfterCurrentActionAcknowledgement(
      currentWriteFixture(parent),
      (key) => key === "$owner.retired",
    )
    const target = await seed(f)
    hideTrashedRelations(f)
    await expect(
      f.run(removeCurrentNotionSkill(library, { target: target.page_id })),
    ).rejects.toMatchObject({ code: "REQUEST_BUDGET_EXHAUSTED" })
    expect(f.paused()).toBe(true)
    const row = f
      .table(table, false)
      .find(
        (row) =>
          table === "files" ||
          property(property(property(row.properties).kind).select).name === "resource",
      )!
    property(row.properties).skill = {
      id: "skill",
      type: "relation",
      relation: [{ id: id(60000) }],
      has_more: false,
    }
    f.clearCalls()
    await expect(
      f.run(removeCurrentNotionSkill(library, { target: target.page_id })),
    ).rejects.toMatchObject({ code: "CURRENT_SKILL_REMOVE_CONFLICT" })
    expect(f.mutations()).toHaveLength(0)
    expect(pending(f)).toHaveLength(1)
  })
