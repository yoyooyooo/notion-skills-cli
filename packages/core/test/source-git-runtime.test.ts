import { expect, test } from "bun:test"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Exit, FileSystem, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { readFixedGitObjects } from "../src/shared-fixed-git-transport.ts"
import { discoverSource, runSourceGit } from "../src/upstream-source.ts"

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

function processState(pid: number) {
  try {
    const value = execFileSync(
      "ps",
      ["-ww", "-p", String(pid), "-o", "pid=,ppid=,pgid=,stat=,command="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim()
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\s\S]+)$/.exec(value)
    if (!match) return undefined
    return {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      state: match[4],
      command: match[5],
    }
  } catch (error) {
    if (error !== null && typeof error === "object" && "status" in error && error.status === 1)
      return undefined
    throw error
  }
}

async function processReceipt(path: string, nonce: string) {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"))
    if (
      value !== null &&
      typeof value === "object" &&
      "nonce" in value &&
      value.nonce === nonce &&
      "pid" in value &&
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 1 &&
      value.pid !== process.pid
    )
      return { pid: value.pid }
    throw new Error("Invalid owned process receipt")
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return undefined
    throw error
  }
}

async function stopOwnedProcess(pid: number, script: string, nonce: string) {
  const send = (signal: NodeJS.Signals) => {
    const current = processState(pid)
    if (!current || current.state?.startsWith("Z")) return
    if (!current.command?.includes(script) || !current.command.includes(nonce))
      throw new Error("Refusing to signal a process outside this fixture")
    process.kill(pid, signal)
  }
  send("SIGTERM")
  for (let index = 0; index < 40 && processState(pid); index++) await delay(25)
  if (processState(pid)) send("SIGKILL")
  for (let index = 0; index < 40 && processState(pid); index++) await delay(25)
  const remaining = processState(pid)
  if (remaining && !remaining.state?.startsWith("Z"))
    throw new Error("Owned process did not exit after fixture cleanup")
}

async function cancelGitProcessTree(mode: "terminate" | "ignore-termination") {
  const directory = await mkdtemp(join(tmpdir(), "ntn-git-cancellation-test-"))
  const nonce = randomUUID()
  const leaderPath = join(directory, "git-shim.mjs")
  const descendantPath = join(directory, "descendant.mjs")
  const leaderReceipt = join(directory, "leader.json")
  const descendantReceipt = join(directory, "descendant.json")
  const termReceipt = join(directory, "descendant-term")
  await writeFile(
    descendantPath,
    `
import { writeFileSync } from "node:fs";
const [receipt, term, nonce, mode] = process.argv.slice(2);
process.on("SIGTERM", () => {
  writeFileSync(term, "SIGTERM");
  if (mode === "terminate") process.exit(0);
});
writeFileSync(receipt, JSON.stringify({nonce, pid: process.pid, ppid: process.ppid}));
setInterval(() => {}, 1000);
`,
  )
  await writeFile(
    leaderPath,
    `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [receipt, childScript, childReceipt, term, nonce, mode] = process.argv.slice(2);
spawn(process.execPath, [childScript, childReceipt, term, nonce, mode], {detached:false, stdio:"ignore"});
writeFileSync(receipt, JSON.stringify({nonce, pid: process.pid, ppid: process.ppid}));
setInterval(() => {}, 1000);
`,
  )
  const controller = new AbortController()
  const completion = Effect.runPromiseExit(
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      const routed = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand" || command.command !== "git")
          throw new Error("Only the owned Git shim is allowed")
        return real.spawn(
          ChildProcess.make(
            process.execPath,
            [
              leaderPath,
              leaderReceipt,
              descendantPath,
              descendantReceipt,
              termReceipt,
              nonce,
              mode,
            ],
            command.options,
          ),
        )
      })
      return yield* runSourceGit(directory, ["fetch", "owned-no-network"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, routed),
      )
    }).pipe(Effect.provide(services)),
    { signal: controller.signal },
  )
  try {
    for (let index = 0; index < 100; index++) {
      if (await processReceipt(descendantReceipt, nonce)) break
      await delay(25)
    }
    const leader = await processReceipt(leaderReceipt, nonce)
    const descendant = await processReceipt(descendantReceipt, nonce)
    if (!leader || !descendant) throw new Error("The owned process tree did not become ready")
    const before = { leader: processState(leader.pid), descendant: processState(descendant.pid) }
    const reason = new Error("Cancel this owned Git acquisition")
    const started = performance.now()
    controller.abort(reason)
    await delay(100)
    const during = { leader: processState(leader.pid), descendant: processState(descendant.pid) }
    const exit = await Promise.race([
      completion,
      delay(5000, undefined, { ref: false }).then(() => {
        throw new Error("Git cancellation did not settle within its cleanup bound")
      }),
    ])
    const elapsedMs = performance.now() - started
    const after = { leader: processState(leader.pid), descendant: processState(descendant.pid) }
    const receivedTerm = await readFile(termReceipt, "utf8").catch(() => undefined)
    const result = {
      mode,
      before,
      during,
      after,
      elapsedMs,
      interrupted: Exit.hasInterrupts(exit),
      originalReason: controller.signal.reason === reason,
      receivedTerm,
    }
    // Keep the owned scripts and receipt; only live fixture processes are cleaned below.
    await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2))
    return result
  } finally {
    controller.abort()
    for (const [path, script] of [
      [descendantReceipt, descendantPath],
      [leaderReceipt, leaderPath],
    ]) {
      if (!path || !script) throw new Error("Missing owned process identity")
      const owned = await processReceipt(path, nonce)
      if (owned) await stopOwnedProcess(owned.pid, script, nonce)
    }
    await completion
  }
}

