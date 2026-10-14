import { afterAll, expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer } from "effect"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Notion, NotionLive } from "../src/notion.ts"
import { Store } from "../src/store.ts"

const directory = await mkdtemp(join(tmpdir(), "ntn-diagnostic-test-"))
const executable = join(directory, "ntn")
await writeFile(
  executable,
  `#!/usr/bin/env bun\nconsole.error("DNS resolution failed https://private.invalid/file?signature=secret authorization: Bearer sensitive-fixture-token")\nprocess.exitCode = 5\n`,
  { mode: 0o700 },
)
afterAll(async () => {
  if (process.platform === "darwin") {
    const child = Bun.spawn(["/usr/bin/trash", directory], { stdout: "ignore", stderr: "ignore" })
    await child.exited
  }
})
const store = Layer.succeed(Store, {
  root: directory,
  configRoot: directory,
  cacheRoot: directory,
  reserveCacheGeneration: (() => {
    let generation = 0
    return () => Effect.sync(() => ++generation)
  })(),
  listKeys: () => Effect.succeed([]),
  retireKeys: () => Effect.succeed([]),
  readJson: () => Effect.succeed({ token: "sensitive-fixture-token" } as any),
  writeJson: () => Effect.void,
  readBytes: () => Effect.succeed(new Uint8Array()),
  writeBytes: () => Effect.void,
  output: () => Effect.succeed({ output: "", reused: false }),
})

test("official transport failures expose a safe reason and preserve unknown write outcomes", async () => {
  const original = process.env.NTN_SKILLS_NTN_BIN
  process.env.NTN_SKILLS_NTN_BIN = executable
  try {
    const layer = NotionLive.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, store)))
    for (const method of ["GET", "PATCH"] as const) {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* Notion
          return yield* api.request("v1/pages/sample", undefined, { method }).pipe(Effect.result)
        }).pipe(Effect.provide(layer)),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag !== "Failure") throw new Error("Expected a failed transport")
      expect(result.failure.code).toBe(
        method === "PATCH" ? "WRITE_OUTCOME_UNKNOWN" : "NOTION_REQUEST_FAILED",
      )
      expect(result.failure.details).toEqual({
        path: "v1/pages/sample",
        exit_code: 5,
        reason: "dns",
      })
      const output = JSON.stringify(result.failure)
      expect(output).not.toContain("sensitive-fixture-token")
      expect(output).not.toContain("signature=secret")
      expect(output).not.toContain("private.invalid")
    }
  } finally {
    if (original === undefined) delete process.env.NTN_SKILLS_NTN_BIN
    else process.env.NTN_SKILLS_NTN_BIN = original
  }
}, 15_000)

test("transient transport loss retries reads and queries while writes remain unknown", async () => {
  const state = join(directory, "attempts.json")
  const retryExecutable = join(directory, "retry-ntn")
  await writeFile(
    retryExecutable,
    `#!/usr/bin/env bun
const state = ${JSON.stringify(state)}
const path = process.argv[3]
const attempts = await Bun.file(state).exists() ? await Bun.file(state).json() : {}
attempts[path] = (attempts[path] ?? 0) + 1
await Bun.write(state, JSON.stringify(attempts))
if (attempts[path] === 1) {
  console.error("error sending request: network connection reset")
  process.exitCode = 5
} else {
  console.log(JSON.stringify({ object: "page", id: "restored" }))
}
`,
    { mode: 0o700 },
  )
  const original = process.env.NTN_SKILLS_NTN_BIN
  process.env.NTN_SKILLS_NTN_BIN = retryExecutable
  try {
    const layer = NotionLive.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, store)))
    for (const [path, method, read] of [
      ["v1/pages/read", "GET", true],
      ["v1/data_sources/sample/query", "POST", true],
      ["v1/pages/write", "PATCH", false],
      ["v1/pages", "POST", false],
    ] as const) {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* Notion
          return yield* api.request(path, undefined, { method }).pipe(Effect.result)
        }).pipe(Effect.provide(layer)),
      )
      if (read) {
        expect(result._tag).toBe("Success")
        if (result._tag !== "Success") throw new Error("Expected a recovered read")
        expect(result.success).toEqual({ object: "page", id: "restored" })
      } else {
        expect(result._tag === "Failure" && result.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
      }
      expect((await Bun.file(state).json())[path]).toBe(read ? 2 : 1)
    }
  } finally {
    if (original === undefined) delete process.env.NTN_SKILLS_NTN_BIN
    else process.env.NTN_SKILLS_NTN_BIN = original
  }
}, 15_000)
