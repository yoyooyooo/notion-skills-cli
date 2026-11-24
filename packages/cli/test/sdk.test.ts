import { describe, expect, test } from "bun:test"
import * as publicSdk from "../src/sdk.ts"
import { Config, ConfigProvider, Effect, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runSourceGit } from "../../core/src/upstream-source.ts"
import {
  consume,
  decodeConsumeResult,
  decodeResourceReadResult,
  parseDuration,
  compareNativeMarkdown,
  readResources,
  readSkill,
  resolveReference,
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
  "skill://skill/references/a.txt?library=0c64a309-510e-5d37-b23c-3ce2f966c66e&snapshot=s_" + "a".repeat(64) + ""

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

  test("relative identity resolution preserves cancellation, effects and zero-request receipts", async () => {
    const reports: unknown[] = []
    await expect(
      resolveReference("../SKILL.md", {
        from: resourceRef,
        env: {},
        signal: AbortSignal.abort(),
        onRequestMetrics: (value) => reports.push(value),
      }),
    ).rejects.toMatchObject({
      code: "CANCELLED",
      details: { effects: { version: 1, remote_writes: "none", author_content: "unchanged" } },
    })
    expectUnstartedMetrics(reports, 1)
  })
  test("exact identity resolution is pure and manifest listing preserves the SDK cancellation boundary", async () => {
    expect(() =>
      resolveCatalogReference("skill://missing/SKILL.md?library=cc029b5c-680e-576d-a381-a069d3f9f26e", {
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
      effects: { version: 1, remote_writes: "none", author_content: "unchanged" },
    })
    await expect(
      readSkill(input.targets[0]!, { env: {}, signal: controller.signal }),
    ).rejects.toBeInstanceOf(SkillsError)
    await expect(
      readSkill(input.targets[0]!, { env: {}, signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "CANCELLED",
      details: {
        effects: { version: 1, remote_writes: "none", author_content: "unchanged" },
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

  test("interleaved SDK environments bind ConfigProvider and actual Git children independently", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-child-environments-"))
    const parent = { path: process.env.PATH, value: process.env.NTN_SDK_TEST_VALUE }
    let entered = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const cases = await Promise.all(
      ["one", "two"].map(async (value) => {
        const directory = join(root, value)
        await mkdir(directory)
        await writeFile(
          join(directory, "git"),
          `#!${process.execPath}\nconsole.log(JSON.stringify({
        executable: ${JSON.stringify(value)}, value: process.env.NTN_SDK_TEST_VALUE,
        terminal: process.env.GIT_TERMINAL_PROMPT, trace: process.env.GIT_TRACE2_EVENT,
        gitDirCleared: process.env.GIT_DIR === undefined
      }));\n`,
          { mode: 0o700 },
        )
        return {
          value,
          env: {
            PATH: directory,
            NTN_SDK_TEST_VALUE: value,
            GIT_DIR: "/controlled/must-be-cleared",
            GIT_TRACE2_EVENT: "/controlled/must-not-be-opened",
          },
        }
      }),
    )
    const results = await Promise.all(
      cases.map(({ value, env }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const configured = yield* Config.String("NTN_SDK_TEST_VALUE")
            yield* Effect.promise(async () => {
              if (++entered === 2) release()
              await barrier
            })
            const bytes = yield* runSourceGit(root, ["--version"])
            return { configured, actual: JSON.parse(new TextDecoder().decode(bytes)), value }
          }).pipe(
            Effect.provide(nodeRuntime(root, env).local),
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
          ),
        ),
      ),
    )
    expect(entered).toBe(2)
    for (const { configured, actual, value } of results) {
      expect(configured).toBe(value)
      expect(actual).toEqual({
        executable: value,
        value,
        terminal: "0",
        trace: "0",
        gitDirCleared: true,
      })
    }
    expect({ path: process.env.PATH, value: process.env.NTN_SDK_TEST_VALUE }).toEqual(parent)
  })

  test("runtime env capture preserves default inheritance and explicit child replacements", async () => {
    const query = ChildProcess.make(process.execPath, [
      "-e",
      "console.log(JSON.stringify({path:process.env.PATH??null,value:process.env.NTN_SDK_TEST_VALUE??null}))",
    ])
    const read = (runtime: ReturnType<typeof nodeRuntime>, command: ChildProcess.Command = query) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          return JSON.parse(yield* spawner.string(command))
        }).pipe(Effect.provide(runtime.local)),
      )
    expect(await read(nodeRuntime())).toEqual({
      path: process.env.PATH ?? null,
      value: process.env.NTN_SDK_TEST_VALUE ?? null,
    })
    const env = { PATH: "/controlled/captured", NTN_SDK_TEST_VALUE: "captured" }
    const runtime = nodeRuntime(undefined, env)
    env.NTN_SDK_TEST_VALUE = "changed-after-capture"
    expect(await read(runtime)).toEqual({ path: "/controlled/captured", value: "captured" })
    expect(
      await read(
        runtime,
        ChildProcess.make(query.command, query.args, {
          env: { NTN_SDK_TEST_VALUE: "explicit" },
          extendEnv: false,
        }),
      ),
    ).toEqual({ path: null, value: "explicit" })
    const pipeline = ChildProcess.pipeTo(
      ChildProcess.make(process.execPath, [
        "-e",
        "process.stdout.write(process.env.NTN_SDK_TEST_VALUE)",
      ]),
      ChildProcess.make(
        process.execPath,
        [
          "-e",
          "let input='';for await(const data of process.stdin)input+=data;console.log(JSON.stringify({input,value:process.env.NTN_SDK_TEST_VALUE}))",
        ],
        { env: { NTN_SDK_TEST_VALUE: "right" }, extendEnv: true },
      ),
    )
    expect(await read(runtime, pipeline)).toEqual({ input: "captured", value: "right" })
    const code = await Effect.runPromise(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        return yield* spawner.exitCode(
          ChildProcess.make(process.execPath, ["-e", "process.exit(7)"]),
        )
      }).pipe(Effect.provide(runtime.local)),
    )
    expect(Number(code)).toBe(7)
  })

  test("duration rules are the public CLI rules", () => {
    expect(parseDuration("0")).toBe(0)
    expect(parseDuration("5m")).toBe(300000)
    expect(() => parseDuration("5ms")).toThrow(SkillsError)
    expect(() => parseDuration("1.5s")).toThrow(SkillsError)
  })

  test("native Markdown comparison preserves the current writer's complete structure", () => {
    const expected = "# Invoice\n\nRead total_cents and `last_invoice_id`.\n"
    const observed = "# Invoice\n\nRead total\\_cents and `last_invoice_id`.\n"
    expect(compareNativeMarkdown({ expected, observed })).toBe("normalized")
    expect(compareNativeMarkdown({ expected, observed: expected })).toBe("exact")
    for (const changed of [
      observed.replace("total\\_cents", "total\\_dollars"),
      observed.replace("# Invoice", "## Invoice"),
      observed.replace("`last_invoice_id`", "`last\\_invoice\\_id`"),
      "# Invoice\n",
    ])
      expect(compareNativeMarkdown({ expected, observed: changed })).toBe("different")
    const wrapped = {
      expected: "1. Run `list --library\n   ENTRY`.\n\n   Keep the paragraph.\n",
      observed:
        "1. Run <code>list --library ENTRY</code>.\n   <p>\n   Keep the paragraph.\n   </p>\n",
    }
    expect(compareNativeMarkdown(wrapped)).toBe("normalized")
    expect(
      compareNativeMarkdown({
        ...wrapped,
        observed: wrapped.observed.replace("library ENTRY", "library<br>ENTRY"),
      }),
    ).toBe("different")
  })

  test("independent resource capability preserves consumer v1 and rejects structural errors before runtime acquisition", async () => {
    expect(Reflect.get(publicSdk, "RESOURCE_READ_EFFECTS_VERSION")).toBe(1)
    expect([
      SDK_VERSION,
      CONSUMER_CONTRACT_VERSION,
      RESOURCE_READ_CONTRACT_VERSION,
      READ_OUTPUT_PROOF_VERSION,
    ]).toEqual([3, 1, 1, 1])
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
          signal: controller.signal,
          onRequestMetrics: (value) => reports.push(value),
        },
      ),
    ).toEqual({
      version: 1,
      status: "cancelled",
      reason: "interrupted",
      effects: { version: 1, remote_writes: "none", author_content: "unchanged" },
    })
    expectUnstartedMetrics(reports, 1)
    await expect(decodeResourceReadResult({ version: 42 })).rejects.toBeInstanceOf(SkillsError)
    await expect(decodeResourceReadResult({ version: 42 })).rejects.toMatchObject({
      code: "RESOURCE_INVALID_PROOF",
    })
  })
})
