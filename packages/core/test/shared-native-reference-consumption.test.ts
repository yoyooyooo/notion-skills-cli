import { expect, test } from "bun:test"
import { Effect } from "effect"
import { exportSkill } from "../src/export.ts"
import { readImportZip } from "../src/import.ts"
import { decode, property, SnapshotSchema } from "../src/model.ts"
import { fileRef, parseRef, parseTarget, resolveRef } from "../src/ref.ts"
import { readSkill, listSkill, resolveSkillRef } from "../src/snapshot.ts"
import { Store } from "../src/store.ts"
import { readResources } from "../src/resource-read.ts"
import { sharedRecordFromPage } from "../src/shared-content.ts"
import { compileSharedNativeReferences } from "../src/shared-native-references.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import {
  currentDigest as digest,
  currentBytes as encode,
  currentId as id,
  currentLibrary as library,
  currentSnapshotFixture,
  currentSkillPage as skillPage,
  currentRich as rich,
} from "./shared-current-fixture.ts"
import { currentSourceConsumerFixture } from "./shared-current-source-consumer-fixture.ts"

const options = { database: library.skills.database_id }
const url = (page: string) => "https://www.notion.so/" + page.replaceAll("-", "")
const mention = (page: string) => '<mention url="' + url(page) + '">Guide</mention>\n'
const owner = "shared_skill:library-current:demo"

test("native same-Skill Source reading links retain relative text and usable path references", async () => {
  const f = await currentSourceConsumerFixture()
  await f.select(
    [
      { path: "SKILL.md", bytes: encode("# Provider main\n"), mode: "100644" },
      { path: "references/guide.md", bytes: encode("# Provider guide\n"), mode: "100644" },
    ],
    "git",
  )
  const guidePage = f.bind("references/guide.md")
  f.native("SKILL.md", mention(guidePage))
  f.contribute([
    { member_key: ".", skill_id: "demo", mount_path: "", mapping: {}, exclude: ["SKILL.md"] },
  ])
  const main = await f.run(readSkill(skillPage, options))
  expect("content" in main && main.content).toContain("[Guide](references/guide.md)")
  const reference = main.native_references?.entries[0]
  if (reference === undefined) throw new Error("Expected same-Skill Source reference")
  expect(reference.file_id).toBeUndefined()
  expect(parseRef(reference.ref)).toEqual({ selector: owner, path: "references/guide.md" })
  const guide = await f.run(readSkill(reference.ref, options))
  expect("content" in guide && guide.content).toBe("# Provider guide\n")
  expect(f.semanticWrites()).toEqual([])
})

test("cross-Skill native Source reading references support public reads and cold resource batches without projection File IDs", async () => {
  const f = await currentSourceConsumerFixture()
  const guideBody = "# Complete Source guide\n"
  await f.select(
    [
      { path: "SKILL.md", bytes: encode("# Provider main\n"), mode: "100644" },
      { path: "references/guide.md", bytes: encode(guideBody), mode: "100644" },
    ],
    "git",
  )
  f.bind("SKILL.md")
  const guidePage = f.bind("references/guide.md")
  const author = {
    ...structuredClone(f.main),
    id: id(77),
    properties: {
      ...f.main.properties,
      "Skill ID": rich("skill-id", "native-author"),
      Content: rich("content", JSON.stringify({ kind: "native", mode: "100644", frontmatter: "" })),
    },
  }
  const record = sharedRecordFromPage(
    author,
    {
      alias: library.library_id,
      title: "",
      role: "content",
      database_id: library.skills.database_id,
      data_source_ids: [library.skills.data_source_id],
      shared_library: library,
    },
    library.skills.data_source_id,
  )
  const markdown = mention(guidePage)
  const compiled = await f.run(
    compileSharedNativeReferences({
      library,
      record,
      bindings: [],
      files: [
        {
          path: "SKILL.md",
          markdown,
          body_sha256: digest(markdown),
          page_id: author.id,
        },
      ],
      relations: { members: [], required: [] },
      inventory: {
        skills: {
          data_source_id: library.skills.data_source_id,
          complete: true,
          pages: [author, f.main],
        },
        files: { data_source_id: library.files.data_source_id, complete: true, pages: f.files },
      },
    }),
  )
  const reference = compiled.index?.entries[0]
  if (reference === undefined) throw new Error("Expected cross-Skill Source reference")
  expect(reference).toMatchObject({ kind: "file", skill_id: "demo", availability: "metadata_only" })
  expect(reference.file_id).toBeUndefined()
  expect(parseRef(reference.ref)).toEqual({ selector: owner, path: "references/guide.md" })
  const read = await f.run(readSkill(reference.ref, options))
  expect("content" in read && read.content).toBe(guideBody)
  expect(parseRef(read.ref).file_id).toBeUndefined()
  f.objects.delete("objects/" + digest(guideBody))
  f.clearCalls()
  f.requests.length = 0
  const batch = await f.run(readResources({ version: 1, refs: [read.ref] }, options))
  expect(batch.status, JSON.stringify(batch)).toBe("ready")
  if (batch.status !== "ready") throw new Error("Expected exact Source resource batch")
  expect(batch.files[0]?.content).toBe(guideBody)
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]).toEndWith("/references/guide.md")
  expect(f.bodyCalls()).toEqual([])
  expect(f.semanticWrites()).toEqual([])
})

