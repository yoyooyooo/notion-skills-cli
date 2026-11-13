import { expect, test } from "bun:test"
import { Effect } from "effect"
import { fail, property } from "../src/model.ts"
import { runSharedAudit, reportSharedAudit, resumeSharedAudit } from "../src/shared-audit.ts"
import { readAuditRun, saveAuditRun } from "../src/shared-audit-store.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { auditFixture } from "./shared-audit-fixture.ts"
import { id, library, rich, skillPage } from "./shared-snapshot-fixture.ts"
import {
  prepareSharedFileManagement,
  executeSharedFileManagement,
} from "../src/shared-file-management.ts"
import { authScope } from "../src/catalog.ts"
import { openSharedSnapshot } from "../src/shared-snapshot.ts"

const relation = (name: string, ids: readonly string[], more = false) => ({
  id: name,
  type: "relation",
  relation: ids.map((value) => ({ id: value })),
  has_more: more,
})

function queries(fixture: Awaited<ReturnType<typeof auditFixture>>) {
  return fixture.ledger.filter(
    (call) => call.path.includes("/data_sources/") && call.path.includes("/query"),
  )
}

test("an early target identity finding survives budget exhaustion before owned rows finish", async () => {
  const fixture = await auditFixture(1)
  property(fixture.main.properties).main_file_id = rich("main_file_id", "")
  let report = await fixture.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "skill", page_id: skillPage },
      budget: { requests: 3 },
    }),
  )
  expect(report.execution).toBe("paused")
  expect(fixture.ledger.some((call) => call.path === `v1/pages/${skillPage}`)).toBe(true)
  expect(report.findings.some((finding) => finding.code === "MAIN_FILE_ID_INVALID")).toBe(true)
  const original = report.run_id
  for (let attempt = 0; report.execution === "paused" && attempt < 15; attempt++)
    report = await fixture.run(resumeSharedAudit(original, { budget: { requests: 2 } }))
  expect(report.run_id).toBe(original)
  expect(report.execution).toBe("completed")
  expect(report.findings.some((finding) => finding.code === "MAIN_FILE_ID_INVALID")).toBe(true)
  expect(fixture.writeCount()).toBe(0)
})

