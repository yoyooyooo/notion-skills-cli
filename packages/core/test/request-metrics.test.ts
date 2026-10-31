import { describe, expect, test } from "bun:test"
import {
  assertRequestBudget,
  classifyBodyRequest,
  classifyRequest,
  createRequestMetrics,
  RequestBudgetError,
  SHARED_ADOPTION_REQUEST_COST,
} from "../src/request-metrics.ts"

describe("request metrics", () => {
  test("classifies queries as metadata and conservatively counts unknown reads as body", () => {
    expect(classifyRequest({ path: "/v1/data_sources/files/query", method: "POST" })).toBe(
      "notion_metadata",
    )
    expect(classifyRequest({ path: "v1/views/view/queries", method: "POST" })).toBe(
      "notion_metadata",
    )
    expect(classifyRequest({ path: "v1/pages/file", method: "GET" })).toBe("notion_metadata")
    expect(classifyRequest({ path: "v1/pages/file/markdown", method: "GET" })).toBe("notion_body")
    expect(
      classifyRequest({ path: "v1/data_sources/records/query", method: "POST", content: "body" }),
    ).toBe("notion_body")
    expect(
      classifyBodyRequest({
        path: "v1/data_sources/records/query",
        method: "POST",
        content: "body",
      }),
    ).toBe("retained_body")
    expect(classifyBodyRequest({ path: "v1/pages/file/markdown", method: "GET" })).toBe(
      "current_body",
    )
    expect(
      classifyBodyRequest({ path: "v1/pages/retained", method: "GET", content: "retained_body" }),
    ).toBe("retained_body")
    expect(
      classifyBodyRequest({ path: "v1/pages/current", method: "GET", content: "current_body" }),
    ).toBe("current_body")
    expect(classifyRequest({ path: "v1/new-download-endpoint", method: "GET" })).toBe("notion_body")
    expect(classifyRequest({ path: "v1/pages/file/markdown", method: "PATCH" })).toBe(
      "notion_write",
    )
    expect(classifyRequest({ path: "objects/hash", method: "GET", provider: "git" })).toBe(
      "provider",
    )
  })

  test("records actual attempts, bytes, concurrency, duplicate attempts, waits and separate end-to-end samples", () => {
    let time = 0
    const metrics = createRequestMetrics({ now: () => time })
    const first = metrics.begin({
      path: "v1/pages/a/markdown",
      method: "GET",
      key: "scope-a:body-a",
      requestBytes: 0,
    })
    time = 5
    const second = metrics.begin({
      path: "v1/pages/a/markdown",
      method: "GET",
      key: "scope-a:body-a",
      requestBytes: 0,
    })
    time = 10
    first({ responseBytes: 100 })
    first({ responseBytes: 100 })
    time = 25
    second({ responseBytes: 200, outcome: "failure" })
    metrics.coalesced()
    metrics.wait(4, "queue")
    metrics.wait(8, "retry")
    metrics.operation(25)
    const actual = metrics.snapshot()
    expect(actual.requests.notion_body).toBe(2)
    expect(actual.body_requests).toEqual({
      current_body: 2,
      retained_body: 0,
      unclassified_body: 0,
    })
    expect(actual.total_requests).toBe(2)
    expect(actual.response_bytes).toBe(300)
    expect(actual.unknown_response_bytes).toBe(0)
    expect(actual.peak_concurrency).toBe(2)
    expect(actual.in_flight).toBe(0)
    expect(actual.duplicate_requests).toBe(1)
    expect(actual.coalesced_requests).toBe(1)
    expect(actual.queue_wait_ms).toBe(4)
    expect(actual.retry_wait_ms).toBe(8)
    expect(actual.request_duration).toEqual({ samples: 2, p50_ms: 10, p95_ms: 20 })
    expect(actual.operation_duration).toEqual({ samples: 1, p50_ms: 25, p95_ms: 25 })
    expect(actual.outcomes).toEqual({ success: 1, failure: 1, cancelled: 0 })
  })

  test("missing byte observations stay explicitly unknown and snapshots do not mutate", () => {
    const metrics = createRequestMetrics({ now: () => 0 })
    const before = metrics.snapshot()
    metrics.begin({ path: "v1/users/me", method: "GET" })()
    const after = metrics.snapshot()
    expect(before.total_requests).toBe(0)
    expect(after.unknown_request_bytes).toBe(1)
    expect(after.unknown_response_bytes).toBe(1)
    expect(after.requests_without_identity).toBe(1)
    expect(after.operation_duration.samples).toBe(0)
    expect(after.operation_duration.p95_ms).toBeNull()
  })

  for (const fileCount of [1, 10, 100, 101, 300]) {
    test(`fixed metadata budget accepts pagination for N=${fileCount}`, () => {
      const metrics = createRequestMetrics({ now: () => 0 })
      const pages = Math.ceil(fileCount / 100)
      for (let index = 0; index < pages; index += 1)
        metrics.begin({
          path: "v1/data_sources/files/query",
          method: "POST",
          key: `page-${index}`,
        })()
      expect(() =>
        assertRequestBudget(metrics.snapshot(), {
          scenario: "ttl_expired",
          fileCount,
          metadataConstant: 0,
        }),
      ).not.toThrow()
    })
  }

  test("rejects an N+1 implementation even with its fixed bootstrap allowance", () => {
    const metrics = createRequestMetrics({ now: () => 0 })
    for (let index = 0; index < 101; index += 1)
      metrics.begin({ path: `v1/pages/${index}`, method: "GET" })()
    expect(() =>
      assertRequestBudget(metrics.snapshot(), {
        scenario: "ttl_expired",
        fileCount: 101,
        metadataConstant: 4,
      }),
    ).toThrow(RequestBudgetError)
  })

  test("rejects downloads and routine writes during unchanged revalidation", () => {
    for (const request of [
      { path: "v1/pages/a/markdown", method: "GET" as const },
      { path: "v1/pages/a", method: "PATCH" as const },
      { path: "objects/hash", method: "GET" as const, provider: "git" },
    ]) {
      const metrics = createRequestMetrics({ now: () => 0 })
      metrics.begin(request)()
      expect(() =>
        assertRequestBudget(metrics.snapshot(), {
          scenario: "ttl_expired",
          fileCount: 300,
          metadataConstant: 4,
        }),
      ).toThrow(RequestBudgetError)
    }
  })

  test("TTL hits permit no remote attempts and body-change budgets reject duplicate downloads", () => {
    const metrics = createRequestMetrics({ now: () => 0 })
    expect(() =>
      assertRequestBudget(metrics.snapshot(), {
        scenario: "ttl_hit",
        fileCount: 300,
        metadataConstant: 4,
      }),
    ).not.toThrow()
    metrics.begin({ path: "v1/pages/a/markdown", method: "GET" })()
    expect(() =>
      assertRequestBudget(metrics.snapshot(), {
        scenario: "ttl_hit",
        fileCount: 300,
        metadataConstant: 4,
      }),
    ).toThrow(RequestBudgetError)
    expect(() =>
      assertRequestBudget(metrics.snapshot(), {
        scenario: "body_changed",
        fileCount: 300,
        changedFiles: 1,
        metadataConstant: 4,
      }),
    ).not.toThrow()
    metrics.begin({ path: "v1/pages/a/markdown", method: "GET" })()
    expect(() =>
      assertRequestBudget(metrics.snapshot(), {
        scenario: "body_changed",
        fileCount: 300,
        changedFiles: 1,
        metadataConstant: 4,
      }),
    ).toThrow(RequestBudgetError)
  })

  test("incomplete or failed traces cannot pass a successful-path cost gate", () => {
    const metrics = createRequestMetrics({ now: () => 0 })
    const finish = metrics.begin({ path: "v1/users/me", method: "GET" })
    const budget = { scenario: "catalog" as const, fileCount: 1, metadataConstant: 4 }
    expect(() => assertRequestBudget(metrics.snapshot(), budget)).toThrow(RequestBudgetError)
    finish({ outcome: "failure" })
    expect(() => assertRequestBudget(metrics.snapshot(), budget)).toThrow(RequestBudgetError)
  })

  test("counts retained body queries within the existing body total without double-counting requests", () => {
    const metrics = createRequestMetrics({ now: () => 0 })
    metrics.begin({ path: "v1/pages/file/markdown", method: "GET" })()
    metrics.begin({ path: "v1/data_sources/records/query", method: "POST", content: "body" })()
    metrics.begin({
      path: "v1/data_sources/records/query",
      method: "POST",
      content: "retained_body",
    })()
    expect(metrics.snapshot().total_requests).toBe(3)
    expect(metrics.snapshot().requests.notion_body).toBe(3)
    expect(metrics.snapshot().body_requests).toEqual({
      current_body: 1,
      retained_body: 2,
      unclassified_body: 0,
    })
  })

  for (const fileCount of [1, 10, 100, 101, 300]) {
    test(`adoption budget accounts for retained objects and the fixed operation graph at N=${fileCount}`, () => {
      for (const changedFiles of new Set([1, Math.min(3, fileCount)])) {
        const metrics = createRequestMetrics({ now: () => 0 })
        const metadataPages = 3 * Math.max(1, Math.ceil(fileCount / 100))
        const metadataConstant = 3
        const perChange = SHARED_ADOPTION_REQUEST_COST
        for (
          let index = 0;
          index < metadataPages + metadataConstant + perChange.metadata * changedFiles;
          index += 1
        )
          metrics.begin({
            path: "v1/data_sources/files/query",
            method: "POST",
            key: `metadata-${index}`,
          })()
        for (let index = 0; index < changedFiles; index += 1) {
          metrics.begin({ path: `v1/pages/file-${index}/markdown`, method: "GET" })()
          metrics.begin({
            path: "v1/data_sources/records/query",
            method: "POST",
            content: "retained_body",
          })()
          metrics.begin({
            path: "v1/data_sources/records/query",
            method: "POST",
            content: "retained_body",
          })()
          metrics.begin({ path: "v1/pages", method: "POST" })()
          metrics.begin({ path: "v1/pages", method: "POST" })()
          metrics.begin({ path: "v1/pages", method: "POST" })()
        }
        const budget = {
          scenario: "body_changed" as const,
          fileCount,
          changedFiles,
          metadataConstant,
          metadataPages,
        }
        expect(() => assertRequestBudget(metrics.snapshot(), budget)).not.toThrow()
        metrics.begin({ path: "v1/data_sources/files/query", method: "POST" })()
        expect(() => assertRequestBudget(metrics.snapshot(), budget)).toThrow(RequestBudgetError)
      }
    })
  }

  test("retained lookup headroom cannot conceal an extra current-body download or fourth adoption write", () => {
    const budget = {
      scenario: "body_changed" as const,
      fileCount: 101,
      changedFiles: 1,
      metadataConstant: 3,
      metadataPages: 4,
    }
    const duplicate = createRequestMetrics({ now: () => 0 })
    duplicate.begin({ path: "v1/pages/a/markdown", method: "GET" })()
    duplicate.begin({ path: "v1/pages/a/markdown", method: "GET" })()
    expect(() => assertRequestBudget(duplicate.snapshot(), budget)).toThrow(RequestBudgetError)
    const extraWrite = createRequestMetrics({ now: () => 0 })
    for (let index = 0; index < 4; index += 1)
      extraWrite.begin({ path: "v1/pages", method: "POST" })()
    expect(() => assertRequestBudget(extraWrite.snapshot(), budget)).toThrow(RequestBudgetError)
  })

  test("explicit legacy operation costs do not silently acquire the shared plan allowance", () => {
    const metrics = createRequestMetrics({ now: () => 0 })
    const budget = {
      scenario: "body_changed" as const,
      fileCount: 100,
      changedFiles: 1,
      metadataConstant: 3,
      perChangeCost: { metadata: 1, retainedBody: 1, writes: 2 },
    }
    metrics.begin({ path: "v1/pages/a/markdown", method: "GET" })()
    metrics.begin({
      path: "v1/data_sources/records/query",
      method: "POST",
      content: "retained_body",
    })()
    for (let index = 0; index < 2; index += 1) metrics.begin({ path: "v1/pages", method: "POST" })()
    expect(() => assertRequestBudget(metrics.snapshot(), budget)).not.toThrow()
    metrics.begin({ path: "v1/pages", method: "POST" })()
    expect(() => assertRequestBudget(metrics.snapshot(), budget)).toThrow(RequestBudgetError)
    expect(() =>
      assertRequestBudget(metrics.snapshot(), {
        ...budget,
        perChangeCost: { metadata: 1, retainedBody: -1, writes: 2 },
      }),
    ).toThrow(TypeError)
  })

  test("exact retained recovery allows its required object query but forbids current-body fallback and writes", () => {
    const metrics = createRequestMetrics({ now: () => 0 })
    const budget = {
      scenario: "retained_recovery" as const,
      fileCount: 300,
      recoveredObjects: 1,
      metadataConstant: 3,
      metadataPages: 6,
    }
    metrics.begin({
      path: "v1/data_sources/records/query",
      method: "POST",
      content: "retained_body",
    })()
    expect(() => assertRequestBudget(metrics.snapshot(), budget)).not.toThrow()
    expect(() =>
      assertRequestBudget(metrics.snapshot(), { ...budget, scenario: "ttl_expired" }),
    ).toThrow(RequestBudgetError)
    metrics.begin({ path: "v1/pages/current/markdown", method: "GET" })()
    expect(() => assertRequestBudget(metrics.snapshot(), budget)).toThrow(RequestBudgetError)
  })
})
