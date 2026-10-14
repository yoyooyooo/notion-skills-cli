import { expect, test } from "bun:test"
import { access, chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const main = new URL("../src/main.ts", import.meta.url).pathname
const snapshot = `s_${"0".repeat(64)}`
const pinned = `skill://sample/SKILL.md?snapshot=${snapshot}`
interface InvocationResult {
  stdout: string
  stderr: string
  exit: number
  onlineCalled: boolean
}
async function invoke(
  args: string[],
  options: { inaccessible?: boolean; traceOnline?: boolean; root?: string } = {},
) {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "ntn-skills-cli-test-")))
  const marker = join(root, "online-called")
  const provider = join(root, "ntn-probe")
  if (options.traceOnline) {
    await writeFile(provider, `#!/bin/sh\nprintf called >> '${marker}'\nexit 97\n`)
    await chmod(provider, 0o700)
  }
  const selectedRoot = options.inaccessible ? "/nonexistent/ntn-skills-cli-help" : root
  const child = Bun.spawn([process.execPath, main, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: {
      ...process.env,
      NOTION_API_TOKEN: "",
      NOTION_WORKSPACE_ID: "",
      NOTION_API_BASE_URL: "",
      NTN_SKILLS_NTN_BIN: options.traceOnline ? provider : join(root, "missing-ntn"),
      NTN_SKILLS_HOME: join(selectedRoot, "state"),
      NTN_SKILLS_CONFIG_HOME: join(selectedRoot, "config"),
      NTN_SKILLS_CACHE_HOME: join(selectedRoot, "cache"),
      XDG_STATE_HOME: join(root, "xdg-state"),
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_CACHE_HOME: join(root, "xdg-cache"),
    },
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const onlineCalled = await access(marker).then(
    () => true,
    () => false,
  )
  return { stdout, stderr, exit, onlineCalled }
}
function jsonFailure(result: InvocationResult, code: string, exit = 2) {
  expect(result.exit).toBe(exit)
  expect(result.stderr).toBe("")
  expect(result.stdout.trim().split("\n")).toHaveLength(1)
  const output = JSON.parse(result.stdout)
  expect(output.ok).toBe(false)
  expect(output.error.code).toBe(code)
  expect(typeof output.error.message).toBe("string")
  expect(output.error.message.length).toBeGreaterThan(0)
}
async function invalid(args: string[]) {
  const result = await invoke(args, { traceOnline: true })
  jsonFailure(result, "INVALID_ARGUMENT")
  expect(result.onlineCalled).toBe(false)
}

test("unknown flags, obsolete selectors and conflicting paths fail before online handlers", async () => {
  for (const args of [
    ["read", "--unexpected"],
    ["nonexistent"],
    ["--wizard"],
    ["ls", "sample"],
    ["databases"],
    ["read", "sample", "SKILL.md"],
    ["read", "--snapshot", snapshot],
    ["read", "skill://sample/SKILL.md", "--path", "guide.md"],
    ["read", "guide.md", "--from", "skill://sample/SKILL.md", "--path", "guide.md"],
    ["write", "sample", "--input", "missing.md", "--offline"],
    ["import", "missing.md", "--refresh"],
    ["doctor", "--max-age", "0"],
    ["import", "missing.md", "--target", `skill://sample/references/guide.md?snapshot=${snapshot}`],
  ])
    await invalid(args)
}, 60000)

test("name reads, refresh policies and valid duration overrides reach online validation", async () => {
  for (const command of [
    ["list"],
    ["read", "Sample Skill"],
    ["open", "Sample Skill"],
    ["files", "Sample Skill"],
    ["export", "Sample Skill", "--output", "output.zip"],
  ]) {
    for (const flags of [
      [],
      ["--refresh"],
      ...["0", "0s", "1s", "2m", "3h", "4d"].map((duration) => ["--max-age", duration]),
    ]) {
      jsonFailure(await invoke([...command, ...flags]), "NTN_UNAVAILABLE", 1)
    }
  }
  jsonFailure(await invoke(["read", "skill://sample/%2e%2e/secret"]), "INVALID_PATH", 1)
}, 120000)

test("offline policy fails explicitly without a safe cached identity", async () => {
  for (const command of [
    ["list"],
    ["read", "sample"],
    ["open", "sample"],
    ["files", "sample"],
    ["export", "sample", "--output", "output.zip"],
  ]) {
    const result = await invoke([...command, "--offline"], { traceOnline: true })
    jsonFailure(result, "CACHE_SCOPE_UNAVAILABLE", 1)
    expect(result.onlineCalled).toBe(false)
  }
}, 30000)

test("read policies reject combinations and invalid durations before online work", async () => {
  for (const command of [
    ["list"],
    ["read", "sample"],
    ["open", "sample"],
    ["files", "sample"],
    ["export", "sample", "--output", "output.zip"],
  ]) {
    for (const flags of [
      ["--refresh", "--offline"],
      ["--refresh", "--max-age", "1s"],
      ["--offline", "--max-age", "0"],
      ...["1", "-1s", "1.5s", "NaN", "Infinity", "1ms", "9007199254740992d"].map((duration) => [
        "--max-age",
        duration,
      ]),
    ])
      await invalid([...command, ...flags])
  }
}, 120000)

test("pinned and relative pinned reads allow offline but reject refresh and age overrides", async () => {
  for (const command of [
    ["read", snapshot],
    ["read", pinned],
    ["read", "guide.md", "--from", pinned],
    ["open", snapshot],
    ["files", pinned],
    ["export", pinned, "--output", "output.zip"],
  ]) {
    for (const policy of [["--refresh"], ["--max-age", "0"], ["--max-age", "1m"]])
      await invalid([...command, ...policy])
    const result = await invoke([...command, "--offline"], { traceOnline: true })
    jsonFailure(result, "SNAPSHOT_MISSING", 1)
    expect(result.onlineCalled).toBe(false)
  }
}, 60000)

test("sync and cache require unambiguous selections before online work", async () => {
  for (const args of [
    ["sync", "bind", "sample"],
    ["sync", "bind", pinned, "--path", "local"],
    ["sync", "plan"],
    ["sync", "plan", "binding", "--all"],
    ["sync", "plan", "--all", "--from", "local"],
    ["sync", "plan", "--all", "--from", "notion"],
    ["sync", "plan", "binding", "--from", "remote"],
    ["sync", "plan", "binding", "--dry-run"],
    ["sync", "apply"],
    ["sync", "apply", "--plan", "p_invalid", "--all"],
    ["sync", "apply", "--plan", "p_invalid", "--from", "local"],
    ["sync", "reconcile", "binding", "--force"],
    ["sync", "status", "--offline"],
    ["sync", "unbind"],
    ["cache", "clear"],
    ["cache", "clear", "sample", "--all"],
    ["cache", "clear", "--all", "--database", "sample"],
    ["cache", "clear", pinned],
    ["config", "set-cache-policy"],
  ])
    await invalid(args)
}, 60000)

test("valid sync selections and explicit import targets reach their actual operational prerequisites", async () => {
  for (const args of [
    ["sync", "bind", "sample", "--path", "local", "--as", "local-copy", "--dry-run"],
    ["import", "missing.md", "--target", "sample", "--dry-run"],
  ])
    jsonFailure(await invoke(args), "NTN_UNAVAILABLE", 1)
  for (const source of ["local", "notion"]) {
    const result = await invoke(
      ["sync", "plan", "missing-binding", "--from", source, "--output", "plan.json"],
      { traceOnline: true },
    )
    jsonFailure(result, "SYNC_BINDING_MISSING", 1)
    expect(result.onlineCalled).toBe(false)
  }
  const empty = await invoke(["sync", "status"])
  expect(empty.exit).toBe(0)
  expect(JSON.parse(empty.stdout)).toEqual({ ok: true, bindings: [] })
}, 30000)

const helpCommands = [
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
  ["config", "set-cache-policy"],
  ["config", "clear-cache-policy"],
  ["source"],
  ["source", "add"],
  ["source", "list"],
  ["sync"],
  ["sync", "bind"],
  ["sync", "status"],
  ["sync", "plan"],
  ["sync", "apply"],
  ["sync", "reconcile"],
  ["sync", "unbind"],
  ["cache"],
  ["cache", "status"],
  ["cache", "clear"],
  ["resolve"],
  ["doctor"],
]
for (const command of helpCommands) {
  test(`${command.join(" ") || "root"} help requires no provider or accessible application roots`, async () => {
    const result = await invoke([...command, "--help"], { inaccessible: true, traceOnline: true })
    expect(result.exit).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout.trim().length).toBeGreaterThan(0)
    expect(result.onlineCalled).toBe(false)
  })
}
test("implicit root help works offline", async () => {
  const result = await invoke([], { inaccessible: true, traceOnline: true })
  expect(result.exit).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.onlineCalled).toBe(false)
})