test("target request count stays flat when unrelated rows exist and library census does not", async () => {
  const small = await auditFixture(3)
  const smallReport = await small.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "skill", page_id: skillPage },
    }),
  )
  const smallQueries = queries(small).length
  const crowded = await auditFixture(3)
  for (let index = 0; index < 180; index++) {
    const page = id(500 + index)
    crowded.files.push({
      ...structuredClone(crowded.files[0]!),
      id: page,
      properties: {
        ...structuredClone(crowded.files[0]!.properties),
        file_id: rich("file_id", `foreign-${index}`),
        path: rich("path", `foreign/${index}.md`),
        skill: relation("skill", [id(70)]),
      },
    })
    crowded.records.set(page, {
      object: "page",
      id: page,
      parent: {
        type: "data_source_id",
        data_source_id: library.records.data_source_id,
        database_id: library.records.database_id,
      },
      properties: {
        title: { id: "title", type: "title", title: [{ plain_text: page }] },
        record: rich("record", `foreign-record-${index}`),
        kind: { id: "kind", type: "select", select: { name: "object" } },
        entity: rich("entity", `foreign-entity-${index}`),
        hash: rich("hash", "ab".repeat(32)),
        payload: rich("payload", "not-read"),
        skill: relation("skill", [id(70)]),
      },
    })
  }
  const before = canonicalSharedJson([...crowded.records.values()])
  const report = await crowded.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "skill", page_id: skillPage },
    }),
  )
  expect(report.execution).toBe("completed")
  expect(report.coverage).toBe("full")
  expect(queries(crowded)).toHaveLength(smallQueries)
  expect(queries(crowded).every((call) => property(call.body).filter !== undefined)).toBe(true)
  expect(canonicalSharedJson([...crowded.records.values()])).toBe(before)
  expect(crowded.writeCount()).toBe(0)
  expect(report.growth.private_pins).toBe("unobserved")
  expect(report.growth.payload_policy).toBe("headers_only")
  expect(report.growth.remote_gc).toBe("not_performed")
  expect(report.growth.script_classification).toBe("unlinked_script_is_not_an_orphan")
  expect(
    [report.next, ...report.alternatives]
      .filter((step) => step !== null)
      .some((step) => step.state === "reverse_census_unobserved"),
  ).toBe(true)
  expect(
    [report.next, ...report.alternatives]
      .filter((step) => step !== null)
      .every((step) => step.argv[0] === "ntn-skills"),
  ).toBe(true)
  expect(JSON.stringify(report.next)).not.toMatch(/[;&|`$<>]/u)
  const libraryRun = await crowded.run(
    runSharedAudit({ entry: library.skills.database_id, selector: { kind: "library" } }),
  )
  expect(libraryRun.inspection_scope).toBe("registered_library")
  expect(libraryRun.reverse_table_completeness).toBe("complete")
  expect(
    queries(crowded).filter((call) => property(call.body).filter === undefined).length,
  ).toBeGreaterThan(0)
  expect(smallReport.coverage).toBe("full")
  expect(crowded.writeCount()).toBe(0)
})

test("a missing target and a bad main file are findings, and a cleared owner stays a library fact", async () => {
  const missing = await auditFixture(2)
  missing.intercept((path) =>
    path === `v1/pages/${skillPage}` ? Effect.fail(fail("NOT_FOUND", "Missing page")) : undefined,
  )
  const missingReport = await missing.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "skill", page_id: skillPage },
    }),
  )
  expect(missingReport.execution).toBe("completed")
  expect(missingReport.coverage).not.toBe("full")
  expect(missingReport.findings.some((finding) => finding.code === "TARGET_PAGE_UNAVAILABLE")).toBe(
    true,
  )
  expect(missingReport.findings.some((finding) => finding.code === "FILE_OWNER_MISSING")).toBe(
    false,
  )
  expect(missing.writeCount()).toBe(0)

  const identity = await auditFixture(2)
  property(identity.main.properties).main_file_id = rich("main_file_id", "")
  const identityReport = await identity.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "skill", page_id: skillPage },
    }),
  )
  expect(identityReport.execution).toBe("completed")
  expect(identityReport.findings.some((finding) => finding.code === "MAIN_FILE_ID_INVALID")).toBe(
    true,
  )
  expect(identityReport.findings.some((finding) => finding.code === "SKILL_TREE_UNAVAILABLE")).toBe(
    true,
  )
  expect(identityReport.items[0]?.tree).toEqual([])

  const cleared = await auditFixture(2)
  const orphan = {
    ...structuredClone(cleared.files[0]!),
    id: id(77),
    properties: {
      ...structuredClone(cleared.files[0]!.properties),
      file_id: rich("file_id", "cleared-owner"),
      path: rich("path", "scripts/unlinked.sh"),
      skill: relation("skill", []),
    },
  }
  cleared.files.push(orphan)
  const target = await cleared.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "skill", page_id: skillPage },
    }),
  )
  expect(target.findings.some((finding) => finding.object_id === id(77))).toBe(false)
  expect(target.reverse_table_completeness).toBe("unobserved")
  expect(target.findings.some((finding) => finding.code.includes("ORPHAN"))).toBe(false)
  const census = await cleared.run(
    runSharedAudit({ entry: library.skills.database_id, selector: { kind: "library" } }),
  )
  expect(
    census.findings.some(
      (finding) => finding.code === "FILE_OWNER_MISSING" && finding.object_id === id(77),
    ),
  ).toBe(true)
  expect(census.growth.script_classification).toBe("unlinked_script_is_not_an_orphan")
  expect(census.findings.some((finding) => finding.code.includes("ORPHAN"))).toBe(false)
})

test("owner pagination and a 30-value relation stay on the filtered target path", async () => {
  const fixture = await auditFixture(2)
  const relationIds = Array.from({ length: 30 }, (_, index) => id(800 + index))
  const rows = Array.from({ length: 105 }, (_, index) => ({
    ...structuredClone(fixture.files[0]!),
    id: id(100 + index),
    properties: {
      ...structuredClone(fixture.files[0]!.properties),
      file_id: rich("file_id", `owned-${index}`),
      path: rich("path", index === 0 ? "scripts/unlinked.sh" : `references/owned-${index}.md`),
      skill: relation("skill", index === 0 ? relationIds.slice(0, 25) : [skillPage], index === 0),
    },
  }))
  fixture.intercept((path, body) => {
    if (path.startsWith(`v1/data_sources/${library.files.data_source_id}/query?`)) {
      expect(property(property(body).filter).relation).toEqual({ contains: skillPage })
      const offset = property(body).start_cursor === "more" ? 100 : 0
      return Effect.succeed({
        object: "list",
        results: rows.slice(offset, offset + 100),
        has_more: offset === 0,
        next_cursor: offset === 0 ? "more" : null,
      })
    }
    if (path.startsWith(`v1/pages/${id(100)}/properties/skill?`)) {
      const second = path.includes("start_cursor=relation-more")
      return Effect.succeed({
        object: "list",
        type: "property_item",
        results: relationIds.slice(second ? 25 : 0, second ? 30 : 25).map((value) => ({
          object: "property_item",
          id: "skill",
          type: "relation",
          relation: { id: value },
        })),
        has_more: !second,
        next_cursor: second ? null : "relation-more",
        property_item: {
          id: "skill",
          type: "relation",
          next_url: second ? null : "https://api.notion.com/next",
        },
      })
    }
    return undefined
  })
  const report = await fixture.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "skill", page_id: skillPage },
    }),
  )
  expect(report.execution).toBe("completed")
  expect(report.inventory.files).toBe(105)
  expect(
    fixture.ledger.filter((call) => call.path.includes("/properties/skill?")).length,
  ).toBeGreaterThan(0)
  expect(report.findings.some((finding) => finding.code === "FILE_MULTIPLE_OWNERS")).toBe(true)
  expect(report.findings.some((finding) => finding.code.includes("ORPHAN"))).toBe(false)
  expect(report.growth.script_classification).toBe("unlinked_script_is_not_an_orphan")
})

test("v1 and v2 checkpoints remain readable and cannot resume under v3", async () => {
  const fixture = await auditFixture(1)
  const paused = await fixture.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "skill", page_id: skillPage },
      budget: { requests: 1 },
    }),
  )
  const run = await fixture.run(readAuditRun(paused.run_id))
  for (const rules_version of ["resource-audit-v1", "resource-audit-v2"]) {
    await fixture.run(saveAuditRun({ ...run, rules_version }))
    fixture.clearLedger()
    const report = await fixture.run(reportSharedAudit(paused.run_id))
    expect(report.rules_version).toBe(rules_version)
    expect(report.execution).toBe("paused")
    expect(report.findings).toEqual(expect.any(Array))
    expect((await fixture.run(resumeSharedAudit(paused.run_id).pipe(Effect.flip))).code).toBe(
      "AUDIT_RULES_UNSUPPORTED",
    )
    expect(fixture.ledger).toHaveLength(0)
  }
})

test("same-owner record headers are possible equivalents and conflicting facts stay errors", async () => {
  const fixture = await auditFixture(1)
  const template = [...fixture.records.values()].find(
    (row) => property(property(property(row.properties).kind).select).name === "object",
  )
  if (template === undefined) throw new Error("Expected retained object fixture")
  const copy: Record<string, unknown> = { ...structuredClone(template), id: id(91) }
  fixture.records.set(id(91), copy)
  const report = await fixture.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "skill", page_id: skillPage },
    }),
  )
  const copies = report.findings.filter((finding) => finding.code === "RECORD_DUPLICATE_COPY")
  expect(copies.length).toBeGreaterThan(0)
  expect(
    copies.every((finding) => property(finding.evidence).equivalence === "possible_equivalent"),
  ).toBe(true)
  expect(copies.every((finding) => property(finding.evidence).full_payload_required === true)).toBe(
    true,
  )
  expect(
    [report.next, ...report.alternatives]
      .filter((step) => step !== null)
      .some((step) => step.state === "record_headers_possible_equivalent"),
  ).toBe(true)
  const conflict: Record<string, unknown> = {
    ...structuredClone(copy),
    id: id(92),
    properties: { ...property(copy.properties), hash: rich("hash", "f".repeat(64)) },
  }
  fixture.records.delete(id(91))
  fixture.records.set(id(92), conflict)
  const conflicting = await fixture.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "skill", page_id: skillPage },
    }),
  )
  expect(conflicting.findings.some((finding) => finding.code === "DUPLICATE_BUSINESS_ID")).toBe(
    true,
  )
  expect(
    property(
      conflicting.findings.find((finding) => finding.code === "DUPLICATE_BUSINESS_ID")?.evidence,
    ).fact_conflict,
  ).toBe(true)
  expect(conflicting.growth.cross_owner_equal_header_hash.body_equality).toBe("not_verified")
})

test("retention diagnostics distinguish an actual tombstone and its retained owner without proposing collection", async () => {
  const fixture = await auditFixture(2)
  const snapshot = await fixture.run(
    Effect.gen(function* () {
      const scope = yield* authScope
      yield* openSharedSnapshot({
        library,
        target: skillPage,
        scope,
        startedAt: Date.now(),
        forceFull: true,
        readOnly: false,
      })
      return yield* openSharedSnapshot({
        library,
        target: skillPage,
        scope,
        startedAt: Date.now(),
        forceFull: true,
        readOnly: true,
      })
    }),
  )
  const binding = snapshot.file_bindings?.find((file) => file.path === "references/1.md")
  if (!binding) throw new Error("The source fixture did not expose its actual supporting File ID")
  const plan = await fixture.run(
    prepareSharedFileManagement({ library, snapshot, action: "delete", fileId: binding.file_id }),
  )
  const deleted = await fixture.run(executeSharedFileManagement(library, { plan, mode: "create" }))
  expect(deleted.verified).toBe(true)
  const records = canonicalSharedJson([...fixture.records.values()])
  fixture.clearLedger()
  const report = await fixture.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "skill", page_id: skillPage },
      depth: "history",
    }),
  )
  expect(report.growth.tombstones.count).toBe(1)
  expect(report.growth.tombstones.entries[0]).toMatchObject({
    owner_page_id: skillPage,
    path: "references/1.md",
    file_id: plan.file_id,
  })
  expect(report.growth.private_pins).toBe("unobserved")
  expect(report.growth.remote_gc).toBe("not_performed")
  expect(report.growth.deletion).toBe("not_performed")
  expect(report.growth.cross_owner_equal_header_hash.body_equality).toBe("not_verified")
  expect(report.growth.body_facts.entries.every((value) => value.kind === "object")).toBe(true)
  expect(canonicalSharedJson([...fixture.records.values()])).toBe(records)
  expect(fixture.writeCount()).toBe(0)
})
