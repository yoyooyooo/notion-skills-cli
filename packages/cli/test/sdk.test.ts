import { describe, expect, test } from "bun:test"
import { Effect, Path } from "effect"
import { consume, decodeConsumeResult, parseDuration, readSkill, SkillsError } from "../src/sdk.ts"
import { nodeRuntime } from "../src/runtime.ts"

const input = { version: 1, targets: ["00000000-0000-4000-8000-000000000001"], purpose: "use" }

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
})
