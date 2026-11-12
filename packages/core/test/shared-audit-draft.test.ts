import { expect, test } from "bun:test"
import { Effect } from "effect"
import { property, type Source } from "../src/model.ts"
import { sharedMetadataEntryFromPage } from "../src/shared-content.ts"
import { inspectAuditInventory } from "../src/shared-audit-inventory.ts"
import { emptyAuditInventory } from "../src/shared-audit-model.ts"
import {
  runSharedAudit,
  reportSharedAudit,
  resumeSharedAudit,
  listSharedAudits,
} from "../src/shared-audit.ts"
import { readAuditRun, saveAuditRun } from "../src/shared-audit-store.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { auditFixture } from "./shared-audit-fixture.ts"
import { library, rich, skillPage } from "./shared-snapshot-fixture.ts"

const source: Source = {
  alias: "controlled",
  database_id: library.skills.database_id,
  title: "Skills",
  data_source_ids: [library.skills.data_source_id],
  role: "content",
  shared_library: library,
}

async function draft() {
  const fixture = await auditFixture(1)
  const fields = property(fixture.main.properties)
  fields.skill_id = rich("skill_id", "")
  fields.main_file_id = rich("main_file_id", "")
  fields.source = rich("source", "")
  fields.projection = rich("projection", "")
  fields.references = rich("references", "")
  fields.enabled = { id: "enabled", type: "checkbox", checkbox: false }
  fixture.records.clear()
  fixture.clearLedger()
  return fixture
}

test("MNT01 the directory and complete metadata audit agree on an ordinary unregistered draft", async () => {
  const fixture = await draft()
  const before = canonicalSharedJson({
    main: fixture.main,
    files: fixture.files,
    records: [...fixture.records],
    bodies: [...fixture.bodies],
  })
  expect(
    sharedMetadataEntryFromPage(fixture.main, source, library.skills.data_source_id).state,
  ).toBe("unregistered")
  const report = await fixture.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "skill", page_id: skillPage },
    }),
  )
  expect(report.execution).toBe("completed")
  expect(report.coverage).toBe("full")
  expect(report.severity.error).toBe(0)
  expect(report.findings.some((item) => item.code === "UNREGISTERED_DRAFT")).toBe(true)
  expect(report.items[0]?.state).toMatchObject({
    registration: "unregistered",
    enabled: false,
    adoption: "not_evaluated",
  })
  expect(report.items[0]?.tree).toEqual([])
  expect(fixture.readBodyCount()).toBe(0)
  expect(fixture.writeCount()).toBe(0)
  expect(
    canonicalSharedJson({
      main: fixture.main,
      files: fixture.files,
      records: [...fixture.records],
      bodies: [...fixture.bodies],
    }),
  ).toBe(before)
  const calls = fixture.ledger.length
  expect((await fixture.run(reportSharedAudit(report.run_id))).run_id).toBe(report.run_id)
  expect(fixture.ledger).toHaveLength(calls)
})

test("MNT01 an unfinished draft remains visible without asserting body or history verification", async () => {
  const fixture = await draft(),
    fields = property(fixture.main.properties)
  fields.title = { id: "title", type: "title", title: [] }
  fields.description = rich("description", "")
  fields.kind = { id: "kind", type: "select", select: null }
  for (const depth of ["metadata", "content", "history"] as const) {
    const report = await fixture.run(
      runSharedAudit({
        entry: library.skills.database_id,
        selector: { kind: "skill", page_id: skillPage },
        depth,
      }),
    )
    expect(report.execution).toBe("completed")
    expect(report.severity.error).toBe(0)
    expect(report.coverage).toBe(depth === "metadata" ? "full" : "partial")
    expect(report.items[0]?.state).toMatchObject({
      registration: "unregistered",
      adoption: "not_evaluated",
    })
    expect(report.items[0]?.history).toEqual([])
  }
  expect(fixture.readBodyCount()).toBe(0)
  expect(fixture.writeCount()).toBe(0)
})

test("MNT01 blank identity never hides lifecycle bindings, partial identities or malformed fields", async () => {
  const mutations = [
    (fields: Record<string, unknown>) => {
      fields.main_file_id = rich("main_file_id", "existing-main")
    },
    (fields: Record<string, unknown>) => {
      fields.source = rich("source", "fixed-old-source")
    },
    (fields: Record<string, unknown>) => {
      fields.projection = rich("projection", "old-proof")
    },
    (fields: Record<string, unknown>) => {
      fields.references = rich("references", "old-reference")
    },
    (fields: Record<string, unknown>) => {
      fields.enabled = { id: "enabled", type: "checkbox", checkbox: true }
    },
    (fields: Record<string, unknown>) => {
      fields.enabled = { id: "enabled", type: "rich_text", rich_text: [] }
    },
    (fields: Record<string, unknown>) => {
      fields.skill_id = { id: "skill_id", type: "title", title: [] }
    },
    (fields: Record<string, unknown>) => {
      fields.main_file_id = { id: "main_file_id", type: "title", title: [] }
    },
    (fields: Record<string, unknown>) => {
      fields.main_file_id = { ...rich("main_file_id", ""), has_more: true }
    },
  ]
  for (const mutate of mutations) {
    const fixture = await draft()
    mutate(property(fixture.main.properties))
    const report = await fixture.run(
      runSharedAudit({
        entry: library.skills.database_id,
        selector: { kind: "skill", page_id: skillPage },
      }),
    )
    expect(report.severity.error > 0 || report.coverage !== "full").toBe(true)
    expect(fixture.writeCount()).toBe(0)
  }
})

