import { describe, expect, test } from "bun:test"
import * as publicSdk from "../src/sdk.ts"
import { Effect, Path } from "effect"
import {
  consume,
  decodeConsumeResult,
  decodeResourceReadResult,
  parseDuration,
  readResources,
  readSkill,
  listCatalog,
  listSkills,
  listSkill,
  resolveCatalogReference,
  SkillsError,
  SDK_VERSION,
  CONSUMER_CONTRACT_VERSION,
  RESOURCE_READ_CONTRACT_VERSION,
  READ_OUTPUT_PROOF_VERSION,
  CATALOG_DIRECTORY_CONTRACT_VERSION,
  CONSUMPTION_EFFECTS_VERSION,
} from "../src/sdk.ts"
import { nodeRuntime } from "../src/runtime.ts"

const input = { version: 1, targets: ["00000000-0000-4000-8000-000000000001"], purpose: "use" }
const resourceRef =
  "skill://shared_skill%3Alibrary%3Askill/references/a.txt?snapshot=s_" +
  "a".repeat(64) +
  "&file_id=file-a"

function expectUnstartedMetrics(reports: readonly unknown[], count: number) {
  expect(reports).toHaveLength(count)
  for (const report of reports)
    expect(report).toMatchObject({
      total_requests: 0,
      requests: { notion_metadata: 0, notion_body: 0, notion_write: 0, provider: 0 },
      request_bytes: 0,
      response_bytes: 0,
      unknown_request_bytes: 0,
      unknown_response_bytes: 0,
      in_flight: 0,
      outcomes: { success: 0, failure: 0, cancelled: 0 },
      trace: [],
      trace_dropped: 0,
    })
}