test("public read and exported snapshot expose compiled native references and preserve the original native hash", async () => {
  const f = currentSnapshotFixture()
  const raw = "# Instructions\n\n" + mention(id(100))
  f.bodies.set(skillPage, raw)
  const read = await f.run(readSkill(skillPage, options))
  expect("content" in read && read.content).toContain("[Guide](references/0.md)")
  expect(read.native_references?.entries[0]).toMatchObject({
    kind: "file",
    file_id: "support-0",
    skill_id: "demo",
  })
  expect(
    read.native_references?.source_files.find((file) => file.path === "SKILL.md")?.body_sha256,
  ).toBe(digest(raw))
  expect(f.objects.get("objects/" + digest(raw))).toEqual(encode(raw))
  expect(read.required).toEqual([])
  const pinned = fileRef(owner, "SKILL.md", read.snapshot_id)
  let archive: Uint8Array | undefined
  f.clearCalls()
  const exported = await f.run(
    Effect.gen(function* () {
      const store = yield* Store
      return yield* exportSkill(pinned, {
        output: "/unused/native-links.zip",
        format: "zip",
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
  expect(new TextDecoder().decode(main.bytes)).toContain("[Guide](references/0.md)")
  expect(f.calls).toHaveLength(0)
})

test("body and relation-derived changes replace current index while exact parent pins retain their old bytes", async () => {
  const f = currentSnapshotFixture()
  f.bodies.set(skillPage, mention(id(100)))
  const first = await f.target(parseTarget(skillPage), options)
  const original = structuredClone(f.json.get("snapshots/" + first.snapshot_id + ".json"))
  f.bodies.set(skillPage, mention(id(101)))
  f.main.last_edited_time = new Date(Date.now() - 500).toISOString()
  for (const [key, value] of f.json)
    if (key.startsWith("cache/latest/")) property(value).validated_at = Date.now() - 300_001
  f.clearCalls()
  const current = await f.target(parseTarget(skillPage), options)
  expect(current.native_references?.index_sha256).not.toBe(first.native_references?.index_sha256)
  expect(current.native_references?.entries[0]?.file_id).toBe("support-1")
  expect(f.bodyCalls().length).toBe(1)
  expect(f.json.get("snapshots/" + first.snapshot_id + ".json")).toEqual(original)
  f.clearCalls()
  const historical = await f.run(
    readSkill(fileRef(owner, "SKILL.md", first.snapshot_id), { offline: true }),
  )
  expect(historical.native_references).toEqual(first.native_references)
  expect("content" in historical && historical.content).toContain("references/0.md")
  expect(f.calls).toHaveLength(0)
})

test("stable File references use the selected owner snapshot binding after moves and never choose a replacement at the old path", async () => {
  const f = currentSnapshotFixture()
  const first = await f.target(parseTarget(skillPage), options)
  const selected = first.files.find((file) => file.path === "references/0.md")!
  const replacement = encode("A different File now occupies the original path\n")
  f.files[0]!.properties.Path = rich("path", "moved/guide.md")
  const replacementRow = structuredClone(f.files[0]!)
  replacementRow.id = id(88)
  replacementRow.properties.Path = rich("path", selected.path)
  replacementRow.properties["File ID"] = rich("file-id", "replacement")
  f.files.push(replacementRow)
  f.bodies.set(replacementRow.id, new TextDecoder().decode(replacement))
  const moved = await f.target(parseTarget(skillPage), { ...options, refresh: true })
  const snapshotId = moved.snapshot_id
  const stable = fileRef(owner, selected.path, undefined, "support-0")
  f.clearCalls()
  const current = await f.run(readSkill(stable, { offline: true }))
  expect(current.path).toBe("moved/guide.md")
  expect("content" in current && current.content).toBe(
    "# Supporting 0\n\nComplete supporting text 0.\n",
  )
  expect(parseRef(current.ref)).toMatchObject({
    snapshot: snapshotId,
    file_id: "support-0",
    path: "moved/guide.md",
  })
  expect(
    (await f.run(listSkill(stable, { offline: true }))).files.map((file) => file.path),
  ).toEqual(["moved/guide.md"])
  expect(await f.run(resolveSkillRef(stable, "guide.md", { offline: true }))).toContain(
    "/moved/guide.md?snapshot=",
  )
  const historical = await f.run(
    readSkill(fileRef(owner, selected.path, first.snapshot_id, "support-0"), { offline: true }),
  )
  expect(historical.path).toBe("references/0.md")
  expect("content" in historical && historical.content).toBe(
    "# Supporting 0\n\nComplete supporting text 0.\n",
  )
  const missing = await f.run(
    Effect.flip(readSkill(fileRef(owner, selected.path, snapshotId, "absent"), { offline: true })),
  )
  expect(missing.code).toBe("SHARED_FILE_BINDING_UNAVAILABLE")
  expect(f.calls).toHaveLength(0)
})

test("File IDs cannot cross owners and sibling relative refs drop the original File identity", async () => {
  const f = currentSnapshotFixture()
  const snapshot = await f.target(parseTarget(skillPage), options)
  const base = fileRef(owner, "references/0.md", snapshot.snapshot_id, "support-0")
  expect(parseRef(resolveRef(base, "1.md"))).toEqual({
    selector: owner,
    path: "references/1.md",
    snapshot: snapshot.snapshot_id,
  })
  const wrong = fileRef(
    "shared_skill:library-current:other",
    "references/0.md",
    snapshot.snapshot_id,
    "support-0",
  )
  expect((await f.run(Effect.flip(readSkill(wrong, { offline: true })))).code).toBe(
    "SNAPSHOT_CONFLICT",
  )
  expect(() => parseRef("skill://name/SKILL.md?file_id=support-0")).toThrow()
  expect(() => parseRef(fileRef(owner, "SKILL.md") + "?file_id=a&file_id=b")).toThrow()
  expect(() => parseRef(fileRef(owner, "SKILL.md") + "?file_id=%00")).toThrow()
})

test("a missing fixed native reference manifest requires current reselection without remote recovery", async () => {
  const f = currentSnapshotFixture()
  f.bodies.set(skillPage, mention(id(100)))
  const snapshot = await f.target(parseTarget(skillPage), options)
  const selected = fileRef(owner, "SKILL.md", snapshot.snapshot_id)
  f.json.delete("snapshots/" + snapshot.snapshot_id + ".json")
  f.objects.clear()
  f.bodies.set(skillPage, mention(id(101)))
  f.clearCalls()
  for (const offline of [false, true]) {
    const error = await f.run(Effect.flip(readSkill(selected, { ...options, offline })))
    expect(error.code).toBe("SNAPSHOT_MISSING")
    expect(error.details).toMatchObject({ next: "reselect_current" })
  }
  expect(f.calls).toHaveLength(0)
  expect(f.records.size).toBe(0)
})

test("a current selected directory without exact File bindings is rejected without upgrading its cache", async () => {
  const f = currentSnapshotFixture()
  const current = await f.target(parseTarget(skillPage), options)
  const { file_bindings: _bindings, ...unbound } = current
  const version = digest("corrupt current directory without physical File bindings")
  const snapshotId = "s_" + digest(JSON.stringify([unbound.scope, unbound.record.id, version]))
  const snapshot = decode(SnapshotSchema, {
    ...unbound,
    snapshot_id: snapshotId,
    version_id: version,
  })
  f.json.set("snapshots/" + snapshotId + ".json", snapshot)
  const original = canonicalSharedJson(snapshot)
  f.clearCalls()
  for (const fileId of [undefined, "support-0"]) {
    const result = await f.run(
      readSkill(fileRef(owner, "references/0.md", snapshotId, fileId), { offline: true }).pipe(
        Effect.result,
      ),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure")
      expect(["STATE_CORRUPT", "SHARED_FILE_BINDING_UNAVAILABLE"]).toContain(result.failure.code)
  }
  expect(canonicalSharedJson(f.json.get("snapshots/" + snapshotId + ".json"))).toBe(original)
  expect(f.calls).toHaveLength(0)
})
