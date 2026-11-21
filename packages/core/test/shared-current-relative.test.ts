import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { Snapshot } from "../src/model.ts"
import { fileRef, parseRef } from "../src/ref.ts"
import { resolveSkillRef } from "../src/snapshot.ts"
import { currentBytes, currentRich, currentSnapshotFixture } from "./shared-current-fixture.ts"

const resolveSelectedRelative = (snapshot: Snapshot, from: string, relative: string) =>
  resolveSkillRef(fileRef(snapshot.record.id, from, snapshot.snapshot_id), relative, {
    offline: true,
  })

test("current relative files stay in their exact Skill and selected directory without Source discovery", async () => {
  const f = currentSnapshotFixture()
  const selected = await f.open()
  f.clearCalls()
  const fromMain = await f.run(resolveSelectedRelative(selected, "SKILL.md", "references/0.md"))
  const fromNested = await f.run(
    resolveSelectedRelative(selected, "references/nested/guide.md", "../1.md"),
  )
  expect(parseRef(fromMain)).toEqual({
    selector: selected.record.id,
    path: "references/0.md",
    snapshot: selected.snapshot_id,
  })
  expect(parseRef(fromNested)).toEqual({
    selector: selected.record.id,
    path: "references/1.md",
    snapshot: selected.snapshot_id,
  })
  expect(f.calls).toHaveLength(0)
})

test("current resource relative paths retain their owner and mode without fetching or exporting siblings", async () => {
  const f = currentSnapshotFixture({ fileCount: 1 })
  const content = await f.resource(
    0,
    "scripts/task.sh",
    currentBytes("#!/bin/sh\r\nexit 0\r\n"),
    "100755",
  )
  const selected = await f.open({ requestedPaths: [] })
  expect(selected.shared_acquisition).toMatchObject({
    version: 5,
    files: [{ kind: "resource", path: "scripts/task.sh", object_id: content.object_id }],
  })
  expect(selected.files.find((file) => file.path === "scripts/task.sh")?.mode).toBe("100755")
  f.clearCalls()
  const resolved = await f.run(
    resolveSelectedRelative(selected, "references/guide.md", "../scripts/task.sh"),
  )
  expect(parseRef(resolved)).toEqual({
    selector: selected.record.id,
    path: "scripts/task.sh",
    snapshot: selected.snapshot_id,
  })
  expect(f.calls).toHaveLength(0)
})

test("cross-Skill relative paths require current contribution links even when obsolete Source markers remain", async () => {
  const f = currentSnapshotFixture({ fileCount: 0 })
  Object.assign(f.main.properties, {
    Projection: currentRich("old-projection", "git-only marker"),
    Source: currentRich("old-source", "source-old"),
    "Source Member": currentRich("old-member", "skills/demo"),
  })
  const selected = await f.open()
  f.clearCalls()
  for (const [from, relative] of [
    ["SKILL.md", "../other/SKILL.md"],
    ["references/nested/guide.md", "../../../other/private.bin"],
  ]) {
    const result = await f.run(
      resolveSelectedRelative(selected, from!, relative!).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure")
      expect(result.failure).toMatchObject({
        code: "CURRENT_SOURCE_REQUIRED",
        details: { next: "manage_current_source_links" },
      })
  }
  expect(f.calls).toHaveLength(0)
  expect(f.semanticWrites()).toHaveLength(0)
})

test("invalid file syntax remains invalid and an explicitly named Skill ref remains explicit", async () => {
  const f = currentSnapshotFixture({ fileCount: 0 })
  const selected = await f.open()
  f.clearCalls()
  for (const relative of [
    "/absolute/file.md",
    "..\\foreign.md",
    "https://example.com/file",
    "../other/SKILL.md?revision=old",
  ])
    await expect(
      f.run(resolveSelectedRelative(selected, "SKILL.md", relative)),
    ).rejects.toMatchObject({ code: "INVALID_PATH" })
  const explicit = fileRef("shared_skill:library-current:another-skill", "SKILL.md")
  expect(await f.run(resolveSelectedRelative(selected, "SKILL.md", explicit))).toBe(explicit)
  expect(f.calls).toHaveLength(0)
})
