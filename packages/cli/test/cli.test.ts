import { expect, test } from "bun:test"

const main = new URL("../src/main.ts", import.meta.url).pathname
async function invoke(args: string[]) {
  const child = Bun.spawn([process.execPath, main, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NTN_SKILLS_NTN_BIN: "/nonexistent/ntn",
      NTN_SKILLS_HOME: "/nonexistent/ntn-skills-cli-test-state",
      NTN_SKILLS_CONFIG_HOME: "/nonexistent/ntn-skills-cli-test-config",
    },
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exit }
}

test("unknown flags and subcommands produce a single JSON failure without help text", async () => {
  for (const args of [["read", "--unexpected"], ["nonexistent"], ["--wizard"]]) {
    const result = await invoke(args)
    const output = JSON.parse(result.stdout)
    expect(result.exit).toBe(2)
    expect(output.ok).toBe(false)
    expect(output.error.code).toBe("INVALID_ARGUMENT")
    expect(result.stdout.trim().split("\n")).toHaveLength(1)
  }
})

test("name reads and protocol reads parse with omitted Boolean switches", async () => {
  const name = await invoke(["read", "Sample Skill"])
  expect(JSON.parse(name.stdout).error.code).toBe("NTN_UNAVAILABLE")
  const invalid = await invoke(["read", "skill://sample/%2e%2e/secret"])
  expect(JSON.parse(invalid.stdout).error.code).toBe("INVALID_PATH")
  const snapshot = await invoke(["read", "s_" + "0".repeat(64), "--path", "guide.md"])
  expect(JSON.parse(snapshot.stdout).error.code).toBe("SNAPSHOT_MISSING")
})

test("obsolete modes and conflicting path sources fail before online access", async () => {
  for (const args of [
    ["ls", "sample"],
    ["databases"],
    ["read", "sample", "SKILL.md"],
    ["read", "--snapshot", "s_" + "0".repeat(64)],
    ["read", "sample", "--refresh"],
    ["files", "sample", "--refresh"],
    ["read", "skill://sample/SKILL.md", "--path", "guide.md"],
    ["read", "guide.md", "--from", "skill://sample/SKILL.md", "--path", "guide.md"],
  ]) {
    const result = await invoke(args)
    expect(result.exit).toBe(2)
    expect(JSON.parse(result.stdout).error.code).toBe("INVALID_ARGUMENT")
  }
})

test("relative resolution preserves snapshot without consulting Notion", async () => {
  const snapshot = "s_" + "1".repeat(64)
  const result = await invoke([
    "resolve",
    "../assets/guide.md",
    "--from",
    `skill://sample/references/page.md?snapshot=${snapshot}`,
  ])
  expect(result.exit).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    ok: true,
    ref: `skill://sample/assets/guide.md?snapshot=${snapshot}`,
  })
})

test("all help routes work with unavailable ntn and inaccessible state/configuration directories", async () => {
  for (const command of [
    [],
    ["list"],
    ["database"],
    ["database", "list"],
    ["open"],
    ["read"],
    ["files"],
    ["create"],
    ["import"],
    ["export"],
    ["write"],
    ["config"],
    ["config", "show"],
    ["config", "set-default"],
    ["config", "clear-default"],
    ["config", "set-token"],
    ["config", "clear-token"],
    ["source"],
    ["source", "add"],
    ["source", "list"],
    ["resolve"],
    ["doctor"],
  ]) {
    const result = await invoke([...command, "--help"])
    expect(result.exit).toBe(0)
    expect(result.stderr).toBe("")
  }
  const implicitHelp = await invoke([])
  expect(implicitHelp.exit).toBe(0)
  expect(implicitHelp.stderr).toBe("")
})

test("database selection rejects repeated values before any read or mutation handler", async () => {
  const commands = [
    ["list"],
    ["database", "list"],
    ["read", "sample-skill"],
    ["open", "sample-skill"],
    ["files", "sample-skill"],
    ["create", "missing.md"],
    ["import", "missing.md"],
    ["export", "sample-skill", "--output", "output.zip"],
    ["write", "sample-skill", "--input", "missing.md"],
    ["source", "add", "personal"],
  ]
  for (const command of commands) {
    for (const flags of [
      ["--database", "frontend", "--database", "ops"],
      ["--database=frontend", "--database=ops"],
      ["--database", "frontend", "--database=frontend"],
    ]) {
      const result = await invoke([...command, ...flags])
      expect(result.exit).toBe(2)
      expect(JSON.parse(result.stdout).error.code).toBe("INVALID_ARGUMENT")
      expect(result.stderr).toBe("")
    }
  }
  const help = await invoke(["list", "--database", "frontend", "--database", "ops", "--help"])
  expect(help.exit).toBe(0)
})
