import { describe, expect, test } from "bun:test"
import { Effect, Path } from "effect"
import {
  consume,
  decodeConsumeResult,
  decodeResourceReadResult,
  parseDuration,
  readResources,
  readSkill,
  SkillsError,
  SDK_VERSION,
  CONSUMER_CONTRACT_VERSION,
  RESOURCE_READ_CONTRACT_VERSION,
  READ_OUTPUT_PROOF_VERSION,
} from "../src/sdk.ts"
import { nodeRuntime } from "../src/runtime.ts"

const input = { version: 1, targets: ["00000000-0000-4000-8000-000000000001"], purpose: "use" }
const resourceRef =
  "skill://shared_skill%3Alibrary%3Askill/references/a.txt?snapshot=s_" +
  "a".repeat(64) +
  "&file_id=file-a"

describe("Promise SDK boundary", () => {
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
    expect(reports).toEqual([null])
  })

  test("an already aborted signal has no acquired metrics and read uses the exported typed error", async () => {
    const controller = new AbortController()
    controller.abort()
    const reports: unknown[] = []
    expect(
      await consume(input, {
        env: {},
        signal: controller.signal,
        onRequestMetrics: (snapshot) => reports.push(snapshot),
      }),
    ).toEqual({ version: 1, status: "cancelled", reason: "interrupted" })
    await expect(
      readSkill(input.targets[0]!, { env: {}, signal: controller.signal }),
    ).rejects.toBeInstanceOf(SkillsError)
    await expect(
      readSkill(input.targets[0]!, { env: {}, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED" })
    expect(reports).toEqual([null])
  })

  test("public decoder preserves typed proof rejection without a configured Store", async () => {
    await expect(decodeConsumeResult({ version: 42 })).rejects.toBeInstanceOf(SkillsError)
    await expect(decodeConsumeResult({ version: 42 })).rejects.toMatchObject({
      code: "CONSUME_INVALID_PROOF",
    })
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
        await readResources(input, { env: {}, onRequestMetrics: (value) => reports.push(value) }),
      ).toMatchObject({ status: "failed", error: { code: "INVALID_ARGUMENT" } })
    expect(reports).toEqual([null, null, null, null])
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
          signal: controller.signal,
          onRequestMetrics: (value) => reports.push(value),
        },
      ),
    ).toEqual({ version: 1, status: "cancelled", reason: "interrupted" })
    expect(reports).toEqual([null])
    await expect(decodeResourceReadResult({ version: 42 })).rejects.toBeInstanceOf(SkillsError)
    await expect(decodeResourceReadResult({ version: 42 })).rejects.toMatchObject({
      code: "RESOURCE_INVALID_PROOF",
    })
  })
})