test("MNT01 clearing identifiers cannot hide owner-linked Records or Files", async () => {
  for (const kind of ["records", "files"] as const) {
    const populated = await auditFixture(2),
      fixture = await draft()
    if (kind === "records")
      for (const [key, value] of populated.records) fixture.records.set(key, value)
    else fixture.files.push(...populated.files)
    const report = await fixture.run(
      runSharedAudit({
        entry: library.skills.database_id,
        selector: { kind: "skill", page_id: skillPage },
      }),
    )
    expect(report.findings.some((item) => item.code === "UNREGISTERED_LIFECYCLE_BOUND")).toBe(true)
    expect(report.severity.error).toBeGreaterThan(0)
    expect(report.items[0]?.state).toMatchObject({
      registration: "unregistered",
      adoption: "not_evaluated",
    })
    expect(fixture.writeCount()).toBe(0)
  }
})

test("MNT01 census does not claim a clean draft when reverse tables are unobserved", async () => {
  const fixture = await draft()
  const findings = inspectAuditInventory(library, {
    ...emptyAuditInventory(),
    skills: [fixture.main],
    complete: ["skills"],
  })
  expect(
    findings.some(
      (item) => item.code === "BUSINESS_ID_INVALID" || item.code === "MAIN_FILE_ID_INVALID",
    ),
  ).toBe(false)
  expect(
    findings.some(
      (item) => item.code === "UNREGISTERED_LIFECYCLE_UNOBSERVED" && item.coverage === "partial",
    ),
  ).toBe(true)
})

test("MNT01 old audit rules stay readable but cannot resume or become current evidence", async () => {
  const fixture = await draft()
  const paused = await fixture.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "skill", page_id: skillPage },
      budget: { requests: 1 },
    }),
  )
  const run = await fixture.run(readAuditRun(paused.run_id))
  const historical = { ...run, rules_version: "resource-audit-v1" }
  await fixture.run(saveAuditRun(historical))
  fixture.clearLedger()
  const report = await fixture.run(reportSharedAudit(paused.run_id))
  expect(report.rules_version).toBe("resource-audit-v1")
  expect(report.execution).toBe("paused")
  expect((await fixture.run(listSharedAudits())).runs[0]).toMatchObject({
    run_id: paused.run_id,
    rules_version: "resource-audit-v1",
    current_rules: false,
  })
  expect((await fixture.run(resumeSharedAudit(paused.run_id).pipe(Effect.flip))).code).toBe(
    "AUDIT_RULES_UNSUPPORTED",
  )
  expect(fixture.ledger).toHaveLength(0)
  await fixture.run(saveAuditRun({ ...run, rules_version: "unknown-future-rules" }))
  expect((await fixture.run(reportSharedAudit(paused.run_id).pipe(Effect.flip))).code).toBe(
    "AUDIT_RULES_UNSUPPORTED",
  )
  expect(fixture.ledger).toHaveLength(0)
})

test("MNT01 known managed relations and incomplete relation values cannot authorize a clean draft", async () => {
  const fixture = await draft()
  const extended = {
    ...library,
    skills: {
      ...library.skills,
      property_ids: { ...library.skills.property_ids, Requires: "requires" },
    },
  }
  for (const field of [
    { id: "requires", type: "relation", relation: [{ id: skillPage }], has_more: false },
    { id: "requires", type: "relation", relation: [], has_more: true },
    { id: "requires", type: "relation", relation: [{ id: "not-a-page" }], has_more: false },
    { id: "requires", type: "rich_text", rich_text: [] },
  ]) {
    property(fixture.main.properties).requires = field
    const findings = inspectAuditInventory(extended, {
      ...emptyAuditInventory(),
      skills: [fixture.main],
      complete: ["skills", "files", "records"],
    })
    expect(
      findings.some(
        (value) =>
          value.code === "UNREGISTERED_LIFECYCLE_BOUND" ||
          value.code === "UNREGISTERED_LIFECYCLE_UNOBSERVED",
      ),
    ).toBe(true)
  }
  expect(fixture.writeCount()).toBe(0)
})
