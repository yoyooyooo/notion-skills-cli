import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { trashPath } from "../src/local-locks.ts"
import { property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { queryCurrentSkillIndex } from "../src/shared-current-index.ts"
import { readCurrentOperationIntent } from "../src/shared-current-operation.ts"
import { loadCurrentSharedResourceContent } from "../src/shared-current-resource.ts"
import {
  inspectCurrentSkillPatch,
  prepareCurrentSkillPatch,
  prepareCurrentSkillWrite,
  writeCurrentSkill,
  writeCurrentSkillPatch,
} from "../src/shared-current-write.ts"
import { observeSharedBody } from "../src/shared-page-body.ts"
import { currentWriteFixture, library, testBytes } from "./shared-current-write-fixture.ts"

const parent = mkdtempSync(join(tmpdir(), "ntn-current-skill-patch-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})
const pending = (f: ReturnType<typeof currentWriteFixture>) =>
  [...f.json.keys()].filter((key) => key.startsWith("operations/current-write-pending/"))
async function seed() {
  const f = currentWriteFixture(parent)
  const plan = await f.run(
    prepareCurrentSkillWrite({
      skill_id: "patch-example",
      kind: "skill",
      name: "Patch example",
      description: "Partial native authoring",
      default_context: true,
      files: [
        {
          path: "SKILL.md",
          bytes: testBytes("# Main\n\nRead [guide](references/guide.md).\n"),
          authority: { kind: "native" },
        },
        {
          path: "references/guide.md",
          bytes: testBytes("# Guide\n\nReturn to [main](../SKILL.md).\n"),
          authority: { kind: "native" },
        },
        { path: "obsolete.txt", bytes: testBytes("retire this original\n") },
        { path: "run.sh", bytes: testBytes("#!/bin/sh\necho exact\n"), mode: "100755" },
      ],
    }),
  )
  const written = await f.run(writeCurrentSkill(library, { plan, operation_id: "seed" }))
  const index = await f.run(queryCurrentSkillIndex(library, written.page_id))
  f.clearCalls()
  return { f, plan, index, page: written.page_id }
}
async function author(f: ReturnType<typeof currentWriteFixture>, page: string, body: string) {
  await f.run(
    Effect.gen(function* () {
      yield* (yield* Notion).request(
        `v1/pages/${page}/markdown`,
        { type: "replace_content", replace_content: { new_str: body } },
        { method: "PATCH" },
      )
    }),
  )
}

test("a prepared patch preserves later unselected native edits, metadata, flags and exact resources", async () => {
  const { f, page, index } = await seed()
  const guide = index.files.find((file) => file.path === "references/guide.md")!
  const resource = index.files.find((file) => file.path === "run.sh")!
  const selection = {
    target: page,
    metadata: { description: "Changed description" },
    files: [
      { path: "SKILL.md", bytes: testBytes("# New main\n\nRead [guide](references/guide.md).\n") },
    ],
  }
  const plan = await f.run(prepareCurrentSkillPatch(library, selection))
  expect(plan.files.filter((file) => file.kind === "preserve")).toHaveLength(3)
  const latest = "# Guide\n\nLater **author** edit and `exact code`.\n"
  await author(f, guide.page_id, latest)
  const fields = property(f.pages.get(page)?.properties)
  property(fields.title).title = [{ type: "text", text: { content: "Author renamed title" } }]
  fields["human-choice"] = { id: "human-choice", type: "checkbox", checkbox: true }
  const editedIndex = await f.run(queryCurrentSkillIndex(library, page))
  f.clearCalls()
  const report = await f.run(inspectCurrentSkillPatch(library, plan))
  expect(report).toMatchObject({ replaces_complete_tree: false, preserves_unselected_files: true })
  expect(f.mutations()).toEqual([])
  const applied = await f.run(writeCurrentSkillPatch(library, { plan, operation_id: "selected" }))
  expect(applied).toMatchObject({ state: "ready", native: { verified: 1, normalized_paths: [] } })
  const final = await f.run(queryCurrentSkillIndex(library, page))
  expect(final).toMatchObject({
    name: "Author renamed title",
    description: "Changed description",
    enabled: true,
    default_context: true,
  })
  expect(final.files).toEqual(editedIndex.files)
  expect((await f.run(observeSharedBody(guide.page_id))).markdown).toBe(latest)
  expect(property(property(f.pages.get(page)?.properties)["human-choice"]).checkbox).toBe(true)
  if (resource.content.kind !== "resource") throw new Error("Expected exact resource")
  expect(
    (
      await f.run(
        loadCurrentSharedResourceContent(library, {
          owner: { kind: "skill", page_id: page },
          content: resource.content,
        }),
      )
    ).bytes,
  ).toEqual(testBytes("#!/bin/sh\necho exact\n"))
  expect(f.mutations().filter((call) => call.path.endsWith("/markdown"))).toHaveLength(1)
  expect(pending(f)).toEqual([])
  f.clearCalls()
  const repeat = await f.run(prepareCurrentSkillPatch(library, selection))
  expect(
    (await f.run(writeCurrentSkillPatch(library, { plan: repeat, operation_id: "repeat" }))).status,
  ).toBe("unchanged")
  expect(f.mutations()).toEqual([])
})

test("a patch resumes an accepted File retirement from its frozen scope without restoring or replaying it", async () => {
  const { f, page, index } = await seed()
  const removed = index.files.find((file) => file.path === "obsolete.txt")!
  const selection = {
    target: page,
    files: [{ path: "notes/new.md", bytes: testBytes("# New note\n\nDurable text.\n") }],
    remove: ["obsolete.txt"],
  }
  const plan = await f.run(prepareCurrentSkillPatch(library, selection))
  f.failNext({ kind: "retire-file", outcome: "accepted" })
  await expect(
    f.run(writeCurrentSkillPatch(library, { plan, operation_id: "replace-support" })),
  ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
  expect(f.pages.get(removed.page_id)?.in_trash).toBe(true)
  const current = await f.run(
    readCurrentOperationIntent(library, { kind: "skill", id: index.skill_id }),
  )
  if (
    current === undefined ||
    !("skill_action" in current.intent) ||
    current.intent.skill_action.kind !== "update"
  )
    throw new Error("Expected the frozen patch scope")
  const resumed = await f.run(
    prepareCurrentSkillPatch(library, { ...selection, scope: current.intent.skill_action.scope }),
  )
  expect(resumed.input_sha256).toBe(plan.input_sha256)
  expect(
    (
      await f.run(
        writeCurrentSkillPatch(library, {
          plan: resumed,
          operation_id: "replace-support",
          mode: "resume",
        }),
      )
    ).state,
  ).toBe("ready")
  expect(
    f.calls.filter(
      (call) =>
        call.path === `v1/pages/${removed.page_id}` && property(call.body).in_trash === true,
    ),
  ).toHaveLength(1)
  const final = await f.run(queryCurrentSkillIndex(library, page))
  expect(final.files.map((file) => file.path).sort()).toEqual([
    "notes/new.md",
    "references/guide.md",
    "run.sh",
  ])
  expect(final.files.find((file) => file.path === "references/guide.md")?.page_id).toBe(
    index.files.find((file) => file.path === "references/guide.md")?.page_id,
  )
  expect(pending(f)).toEqual([])
  expect(f.table("records")).toHaveLength(1)
  f.clearCalls()
  const repeat = await f.run(prepareCurrentSkillPatch(library, selection))
  expect(
    (await f.run(writeCurrentSkillPatch(library, { plan: repeat, operation_id: "repeat" }))).status,
  ).toBe("unchanged")
  expect(f.mutations()).toEqual([])
})

test("a removal cannot strand a preserved native reference, including on the read-only preview", async () => {
  const { f, page } = await seed()
  const plan = await f.run(
    prepareCurrentSkillPatch(library, { target: page, remove: ["references/guide.md"] }),
  )
  await expect(f.run(inspectCurrentSkillPatch(library, plan))).rejects.toMatchObject({
    code: "SHARED_REFERENCE_BROKEN",
  })
  await expect(
    f.run(writeCurrentSkillPatch(library, { plan, operation_id: "broken-reference" })),
  ).rejects.toMatchObject({ code: "SHARED_REFERENCE_BROKEN" })
  expect(f.mutations()).toEqual([])
  expect(pending(f)).toEqual([])
})

test("a stale prepared patch refuses a newly added unselected binding instead of pruning it", async () => {
  const { f, page } = await seed()
  const stale = await f.run(
    prepareCurrentSkillPatch(library, { target: page, metadata: { description: "Stale patch" } }),
  )
  const next = await f.run(
    prepareCurrentSkillPatch(library, {
      target: page,
      files: [{ path: "later.md", bytes: testBytes("# Concurrent addition\n") }],
    }),
  )
  await f.run(writeCurrentSkillPatch(library, { plan: next, operation_id: "other-complete" }))
  const before = structuredClone([...f.pages])
  f.clearCalls()
  await expect(
    f.run(writeCurrentSkillPatch(library, { plan: stale, operation_id: "stale" })),
  ).rejects.toMatchObject({ code: "CURRENT_WRITE_CONFLICT" })
  expect([...f.pages]).toEqual(before)
  expect(f.mutations()).toEqual([])
  expect(pending(f)).toEqual([])
})

test("a Notion-owned patch refuses Source authority before creating an intent", async () => {
  const { f, page } = await seed()
  const content = {
    kind: "source",
    source_id: "provider",
    revision: "a".repeat(64),
    source_path: "skills/example/SKILL.md",
    sha256: "b".repeat(64),
    bytes: 10,
    mode: "100644",
  }
  property(property(f.pages.get(page)?.properties).content).rich_text = [
    { type: "text", text: { content: JSON.stringify(content) } },
  ]
  await expect(
    f.run(
      prepareCurrentSkillPatch(library, {
        target: page,
        metadata: { description: "Cannot bypass Source" },
      }),
    ),
  ).rejects.toMatchObject({ code: "CURRENT_SOURCE_MANAGEMENT_REQUIRED" })
  expect(f.mutations()).toEqual([])
  expect(pending(f)).toEqual([])
})

test("the create-only writer refuses an existing ready Skill even when resume is requested", async () => {
  const { f, page, plan } = await seed()
  const before = structuredClone([...f.pages])
  await expect(
    f.run(
      writeCurrentSkill(library, {
        plan,
        operation_id: "unrelated-create",
        mode: "resume",
        create_only: true,
      }),
    ),
  ).rejects.toMatchObject({ code: "CURRENT_SKILL_EXISTS" })
  expect(text(property(property(f.pages.get(page)?.properties).operation).rich_text)).toBe("")
  expect([...f.pages]).toEqual(before)
  expect(f.mutations()).toEqual([])
  expect(pending(f)).toEqual([])
})
