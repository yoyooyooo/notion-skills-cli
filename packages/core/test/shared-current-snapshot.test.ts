import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { cachedRemoteObservation } from "../src/cache.ts"
import { snapshotPortable } from "../src/export.ts"
import { openFixedSnapshotFiles } from "../src/fixed-snapshot-files.ts"
import { readImportZip } from "../src/import.ts"
import { portableZip, readPortable } from "../src/portable.ts"
import { fail, property } from "../src/model.ts"
import { openSharedSnapshot, SHARED_FULL_BODY_MAX_AGE_MS } from "../src/shared-snapshot.ts"
import {
  currentBytes,
  currentDigest,
  currentLibrary,
  currentRich,
  currentScope,
  currentSkillPage,
  currentSnapshotFixture,
} from "./shared-current-fixture.ts"

describe("current tree consumption", () => {
  test("cold native consumption uses three metadata requests plus one read per body and writes no Notion state", async () => {
    const f = currentSnapshotFixture()
    f.records.set("unread-history", { malformed: "obsolete event, proof and snapshot records" })
    f.json.set("operations/shared-observation-pending/old/pending.json", { obsolete: true })
    const selected = await f.open()
    expect(selected.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "references/0.md",
      "references/1.md",
    ])
    expect(selected.file_bindings).toHaveLength(3)
    expect(selected.shared_acquisition).toMatchObject({ version: 5, files: [] })
    expect(f.calls).toHaveLength(6)
    expect(f.bodyCalls()).toHaveLength(3)
    expect(f.recordCalls()).toHaveLength(0)
    expect(f.semanticWrites()).toHaveLength(0)
    expect(new TextDecoder().decode(f.selectedBytes(selected, "SKILL.md"))).toContain(
      "name: authored-name",
    )
  })

  test("warm metadata observation reads no body and one direct edit fetches only that current body", async () => {
    const f = currentSnapshotFixture()
    const first = await f.open()
    f.clearCalls()
    const warm = await f.open()
    expect(warm.version_id).toBe(first.version_id)
    expect(f.calls).toHaveLength(3)
    expect(f.bodyCalls()).toHaveLength(0)
    const changed = f.files[0]!
    f.bodies.set(changed.id, "# Changed by a human\n\nRead this latest content directly.\n")
    changed.last_edited_time = "2026-11-18T00:01:00.000Z"
    f.clearCalls()
    const next = await f.open()
    expect(next.version_id).not.toBe(first.version_id)
    expect(f.bodyCalls()).toHaveLength(1)
    expect(f.bodyCalls()[0]?.path).toContain(changed.id)
    expect(new TextDecoder().decode(f.selectedBytes(next, "references/0.md"))).toContain(
      "Changed by a human",
    )
    expect(f.recordCalls()).toHaveLength(0)
    expect(f.semanticWrites()).toHaveLength(0)
  })

  test("missing native cache reads current content even with unchanged metadata, without historical recovery", async () => {
    const f = currentSnapshotFixture({ fileCount: 1 })
    const first = await f.open()
    const file = first.files.find((file) => file.path === "references/0.md")!
    f.objects.delete(`objects/${file.sha256}`)
    f.bodies.set(f.files[0]!.id, "# Current body after missing cache\n")
    f.clearCalls()
    const next = await f.open()
    expect(next.version_id).not.toBe(first.version_id)
    expect(f.bodyCalls()).toHaveLength(1)
    expect(f.recordCalls()).toHaveLength(0)
    expect(f.semanticWrites()).toHaveLength(0)
    expect(new TextDecoder().decode(f.selectedBytes(next, file.path))).toBe(
      "# Current body after missing cache\n",
    )
  })

  test("metadata renewals do not extend the independent full-body deadline", async () => {
    const f = currentSnapshotFixture({ fileCount: 0 })
    await f.open()
    const key = [...f.json.keys()].find((key) => key.startsWith("cache/current-native-bodies/"))!
    const observation = property(f.json.get(key))
    const files = observation.files
    if (!Array.isArray(files)) throw new Error("Missing current observation.")
    property(files[0]).body_verified_at = Date.now() - SHARED_FULL_BODY_MAX_AGE_MS - 1000
    f.clearCalls()
    await f.open()
    expect(f.bodyCalls()).toHaveLength(1)
    expect(f.semanticWrites()).toHaveLength(0)
  })

  test("display metadata changes return new metadata while retaining exact authored bytes and content identity", async () => {
    const f = currentSnapshotFixture({ fileCount: 0 })
    const first = await f.open()
    const original = new Uint8Array(f.selectedBytes(first, "SKILL.md"))
    f.main.properties.Name.title[0]!.plain_text = "Renamed display"
    f.main.properties.Description = currentRich("description", "Different directory summary.")
    f.main.last_edited_time = "2026-11-18T00:02:00.000Z"
    f.clearCalls()
    const next = await f.open()
    expect(next.record.name).toBe("Renamed display")
    expect(next.record.description).toBe("Different directory summary.")
    expect(next.version_id).toBe(first.version_id)
    expect(next.snapshot_id).toBe(first.snapshot_id)
    expect(f.selectedBytes(next, "SKILL.md")).toEqual(original)
    expect(property(property(f.json.get(`snapshots/${first.snapshot_id}.json`)).record).name).toBe(
      "Current demo",
    )
    f.clearCalls()
    const cached = await f.run(
      cachedRemoteObservation(next.record.id, currentScope, { access: "metadata" }),
    )
    expect(cached?.snapshot.record.name).toBe("Renamed display")
    expect(cached?.snapshot.record.description).toBe("Different directory summary.")
    expect(cached?.stored_snapshot?.record.name).toBe("Current demo")
    expect(f.calls).toHaveLength(0)
    expect(f.semanticWrites()).toHaveLength(0)
  })

  test("cached current metadata rejects a corrupted alias, entrypoint, owner or File binding without network access", async () => {
    for (const changed of ["alias", "entrypoint", "owner", "file_id", "missing_binding"]) {
      const f = currentSnapshotFixture({ fileCount: 0 })
      const selected = await f.open()
      const key = [...f.json.keys()].find((key) => key.startsWith("cache/latest/"))!
      const current = property(property(f.json.get(key)).current_snapshot)
      const record = property(current.record)
      if (changed === "alias") record.alias = "forged-alias"
      else if (changed === "entrypoint") current.entrypoint = "missing.md"
      else if (changed === "owner") property(record.locator).page_id = currentLibrary.parent_page_id
      else if (changed === "missing_binding") current.file_bindings = []
      else {
        if (!Array.isArray(current.file_bindings)) throw new Error("Missing fixture bindings.")
        property(current.file_bindings[0]).file_id = "forged-file-id"
      }
      f.clearCalls()
      await expect(
        f.run(cachedRemoteObservation(selected.record.id, currentScope, { access: "metadata" })),
      ).rejects.toMatchObject({ code: "STATE_CORRUPT" })
      expect(f.calls).toHaveLength(0)
    }
  })

  test("a failed lazy acquisition invalidates current eligibility and remembers access denial", async () => {
    for (const change of ["disabled", "removed", "pending", "denied"]) {
      const f = currentSnapshotFixture({ fileCount: 1 })
      await f.resource(0, "assets/current.bin", new Uint8Array([0, 255, 19]))
      const selected = await f.open({ requestedPaths: [] })
      if (change === "disabled") f.main.properties.Enabled.checkbox = false
      else if (change === "removed") f.files.splice(0)
      else if (change === "pending") {
        f.main.properties["Current State"].select.name = "applying"
        f.main.properties.Operation = currentRich("operation", "current-writer")
      } else
        f.failRequests((call) =>
          call.path.includes(currentLibrary.records.data_source_id)
            ? fail("ACCESS_DENIED", "Current resource access denied.")
            : undefined,
        )
      await expect(
        f.run(openFixedSnapshotFiles(selected, () => ["assets/current.bin"])),
      ).rejects.toMatchObject({
        code: {
          disabled: "SKILL_DISABLED",
          removed: "SHARED_ACQUISITION_CHANGED",
          pending: "CURRENT_OPERATION_PENDING",
          denied: "ACCESS_DENIED",
        }[change],
      })
      expect(
        await f.run(
          cachedRemoteObservation(selected.record.id, currentScope, { access: "metadata" }),
        ),
      ).toBeUndefined()
      f.clearCalls()
      if (change === "denied")
        await expect(
          f.run(openFixedSnapshotFiles(selected, () => [selected.entrypoint])),
        ).rejects.toMatchObject({ code: "ACCESS_DENIED" })
      const offline = await f.run(
        openFixedSnapshotFiles(selected, () => [selected.entrypoint], { offline: true }),
      )
      expect(offline.files[0]?.bytes).toEqual(f.selectedBytes(selected, selected.entrypoint))
      expect(f.calls).toHaveLength(0)
    }
  })

  test("current path edits and row removal supersede disposable observations without retained tombstones", async () => {
    const f = currentSnapshotFixture()
    const first = await f.open()
    const firstFileId = first.file_bindings?.find(
      (file) => file.path === "references/0.md",
    )?.file_id
    f.files[0]!.properties.Path = currentRich("path", "references/renamed.md")
    const moved = await f.open()
    expect(moved.file_bindings?.find((file) => file.file_id === firstFileId)?.path).toBe(
      "references/renamed.md",
    )
    expect(moved.files.some((file) => file.path === "references/0.md")).toBe(false)
    f.files.splice(0, 1)
    f.clearCalls()
    const removed = await f.open()
    expect(removed.files.map((file) => file.path)).toEqual(["SKILL.md", "references/1.md"])
    expect(removed.file_bindings?.some((file) => file.file_id === firstFileId)).toBe(false)
    expect(f.bodyCalls()).toHaveLength(0)
    expect(f.recordCalls()).toHaveLength(0)
    expect(f.semanticWrites()).toHaveLength(0)
  })

  test("same-owner native links follow the current File binding without rewriting remote bodies", async () => {
    const f = currentSnapshotFixture({ fileCount: 1 })
    const supporting = f.files[0]!
    f.bodies.set(
      currentSkillPage,
      `[Read supporting text](https://app.notion.com/p/${supporting.id.replaceAll("-", "")})\n`,
    )
    const first = await f.open()
    expect(new TextDecoder().decode(f.selectedBytes(first, "SKILL.md"))).toContain(
      "(references/0.md)",
    )
    supporting.properties.Path = currentRich("path", "guide.md")
    f.clearCalls()
    const moved = await f.open()
    expect(new TextDecoder().decode(f.selectedBytes(moved, "SKILL.md"))).toContain("(guide.md)")
    expect(f.bodyCalls().some((call) => call.path.includes(currentSkillPage))).toBe(false)
    expect(f.semanticWrites()).toHaveLength(0)
  })

  test("a non-ready Skill and an old Content row stop before body reads and never reconcile implicitly", async () => {
    for (const state of ["applying", "attention"]) {
      const f = currentSnapshotFixture()
      f.main.properties["Current State"].select.name = state
      f.main.properties.Operation = currentRich("operation", "current-operation")
      const error = await f.run(
        Effect.flip(
          openSharedSnapshot({
            library: currentLibrary,
            target: currentSkillPage,
            scope: currentScope,
            startedAt: Date.now(),
          }),
        ),
      )
      expect(error.code).toBe("CURRENT_OPERATION_PENDING")
      expect(error.details).toMatchObject({
        operation_id: "current-operation",
        next: "reconcile_current",
      })
      expect(f.bodyCalls()).toHaveLength(0)
      expect(f.recordCalls()).toHaveLength(0)
      expect(f.semanticWrites()).toHaveLength(0)
    }
    const f = currentSnapshotFixture()
    f.files[0]!.properties.Content = currentRich("content", "")
    await expect(f.open()).rejects.toThrow("migration")
    expect(f.bodyCalls()).toHaveLength(0)
    expect(f.semanticWrites()).toHaveLength(0)
  })

  test("a writer starting or completing during body reads prevents publication of a mixed selection", async () => {
    for (const state of ["applying", "ready"]) {
      const f = currentSnapshotFixture()
      f.alterResponses((call, response) => {
        if (call.path.includes("/markdown")) {
          f.main.last_edited_time = "2026-11-18T00:03:00.000Z"
          f.main.properties["Current State"].select.name = state
          if (state === "applying")
            f.main.properties.Operation = currentRich("operation", "concurrent-writer")
        }
        return response
      })
      await expect(f.open()).rejects.toMatchObject({
        code: state === "applying" ? "CURRENT_OPERATION_PENDING" : "CURRENT_TREE_CHANGED",
      })
      expect([...f.json.keys()].filter((key) => key.startsWith("snapshots/"))).toHaveLength(0)
      expect([...f.json.keys()].filter((key) => key.startsWith("cache/latest/"))).toHaveLength(0)
      expect(f.semanticWrites()).toHaveLength(0)
    }
  })

  test("partial Files pagination, access failure and truncated native text cannot publish a complete selection", async () => {
    for (const kind of ["pagination", "permission", "truncation"]) {
      const f = currentSnapshotFixture()
      if (kind === "permission")
        f.failRequests((call) =>
          call.path.includes(`/pages/${f.files[0]!.id}/markdown`)
            ? fail("NOTION_FORBIDDEN", "Permission denied.")
            : undefined,
        )
      else
        f.alterResponses((call, response) => {
          if (kind === "pagination" && call.path.includes(currentLibrary.files.data_source_id))
            return { ...property(response), request_status: { type: "incomplete" } }
          if (kind === "truncation" && call.path.includes("/markdown"))
            return { ...property(response), truncated: true }
          return response
        })
      await expect(f.open()).rejects.toThrow()
      expect([...f.json.keys()].filter((key) => key.startsWith("snapshots/"))).toHaveLength(0)
      expect(f.semanticWrites()).toHaveLength(0)
    }
  })

  test("requested resources preserve complete bindings and exact bytes while ignoring generated page edits", async () => {
    const f = currentSnapshotFixture()
    const selectedBytes = currentBytes("\uFEFF#!/bin/sh\r\nprintf 'current\\n'\r\n")
    const content = await f.resource(0, "scripts/run.sh", selectedBytes, "100755")
    await f.resource(1, "assets/other.bin", new Uint8Array([0, 255, 19]))
    f.bodies.set(f.files[0]!.id, "Human edit to generated display must not acquire authority.")
    const entry = await f.open({ requestedPaths: [] })
    expect(entry.files).toHaveLength(3)
    expect(entry.file_bindings).toHaveLength(3)
    expect(entry.materialization?.materialized_paths).toEqual(["SKILL.md"])
    expect(f.recordCalls()).toHaveLength(0)
    expect(f.bodyCalls()).toHaveLength(1)
    f.clearCalls()
    const selected = await f.open({ requestedPaths: ["scripts/run.sh"] })
    expect(selected.version_id).toBe(entry.version_id)
    expect(selected.files.find((file) => file.path === "scripts/run.sh")).toMatchObject({
      sha256: currentDigest(selectedBytes),
      bytes: selectedBytes.length,
      mode: "100755",
    })
    expect(f.selectedBytes(selected, "scripts/run.sh")).toEqual(selectedBytes)
    expect(f.recordCalls()).toHaveLength(1)
    expect(JSON.stringify(f.recordCalls()[0]?.body)).toContain(content.object_id)
    expect(f.bodyCalls()).toHaveLength(0)
    expect(selected.materialization?.materialized_paths).toEqual(["SKILL.md", "scripts/run.sh"])
    expect(f.semanticWrites()).toHaveLength(0)
    const complete = await f.open()
    f.clearCalls()
    const portable = await f.run(snapshotPortable(complete))
    const exported = readPortable(readImportZip(portableZip(portable)))!
    expect(exported.files.find((file) => file.path === "scripts/run.sh")).toMatchObject({
      bytes: selectedBytes,
      mode: "100755",
    })
    expect(exported.files.find((file) => file.path === "assets/other.bin")?.bytes).toEqual(
      new Uint8Array([0, 255, 19]),
    )
    expect(exported.files.find((file) => file.path === complete.entrypoint)?.bytes).toEqual(
      f.selectedBytes(complete, complete.entrypoint),
    )
    expect(f.calls).toHaveLength(0)
  })

  test("a directory selection checks its main against deferred Markdown paths without downloading those bodies", async () => {
    const f = currentSnapshotFixture()
    f.bodies.set(currentSkillPage, "# Main\n\nRead [guide](references/guide.md).\n")
    const guide = currentBytes("# Guide\r\n\r\nRead [other](other.md).\r\n")
    const other = currentBytes("# Other\n")
    await f.resource(0, "references/guide.md", guide)
    await f.resource(1, "references/other.md", other)
    const selected = await f.open({ requestedPaths: [] })
    expect(selected.materialization?.materialized_paths).toEqual(["SKILL.md"])
    expect(f.recordCalls()).toHaveLength(0)
    expect(f.objects.has(`objects/${currentDigest(guide)}`)).toBe(false)
    expect(f.objects.has(`objects/${currentDigest(other)}`)).toBe(false)
    f.clearCalls()
    expect(
      await f.run(
        cachedRemoteObservation(selected.record.id, currentScope, { access: "metadata" }),
      ),
    ).toBeDefined()
    expect(f.calls).toHaveLength(0)
    const acquired = await f.run(openFixedSnapshotFiles(selected, () => ["references/guide.md"]))
    expect(acquired.files).toEqual([{ path: "references/guide.md", bytes: guide }])
    expect(f.recordCalls()).toHaveLength(1)
    expect(f.objects.has(`objects/${currentDigest(other)}`)).toBe(false)
    expect(f.semanticWrites()).toHaveLength(0)
  })

  test("reference validation still rejects absent targets in either the selected main or a lazily acquired child", async () => {
    for (const invalid of ["main", "child"]) {
      const f = currentSnapshotFixture({ fileCount: 1 })
      f.bodies.set(
        currentSkillPage,
        invalid === "main" ? "[Missing](absent.md)\n" : "[Guide](references/guide.md)\n",
      )
      await f.resource(0, "references/guide.md", currentBytes("[Missing](absent.md)\n"))
      if (invalid === "main")
        await expect(f.open({ requestedPaths: [] })).rejects.toMatchObject({
          code: "SHARED_REFERENCE_BROKEN",
        })
      else {
        const selected = await f.open({ requestedPaths: [] })
        expect(f.recordCalls()).toHaveLength(0)
        await expect(
          f.run(openFixedSnapshotFiles(selected, () => ["references/guide.md"])),
        ).rejects.toMatchObject({ code: "SHARED_REFERENCE_BROKEN" })
      }
      expect(f.semanticWrites()).toHaveLength(0)
    }
  })
})
