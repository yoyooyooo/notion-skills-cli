import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { Notion } from "../src/notion.ts"
import { assertRequestBudget, RequestBudgetError } from "../src/request-metrics.ts"
import { sharedSnapshotFixture } from "./shared-snapshot-fixture.ts"

const pages = (rows: number) => Math.max(1, Math.ceil(rows / 100))

describe("shared snapshot controlled transport budgets", () => {
  for (const fileCount of [1, 10, 100, 101, 300]) {
    for (const changedFiles of new Set([1, Math.min(3, fileCount)])) {
      test(`N=${fileCount}, k=${changedFiles}: batched unchanged validation and only changed bodies`, async () => {
        const f = sharedSnapshotFixture({ fileCount })
        const first = await f.open()
        const cold = f.requestMetrics()
        f.clearCalls()
        const unchanged = await f.open()
        const unchangedMetrics = f.requestMetrics()
        // Main metadata is the one fixed request. Files, events and operations
        // each paginate independently; no allowance is inferred from the trace.
        const metadataPages = pages(fileCount - 1) + 2 * pages(fileCount)
        const baselineBudget = { fileCount, metadataPages, metadataConstant: 1 }
        expect(() =>
          assertRequestBudget(f.requestMetrics(), { ...baselineBudget, scenario: "ttl_expired" }),
        ).not.toThrow()
        expect(f.requestMetrics().requests).toEqual({
          notion_metadata: metadataPages + 1,
          notion_body: 0,
          notion_write: 0,
          provider: 0,
        })
        expect(unchanged.snapshot_id).toBe(first.snapshot_id)

        const changedPages =
          changedFiles === 1 && f.files[0] !== undefined
            ? [f.files[0]]
            : [f.main, ...f.files].slice(0, changedFiles)
        for (const file of changedPages) {
          file.last_edited_time = new Date(
            Date.parse(String(file.last_edited_time)) + 1,
          ).toISOString()
          f.bodies.set(
            String(file.id),
            `Changed file ${file.id} at N=${fileCount}, k=${changedFiles}\n`,
          )
        }
        f.clearCalls()
        const changed = await f.open()
        const trace = f.requestMetrics()
        if (process.env.SC12_EVIDENCE !== undefined)
          writeFileSync(
            join(process.env.SC12_EVIDENCE, `shared-cost-N${fileCount}-k${changedFiles}.json`),
            JSON.stringify(
              {
                version: 1,
                environment: "controlled Notion service fixture; not a live HTTP measurement",
                file_count: fileCount,
                changed_files: changedFiles,
                changed_page_ids: changedPages.map((file) => file.id),
                phases: {
                  cold: { snapshot_id: first.snapshot_id, metrics: cold },
                  unchanged_online: {
                    snapshot_id: unchanged.snapshot_id,
                    metrics: unchangedMetrics,
                  },
                  changed_online: { snapshot_id: changed.snapshot_id, metrics: trace },
                },
              },
              null,
              2,
            ) + "\n",
            { flag: "wx", mode: 0o600 },
          )
        expect(() =>
          assertRequestBudget(trace, { ...baselineBudget, scenario: "body_changed", changedFiles }),
        ).not.toThrow()
        expect(trace.requests).toEqual({
          notion_metadata: metadataPages + 1 + changedFiles,
          notion_body: 3 * changedFiles,
          notion_write: 3 * changedFiles,
          provider: 0,
        })
        expect(trace.body_requests).toEqual({
          current_body: changedFiles,
          retained_body: 2 * changedFiles,
          unclassified_body: 0,
        })
        expect(
          f.calls
            .map((call) => new URL(call.path, "https://controlled.invalid/").pathname)
            .filter((path) => path.endsWith("/markdown")),
        ).toEqual(changedPages.map((file) => `/v1/pages/${file.id}/markdown`))
        expect(trace.in_flight).toBe(0)
        expect(trace.unknown_response_bytes).toBe(0)
        expect(changed.snapshot_id).not.toBe(first.snapshot_id)
      })
    }
  }

  test("an actual per-file metadata loop fails the unchanged budget", async () => {
    const fileCount = 101
    const f = sharedSnapshotFixture({ fileCount })
    await f.open()
    f.clearCalls()
    await f.open()
    // Deliberately model an N+1 regression through the same request boundary.
    await f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        for (const file of [f.main, ...f.files]) yield* api.request(`v1/pages/${file.id}`)
      }),
    )
    expect(() =>
      assertRequestBudget(f.requestMetrics(), {
        scenario: "ttl_expired",
        fileCount,
        metadataPages: pages(fileCount - 1) + 2 * pages(fileCount),
        metadataConstant: 1,
      }),
    ).toThrow(RequestBudgetError)
  })
})
