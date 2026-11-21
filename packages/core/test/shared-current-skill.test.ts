import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { trashPath } from "../src/local-locks.ts"
import { property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { queryCurrentSkillIndex } from "../src/shared-current-index.ts"
import { createCurrentNotionSkill, updateCurrentNotionSkill } from "../src/shared-current-skill.ts"
import {
  prepareCurrentSkillWrite,
  type CurrentSkillWriteInput,
} from "../src/shared-current-write-input.ts"
import { currentWriteFixture, library, testBytes } from "./shared-current-write-fixture.ts"

const parent = mkdtempSync(join(tmpdir(), "ntn-current-skill-management-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})
type Fixture = ReturnType<typeof currentWriteFixture>
function input(overrides: Partial<CurrentSkillWriteInput> = {}): CurrentSkillWriteInput {
  return {
    skill_id: "native-managed",
    kind: "skill",
    name: "Native managed",
    description: "Authoring wrapper acceptance",
    files: [
      {
        path: "SKILL.md",
        file_id: "managed-main",
        bytes: testBytes(
          "---\nname: native-managed\ndescription: Authoring wrapper acceptance\n---\n# Main\n",
        ),
        authority: { kind: "native" },
      },
      {
        path: "references/note.md",
        file_id: "managed-note",
        bytes: testBytes("# Supporting note\n"),
        authority: { kind: "native" },
      },
      {
        path: "assets/data.bin",
        file_id: "managed-data",
        bytes: new Uint8Array([0, 255, 4, 1, 128]),
      },
    ],
    ...overrides,
  }
}
function pending(f: Fixture) {
  return [...f.json.keys()].filter((key) => key.startsWith("operations/current-write-pending/"))
}
async function body(f: Fixture, page: string) {
  return property(
    await f.run(Effect.flatMap(Notion, (api) => api.request(`v1/pages/${page}/markdown`))),
  ).markdown
}
async function editBody(f: Fixture, page: string, markdown: string) {
  await f.run(
    Effect.flatMap(Notion, (api) =>
      api.request(
        `v1/pages/${page}/markdown`,
        {
          type: "replace_content",
          replace_content: { new_str: markdown },
          markdown_version: "v2",
        },
        { method: "PATCH" },
      ),
    ),
  )
}
async function create(f: Fixture) {
  const plan = await f.run(prepareCurrentSkillWrite(input()))
  const result = createdResult(await f.run(createCurrentNotionSkill(library, { plan })))
  return { plan, result }
}
function createdResult(result: Effect.Success<ReturnType<typeof createCurrentNotionSkill>>) {
  if (!("status" in result) || result.status !== "created")
    throw new Error("Expected an applied creation.")
  return result
}

test("create verifies the whole native/resource tree and an equal repeat writes nothing", async () => {
  const f = currentWriteFixture(parent),
    plan = await f.run(prepareCurrentSkillWrite(input()))
  const dry = await f.run(createCurrentNotionSkill(library, { plan, dry_run: true }))
  expect(dry).toMatchObject({ dry_run: true })
  expect(f.mutations()).toHaveLength(0)
  const created = createdResult(await f.run(createCurrentNotionSkill(library, { plan })))
  expect(created).toMatchObject({
    action: "create",
    status: "created",
    state: "ready",
    skill_id: "native-managed",
  })
  expect(pending(f)).toEqual([])
  const before = await f.run(queryCurrentSkillIndex(library, created.page_id))
  expect(before.files.map((file) => file.path).sort()).toEqual([
    "assets/data.bin",
    "references/note.md",
  ])
  expect(before.main.content.kind).toBe("native")
  expect(before.files.find((file) => file.path === "assets/data.bin")?.content.kind).toBe(
    "resource",
  )
  f.clearCalls()
  const repeated = await f.run(createCurrentNotionSkill(library, { plan }))
  expect(repeated).toMatchObject({
    action: "create",
    status: "unchanged",
    remote_writes: 0,
    page_id: created.page_id,
  })
  expect(f.mutations()).toHaveLength(0)
  const after = await f.run(queryCurrentSkillIndex(library, created.page_id))
  expect(after).toEqual(before)
})

for (const difference of ["metadata", "support-body", "file-count"] as const)
  test(`create refuses an existing different ${difference} without replacement writes`, async () => {
    const f = currentWriteFixture(parent),
      { plan, result } = await create(f)
    const index = await f.run(queryCurrentSkillIndex(library, result.page_id))
    let candidate = plan
    if (difference === "metadata")
      candidate = await f.run(
        prepareCurrentSkillWrite(input({ description: "A different author intention" })),
      )
    if (difference === "support-body")
      await editBody(
        f,
        index.files.find((file) => file.path === "references/note.md")!.page_id,
        "# Human changed the supporting file\n",
      )
    if (difference === "file-count")
      candidate = await f.run(
        prepareCurrentSkillWrite(
          input({ files: input().files.filter((file) => file.path !== "assets/data.bin") }),
        ),
      )
    const pages = structuredClone(f.pages)
    f.clearCalls()
    await expect(
      f.run(createCurrentNotionSkill(library, { plan: candidate })),
    ).rejects.toMatchObject({ code: "CURRENT_SKILL_EXISTS" })
    expect(f.mutations()).toHaveLength(0)
    expect(f.pages).toEqual(pages)
    expect(pending(f)).toEqual([])
  })

for (const kind of ["skill-create", "native-body"] as const)
  test(`create automatically resumes the same input after an accepted ${kind} response is lost`, async () => {
    const f = currentWriteFixture(parent),
      plan = await f.run(prepareCurrentSkillWrite(input()))
    f.failNext({ kind, outcome: "accepted" })
    await expect(f.run(createCurrentNotionSkill(library, { plan }))).rejects.toMatchObject({
      code: "WRITE_OUTCOME_UNKNOWN",
    })
    expect(pending(f)).toHaveLength(1)
    const original = property(property(f.json.get(pending(f)[0]!)).intent).operation_id
    const resumed = await f.run(createCurrentNotionSkill(library, { plan }))
    expect(resumed).toMatchObject({
      action: "create",
      status: "created",
      state: "ready",
      operation_id: original,
    })
    expect(f.table("skills")).toHaveLength(1)
    expect(pending(f)).toEqual([])
    f.clearCalls()
    expect(await f.run(createCurrentNotionSkill(library, { plan }))).toMatchObject({
      status: "unchanged",
    })
    expect(f.mutations()).toHaveLength(0)
  })

test("create preserves an unfinished creation and refuses changed input before any new write", async () => {
  const f = currentWriteFixture(parent),
    plan = await f.run(prepareCurrentSkillWrite(input()))
  f.failNext({ kind: "native-body", outcome: "accepted" })
  await expect(f.run(createCurrentNotionSkill(library, { plan }))).rejects.toMatchObject({
    code: "WRITE_OUTCOME_UNKNOWN",
  })
  const changed = await f.run(
    prepareCurrentSkillWrite(input({ description: "Changed while the original is pending" })),
  )
  f.clearCalls()
  await expect(f.run(createCurrentNotionSkill(library, { plan: changed }))).rejects.toMatchObject({
    code: "CURRENT_OPERATION_PENDING",
  })
  expect(f.mutations()).toHaveLength(0)
  expect(pending(f)).toHaveLength(1)
  await f.run(createCurrentNotionSkill(library, { plan }))
  expect(pending(f)).toEqual([])
})

test("update changes selected main and metadata while preserving unselected author body and exact resource; repeat writes nothing", async () => {
  const f = currentWriteFixture(parent),
    { result } = await create(f)
  const before = await f.run(queryCurrentSkillIndex(library, result.page_id))
  const note = before.files.find((file) => file.path === "references/note.md")!
  const data = before.files.find((file) => file.path === "assets/data.bin")!
  const authored = "# Independently authored supporting note\n\nKeep **this** text and `code`.\n"
  await editBody(f, note.page_id, authored)
  const selected = {
    target: "native-managed",
    main: { bytes: testBytes("# Updated main\n") },
    metadata: { description: "Updated metadata" },
  }
  f.clearCalls()
  const updated = await f.run(updateCurrentNotionSkill(library, selected))
  expect(updated).toMatchObject({ action: "update", state: "ready", page_id: result.page_id })
  const after = await f.run(queryCurrentSkillIndex(library, result.page_id))
  expect(after.description).toBe("Updated metadata")
  expect(after.main.file_id).toBe(before.main.file_id)
  expect(after.files.find((file) => file.path === "references/note.md")?.page_id).toBe(note.page_id)
  expect(after.files.find((file) => file.path === "assets/data.bin")).toEqual(data)
  expect(await body(f, note.page_id)).toBe(authored)
  expect(await body(f, result.page_id)).toBe("# Updated main\n")
  expect(f.mutations().some((call) => call.path === `v1/pages/${note.page_id}/markdown`)).toBe(
    false,
  )
  expect(f.mutations().some((call) => call.path === `v1/pages/${data.page_id}`)).toBe(false)
  expect(pending(f)).toEqual([])
  f.clearCalls()
  const repeated = await f.run(updateCurrentNotionSkill(library, selected))
  expect(repeated).toMatchObject({ status: "unchanged" })
  expect(f.mutations()).toHaveLength(0)
  expect(await body(f, note.page_id)).toBe(authored)
})

test("metadata-only update preserves every current body and File identity", async () => {
  const f = currentWriteFixture(parent),
    { result } = await create(f)
  const before = await f.run(queryCurrentSkillIndex(library, result.page_id))
  await editBody(f, result.page_id, "# Current author main\n\nUnselected content survives.\n")
  f.clearCalls()
  const updated = await f.run(
    updateCurrentNotionSkill(library, {
      target: result.page_id,
      metadata: { name: "Renamed native skill", enabled: false, default_context: true },
    }),
  )
  expect(updated.state).toBe("ready")
  const after = await f.run(queryCurrentSkillIndex(library, result.page_id))
  expect(after).toMatchObject({
    name: "Renamed native skill",
    enabled: false,
    default_context: true,
  })
  expect(after.main.file_id).toBe(before.main.file_id)
  expect(after.main.content).toEqual(before.main.content)
  expect(after.files).toEqual(before.files)
  expect(await body(f, result.page_id)).toBe(
    "# Current author main\n\nUnselected content survives.\n",
  )
  expect(
    f
      .mutations()
      .every((call) => !call.path.includes("/markdown") && !call.path.includes("/blocks/")),
  ).toBe(true)
})

test("update resumes the original selected input, rejects a changed pending input, and preserves the rest", async () => {
  const f = currentWriteFixture(parent),
    { result } = await create(f)
  const original = {
    target: result.page_id,
    main: { bytes: testBytes("# Original pending update\n") },
  }
  f.failNext({ kind: "native-body", outcome: "absent" })
  await expect(f.run(updateCurrentNotionSkill(library, original))).rejects.toMatchObject({
    code: "WRITE_OUTCOME_UNKNOWN",
  })
  expect(pending(f)).toHaveLength(1)
  const intent = property(property(f.json.get(pending(f)[0]!)).intent)
  expect(property(intent.skill_action).kind).toBe("update")
  f.clearCalls()
  await expect(
    f.run(
      updateCurrentNotionSkill(library, {
        ...original,
        main: { bytes: testBytes("# Different retry\n") },
      }),
    ),
  ).rejects.toMatchObject({ code: "CURRENT_OPERATION_PENDING" })
  expect(f.mutations()).toHaveLength(0)
  expect(pending(f)).toHaveLength(1)
  const resumed = await f.run(updateCurrentNotionSkill(library, original))
  expect(resumed).toMatchObject({
    action: "update",
    state: "ready",
    operation_id: intent.operation_id,
  })
  expect(await body(f, result.page_id)).toBe("# Original pending update\n")
  expect(pending(f)).toEqual([])
  f.clearCalls()
  expect(await f.run(updateCurrentNotionSkill(library, original))).toMatchObject({
    status: "unchanged",
  })
  expect(f.mutations()).toHaveLength(0)
})
