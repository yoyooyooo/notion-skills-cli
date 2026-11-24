import { expect, test } from "bun:test"
import * as sdk from "../src/sdk.ts"
import {
  checkSources,
  syncSources,
  MANAGEMENT_VERSION,
  currentSourceSyncExitCode,
  type SourceSyncInput,
  type CurrentSourceSyncResult,
} from "../src/management.ts"
import { createRequestMetrics } from "../../core/src/request-metrics.ts"
import { DEFAULT_CURRENT_INVOCATION_BUDGET } from "../../core/src/shared-current-invocation.ts"

const libraryRoot = "00000000-0000-4000-8000-000000000002"
const request: SourceSyncInput = {
  library: libraryRoot,
  source_ids: ["team-skills"],
  manager_id: "fixture",
  execution_id: "a".repeat(64),
}

test("management is an explicit public capability and does not appear on the consumption SDK", () => {
  expect(MANAGEMENT_VERSION).toBe(1)
  expect(typeof checkSources).toBe("function")
  expect(typeof syncSources).toBe("function")
  expect(Object.hasOwn(sdk, "checkSources")).toBe(false)
  expect(Object.hasOwn(sdk, "syncSources")).toBe(false)
})

test("management pre-abort shares the SDK cleanup and exact zero-request metrics boundary", async () => {
  const reports: unknown[] = []
  const options = {
    env: {},
    signal: AbortSignal.abort(),
    onRequestMetrics: (value: unknown) => reports.push(value),
  }
  await expect(checkSources(request, options)).rejects.toMatchObject({ code: "CANCELLED" })
  await expect(syncSources(request, options)).rejects.toMatchObject({ code: "CANCELLED" })
  expect(reports).toHaveLength(2)
  for (const report of reports) expect(report).toEqual(createRequestMetrics().snapshot())
})

test("invalid management inputs fail before acquiring runtime or credentials", async () => {
  const reports: unknown[] = []
  const options = { env: {}, onRequestMetrics: (value: unknown) => reports.push(value) }
  for (const changed of [
    { ...request, library: "" },
    { ...request, library: "skill://old/SKILL.md" },
    { ...request, source_ids: [] },
    { ...request, source_ids: ["snapshot-retired"] },
    { ...request, source_ids: ["invalid:source"] },
    { ...request, limits: { requests: 0 } },
    { ...request, limits: { bytes: -1 } },
    { ...request, limits: { duration_ms: 1.5 } },
  ])
    await expect(checkSources(changed, options)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
  await expect(syncSources({ ...request, manager_id: "" }, options)).rejects.toThrow()
  await expect(syncSources({ ...request, execution_id: "" }, options)).rejects.toThrow()
  await expect(syncSources(request, { ...options, ...{ readOnly: true } })).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  })
  expect(reports).toHaveLength(11)
  for (const report of reports) expect(report).toEqual(createRequestMetrics().snapshot())
})

test("public exit mapping retries only the report's explicit retryable outcome", () => {
  const report: CurrentSourceSyncResult = {
    version: 1,
    kind: "current_source_sync",
    action: "sync",
    status: "complete",
    library_id: "4ba40d28-dbb8-54ca-99c9-36621a27d5e7",
    results: [],
    request_metrics: null,
    budget: {
      limits: DEFAULT_CURRENT_INVOCATION_BUDGET,
      attempts: 0,
      request_bytes: 0,
      response_bytes: 0,
      elapsed_ms: 0,
      exhausted: null,
      byte_overshoot: 0,
      byte_policy: "finish_admitted_response",
      byte_units: "payload_bytes_excluding_http_tls_framing",
      maximum_in_flight: 1,
    },
  }
  expect(currentSourceSyncExitCode(report)).toBe(0)
  expect(currentSourceSyncExitCode({ ...report, status: "retryable" })).toBe(75)
  for (const status of ["partial", "blocked", "failed"] as const)
    expect(currentSourceSyncExitCode({ ...report, status })).toBe(1)
})
