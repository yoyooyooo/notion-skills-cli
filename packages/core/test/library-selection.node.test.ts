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
      total_requests: 0,
      requests: { notion_metadata: 0, notion_body: 0, notion_write: 0, provider: 0 },
    })
})
