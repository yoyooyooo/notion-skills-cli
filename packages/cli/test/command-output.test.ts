import { expect, test } from "bun:test"
import { channel } from "node:diagnostics_channel"
import { createHash } from "node:crypto"
import { renderCommandOutput } from "../src/command-output.ts"
import { createRequestMetrics } from "../../core/src/request-metrics.ts"

test("current import output keeps complete metrics and binds diagnostics to stdout without exposing input", () => {
  const metrics = createRequestMetrics({ traceLimit: 100 })
  const finish = metrics.begin({
    path: "v1/pages/00000000-0000-4000-8000-000000000001",
    method: "GET",
    requestBytes: 0,
  })
  finish({ responseBytes: 364 })
  const observed = metrics.snapshot()
  const events: unknown[] = []
  const observer = (event: unknown) => {
    events.push(event)
  }
  const diagnostic = channel("ntn-skills.command-output")
  diagnostic.subscribe(observer)
  try {
    const result = {
      contract: "current",
      status: "applied",
      operation_id: "current-import",
      skill_id: "example",
      page_id: "00000000-0000-4000-8000-000000000001",
      input_sha256: "a".repeat(64),
      files: 2,
      state: "ready",
      input: { source: "/private/selected-input" },
      sensitive_input_body: "完整私有正文，不进入诊断事件",
      request_metrics: { total_requests: 999 },
    }
    const output = renderCommandOutput(result, observed)
    expect(output).toBe(JSON.stringify({ ok: true, ...result, request_metrics: observed }) + "\n")
    expect(JSON.parse(output).request_metrics).toEqual(observed)
    expect(observed.trace.length).toBeGreaterThan(0)
    expect(events).toEqual([
      {
        version: 1,
        event: "result",
        operation: null,
        status: "applied",
        operation_id: result.operation_id,
        projected: false,
        output_bytes: Buffer.byteLength(output),
        output_sha256: createHash("sha256").update(output).digest("hex"),
        request_metrics: observed,
      },
    ])
    expect(events[0]).not.toHaveProperty("input")
    expect(events[0]).not.toHaveProperty("sensitive_input_body")
    expect(JSON.stringify(events)).not.toContain(result.sensitive_input_body)
  } finally {
    diagnostic.unsubscribe(observer)
  }
})

test("diagnostics do not infer a current operation identity from a retired apply field", () => {
  const events: unknown[] = []
  const observer = (event: unknown) => {
    events.push(event)
  }
  const diagnostic = channel("ntn-skills.command-output")
  diagnostic.subscribe(observer)
  try {
    renderCommandOutput({ status: "ready", apply_operation_id: "retired-operation" })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ operation_id: null, projected: false })
  } finally {
    diagnostic.unsubscribe(observer)
  }
})
