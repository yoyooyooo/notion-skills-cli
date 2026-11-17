import { expect, test } from "bun:test"
import { compactApplyOutput } from "../src/apply-output.ts"
import { renderCommandOutput } from "../src/command-output.ts"
import { channel } from "node:diagnostics_channel"
import { createHash } from "node:crypto"
import { createRequestMetrics } from "../../core/src/request-metrics.ts"

test("compact apply retains exact owner, pin, operation and aggregate request evidence without carrying the transport trace", () => {
  const original = {
    ok: true,
    operation: "apply",
    status: "applied",
    completion: "complete",
    verified: true,
    apply_operation_id: "skill-apply-" + "a".repeat(64),
    record: { id: "shared_skill:library-1:skill-1", name: "Owned Skill" },
    snapshot_id: "s_" + "b".repeat(64),
    ref: "skill://shared_skill%3Alibrary-1%3Askill-1/SKILL.md?snapshot=s_" + "b".repeat(64),
    changes: { files: ["SKILL.md", "references/new.md"], removed: [] },
    effects: { author_content: "confirmed", retained_remote: "confirmed" },
    next: { read_only: true, argv: ["ntn-skills", "read", "PINNED_REF"] },
    request_metrics: {
      requests: { notion_metadata: 81, notion_body: 19, notion_write: 14, provider: 0 },
      total_requests: 114,
      response_bytes: 548166,
      trace_enabled: true,
      trace_dropped: 0,
      trace: Array.from({ length: 114 }, (_, index) => ({
        event: "attempt",
        attempt: index + 1,
        request_id: String(index).padStart(10, "0"),
        details: "test-event".repeat(50),
      })),
    },
  }
  const fullSize = Buffer.byteLength(JSON.stringify(original))
  expect(fullSize).toBeGreaterThan(50000)
  const compressed = compactApplyOutput(original)
  expect(Buffer.byteLength(JSON.stringify(compressed))).toBeLessThan(3000)
  expect(compressed).toMatchObject({
    ok: true,
    status: "applied",
    completion: "complete",
    verified: true,
    apply_operation_id: original.apply_operation_id,
    record: original.record,
    snapshot_id: original.snapshot_id,
    ref: original.ref,
    changes: original.changes,
    next: original.next,
    request_metrics: {
      requests: original.request_metrics.requests,
      total_requests: 114,
      response_bytes: 548166,
      trace_enabled: true,
      trace_dropped: 0,
      trace_omitted_from_output: true,
      trace_entries: 114,
    },
  })
  expect(compressed.request_metrics).not.toHaveProperty("trace")
  expect(original.request_metrics.trace).toHaveLength(114)
})

test("compact mode does not rewrite results without a complete per-attempt trace", () => {
  const error = { ok: false, error: { code: "SHARED_APPLY_UNKNOWN" } }
  expect(compactApplyOutput(error)).toBe(error)
  const untraced = { ok: true, status: "unchanged", request_metrics: { total_requests: 0 } }
  expect(compactApplyOutput(untraced)).toBe(untraced)
})

test("the final CLI formatter projects after full command metrics and emits a hash-bound separate complete ledger", () => {
  const metrics = createRequestMetrics({ traceLimit: 100 })
  const finish = metrics.begin({
    path: "v1/pages/00000000-0000-4000-8000-000000000001",
    method: "GET",
    requestBytes: 0,
  })
  finish({ responseBytes: 364 })
  const original = metrics.snapshot()
  const outputEvents: unknown[] = []
  const observer = (event: unknown) => {
    outputEvents.push(event)
  }
  const diagnostic = channel("ntn-skills.command-output")
  diagnostic.subscribe(observer)
  try {
    const result = {
      operation: "apply",
      status: "applied",
      verified: true,
      apply_operation_id: "exact-original",
      sensitive_input_body: "Not recorded by diagnostics",
      request_metrics: { total_requests: 999 },
    }
    const compact = renderCommandOutput(result, original, compactApplyOutput)
    const projected = JSON.parse(compact)
    expect(projected.request_metrics.total_requests).toBe(1)
    expect(projected.request_metrics.trace_omitted_from_output).toBe(true)
    expect(projected.request_metrics).not.toHaveProperty("trace")
    expect(outputEvents).toHaveLength(1)
    expect(outputEvents[0]).toEqual({
      version: 1,
      event: "result",
      operation: "apply",
      status: "applied",
      operation_id: "exact-original",
      projected: true,
      output_bytes: Buffer.byteLength(compact),
      output_sha256: createHash("sha256").update(compact).digest("hex"),
      request_metrics: original,
    })
    expect(outputEvents[0]).not.toHaveProperty("sensitive_input_body")
    const full = renderCommandOutput(result, original)
    expect(JSON.parse(full).request_metrics).toEqual(original)
    expect(full).toBe(JSON.stringify({ ok: true, ...result, request_metrics: original }) + "\n")
    expect(original.trace.length).toBeGreaterThan(0)
  } finally {
    diagnostic.unsubscribe(observer)
  }
})
