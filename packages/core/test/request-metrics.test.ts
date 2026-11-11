import { describe, expect, test } from "bun:test"
import {
  assertRequestBudget,
  classifyBodyRequest,
  classifyRequest,
  createRequestMetrics,
  requestAttribution,
  notionRequestTarget,
  RequestBudgetError,
  SHARED_ADOPTION_REQUEST_COST,
} from "../src/request-metrics.ts"

describe("request metrics", () => {
  test("explicit producer attribution remains attached to attempts and queue waits", () => {
    const metrics = createRequestMetrics({ traceLimit: 10 })
    const attribution = {
      phase: "retention" as const,
      skill_page_id: "11111111-2222-4333-8444-555555555555",
      operation_id: "observe-original.operation",
    }
    metrics.begin({
      path: "v1/pages",
      method: "POST",
      ...{ attribution },
    })({ outcome: "failure", responseBytes: 11 })
    expect(metrics.snapshot().trace[0]).toMatchObject({ attribution })
    metrics.wait(10, "queue", attribution)
    expect(metrics.snapshot().trace[1]).toMatchObject({ attribution })
    expect(requestAttribution(undefined)).toEqual({
      phase: null,
      skill_page_id: null,
      operation_id: null,
    })
    expect(
      requestAttribution(
        { phase: "consume", skill_page_id: "private name", operation_id: "observe-secret" },
        "secret",
      ),
    ).toEqual({ phase: "consume", skill_page_id: null, operation_id: null })
  })

  test("Git acquisition costs remain separate from HTTP and preserve unknown wire/auth costs", () => {
    let time = 10
    const metrics = createRequestMetrics({ now: () => time, traceLimit: 2 })
    expect(metrics.snapshot()).not.toHaveProperty("source_acquisitions")
    const finish = metrics.beginSourceAcquisition({ provider: "git", configured_transport: "ssh" })
    expect(metrics.snapshot().source_acquisitions?.in_flight).toBe(1)
    metrics.begin({ path: "/metadata", provider: "other", method: "GET", requestBytes: 0 })({
      responseBytes: 12,
    })
    time = 30
    const result = {
      outcome: "success" as const,
      fetchMilliseconds: 12,
      repositoryObjectBytes: 91,
      catFileBytes: 120,
      observationMilliseconds: 2,
    }
    finish(result)
    finish(result)
    time = 40
    metrics.beginSourceAcquisition({ provider: "skills.sh", configured_transport: "https" })({
      outcome: "failure",
      fetchMilliseconds: 0,
      catFileBytes: 0,
      observationMilliseconds: 0,
    })
    const snapshot = metrics.snapshot()
    expect(snapshot).toMatchObject({ total_requests: 1, response_bytes: 12, in_flight: 0 })
    expect(snapshot.source_acquisitions).toMatchObject({
      attempts: 2,
      providers: { git: 1, "skills.sh": 1 },
      outcomes: { success: 1, failure: 1, cancelled: 0 },
      in_flight: 0,
      duration_ms: 20,
      fetch_ms: 12,
      observation_ms: 2,
      repository_object_bytes: 91,
      unknown_repository_object_bytes: 1,
      cat_file_bytes: 120,
      wire_bytes: null,
      auth_wait_ms: null,
      trace_dropped: 1,
    })
    expect(snapshot.trace.length + (snapshot.source_acquisitions?.trace.length ?? 0)).toBe(2)
    expect(snapshot.source_acquisitions?.trace[0]).toMatchObject({
      provider: "git",
      configured_transport: "ssh",
      wire_bytes: null,
      auth_wait_ms: null,
    })
  })

  test("safe targets normalize only Notion UUID routes and bounded exact Entity filters", () => {
    const id = "11111111-2222-4333-8444-555555555555"
    expect(
      notionRequestTarget({
        path: `v1/pages/${id.replaceAll("-", "").toUpperCase()}/markdown?private=query`,
        method: "GET",
      }),
    ).toEqual({ page_id: id })
    expect(
      notionRequestTarget({ path: `v1/blocks/${id}/children?start_cursor=private`, method: "GET" }),
    ).toEqual({ block_id: id })
    for (const path of [
      "https://private.example/v1/pages/" + id,
      "v1/pages/private-name",
      `v1/pages/${id}/unknown`,
      `v1/pages/${id}#private`,
    ])
      expect(notionRequestTarget({ path, method: "GET" })).toBeNull()
    expect(
      notionRequestTarget({ path: `v1/pages/${id}`, method: "GET", provider: "other" }),
    ).toBeNull()
    const query = {
      path: `v1/data_sources/${id}/query`,
      method: "POST" as const,
      entityPropertyId: "encoded-entity",
    }
    const exact = (entity: string) => ({
      property: "encoded-entity",
      rich_text: { equals: entity },
    })
    const other = { property: "other", rich_text: { equals: "private-prose" } }
    expect(
      notionRequestTarget({
        ...query,
        body: {
          filter: { and: [other, { or: [exact("file-b"), exact("file-a"), exact("file-a")] }] },
        },
      }),
    ).toEqual({ data_source_id: id, entity_ids: ["file-a", "file-b"] })
    expect(
      notionRequestTarget({
        ...query,
        body: { filter: { and: [{ or: [exact("file-a"), exact("file-b")] }, exact("file-b")] } },
      }),
    ).toEqual({ data_source_id: id, entity_ids: ["file-b"] })
    for (const filter of [
      other,
      { or: [exact("file-a"), other] },
      { property: "encoded-entity", rich_text: { contains: "file" } },
      exact("https://private.example/?token=secret"),
      { or: Array.from({ length: 101 }, (_, index) => exact(`file-${index}`)) },
    ])
      expect(notionRequestTarget({ ...query, body: { filter } })).toEqual({ data_source_id: id })
    expect(
      notionRequestTarget({
        ...query,
        body: { filter: exact("owned_secret_value") },
        redactedValue: "owned_secret_value",
      }),
    ).toEqual({ data_source_id: id })
    expect(
      notionRequestTarget({
        ...query,
        entityPropertyId: undefined,
        body: { filter: exact("file-a") },
      }),
    ).toEqual({ data_source_id: id })
  })

  test("opt-in attempt traces retain actual safe HTTP observations without request data", () => {
    let time = 10
    const metrics = createRequestMetrics({ now: () => time, traceLimit: 3 })
    metrics.wait(350, "queue")
    const finish = metrics.begin({ path: "v1/pages/private-page", method: "GET", requestBytes: 0 })
    time = 15
    finish({
      outcome: "failure",
      responseBytes: 75,
      httpStatus: 429,
      requestId: "request-123",
      rateLimitReason: "public_api_space_request_rate_limit",
      retryAfterSeconds: 120,
    })
    metrics.wait(120_000, "retry")
    metrics.begin({ path: "v1/users/me", method: "GET" })({ httpStatus: 200 })
    const snapshot = metrics.snapshot()
    expect(snapshot.trace_enabled).toBe(true)
    expect(snapshot.trace_dropped).toBe(1)
    expect(snapshot.trace).toHaveLength(3)
    expect(snapshot.trace[1]).toMatchObject({
      event: "attempt",
      attempt: 1,
      duration_ms: 5,
      http_status: 429,
      request_id: "request-123",
      retry_after_seconds: 120,
      request_bytes: 0,
      response_bytes: 75,
    })
    expect(JSON.stringify(snapshot.trace)).not.toContain("private-page")
    expect(snapshot.total_requests).toBe(2)
  })

  test("default traces are disabled and malformed diagnostic labels are excluded", () => {
    const ordinary = createRequestMetrics()
    ordinary.begin({ path: "v1/users/me", method: "GET" })({ httpStatus: 200 })
    expect(ordinary.snapshot().trace_enabled).toBe(false)
    expect(ordinary.snapshot().trace).toEqual([])
    const observed = createRequestMetrics({ traceLimit: 1 })
    observed.begin({ path: "v1/users/me", method: "GET" })({
      httpStatus: 999,
      requestId: "Authorization: Bearer secret",
      rateLimitReason: "contains private prose",
      retryAfterSeconds: Number.NaN,
    })
    expect(observed.snapshot().trace[0]).toMatchObject({
      http_status: null,
      request_id: null,
      rate_limit_reason: null,
      retry_after_seconds: null,
    })
    expect(() => createRequestMetrics({ traceLimit: 10_001 })).toThrow(TypeError)
  })

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
