import { expect, test } from "bun:test"
import { Effect } from "effect"
import { exportSkill } from "../src/export.ts"
import { readImportZip } from "../src/import.ts"
import { decode, property, SnapshotSchema } from "../src/model.ts"
import { fileRef, parseRef, parseTarget, resolveRef } from "../src/ref.ts"
import { readSkill, listSkill, resolveSkillRef } from "../src/snapshot.ts"
import { Store } from "../src/store.ts"
import {
  prepareSharedSnapshotHistory,
  retainSharedSnapshotHistory,
} from "../src/shared-snapshot-history.ts"
import { restoreSharedHistory } from "../src/shared-history-workflow.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import {
  digest,
  encode,
  id,
  library,
  sharedSnapshotFixture,
  skillPage,
} from "./shared-snapshot-fixture.ts"

const options = { database: library.skills.database_id }
const url = (page: string) => "https://www.notion.so/" + page.replaceAll("-", "")
const mention = (page: string) => '<mention url="' + url(page) + '">Guide</mention>\n'
const owner = "shared_skill:library-snapshot:stable-skill"

test("public read and exported snapshot expose compiled native references and preserve the original native hash", async () => {
  const f = sharedSnapshotFixture()
  const raw = "# Instructions\n\n" + mention(id(11))
  f.bodies.set(skillPage, raw)
  const read = await f.run(readSkill(skillPage, options))
  expect("content" in read && read.content).toContain("[Guide](references/1.md)")
  expect(read.native_references?.entries[0]).toMatchObject({
    kind: "file",
    file_id: "file-1",
    skill_id: "stable-skill",
  })
  expect(
    read.native_references?.source_files.find((file) => file.path === "SKILL.md")?.body_sha256,
  ).toBe(digest(raw))
  expect(f.objects.get("objects/" + digest(raw))).toEqual(encode(raw))
  expect(read).not.toHaveProperty("required")
  const pinned = fileRef(owner, "SKILL.md", read.snapshot_id)
  let archive: Uint8Array | undefined
  f.clearCalls()
  const exported = await f.run(
    Effect.gen(function* () {
      const store = yield* Store
      return yield* exportSkill(pinned, {
        output: "/unused/native-links.zip",
        format: "zip",
        projection: "snapshot",
        offline: true,
      }).pipe(
        Effect.provideService(Store, {
          ...store,
          output: (output, bytes) =>
            Effect.sync(() => {
              archive = bytes
              return { output, reused: false }
            }),
        }),
      )
    }),
  )
  expect(exported.native_references).toEqual(read.native_references)
  expect(archive).toBeDefined()
  const files = readImportZip(archive!)
  const main = files.find((file) => file.path.endsWith("SKILL.md"))!
  expect(new TextDecoder().decode(main.bytes)).toContain("[Guide](references/1.md)")
  expect(f.calls).toHaveLength(0)
})

test("body and relation-derived changes replace current index while exact parent pins retain their old bytes", async () => {
  const f = sharedSnapshotFixture()
  f.bodies.set(skillPage, mention(id(11)))
  const first = await f.target(parseTarget(skillPage), options)
  const original = structuredClone(f.json.get("snapshots/" + first.snapshot_id + ".json"))
  f.bodies.set(skillPage, mention(id(12)))
  f.main.last_edited_time = new Date(Date.now() - 500).toISOString()
  for (const [key, value] of f.json)
    if (key.startsWith("cache/latest/")) property(value).validated_at = Date.now() - 300_001
  f.clearCalls()
  const current = await f.target(parseTarget(skillPage), options)
  expect(current.native_references?.index_sha256).not.toBe(first.native_references?.index_sha256)
  expect(current.native_references?.entries[0]?.file_id).toBe("file-2")
  expect(f.readBodyCount()).toBe(1)
  expect(f.json.get("snapshots/" + first.snapshot_id + ".json")).toEqual(original)
  f.clearCalls()
  const historical = await f.run(
    readSkill(fileRef(owner, "SKILL.md", first.snapshot_id), { offline: true }),
  )
  expect(historical.native_references).toEqual(first.native_references)
  expect("content" in historical && historical.content).toContain("references/1.md")
  expect(f.calls).toHaveLength(0)
})

