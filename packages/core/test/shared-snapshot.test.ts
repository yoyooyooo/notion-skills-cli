import { describe, expect, test } from "bun:test"
import { property, text } from "../src/model.ts"
import { SHARED_FULL_BODY_MAX_AGE_MS, type FixedSharedSource } from "../src/shared-snapshot.ts"
import {
  sharedSnapshotFixture as fixture,
  skillPage,
  id,
  rich,
  digest,
  encode,
} from "./shared-snapshot-fixture.ts"

describe("shared snapshot consumer", () => {
  test("cold native consumption retains ownership and publishes complete standard files", async () => {
    const f = fixture()
    const snapshot = await f.open()
    expect(snapshot.record.id).toBe("shared_skill:library-snapshot:stable-skill")
    expect(snapshot.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "references/1.md",
      "references/2.md",
    ])
    const main = snapshot.files.find((file) => file.path === "SKILL.md")
    if (!main) throw new Error("Missing main")
    const body = new TextDecoder().decode(f.objects.get(`objects/${main.sha256}`))
    expect(body).toContain('"name": "Managed Name"')
    expect(body).toContain('"description": "Managed description"')
    expect(body).toContain("# Native main")
    expect(f.readBodyCount()).toBe(3)
    expect(f.writeCount()).toBe(9)
    expect(
      [...f.json.keys()].some((key) => key.startsWith("operations/shared-observation-pending/")),
    ).toBe(false)
    expect([...f.json.keys()].filter((key) => key.startsWith("snapshots/"))).toHaveLength(1)
  })

  test("unchanged batched revalidation reads no bodies and performs no remote writes", async () => {
    const f = fixture()
    const first = await f.open()
    f.clearCalls()
    const next = await f.open()
    expect(next.snapshot_id).toBe(first.snapshot_id)
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
    expect(f.calls).toHaveLength(4)
    expect(next.freshness?.validation).toBe("metadata")
  })

  test("a single changed file does not invalidate the other files' body observations", async () => {
    const f = fixture()
    const first = await f.open()
    const row = f.files[0]
    if (!row) throw new Error("Missing reference")
    row.last_edited_time = new Date(Date.now() - 1).toISOString()
    f.bodies.set(row.id, "Edited reference one\n")
    f.clearCalls()
    const changed = await f.open()
    expect(f.readBodyCount()).toBe(1)
    expect(f.writeCount()).toBe(3)
    expect(changed.snapshot_id).not.toBe(first.snapshot_id)
    expect(changed.files.find((file) => file.path === "references/2.md")?.sha256).toBe(
      first.files.find((file) => file.path === "references/2.md")?.sha256,
    )
    f.clearCalls()
    await f.open()
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
  })

  test("Notion metadata updates regenerate the main file without transferring body ownership", async () => {
    const f = fixture()
    await f.open()
    const count = f.records.size
    property(f.main.properties).description = rich("description", "Updated management description")
    f.main.last_edited_time = new Date(Date.now() - 1).toISOString()
    f.clearCalls()
    const next = await f.open()
    expect(next.record.description).toBe("Updated management description")
    expect(f.readBodyCount()).toBe(1)
    expect(f.writeCount()).toBe(0)
    expect(f.records.size).toBe(count)
  })

  test("losing derived caches preserves shared ownership and does not write replacement facts", async () => {
    const f = fixture()
    const first = await f.open()
    f.json.clear()
    f.objects.clear()
    f.clearCalls()
    const rebuilt = await f.open()
    expect(rebuilt.snapshot_id).toBe(first.snapshot_id)
    expect(f.readBodyCount()).toBe(3)
    expect(f.writeCount()).toBe(0)
  })

  test("a missing custom body object is recovered from retained exact bytes without reading current content", async () => {
    const f = fixture()
    const first = await f.open()
    const reference = first.files.find((file) => file.path === "references/1.md")
    if (!reference) throw new Error("Missing reference")
    f.objects.delete(`objects/${reference.sha256}`)
    f.clearCalls()
    const recovered = await f.open()
    expect(recovered.snapshot_id).toBe(first.snapshot_id)
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
    expect(digest(f.objects.get(`objects/${reference.sha256}`) ?? new Uint8Array())).toBe(
      reference.sha256,
    )
  })

  test("missing retained history fails explicitly instead of substituting current body", async () => {
    const f = fixture()
    const first = await f.open()
    const reference = first.files.find((file) => file.path === "references/1.md")
    if (!reference) throw new Error("Missing reference")
    f.objects.delete(`objects/${reference.sha256}`)
    for (const [page, row] of f.records)
      if (text(property(property(row.properties).record).rich_text) === `body-${reference.sha256}`)
        f.records.delete(page)
    f.clearCalls()
    await expect(f.open()).rejects.toThrow("exact retained body")
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
  })

  test("body-only reconciliation reaches its independent deadline when timestamps stay unchanged", async () => {
    const f = fixture()
    const first = await f.open()
    for (const [key, value] of f.json) {
      if (!key.startsWith("cache/shared-file-observations/")) continue
      const entry = property(value)
      if (!Array.isArray(entry.observations)) throw new Error("Missing cache observations")
      entry.observations = entry.observations.map((item) => ({
        ...property(item),
        body_verified_at: Date.now() - SHARED_FULL_BODY_MAX_AGE_MS - 1,
      }))
    }
    f.bodies.set(skillPage, "Changed under the same timestamp\n")
    f.clearCalls()
    const next = await f.open()
    expect(f.readBodyCount()).toBe(3)
    expect(f.writeCount()).toBe(3)
    expect(next.snapshot_id).not.toBe(first.snapshot_id)
  })

  test("source selection or a missing projected fact never falls through to native adoption", async () => {
    const sourced = fixture()
    property(sourced.main.properties).source = rich("source", "selected-source")
    await expect(sourced.open()).rejects.toThrow("exact source selected")
    expect(sourced.readBodyCount()).toBe(0)
    expect(sourced.writeCount()).toBe(0)
    const projected = fixture()
    property(projected.main.properties).projection = rich(
      "projection",
      JSON.stringify({
        normalization_version: 1,
        sha256: digest("old body"),
        source_revision: "commit-old",
      }),
    )
    await expect(projected.open()).rejects.toThrow("projected state is absent")
    expect(projected.readBodyCount()).toBe(0)
    expect(projected.writeCount()).toBe(0)
  })

  test("fixed source follows exact bytes while scripts and binary resources are only materialized", async () => {
    const f = fixture()
    property(f.main.properties).source = rich("source", "selected-source")
    const bindings = [
      { file_id: "file-main", page: skillPage, path: "SKILL.md" },
      ...[1, 2].map((n) => ({
        file_id: `file-${n}`,
        page: id(10 + n),
        path: `references/${n}.md`,
      })),
    ]
    for (const binding of bindings)
      f.seedFact(
        {
          event_id: `project-${binding.file_id}`,
          file_id: binding.file_id,
          parents: [],
          kind: "projected",
          source_revision: "selected-commit",
          projection: {
            normalization_version: 1,
            sha256: digest(f.bodies.get(binding.page) ?? ""),
          },
        },
        "file_event",
        binding.file_id,
        `project-${binding.file_id}`,
      )
    const fixedSource: FixedSharedSource = {
      source_id: "selected-source",
      revision: "selected-commit",
      files: [
        {
          path: "SKILL.md",
          bytes: encode(
            "---\nname: Upstream Name\ndescription: Old metadata\n---\n\n# Source main\n",
          ),
        },
        { path: "references/1.md", bytes: encode("Source reference one\n") },
        { path: "references/2.md", bytes: encode("Source reference two\n") },
        { path: "scripts/example.sh", bytes: encode("exit 91\n") },
        { path: "assets/icon.bin", bytes: new Uint8Array([0, 1, 128, 255]) },
        { path: "assets/large.bin", bytes: new Uint8Array(70 * 1024) },
      ],
    }
    const snapshot = await f.open({ fixedSource })
    expect(snapshot.files).toHaveLength(6)
    expect(f.writeCount()).toBe(0)
    const main = snapshot.files.find((file) => file.path === "SKILL.md")
    if (!main) throw new Error("Missing main")
    const content = new TextDecoder().decode(f.objects.get(`objects/${main.sha256}`))
    expect(content).toContain('"name": "Managed Name"')
    expect(content).toContain("# Source main")
    expect(content).not.toContain("Upstream Name")
    const binary = snapshot.files.find((file) => file.path === "assets/icon.bin")
    expect(binary?.sha256).toBe(digest(new Uint8Array([0, 1, 128, 255])))
  })

  test("selecting a source with one changed blob does not reobserve unchanged following or custom files", async () => {
    const f = fixture()
    property(f.main.properties).source = rich("source", "source-a")
    const bindings = [
      { file_id: "file-main", page: skillPage },
      ...[1, 2].map((n) => ({ file_id: `file-${n}`, page: id(10 + n) })),
    ]
    for (const binding of bindings)
      f.seedFact(
        {
          event_id: `project-${binding.file_id}`,
          file_id: binding.file_id,
          parents: [],
          kind: "projected",
          source_revision: "commit-a",
          projection: {
            normalization_version: 1,
            sha256: digest(f.bodies.get(binding.page) ?? ""),
          },
        },
        "file_event",
        binding.file_id,
        `project-${binding.file_id}`,
      )
    const sourceA: FixedSharedSource = {
      source_id: "source-a",
      revision: "commit-a",
      files: [
        { path: "SKILL.md", bytes: encode("# Source main A\n") },
        { path: "references/1.md", bytes: encode("Unchanged following reference\n") },
        { path: "references/2.md", bytes: encode("Upstream reference later customized\n") },
      ],
    }
    await f.open({ fixedSource: sourceA })
    const customRow = f.files[1]
    if (customRow === undefined) throw new Error("Missing custom fixture binding")
    customRow.last_edited_time = new Date(Date.parse(customRow.last_edited_time) + 1).toISOString()
    f.bodies.set(customRow.id, "Locally authored custom reference\n")
    const custom = await f.open({ fixedSource: sourceA })

    const sourceB: FixedSharedSource = {
      source_id: "source-b",
      revision: "commit-b",
      files: sourceA.files.map((file) =>
        file.path === "SKILL.md" ? { ...file, bytes: encode("# Source main B\n") } : file,
      ),
    }
    property(f.main.properties).source = rich("source", "source-b")
    f.main.last_edited_time = new Date(
      Date.parse(String(f.main.last_edited_time)) + 1,
    ).toISOString()
    f.clearCalls()
    const changed = await f.open({ fixedSource: sourceB })
    expect(
      f.calls.filter((call) => call.path.includes("/markdown")).map((call) => call.path),
    ).toEqual([`v1/pages/${skillPage}/markdown?markdown_version=v2`])
    expect(f.requestMetrics().body_requests).toEqual({
      current_body: 1,
      retained_body: 0,
      unclassified_body: 0,
    })
    expect(f.writeCount()).toBe(0)
    expect(changed.snapshot_id).not.toBe(custom.snapshot_id)
    expect(changed.files.find((file) => file.path === "references/1.md")?.sha256).toBe(
      custom.files.find((file) => file.path === "references/1.md")?.sha256,
    )
    expect(changed.files.find((file) => file.path === "references/2.md")?.sha256).toBe(
      digest("Locally authored custom reference\n"),
    )
    const main = changed.files.find((file) => file.path === "SKILL.md")
    if (main === undefined) throw new Error("Missing changed main file")
    expect(new TextDecoder().decode(f.objects.get(`objects/${main.sha256}`))).toContain(
      "# Source main B",
    )
    f.clearCalls()
    await f.open({ fixedSource: sourceB })
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
  })

  test("unknown ownership writes publish no snapshot and retry discovers the existing fact", async () => {
    const f = fixture()
    f.unknownEvent()
    await expect(f.open()).rejects.toThrow()
    expect(
      [...f.json.keys()].some(
        (key) => key.startsWith("snapshots/") || key.startsWith("cache/latest/"),
      ),
    ).toBe(false)
    const writes = f.writeCount()
    const snapshot = await f.open()
    expect(snapshot.files).toHaveLength(3)
    expect(f.writeCount() - writes).toBe(6)
    expect(
      [...f.json.keys()].some((key) => key.startsWith("operations/shared-observation-pending/")),
    ).toBe(false)
  })

  for (const stage of ["operation", "object", "file_event"] as const) {
    test(`an unknown ${stage} write preserves original intent and cannot adopt a later body`, async () => {
      const f = fixture()
      f.unknownRecord(stage, false)
      await expect(f.open()).rejects.toThrow()
      const pending = [...f.json.entries()].filter(([key]) =>
        key.startsWith("operations/shared-observation-pending/"),
      )
      expect(pending).toHaveLength(1)
      const frozen = structuredClone(pending[0]?.[1])
      expect(property(property(frozen).plan).file_id).toBe("file-main")
      expect(property(property(property(frozen).plan).body).markdown).toBe("# Native main\n")
      f.bodies.set(skillPage, "Later edit after the unknown response\n")
      f.main.last_edited_time = new Date(Date.now() - 1).toISOString()
      // Ordinary cache loss must not remove the independent replay barrier.
      for (const key of f.json.keys()) if (key.startsWith("cache/")) f.json.delete(key)
      f.clearCalls()
      await expect(f.open()).rejects.toThrow()
      expect(f.readBodyCount()).toBe(0)
      expect(f.writeCount()).toBe(0)
      expect(
        [...f.json.entries()].filter(([key]) =>
          key.startsWith("operations/shared-observation-pending/"),
        ),
      ).toEqual(pending)
      expect(
        [...f.json.keys()].some(
          (key) => key.startsWith("snapshots/") || key.startsWith("cache/latest/"),
        ),
      ).toBe(false)
    })
  }

  test("a visible unresolved shared plan blocks a second machine without a local journal", async () => {
    const f = fixture()
    f.unknownRecord("file_event", false)
    await expect(f.open()).rejects.toThrow()
    f.json.clear()
    f.objects.clear()
    f.bodies.set(skillPage, "Changed on another client\n")
    f.clearCalls()
    await expect(f.open()).rejects.toThrow()
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
    expect([...f.json.keys()].some((key) => key.startsWith("snapshots/"))).toBe(false)
  })

  test("a shared tombstone removes its logical file without reading the deleted body's page", async () => {
    const f = fixture()
    await f.open()
    const row = [...f.records.values()].find(
      (candidate) =>
        text(property(property(candidate.properties).entity).rich_text) === "file-1" &&
        property(property(property(candidate.properties).kind).select).name === "file_event",
    )
    if (!row) throw new Error("Missing adoption event")
    const event = property(
      property(JSON.parse(text(property(property(row.properties).payload).rich_text))).payload,
    )
    f.seedFact(
      {
        event_id: "delete-reference-one",
        file_id: "file-1",
        parents: [event.event_id],
        kind: "deleted",
        retained: event.content,
      },
      "file_event",
      "file-1",
      "delete-reference-one",
    )
    f.clearCalls()
    const snapshot = await f.open()
    expect(snapshot.files.map((file) => file.path)).toEqual(["SKILL.md", "references/2.md"])
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
  })

  test("missing visible membership and events cannot silently delete a previously observed native file", async () => {
    const f = fixture()
    const first = await f.open()
    f.files.splice(0, 1)
    for (const [page, row] of f.records)
      if (text(property(property(row.properties).entity).rich_text) === "file-1")
        f.records.delete(page)
    f.clearCalls()
    await expect(f.open()).rejects.toThrow("membership is missing")
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
    expect([...f.json.keys()].filter((key) => key.startsWith("snapshots/"))).toEqual([
      `snapshots/${first.snapshot_id}.json`,
    ])
  })

  test("orphan file facts prevent a false complete snapshot, and disabled content never reads bodies", async () => {
    const orphan = fixture()
    orphan.seedFact(
      {
        event_id: "orphan",
        file_id: "absent-file",
        parents: [],
        kind: "projected",
        source_revision: "commit",
        projection: { normalization_version: 1, sha256: digest("x") },
      },
      "file_event",
      "absent-file",
      "orphan",
    )
    await expect(orphan.open()).rejects.toThrow("no current binding")
    expect(orphan.readBodyCount()).toBe(0)
    const disabled = fixture()
    property(disabled.main.properties).enabled = {
      id: "enabled",
      type: "checkbox",
      checkbox: false,
    }
    await expect(disabled.open()).rejects.toThrow("disabled")
    expect(disabled.readBodyCount()).toBe(0)
    expect(disabled.writeCount()).toBe(0)
  })
})
