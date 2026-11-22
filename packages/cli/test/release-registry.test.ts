import { test } from "bun:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const source = resolve(import.meta.dir, "../../..")
const config = JSON.parse(readFileSync(join(source, ".github/release.config.json"), "utf8"))

const cases = [
  { name: "structured npm E404", stdout: '{"error":{"code":"E404"}}', status: 1, expected: 0 },
  {
    name: "valid version array including a prerelease",
    stdout: '["0.3.0","0.4.0-rc.1"]',
    status: 0,
    expected: 0,
  },
  { name: "valid single version", stdout: '"0.3.0"', status: 0, expected: 0 },
  {
    name: "misleading E404 in a network error",
    stdout: "",
    stderr: "connection failed; previous request mentioned E404",
    status: 1,
    expected: 1,
  },
  { name: "authentication failure", stdout: '{"error":{"code":"E401"}}', status: 1, expected: 1 },
  { name: "malformed successful object", stdout: "{}", status: 0, expected: 1 },
  { name: "empty successful response", stdout: "", status: 0, expected: 1 },
  { name: "empty successful version array", stdout: "[]", status: 0, expected: 1 },
  { name: "non-version member", stdout: '["0.3.0",null]', status: 0, expected: 1 },
  { name: "invalid version string", stdout: '"unavailable"', status: 0, expected: 1 },
]

for (const row of cases) {
  test("release planning distinguishes registry absence from " + row.name, () => {
    // Only local bare repositories and a process-owned npm response are used.
    // Preserve every fixture, including failures, for inspection.
    const sandbox = mkdtempSync(join(tmpdir(), "ntn-release-registry-"))
    const repo = join(sandbox, "repo"),
      remote = join(sandbox, "origin.git"),
      bin = join(sandbox, "bin")
    mkdirSync(join(repo, "scripts"), { recursive: true })
    mkdirSync(join(repo, ".github"))
    mkdirSync(bin)
    copyFileSync(join(source, "scripts/release.ts"), join(repo, "scripts/release.ts"))
    for (const relative of config.versionFiles) {
      const file = join(repo, relative)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ name: "release-fixture", version: "0.1.0" }) + "\n")
    }
    writeFileSync(
      join(repo, ".github/release.config.json"),
      JSON.stringify({
        ...config,
        lockfiles: [],
        lockfileCommand: null,
        checkCommand: [process.execPath, "-e", "process.exit(42)"],
        localCheckCommand: [process.execPath, "-e", "process.exit(42)"],
      }) + "\n",
    )
    const npm = join(bin, "npm")
    writeFileSync(
      npm,
      "#!" +
        process.execPath +
        "\n" +
        "process.stdout.write(process.env.RELEASE_FIXTURE_STDOUT);\n" +
        "process.stderr.write(process.env.RELEASE_FIXTURE_STDERR);\n" +
        "process.exit(Number(process.env.RELEASE_FIXTURE_STATUS));\n",
    )
    chmodSync(npm, 0o755)
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key]
    Object.assign(env, {
      PATH: bin + ":" + process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Release fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Release fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      RELEASE_FIXTURE_STDOUT: row.stdout,
      RELEASE_FIXTURE_STDERR: row.stderr ?? "",
      RELEASE_FIXTURE_STATUS: String(row.status),
    })
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" })
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim()
    }
    git("init", "--initial-branch=main")
    git("init", "--bare", "--initial-branch=main", remote)
    git("remote", "add", "origin", remote)
    git("add", ".")
    git("-c", "commit.gpgsign=false", "commit", "-m", "fixture")
    git("push", "-u", "origin", "main")
    const before = git("rev-parse", "HEAD"),
      refs = git("--git-dir", remote, "show-ref")
    const result = spawnSync(
      process.execPath,
      [join(repo, "scripts/release.ts"), "0.4.0", "--dry-run", "--no-push"],
      {
        cwd: repo,
        env,
        encoding: "utf8",
        timeout: 15_000,
      },
    )
    assert.equal(
      result.status,
      row.expected,
      JSON.stringify({ sandbox, stdout: result.stdout, stderr: result.stderr }),
    )
    if (row.expected === 0) assert.match(result.stdout, /next: 0\.4\.0/)
    assert.equal(git("rev-parse", "HEAD"), before)
    assert.equal(git("tag", "--list"), "")
    assert.equal(git("status", "--porcelain"), "")
    assert.equal(git("--git-dir", remote, "show-ref"), refs)
  })
}