test.skipIf(process.platform === "win32")(
  "Git cancellation terminates a normal descendant in the owned POSIX process group",
  async () => {
    const result = await cancelGitProcessTree("terminate")
    expect(result.interrupted).toBe(true)
    expect(result.originalReason).toBe(true)
    expect(result.before.leader?.pgid).toBe(result.before.leader?.pid)
    expect(result.before.descendant?.pgid).toBe(result.before.leader?.pid)
    expect(result.receivedTerm).toBe("SIGTERM")
    expect(result.after.leader).toBeUndefined()
    expect(result.after.descendant?.state?.startsWith("Z") ?? true).toBe(true)
    expect(result.elapsedMs).toBeLessThan(4500)
  },
  10000,
)

test.skipIf(process.platform === "win32")(
  "Git cancellation bounds a SIGTERM-ignoring descendant after the leader exits",
  async () => {
    const result = await cancelGitProcessTree("ignore-termination")
    expect(result.interrupted).toBe(true)
    expect(result.originalReason).toBe(true)
    expect(result.during.leader).toBeUndefined()
    expect(result.during.descendant).toBeDefined()
    expect(result.receivedTerm).toBe("SIGTERM")
    expect(result.after.leader).toBeUndefined()
    expect(result.after.descendant?.state?.startsWith("Z") ?? true).toBe(true)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(1800)
    expect(result.elapsedMs).toBeLessThan(4500)
  },
  10000,
)

test.each([0, 7])("Git exit %i preserves output and never exposes raw stderr", async (code) => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      const routed = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand" || command.command !== "git")
          throw new Error("Only the owned Git shim is allowed")
        return real.spawn(
          ChildProcess.make(
            process.execPath,
            [
              "-e",
              `process.stdout.write("owned-output");process.stderr.write("private-stderr-token");process.exit(${code})`,
            ],
            command.options,
          ),
        )
      })
      return yield* runSourceGit(process.cwd(), ["rev-parse", "owned"]).pipe(
        Effect.result,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, routed),
      )
    }).pipe(Effect.provide(services)),
  )
  if (code === 0) {
    expect(result._tag).toBe("Success")
    if (result._tag === "Success")
      expect(new TextDecoder().decode(result.success)).toBe("owned-output")
  } else {
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure")
      expect(result.failure).toMatchObject({
        code: "UPSTREAM_GIT_FAILED",
        details: { operation: "rev-parse", exit_code: code },
      })
  }
  expect(JSON.stringify(result)).not.toContain("private-stderr-token")
})
