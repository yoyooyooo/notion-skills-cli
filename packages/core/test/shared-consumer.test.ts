import { expect, test } from "bun:test"
import { Effect } from "effect"
import { consume } from "../src/consumer.ts"
import { exportSkill } from "../src/export.ts"
import { readImportZip } from "../src/import.ts"
import { fail, property } from "../src/model.ts"
import { readPortable } from "../src/portable.ts"
import { fileRef } from "../src/ref.ts"
import { readSkill } from "../src/snapshot.ts"
import { readResources } from "../src/resource-read.ts"
import { Store } from "../src/store.ts"
import {
  currentBytes as bytes,
  currentId,
  currentLibrary,
  currentRich as rich,
  currentSkillPage,
} from "./shared-current-fixture.ts"
import {
  currentSourceConsumerFixture,
  type SourceFile,
} from "./shared-current-source-consumer-fixture.ts"

const gitFiles: readonly SourceFile[] = [
  {
    path: "SKILL.md",
    bytes: bytes(
      "---\r\nname: Source name\r\ndescription: Source description\r\nlicense: MIT\r\n---\r\n\r\n# Exact Git main\r\n",
    ),
    mode: "100644",
  },
  { path: "scripts/check.sh", bytes: bytes("#!/bin/sh\r\nexit 91\r\n"), mode: "100755" },
  { path: "assets/icon.bin", bytes: new Uint8Array([0, 255, 10, 13, 0, 128]), mode: "100644" },
]

test("Git-only current Files preserve every exact byte and mode without reading their projections", async () => {
  const f = await currentSourceConsumerFixture()
  await f.select(gitFiles, "git")
  for (const file of gitFiles) f.bind(file.path)
  f.clearCalls()
  const snapshot = await f.target()
  expect(snapshot.files.map((file) => file.path)).toEqual(gitFiles.map((file) => file.path).sort())
  for (const file of gitFiles) {
    expect(f.bytes(snapshot, file.path)).toEqual(file.bytes)
    expect(snapshot.files.find((actual) => actual.path === file.path)?.mode).toBe(file.mode)
  }
  expect(f.requests).toHaveLength(3)
  expect(f.requests.every((url) => url.includes(`/example/skills/${"a".repeat(40)}/`))).toBe(true)
  expect(f.bodyCalls()).toHaveLength(0)
  expect(f.semanticWrites()).toHaveLength(0)
  expect(f.records.size).toBe(0)
  f.clearCalls()
  f.requests.length = 0
  const refreshed = await f.target({ refresh: true })
  expect(refreshed.snapshot_id).toBe(snapshot.snapshot_id)
  expect(f.requests).toEqual([])
  expect(f.bodyCalls()).toHaveLength(0)
  expect(f.semanticWrites()).toHaveLength(0)
})

