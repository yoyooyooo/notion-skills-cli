import { expect, test } from "bun:test"
import { fileRef } from "../src/ref.ts"
import { readResources } from "../src/resource-read.ts"
import { readSkill } from "../src/snapshot.ts"
import { currentId, currentLibrary, currentSnapshotFixture } from "./shared-current-fixture.ts"

test("an explicit Library constraint rejects a cold full reference before I/O", async () => {
  const f = currentSnapshotFixture({ fileCount: 0 })
  const ref = fileRef(`skill://demo?library=${currentLibrary.library_id}`, "SKILL.md")
  await expect(f.run(readSkill(ref, { library: currentId(9999) }))).rejects.toMatchObject({
    code: "LIBRARY_SCOPE_MISMATCH",
  })
  expect(f.calls).toEqual([])
  expect(f.semanticWrites()).toEqual([])

  const allowed = await f.run(readSkill(ref, { library: currentLibrary.library_id }))
  expect(allowed.record.id).toBe(`skill://demo?library=${currentLibrary.library_id}`)
  expect(allowed).toMatchObject({ content: expect.stringContaining("Keep the author's content.") })
  expect(f.semanticWrites()).toEqual([])
})

test.each(["current", "fixed", "resources"] as const)(
  "an explicit database conflict keeps its Library error without I/O for %s selection",
  async (selection) => {
    const f = currentSnapshotFixture({ fileCount: 1 })
    const selected = await f.open()
    await f.run(readSkill(fileRef(selected.record.id, selected.entrypoint)))
    const options = { library: currentId(9999) }
    f.clearCalls()
    if (selection === "resources") {
      const resource = selected.files.find((file) => file.path !== selected.entrypoint)
      if (resource === undefined) throw new Error("The fixture needs a supporting file")
      expect(
        await f.run(
          readResources(
            {
              version: 1,
              refs: [fileRef(selected.record.id, resource.path, selected.snapshot_id)],
            },
            options,
          ),
        ),
      ).toMatchObject({ status: "failed", error: { code: "LIBRARY_SCOPE_MISMATCH" } })
    } else {
      await expect(
        f.run(
          readSkill(
            fileRef(
              selected.record.id,
              selected.entrypoint,
              selection === "fixed" ? selected.snapshot_id : undefined,
            ),
            options,
          ),
        ),
      ).rejects.toMatchObject({ code: "LIBRARY_SCOPE_MISMATCH" })
    }
    expect(f.calls).toEqual([])
    expect(f.semanticWrites()).toEqual([])
  },
)

test("an explicit physical page keeps its database containment error on a warm read", async () => {
  const f = currentSnapshotFixture({ fileCount: 0 })
  await f.run(readSkill(f.main.id))
  f.clearCalls()
  await expect(f.run(readSkill(f.main.id, { library: currentId(9999) }))).rejects.toMatchObject({
    code: "SKILL_NOT_FOUND",
  })
  expect(f.calls).toEqual([])
  expect(f.semanticWrites()).toEqual([])
})

test("a fixed reference rejects a foreign Library with the same stable Skill ID before source work", async () => {
  const f = currentSnapshotFixture({ fileCount: 0 })
  const selected = await f.open()
  f.clearCalls()
  for (const path of ["", "SKILL.md"]) {
    await expect(
      f.run(
        readSkill(
          fileRef(
            "skill://demo?library=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            path,
            selected.snapshot_id,
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: "SNAPSHOT_CONFLICT" })
  }
  expect(f.calls).toEqual([])
  expect(f.semanticWrites()).toEqual([])
})

test("a missing selected manifest never falls back to an available current snapshot", async () => {
  const f = currentSnapshotFixture({ fileCount: 0 })
  const selected = await f.open()
  const missing = `s_${"0".repeat(64)}`
  expect(f.json.has(`snapshots/${selected.snapshot_id}.json`)).toBe(true)
  expect(f.json.has(`snapshots/${missing}.json`)).toBe(false)
  f.clearCalls()
  for (const offline of [false, true]) {
    await expect(
      f.run(readSkill(fileRef(selected.record.id, "SKILL.md", missing), { offline })),
    ).rejects.toMatchObject({ code: "SNAPSHOT_MISSING" })
  }
  expect(f.calls).toEqual([])
  expect(f.semanticWrites()).toEqual([])
})

test("a pathless fixed reference keeps the manifest entrypoint after the live kind and main change", async () => {
  const f = currentSnapshotFixture({ fileCount: 0 })
  const selected = await f.open()
  f.main.properties.Kind.select.name = "router"
  f.bodies.set(f.main.id, "# New current router\n\nChanged live instructions.\n")
  const current = await f.open({ forceFull: true })
  expect(current.entrypoint).toBe("ROUTER.md")
  expect(current.snapshot_id).not.toBe(selected.snapshot_id)
  f.clearCalls()
  const result = await f.run(readSkill(fileRef(selected.record.id, "", selected.snapshot_id)))
  expect(result.path).toBe("SKILL.md")
  expect(result.snapshot_id).toBe(selected.snapshot_id)
  if (!("content" in result) || typeof result.content !== "string")
    throw new Error("The selected text entrypoint must return its instruction content.")
  expect(result.content).toContain("Keep the author's content.")
  expect(result.content).not.toContain("Changed live instructions.")
  expect(f.calls).toEqual([])
  expect(f.semanticWrites()).toEqual([])
})

test("a fixed missing path cannot be repaired by selecting another manifest file", async () => {
  const f = currentSnapshotFixture({ fileCount: 1 })
  const selected = await f.open()
  f.clearCalls()
  await expect(
    f.run(readSkill(fileRef(selected.record.id, "former-name.md", selected.snapshot_id))),
  ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" })
  expect(f.calls).toEqual([])
  expect(f.semanticWrites()).toEqual([])
})
