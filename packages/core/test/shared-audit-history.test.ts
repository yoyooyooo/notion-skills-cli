import { expect, test } from "bun:test"
import { Effect } from "effect"
import { zipSync } from "fflate"
import { readImportZip } from "../src/import.ts"
import { property, text, SkillsError } from "../src/model.ts"
import { runSharedAudit } from "../src/shared-audit.ts"
import { auditRetainedHistory } from "../src/shared-audit-history.ts"
import {
  prepareSharedResourceContent,
  retainSharedResourceContent,
} from "../src/shared-resource-content.ts"
import { appendSharedRecord, canonicalSharedJson } from "../src/shared-records.ts"
import type { RetainedSource } from "../src/shared-retained-source.ts"
import { auditFixture } from "./shared-audit-fixture.ts"
import { digest, encode, library, rich, skillPage } from "./shared-snapshot-fixture.ts"

for (const scenario of [
  { name: "mismatched declared mode", declared: "100755", archived: "100644", verified: false },
  { name: "unobserved declared mode", declared: "100755", archived: undefined, verified: false },
  { name: "matching declared mode", declared: "100755", archived: "100755", verified: true },
  { name: "legacy absent mode", declared: undefined, archived: "100644", verified: true },
] as const) {
  test(`retained archive history checks ${scenario.name} independently of warm bytes`, async () => {
    const f = await auditFixture(1)
    const bytes = encode("# Retained mode fixture\n")
    const archive = zipSync(
      {
        "SKILL.md": [
          bytes,
          scenario.archived === undefined
            ? {}
            : { attrs: Number.parseInt(scenario.archived, 8) << 16, os: 3 },
        ],
      },
      { level: 0 },
    )
    expect(readImportZip(archive)[0]?.mode).toBe(scenario.archived)
    const hash = digest(archive)
    const chunk = { object_id: `chunk-${hash}`, sha256: hash, bytes: archive.length }
    const source: RetainedSource = {
      version: 1,
      kind: "retained_bundle",
      library_id: library.library_id,
      skill_page_id: skillPage,
      entrypoint: "SKILL.md",
      files: [
        {
          path: "SKILL.md",
          sha256: digest(bytes),
          bytes: bytes.length,
          ...(scenario.declared === undefined ? {} : { mode: scenario.declared }),
        },
      ],
      archive: { format: "zip", sha256: hash, bytes: archive.length, chunks: [chunk] },
    }
    const sourceId = `bundle-${digest(canonicalSharedJson(source))}`
    await f.run(
      appendSharedRecord(library, {
        mode: "create",
        recordId: chunk.object_id,
        operationId: `retain-${chunk.object_id}`,
        skillPageId: skillPage,
        entityId: chunk.object_id,
        kind: "object",
        payload: {
          version: 1,
          kind: "exact_bytes",
          encoding: "base64",
          sha256: hash,
          bytes: archive.length,
          data: Buffer.from(archive).toString("base64"),
        },
      }),
    )
    await f.run(
      appendSharedRecord(library, {
        mode: "create",
        recordId: sourceId,
        operationId: `retain-${sourceId}`,
        skillPageId: skillPage,
        entityId: sourceId,
        kind: "source",
        payload: source,
      }),
    )
    f.objects.set(`objects/${digest(bytes)}`, bytes)
    const before = canonicalSharedJson([...f.records.values()])
    f.clearLedger()
    const report = await f.run(
      auditRetainedHistory(library, {
        skill_page_id: skillPage,
        events: [],
        pins: [],
        bundles: [sourceId],
        operations: [],
      }),
    )
    expect(report.history).toHaveLength(1)
    expect(report.history[0]).toMatchObject({
      object_id: sourceId,
      kind: "retained_bundle",
      cached_available: true,
      remote_status: scenario.verified ? "verified" : "unavailable",
    })
    if (scenario.verified) expect(report.findings).toEqual([])
    else {
      expect(report.findings).toHaveLength(1)
      expect(report.findings[0]).toMatchObject({
        code: "HISTORY_REMOTE_UNAVAILABLE",
        object_id: sourceId,
        coverage: "partial",
        evidence: { code: "RETAINED_SOURCE_INVALID" },
      })
    }
    expect(canonicalSharedJson([...f.records.values()])).toBe(before)
    expect(f.writeCount()).toBe(0)
  })
}

