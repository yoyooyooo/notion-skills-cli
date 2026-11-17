import { expect, test } from "bun:test"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import { Store, sha256 } from "../src/store.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { captureAuditValue } from "../src/shared-audit-checkpoint.ts"
import { emptyAuditInventory } from "../src/shared-audit-model.ts"
import { readAuditRun, saveAuditRun } from "../src/shared-audit-store.ts"
import { runSharedAudit, reportSharedAudit } from "../src/shared-audit.ts"
import { auditFixture } from "./shared-audit-fixture.ts"
import { library } from "./shared-snapshot-fixture.ts"

test("large paginated observations append bounded bytes and reopen with every original value", async () => {
  const fixture = await auditFixture(1)
  const started = await fixture.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "census" },
      budget: { requests: 1 },
    }),
  )
  const original = await fixture.run(readAuditRun(started.run_id))
  const writes: Array<{ key: string; bytes: number }> = []
  const expected = await fixture.run(
    Effect.gen(function* () {
      const store = yield* Store
      const measured = {
        ...store,
        writeJson: (key: string, value: unknown) => {
          if (key.startsWith("audit/"))
            writes.push({ key, bytes: new TextEncoder().encode(JSON.stringify(value)).length })
          return store.writeJson(key, value)
        },
      }
      let current = {
        ...original,
        observations: {},
        inventory: emptyAuditInventory(),
        census: emptyAuditInventory(),
      }
      const observed: unknown[] = []
      for (let page = 0; page < 40; page++) {
        const value = captureAuditValue({
          object: "list",
          results: [{ id: `record-${page}`, metadata: "m".repeat(50_000) }],
          has_more: page < 39,
          next_cursor: page < 39 ? `page-${page + 1}` : null,
        })
        observed.push(value)
        current = {
          ...current,
          observations: {
            ...current.observations,
            [`request-${page}`]: {
              task_key: "initial:0:records",
              path: "v1/data_sources/records/query",
              outcome: "success" as const,
              observed_at: page,
              response_sha256: yield* sha256(canonicalSharedJson(value)),
              value,
            },
          },
        }
        // Later pagination must not rewrite an already completed large table.
        if (page === 19) current.inventory = { ...current.inventory, records: [...observed] }
        yield* saveAuditRun(current).pipe(Effect.provideService(Store, measured))
      }
      return current
    }),
  )
  const total = writes.reduce((sum, write) => sum + write.bytes, 0)
  const logical = new TextEncoder().encode(canonicalSharedJson(expected)).length
  expect(total).toBeLessThan(logical * 2)
  expect(
    Math.max(
      ...writes.filter((write) => write.key.startsWith("audit/runs/")).map((write) => write.bytes),
    ),
  ).toBeLessThan(32_000)
  fixture.clearLedger()
  const reopened = await fixture.run(readAuditRun(started.run_id))
  expect(canonicalSharedJson(reopened)).toBe(canonicalSharedJson(expected))
  expect(Object.keys(reopened.observations)).toHaveLength(40)
  expect(fixture.ledger).toHaveLength(0)
})

test("old full checkpoints report offline without rewriting their format", async () => {
  const fixture = await auditFixture(1)
  const report = await fixture.run(
    runSharedAudit({ entry: library.skills.database_id, selector: { kind: "census" } }),
  )
  const run = await fixture.run(readAuditRun(report.run_id))
  const key = `audit/runs/${run.run_id}.json`
  const legacy = { sha256: await fixture.run(sha256(canonicalSharedJson(run))), run }
  fixture.json.set(key, legacy)
  fixture.clearLedger()
  const before = canonicalSharedJson([...fixture.json])
  const reopened = await fixture.run(reportSharedAudit(run.run_id))
  expect(reopened.execution).toBe(report.execution)
  expect(canonicalSharedJson([...fixture.json])).toBe(before)
  expect(fixture.ledger).toHaveLength(0)
})

test("missing or damaged parts fail offline with the exact audit and part identity", async () => {
  for (const missing of [false, true]) {
    const fixture = await auditFixture(1)
    const report = await fixture.run(
      runSharedAudit({ entry: library.skills.database_id, selector: { kind: "census" } }),
    )
    const entry = [...fixture.json].find(([key]) => key.startsWith(`audit/parts/${report.run_id}/`))
    expect(entry).toBeDefined()
    if (entry === undefined) throw new Error("No retained audit part")
    if (missing) fixture.json.delete(entry[0])
    else fixture.json.set(entry[0], { value: { replaced: true } })
    fixture.clearLedger()
    const error = await fixture.run(readAuditRun(report.run_id).pipe(Effect.flip))
    expect(error.code).toBe("AUDIT_CHECKPOINT_CORRUPT")
    expect(property(error.details).run_id).toBe(report.run_id)
    expect(entry[0]).toContain(String(property(error.details).part_sha256))
    expect(fixture.ledger).toHaveLength(0)
  }
})
