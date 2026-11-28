import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { Snapshot } from "../src/model.ts"
import { fileRef, parseRef } from "../src/ref.ts"
import { readSkill, resolveReference, resolveSkillRef } from "../src/snapshot.ts"
import { currentBytes, currentRich, currentSnapshotFixture } from "./shared-current-fixture.ts"

const resolveSelectedRelative = (snapshot: Snapshot, from: string, relative: string) =>
  resolveSkillRef(fileRef(snapshot.record.id, from, snapshot.snapshot_id), relative, {
    offline: true,
  })

test("current relative files stay in their exact Skill and selected directory without Source discovery", async () => {
  const f = currentSnapshotFixture()
  f.files[0]!.properties.Path = currentRich("path", "references/nested/guide.md")
  const selected = await f.open()
  f.clearCalls()
  const fromMain = await f.run(
    resolveSelectedRelative(selected, "SKILL.md", "references/nested/guide.md"),
  )
  const fromNested = await f.run(
    resolveSelectedRelative(selected, "references/nested/guide.md", "../1.md"),
  )
  expect(parseRef(fromMain)).toMatchObject({
    skillId: "demo",
    scope: { kind: "library", libraryId: "00000000-0000-4000-8000-000000000002" },
    path: "references/nested/guide.md",
    selection: { kind: "fixed", snapshotId: selected.snapshot_id },
  })
  expect(parseRef(fromNested)).toMatchObject({
    skillId: "demo",
    scope: { kind: "library", libraryId: "00000000-0000-4000-8000-000000000002" },
    path: "references/1.md",
    selection: { kind: "fixed", snapshotId: selected.snapshot_id },
  })
  expect(f.calls).toHaveLength(0)
})

test("current resource relative paths retain their owner and mode without fetching or exporting siblings", async () => {
  const f = currentSnapshotFixture({ fileCount: 2 })
  f.files[1]!.properties.Path = currentRich("path", "references/guide.md")
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
  expect(parseRef(resolved)).toMatchObject({
    skillId: "demo",
    scope: { kind: "library", libraryId: "00000000-0000-4000-8000-000000000002" },
    path: "scripts/task.sh",
    selection: { kind: "fixed", snapshotId: selected.snapshot_id },
  })
  expect(f.calls).toHaveLength(0)
})

test("cross-Skill relative paths require current contribution links even when obsolete Source markers remain", async () => {
  const f = currentSnapshotFixture({ fileCount: 1 })
  f.files[0]!.properties.Path = currentRich("path", "references/nested/guide.md")
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
  for (const relative of ["/absolute/file.md", "..\\foreign.md", "../other/SKILL.md?revision=old"])
    await expect(
      f.run(resolveSelectedRelative(selected, "SKILL.md", relative)),
    ).rejects.toMatchObject({ code: "INVALID_PATH" })
  const explicit = fileRef(
    "skill://another-skill?library=00000000-0000-4000-8000-000000000002",
    "SKILL.md",
  )
  expect(await f.run(resolveSelectedRelative(selected, "SKILL.md", explicit))).toBe(explicit)
  expect(f.calls).toHaveLength(0)
})

test("identity resolution and reads require the exact containing manifest path without acquiring bodies", async () => {
  const f = currentSnapshotFixture()
  const selected = await f.open()
  const from = fileRef(selected.record.id, "references/0.md", selected.snapshot_id)
  f.clearCalls()
  const resolved = await f.run(resolveReference("../SKILL.md", { from, offline: true }))
  expect(resolved).toMatchObject({
    version: 1,
    from,
    effects: { version: 1, remote_writes: "none", author_content: "unchanged" },
  })
  expect(parseRef(resolved.ref)).toMatchObject({
    skillId: "demo",
    scope: { kind: "library", libraryId: "00000000-0000-4000-8000-000000000002" },
    selection: { kind: "fixed", snapshotId: selected.snapshot_id },
    path: "SKILL.md",
  })
  const read = await f.run(readSkill("../SKILL.md", { from, offline: true }))
  expect(read.ref).toBe(fileRef(selected.record.id, "SKILL.md", selected.snapshot_id))
  expect(f.calls).toEqual([])
})

test("identity resolution rejects unfixed, noncanonical and nonexistent containing Files", async () => {
  const f = currentSnapshotFixture()
  const selected = await f.open()
  f.clearCalls()
  for (const from of [
    fileRef(selected.record.id, "SKILL.md"),
    `skill://demo/SKILL.md?snapshot=${selected.snapshot_id}`,
    fileRef(selected.record.id, "", selected.snapshot_id),
  ])
    await expect(
      f.run(resolveReference("./SKILL.md", { from, offline: true })),
    ).rejects.toMatchObject({ code: "EXACT_TARGET_REQUIRED" })
  await expect(
    f.run(
      resolveReference("../SKILL.md", {
        from: fileRef(selected.record.id, "missing/guide.md", selected.snapshot_id),
        offline: true,
      }),
    ),
  ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" })
  expect(f.calls).toEqual([])
  expect(f.semanticWrites()).toEqual([])
})

test("containing Library binds short references independently of ambient defaults and cross owners do not share pins", async () => {
  const f = currentSnapshotFixture(),
    selected = await f.open()
  const from = fileRef(selected.record.id, "SKILL.md", selected.snapshot_id)
  f.clearCalls()
  const same = await f.run(resolveReference("skill://demo", { from, offline: true }))
  expect(same.ref).toBe(fileRef(selected.record.id, "", selected.snapshot_id))
  const other = await f.run(resolveReference("skill://other", { from, offline: true }))
  expect(other.ref).toBe("skill://other?library=00000000-0000-4000-8000-000000000002")
  const foreign = await f.run(
    resolveReference("skill://demo?library=00000000-0000-4000-8000-000000000117", {
      from,
      offline: true,
    }),
  )
  expect(foreign.ref).toBe("skill://demo?library=00000000-0000-4000-8000-000000000117")
  expect(f.calls).toEqual([])
  expect(f.semanticWrites()).toEqual([])
})