test.each(["read", "export", "use"] as const)(
  "a rebuilt Git-only Skill refreshes through public %s with its existing cache",
  async (action) => {
    const f = await currentSourceConsumerFixture()
    await f.select(gitFiles, "git")
    for (const file of gitFiles) f.bind(file.path)
    const first = await f.target()
    const retained = structuredClone(f.json.get(`snapshots/${first.snapshot_id}.json`))
    const nativeKey = [...f.json.keys()].find((key) =>
      key.startsWith("cache/current-native-bodies/"),
    )!
    expect(f.json.get(nativeKey)).toMatchObject({ skill_page_id: currentSkillPage, files: [] })
    const rebuilt = currentId(900)
    f.main.id = rebuilt
    for (const file of f.files) file.properties.Skill.relation = [{ id: rebuilt }]
    const options = { database: currentLibrary.skills.database_id, refresh: true }
    f.clearCalls()
    f.requests.length = 0
    let currentSnapshotId: string
    if (action === "read") {
      const selected = await f.run(readSkill(rebuilt, options))
      currentSnapshotId = selected.snapshot_id
      expect("content" in selected && selected.content).toBe(
        new TextDecoder().decode(gitFiles[0]!.bytes),
      )
    } else if (action === "export") {
      const store = await f.run(Store)
      let archive: Uint8Array | undefined
      const selected = await f.run(
        exportSkill(rebuilt, { ...options, output: "/recreated-skill.zip", format: "zip" }).pipe(
          Effect.provideService(Store, {
            ...store,
            output: (output, value) =>
              Effect.sync(() => {
                archive = value
                return { output, reused: false }
              }),
          }),
        ),
      )
      currentSnapshotId = selected.snapshot_id
      if (archive === undefined) throw new Error("Missing exported archive.")
      const exported = readPortable(readImportZip(archive))!
      for (const file of gitFiles)
        expect(exported.files.find((item) => item.path === file.path)?.bytes).toEqual(file.bytes)
    } else {
      const selected = await f.run(
        consume(
          { version: 1, targets: [rebuilt], purpose: "use", freshness: { policy: "refresh" } },
          options,
        ),
      )
      expect(selected.status).toBe("ready")
      if (selected.status !== "ready") throw new Error(JSON.stringify(selected))
      currentSnapshotId = selected.entries[0]!.manifest.snapshot_id
    }
    expect(currentSnapshotId).not.toBe(first.snapshot_id)
    expect(f.json.get(nativeKey)).toMatchObject({ skill_page_id: rebuilt, files: [] })
    expect(f.json.get(`snapshots/${first.snapshot_id}.json`)).toEqual(retained)
    expect(f.requests).toEqual([])
    expect(f.bodyCalls()).toHaveLength(0)
    expect(f.semanticWrites()).toHaveLength(0)
    f.clearCalls()
    const warm = await f.run(readSkill(rebuilt, { database: options.database }))
    expect(warm.snapshot_id).toBe(currentSnapshotId)
    expect(warm.version_id).not.toBe(first.version_id)
    expect(warm.source).toBe("local_cache")
    const stable = await f.run(readSkill(first.record.id, { database: options.database }))
    expect(stable.snapshot_id).toBe(currentSnapshotId)
    expect(stable.source).toBe("local_cache")
    const pinned = await f.run(
      readSkill(fileRef(first.record.id, "SKILL.md", first.snapshot_id, "main-demo"), {
        offline: true,
      }),
    )
    expect("content" in pinned && pinned.content).toBe(new TextDecoder().decode(gitFiles[0]!.bytes))
    expect(f.calls).toHaveLength(0)
    if (action === "read") {
      const missing = first.files.find((file) => file.path === "scripts/check.sh")!
      const fileId = first.file_bindings!.find((file) => file.path === missing.path)!.file_id
      f.objects.delete(`objects/${missing.sha256}`)
      const acquired = await f.run(
        readSkill(fileRef(warm.record.id, missing.path, warm.snapshot_id, fileId), {
          database: options.database,
        }),
      )
      expect(acquired.record.locator).toEqual(warm.record.locator)
      expect("content" in acquired && acquired.content).toBe(
        new TextDecoder().decode(gitFiles[1]!.bytes),
      )
      expect(f.calls.some((call) => call.path === `v1/pages/${currentSkillPage}`)).toBe(false)
      expect(f.requests).toHaveLength(1)
      expect(f.bodyCalls()).toHaveLength(0)
      expect(f.semanticWrites()).toHaveLength(0)
      f.objects.delete(`objects/${missing.sha256}`)
      f.clearCalls()
      const batch = await f.run(
        readResources(
          {
            version: 1,
            refs: [fileRef(warm.record.id, missing.path, warm.snapshot_id, fileId)],
          },
          { database: options.database },
        ),
      )
      expect(batch.status).toBe("ready")
      if (batch.status !== "ready") throw new Error(JSON.stringify(batch))
      expect(batch.manifest.record.locator).toEqual(warm.record.locator)
      expect(batch.files[0]?.content).toBe(new TextDecoder().decode(gitFiles[1]!.bytes))
      expect(f.calls.some((call) => call.path === `v1/pages/${currentSkillPage}`)).toBe(false)
      const oldRef = fileRef(first.record.id, missing.path, first.snapshot_id, fileId)
      f.clearCalls()
      const old = await f.run(readSkill(oldRef, { offline: true }))
      expect(old.record.locator).toEqual(first.record.locator)
      expect(f.calls).toHaveLength(0)
      f.objects.delete(`objects/${missing.sha256}`)
      f.failRequests((call) =>
        call.path === `v1/pages/${currentSkillPage}`
          ? fail("NOT_FOUND", "The former physical owner is gone.")
          : undefined,
      )
      await expect(f.run(readSkill(oldRef))).rejects.toMatchObject({ code: "NOT_FOUND" })
      expect(f.calls.some((call) => call.path === `v1/pages/${rebuilt}`)).toBe(false)
    }
  },
)