for (const command of [
  ["list"],
  ["database", "list"],
  ["read", "sample"],
  ["open", "sample"],
  ["files", "sample"],
  ["create", "missing.md"],
  ["import", "missing.md"],
  ["export", "sample", "--output", "output.zip"],
  ["write", "sample", "--input", "missing.md"],
  ["source", "add", "personal"],
  ["sync", "bind", "sample", "--path", "local"],
  ["cache", "status", "sample"],
  ["cache", "clear", "sample"],
]) {
  test(`${command.join(" ")} rejects repeated database values before its handler`, async () => {
    for (const flags of [
      ["--database", "frontend", "--database", "ops"],
      ["--database=frontend", "--database=ops"],
      ["--database", "frontend", "--database=frontend"],
    ])
      await invalid([...command, ...flags])
  }, 15000)
}

test("new and existing singleton strings and Booleans reject repetition", async () => {
  for (const args of [
    ["read", "sample", "--refresh", "--refresh"],
    ["files", "sample", "--offline", "--offline"],
    ["list", "--max-age", "0", "--max-age=1s"],
    ["list", "--query", "a", "--query=a"],
    ["read", "sample", "--raw", "--raw"],
    ["read", "sample", "--path", "a", "--path=a"],
    ["read", "sample", "--lines", "1", "--lines=1"],
    ["read", "a", "--from", pinned, `--from=${pinned}`],
    ["export", "sample", "--output", "a.zip", "--output=a.zip"],
    ["export", "sample", "--output", "a.zip", "--format", "zip", "--format=zip"],
    ["import", "missing.md", "--target", "sample", "--target=sample"],
    ["import", "missing.md", "--name", "Sample", "--name=Sample"],
    ["create", "missing.md", "--description", "a", "--description=a"],
    ["import", "missing.md", "--dry-run", "--dry-run"],
    ["sync", "bind", "sample", "--path", "a", "--path=a"],
    ["sync", "bind", "sample", "--path", "a", "--as", "b", "--as=b"],
    ["sync", "plan", "--all", "--all"],
    ["sync", "plan", "b", "--from", "local", "--from=local"],
    ["sync", "plan", "b", "--output", "a.json", "--output=a.json"],
    ["sync", "apply", "--plan", "p_a", "--plan=p_a"],
    ["sync", "status", "--refresh", "--refresh"],
    ["sync", "unbind", "b", "--dry-run", "--dry-run"],
    ["cache", "clear", "--all", "--all"],
    ["cache", "clear", "--all", "--dry-run", "--dry-run"],
    ["config", "set-cache-policy", "--read-max-age", "0", "--read-max-age=0"],
    ["config", "set-cache-policy", "--catalog-max-age", "1s", "--catalog-max-age=1s"],
    ["config", "set-token", "--stdin", "--stdin"],
  ])
    await invalid(args)
}, 90000)