test("stable File references use the selected owner snapshot binding after moves and never choose a replacement at the old path", async () => {
  const f = sharedSnapshotFixture()
  const first = await f.target(parseTarget(skillPage), options)
  const selected = first.files.find((file) => file.path === "references/1.md")!
  const replacement = encode("A different File now occupies the original path\n")
  f.objects.set("objects/" + digest(replacement), replacement)
  const movedFiles = [
    ...first.files.filter((file) => file.path !== selected.path),
    { ...selected, path: "moved/guide.md" },
    { path: selected.path, bytes: replacement.length, sha256: digest(replacement) },
  ]
  const bindings = [
    ...first.file_bindings!.map((binding) =>
      binding.file_id === "file-1" ? { ...binding, path: "moved/guide.md" } : binding,
    ),
    { file_id: "replacement", page_id: id(88), path: selected.path },
  ]
  const version = digest(canonicalSharedJson({ files: movedFiles, file_bindings: bindings }))
  const snapshotId = "s_" + digest(JSON.stringify([first.scope, first.record.id, version]))
  const moved = decode(SnapshotSchema, {
    ...first,
    snapshot_id: snapshotId,
    version_id: version,
    files: movedFiles,
    file_bindings: bindings,
  })
  f.json.set("snapshots/" + snapshotId + ".json", moved)
  for (const [key, value] of f.json)
    if (key.startsWith("cache/latest/")) property(value).snapshot_id = snapshotId
  const stable = fileRef(owner, selected.path, undefined, "file-1")
  f.clearCalls()
  const current = await f.run(readSkill(stable, { offline: true }))
  expect(current.path).toBe("moved/guide.md")
  expect("content" in current && current.content).toBe("Reference one\n")
  expect(parseRef(current.ref)).toMatchObject({
    snapshot: snapshotId,
    file_id: "file-1",
    path: "moved/guide.md",
  })
  expect(
    (await f.run(listSkill(stable, { offline: true }))).files.map((file) => file.path),
  ).toEqual(["moved/guide.md"])
  expect(await f.run(resolveSkillRef(stable, "guide.md", { offline: true }))).toContain(
    "/moved/guide.md?snapshot=",
  )
  const historical = await f.run(
    readSkill(fileRef(owner, selected.path, first.snapshot_id, "file-1"), { offline: true }),
  )
  expect(historical.path).toBe("references/1.md")
  expect("content" in historical && historical.content).toBe("Reference one\n")
  const missing = await f.run(
    Effect.flip(readSkill(fileRef(owner, selected.path, snapshotId, "absent"), { offline: true })),
  )
  expect(missing.code).toBe("SHARED_FILE_BINDING_UNAVAILABLE")
  expect(f.calls).toHaveLength(0)
})

test("File IDs cannot cross owners and sibling relative refs drop the original File identity", async () => {
  const f = sharedSnapshotFixture()
  const snapshot = await f.target(parseTarget(skillPage), options)
  const base = fileRef(owner, "references/1.md", snapshot.snapshot_id, "file-1")
  expect(parseRef(resolveRef(base, "2.md"))).toEqual({
    selector: owner,
    path: "references/2.md",
    snapshot: snapshot.snapshot_id,
  })
  const wrong = fileRef(
    "shared_skill:library-snapshot:other",
    "references/1.md",
    snapshot.snapshot_id,
    "file-1",
  )
  expect((await f.run(Effect.flip(readSkill(wrong, { offline: true })))).code).toBe(
    "SNAPSHOT_CONFLICT",
  )
  expect(() => parseRef("skill://name/SKILL.md?file_id=file-1")).toThrow()
  expect(() => parseRef(fileRef(owner, "SKILL.md") + "?file_id=a&file_id=b")).toThrow()
  expect(() => parseRef(fileRef(owner, "SKILL.md") + "?file_id=%00")).toThrow()
})

test("shared Records retain and restore the frozen native reference directory without current body reads", async () => {
  const f = sharedSnapshotFixture()
  f.bodies.set(skillPage, mention(id(11)))
  const snapshot = await f.target(parseTarget(skillPage), options)
  const plan = await f.run(prepareSharedSnapshotHistory(library, snapshot))
  expect(plan.manifest.native_references).toEqual(snapshot.native_references)
  expect(plan.manifest.file_bindings).toEqual(snapshot.file_bindings)
  await f.run(retainSharedSnapshotHistory(library, { plan, mode: "create" }))
  f.json.delete("snapshots/" + snapshot.snapshot_id + ".json")
  f.objects.clear()
  f.bodies.set(skillPage, mention(id(12)))
  f.clearCalls()
  const restored = await f.run(
    restoreSharedHistory(library, { skillPageId: skillPage, pinId: plan.pin_id }),
  )
  expect(restored.native_references).toEqual(snapshot.native_references)
  expect(restored.file_bindings).toEqual(snapshot.file_bindings)
  expect(f.readBodyCount()).toBe(0)
  expect(f.writeCount()).toBe(0)
  const read = await f.run(readSkill(restored.ref, { offline: true }))
  expect("content" in read && read.content).toContain("references/1.md")
})

test("legacy pins without the new optional fields preserve their original manifest shape and path reads", async () => {
  const f = sharedSnapshotFixture()
  const current = await f.target(parseTarget(skillPage), options)
  const { file_bindings: _bindings, native_references: _references, ...legacy } = current
  const version = digest("legacy version without native reference index")
  const snapshotId = "s_" + digest(JSON.stringify([legacy.scope, legacy.record.id, version]))
  const snapshot = decode(SnapshotSchema, {
    ...legacy,
    snapshot_id: snapshotId,
    version_id: version,
  })
  f.json.set("snapshots/" + snapshotId + ".json", snapshot)
  const plan = await f.run(prepareSharedSnapshotHistory(library, snapshot))
  expect(plan.manifest).not.toHaveProperty("file_bindings")
  expect(plan.manifest).not.toHaveProperty("native_references")
  const original = canonicalSharedJson(snapshot)
  await f.run(readSkill(fileRef(owner, "references/1.md", snapshotId), { offline: true }))
  expect(canonicalSharedJson(f.json.get("snapshots/" + snapshotId + ".json"))).toBe(original)
  expect(
    (
      await f.run(
        Effect.flip(
          readSkill(fileRef(owner, "references/1.md", snapshotId, "file-1"), { offline: true }),
        ),
      )
    ).code,
  ).toBe("SHARED_FILE_BINDING_UNAVAILABLE")
})