test("history keeps warm exact bytes separate from a missing remote retained object", async () => {
  const f = await auditFixture(1)
  const first = await f.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "library" },
      depth: "history",
    }),
  )
  expect(first.coverage).toBe("full")
  const object = first.items[0]!.history.find((value) => value.kind === "custom_history")!
  expect(object.remote_status).toBe("verified")
  f.objects.set(`objects/${object.sha256}`, encode(f.bodies.get(skillPage)!))
  const row = [...f.records.entries()].find(
    ([, row]) => text(property(property(row.properties).record).rich_text) === object.object_id,
  )!
  f.records.delete(row[0])
  const remaining = canonicalSharedJson([...f.records.values()])
  f.clearLedger()
  const missing = await f.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "library" },
      depth: "history",
    }),
  )
  const retained = missing.items[0]!.history.find((value) => value.object_id === object.object_id)
  expect(retained?.cached_available).toBe(true)
  expect(retained?.remote_status).toBe("unavailable")
  expect(missing.coverage).toBe("permission_limited")
  expect(missing.retention.global_gc_safe).toBe(false)
  expect(missing.retention.private_session_references).toBe("not_globally_enumerable")
  expect(
    missing.findings.some(
      (finding) =>
        finding.code === "HISTORY_REMOTE_UNAVAILABLE" && finding.object_id === object.object_id,
    ),
  ).toBe(true)
  expect(canonicalSharedJson([...f.records.values()])).toBe(remaining)
  expect(f.writeCount()).toBe(0)
})

test("raw resource audit verifies exact binary bytes and retained history without observing its management page", async () => {
  const f = await auditFixture(2)
  const child = f.files[0]!
  const bytes = new Uint8Array([0, 255, 13, 10, 128, 1])
  // Controlled initial ownership setup, separate from the readonly audit.
  for (const [key, row] of f.records)
    if (text(property(property(row.properties).entity).rich_text) === "file-1")
      f.records.delete(key)
  const prepared = await f.run(prepareSharedResourceContent(bytes, "100755"))
  await f.run(
    retainSharedResourceContent(library, { skillPageId: skillPage, prepared, mode: "create" }),
  )
  property(child.properties).path = rich("path", "scripts/tool.bin")
  f.seedFact(
    {
      kind: "adopted",
      event_id: "raw-initial",
      file_id: "file-1",
      parents: [],
      content: prepared.content,
    },
    "file_event",
    "file-1",
    "raw-initial",
  )
  f.bodies.set(child.id, "This is a resource management page, not the file bytes.")
  f.clearLedger()
  const before = canonicalSharedJson([...f.records.values()])
  const report = await f.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "library" },
      depth: "history",
    }),
  )
  const file = report.items[0]?.tree.find((file) => file.path === "scripts/tool.bin")
  expect(file?.origin).toBe("resource")
  expect(file?.sha256).toBe(prepared.content.sha256)
  expect(file?.bytes).toBe(bytes.length)
  expect(file?.remote_status).toBe("verified")
  expect(
    report.items[0]?.history.some(
      (value) =>
        value.object_id === prepared.content.object_id && value.remote_status === "verified",
    ),
  ).toBe(true)
  expect(f.ledger.some((call) => call.path.startsWith(`v1/pages/${child.id}/markdown`))).toBe(false)
  expect(canonicalSharedJson([...f.records.values()])).toBe(before)
  expect(f.writeCount()).toBe(0)
})

test("an explicit unavailable graph stays an exact incomplete scope and never falls back to current graph", async () => {
  const f = await auditFixture(1)
  const graph = `graph-${"a".repeat(64)}`
  const report = await f.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "library" },
      depth: "history",
      graph_id: graph,
    }),
  )
  expect(report.execution).toBe("completed")
  expect(report.coverage).toBe("partial")
  expect(report.graph.graph_id).toBe(graph)
  expect(report.graph.result).toBeNull()
  expect(
    report.findings.some(
      (finding) => finding.code === "GRAPH_HISTORY_UNAVAILABLE" && finding.object_id === graph,
    ),
  ).toBe(true)
  expect(f.writeCount()).toBe(0)
  const invalid = await f.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "library" },
      graph_id: graph,
    }).pipe(Effect.flip),
  )
  expect(invalid instanceof SkillsError && invalid.code).toBe("INVALID_ARGUMENT")
})