test("cache duration configuration persists across processes and preserves other configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-skills-cli-policy-"))
  await mkdir(join(root, "config"))
  const original = {
    token: "offline-fixture-token",
    default_database: "11111111-1111-4111-8111-111111111111",
    sources: [],
  }
  await writeFile(join(root, "config", "config.json"), JSON.stringify(original))
  for (const [duration, milliseconds] of [
    ["0", 0],
    ["0s", 0],
    ["1s", 1000],
    ["2m", 120000],
    ["3h", 10800000],
    ["4d", 345600000],
  ] as const) {
    const result = await invoke(["config", "set-cache-policy", "--read-max-age", duration], {
      root,
    })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout).config.effective_cache_policy.read_max_age_ms).toBe(
      milliseconds,
    )
    const show = JSON.parse((await invoke(["config", "show"], { root })).stdout)
    expect(show.config.effective_cache_policy.read_max_age_ms).toBe(milliseconds)
    expect(show.config.default_database).toBe(original.default_database)
    expect(show.config.token_configured).toBe(true)
    expect(show.config.token).toBeUndefined()
  }
  for (const duration of ["1", "-1s", "1.5s", "9007199254740992d"]) {
    for (const flag of ["--read-max-age", "--catalog-max-age"])
      await invalid(["config", "set-cache-policy", flag, duration])
  }
  const clear = await invoke(["config", "clear-cache-policy"], { root })
  expect(clear.exit).toBe(0)
  const show = JSON.parse((await invoke(["config", "show"], { root })).stdout)
  expect(show.config.effective_cache_policy).toEqual({
    read_max_age_ms: 300000,
    catalog_max_age_ms: 60000,
  })
  expect(show.config.default_database).toBe(original.default_database)
  expect(show.config.token_configured).toBe(true)
}, 60000)

test("relative resolution preserves snapshot without consulting Notion", async () => {
  const result = await invoke(
    [
      "resolve",
      "../assets/guide.md",
      "--from",
      `skill://sample/references/page.md?snapshot=${snapshot}`,
    ],
    { traceOnline: true },
  )
  expect(result.exit).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    ok: true,
    ref: `skill://sample/assets/guide.md?snapshot=${snapshot}`,
  })
  expect(result.onlineCalled).toBe(false)
})
test("explicit help takes precedence over repeated singleton values", async () => {
  const result = await invoke(["list", "--database", "frontend", "--database", "ops", "--help"], {
    inaccessible: true,
    traceOnline: true,
  })
  expect(result.exit).toBe(0)
  expect(result.onlineCalled).toBe(false)
})