test("missing or unready current Source metadata fails before bodies, providers or snapshot publication", async () => {
  for (const fault of ["missing", "pending", "revision", "content"] as const) {
    const f = await currentSourceConsumerFixture()
    await f.select(gitFiles, "git")
    f.bind("SKILL.md")
    if (fault === "missing") f.visible(false)
    const fields = property(f.source.properties)
    if (fault === "pending") {
      property(property(fields.Status).select).name = "attention"
      fields.Operation = rich(String(property(fields.Operation).id), "source-operation")
    }
    if (fault === "revision")
      fields["Last Revision"] = rich(String(property(fields["Last Revision"]).id), "f".repeat(64))
    if (fault === "content") delete fields.Content
    f.clearCalls()
    await expect(f.target()).rejects.toMatchObject({
      code: (
        {
          missing: "SHARED_SOURCE_MISSING",
          pending: "CURRENT_SOURCE_NOT_READY",
          revision: "SHARED_SOURCE_CONFLICT",
          content: "CURRENT_SOURCE_INVALID",
        } as const
      )[fault],
    })
    expect(f.requests).toEqual([])
    expect(f.bodyCalls()).toHaveLength(0)
    expect(f.semanticWrites()).toHaveLength(0)
    expect([...f.json.keys()].some((key) => key.startsWith("snapshots/"))).toBe(false)
  }
})

test("each current File must match the Source hash, size and executable mode before provider acquisition", async () => {
  for (const field of ["sha256", "bytes", "mode"] as const) {
    const f = await currentSourceConsumerFixture()
    await f.select(gitFiles)
    f.bind("scripts/check.sh")
    const row = f.files[0]!
    const descriptor = JSON.parse(row.properties.Content.rich_text[0]!.plain_text)
    descriptor[field] = field === "sha256" ? "f".repeat(64) : field === "bytes" ? 0 : "100644"
    row.properties.Content = rich("content", JSON.stringify(descriptor))
    f.clearCalls()
    await expect(f.target()).rejects.toMatchObject({ code: "CURRENT_SOURCE_CONFLICT" })
    expect(f.requests).toEqual([])
    expect(f.bodyCalls()).toHaveLength(0)
    expect(f.semanticWrites()).toHaveLength(0)
    expect([...f.json.keys()].some((key) => key.startsWith("snapshots/"))).toBe(false)
  }
})

test("editing a source projection never replaces its exact current author bytes", async () => {
  const f = await currentSourceConsumerFixture()
  await f.select(gitFiles)
  for (const file of gitFiles) f.bind(file.path)
  const first = await f.target()
  for (const page of [currentSkillPage, ...f.files.map((file) => file.id)])
    f.bodies.set(page, "# Edited reading projection\nDo not adopt this text.\n")
  f.main.last_edited_time = new Date().toISOString()
  f.clearCalls()
  f.requests.length = 0
  const current = await f.target({ refresh: true })
  expect(current.snapshot_id).toBe(first.snapshot_id)
  for (const file of gitFiles) expect(f.bytes(current, file.path)).toEqual(file.bytes)
  expect(f.requests).toEqual([])
  expect(f.bodyCalls()).toHaveLength(0)
  expect(f.semanticWrites()).toHaveLength(0)
  expect([...f.json.keys()].filter((key) => key.startsWith("operations/"))).toEqual([])
})

test("a Source advance requires explicit current File reselection while a native takeover remains independent", async () => {
  const f = await currentSourceConsumerFixture()
  await f.select(gitFiles, "git")
  f.bind("SKILL.md")
  f.bind("scripts/check.sh")
  const first = await f.target()
  const original = f.bytes(first, "SKILL.md")
  const next: readonly SourceFile[] = gitFiles.map((file) =>
    file.path === "scripts/check.sh" ? { ...file, bytes: bytes("#!/bin/sh\nexit 92\n") } : file,
  )
  await f.select(next, "git", "c".repeat(40))
  f.clearCalls()
  f.requests.length = 0
  await expect(f.target({ refresh: true })).rejects.toMatchObject({
    code: "SHARED_SOURCE_CONFLICT",
  })
  expect(f.requests).toEqual([])
  expect(f.bodyCalls()).toHaveLength(0)
  expect(f.semanticWrites()).toHaveLength(0)
  f.clearCalls()
  const selected = await f.run(
    readSkill(fileRef(first.record.id, "SKILL.md", first.snapshot_id), { offline: true }),
  )
  expect("content" in selected && bytes(selected.content)).toEqual(new Uint8Array(original))
  expect(f.calls).toHaveLength(0)
  f.native(
    "SKILL.md",
    "# Explicit Notion author\n",
    "---\nname: Local author\nlicense: MIT\n---\n\n",
  )
  f.bind("scripts/check.sh")
  f.objects.clear()
  const current = await f.target({ refresh: true })
  expect(new TextDecoder().decode(f.bytes(current, "SKILL.md"))).toBe(
    "---\nname: Local author\nlicense: MIT\n---\n\n# Explicit Notion author\n",
  )
  expect(f.bytes(current, "scripts/check.sh")).toEqual(next[1]!.bytes)
  expect(current.files.map((file) => file.path)).toEqual(["SKILL.md", "scripts/check.sh"])
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]).toEndWith("/scripts/check.sh")
  expect(f.semanticWrites()).toHaveLength(0)
})
