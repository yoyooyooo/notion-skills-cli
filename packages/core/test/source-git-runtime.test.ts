import { expect, test } from "bun:test"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, FileSystem, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFixedGitObjects } from "../src/shared-fixed-git-transport.ts"
import { discoverSource } from "../src/upstream-source.ts"

const services = Layer.merge(NodeServices.layer, NodeHttpClient.layerFetch)
const file = {
  path: "SKILL.md",
  source_path: "skills/demo/SKILL.md",
  git_oid: "c".repeat(40),
  sha256: "d".repeat(64),
  bytes: 1,
  mode: "100644" as const,
}

async function probe(entry: "upstream" | "fixed", exit: 128 | 129) {
  const directory = await mkdtemp(join(tmpdir(), "ntn-git-runtime-test-"))
  const calls: string[][] = []
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem
      const routed = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") return real.spawn(command)
        calls.push([...command.args])
        // A real child process reports the controlled capability failure. No PATH change.
        const script = `
if (process.argv.includes("--no-lazy-fetch")) {
  process.stderr.write(${JSON.stringify(exit === 129 ? "unknown option: --no-lazy-fetch\n" : "fatal: controlled process failure\n")});
  process.exit(${exit});
}
if (process.argv.includes("--version")) console.log("git version controlled-unsupported");
else process.exit(91);
`
        return real.spawn(
          ChildProcess.make(
            process.execPath,
            ["-e", script, "--", ...command.args],
            command.options,
          ),
        )
      })
      const operation =
        entry === "upstream"
          ? discoverSource({
              source: { type: "git", url: "https://github.com/example/runtime", ref: "main" },
              roots: ["skills"],
              include: [],
              exclude: [],
              mapping: {},
            }).pipe(Effect.asVoid)
          : readFixedGitObjects({
              source: {
                url: "https://github.com/example/runtime",
                commit: "a".repeat(40),
                tree: "b".repeat(40),
                root: "skills/demo",
                files: [file],
              },
              files: [file],
            }).pipe(Effect.asVoid)
      return yield* operation.pipe(
        Effect.result,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, routed),
        // Retain this test-owned directory; the controlled process never writes a repository.
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          makeTempDirectoryScoped: () => Effect.succeed(directory),
        }),
      )
    }).pipe(Effect.provide(services)),
  )
  return { result, calls }
}

test.each(["upstream", "fixed"] as const)(
  "%s rejects an unsupported Git capability before repository or remote acquisition",
  async (entry) => {
    const { result, calls } = await probe(entry, 129)
    if (result._tag !== "Failure") throw new Error("The unsupported runtime was accepted")
    expect(result.failure).toMatchObject({
      code: "UPSTREAM_GIT_RUNTIME_UNSUPPORTED",
      details: {
        required_capability: "--no-lazy-fetch",
        observed_version: "git version controlled-unsupported",
      },
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain("--no-lazy-fetch")
    expect(calls[1]).not.toContain("--no-lazy-fetch")
    expect(calls.every((args) => args.includes("--version"))).toBe(true)
    expect(
      calls.some((args) => args.some((arg) => ["init", "remote", "fetch"].includes(arg))),
    ).toBe(false)
  },
)

test.each(["upstream", "fixed"] as const)(
  "%s preserves a non-capability Git failure without version retry or remote acquisition",
  async (entry) => {
    const { result, calls } = await probe(entry, 128)
    if (result._tag !== "Failure") throw new Error("The failed process was accepted")
    expect(result.failure).toMatchObject({
      code: "UPSTREAM_GIT_FAILED",
      details: { operation: "--version", exit_code: 128 },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("--no-lazy-fetch")
  },
)