describe("Promise SDK boundary", () => {
  test("name resolution is pure and manifest listing preserves the SDK cancellation boundary", async () => {
    expect(() =>
      resolveCatalogReference("skill://missing/SKILL.md", {
        scope: "a".repeat(64),
        fetched_at: 1000,
        databases: [],
        records: [],
        coverage: {
          method: "search_and_registered",
          exhaustive: false,
          queried_data_sources: [],
          failed_sources: [],
          search_index_limited: true,
        },
      }),
    ).toThrow(expect.objectContaining({ code: "CATALOG_INCOMPLETE" }))
    const controller = new AbortController()
    controller.abort()
    const reports: unknown[] = []
    await expect(
      listSkill(resourceRef, {
        env: {},
        signal: controller.signal,
        onRequestMetrics: (value) => reports.push(value),
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" })
    expectUnstartedMetrics(reports, 1)
  })

  test("catalog/list cancellation and invalid pagination fail before runtime acquisition", async () => {
    const controller = new AbortController()
    controller.abort()
    const reports: unknown[] = []
    for (const list of [listCatalog, listSkills])
      await expect(
        list({
          env: {},
          signal: controller.signal,
          onRequestMetrics: (value) => reports.push(value),
        }),
      ).rejects.toMatchObject({ code: "CANCELLED" })
    for (const selection of [
      { limit: 0 },
      { limit: 501 },
      { limit: 1.5 },
      { cursor: "not-a-returned-cursor" },
    ])
      await expect(
        listSkills({ ...selection, env: {}, onRequestMetrics: (value) => reports.push(value) }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
    expectUnstartedMetrics(reports, 6)
  })
  test("combined catalog directories keep the SDK pre-abort boundary", async () => {
    expect(CATALOG_DIRECTORY_CONTRACT_VERSION).toBe(1)
    const controller = new AbortController()
    controller.abort()
    const reports: unknown[] = []
    await expect(
      listCatalog({
        directory: {},
        env: {},
        signal: controller.signal,
        onRequestMetrics: (value) => reports.push(value),
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" })
    expectUnstartedMetrics(reports, 1)
  })
  test("unknown input and unsupported capability fail before runtime acquisition", async () => {
    const reports: unknown[] = []
    const invalid = await consume(
      { ...input, version: 2 },
      {
        env: {},
        onRequestMetrics: (snapshot) => reports.push(snapshot),
      },
    )
    expect(invalid).toMatchObject({ status: "failed", error: { code: "INVALID_ARGUMENT" } })
    const unsupported = await consume(
      { ...input, projection: { compiler: "unknown/v2" } },
      { env: {} },
    )
    expect(unsupported).toMatchObject({ status: "failed", error: { code: "CONSUME_UNSUPPORTED" } })
    expect(await consume({ ...input, requestedFiles: [resourceRef] }, { env: {} })).toMatchObject({
      status: "failed",
      error: { code: "CONSUME_UNSUPPORTED" },
    })
    expectUnstartedMetrics(reports, 1)
  })

  test("an already aborted signal proves no transport and read uses the exported typed error", async () => {
    expect(CONSUMPTION_EFFECTS_VERSION).toBe(1)
    const controller = new AbortController()
    controller.abort()
    const reports: unknown[] = []
    expect(
      await consume(input, {
        env: {},
        signal: controller.signal,
        onRequestMetrics: (snapshot) => reports.push(snapshot),
      }),
    ).toEqual({
      version: 1,
      status: "cancelled",
      reason: "interrupted",
      effects: { version: 1, remote_writes: "none", author_content: "unchanged", retention: [] },
    })
    await expect(
      readSkill(input.targets[0]!, { env: {}, signal: controller.signal }),
    ).rejects.toBeInstanceOf(SkillsError)
    await expect(
      readSkill(input.targets[0]!, { env: {}, signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "CANCELLED",
      details: {
        effects: { version: 1, remote_writes: "none", author_content: "unchanged", retention: [] },
      },
    })
    expectUnstartedMetrics(reports, 1)
  })

  test("public decoder preserves typed proof rejection without a configured Store", async () => {
    await expect(decodeConsumeResult({ version: 42 })).rejects.toBeInstanceOf(SkillsError)
    await expect(decodeConsumeResult({ version: 42 })).rejects.toMatchObject({
      code: "CONSUME_INVALID_PROOF",
    })
  })

  test("unstarted metrics preserve explicit trace selection without acquiring a runtime", async () => {
    const signal = AbortSignal.abort()
    for (const [options, enabled] of [
      [{ metrics: true, env: {} }, true],
      [{ metrics: true, env: { NTN_SKILLS_REQUEST_TRACE_LIMIT: "0" } }, false],
      [{ env: { NTN_SKILLS_REQUEST_TRACE_LIMIT: "1" } }, true],
    ] as const) {
      const reports: unknown[] = []
      await expect(
        listCatalog({ ...options, signal, onRequestMetrics: (value) => reports.push(value) }),
      ).rejects.toMatchObject({ code: "CANCELLED" })
      expectUnstartedMetrics(reports, 1)
      expect(reports[0]).toMatchObject({ trace_enabled: enabled })
    }
  })

  test("concurrent Path services own relative resolution without chdir", async () => {
    const cwd = process.cwd()
    const resolve = (root: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const path = yield* Path.Path
          return {
            absolute: path.resolve("state"),
            relative: path.relative("a", "b"),
            file: (yield* path.toFileUrl("result.bin")).pathname,
          }
        }).pipe(Effect.provide(nodeRuntime(root).local)),
      )
    const results = await Promise.all([resolve("/owned/one"), resolve("/owned/two")])
    expect(results).toEqual([
      { absolute: "/owned/one/state", relative: "../b", file: "/owned/one/result.bin" },
      { absolute: "/owned/two/state", relative: "../b", file: "/owned/two/result.bin" },
    ])
    expect(process.cwd()).toBe(cwd)
  })

  test("duration rules are the public CLI rules", () => {
    expect(parseDuration("0")).toBe(0)
    expect(parseDuration("5m")).toBe(300000)
    expect(() => parseDuration("5ms")).toThrow(SkillsError)
    expect(() => parseDuration("1.5s")).toThrow(SkillsError)
  })

  test("independent resource capability preserves consumer v1 and rejects structural errors before runtime acquisition", async () => {
    expect(Reflect.get(publicSdk, "RESOURCE_READ_EFFECTS_VERSION")).toBe(1)
    expect([
      SDK_VERSION,
      CONSUMER_CONTRACT_VERSION,
      RESOURCE_READ_CONTRACT_VERSION,
      READ_OUTPUT_PROOF_VERSION,
    ]).toEqual([1, 1, 1, 1])
    const reports: unknown[] = []
    for (const input of [
      { version: 2, refs: [resourceRef] },
      { version: 1, refs: [] },
      { version: 1, refs: [resourceRef, resourceRef] },
      { version: 1, refs: [resourceRef], budget: { timeBudgetMs: 120_001 } },
    ])
      expect(
        await readResources(input, {
          env: {},
          readOnly: true,
          onRequestMetrics: (value) => reports.push(value),
        }),
      ).toMatchObject({ status: "failed", error: { code: "INVALID_ARGUMENT" } })
    expectUnstartedMetrics(reports, 4)
  })

  test("resource pre-abort and the pure resource decoder need no source runtime", async () => {
    const controller = new AbortController()
    controller.abort()
    const reports: unknown[] = []
    expect(
      await readResources(
        { version: 1, refs: [resourceRef] },
        {
          env: {},
          readOnly: true,
          signal: controller.signal,
          onRequestMetrics: (value) => reports.push(value),
        },
      ),
    ).toEqual({
      version: 1,
      status: "cancelled",
      reason: "interrupted",
      effects: { version: 1, remote_writes: "none", author_content: "unchanged", retention: [] },
    })
    expectUnstartedMetrics(reports, 1)
    await expect(decodeResourceReadResult({ version: 42 })).rejects.toBeInstanceOf(SkillsError)
    await expect(decodeResourceReadResult({ version: 42 })).rejects.toMatchObject({
      code: "RESOURCE_INVALID_PROOF",
    })
  })
})
