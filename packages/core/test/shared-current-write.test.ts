import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { trashPath } from "../src/local-locks.ts"
import { exportPortable, snapshotPortable } from "../src/export.ts"
import { property, text } from "../src/model.ts"
import { queryCurrentSkillIndex } from "../src/shared-current-index.ts"
import { loadCurrentSharedResourceContent } from "../src/shared-current-resource.ts"
import {
  prepareCurrentSkillWrite,
  writeCurrentSkill,
  type CurrentSkillWriteInput,
} from "../src/shared-current-write.ts"
import { openSharedSnapshot } from "../src/shared-snapshot.ts"
import { currentWriteFixture, library, testBytes } from "./shared-current-write-fixture.ts"

const parent = mkdtempSync(join(tmpdir(), "ntn-current-write-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})
const main = testBytes(
  "---\r\nname: Example\r\ndescription: Current writer integration\r\n---\r\n# Example\r\n\r\nRead [guide](references/guide.md).\r\n",
)
const guide = testBytes("# Guide\n\nComplete child document.\n")
function input(
  files: CurrentSkillWriteInput["files"] = [
    { path: "SKILL.md", bytes: main },
    { path: "references/guide.md", bytes: guide },
  ],
): CurrentSkillWriteInput {
  return {
    skill_id: "example",
    kind: "skill",
    name: "Example",
    description: "Current writer integration",
    files,
  }
}

describe("complete current Skill writer", () => {
  test("changed bytes after preparation are rejected before opening a current intent", async () => {
    const f = currentWriteFixture(parent),
      plan = await f.run(prepareCurrentSkillWrite(input()))
    const file = plan.files[0]!
    file.bytes[0] = (file.bytes[0] ?? 0) ^ 1
    await expect(
      f.run(writeCurrentSkill(library, { plan, operation_id: "changed-input" })),
    ).rejects.toBeDefined()
    expect(f.mutations()).toEqual([])
    expect(f.pages.size).toBe(0)
  })
  test("creates one current tree with complete reading pages and exact resource bytes", async () => {
    const f = currentWriteFixture(parent)
    const plan = await f.run(prepareCurrentSkillWrite(input()))
    const result = await f.run(writeCurrentSkill(library, { plan, operation_id: "write-first" }))
    expect(result).toMatchObject({ status: "applied", state: "ready", files: 2 })
    expect(f.table("skills")).toHaveLength(1)
    expect(f.table("files")).toHaveLength(1)
    expect(f.table("records")).toHaveLength(2)
    const index = await f.run(queryCurrentSkillIndex(library, result.page_id))
    expect(index.state).toEqual({ state: "ready" })
    expect([index.main.path, ...index.files.map((file) => file.path)]).toEqual([
      "SKILL.md",
      "references/guide.md",
    ])
    for (const file of [index.main, ...index.files]) {
      if (file.content.kind !== "resource") throw new Error("Expected resource authority")
      const original = await f.run(
        loadCurrentSharedResourceContent(library, {
          owner: { kind: "skill", page_id: result.page_id },
          content: file.content,
        }),
      )
      expect(original.bytes).toEqual(file.path === "SKILL.md" ? main : guide)
      const body = f.blocks.get(file.page_id) ?? []
      expect(body.length).toBeGreaterThan(0)
      expect(
        body.map((block) => text(property(block[String(block.type)]).rich_text)).join("\n"),
      ).toContain(file.path === "SKILL.md" ? "Example" : "Complete child document.")
    }
    expect(
      [...f.json.keys()].filter((key) => key.startsWith("operations/current-write-pending/")),
    ).toEqual([])
    const snapshot = await f.run(
      openSharedSnapshot({
        library,
        target: result.page_id,
        scope: "a".repeat(64),
        startedAt: Date.now(),
        forceFull: true,
      }),
    )
    const portable = await f.run(snapshotPortable(snapshot))
    const directory = join(f.root, "exported")
    await f.run(
      exportPortable(portable, { output: directory, format: "directory", projection: "snapshot" }),
    )
    expect(new Uint8Array(readFileSync(join(directory, "SKILL.md")))).toEqual(main)
    expect(new Uint8Array(readFileSync(join(directory, "references/guide.md")))).toEqual(guide)
  })
  test("a new operation with unchanged complete input does no semantic writes", async () => {
    const f = currentWriteFixture(parent),
      plan = await f.run(prepareCurrentSkillWrite(input()))
    await f.run(writeCurrentSkill(library, { plan, operation_id: "initial" }))
    const pages = f.pages.size
    f.clearCalls()
    expect(
      await f.run(writeCurrentSkill(library, { plan, operation_id: "another-operation" })),
    ).toMatchObject({ status: "unchanged", state: "ready" })
    expect(f.mutations()).toEqual([])
    expect(f.pages.size).toBe(pages)
    await expect(
      f.run(
        writeCurrentSkill(library, { plan, operation_id: "another-operation", mode: "resume" }),
      ),
    ).rejects.toMatchObject({ code: "CURRENT_OPERATION_NOT_FOUND" })
    expect(f.mutations()).toEqual([])
  })
  test("complete replacement removes old Files and unreferenced originals", async () => {
    const f = currentWriteFixture(parent),
      first = await f.run(prepareCurrentSkillWrite(input()))
    const written = await f.run(writeCurrentSkill(library, { plan: first, operation_id: "first" }))
    const oldFile = f.table("files")[0]!,
      oldResources = f.table("records").map((row) => String(row.id))
    const replacement = input([
      { path: "SKILL.md", bytes: testBytes("# New\n[run](scripts/run.ts)\n") },
      { path: "scripts/run.ts", bytes: testBytes("export const current = true\n"), mode: "100755" },
    ])
    const next = await f.run(prepareCurrentSkillWrite(replacement))
    expect(
      await f.run(writeCurrentSkill(library, { plan: next, operation_id: "replace" })),
    ).toMatchObject({ page_id: written.page_id, files: 2, status: "applied" })
    expect(f.pages.get(String(oldFile.id))?.in_trash).toBe(true)
    for (const page of oldResources) expect(f.pages.get(page)?.in_trash).toBe(true)
    const index = await f.run(queryCurrentSkillIndex(library, written.page_id))
    expect(index.files.map((file) => file.path)).toEqual(["scripts/run.ts"])
    expect(f.table("records")).toHaveLength(2)
    for (const file of [index.main, ...index.files]) {
      if (file.content.kind !== "resource") throw new Error("Expected resource")
      const result = await f.run(
        loadCurrentSharedResourceContent(library, {
          owner: { kind: "skill", page_id: index.page_id },
          content: file.content,
        }),
      )
      expect(result.bytes).toEqual(replacement.files.find((item) => item.path === file.path)!.bytes)
    }
  })
  test("omitted enabled and default-context fields preserve the current Notion choices", async () => {
    const f = currentWriteFixture(parent)
    const initial = await f.run(
      prepareCurrentSkillWrite({ ...input(), enabled: false, default_context: true }),
    )
    const first = await f.run(
      writeCurrentSkill(library, { plan: initial, operation_id: "explicit-flags" }),
    )
    const next = await f.run(
      prepareCurrentSkillWrite(
        input([{ path: "SKILL.md", bytes: testBytes("# Changed while disabled\n") }]),
      ),
    )
    await f.run(writeCurrentSkill(library, { plan: next, operation_id: "preserve-flags" }))
    const index = await f.run(queryCurrentSkillIndex(library, first.page_id))
    expect(index.enabled).toBe(false)
    expect(index.default_context).toBe(true)
    expect(index.state).toEqual({ state: "ready" })
    expect(index.files).toHaveLength(0)
  })
  test("stable File IDs survive a path swap and a rename without creating replacement rows", async () => {
    const f = currentWriteFixture(parent)
    const files = [
      { path: "SKILL.md", bytes: testBytes("# Main\n") },
      { path: "one.md", file_id: "file-one", bytes: testBytes("# One\n") },
      { path: "two.md", file_id: "file-two", bytes: testBytes("# Two\n") },
    ]
    const first = await f.run(prepareCurrentSkillWrite(input(files)))
    const result = await f.run(
      writeCurrentSkill(library, { plan: first, operation_id: "before-swap" }),
    )
    const before = await f.run(queryCurrentSkillIndex(library, result.page_id))
    const swapped = await f.run(
      prepareCurrentSkillWrite(
        input([files[0]!, { ...files[1]!, path: "two.md" }, { ...files[2]!, path: "one.md" }]),
      ),
    )
    await f.run(writeCurrentSkill(library, { plan: swapped, operation_id: "swap" }))
    const after = await f.run(queryCurrentSkillIndex(library, result.page_id))
    for (const file of before.files) {
      const current = after.files.find((item) => item.file_id === file.file_id)!
      expect(current.page_id).toBe(file.page_id)
      expect(current.path).toBe(file.path === "one.md" ? "two.md" : "one.md")
    }
    const renamed = await f.run(
      prepareCurrentSkillWrite(
        input([
          files[0]!,
          { ...files[1]!, path: "guides/renamed.md" },
          { ...files[2]!, path: "one.md" },
        ]),
      ),
    )
    await f.run(writeCurrentSkill(library, { plan: renamed, operation_id: "rename" }))
    const final = await f.run(queryCurrentSkillIndex(library, result.page_id))
    expect(final.files.find((file) => file.file_id === "file-one")?.page_id).toBe(
      before.files.find((file) => file.file_id === "file-one")?.page_id,
    )
    expect(final.files.map((file) => file.path).sort()).toEqual(["guides/renamed.md", "one.md"])
    expect(f.table("files", false)).toHaveLength(2)
    expect(f.table("records")).toHaveLength(3)
  })
  test.each(["file-create", "append"] as const)(
    "accepted unknown %s resumes from current state without repeating the mutation",
    async (kind) => {
      const f = currentWriteFixture(parent),
        plan = await f.run(prepareCurrentSkillWrite(input()))
      f.failNext({ kind, outcome: "accepted" })
      await expect(
        f.run(writeCurrentSkill(library, { plan, operation_id: "interrupted" })),
      ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
      const original = f.calls.findLast((call) =>
        kind === "append"
          ? call.path.includes("/children") && call.method === "PATCH"
          : call.path === "v1/pages" &&
            property(property(call.body).parent).data_source_id === library.files.data_source_id,
      )!
      const matching = () =>
        f.calls.filter(
          (call) =>
            call.path === original.path &&
            call.method === original.method &&
            JSON.stringify(call.body) === JSON.stringify(original.body),
        )
      expect(matching()).toHaveLength(1)
      const result = await f.run(
        writeCurrentSkill(library, { plan, operation_id: "interrupted", mode: "resume" }),
      )
      expect(result.state).toBe("ready")
      expect(matching()).toHaveLength(1)
      expect(f.table("skills")).toHaveLength(1)
      expect(f.table("files")).toHaveLength(1)
      expect(f.table("records")).toHaveLength(2)
    },
  )
  test.each(["retire-file", "retire-resource"] as const)(
    "accepted unknown %s is recovered even after it disappears from active queries",
    async (kind) => {
      const f = currentWriteFixture(parent),
        initial = await f.run(prepareCurrentSkillWrite(input()))
      await f.run(writeCurrentSkill(library, { plan: initial, operation_id: "initial" }))
      const plan = await f.run(
        prepareCurrentSkillWrite(
          input([{ path: "SKILL.md", bytes: testBytes("# Replacement\n") }]),
        ),
      )
      f.failNext({ kind, outcome: "accepted" })
      await expect(
        f.run(writeCurrentSkill(library, { plan, operation_id: "cleanup" })),
      ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
      const original = f.calls.findLast(
        (call) => call.method === "PATCH" && property(call.body).in_trash === true,
      )!
      expect(f.pages.get(original.path.replace("v1/pages/", ""))?.in_trash).toBe(true)
      await f.run(writeCurrentSkill(library, { plan, operation_id: "cleanup", mode: "resume" }))
      expect(
        f.calls.filter(
          (call) => call.path === original.path && property(call.body).in_trash === true,
        ),
      ).toHaveLength(1)
      expect(f.table("files")).toHaveLength(0)
      expect(f.table("records")).toHaveLength(1)
      expect(
        [...f.json.keys()].filter((key) => key.startsWith("operations/current-write-pending/")),
      ).toEqual([])
    },
  )
  test("incomplete pagination and a foreign owner fail before any semantic write", async () => {
    const f = currentWriteFixture(parent),
      plan = await f.run(prepareCurrentSkillWrite(input()))
    f.rewrite((path, row) =>
      path.includes(library.skills.data_source_id)
        ? { ...row, has_more: true, next_cursor: null }
        : row,
    )
    await expect(
      f.run(writeCurrentSkill(library, { plan, operation_id: "bad-page" })),
    ).rejects.toMatchObject({ code: "CURRENT_WRITE_CONFLICT" })
    expect(f.mutations()).toEqual([])
    f.rewrite()
    const result = await f.run(writeCurrentSkill(library, { plan, operation_id: "initial" }))
    const fields = property(f.pages.get(result.page_id)?.properties)
    property(fields["current-state"]).select = { name: "applying" }
    property(fields.operation).rich_text = [
      { type: "text", text: { content: "foreign-operation" } },
    ]
    f.clearCalls()
    await expect(
      f.run(writeCurrentSkill(library, { plan, operation_id: "wrong-owner" })),
    ).rejects.toMatchObject({ code: "CURRENT_OPERATION_CONFLICT" })
    expect(f.mutations()).toEqual([])
  })
  test("a partial append remains pending, blocks consumption and never repeats the batch", async () => {
    const f = currentWriteFixture(parent),
      plan = await f.run(prepareCurrentSkillWrite(input()))
    f.failNext({ kind: "append", outcome: "partial" })
    await expect(
      f.run(writeCurrentSkill(library, { plan, operation_id: "partial" })),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    const writes = f.mutations().length,
      owner = String(f.table("skills")[0]?.id)
    const resumed = await f.run(
      writeCurrentSkill(library, { plan, operation_id: "partial", mode: "resume" }).pipe(
        Effect.result,
      ),
    )
    expect(resumed._tag).toBe("Failure")
    expect(f.mutations()).toHaveLength(writes)
    expect(
      f.calls.filter((call) => call.path.includes("/children") && call.method === "PATCH"),
    ).toHaveLength(1)
    await expect(
      f.run(
        openSharedSnapshot({
          library,
          target: owner,
          scope: "c".repeat(64),
          startedAt: Date.now(),
        }),
      ),
    ).rejects.toMatchObject({ code: "CURRENT_OPERATION_PENDING" })
    expect(
      [...f.json.keys()].filter((key) => key.startsWith("operations/current-write-pending/")),
    ).toHaveLength(1)
  })
  test("accepted unknown attachment Record and projection reuse the same uploaded original", async () => {
    const f = currentWriteFixture(parent),
      root = { path: "SKILL.md", bytes: testBytes("# Assets\n") }
    const initial = await f.run(prepareCurrentSkillWrite(input([root])))
    await f.run(writeCurrentSkill(library, { plan: initial, operation_id: "initial" }))
    const asset = { path: "assets/font.otf", bytes: new Uint8Array([0, 255, 17, 5, 0, 1, 13, 10]) }
    const plan = await f.run(prepareCurrentSkillWrite(input([root, asset])))
    f.failNext({ kind: "resource-create", outcome: "accepted" })
    await expect(
      f.run(writeCurrentSkill(library, { plan, operation_id: "attachment-resume" })),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    expect(f.uploads.size).toBe(1)
    f.failNext({ kind: "append", outcome: "accepted" })
    await expect(
      f.run(
        writeCurrentSkill(library, { plan, operation_id: "attachment-resume", mode: "resume" }),
      ),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    const appended = f.calls.filter(
      (call) => call.path.includes("/children") && call.method === "PATCH",
    ).length
    const result = await f.run(
      writeCurrentSkill(library, { plan, operation_id: "attachment-resume", mode: "resume" }),
    )
    expect(f.uploads.size).toBe(1)
    expect(f.calls.filter((call) => call.path.endsWith("/send"))).toHaveLength(1)
    expect(
      f.calls.filter((call) => call.path.includes("/children") && call.method === "PATCH"),
    ).toHaveLength(appended)
    expect(f.table("files")).toHaveLength(1)
    expect(f.table("records")).toHaveLength(2)
    const snapshot = await f.run(
      openSharedSnapshot({
        library,
        target: result.page_id,
        scope: "d".repeat(64),
        startedAt: Date.now(),
        forceFull: true,
      }),
    )
    const portable = await f.run(snapshotPortable(snapshot))
    expect(portable.files.find((file) => file.path === asset.path)?.bytes).toEqual(asset.bytes)
  })
  test("raw and one-file ZIP attachments retain exact bytes through upload, projection and current export", async () => {
    const f = currentWriteFixture(parent)
    const png = new Uint8Array([137, 80, 78, 71, 0, 255, 13, 10]),
      font = new Uint8Array([0, 255, 10, 65, 12, 0, 13, 10])
    const originals = [
      { path: "SKILL.md", bytes: testBytes("# Assets\n") },
      { path: "assets/logo.png", bytes: png },
      { path: "assets/logo-copy.png", bytes: png },
      { path: "assets/font.otf", bytes: font },
    ]
    const plan = await f.run(prepareCurrentSkillWrite(input(originals)))
    const result = await f.run(writeCurrentSkill(library, { plan, operation_id: "attachments" }))
    expect(f.uploads.size).toBe(2)
    expect(f.calls.filter((call) => call.path.endsWith("/send"))).toHaveLength(2)
    expect(
      [...f.uploadedBytes.values()].some(
        (value) => value.length === png.length && value.every((byte, index) => byte === png[index]),
      ),
    ).toBe(true)
    expect([...f.uploadedBytes.values()].some((value) => value.length > font.length)).toBe(true)
    const snapshot = await f.run(
      openSharedSnapshot({
        library,
        target: result.page_id,
        scope: "b".repeat(64),
        startedAt: Date.now(),
        forceFull: true,
      }),
    )
    const portable = await f.run(snapshotPortable(snapshot))
    for (const file of originals)
      expect(portable.files.find((item) => item.path === file.path)?.bytes).toEqual(file.bytes)
    for (const file of (await f.run(queryCurrentSkillIndex(library, result.page_id))).files) {
      const body = f.blocks.get(file.page_id) ?? []
      expect(body.some((block) => block.type === "file")).toBe(true)
      if (file.path.endsWith(".png"))
        expect(body.some((block) => block.type === "image")).toBe(true)
    }
    f.clearCalls()
    await f.run(writeCurrentSkill(library, { plan, operation_id: "attachments-noop" }))
    expect(f.mutations()).toEqual([])
    expect(f.uploads.size).toBe(2)
    const index = await f.run(queryCurrentSkillIndex(library, result.page_id))
    const damaged = index.files.find((file) => file.path === "assets/logo.png")!
    f.blocks.set(damaged.page_id, [])
    expect(
      await f.run(writeCurrentSkill(library, { plan, operation_id: "repair-attachment-reading" })),
    ).toMatchObject({ status: "applied", state: "ready" })
    expect(f.uploads.size).toBe(3)
    f.clearCalls()
    await f.run(writeCurrentSkill(library, { plan, operation_id: "repaired-noop" }))
    expect(f.mutations()).toEqual([])
    expect(f.uploads.size).toBe(3)
  })
})
