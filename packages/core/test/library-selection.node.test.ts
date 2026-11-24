import { test, expect } from "vitest"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { selectLibrary } from "../../cli/src/sdk.ts"

test("local Library selection observes Config changes without constructing Notion transport", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sdk-library-selection-"))
  const rootA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  const rootB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  const reports: unknown[] = []
  const options = {
    metrics: true,
    env: {
      NTN_SKILLS_CONFIG_HOME: directory,
      NTN_SKILLS_HOME: join(directory, "store"),
      NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
      NOTION_API_BASE_URL: "not-a-url",
      NTN_SKILLS_NOTION_CONCURRENCY: "invalid",
    },
    onRequestMetrics: (value: unknown) => reports.push(value),
  }
  await writeFile(join(directory, "config.json"), JSON.stringify({ default_library: rootA }))
  expect(await selectLibrary(options)).toBe(rootA)
  await writeFile(join(directory, "config.json"), JSON.stringify({ default_library: rootB }))
  expect(await selectLibrary(options)).toBe(rootB)
  expect(await selectLibrary({ ...options, library: rootA.toUpperCase() })).toBe(rootA)
  await writeFile(join(directory, "config.json"), "{}")
  await expect(selectLibrary(options)).rejects.toMatchObject({ code: "LIBRARY_CONTEXT_REQUIRED" })
  await expect(selectLibrary({ ...options, ...{ database: rootA } })).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  })
  expect(reports).toHaveLength(5)
  for (const report of reports)
    expect(report).toMatchObject({
      trace_enabled: true,
      trace_dropped: 0,
      trace: [],
      total_requests: 0,
      requests: { notion_metadata: 0, notion_body: 0, notion_write: 0, provider: 0 },
    })
})

test("local selection preserves explicit per-operation trace settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sdk-library-trace-selection-"))
  const library = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  await writeFile(join(directory, "config.json"), JSON.stringify({ default_library: library }))
  for (const [metrics, limit, enabled] of [
    [true, undefined, true],
    [true, "0", false],
    [false, "1", true],
    [false, undefined, false],
  ] as const) {
    const reports: unknown[] = []
    expect(
      await selectLibrary({
        metrics,
        env: {
          NTN_SKILLS_CONFIG_HOME: directory,
          NTN_SKILLS_HOME: join(directory, "store"),
          NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
          NOTION_API_BASE_URL: "not-a-url",
          NTN_SKILLS_NOTION_CONCURRENCY: "invalid",
          ...(limit === undefined ? {} : { NTN_SKILLS_REQUEST_TRACE_LIMIT: limit }),
        },
        onRequestMetrics: (value) => reports.push(value),
      }),
    ).toBe(library)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      trace_enabled: enabled,
      trace_dropped: 0,
      trace: [],
      total_requests: 0,
    })
  }
})

test("cancelled local selection emits its requested zero-attempt trace before Store acquisition", async () => {
  const reports: unknown[] = []
  await expect(
    selectLibrary({
      metrics: true,
      env: {},
      signal: AbortSignal.abort(),
      onRequestMetrics: (value) => reports.push(value),
    }),
  ).rejects.toMatchObject({ code: "CANCELLED" })
  expect(reports).toHaveLength(1)
  expect(reports[0]).toMatchObject({
    trace_enabled: true,
    trace_dropped: 0,
    trace: [],
    total_requests: 0,
    requests: { notion_metadata: 0, notion_body: 0, notion_write: 0, provider: 0 },
  })
})
